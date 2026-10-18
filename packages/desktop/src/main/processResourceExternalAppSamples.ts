/**
 * External-sample ingress for the device-level app total.
 *
 * perf_system_window's app total = Chromium's exact per-10s sum plus the latest known external samples.
 * External processes (CLI 60s self-sample, MCP 5-minute) are outside app.getAppMetrics() and cannot
 * match main's 10s cadence, so only each source's latest sample is kept, expiring on that source's
 * own period: no new sample for two periods means exited/broken -- undercount, never stale-as-current.
 * two silent periods means exited/broken ingress: undercount, never present stale as current.
 *
 * CLI and MCP roles call recordExternalAppResourceSample at their own ingest points.
 * Pure memory, bounded, fail-drop: no queues, no persistence, no retries.
 */

import type { ProcessResourceRuntimeSurface } from "@zcode/shared";
import {
  addAppResourceTotals,
  createEmptyAppResourceTotals,
  type AppResourceTotals,
} from "./processResourceAppTotals.js";

/** Period when a source does not self-report (CLI cadence). */
const EXTERNAL_APP_RESOURCE_SAMPLE_DEFAULT_INTERVAL_MS = 60_000;

/**
 * Source entry cap (memory bound).
 * CLI's 64-instance budget adds these 64 slots; MCP space unchanged.
 * Raising the memory cap only -- no new queues/timers; excess sources are dropped.
 */
const PROCESS_RESOURCE_MAX_EXTERNAL_SAMPLE_SOURCES = 128;

interface ExternalAppResourceSample extends AppResourceTotals {
  /**
   * Stable source key (CLI instance, MCP group): overrides old samples and drives expiry only.
   * Never an ARMS attribute: no pids, paths, or workspace identifiers.
   */
  sourceKey: string;
  /** Device totals count local processes only; remote CLI/MCP samples are dropped here. */
  runtimeSurface: ProcessResourceRuntimeSurface;
  /** Source period; expiry at 2x silence. Default 60s. */
  intervalMs?: number;
  /** When main received the sample. */
  receivedAt: number;
}

interface StoredExternalSample extends AppResourceTotals {
  receivedAt: number;
  expiresAfterMs: number;
}

const latestSamplesBySource = new Map<string, StoredExternalSample>();

function isNonNegativeFinite(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/** Records a source's latest sample; invalid samples drop without touching totals. */
export function recordExternalAppResourceSample(sample: ExternalAppResourceSample): void {
  if (sample.runtimeSurface !== "local" || !sample.sourceKey) {
    return;
  }
  if (
    !isNonNegativeFinite(sample.cpuPercent) ||
    !isNonNegativeFinite(sample.rssKbTotal) ||
    !isNonNegativeFinite(sample.processCount) ||
    !Number.isFinite(sample.receivedAt)
  ) {
    return;
  }
  if (
    !latestSamplesBySource.has(sample.sourceKey) &&
    latestSamplesBySource.size >= PROCESS_RESOURCE_MAX_EXTERNAL_SAMPLE_SOURCES
  ) {
    return;
  }

  const intervalMs =
    typeof sample.intervalMs === "number" &&
    Number.isFinite(sample.intervalMs) &&
    sample.intervalMs > 0
      ? sample.intervalMs
      : EXTERNAL_APP_RESOURCE_SAMPLE_DEFAULT_INTERVAL_MS;

  latestSamplesBySource.set(sample.sourceKey, {
    cpuPercent: sample.cpuPercent,
    rssKbTotal: sample.rssKbTotal,
    processCount: sample.processCount,
    receivedAt: sample.receivedAt,
    expiresAfterMs: intervalMs * 2,
  });
}

/** Sums unexpired sources, pruning expired ones so zombies never linger. */
export function collectExternalAppResourceTotals(now: number): AppResourceTotals {
  let totals = createEmptyAppResourceTotals();
  for (const [sourceKey, sample] of latestSamplesBySource) {
    if (now - sample.receivedAt > sample.expiresAfterMs) {
      latestSamplesBySource.delete(sourceKey);
      continue;
    }
    totals = addAppResourceTotals(totals, sample);
  }
  return totals;
}

/** Clears all sources on sampling start/stop; no cross-session bleed. */
export function resetExternalAppResourceSamples(): void {
  latestSamplesBySource.clear();
}
