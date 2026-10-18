/**
 * Bounded per-role aggregation windows.
 *
 * Every source (Chromium family, Node self-samples, CLI, MCP) feeds instant role facts;
 * flush projects each window into one perf_process_window. In-memory, bounded, no queues, no retries.
 */

import type { ProcessResourceRole, ProcessResourceRuntimeSurface } from "@zcode/shared";
import {
  appendBoundedSamples,
  computeAggregateStats,
  roundMetric,
} from "./resourceMetricsStats.js";

/** Per-role per-series sample cap (5m @ 10s = 30, +2 for timer drift). */
export const PROCESS_RESOURCE_MAX_SAMPLES_PER_WINDOW = 32;
/**
 * Cap on concurrent windows (memory bound).
 * role x environment x hardware x mcpId each open windows; remote environments share 64 slots,
 * excess windows dropped -- no queueing, no persistence.
 */
const PROCESS_RESOURCE_MAX_WINDOWS = 64;

type ProcessResourceScene = "foreground" | "background";

/** Machine the role actually runs on; the outlet defaults to the desktop machine when absent. */
export interface ProcessResourceHardware {
  platform: NodeJS.Platform;
  arch: string;
  logicalCpuCount: number;
  totalMemoryGb: number;
}

/**
 * Self-reported host info may be partial (legacy CLIs lack totalMemoryGb);
 * the outlet overrides per field, not all-or-nothing.
 */
export type ProcessResourceHardwareOverride = Partial<ProcessResourceHardware>;

/** One role's instant facts at a moment in time. */
export interface ProcessRoleSample {
  role: ProcessResourceRole;
  /** Host-injected environment hash, memory grouping only, never an event attribute. */
  environmentKey?: string;
  /** CPU sum over the role's processes (machine-normalized percent). */
  cpuPercent: number;
  rssKbTotal: number;
  rssKbMaxProcess: number;
  processCount: number;
  uptimeMinutes: number;
  /** Node roles and renderer_main only; absent means no heap reading this round. */
  heapUsedKb?: number;
  runtimeSurface?: ProcessResourceRuntimeSurface;
  /** mcp role only. */
  mcpId?: string;
  hardware?: ProcessResourceHardwareOverride;
}

export interface ProcessRoleWindowReport {
  role: ProcessResourceRole;
  runtimeSurface: ProcessResourceRuntimeSurface;
  mcpId?: string;
  hardware?: ProcessResourceHardwareOverride;
  backgroundRatio: number;
  uptimeMinutes: number;
  cpuPercentMean: number;
  cpuPercentP95: number;
  cpuPercentPeak: number;
  rssKbTotalMean: number;
  rssKbTotalPeak: number;
  rssKbMaxProcessPeak: number;
  heapUsedKbMean?: number;
  heapUsedKbPeak?: number;
  processCountPeak: number;
  sampleCount: number;
}

interface ProcessRoleWindow {
  role: ProcessResourceRole;
  runtimeSurface: ProcessResourceRuntimeSurface;
  mcpId?: string;
  hardware?: ProcessResourceHardwareOverride;
  cpuPercent: number[];
  rssKbTotal: number[];
  rssKbMaxProcess: number[];
  heapUsedKb: number[];
  processCountPeak: number;
  uptimeMinutes: number;
}

/**
 * The hardware fingerprint describes specs, not identity; environment identity comes via the Host window key
 * so same-spec remote CPU/RSS is never summed; hardware still separates specs within one environment.
 * Local roles carry no hardware: empty fingerprint, window key identical to role-only.
 */
export function processResourceHardwareKey(hardware?: ProcessResourceHardwareOverride): string {
  if (!hardware) {
    return "";
  }
  return [
    hardware.platform ?? "",
    hardware.arch ?? "",
    hardware.logicalCpuCount ?? "",
    hardware.totalMemoryGb ?? "",
  ].join("/");
}

function windowKey(sample: ProcessRoleSample): string {
  return [
    sample.role,
    sample.runtimeSurface ?? "local",
    sample.environmentKey ?? "",
    sample.mcpId ?? "",
    processResourceHardwareKey(sample.hardware),
  ].join(":");
}

