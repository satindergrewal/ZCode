// The canonical implementation of delta application semantics (pure functions).
// Part of the protocol semantics: coalesce's "semantics preservation" is judged by this--
// applyAll(s, coalesce(ds)) must be byte-identical to applyAll(s, ds) (golden tests).
// Client store apply logic is a hostified rewrite of this; no extra branches allowed.
import type { ConversationDelta } from "./delta.js";
import type { ConversationSnapshot } from "./snapshot.js";
import type { ConversationRow } from "./rows.js";
import type { StreamablePath } from "./core.js";
import { applyWorkflowRunRemoved, applyWorkflowRunUpdated } from "./workflow-runs-delta.js";

/**
 * For the server's batch reduction inside unpublished candidate snapshots only.
 *
 * Calling the immutable apply per event during cold recovery copies the history-growing
 * rows.window on every append/upsert and re-scans rowId linearly, degrading long sessions to O(N^2). Candidate snapshots are not yet visible,
 * so within this explicit isolation boundary the same array and an incremental index may be reused; normal clients keep the
 * immutable semantics above, keeping published snapshots safe from later events.
 */
export interface MutableConversationSnapshotAccumulator {
  snapshot: ConversationSnapshot;
  rowIndexById: Map<number, number>;
}

export function createMutableConversationSnapshotAccumulator(
  snapshot: ConversationSnapshot,
): MutableConversationSnapshotAccumulator {
  const window = [...snapshot.rows.window];
  return {
    snapshot: {
      ...snapshot,
      rows: { ...snapshot.rows, window },
    },
    rowIndexById: new Map(window.map((row, index) => [row.rowId, index])),
  };
}

// row.delta applies only to streaming rows (invariant, guaranteed server-side).
// Per protocol semantics this implements: no-op when path/row missing (a patch hitting an unloaded row = no-op).
function appendToRow(row: ConversationRow, path: StreamablePath, append: string): ConversationRow {
  switch (path) {
    case "text":
      if (row.kind === "assistantText" || row.kind === "reasoning") {
        return { ...row, text: row.text + append };
      }
      return row;
    case "inputText":
      if (row.kind === "toolCall") {
        return { ...row, inputText: row.inputText + append };
      }
      return row;
    case "output.text":
      if (row.kind === "toolCall" && row.output) {
        return {
          ...row,
          output: { ...row.output, text: row.output.text + append },
        };
      }
      return row;
    case "summaryText":
      if (row.kind === "subagent") {
        return { ...row, summaryText: row.summaryText + append };
      }
      return row;
  }
}

/** Apply one delta, returning a new snapshot (inputs unmodified). */
export function applyConversationDelta(
  snapshot: ConversationSnapshot,
  delta: ConversationDelta,
): ConversationSnapshot {
  switch (delta.op) {
    case "row.appended":
      return {
        ...snapshot,
        rows: {
          ...snapshot.rows,
          window: [...snapshot.rows.window, delta.row],
          totalCount: snapshot.rows.totalCount + 1,
          firstRowId: snapshot.rows.firstRowId ?? delta.row.rowId,
        },
      };
    case "row.upserted": {
      const index = snapshot.rows.window.findIndex((row) => row.rowId === delta.row.rowId);
      // Unloaded rowId = no-op (evicted rows return only via rows/range).
      if (index === -1) return snapshot;
      const window = [...snapshot.rows.window];
      window[index] = delta.row;
      return { ...snapshot, rows: { ...snapshot.rows, window } };
    }
    case "row.removed": {
      const window = snapshot.rows.window.filter((row) => row.rowId < delta.fromRowId);
      const removed = snapshot.rows.window.length - window.length;
      const removesEntireActiveBranch =
        snapshot.rows.firstRowId !== null && delta.fromRowId <= snapshot.rows.firstRowId;
      return {
        ...snapshot,
        rows: {
          ...snapshot.rows,
          window,
          // rowIds keep rising monotonically after the first rewind round; keeping the old firstRowId would make the UI
          // misread the old branch's rowId holes as "load earlier". Both full and tail windows must clear active-branch
          // pagination anchors and counts when clipping from the head; the next append establishes a new head.
          totalCount: removesEntireActiveBranch
            ? 0
            : Math.max(0, snapshot.rows.totalCount - removed),
          firstRowId: removesEntireActiveBranch ? null : snapshot.rows.firstRowId,
        },
      };
    }
    case "row.delta": {
      const index = snapshot.rows.window.findIndex((row) => row.rowId === delta.rowId);
      const target = snapshot.rows.window[index];
      if (index === -1 || target === undefined) return snapshot;
      const window = [...snapshot.rows.window];
      window[index] = appendToRow(target, delta.path, delta.append);
      return { ...snapshot, rows: { ...snapshot.rows, window } };
    }
    case "state.updated":
      // Whole-key replace: keys present in the patch win, never a deep merge.
      return { ...snapshot, ...delta.patch };
    // workflowRuns is the only state key with a delta hatch (why: delta.ts's comment). The rules live wholly in
    // workflow-runs-delta.ts: both twins delegate to it, leaving no room for semantic drift.
    case "workflowRun.updated":
      return {
        ...snapshot,
        workflowRuns: applyWorkflowRunUpdated(snapshot.workflowRuns, delta),
      };
    case "workflowRun.removed":
      return {
        ...snapshot,
        workflowRuns: applyWorkflowRunRemoved(snapshot.workflowRuns, delta),
      };
  }
}

