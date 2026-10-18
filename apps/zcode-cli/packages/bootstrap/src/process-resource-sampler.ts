import { randomBytes } from "node:crypto";
import { availableParallelism, totalmem } from "node:os";
import {
  ZCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS,
  type ZCodeProcessResourceSample,
} from "@zcode/shared";

/** The sampling period shares shared's single constant with the app-side aggregation, keeping both cadences locked. */
export const ZCODE_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS = ZCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS;

let processInstanceToken: string | undefined;

/**
 * This CLI process's instance id: generated on first sample, then constant for the process lifetime (sampler rebuilds keep it).
 *
 * For the app-side main only: counting concurrently alive CLI processes and the max per-process RSS.
 *
 * No pid, never leaves the machine; a random token instead of the pid is a privacy hard requirement.
 */
function resolveProcessInstanceToken(): string {
  processInstanceToken ??= randomBytes(8).toString("hex");
  return processInstanceToken;
}

interface CpuUsageSnapshot {
  user: number;
  system: number;
}

/** Same shape as Node `process.memoryUsage()`; the local memory diagnostics log needs heap detail, protocol samples take rss only. */
export interface ProcessMemoryUsageSnapshot {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

interface ResourceSamplerTimerHandle {
  unref?(): void;
}

interface ResourceSamplerTimer {
  setInterval(callback: () => void, intervalMs: number): ResourceSamplerTimerHandle;
  clearInterval(handle: ResourceSamplerTimerHandle): void;
}

interface CreateZCodeProcessResourceSamplerOptions {
  /**
   * The second argument is the period's full memory snapshot, for the in-process local diagnostics log;
   * the protocol sample itself carries only rss and heapUsed.
   */
  onSample(sample: ZCodeProcessResourceSample, memoryUsage: ProcessMemoryUsageSnapshot): void;
  platform?: ZCodeProcessResourceSample["platform"];
  arch?: ZCodeProcessResourceSample["arch"];
  logicalCpuCount?: number;
  readCpuUsage?: () => CpuUsageSnapshot;
  readMonotonicTimeNs?: () => bigint;
  readMemoryUsage?: () => ProcessMemoryUsageSnapshot;
  /** Machine physical memory, read once at construction (constant for the process). */
  readTotalMemoryBytes?: () => number;
  /** This process's uptime; the platform buckets by uptime to spot memory growth over time. */
  readUptimeSeconds?: () => number;
  /** For tests to inject a predictable instance id; production uses the process-level random token. */
  instanceToken?: string;
  timer?: ResourceSamplerTimer;
}

export interface ZCodeProcessResourceSampler {
  start(): void;
  stop(): void;
}

interface ResourceSamplerBaseline {
  cpu: CpuUsageSnapshot;
  monotonicTimeNs: bigint;
}

const defaultTimer: ResourceSamplerTimer = {
  setInterval(callback, intervalMs) {
    return setInterval(callback, intervalMs);
  },
  clearInterval(handle) {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

function roundResourceMetric(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * When a reading is unavailable the field is absent (both optional in the protocol); never fake it with 0.
 * Errors from the reading itself are caught by the sampling try/catch (hard rule 6: failure means drop).
 */
function toRoundedUnit(value: number, divisor: number): number | undefined {
  return Number.isFinite(value) && value >= 0 ? Math.round(value / divisor) : undefined;
}

export function createZCodeProcessResourceSampler(
  options: CreateZCodeProcessResourceSamplerOptions,
): ZCodeProcessResourceSampler {
  const platform = options.platform ?? (process.platform as ZCodeProcessResourceSample["platform"]);
  const arch = options.arch ?? (process.arch as ZCodeProcessResourceSample["arch"]);
  const logicalCpuCount = Math.max(
    1,
    Math.min(4_096, Math.trunc(options.logicalCpuCount ?? availableParallelism())),
  );
  const readCpuUsage = options.readCpuUsage ?? (() => process.cpuUsage());
  const readMonotonicTimeNs = options.readMonotonicTimeNs ?? (() => process.hrtime.bigint());
  // One memoryUsage() yields rss and the heap detail together; memoryUsage.rss() alone also
  // reads /proc on Linux, so the merged call costs nothing extra.
  const readMemoryUsage = options.readMemoryUsage ?? (() => process.memoryUsage());
  const readUptimeSeconds = options.readUptimeSeconds ?? (() => process.uptime());
  const instanceToken = options.instanceToken ?? resolveProcessInstanceToken();
  // Machine physical memory is read once at construction: remote CLI samples need it to override the desktop's total_memory_gb.
  const totalMemoryGb = toRoundedUnit(
    (options.readTotalMemoryBytes ?? (() => totalmem()))(),
    1024 ** 3,
  );
  const timer = options.timer ?? defaultTimer;
  let baseline: ResourceSamplerBaseline | undefined;
  let timerHandle: ResourceSamplerTimerHandle | undefined;

  const readBaseline = (): ResourceSamplerBaseline => ({
    cpu: readCpuUsage(),
    monotonicTimeNs: readMonotonicTimeNs(),
  });

  const sample = (): void => {
    try {
      const nextBaseline = readBaseline();
      if (!baseline) {
        baseline = nextBaseline;
        return;
      }
      const elapsedNs = nextBaseline.monotonicTimeNs - baseline.monotonicTimeNs;
      const cpuDeltaUs =
        nextBaseline.cpu.user - baseline.cpu.user + (nextBaseline.cpu.system - baseline.cpu.system);
      if (elapsedNs <= 0n || cpuDeltaUs < 0) {
        baseline = nextBaseline;
        return;
      }
      const intervalMs = Math.round(Number(elapsedNs) / 1_000_000);
      if (intervalMs <= 0) {
        baseline = nextBaseline;
        return;
      }
      const cpuCores = cpuDeltaUs / (Number(elapsedNs) / 1_000);
      const memoryUsage = readMemoryUsage();
      const rssKb = memoryUsage.rss / 1_024;
      const uptimeMinutes = toRoundedUnit(readUptimeSeconds(), 60);
      baseline = nextBaseline;
      const resourceSample: ZCodeProcessResourceSample = {
        platform,
        arch,
        logicalCpuCount,
        intervalMs,
        cpuCores: roundResourceMetric(cpuCores),
        cpuPercent: roundResourceMetric((cpuCores / logicalCpuCount) * 100),
        rssKb: roundResourceMetric(rssKb),
        heapUsedKb: roundResourceMetric(memoryUsage.heapUsed / 1_024),
        instanceToken,
        ...(uptimeMinutes === undefined ? {} : { uptimeMinutes }),
        ...(totalMemoryGb === undefined ? {} : { totalMemoryGb }),
      };
      try {
        options.onSample(resourceSample, memoryUsage);
      } catch {
        // With the reporter closed or backpressured, drop the current sample; never carry the exception into the Agent's main loop.
      }
    } catch {
      // A process-metrics API error only skips the period, keeping the last good baseline for recovery.
    }
  };

  return {
    start() {
      if (timerHandle) {
        return;
      }
      try {
        baseline = readBaseline();
      } catch {
        baseline = undefined;
      }
      try {
        timerHandle = timer.setInterval(sample, ZCODE_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS);
      } catch {
        timerHandle = undefined;
        return;
      }
      try {
        timerHandle.unref?.();
      } catch {
        // If unref is unavailable, keep the timer owner so stop can still reclaim the timer.
      }
    },
    stop() {
      if (!timerHandle) {
        return;
      }
      const handle = timerHandle;
      timerHandle = undefined;
      baseline = undefined;
      try {
        timer.clearInterval(handle);
      } catch {
        // A sampler cleanup failure must not block the CLI's existing exit path.
      }
    },
  };
}
