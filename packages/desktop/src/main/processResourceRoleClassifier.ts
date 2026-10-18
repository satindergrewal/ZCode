/**
 * Process-role classification and per-role aggregation for the Chromium family (main-side getAppMetrics).
 * Pure functions, zero Electron runtime deps, unit-testable; pid sets come from the resourceManagerWindow registry.
 */

import type { ProcessResourceRole } from "@zcode/shared";
import {
  addAppResourceTotals,
  createEmptyAppResourceTotals,
  type AppResourceTotals,
} from "./processResourceAppTotals.js";
import { roundMetric } from "./resourceMetricsStats.js";

/** The seven roles getAppMetrics covers; cli and mcp come from CLI samples and never appear here. */
export const CHROMIUM_PROCESS_RESOURCE_ROLES = [
  "main",
  "renderer_main",
  "renderer_guest",
  "gpu",
  "chromium_other",
  "host",
  "scheduler",
] as const satisfies readonly ProcessResourceRole[];

export type ChromiumProcessResourceRole = (typeof CHROMIUM_PROCESS_RESOURCE_ROLES)[number];

/** Normalized per-process sample: CPU normalized machine-wide, memory in KB. */
export interface ChromiumProcessMetricSample {
  pid: number;
  type: string;
  cpuPercent: number;
  rssKb: number;
  /** Process start time (epoch ms); unknown when absent, runtime counts as 0. */
  creationTime?: number;
}

/**
 * Role-keyed pid snapshot. renderer must separate the main window from webview guests;
 * host/scheduler utilityProcess pids are registered at their spawn points.
 */
export interface ChromiumProcessRolePids {
  mainPid: number;
  mainWindowRendererPids: ReadonlySet<number>;
  guestRendererPids: ReadonlySet<number>;
  hostPids: ReadonlySet<number>;
  schedulerPids: ReadonlySet<number>;
}

export interface ChromiumRoleAggregate {
  role: ChromiumProcessResourceRole;
  /** CPU sum over the role's processes (machine-normalized percent). */
  cpuPercent: number;
  rssKbTotal: number;
  rssKbMaxProcess: number;
  processCount: number;
  /** Age in minutes of the role's oldest process. */
  uptimeMinutes: number;
}

/**
 * Aggregate every Chromium role for a tick into the app total main can enumerate exactly.
 * Device-level app totals take Chromium only here; CLI/MCP use the external-sample ingress, no double count.
 */
export function sumChromiumRoleAggregates(
  aggregates: readonly ChromiumRoleAggregate[],
): AppResourceTotals {
  let totals = createEmptyAppResourceTotals();
  for (const aggregate of aggregates) {
    totals = addAppResourceTotals(totals, {
      cpuPercent: aggregate.cpuPercent,
      rssKbTotal: aggregate.rssKbTotal,
      processCount: aggregate.processCount,
    });
  }
  return totals;
}

export function classifyChromiumProcessRole(
  sample: Pick<ChromiumProcessMetricSample, "pid" | "type">,
  pids: ChromiumProcessRolePids,
): ChromiumProcessResourceRole {
  if (sample.pid === pids.mainPid) {
    return "main";
  }
  if (sample.type === "GPU") {
    return "gpu";
  }
  if (pids.mainWindowRendererPids.has(sample.pid)) {
    return "renderer_main";
  }
  if (pids.guestRendererPids.has(sample.pid)) {
    return "renderer_guest";
  }
  if (pids.hostPids.has(sample.pid)) {
    return "host";
  }
  if (pids.schedulerPids.has(sample.pid)) {
    return "scheduler";
  }
  return "chromium_other";
}

function uptimeMinutesOf(sample: ChromiumProcessMetricSample, now: number): number {
  const creationTime = sample.creationTime;
  if (typeof creationTime !== "number" || !Number.isFinite(creationTime) || creationTime <= 0) {
    return 0;
  }
  return Math.max(0, Math.round((now - creationTime) / 60_000));
}

/** Aggregates the tick's Chromium processes by role; returns only roles with live processes. */
export function aggregateChromiumProcessRoles(input: {
  processes: readonly ChromiumProcessMetricSample[];
  pids: ChromiumProcessRolePids;
  now: number;
}): ChromiumRoleAggregate[] {
  const byRole = new Map<ChromiumProcessResourceRole, ChromiumRoleAggregate>();

  for (const sample of input.processes) {
    const role = classifyChromiumProcessRole(sample, input.pids);
    const existing = byRole.get(role);
    const uptimeMinutes = uptimeMinutesOf(sample, input.now);
    if (!existing) {
      byRole.set(role, {
        role,
        cpuPercent: sample.cpuPercent,
        rssKbTotal: sample.rssKb,
        rssKbMaxProcess: sample.rssKb,
        processCount: 1,
        uptimeMinutes,
      });
      continue;
    }
    // Round once after summing; per-item rounding accumulates error with process count.
    existing.cpuPercent += sample.cpuPercent;
    existing.rssKbTotal += sample.rssKb;
    existing.rssKbMaxProcess = Math.max(existing.rssKbMaxProcess, sample.rssKb);
    existing.processCount += 1;
    existing.uptimeMinutes = Math.max(existing.uptimeMinutes, uptimeMinutes);
  }

  // Output order follows the role enum, keeping event order stable in tests and dashboards.
  return CHROMIUM_PROCESS_RESOURCE_ROLES.map((role) => byRole.get(role))
    .filter((aggregate): aggregate is ChromiumRoleAggregate => aggregate !== undefined)
    .map((aggregate) => ({ ...aggregate, cpuPercent: roundMetric(aggregate.cpuPercent) }));
}
