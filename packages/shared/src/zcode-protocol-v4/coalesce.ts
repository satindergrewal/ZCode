// Coalesce pure functions: the merge rules applied by the CLI flush buffer.
// Semantic bar: coalesce(deltas) must equal per-op delivery -- after both delivery profiles process the same event sequence, end states must be byte-identical. No merge may change the post-apply state.
//
// Rules (a closed set):
//   1. adjacent row.delta with equal (rowId, path) -> concatenate appends;
//   2. adjacent state.updated -> shallow key merge (whole-key replacement inside a key, safe);
//   3. row.delta followed by same-rowId row.upserted -> drop the former (whole-row replacement implies all appends);
//   4. row.removed is a barrier no rule may cross;
//   5. frame-size splitting is not here (channel-layer framing, 3.2);
//   6. same-runId workflowRun.updated merges into the **earliest** such op (see mergeWorkflowRunUpdate below).
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
 * Rule 6's barriers: wherever `workflowRuns` is whole-key replaced (`state.updated` carrying it), and
 * `workflowRun.removed` for the **same run**. Other ops and other runs' deltas act on disjoint state and commute --
 * row ops never touch state keys, other runs' deltas never touch this run, and a state.updated without workflowRuns never touches the key.
 */
function isWorkflowRunBarrier(delta: ConversationDelta, runId: string): boolean {
  if (delta.op === "state.updated") return delta.patch.workflowRuns !== undefined;
  return delta.op === "workflowRun.removed" && delta.runId === runId;
}

/**
 * Rule 6: merge one `workflowRun.updated` into the **last** same-runId delta within the window.
 *
 * Why search back instead of neighbors only: a wide-fan-out run emits one delta per engine event, and the window
 * interleaves other runs and row ops; merging neighbors only would merge none.
 *
 * Why the **last**, not earlier: while merging keeps succeeding, after the barrier at most one delta of this run
 * remains (every new one merged in), so earliest and last are the same op and the merge still sits at the earliest position,
 * preserving `runs[]` birth order. When a merge is refused, two remain -- and merging into the **earlier** one then
 * would let the later upsert jump before the middle one's deletion -- a delete-then-add key would vanish.
 *
 * The merged op sits early but carries a later revision, so apply's container revision takes the max (see
 * applyWorkflowRunUpdated). A merge can **never assemble** a complete header, so it cannot turn two no-ops
 * for an unknown run into a spontaneous birth (see isCompleteWorkflowRunHeader's comment).
 *
 * When the merged payload exceeds wire bounds, do not merge (both ops stay as-is; per-op delivery unchanged):
 * eviction breaks "distinct keys deleted within one window <= table bound", and an over-bound frame dies whole.
 * workflowRunUpdateWithinWireBounds。
 *
 * Returns true when merged (the caller skips its push).
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
  // On refusal, do **not** try an earlier op: that is exactly the crossing-the-middle-deletion path described above.
  if (!workflowRunUpdateWithinWireBounds(merged, bounds)) return false;
  result[target] = merged;
  return true;
}

/**
 * Apply semantics-preserving coalesce over one flush window of deltas.
 * Input and output in authoritative log order; pure, never mutates inputs.
 *
 * `bounds` is a test-only injection point (defaults to the real bounds): under the real 1024 the rule-6-refused branch
 * needs thousands of events to reach, and it is exactly where "merge equals sequential apply" breaks most easily.
 */
export function coalesceConversationDeltas(
  deltas: readonly ConversationDelta[],
  bounds?: WorkflowRunWireBounds,
): ConversationDelta[] {
  const result: ConversationDelta[] = [];

  for (const delta of deltas) {
    // Rule 3: row.upserted swallows earlier row.delta of the same rowId.
    // Backtrack only to the nearest barrier (rule 4) and never past a prior upserted/append of the same rowId --
    // crossing one would swallow the previous generation's appends and change the end state.
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

    // Rule 6: eviction swallows all of the run's earlier deltas (birth + eviction in one window = the client
    // never saw the run; equivalent to per-op delivery). Same backtrack-to-nearest-barrier rule.
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

    // Rule 1: concatenate adjacent row.delta with equal (rowId, path).
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

    // Rule 2: shallow-merge adjacent state.updated (later keys win; whole-key replacement makes it safe).
    if (delta.op === "state.updated" && last?.op === "state.updated") {
      result[result.length - 1] = {
        op: "state.updated",
        patch: { ...last.patch, ...delta.patch },
      };
      continue;
    }

    // Adjacent row.upserted of one rowId: keep the last (transitive whole-row replacement).
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
 * Conflation helper (for latest-state topics such as sessions-index): per key, keep only the last update.
 * Order-preserving: survivors output in their last-occurrence relative order.
 */
export function conflateByKey<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  const lastIndexByKey = new Map<string, number>();
  items.forEach((item, index) => {
    lastIndexByKey.set(keyOf(item), index);
  });
  return items.filter((item, index) => lastIndexByKey.get(keyOf(item)) === index);
}
