// ============================================================
// Upsert semantics for the **bounded tables** of workflowRuns
// ============================================================
// Split from workflow-runs-reducer.ts (max-lines gate), with -started.ts / -phases.ts / -eviction.ts:
// same precedent, same discipline -- pure, clockless, no IO.
//
// Two functions, two halves of one sentence: how a table recognizes the same entry, and what happens when full.
// Bound semantics: **reject new, still update existing** -- freezing a running instance at queued misleads
// less than dropping it (its grid would read never-started forever). Who yields to newcomers is another matter, in the eviction module.
// workflow-runs-eviction.ts。

import type { WorkflowRunPendingQuestion } from "./workflow-runs.js";

/** Result of one bounded upsert. `truncated` = this record **failed to enter** (not present-and-updated). */
export interface BoundedUpsert<T> {
  list: T[];
  truncated: boolean;
}

/**
 * Bounded upsert by (siteId, ordinal) -- the dedup key of actors / nodes / reports alike.
 *
 * `admitNew: false` extends no-new-entry from bounds to other reasons (replayed events, an off-table instance's
 * intermediate phase; see the reducer node branch's `born`), producing **verbatim** the bound-rejected shape --
 * it says the same thing: this instance is not in the table. Callers count as usual.
 */
export function upsertBoundedByInstance<T extends { siteId: string; ordinal: number }>(
  list: readonly T[],
  entry: T,
  limit: number,
  options: { admitNew?: boolean } = {},
): BoundedUpsert<T> {
  const index = list.findIndex(
    (item) => item.siteId === entry.siteId && item.ordinal === entry.ordinal,
  );
  if (index >= 0) {
    const next = [...list];
    next[index] = entry;
    return { list: next, truncated: false };
  }
  if (options.admitNew === false || list.length >= limit) {
    return { list: [...list], truncated: true };
  }
  return { list: [...list, entry], truncated: false };
}

/**
 * Bounded upsert into the parked-questions table, by `qid`.
 *
 * Same bound semantics as {@link upsertBoundedByInstance} (reject new, update existing); the key differs -- escalation
 * has no site-instance identity, qid is its key. Not one generic function: the key's **derivation** is the only
 * point here -- a keyer parameter would hide what each table dedups by.
 */
export function upsertBoundedByQid(
  list: readonly WorkflowRunPendingQuestion[],
  entry: WorkflowRunPendingQuestion,
  limit: number,
): BoundedUpsert<WorkflowRunPendingQuestion> {
  const index = list.findIndex((item) => item.qid === entry.qid);
  if (index >= 0) {
    const next = [...list];
    next[index] = entry;
    return { list: next, truncated: false };
  }
  if (list.length >= limit) return { list: [...list], truncated: true };
  return { list: [...list, entry], truncated: false };
}
