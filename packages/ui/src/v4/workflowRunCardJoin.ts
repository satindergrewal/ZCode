import { workflowRunStepCounts, type WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";

/**
 * Tool card -> dwf run join.
 *
 * The authority is each run toolCallId in the `workflowRuns` projection (the schema comment names it
 * the tool-card-to-details correlation key); under v4 a tool row own output keeps only
 * the prose picked by `formatCreateWorkflowModelContent`; structured fields such as `status` / `backgroundTaskId`
 * are not on the row at all.
 *
 * A pure function, not a `useMemo` in a component: the counting semantics (settled vs observed) are the only
 * rule worth enumerating here, and enumerating a Map renders nothing.
 */
export function buildWorkflowRunByToolCallId(
  runs: readonly WorkflowRunState[] | undefined,
): ReadonlyMap<string, WorkflowRunCardSummary> {
  const byToolCallId = new Map<string, WorkflowRunCardSummary>();
  for (const run of runs ?? []) {
    // Runs without a toolCallId have no clickable card; keep them out of the table.
    if (!run.toolCallId) continue;
    const { settled, total } = workflowRunStepCounts(run);
    byToolCallId.set(run.toolCallId, {
      runId: run.runId,
      status: run.status,
      ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
      nodesSettled: settled,
      // Scheduled (observed), never a grand total: dynamic-workflow node counts are decided by the script at runtime.
      nodesTotal: total,
      agents: run.actors.length,
      // Carry the whole live projection: the in-card timeline needs lights, pills, and ink.
      run,
      // Resumability is a status bit (decided by the CLI on the run-settled payload per the resume gate, carried by the reducer); the UI never derives it.
      ...(run.resumable === true ? { resumable: true as const } : {}),
    });
  }
  return byToolCallId;
}

/**
 * The runId-keyed join table (compact clickable run state).
 *
 * ResumeWorkflowRun tool rows can NEVER be joined by toolCallId - in the projection run.toolCallId keeps the
 * original CreateWorkflow row across resumes (deliberate keep-the-details-join-intact semantics; do not change); the resume row
 * display payload carries runId (= backgroundTaskId = workId), so join the same projection by runId.
 * The sidebar run-tab identity is runId-keyed too: opening from the resume or original create row hits the same tab.
 */
export function buildWorkflowRunByRunId(
  runs: readonly WorkflowRunState[] | undefined,
): ReadonlyMap<string, WorkflowRunCardSummary> {
  const byRunId = new Map<string, WorkflowRunCardSummary>();
  for (const run of runs ?? []) {
    const { settled, total } = workflowRunStepCounts(run);
    byRunId.set(run.runId, {
      runId: run.runId,
      status: run.status,
      ...(run.stopReason === undefined ? {} : { stopReason: run.stopReason }),
      nodesSettled: settled,
      nodesTotal: total,
      agents: run.actors.length,
      run,
      ...(run.resumable === true ? { resumable: true as const } : {}),
      // Correlation key of the open request: WorkflowRunSidePane uses it to find the CreateWorkflow initiating row (graph and script
      // both live on that row). The resume row own id is useless - its display has no graph.
      ...(run.toolCallId ? { toolCallId: run.toolCallId } : {}),
    });
  }
  return byRunId;
}

/**
 * Which `toolCallId` the open-sidebar-run request carries: not the clicked row, the initiating
 * CreateWorkflow row - `WorkflowRunSidePane` uses it to find the initiator in the row window (causalityGraph and script
 * text hang on that row display/inputs; the resume row display has no graph, passing its own id would drop details into
 * no-graph-in-visible-history). When the join digest carries the projected `toolCallId`, always use it; absent falls
 * back to the clicked row id - equal on create rows anyway.
 *
 * Also blocks overwrite pollution: `openWorkflowRunSidePane` merges {...existing, ...nextTab} into an existing tab;
 * a wrong id in the request would corrupt a healthy tab too.
 */
export function resolveWorkflowRunOpenToolCallId(
  rowToolCallId: string,
  workflowRun: WorkflowRunCardSummary | undefined,
): string {
  return workflowRun?.toolCallId ?? rowToolCallId;
}

/**
 * runId -> qids the run currently rests on. Sole data source of the Waiting->Answered flip in the workflow notification manifest.
 *
 * Key present iff the run is in the projection (after cold replay, run-settled clears a settled run pendingQuestions); the value is a Set (possibly empty = last
 * one answered); key absent = run not present (evicted by the 8-cap, neutral Question).
 *
 * An empty pendingQuestions drops the whole key (existing workflow-runs schema convention), collapsing to an empty Set.
 */
export function buildWorkflowRunPendingQuestionsByRunId(
  runs: readonly WorkflowRunState[] | undefined,
): ReadonlyMap<string, ReadonlySet<string>> {
  const byRunId = new Map<string, ReadonlySet<string>>();
  for (const run of runs ?? []) {
    byRunId.set(run.runId, new Set((run.pendingQuestions ?? []).map((question) => question.qid)));
  }
  return byRunId;
}

/**
 * The initiating graph hanging on a row: the graph belongs to the run,
 * found via the run-initiating toolCallId regardless of the hosting row -
 * - CreateWorkflow tool row: the `causalityGraph` of `display.kind === "create_workflow"`;
 * - hub direct-launch has no tool row: the graph hangs on the launch-turn turnHeader / userInputs
 *   `workflowLaunch` metadata (same toolCallId, same display schema).
 *
 * An empty graph (no ask / files.* anywhere in the script) deserves no empty lane; treat as no-graph, same verdict as the tool card.
 */
function workflowGraphOfRow(
  row: ConversationRow,
): { toolCallId: string; graph: WorkflowCausalityGraphData } | undefined {
  if (row.kind === "toolCall") {
    const display = row.display;
    if (display?.kind !== "create_workflow") return undefined;
    const graph = display.causalityGraph;
    return graph !== undefined && graph.steps.length > 0
      ? { toolCallId: row.toolCallId, graph }
      : undefined;
  }
  if (row.kind === "turnHeader" || row.kind === "userInput") {
    const launch = row.workflowLaunch;
    const display = launch?.display;
    if (launch === undefined || display?.kind !== "create_workflow") return undefined;
    const graph = display.causalityGraph;
    return graph !== undefined && graph.steps.length > 0
      ? { toolCallId: launch.toolCallId, graph }
      : undefined;
  }
  return undefined;
}

/**
 * initiating toolCallId -> graph join, built in one pass over the row window. Turn-tail run cards (three sources: CreateWorkflow rows,
 * ResumeWorkflowRun rows, direct-launch turns) and the run details / script transcript side pane all take the graph from this one table -
 * graph-by-initiating-toolCallId has exactly one implementation. The row window is bounded; missing the initiator in old chats is normal,
 * not an error: no graph to give; the card degrades to a single header row and the side pane reports graph unavailable.
 */
export function buildWorkflowGraphByToolCallId(
  rows: readonly ConversationRow[] | undefined,
): ReadonlyMap<string, WorkflowCausalityGraphData> {
  const byToolCallId = new Map<string, WorkflowCausalityGraphData>();
  for (const row of rows ?? []) {
    const found = workflowGraphOfRow(row);
    // Launch-turn turnHeader and userInputs carry identical metadata; first seen wins.
    if (found !== undefined && !byToolCallId.has(found.toolCallId)) {
      byToolCallId.set(found.toolCallId, found.graph);
    }
  }
  return byToolCallId;
}

/** Initiating toolCallId prefix of runs revised via Configure (the agent mints `settings-<uuid>`). */
const WORKFLOW_SETTINGS_TOOL_CALL_PREFIX = "settings-";

/**
 * Graph by initiating toolCallId, plus the single borrow rule:
 * a run revised via Configure (`settings-...`) has no graph in the row window until its settings turn lands - the main agent is mid-turn and
 * the settings turn waits for that turn; until then borrow the predecessor graph via `resumedFrom` - its script is the predecessor by construction.
 * No other run borrows: an amended script draws a different graph. The predecessor may itself be a Configure, so walk up the chain with cycle protection.
 */
export function resolveWorkflowRunGraph(
  graphs: ReadonlyMap<string, WorkflowCausalityGraphData>,
  toolCallId: string,
  runs: readonly WorkflowRunState[] | undefined,
): WorkflowCausalityGraphData | undefined {
  const visited = new Set<string>();
  let current: string | undefined = toolCallId;
  while (current !== undefined && !visited.has(current)) {
    visited.add(current);
    const graph = graphs.get(current);
    if (graph !== undefined) return graph;
    if (!current.startsWith(WORKFLOW_SETTINGS_TOOL_CALL_PREFIX)) return undefined;
    const settingsToolCallId: string = current;
    const run: WorkflowRunState | undefined = runs?.find(
      (candidate) => candidate.toolCallId === settingsToolCallId,
    );
    const predecessorId: string | undefined = run?.resumedFrom;
    current =
      predecessorId === undefined
        ? undefined
        : runs?.find((candidate) => candidate.runId === predecessorId)?.toolCallId;
  }
  return undefined;
}
