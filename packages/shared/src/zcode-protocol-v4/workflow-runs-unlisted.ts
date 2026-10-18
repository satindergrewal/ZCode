// ============================================================
// The off-table ledger: how each `unlistedByPhase` cell grows, shrinks, and when it disappears whole
// ============================================================
// Split from workflow-runs-eviction.ts (the main file's max-lines gate), same discipline: pure, clockless, no IO.
// Eviction says who left the tables; this says how the departed stay countable.
//
// Readers draw per **stop** (docs/dynamic-workflow/presentation.md, Past six participants): a stop's roster, count ring,
// and N-more must add back their own cell's off-table entries. The run-level counters (workflow-runs-caps.ts)
// say how many a run lacks in total, not where.
// This per-stop table is that missing piece.
//
// Each cell's four numbers answer one question, all describing **now** (not history):
//   - `actors`: subagents of this birth phase **currently off-table**, whether rejected, evicted,
//     or born-settled orphans. It rises and falls -- an evicted subagent returns to a table on its next
//     dispatch (workflow-runs-eviction.ts activation), and the cell decrements then;
//   - `actorsSettled` / `actorsFailed`: of those, the finished and the failed-at-finish;
//   - `settled`: off-table **settled nodes** recorded to this cell.
// A cell of all zeros is dropped; dropping the last cell drops the whole key -- same absent-when-empty rule as the family.
//
// After every change the cell is clamped to `actorsFailed <= actorsSettled <= actors` -- the cell's **law**, not a patch:
// it is exactly what lets `actorsSettled` fall as well as rise. It must fall -- between two asks a subagent
// looks finished, eviction stamps it ended, and its next dispatch takes it back onto a table
// (an older note here claimed actorsSettled only grows since finished subagents never re-seat; that is wrong
// for multi-ask subagents). But the cell cannot remember **who** returned, so decrementing
// `actorsSettled` at activation is a guess, and wide fan-outs guess wildly: a phase with hundreds of subagents
// rejected **at birth** never settled, and every return would deduct an unearned unit. Clamping errs only in a crowded
// cell and only briefly -- the returning finished subagent lends its ended mark to another unlisted subagent of the
// same phase until the cell drains; as subagents re-seat, each phase's numbers settle. Run-level counters stay exact throughout.

import type { WorkflowRunState, WorkflowRunUnlistedPhase } from "./workflow-runs.js";

/** One cell's increment. `actors` may be negative (a subagent re-seats); the rest are positive only. */
export interface WorkflowRunUnlistedDelta {
  actors?: number;
  actorsSettled?: number;
  actorsFailed?: number;
  settled?: number;
}

/**
 * Add to a birth phase's cell.
 *
 * **A full cell table drops attribution** (returns the table as-is): a stop may lack a number it never had, run-level
 * counters may not lie -- the caller adds those regardless. The table is one longer than `maxPhases`: the extra
 * cell is phaseless, sharing the table with named phases.
 *
 * `undefined` always means no cells at all (key absent), so zeroing the last cell collapses the whole table.
 */
export function addToUnlistedBucket(
  buckets: readonly WorkflowRunUnlistedPhase[] | undefined,
  phaseName: string | undefined,
  delta: WorkflowRunUnlistedDelta,
  maxPhases: number,
): WorkflowRunUnlistedPhase[] | undefined {
  const current = buckets ?? [];
  const index = current.findIndex((bucket) => bucket.phaseName === phaseName);
  if (index < 0 && current.length >= maxPhases + 1) {
    return buckets === undefined ? undefined : [...buckets];
  }
  const base = index < 0 ? undefined : current[index]!;
  // Clamp at zero: the subtraction has two unmet preconditions (attribution lost to a full table, birth phase vs
  // dispatch-resend mismatch); clamping undercounts one cell, not clamping puts a negative on the wire.
  const actors = atLeastZero((base?.actors ?? 0) + (delta.actors ?? 0));
  // Clamp to `actorsFailed <= actorsSettled <= actors` (the header law): the cell cannot know who returned,
  // so the ended count falls only together with the off-table count.
  const actorsSettled = Math.min(
    atLeastZero((base?.actorsSettled ?? 0) + (delta.actorsSettled ?? 0)),
    actors,
  );
  const actorsFailed = Math.min(
    atLeastZero((base?.actorsFailed ?? 0) + (delta.actorsFailed ?? 0)),
    actorsSettled,
  );
  const settled = atLeastZero((base?.settled ?? 0) + (delta.settled ?? 0));
  if (actors === 0 && actorsSettled === 0 && actorsFailed === 0 && settled === 0) {
    if (index < 0) return buckets === undefined ? undefined : [...buckets];
    const remaining = current.filter((_, position) => position !== index);
    return remaining.length > 0 ? remaining : undefined;
  }
  // Key order = schema declaration order: this object rides the delta verbatim; both sides' bytes must match.
  const merged: WorkflowRunUnlistedPhase = {
    ...(phaseName === undefined ? {} : { phaseName }),
    actors,
    ...(actorsSettled > 0 ? { actorsSettled } : {}),
    ...(actorsFailed > 0 ? { actorsFailed } : {}),
    settled,
  };
  if (index < 0) return [...current, merged];
  const next = [...current];
  next[index] = merged;
  return next;
}

/**
 * Land the cell table back on the run: **empty table removes the key** (never an empty array).
 *
 * Zero-entries-means-key-absent is this field's protocol (see the schema comment) and the idempotency pivot: a
 * no-op reduction must yield a byte-identical run object, or the top-level structural compare returns null.
 */
export function withUnlistedBuckets(
  run: WorkflowRunState,
  buckets: readonly WorkflowRunUnlistedPhase[] | undefined,
): WorkflowRunState {
  if (buckets === run.unlistedByPhase) return run;
  if (buckets === undefined || buckets.length === 0) {
    if (run.unlistedByPhase === undefined) return run;
    const { unlistedByPhase: _emptied, ...withoutKey } = run;
    return withoutKey;
  }
  return { ...run, unlistedByPhase: [...buckets] };
}

function atLeastZero(value: number): number {
  return value > 0 ? value : 0;
}
