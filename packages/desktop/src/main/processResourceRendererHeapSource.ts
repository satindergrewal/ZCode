/**
 * Sample source for the main-window renderer heap (registry row four).
 *
 * Every 60s the renderer reads performance.memory and, in the same reading that feeds local diag logs,
 * send-once to main via the preload bridge. The latest reading is kept here and merged into the
 * renderer_main role sample on the next 10s tick as heap_used_kb_mean / heap_used_kb_peak.
 *
 * Heap only: renderer CPU/RSS come solely from main's getAppMetrics(); mixing 60s readings into
 * the 10s series would pollute sample_count and every statistic.
 * Each reading yields one heap sample (deliver-and-clear); stale values never stand in for current.
 *
 * Attribution is sender-webContents only: the main window webContents is renderer_main;
 * resource-manager/about/DevTools/<webview> guest samples are dropped (they belong to
 * chromium_other / renderer_guest, which carry no heap per the role table).
 */

import { ipcMain } from "electron";
import { PlatformChannels, rendererHeapSampleSchema } from "@zcode/shared";
import type { ProcessResourceSampleSource } from "./processResourceSampleSources.js";
import { isMainApplicationWindowWebContents } from "./resourceManagerWindow.js";

/** Sender webContents id -> undelivered heap reading (KB). */
const pendingHeapUsedKb = new Map<number, number>();

/**
 * Main-side trust boundary: the payload comes from the renderer and is strict-schema validated;
 * invalid messages (missing fields, wrong types, extra path-ish fields) are dropped, not thrown.
 */
export function ingestRendererHeapSample(webContentsId: number, raw: unknown): void {
  if (!isMainApplicationWindowWebContents(webContentsId)) {
    return;
  }
  const parsed = rendererHeapSampleSchema.safeParse(raw);
  if (!parsed.success) {
    return;
  }
  pendingHeapUsedKb.set(webContentsId, parsed.data.heapUsedKb);
}

/** Main-side landing for the preload bridge: send-only, no invoke. */
export function registerRendererHeapSampleIpc(): void {
  // Exactly one listener: re-registration must not stack, or one sample gets ingested twice.
  ipcMain.removeAllListeners(PlatformChannels.ReportRendererHeapSample);
  ipcMain.on(PlatformChannels.ReportRendererHeapSample, (event, payload: unknown) => {
    ingestRendererHeapSample(event.sender.id, payload);
  });
}

export const rendererHeapProcessResourceSampleSource: ProcessResourceSampleSource = {
  id: "renderer_heap",
  sample(context) {
    // Take, then deliver: a delivery throw never leaves the old reading for the next tick.
    const arrivedHeapUsedKb = [...pendingHeapUsedKb.values()];
    pendingHeapUsedKb.clear();
    if (arrivedHeapUsedKb.length === 0) {
      return;
    }
    /**
     * Multi-window: max over readings arrived this tick. Not the rss-style same-tick all-process max:
     * window timers phase independently, so one 10s tick sees only some windows' 60s readings --
     * heap_used_kb_peak is the largest single window, the mean is the mixed average.
     * Heap is a 60s-grain extra dimension; no readings are retained (deliver-and-clear).
     */
    context.addRoleHeapSample("renderer_main", Math.max(...arrivedHeapUsedKb));
  },
  reset() {
    pendingHeapUsedKb.clear();
  },
};
