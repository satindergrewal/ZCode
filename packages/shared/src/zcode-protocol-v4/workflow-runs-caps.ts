// ============================================================
// What the caps leave behind: rejected-instance counters, the whole-key entry budget, and the only legal step-count reading
// ============================================================
// Pure functions: capacity and counting rules; no clock reads, no I/O.
//
// Instances that cannot enter at cap must still be counted; existing entries keep updating; eviction and re-entry are other rules' business.
// The three rule families:
//   - counters keep them **countable**--`truncated` can only say "something did not enter", not how much;
//   - the entry budget keeps the whole state key **bounded**--one run's cap times maxRuns sits too close to the snapshot cap;
//   - workflowRunStepCounts is the only legal step reading--inside + outside the table, shared by all three read surfaces
//     (run card, timeline summary, TUI mirror) so one run never shows different counts.

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunState,
  type WorkflowRunUsage,
} from "./workflow-runs.js";

/** One rejected instance's event, and its effect on the two counters. */
export interface UnlistedInstanceEvent {
  /// This instance failed to enter (upsert rejected at cap), not "already present, updated in place".
  rejected: boolean;
  /// This event raised the run's watermark. false = retransmit/late; not one counter moves.
  advancesWaterMark: boolean;
  eventType: string;
  /// `node-settled`'s `cached` flag: a cache-hit settle has no queued; it is its own birth event.
  cached: boolean;
}

/**
 * Record one **rejected** instance's event into usage's two counters.
 *
 * There are two birth events (verbatim the reducer's phaseName / node-progress predicate): `node-queued`, and the
 * `node-settled { cached: true }` emitted on replay hits. Intermediate phases count none--they describe the same
 * instance moving, not one more instance.
 *
 * Why `nodesUnlistedSettled` needs no clamp under `nodesUnlisted`: within one life the engine sends at most one
 * `node-queued` per instance (repair / nudge never re-queue, no backoff retries) and at most one
 * `node-settled` (the scheduler's settled latch), while cache-hit settles carry their own birth. So "settles <= births"
 * is structural. Should that ever break, the engine or `run-started`'s zeroing is at fault--clamping would only hide it.
 */
export function countUnlistedInstance(
  usage: WorkflowRunUsage,
  event: UnlistedInstanceEvent,
): WorkflowRunUsage {
  if (!event.rejected || !event.advancesWaterMark) return usage;
  const settled = event.eventType === "node-settled";
  const born = event.eventType === "node-queued" || (settled && event.cached);
  if (!born && !settled) return usage;
  const nodesUnlisted = (usage.nodesUnlisted ?? 0) + (born ? 1 : 0);
  const nodesUnlistedSettled = (usage.nodesUnlistedSettled ?? 0) + (settled ? 1 : 0);
  return {
    ...usage,
    // At zero the whole key is absent (same rule as reports / pendingQuestions): a run never at cap gains no new keys.
    ...(nodesUnlisted > 0 ? { nodesUnlisted } : {}),
    ...(nodesUnlistedSettled > 0 ? { nodesUnlistedSettled } : {}),
  };
}

/**
 * An **off-table** instance returned to the node table (workflow-runs-eviction.ts activation: it got work,
 * person and job reseated together): decrement `nodesUnlisted`.
 *
 * Clamp at zero rather than go negative: this counter is **additive** with no dedupable identity, and a readmitted instance
 * should in theory always have been counted once (a rejected birth, or at eviction). Clamping undercounts one; not clamping puts
 * a negative on the wire, which read surfaces add straight into step totals. At zero the whole key is absent (same rule as
 * {@link countUnlistedInstance}), so the key must be removed explicitly, not written as 0.
 */
export function discountUnlistedInstance(usage: WorkflowRunUsage): WorkflowRunUsage {
  const current = usage.nodesUnlisted ?? 0;
  if (current === 0) return usage;
  const { nodesUnlisted: _returned, nodesUnlistedSettled: settled, ...head } = usage;
  return {
    ...head,
    ...(current > 1 ? { nodesUnlisted: current - 1 } : {}),
    ...(settled === undefined ? {} : { nodesUnlistedSettled: settled }),
  };
}

/**
 * The whole-key entry budget ({@link WORKFLOW_RUNS_LIMITS.maxTotalEntries}): over it, evict the **oldest terminal run**
 * until back within budget or nothing evictable remains.
 *
 * Three things never move: a running run (`pending` / `running`)--it is producing facts; stripping its table blinds the panel on the spot;
 // the run the event belongs to--just-arrived facts must survive; and any run's **partial** entries--this protocol
 // has no entry-removal syntax, so halving would desync downstream deltas (diff could only resend the whole key).
 *
 * Pure and deterministic: reads only `runs` order (oldest first) and each status, so cold replay evicts the same set.
 * Within budget it returns the **same array**, keeping unchanged runs' references and the delta fast path alive.
 */
export function evictForEntryBudget(
  runs: WorkflowRunState[],
  eventRunId: string,
): WorkflowRunState[] {
  let total = 0;
  for (const run of runs) total += run.nodes.length + run.actors.length;
  if (total <= WORKFLOW_RUNS_LIMITS.maxTotalEntries) return runs;
  let remaining = runs;
  while (total > WORKFLOW_RUNS_LIMITS.maxTotalEntries) {
    const index = remaining.findIndex(
      (run) => run.runId !== eventRunId && run.status !== "pending" && run.status !== "running",
    );
    // Nothing evictable (all running, or only the event's own run): keep over budget. An honest slight overrun
    // beats erasing a living run from the panel to defend a number.
    if (index < 0) break;
    total -= remaining[index]!.nodes.length + remaining[index]!.actors.length;
    remaining = [...remaining.slice(0, index), ...remaining.slice(index + 1)];
  }
  return remaining;
}

/**
 * How many steps a run took and how many settled--**inside + outside the table**.
 *
 * Every read surface (run card, timeline summary, TUI mirror) must go through this one function: they each counted `nodes`, so one
 * cap-hitting run showed three different numbers, all smaller than the truth.
 */
export function workflowRunStepCounts(run: WorkflowRunState): { total: number; settled: number } {
  let settledInList = 0;
  for (const node of run.nodes) if (node.phase === "settled") settledInList += 1;
  return {
    total: run.nodes.length + (run.usage.nodesUnlisted ?? 0),
    settled: settledInList + (run.usage.nodesUnlistedSettled ?? 0),
  };
}
