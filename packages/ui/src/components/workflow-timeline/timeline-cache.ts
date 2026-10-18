import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";

/**
 * Caches the computed results of `timeline-model.ts`: each (graph, run) pair is built once.
 *
 * Why keying by **object identity** is correct: both inputs are immutable protocol objects — the graph is the validated
 * `causalityGraph` inside the row's display payload, the run is one entry of the `workflowRuns` projection; the projection's reduction and
 * key-level incrementals are shallow rebuilds (the changed entry gets a new object, unchanged elements keep their references). So "same object"
 * equals "same content", and any content change necessarily produces a new object — the cache can never serve a stale model.
 *
 * Why not rely on each consumer's `useMemo`: the run card and run detail page draw the same run in the same frame; each useMemo only
 * knows its own instance, so one frame builds twice (a dozen ms each on the render path). Two-level WeakMap (run, then graph) reduces the
 * second site to a lookup. Keys are weak: the projection emits fresh run objects each frame, so last frame's entries stay collectable and the table does not grow.
 */
const BY_RUN = new WeakMap<object, WeakMap<object, unknown>>();

/** Run-less static graphs (approval dialog, compile feedback card) share the same table; a module-level sentinel occupies the run slot. */
const NO_RUN: object = {};

export function sharedTimelineModel<Model>(
  graph: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
  build: () => Model,
): Model {
  const runKey: object = run ?? NO_RUN;
  let byGraph = BY_RUN.get(runKey);
  if (byGraph === undefined) {
    byGraph = new WeakMap<object, unknown>();
    BY_RUN.set(runKey, byGraph);
  }
  // `has` instead of `get() !== undefined`: the model is always an object, but the check should not depend on that.
  if (byGraph.has(graph)) return byGraph.get(graph) as Model;
  const model = build();
  byGraph.set(graph, model);
  return model;
}
