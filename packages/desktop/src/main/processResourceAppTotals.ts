/**
 * * The value: resource totals for one batch of processes at an instant.
 *
 * * Device-level perf_system_window app totals sum two parts: the Chromium-family total main enumerates exactly,
 * plus the latest known samples from external sources (CLI/MCP). Same semantics, hence one type and one adder.
 */

import { roundMetric } from "./resourceMetricsStats.js";

export interface AppResourceTotals {
  /** CPU sum for this batch (machine-normalized percent). */
  cpuPercent: number;
  rssKbTotal: number;
  processCount: number;
}

export function createEmptyAppResourceTotals(): AppResourceTotals {
  return { cpuPercent: 0, rssKbTotal: 0, processCount: 0 };
}

/** Adds two totals; round CPU once after summing, or error compounds per process. */
export function addAppResourceTotals(
  base: AppResourceTotals,
  extra: AppResourceTotals,
): AppResourceTotals {
  return {
    cpuPercent: roundMetric(base.cpuPercent + extra.cpuPercent),
    rssKbTotal: base.rssKbTotal + extra.rssKbTotal,
    processCount: base.processCount + extra.processCount,
  };
}
