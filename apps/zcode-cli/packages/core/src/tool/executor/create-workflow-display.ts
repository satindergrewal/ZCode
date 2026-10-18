/**
 * CreateWorkflow result-card display builder. Split from result-display.ts (400-line discipline): same family
 * as workflow-observation-display.ts -- dispatch by tool name, safeParse the output schema,
 * display-side bounds independent of the result budget.
 */

import {
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS,
  CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS,
  CREATE_WORKFLOW_TOOL_NAME,
  CreateWorkflowOutputSchema,
  FILL_WORKFLOW_HOLE_TOOL_NAME,
  type ToolResultDisplayPayload,
} from "@zcode/contracts";

/**
 * Three tools share the `create_workflow` display: the two launchers plus hole fill — its output is a
 * CreateWorkflowOutput, the graph is the valid script's graph, and the shared row renderer recognizes the fill by tool name
 * (docs/dynamic-workflow/presentation.md "Holes on the timeline", "The fill row").
 */
const CREATE_WORKFLOW_DISPLAY_TOOL_NAMES: ReadonlySet<string> = new Set([
  CREATE_WORKFLOW_TOOL_NAME,
  AMEND_WORKFLOW_TOOL_NAME,
  FILL_WORKFLOW_HOLE_TOOL_NAME,
]);

/**
 * The field set of this projection is **frozen** (see the contracts schema comment for why). Gate-specific
 * facts -- a saved run's origin, the resolved script -- travel only through the **tool args** channel, never display.
 */
export function createCreateWorkflowDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  // Both launch tools share one display kind: graph, draft pen, and diagnostic card have a single UI implementation.
  if (!CREATE_WORKFLOW_DISPLAY_TOOL_NAMES.has(toolName)) return undefined;
  const parsed = CreateWorkflowOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;
  // In-place concurrency has no display (docs/dynamic-workflow/launch.md "Changing only the parallelism of a
  // live run"): that path compiles no script, and the `ok` of this payload reads on the UI as
  // "compiled" in the UI. The criterion is an **explicit `retuned` block**, not shape -- "ok without status" also
  // covers the no-run-port/typecheck-only path. The card falls back to the response-body segment.
  if (parsed.data.retuned !== undefined) return undefined;

  const { causalityGraph, diagnostics, fill, ok } = parsed.data;
  // Display bypasses the tool-result budget: diagnostic count and per-message length must be bounded before
  // entering live events and persisted metadata, so type errors cannot inflate continuous/replayable messages.
  // causalityGraph is already bounded at the tool-output edge (handler boundCausalityGraph + output schema);
  // pass it through.
  const errorCount = diagnostics.length;
  const bounded = diagnostics
    .slice(0, CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS)
    .map((diagnostic) => ({
      line: diagnostic.line,
      column: diagnostic.column,
      code: diagnostic.code,
      message: diagnostic.message.slice(0, CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS),
    }));
  const truncated = errorCount > bounded.length;

  return {
    kind: "create_workflow",
    ok,
    errorCount,
    diagnostics: bounded,
    ...(causalityGraph === undefined ? {} : { causalityGraph }),
    ...(truncated ? { truncated: true } : {}),
    // The row that names itself (contracts' CreateWorkflowOutputSchema.fill explains why it goes through display).
    ...(fill === undefined ? {} : { fill }),
  };
}
