import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";

/**
 * One timeline model per (graph, run) pair (docs/dynamic-workflow/presentation.md The timeline model, Cost).
 * A separate file from timeline-model.ts: that is the model, this is only its memory, and oxlint's max-lines
 * gate is tight enough over there.
 *
 * Why keying on OBJECT IDENTITY is right: both inputs are immutable protocol objects. The graph is the
 * causalityGraph inside the validated display payload on the wire; the run is one entry of the workflowRuns
 * projection whose reduction and keyed increments rebuild shallowly (changed entries get fresh objects, untouched
 * elements keep references). Same object therefore equals same content, and any content change mints a new
 * object, so the cache can never serve a stale model.
 *
 * Why not each consumer's useMemo: the run card and the run detail draw the same run in the same frame; each
 * useMemo knows only itself and the model gets built twice per frame (tens of ms at table bounds). Two levels of
 * WeakMap (run, then graph) turn the second build into a lookup. Keys are weak: the projection emits fresh run
 * objects per frame, last frame's entries become collectable, the table does not grow.
 */
const BY_RUN = new WeakMap<object, WeakMap<object, unknown>>();

/** Run-less static graphs (confirm dialog, compile-feedback card) share the table under a module sentinel. */
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
  // has, not get() !== undefined: the model is always an object, but the check should not lean on that.
  if (byGraph.has(graph)) return byGraph.get(graph) as Model;
  const model = build();
  byGraph.set(graph, model);
  return model;
}
