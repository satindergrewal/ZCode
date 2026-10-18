/**
 * Sample source for zcode-cli roles (cli_chat / cli_aux) (registry row five).
 *
 * Each CLI process self-samples every 60s and reports via the protocol into services (laned by owning process manager),
 * then the Host forwards to main. Latest reading kept per role x runtime_surface x process instance,
 * and every 60s the alive-process total goes to the window aggregator:
 *
 * - Why not every 10s tick: CLI grain is 60s; per-tick delivery double-counts one reading and
 *   pushes sample_count from the expected 5 to 30.
 * - Why not emit-on-arrival/clear-on-delivery (the host/renderer heap approach): per-process 60s timers
 *   phase independently, so a tick sees only some processes and undercounts peak/total.
 *   Role events need concurrent-alive count and total; per-process latest readings are kept.
 * - Expiry matches device-level external samples: no new reading for two periods means exited.
 *   Undercounting beats presenting stale values as current facts.
 * - Deliver only on new readings, so one reading never counts twice.
 * - Normal exit runs flushPending: readings received but not yet due in the 60s cycle are delivered
 *   (existing facts only, no new sampling).
 *
 * Privacy: instanceToken lives only in this module's memory to tell processes apart; no ARMS attrs, no pid in samples.
 */

import {
  agentLaneResourceSampleSchema,
  resolveCliProcessResourceRole,
  ZCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS,
  type AgentLaneResourceSample,
  type ProcessResourceRole,
  type ProcessResourceRuntimeSurface,
} from "@zcode/shared";
import { recordExternalAppResourceSample } from "./processResourceExternalAppSamples.js";
import type {
  ProcessResourceSampleContext,
  ProcessResourceSampleSource,
} from "./processResourceSampleSources.js";
import {
  processResourceHardwareKey,
  type ProcessResourceHardwareOverride,
  type ProcessRoleSample,
} from "./processResourceWindowAggregator.js";
import { roundMetric } from "./resourceMetricsStats.js";

/**
 * Cap on simultaneously tracked CLI processes (bounds memory).
 * Normal shape: one chat process per workspace plus three control-plane lanes; 64 is generous, extras are dropped.
 */
const PROCESS_RESOURCE_MAX_CLI_INSTANCES = 64;

/** Legacy CLI samples without instanceToken share one bucket: indistinguishable, counted as one process. */
const LEGACY_INSTANCE_KEY = "legacy";

interface StoredCliSample {
  role: ProcessResourceRole;
  runtimeSurface: ProcessResourceRuntimeSurface;
  environmentKey?: string;
  sample: AgentLaneResourceSample;
  /** Arrival time, expiry checks only. */
  receivedAt: number;
  /**
   * Whether this reading was already delivered to the window aggregator.
   * Explicit flag, not a timestamp compare: same-millisecond delivery would look delivered and be dropped for good.
   */
  delivered: boolean;
}

const latestSamplesByInstance = new Map<string, StoredCliSample>();

/**
 * Main-side trust boundary: the payload passed strict Host response validation; validate once more here
 * (scheduler/remote-relay paths share this entry). Invalid samples are dropped, never thrown.
 */
export function ingestCliResourceSample(
  raw: unknown,
  runtimeSurface: ProcessResourceRuntimeSurface,
  environmentKey?: string,
): void {
  const parsed = agentLaneResourceSampleSchema.safeParse(raw);
  if (!parsed.success) {
    return;
  }
  const sample = parsed.data;
  const role = resolveCliProcessResourceRole(sample.lane);
  const key = [
    role,
    runtimeSurface,
    environmentKey ?? "",
    sample.instanceToken ?? LEGACY_INSTANCE_KEY,
  ].join(":");
  if (
    !latestSamplesByInstance.has(key) &&
    latestSamplesByInstance.size >= PROCESS_RESOURCE_MAX_CLI_INSTANCES
  ) {
    return;
  }
  const receivedAt = Date.now();
  latestSamplesByInstance.set(key, {
    role,
    runtimeSurface,
    environmentKey,
    sample,
    receivedAt,
    delivered: false,
  });
  // Device totals keep per-instance arrival times; a group delivery time would let idle instances ride on active ones.
  recordExternalAppResourceSample({
    sourceKey: `cli:${key}`,
    runtimeSurface,
    cpuPercent: sample.cpuPercent,
    rssKbTotal: sample.rssKb,
    processCount: 1,
    intervalMs: resolveSampleIntervalMs(sample),
    receivedAt,
  });
}

/** Sample period floors at the CLI self-sample interval; shorter gaps must not shrink the expiry window. */
function resolveSampleIntervalMs(sample: AgentLaneResourceSample): number {
  return Math.max(ZCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS, sample.intervalMs);
}

function resolveHardware(sample: AgentLaneResourceSample): ProcessResourceHardwareOverride {
  return {
    platform: sample.platform,
    arch: sample.arch,
    logicalCpuCount: sample.logicalCpuCount,
    // Legacy CLIs omit host memory; the outlet defaults to the desktop machine's value.
    ...(sample.totalMemoryGb === undefined ? {} : { totalMemoryGb: sample.totalMemoryGb }),
  };
}

