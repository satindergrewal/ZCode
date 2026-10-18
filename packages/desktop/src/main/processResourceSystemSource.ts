/**
 * * Device-level sample source.
 *
 * Shares main's 10s tick with the Chromium family and runs in phase two:
 * os.cpus() deltas give machine CPU, os.freemem() free memory,
 * and app totals add phase-one exact sums to the latest external samples (CLI/MCP).
 * In-process APIs only; main spawns nothing.
 */

import os from "node:os";
import { addAppResourceTotals } from "./processResourceAppTotals.js";
import {
  collectExternalAppResourceTotals,
  resetExternalAppResourceSamples,
} from "./processResourceExternalAppSamples.js";
import type { ProcessResourceSampleSource } from "./processResourceSampleSources.js";
import { roundMetric } from "./resourceMetricsStats.js";

/* /** Cumulative CPU snapshot; only the delta of two snapshots is machine CPU over time. */
interface SystemCpuTimesSnapshot {
  busyMs: number;
  totalMs: number;
}

function summarizeSystemCpuTimes(cpus: readonly os.CpuInfo[]): SystemCpuTimesSnapshot {
  let busyMs = 0;
  let idleMs = 0;
  for (const cpu of cpus) {
    const times = cpu.times;
    busyMs += (times?.user ?? 0) + (times?.nice ?? 0) + (times?.sys ?? 0) + (times?.irq ?? 0);
    idleMs += times?.idle ?? 0;
  }
  return { busyMs, totalMs: busyMs + idleMs };
}

/**
 * * Delta percent of two snapshots; null when no usable delta, so no sample this tick.
 * null cases: stalled counters (empty os.cpus in containers), core-count changes, or clock rollback negative deltas.
 */
function diffSystemCpuPercent(
  previous: SystemCpuTimesSnapshot,
  next: SystemCpuTimesSnapshot,
): number | null {
  const totalDeltaMs = next.totalMs - previous.totalMs;
  const busyDeltaMs = next.busyMs - previous.busyMs;
  if (!(totalDeltaMs > 0) || busyDeltaMs < 0) {
    return null;
  }
  return roundMetric(Math.min(100, (busyDeltaMs / totalDeltaMs) * 100));
}

let previousCpuTimes: SystemCpuTimesSnapshot | null = null;

export const systemProcessResourceSampleSource: ProcessResourceSampleSource = {
  id: "system",
  sampleDevice(context) {
    const snapshot = summarizeSystemCpuTimes(os.cpus());
    const baseline = previousCpuTimes;
    previousCpuTimes = snapshot;

    // The first tick has one snapshot, so no delta and no sample;
    // likewise when phase one has no exact totals: prefer a missing sample to a half-true total.
    if (!baseline || !context.appProcessTotals) {
      return;
    }
    const systemCpuPercent = diffSystemCpuPercent(baseline, snapshot);
    if (systemCpuPercent === null) {
      return;
    }

    const appTotals = addAppResourceTotals(
      context.appProcessTotals,
      collectExternalAppResourceTotals(context.now),
    );
    context.addDeviceSample({
      systemCpuPercent,
      systemFreeMemoryKb: Math.round(os.freemem() / 1024),
      appCpuPercent: appTotals.cpuPercent,
      appRssKbTotal: appTotals.rssKbTotal,
      appProcessCount: appTotals.processCount,
    });
  },
  reset() {
    // Drop the CPU baseline and external latest-samples so a new session never reuses old facts.
    previousCpuTimes = null;
    resetExternalAppResourceSamples();
  },
};
