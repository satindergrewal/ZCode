// ============================================================
// The attribution ledger of off-table entries: how each `unlistedByPhase` cell grows, shrinks, and vanishes
// ============================================================
// Pure functions; no clock reads or I/O. Eviction rules decide who leaves the table; this maintains the per-phase counts after leaving.
//
// The read surface is drawn per **station**: a site's
// roster, counter ring, and "N more" must add back their own cell's off-table entries. The two run-level counters
// (workflow-runs-caps.ts) can say how under-listed a run is in total, not where--this cell table is
// that gap.
//
// Each cell's four numbers answer one question each, all describing **now**, never a historical total:
//   - `actors`: subagents of this birth phase **currently off-table**, whether rejected, evicted, or
//     born-settled orphans. It grows and shrinks--an evicted subagent returns to the table at its next dispatch
//     (workflow-runs-eviction.ts activation), and the cell decrements then;
//   - `actorsSettled` / `actorsFailed`: of those, the finished and the failed-at-finish;
//   - `settled`: off-table **settled nodes** recorded in this cell.
// An all-zero cell is dropped whole; dropping the last cell removes the key--the family's usual "none => absent".
//
// After every change the cell is clamped to `actorsFailed <= actorsSettled <= actors`--the cell's **law**, not a patch:
// it is exactly the rule letting `actorsSettled` rise and fall. It must fall--between its two asks a subagent looks
// "finished", so eviction stamps it finished, and its next dispatch readmits it. The cell records not **who** returned, so decrementing
// `actorsSettled` at activation would be guesswork, wildly wrong under wide fan-out: hundreds of that phase's subagents were
// rejected **at birth**, never settled, and every readmission would deduct a foreign entry. Clamping errs only when a cell is crowded, and
// temporarily--the readmitted finished subagent lends its finished mark to another unlisted one of the same phase until the cell
// drains; as subagents re-enter, each phase's numbers right themselves. The run-level counters stay exact throughout.

import type { WorkflowRunState, WorkflowRunUnlistedPhase } from "./workflow-runs.js";

/** The delta added to a cell. `actors` may be negative (a subagent returning); the rest only positive. */
export interface WorkflowRunUnlistedDelta {
  actors?: number;
  actorsSettled?: number;
  actorsFailed?: number;
  settled?: number;
}

/**
 * Add to a birth phase's cell.
 *
 * **A full cell table drops the attribution** (returns the table as-is): a site may lack a number it never had, but the run-level
 * count must not lie--callers add that regardless. Table length is `maxPhases` + one: the extra cell is "no phase", sharing
 * the table with named phases.
 *
 * Returning `undefined` always means "not one cell" (key absent), so reducing the last all-zero cell collapses the whole table.
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
  // Clamp at zero: the `actors` subtraction has two unreachable prerequisites (attribution dropped at a full table; the factual birth
  // phase mismatching the re-dispatched one); clamping undercounts one cell, not clamping puts a negative on the wire.
  const actors = atLeastZero((base?.actors ?? 0) + (delta.actors ?? 0));
  // Clamp to `actorsFailed <= actorsSettled <= actors` (header law): the cell cannot tell who returned, so the
  // finished count may only fall along with the off-table count.
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
 * Land a cell table back on the run: **empty table removes the key** (never an empty array).
 *
 * "Zero => key absent" is the field's protocol contract (see the schema comment) and the idempotence pivot: a no-change
 * reduction must yield a byte-identical run object for the top-level structural compare to return null.
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
