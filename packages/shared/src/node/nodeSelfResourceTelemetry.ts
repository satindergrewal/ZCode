/**
 * Shared conversion for the host and scheduler utilityProcesses' self-sampled CPU/memory.
 *
 * Differencing only: no timers, no sending. The host reuses the memory diagnostic log's 60s timer;
 * the scheduler owns a single unref timer; both hand the same process.memoryUsage() reading here for one sample.
 * Zero subprocesses, in-process APIs only.
 */

import { availableParallelism } from "node:os";
import { bytesToKb } from "../memoryDiagnostics.js";
import type { NodeSelfResourceSample } from "../validation.js";

interface NodeCpuUsageSnapshot {
  user: number;
  system: number;
}

/** Node self-sample period: 60s, in step with the local memory diagnostic log. */
export const NODE_SELF_RESOURCE_SAMPLE_INTERVAL_MS = 60_000;

export interface NodeSelfResourceSamplerOptions {
  readCpuUsage?: () => NodeCpuUsageSnapshot;
  readMonotonicTimeNs?: () => bigint;
  logicalCpuCount?: number;
}

export interface NodeSelfResourceSampler {
  /**
   * Convert the caller's fresh memoryUsage into one sample.
   * null when the baseline is unusable (first-read failure, stalled clock, CPU counter regression); only this sample drops.
   */
  sample(memoryUsage: NodeJS.MemoryUsage): NodeSelfResourceSample | null;
}

interface SamplerBaseline {
  cpu: NodeCpuUsageSnapshot;
  monotonicTimeNs: bigint;
}

/** CPU percent to 4 decimals, same convention as the CLI's self-samples. */
function roundResourceMetric(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

export function createNodeSelfResourceSampler(
  options: NodeSelfResourceSamplerOptions = {},
): NodeSelfResourceSampler {
  const readCpuUsage = options.readCpuUsage ?? (() => process.cpuUsage());
  const readMonotonicTimeNs = options.readMonotonicTimeNs ?? (() => process.hrtime.bigint());
  const logicalCpuCount = Math.max(
    1,
    Math.min(4_096, Math.trunc(options.logicalCpuCount ?? availableParallelism())),
  );

  const readBaseline = (): SamplerBaseline | null => {
    try {
      return { cpu: readCpuUsage(), monotonicTimeNs: readMonotonicTimeNs() };
    } catch {
      return null;
    }
  };

  // Baseline at construction, so the first 60s tick yields a sample instead of idling a round.
  let baseline = readBaseline();

  return {
    sample(memoryUsage) {
      const next = readBaseline();
      if (!next) {
        return null;
      }
      const previous = baseline;
      baseline = next;
      if (!previous) {
        return null;
      }

      const elapsedNs = next.monotonicTimeNs - previous.monotonicTimeNs;
      const cpuDeltaUs =
        next.cpu.user - previous.cpu.user + (next.cpu.system - previous.cpu.system);
      if (elapsedNs <= 0n || cpuDeltaUs < 0) {
        return null;
      }

      const cpuCores = cpuDeltaUs / (Number(elapsedNs) / 1_000);
      return {
        cpuPercent: roundResourceMetric((cpuCores / logicalCpuCount) * 100),
        rssKb: bytesToKb(memoryUsage.rss),
        heapUsedKb: bytesToKb(memoryUsage.heapUsed),
      };
    },
  };
}