export class ProcessResourceWindowAggregator {
  private readonly windows = new Map<string, ProcessRoleWindow>();
  private sceneTicks = 0;
  private backgroundTicks = 0;

  /** main records foreground/background each 10s tick; the in-window ratio is shared by all role events. */
  recordScene(scene: ProcessResourceScene): void {
    this.sceneTicks += 1;
    if (scene === "background") {
      this.backgroundTicks += 1;
    }
  }

  add(sample: ProcessRoleSample): void {
    const key = windowKey(sample);
    let window = this.windows.get(key);
    if (!window) {
      if (this.windows.size >= PROCESS_RESOURCE_MAX_WINDOWS) {
        return;
      }
      window = {
        role: sample.role,
        runtimeSurface: sample.runtimeSurface ?? "local",
        mcpId: sample.mcpId,
        hardware: sample.hardware,
        cpuPercent: [],
        rssKbTotal: [],
        rssKbMaxProcess: [],
        heapUsedKb: [],
        processCountPeak: 0,
        uptimeMinutes: 0,
      };
      this.windows.set(key, window);
    }

    // Environment and hardware are both in the window key; one window never mixes dimensions.
    window.cpuPercent = appendBounded(window.cpuPercent, sample.cpuPercent);
    window.rssKbTotal = appendBounded(window.rssKbTotal, sample.rssKbTotal);
    window.rssKbMaxProcess = appendBounded(window.rssKbMaxProcess, sample.rssKbMaxProcess);
    if (typeof sample.heapUsedKb === "number" && Number.isFinite(sample.heapUsedKb)) {
      window.heapUsedKb = appendBounded(window.heapUsedKb, sample.heapUsedKb);
    }
    window.processCountPeak = Math.max(window.processCountPeak, sample.processCount);
    window.uptimeMinutes = Math.max(window.uptimeMinutes, sample.uptimeMinutes);
  }

  /**
   * In-window background tick ratio.
   * Shared by role events and the device perf_system_window, so scene counts live once;
   * drain() zeroes them -- device events must read before draining.
   */
  get backgroundRatio(): number {
    return this.sceneTicks > 0 ? roundMetric(this.backgroundTicks / this.sceneTicks) : 0;
  }

  /** Takes and clears all windows; sample_count reflects reality (partial windows included). */
  drain(): ProcessRoleWindowReport[] {
    const backgroundRatio = this.backgroundRatio;
    const reports = [...this.windows.values()]
      .filter((window) => window.cpuPercent.length > 0)
      .map((window) => projectWindow(window, backgroundRatio));
    this.clear();
    return reports;
  }

  clear(): void {
    this.windows.clear();
    this.sceneTicks = 0;
    this.backgroundTicks = 0;
  }
}

/**
 * Overflow drops the oldest samples: the cap only trips on timer drift (>30 ticks in one window),
 * where the window tail is the facts worth reporting.
 */
function appendBounded(bucket: number[], value: number): number[] {
  return appendBoundedSamples(bucket, value, PROCESS_RESOURCE_MAX_SAMPLES_PER_WINDOW);
}

function projectWindow(
  window: ProcessRoleWindow,
  backgroundRatio: number,
): ProcessRoleWindowReport {
  const cpu = computeAggregateStats(window.cpuPercent);
  const rssTotal = computeAggregateStats(window.rssKbTotal);
  const rssMaxProcess = computeAggregateStats(window.rssKbMaxProcess);
  const heap = window.heapUsedKb.length > 0 ? computeAggregateStats(window.heapUsedKb) : null;

  return {
    role: window.role,
    runtimeSurface: window.runtimeSurface,
    mcpId: window.mcpId,
    hardware: window.hardware,
    backgroundRatio,
    uptimeMinutes: window.uptimeMinutes,
    cpuPercentMean: cpu.mean,
    cpuPercentP95: cpu.p95,
    cpuPercentPeak: cpu.peak,
    rssKbTotalMean: rssTotal.mean,
    rssKbTotalPeak: rssTotal.peak,
    rssKbMaxProcessPeak: rssMaxProcess.peak,
    heapUsedKbMean: heap?.mean,
    heapUsedKbPeak: heap?.peak,
    processCountPeak: window.processCountPeak,
    sampleCount: cpu.sample_count,
  };
}
