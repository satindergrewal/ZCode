// ============================================================
// workflowRuns trimming for consumers **without** the `workflowRunDeltas` capability
// ============================================================
// Not a display budget -- wire compat: legacy consumers' compiled actors / nodes bound is 256
// ({@link WORKFLOW_RUNS_LEGACY_LIMITS}), and a parse error on a known key does **not** strip one key -- it fails
// the whole `state.updated` patch, drops the frame, and the subscription goes silently dead. Past the 1024 raise, every
// frame toward legacy consumers (the coalesced whole-key patch, and snapshots) passes through here.
//
// Which 256 survive follows the reducer's eviction rule (workflow-runs-eviction.ts): keep what still moves.
// Legacy phones and new clients draw the same thing -- who is running now -- and a flat first-256 would freeze a wide
// run on its earliest finished entries forever. Spare slots backfill oldest-by-table-order; output stays in table order.

import { canonicalWorkflowRun } from "./workflow-runs-delta.js";
import {
  WORKFLOW_RUNS_LEGACY_LIMITS,
  type WorkflowRunActor,
  type WorkflowRunNode,
  type WorkflowRunsState,
} from "./workflow-runs.js";

/**
 * Trim to the legacy bound; trimmed runs get `truncated: true` (readers show details for N of M steps only).
 *
 * **Nothing else is trimmed**: unknown new optional keys are harmless to legacy consumers (the container is not strict,
 * extra keys strip) and stripping them for cleanliness would maintain a second field table -- the 2026-09-04 incident's shape.
 *
 * Returns the **same object** when nothing needs trimming: this runs on every flush, and a gratuitous new state
 * invalidates every reference-memo downstream.
 */
export function clampWorkflowRunsForLegacy(state: WorkflowRunsState): WorkflowRunsState {
  let clamped = false;
  const runs = state.runs.map((run) => {
    const actors = clampKeepingLive(
      run.actors,
      WORKFLOW_RUNS_LEGACY_LIMITS.maxActors,
      (actor: WorkflowRunActor) => actor.status !== "completed",
    );
    const nodes = clampKeepingLive(
      run.nodes,
      WORKFLOW_RUNS_LEGACY_LIMITS.maxNodes,
      (node: WorkflowRunNode) => node.phase !== "settled",
    );
    if (actors === run.actors && nodes === run.nodes) return run;
    clamped = true;
    // Canonical key order: `truncated` may be a new key on this run, and a plain spread would trail it
    // object-tail while the same state elsewhere (reducer egress, delta apply) is schema-ordered.
    return canonicalWorkflowRun({ ...run, actors, nodes, truncated: true });
  });
  return clamped ? { revision: state.revision, runs } : state;
}

/**
 * Trim to `limit`: keep the still-moving in table order, backfill oldest-by-table-order into spare slots, output
 * in the **original table order** (two index passes, one filter -- table order, not live-first).
 *
 * Live entries alone over the limit: take the first `limit` by table order -- still bounded; the legacy compiled
 * bound accepts no excuses. Under the bound, the same array returns.
 */
function clampKeepingLive<T>(
  list: readonly T[],
  limit: number,
  isLive: (entry: T) => boolean,
): T[] {
  if (list.length <= limit) return list as T[];
  const kept = new Set<number>();
  for (let index = 0; index < list.length && kept.size < limit; index += 1) {
    if (isLive(list[index]!)) kept.add(index);
  }
  for (let index = 0; index < list.length && kept.size < limit; index += 1) {
    kept.add(index);
  }
  return list.filter((_, index) => kept.has(index));
}