/** Apply deltas in order. */
export function applyConversationDeltas(
  snapshot: ConversationSnapshot,
  deltas: readonly ConversationDelta[],
): ConversationSnapshot {
  let current = snapshot;
  for (const delta of deltas) {
    current = applyConversationDelta(current, delta);
  }
  return current;
}

/**
 * Apply one delta in place on an unpublished candidate snapshot; semantics must match applyConversationDelta.
 * Callers must not expose accumulator.snapshot to subscribers and keep calling this.
 */
export function applyConversationDeltaMutable(
  accumulator: MutableConversationSnapshotAccumulator,
  delta: ConversationDelta,
): void {
  const snapshot = accumulator.snapshot;
  switch (delta.op) {
    case "row.appended":
      accumulator.rowIndexById.set(delta.row.rowId, snapshot.rows.window.length);
      snapshot.rows.window.push(delta.row);
      snapshot.rows.totalCount += 1;
      snapshot.rows.firstRowId ??= delta.row.rowId;
      return;
    case "row.upserted": {
      const index = accumulator.rowIndexById.get(delta.row.rowId);
      if (index === undefined) return;
      snapshot.rows.window[index] = delta.row;
      return;
    }
    case "row.removed": {
      const removesEntireActiveBranch =
        snapshot.rows.firstRowId !== null && delta.fromRowId <= snapshot.rows.firstRowId;
      let writeIndex = 0;
      for (const row of snapshot.rows.window) {
        if (row.rowId >= delta.fromRowId) continue;
        snapshot.rows.window[writeIndex] = row;
        writeIndex += 1;
      }
      const removed = snapshot.rows.window.length - writeIndex;
      snapshot.rows.window.length = writeIndex;
      snapshot.rows.totalCount = removesEntireActiveBranch
        ? 0
        : Math.max(0, snapshot.rows.totalCount - removed);
      snapshot.rows.firstRowId = removesEntireActiveBranch ? null : snapshot.rows.firstRowId;
      accumulator.rowIndexById.clear();
      snapshot.rows.window.forEach((row, index) => accumulator.rowIndexById.set(row.rowId, index));
      return;
    }
    case "row.delta": {
      const index = accumulator.rowIndexById.get(delta.rowId);
      if (index === undefined) return;
      const target = snapshot.rows.window[index];
      if (target === undefined) return;
      snapshot.rows.window[index] = appendToRow(target, delta.path, delta.append);
      return;
    }
    case "state.updated":
      // As the immutable one: patch-present keys replace whole, never deep-merge.
      Object.assign(snapshot, delta.patch);
      return;
    // Same pure function as the immutable path: workflowRuns is a state key, not the rows window--no "in-place append" to optimize--
    // and accumulator.snapshot is already the candidate's own object; assigning a new container never touches published snapshots.
    case "workflowRun.updated":
      snapshot.workflowRuns = applyWorkflowRunUpdated(snapshot.workflowRuns, delta);
      return;
    case "workflowRun.removed":
      snapshot.workflowRuns = applyWorkflowRunRemoved(snapshot.workflowRuns, delta);
  }
}

/** Apply deltas in place, in order; unpublished candidate snapshots only. */
export function applyConversationDeltasMutable(
  accumulator: MutableConversationSnapshotAccumulator,
  deltas: readonly ConversationDelta[],
): void {
  for (const delta of deltas) applyConversationDeltaMutable(accumulator, delta);
}