/** Drops process entries with no new reading for two sample periods. */
function purgeExpired(now: number): void {
  for (const [key, entry] of latestSamplesByInstance) {
    if (now - entry.receivedAt > resolveSampleIntervalMs(entry.sample) * 2) {
      latestSamplesByInstance.delete(key);
    }
  }
}

interface CliRoleGroup {
  role: ProcessResourceRole;
  runtimeSurface: ProcessResourceRuntimeSurface;
  environmentKey?: string;
  /** The group's host machine; part of the group key, hence identical for every member. */
  hardware: ProcessResourceHardwareOverride;
  samples: AgentLaneResourceSample[];
  fresh: boolean;
}

/**
 * Group key: role x runtime_surface x host machine.
 * Machine matters: remote workspaces may run on different hosts -- RSS is not additive and hardware
 * dimensions describe one machine (the aggregator windows by the same fingerprint).
 */
function groupByRole(): CliRoleGroup[] {
  const groups = new Map<string, CliRoleGroup>();
  for (const entry of latestSamplesByInstance.values()) {
    const hardware = resolveHardware(entry.sample);
    // Same hardware is not the same environment; the Host-injected identity spans instance cache and grouping.
    const key = [
      entry.role,
      entry.runtimeSurface,
      entry.environmentKey ?? "",
      processResourceHardwareKey(hardware),
    ].join(":");
    const group = groups.get(key);
    if (group) {
      group.samples.push(entry.sample);
      group.fresh ||= !entry.delivered;
      continue;
    }
    groups.set(key, {
      role: entry.role,
      runtimeSurface: entry.runtimeSurface,
      environmentKey: entry.environmentKey,
      hardware,
      samples: [entry.sample],
      fresh: !entry.delivered,
    });
  }
  return [...groups.values()];
}

function projectRoleSample(group: CliRoleGroup): ProcessRoleSample {
  let cpuPercent = 0;
  let rssKbTotal = 0;
  let rssKbMaxProcess = 0;
  let uptimeMinutes = 0;
  let heapUsedKb: number | undefined;
  for (const sample of group.samples) {
    cpuPercent += sample.cpuPercent;
    rssKbTotal += sample.rssKb;
    rssKbMaxProcess = Math.max(rssKbMaxProcess, sample.rssKb);
    uptimeMinutes = Math.max(uptimeMinutes, sample.uptimeMinutes ?? 0);
    // Multi-process roles take the largest single-process heap of this sample.
    if (sample.heapUsedKb !== undefined) {
      heapUsedKb = Math.max(heapUsedKb ?? 0, sample.heapUsedKb);
    }
  }

  return {
    role: group.role,
    runtimeSurface: group.runtimeSurface,
    ...(group.environmentKey === undefined ? {} : { environmentKey: group.environmentKey }),
    // Round CPU once after summing; per-item rounding accumulates error with process count.
    cpuPercent: roundMetric(cpuPercent),
    rssKbTotal: roundMetric(rssKbTotal),
    rssKbMaxProcess: roundMetric(rssKbMaxProcess),
    processCount: group.samples.length,
    uptimeMinutes,
    ...(heapUsedKb === undefined ? {} : { heapUsedKb }),
    hardware: group.hardware,
  };
}

/** Last role-sample delivery to the window aggregator (context.now, same clock as ingest Date.now()). */
let lastDeliveredAt: number | null = null;

/** Received-but-undelivered readings exist; without new data the same facts are never re-delivered. */
function hasUndeliveredReading(): boolean {
  for (const entry of latestSamplesByInstance.values()) {
    if (!entry.delivered) {
      return true;
    }
  }
  return false;
}

/** Delivers alive groups with new readings to the role window; device totals accrue per instance at ingest. */
function deliverRoleSamples(context: ProcessResourceSampleContext): void {
  lastDeliveredAt = context.now;
  // Read every group's has-new flag before sealing; global has-new is not per-group, stale groups must not renew.
  const groups = groupByRole();
  for (const entry of latestSamplesByInstance.values()) {
    entry.delivered = true;
  }
  for (const group of groups) {
    if (!group.fresh) continue;
    context.addRoleSample(projectRoleSample(group));
  }
}

export const cliProcessResourceSampleSource: ProcessResourceSampleSource = {
  id: "cli",
  sample(context) {
    purgeExpired(context.now);
    // Deliver per 60s and only on new readings: window slicing stays on main's flush clock;
    // this only defines what one CLI sample is, so a reading never counts twice.
    if (
      lastDeliveredAt !== null &&
      context.now - lastDeliveredAt < ZCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS
    ) {
      return;
    }
    if (!hasUndeliveredReading()) {
      return;
    }
    deliverRoleSamples(context);
  },
  flushPending(context) {
    // Normal exit: flush readings received this cycle but not yet due, else a 1-minute
    // window (dev/E2E) exit yields zero cli-role events.
    purgeExpired(context.now);
    if (!hasUndeliveredReading()) {
      return;
    }
    deliverRoleSamples(context);
  },
  reset() {
    latestSamplesByInstance.clear();
    lastDeliveredAt = null;
  },
};
