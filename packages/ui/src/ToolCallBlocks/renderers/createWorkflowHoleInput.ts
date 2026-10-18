import {
  isSyntheticLaneId,
  type WorkflowCausalityGraphData,
} from "@/components/workflow-graph/types.js";
import { isPlainRecord } from "@/ToolCallBlocks/renderers/createWorkflowInput.js";

/**
 * Target hole of a FillWorkflowHole row (docs/dynamic-workflow/presentation.md "The fill row"): `run_id` /
 * `hole_id` come from the row input (written by the model); **name, draft path and line numbers come from the display `fill` block**, which the tool
 * writes parsed into its output and the projection carries verbatim. The `hole` block in the input is backfilled by resolveInput for the permission rule; the
 * transcript does not store it (first relay run 2026-09-28: input-only row titles degraded to `hole#1`) -- it is still read here, solely for the
 * approval-dialog path that sees the parsed input; display wins when present. Split from createWorkflowInput.ts (max-lines gate).
 */
export interface WorkflowHoleTarget {
  runId: string | undefined;
  holeId: string | undefined;
  name: string | undefined;
  draftPath: string | undefined;
  line: number | undefined;
}

/** The display `fill` block (same shape as the shared toolCallCreateWorkflowDisplaySchema.fill), unparsed as-is. */
export interface WorkflowDisplayFill {
  siteId: string;
  name: string;
  draftPath?: string;
  line?: number;
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

export function readWorkflowHoleTarget(
  input: unknown,
  fill?: WorkflowDisplayFill,
): WorkflowHoleTarget | undefined {
  if (!isPlainRecord(input)) return undefined;
  const hole = isPlainRecord(input.hole) ? input.hole : undefined;
  const line = fill?.line ?? hole?.line;
  return {
    runId: trimmed(input.run_id),
    holeId: trimmed(input.hole_id) ?? trimmed(fill?.siteId),
    name: trimmed(fill?.name) ?? trimmed(hole?.name),
    draftPath: trimmed(fill?.draftPath) ?? trimmed(hole?.draft_path),
    line: typeof line === "number" && Number.isInteger(line) && line > 0 ? line : undefined,
  };
}

/** The fill body (`script`): same channel as the CreateWorkflow script; the streaming draft scans stages from it. */
export function readWorkflowHoleBody(input: unknown): string | undefined {
  return isPlainRecord(input) && typeof input.script === "string" ? input.script : undefined;
}

/**
 * How many stages and subagents one fill wrote (title: hole filled, name, k stages, m subagents):
 * the valid script graph carries stages/sites with `fill === holeId`. The hole's own stage (a fill without stages) does not count.
 */
export function workflowFillCounts(
  graph: WorkflowCausalityGraphData | undefined,
  holeId: string,
): { phases: number; agents: number } {
  if (graph === undefined) return { agents: 0, phases: 0 };
  const phases = (graph.phases ?? []).filter((phase) => phase.fill === holeId).length;
  const lanes = new Set<string>();
  for (const step of graph.steps) {
    // Open inner holes written by the fill (kind `hole`, lane `main`) are not subagents.
    if (step.fill === holeId && step.kind !== "hole" && !isSyntheticLaneId(step.lane)) {
      lanes.add(step.lane);
    }
  }
  return { agents: lanes.size, phases };
}
