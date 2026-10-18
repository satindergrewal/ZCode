/**
 * Sample source for host/scheduler self-reported heap (registry row three).
 *
 * Both utilityProcesses read process.memoryUsage()/cpuUsage() every 60s and parentPort the sample to main;
 * the message dispatch calls ingestXxx here to keep the latest reading,
 * and the next 10s tick merges it into the role sample as heap_used_kb_mean / heap_used_kb_peak.
 *
 * Heap only: CPU/RSS come solely from main's getAppMetrics() (role table); mixing 60s self-readings
 * into the 10s series would pollute sample_count and every statistic.
 * Each reading yields one heap sample (deliver-and-clear); stale values never pass as current.
 */

import { nodeSelfResourceSampleSchema, type ProcessResourceRole } from "@zcode/shared";
import type { ProcessResourceSampleSource } from "./processResourceSampleSources.js";

/** role -> undelivered heap reading (KB). */
const pendingHeapUsedKb = new Map<ProcessResourceRole, number>();

/**
 * Ingest accepts unknown: host payload uses the host response schema, scheduler an unvalidated private protocol;
 * both converge on one trust boundary here -- validation lives only here.
 * Invalid messages (missing fields, wrong types, extra fields) are dropped, never thrown.
 */
function ingest(role: ProcessResourceRole, raw: unknown): void {
  const parsed = nodeSelfResourceSampleSchema.safeParse(raw);
  if (!parsed.success) {
    return;
  }
  // Multi-window hosts land in one tick; a later smaller heap must not overwrite the earlier peak.
  pendingHeapUsedKb.set(role, Math.max(pendingHeapUsedKb.get(role) ?? 0, parsed.data.heapUsedKb));
}

export function ingestHostSelfResourceSample(raw: unknown): void {
  ingest("host", raw);
}

export function ingestSchedulerSelfResourceSample(raw: unknown): void {
  ingest("scheduler", raw);
}

export const selfHeapProcessResourceSampleSource: ProcessResourceSampleSource = {
  id: "self_heap",
  sample(context) {
    // Take, then deliver: a delivery throw never leaves the old reading for the next tick.
    const delivering = [...pendingHeapUsedKb];
    pendingHeapUsedKb.clear();
    for (const [role, heapUsedKb] of delivering) {
      context.addRoleHeapSample(role, heapUsedKb);
    }
  },
  reset() {
    pendingHeapUsedKb.clear();
  },
};
