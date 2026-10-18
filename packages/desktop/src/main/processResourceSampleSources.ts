/**
 * * Types and scheduling for the resource-sample source registry.
 *
 * * Each source is its own file registering one line; sources never know each other.
 * * A failing sample drops only that source's data, never blocking business flows.
 */

import type { ProcessResourceRole } from "@zcode/shared";
import type { AppResourceTotals } from "./processResourceAppTotals.js";
import type { DeviceResourceSample } from "./processResourceSystemWindowAggregator.js";
import type { ProcessRoleSample } from "./processResourceWindowAggregator.js";

export interface ProcessResourceSampleContext {
  /** Wall-clock for this tick, shared by all sources to avoid intra-tick drift. */
  now: number;
  addRoleSample: (sample: ProcessRoleSample) => void;
  /**
   * Hook for sources contributing heap only, not a full role sample (host/scheduler
   * self-sampling, renderer). Heap merges into that role's full sample in the same tick;
   * with no full sample this tick, the reading drops: heap is an additive dimension,
   * never a window of its own.
   */
  addRoleHeapSample: (role: ProcessResourceRole, heapUsedKb: number) => void;
  /**
   * App-process totals main can enumerate exactly this tick (Chromium family only today).
   * The device-level stage reads it for app totals, so it must not double-count external sample entries.
   */
  addAppProcessTotals: (totals: AppResourceTotals) => void;
  onError?: (sourceId: string, error: unknown) => void;
}

/**
 * * Context for device-level (phase two) sampling: relies on phase-one facts from the same tick.
 * Splitting the phases removes order-dependence and module-level value passing between sources.
 */
export interface ProcessResourceDeviceSampleContext {
  now: number;
  /** Phase-one exact totals; null when no source contributed this tick, so no device sample is produced. */
  appProcessTotals: AppResourceTotals | null;
  addDeviceSample: (sample: DeviceResourceSample) => void;
  onError?: (sourceId: string, error: unknown) => void;
}

export interface ProcessResourceSampleSource {
  /** Source id for logs and registry uniqueness only; never an event attribute. */
  readonly id: string;
  /**
   * Called on main's 10s tick to fold this source's instant facts into the open window.
   *
   * Push-style sources (host/scheduler heap, renderer heap, CLI, MCP) use it too:
   * each exports ingestXxx(sample) for the dispatch point, caching the latest sample in the source module,
   * then hands it to the aggregator in sample(). Window boundaries stay solely on main's flush clock,
   * sources stay oblivious to each other, and the registry grows by one line.
   */
  sample?: (context: ProcessResourceSampleContext) => void;
  /**
   * Hook for sources needing same-tick facts from other sources (perf_system_window).
   * All sample() calls complete before any sampleDevice() in the same tick.
   */
  sampleDevice?: (context: ProcessResourceDeviceSampleContext) => void;
  /**
   * On graceful shutdown, drains stragglers: readings received but not yet delivered join the window
   * (CLI, MCP likewise). Moves existing facts only, no new sampling: the exit path must not call
   * getAppMetrics() or start probes.
   */
  flushPending?: (context: ProcessResourceSampleContext) => void;
  /** Clears cached transient state on stop/restart so sessions never bleed into each other. */
  reset?: () => void;
}

export function runProcessResourceSampleSources(
  sources: readonly ProcessResourceSampleSource[],
  context: ProcessResourceSampleContext,
): void {
  for (const source of sources) {
    try {
      source.sample?.(context);
    } catch (error) {
      context.onError?.(source.id, error);
    }
  }
}

export function runProcessResourceDeviceSampleSources(
  sources: readonly ProcessResourceSampleSource[],
  context: ProcessResourceDeviceSampleContext,
): void {
  for (const source of sources) {
    try {
      source.sampleDevice?.(context);
    } catch (error) {
      context.onError?.(source.id, error);
    }
  }
}

export function flushPendingProcessResourceSampleSources(
  sources: readonly ProcessResourceSampleSource[],
  context: ProcessResourceSampleContext,
): void {
  for (const source of sources) {
    try {
      source.flushPending?.(context);
    } catch (error) {
      context.onError?.(source.id, error);
    }
  }
}

export function resetProcessResourceSampleSources(
  sources: readonly ProcessResourceSampleSource[],
): void {
  for (const source of sources) {
    try {
      source.reset?.();
    } catch {
      // reset only drops transient state; failures never affect other sources or later samples.
    }
  }
}
