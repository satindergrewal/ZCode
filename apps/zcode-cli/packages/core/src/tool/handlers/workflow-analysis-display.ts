// ============================================================
// Workflow analysis -> display: the single projection from static analysis to display graph / result card.
// ============================================================
//
// The display graph composites **three** analysis projections: causality graph (sites and lanes), control-flow
// graph (phase vocabulary and phase edges), handoff graph (per-phase subagent cards and handoff edges).
// Missing any one silently drops a layer -- the hub-launched run detail pane having no timeline and no
// subagents traced to the launch path passing only the causality graph. So "analysis -> bounded display
// graph" is composited here exactly once; CreateWorkflow's handler, the confirm gate, and direct launch

import {
  CREATE_WORKFLOW_TOOL_NAME,
  type CreateWorkflowCausalityGraph,
  type CreateWorkflowOutput,
  type ToolResultDisplayPayload,
} from "@zcode/contracts";
import type { AnalyzeResult } from "@zcode/dynamic-workflow";
import { createCreateWorkflowDisplay } from "../executor/result-display.js";
import { boundCausalityGraph } from "./create-workflow-graph-bounds.js";

/** Bounded display graph of the analysis; absent when not even one site is analyzable (compile fails before causality). */
export function boundGraphOfAnalysis(
  analysis: AnalyzeResult,
): CreateWorkflowCausalityGraph | undefined {
  return analysis.causality === undefined
    ? undefined
    : boundCausalityGraph(analysis.causality, analysis.flow, analysis.handoff);
}

/**
 * The analysis's create_workflow display (confirm dialog, launch-turn metadata). The model-facing
 response is empty to these readers -- the display projection does not read it either. AmendWorkflow passes
 its own tool name: both launch tools share one display kind.
 */
export function displayOfAnalysis(
  analysis: AnalyzeResult,
  toolName: string = CREATE_WORKFLOW_TOOL_NAME,
): ToolResultDisplayPayload | undefined {
  const causalityGraph = boundGraphOfAnalysis(analysis);
  return createCreateWorkflowDisplay(toolName, {
    diagnostics: analysis.diagnostics,
    ok: analysis.ok,
    response: "",
    ...(causalityGraph === undefined ? {} : { causalityGraph }),
  } satisfies CreateWorkflowOutput);
}
