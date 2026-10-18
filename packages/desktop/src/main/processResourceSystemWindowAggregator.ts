/**
 * * Bounded aggregation window for device-level resources.
 *
 * One perf_system_window per device per window: machine CPU and free memory, app totals, and telemetry overhead.
 * Like role windows: in-memory, bounded, no queue, no retry; flush projects one report.
 */

import {
  appendBoundedSamples,
  computeAggregateStats,
  roundMetric,
} from "./resourceMetricsStats.js";
import { PROCESS_RESOURCE_MAX_SAMPLES_PER_WINDOW } from "./processResourceWindowAggregator.js";

/* /** One 10s tick of device facts; no sample without a machine-CPU baseline. */
export interface DeviceResourceSample {
  /* /** Machine CPU (normalized percent from two os.cpus() deltas). */
  systemCpuPercent: number;
  systemFreeMemoryKb: number;
  /* /** CPU sum across all local ZCode processes. */
  appCpuPercent: number;
  appRssKbTotal: number;
  appProcessCount: number;
}

export interface SystemResourceWindowReport {
  backgroundRatio: number;
  appUptimeMinutes: number;
  systemCpuPercentP95: number;
  systemFreeMemoryKbMin: number;
  /* /** Event value. */
  appCpuPercentMean: number;
  appCpuPercentP95: number;
  appRssKbTotalMean: number;
  appRssKbTotalPeak: number;
  processCountTotalPeak: number;
  sampleCount: number;
  telemetrySelfMs: number;
}

export class ProcessResourceSystemWindowAggregator {
  private systemCpuPercent: number[] = [];
  private systemFreeMemoryKb: number[] = [];
  private appCpuPercent: number[] = [];
  private appRssKbTotal: number[] = [];
  private processCountTotalPeak = 0;
  private telemetrySelfMs = 0;

  add(sample: DeviceResourceSample): void {
    this.systemCpuPercent = appendSample(this.systemCpuPercent, sample.systemCpuPercent);
    this.systemFreeMemoryKb = appendSample(this.systemFreeMemoryKb, sample.systemFreeMemoryKb);
    this.appCpuPercent = appendSample(this.appCpuPercent, sample.appCpuPercent);
    this.appRssKbTotal = appendSample(this.appRssKbTotal, sample.appRssKbTotal);
    this.processCountTotalPeak = Math.max(this.processCountTotalPeak, sample.appProcessCount);
  }

  /**
   * * Accumulates wall time spent in main-side telemetry itself (self-accounting).
   * flush's own cost lands in the next window: it runs after projection.
   */
  addTelemetrySelfMs(elapsedMs: number): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
      return;
    }
    this.telemetrySelfMs += elapsedMs;
  }

  /**
   * * Takes and clears the window. null when no device sample, emitting no empty event;
   * accrued overhead carries forward: windows with failing samples need the overhead figure most.
   * Role aggregators supply backgroundRatio from scene counts, keeping both events consistent.
   */
  drain(input: {
    backgroundRatio: number;
    appUptimeMinutes: number;
  }): SystemResourceWindowReport | null {
    if (this.appCpuPercent.length === 0) {
      this.clearSamples();
      return null;
    }

    const systemCpu = computeAggregateStats(this.systemCpuPercent);
    const appCpu = computeAggregateStats(this.appCpuPercent);
    const appRss = computeAggregateStats(this.appRssKbTotal);
    const report: SystemResourceWindowReport = {
      backgroundRatio: input.backgroundRatio,
      appUptimeMinutes: input.appUptimeMinutes,
      systemCpuPercentP95: systemCpu.p95,
      systemFreeMemoryKbMin: Math.min(...this.systemFreeMemoryKb),
      appCpuPercentMean: appCpu.mean,
      appCpuPercentP95: appCpu.p95,
      appRssKbTotalMean: appRss.mean,
      appRssKbTotalPeak: appRss.peak,
      processCountTotalPeak: this.processCountTotalPeak,
      sampleCount: appCpu.sample_count,
      telemetrySelfMs: roundMetric(this.telemetrySelfMs),
    };
    this.clear();
    return report;
  }

  clear(): void {
    this.clearSamples();
    this.telemetrySelfMs = 0;
  }

  private clearSamples(): void {
    this.systemCpuPercent = [];
    this.systemFreeMemoryKb = [];
    this.appCpuPercent = [];
    this.appRssKbTotal = [];
    this.processCountTotalPeak = 0;
  }
}

/** Same cap and overflow policy as role windows: on timer drift, keep the window-tail readings. */
function appendSample(bucket: number[], value: number): number[] {
  return appendBoundedSamples(bucket, value, PROCESS_RESOURCE_MAX_SAMPLES_PER_WINDOW);
}
