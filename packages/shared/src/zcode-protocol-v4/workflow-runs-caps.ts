// ============================================================
// Traces of the bounds: rejected-instance counters, a whole-key entry budget, and the only step-count reading
// ============================================================
// Living outside the reducer main file, for the same reason as workflow-runs-concurrency.ts / -phases.ts / -started.ts
// (the main file's max-lines gate) and under the same discipline: pure, clockless, no IO.
//
// These three are three faces of one thing. Hitting a bound means **reject the new** (existing entries still update), so a run
// wide enough to hit bounds always has instances that never make it onto a table:
//   - the counters make them **countable** -- `truncated` can say "something did not fit", not how much;
//   - the entry budget keeps the whole state key **bounded** -- one run's bound times maxRows sits too close to the snapshot cap;
//   - workflowRunStepCounts is the only sanctioned step reading -- on- and off-table; the three readers (run card, timeline summary,
//     TUI mirror) used to count separately, so one run showed three different step counts.

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunState,
  type WorkflowRunUsage,
} from "./workflow-runs.js";

/** One rejected-instance event's effect on the two counters. */
export interface UnlistedInstanceEvent {
  /** The instance failed to enter the table (upsert rejected at bound), not "already present, updated in place". */
  rejected: boolean;
  /** This event raised the run's watermark. false = resend/late; no counter moves. */
  advancesWaterMark: boolean;
  eventType: string;
  /** The `node-settled` `cached` mark: a cache-hit settlement has no queued; it is its own birth. */
  cached: boolean;
}

/**
 * Record one **rejected** instance event into usage's two counters.
 *
 * Birth has two shapes (verbatim the reducer main file's phaseName / node-progress test): `node-queued`, and
 * the direct `node-settled { cached: true }` on replay hit. Intermediate phases count none -- they describe
 * the same instance moving, not one more instance.
 *
 * Why `nodesUnlistedSettled` needs no clamp below `nodesUnlisted`: within one lifetime the engine sends at most
 * one `node-queued` per instance (repair / nudge never requeue, no backoff) and at most one
 * `node-settled` (the scheduler's settled latch), and a cache-hit settlement carries its own birth. So
 * "settled <= born" is structural. If that ever breaks, the engine or the `run-started` reset is at fault -- clamping would only hide it.
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
    // At zero the whole key is absent (same rule as reports / pendingQuestions): a run that never hit a bound gains no new key.
    ...(nodesUnlisted > 0 ? { nodesUnlisted } : {}),
    ...(nodesUnlistedSettled > 0 ? { nodesUnlistedSettled } : {}),
  };
}

/**
 * An **off-table** instance returned to the node table (workflow-runs-eviction.ts activation: it got dispatched,
 * so it and its work re-seat): `nodesUnlisted` minus one.
 *
 * Clamp at zero rather than going negative: this counter is **derived**, has no dedupable identity, and a returning
 * instance should always have been counted once (a rejected birth, or at eviction). Clamping undercounts by one;
 * not clamping puts a negative on the wire, and readers add it straight into step totals. Zero = whole key absent
 * (same rule as {@link countUnlistedInstance}), so remove the key instead of writing 0.
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
 * Whole-key entry budget ({@link WORKFLOW_RUNS_LIMITS.maxTotalEntries}): over budget, evict the **oldest terminal run**
 * until back under budget or nothing is evictable.
 *
 * Three things never evict: the running run (`pending` / `running`) -- it is producing facts; blinding its panel on the
 * spot helps no one; the run the event belongs to -- just-arrived facts must stick; and any run's **partial** entries --
 * the protocol has no entry-removal syntax, so halving breaks downstream deltas (diff can only resend whole-key).
 *
 * Pure and deterministic: reads only `runs` order (oldest first) and each status, so cold replay evicts the same set.
 * Under budget it returns the **same array**, preserving untouched runs' references and the delta fast path.
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
    // Not one evictable (all running, or only the event's own run): keep over budget. An honest overshoot
    // beats erasing a living run from its panel to honor a number.
    if (index < 0) break;
    total -= remaining[index]!.nodes.length + remaining[index]!.actors.length;
    remaining = [...remaining.slice(0, index), ...remaining.slice(index + 1)];
  }
  return remaining;
}

/**
 * How far a run has gotten, how many steps settled -- **on-table plus off-table**.
 *
 * Every reader (run card, timeline summary, TUI mirror) must go through this one function: they each counted `nodes`
 * before, so one bound-hitting run showed three different numbers, all undercounting.
 */
export function workflowRunStepCounts(run: WorkflowRunState): { total: number; settled: number } {
  let settledInList = 0;
  for (const node of run.nodes) if (node.phase === "settled") settledInList += 1;
  return {
    total: run.nodes.length + (run.usage.nodesUnlisted ?? 0),
    settled: settledInList + (run.usage.nodesUnlistedSettled ?? 0),
  };
}
