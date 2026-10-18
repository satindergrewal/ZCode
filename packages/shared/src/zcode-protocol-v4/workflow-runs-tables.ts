// ============================================================
// Upsert semantics of the **bounded tables** inside workflowRuns
// ============================================================
// Pure functions: entry update and capacity judgment; no clock reads, no I/O.
//
// These two functions are two halves of one sentence: how a table decides "same record", and what happens when it is full.
// Over-cap semantics are **reject new, still update existing**--freezing a running instance's phase at "queued" misleads
// readers more easily than missing one row (that graph cell would forever show not-started). Who yields to a newcomer is a different matter, in
// workflow-runs-eviction.ts。

import type { WorkflowRunPendingQuestion } from "./workflow-runs.js";

/** Result of one bounded upsert. `truncated` = this record **failed to enter the table** (not "already present, updated in place"). */
export interface BoundedUpsert<T> {
  list: T[];
  truncated: boolean;
}

/**
 * Bounded-list upsert by (siteId, ordinal) (the dedupe key of the actors / nodes / reports tables alike).
 *
 * `admitNew: false` extends "no new entries" beyond the cap to other reasons (replayed events, an off-table instance's intermediate
 * phase; see the node branch's `born` in the reducer), with output **verbatim identical** to a cap rejection--because it states the same thing:
 * this instance is not in the table. Callers count as usual on that basis.
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
 * Bounded parked-questions upsert by `qid`.
 *
 * Same over-cap semantics as {@link upsertBoundedByInstance} (reject new, update existing), different key: escalation has no
 * site-instance identity; qid is its key. Not merged into one generic function because the key **extraction** is the only
 * thing worth saying here--merged, call sites would pass a keyOf fn and readers would lose sight of each table's dedupe key.
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
