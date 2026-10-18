// Coalesce pure functions: the merge rules used by the CLI flush buffer.
// Semantic requirement: coalesce(deltas) equals per-op delivery--after both delivery profiles process the same event sequence, the final states must be byte-identical. No merge may change the post-apply state.
//
// Rules (closed set):
//   1. adjacent row.delta with the same (rowId, path) -> concat appends;
//   2. adjacent state.updated -> shallow key merge (whole-key replace within a key, safe);
//   3. row.delta followed by row.upserted of the same row -> the former is dropped (whole-row replace implies all appends);
//   4. row.removed is a barrier no rule may cross;
//   5. frame-size splitting is not here (the channel layer frames);
//   6. workflowRun.updated of the same runId merges into the **earliest** one (see mergeWorkflowRunUpdate below).
import type { ConversationDelta, WorkflowRunUpdatedDelta } from "./delta.js";
import {
  mergeWorkflowRunUpdates,
  workflowRunUpdateWithinWireBounds,
  type WorkflowRunWireBounds,
} from "./workflow-runs-delta.js";

function isBarrier(delta: ConversationDelta): boolean {
  return delta.op === "row.removed";
}

/**
 * Rule 6's barriers: wherever `workflowRuns` is whole-key replaced (`state.updated` carrying the key), and
 * `workflowRun.removed` of the **same run**. Other ops touch disjoint state and commute--
 * row ops never touch state keys, other runs' deltas never touch this run, and a state.updated without workflowRuns never touches the key.
 */
function isWorkflowRunBarrier(delta: ConversationDelta, runId: string): boolean {
  if (delta.op === "state.updated") return delta.patch.workflowRuns !== undefined;
  return delta.op === "workflowRun.removed" && delta.runId === runId;
}

/**
 * Rule 6: merge a `workflowRun.updated` into the **last** same-runId delta within the window.
 *
 * Why search back instead of adjacent-only: a wide-fan-out run emits one delta per engine event, separated in the window by
 * other runs and row ops; merging adjacent-only would merge none.
 *
 * Why the **last** and not an earlier one: while merges keep succeeding, at most one same-run delta remains after the barrier
 (every new one merged in), so "earliest" and "latest" are the same op and the merged result still sits at the earliest position,
 * preserving birth order in `runs[]`. When a merge is rejected two remain; merging into the **earlier** one then
 * would let the later upsert jump before the middle one's deletion--a delete-then-add key would vanish.
 *
 * The merged op sits early but carries a later revision, so apply takes the max container revision (see
 * applyWorkflowRunUpdated). Merging **cannot assemble** a complete header, so it never turns two no-ops for an unknown run
 * into a spontaneous birth (see isCompleteWorkflowRunHeader's comment).
 *
 * When the merged payload would exceed the wire caps, do not merge (both ops stay as-is; per-op delivery is unchanged): eviction breaks
 * "distinct keys deleted within one window <= table cap", and an over-cap frame is dropped whole. Rationale in
 * workflowRunUpdateWithinWireBounds。
 *
 * Returns true when merged (the caller must not push).
 */
function mergeWorkflowRunUpdate(
  result: ConversationDelta[],
  delta: WorkflowRunUpdatedDelta,
  bounds: WorkflowRunWireBounds | undefined,
): boolean {
  let target = -1;
  for (let i = result.length - 1; i >= 0; i--) {
    const prev = result[i];
    if (prev === undefined || isWorkflowRunBarrier(prev, delta.runId)) break;
    if (prev.op === "workflowRun.updated" && prev.runId === delta.runId) {
      target = i;
      break;
    }
  }
  if (target < 0) return false;
  const merged = mergeWorkflowRunUpdates(result[target] as WorkflowRunUpdatedDelta, delta);
  // On rejection, never retry an earlier one: that is exactly the cross-the-middle-deletion path described above.
  if (!workflowRunUpdateWithinWireBounds(merged, bounds)) return false;
  result[target] = merged;
  return true;
}

/**
 * Semantics-preserving merge of a flush window's delta sequence.
 // Input and output both in authoritative log order; pure, never mutates inputs.
 * `bounds` defaults to the protocol caps; the merged state must equal per-op application.
 */
export function coalesceConversationDeltas(
  deltas: readonly ConversationDelta[],
  bounds?: WorkflowRunWireBounds,
): ConversationDelta[] {
  const result: ConversationDelta[] = [];

  for (const delta of deltas) {
    // Rule 3: row.upserted swallows earlier row.delta of the same rowId.
    // Backtrack only to the nearest barrier (rule 4), never past a prior same-row upserted/append--
    // crossing would swallow the previous generation's appends and change the final state.
    if (delta.op === "row.upserted") {
      for (let i = result.length - 1; i >= 0; i--) {
        const prev = result[i];
        if (prev === undefined || isBarrier(prev)) break;
        if (prev.op === "row.delta" && prev.rowId === delta.row.rowId) {
          result.splice(i, 1);
          continue;
        }
        if (
          (prev.op === "row.upserted" || prev.op === "row.appended") &&
          prev.row.rowId === delta.row.rowId
        ) {
          break;
        }
      }
    }

    // Rule 6: an eviction swallows all of that run's earlier deltas (birth + eviction in one window = the client never saw the run,
    // equivalent to per-op delivery). The backtrack again stops at the nearest barrier.
    if (delta.op === "workflowRun.removed") {
      for (let i = result.length - 1; i >= 0; i--) {
        const prev = result[i];
        if (prev === undefined || isWorkflowRunBarrier(prev, delta.runId)) break;
        if (prev.op === "workflowRun.updated" && prev.runId === delta.runId) result.splice(i, 1);
      }
    }

    if (delta.op === "workflowRun.updated" && mergeWorkflowRunUpdate(result, delta, bounds))
      continue;

    const last = result[result.length - 1];

    // Rule 1: concat adjacent row.delta with the same (rowId, path).
    if (
      delta.op === "row.delta" &&
      last?.op === "row.delta" &&
      last.rowId === delta.rowId &&
      last.path === delta.path
    ) {
      result[result.length - 1] = {
        op: "row.delta",
        rowId: delta.rowId,
        path: delta.path,
        append: last.append + delta.append,
      };
      continue;
    }

    // Rule 2: shallow-merge adjacent state.updated (the later's keys win; whole-key replace makes it safe).
    if (delta.op === "state.updated" && last?.op === "state.updated") {
      result[result.length - 1] = {
        op: "state.updated",
        patch: { ...last.patch, ...delta.patch },
      };
      continue;
    }

    // Adjacent row.upserted of the same row: keep the last (transitivity of whole-row replace).
    if (
      delta.op === "row.upserted" &&
      last?.op === "row.upserted" &&
      last.row.rowId === delta.row.rowId
    ) {
      result[result.length - 1] = delta;
      continue;
    }

    result.push(delta);
  }

  return result;
}

/**
 * conflation helper (shared by latest-state topics such as sessions-index): keep only each object's last update by key.
 * Order-preserving: survivors output in the relative order of their last occurrence.
 */
export function conflateByKey<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const lastIndexByKey = new Map<string, number>();
  items.forEach((item, index) => {
    lastIndexByKey.set(keyOf(item), index);
  });
  return items.filter((item, index) => lastIndexByKey.get(keyOf(item)) === index);
}
