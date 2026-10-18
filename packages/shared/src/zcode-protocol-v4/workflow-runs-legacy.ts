// ============================================================
// Clipping workflowRuns for consumers **without** the workflowRunDeltas capability
// ============================================================
// Not a display budget but wire compat: legacy consumers' compiled actors / nodes validation caps are 256
// ({@link WORKFLOW_RUNS_LEGACY_LIMITS}), and a parse error on a known key does **not strip one key**--it fails the whole
// state.updated patch, drops the frame, and the subscription goes silent. Having raised the caps to 1024, every frame to legacy
// consumers (whole-key patches folded from deltas, and snapshots) must pass through here first.
//
// Which 256 survive follows the same logic as the reducer's eviction (workflow-runs-eviction.ts): **keep the moving ones**.
// Legacy phones draw the same thing as new clients--who is running now--and a blind "first 256" would freeze a wide run
// on the earliest finished batch forever on that client generation. When slots remain, fill with the earliest by table order; output stays in table order.

import { canonicalWorkflowRun } from "./workflow-runs-delta.js";
import {
  WORKFLOW_RUNS_LEGACY_LIMITS,
  type WorkflowRunActor,
  type WorkflowRunNode,
  type WorkflowRunsState,
} from "./workflow-runs.js";

/**
 * Clip to the legacy caps; clipped runs get `truncated: true` (read surfaces show "only N/M steps' details" from it).
 *
 * **Nothing else is clipped**: new optional keys unknown to legacy consumers are harmless (the container is not strict; extra keys are stripped),
 * and stripping them for tidiness would maintain a second field table, adding drift risk.
 *
 * Returns the **same object** when no clipping is needed: this runs on every flush, and a fresh state would
 * invalidate every reference-memoized consumer downstream.
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
    // Canonical key order: `truncated` may be a new key on this run; spreading would append it at the tail,
    // while the same state elsewhere (reducer exit, delta apply) is schema-ordered.
    return canonicalWorkflowRun({ ...run, actors, nodes, truncated: true });
  });
  return clamped ? { revision: state.revision, runs } : state;
}

/**
 * Clip to `limit`: take the **moving** ones in table order, fill remaining slots with the earliest by table order, output in
 * **original table order** (two index passes, one filter--table order, not "live first").
 *
 * When live entries alone exceed the quota, take the first `limit` by table order--still bounded; the legacy validation cap
 * accepts no excuses. Within the cap, the same array returns.
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
