import { workflowRunStepCounts, type WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  ZCODE_WORKFLOWS_FOR_RUN_MAX_CANDIDATES,
  type ZCodeWorkflowsForRunCandidate,
} from "@zcode/shared";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";
import { readWorkflowHoleTarget } from "@/ToolCallBlocks/renderers/createWorkflowHoleInput.js";
import { isFillWorkflowHoleToolCall } from "@/lib/workflowToolNames.js";

/**
 * Tool card -> dwf run join (docs/dynamic-workflow/presentation.md, The tool row).
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

/**
 * runId -> latest successful fill's display (docs/dynamic-workflow/presentation.md, Holes on the timeline,
 * The model): a `FillWorkflowHole` row outputs `CreateWorkflowOutput` whose `causalityGraph` is the **valid script's**
 * graph -- the hole's body already stands at the hole. Card and side pane take the newest display whose run id is theirs:
 * the fill row's after completion, the origin's before. One ordered pass over the row window, later wins; only successful parsed rows count
 * (an unparsable fill joined nothing; its graph is not this run's). The name comes from display's `fill` block (the filled hole has no graph node;
 * the row args have none -- the transcript keeps only the model's own args); the type never surfaces.
 */
export interface WorkflowFillGraph {
  graph: WorkflowCausalityGraphData;
  holeLabels: ReadonlyMap<string, { name: string }>;
}

function readFillRow(
  row: ConversationRow,
): { runId: string; holeId: string; name?: string; graph: WorkflowCausalityGraphData } | undefined {
  if (row.kind !== "toolCall" || row.status !== "success") return undefined;
  if (!isFillWorkflowHoleToolCall(row)) return undefined;
  const display = row.display;
  if (display?.kind !== "create_workflow" || display.ok !== true) return undefined;
  const graph = display.causalityGraph;
  if (graph === undefined || graph.steps.length === 0) return undefined;
  const target = readWorkflowHoleTarget(row.input, display.fill);
  if (target?.runId === undefined || target.holeId === undefined) return undefined;
  return {
    runId: target.runId,
    holeId: target.holeId,
    ...(target.name === undefined ? {} : { name: target.name }),
    graph,
  };
}

export function buildWorkflowFillGraphByRunId(
  rows: readonly ConversationRow[] | undefined,
): ReadonlyMap<string, WorkflowFillGraph> {
  const byRunId = new Map<string, WorkflowFillGraph>();
  for (const row of rows ?? []) {
    const fill = readFillRow(row);
    if (fill === undefined) continue;
    // Names accumulate across fills: the second fill's graph still has the first head, whose name lives only in the first row's args.
    const labels = new Map(byRunId.get(fill.runId)?.holeLabels ?? []);
    if (fill.name !== undefined) labels.set(fill.holeId, { name: fill.name });
    byRunId.set(fill.runId, { graph: fill.graph, holeLabels: labels });
  }
  return byRunId;
}

/** The only graph entry for card/side pane: the fill row's graph once filled, else by origin toolCallId (including the config borrow rule). */
export function resolveWorkflowRunGraphForRun(
  graphs: ReadonlyMap<string, WorkflowCausalityGraphData>,
  fills: ReadonlyMap<string, WorkflowFillGraph> | undefined,
  toolCallId: string | undefined,
  runId: string | undefined,
  runs: readonly WorkflowRunState[] | undefined,
): WorkflowCausalityGraphData | undefined {
  const fill = runId === undefined ? undefined : fills?.get(runId);
  if (fill !== undefined) return fill.graph;
  return toolCallId === undefined ? undefined : resolveWorkflowRunGraph(graphs, toolCallId, runs);
}

/** Origin toolCallId prefix for config-revised runs (the agent mints `settings-<uuid>`; docs/dynamic-workflow/launch.md). */
export const WORKFLOW_SETTINGS_TOOL_CALL_PREFIX = "settings-";

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

/**
 * Which workflow the model saved this run as (docs/dynamic-workflow/transcript-and-notifications.md,
 * Which workflow a run is saved as): successful `SaveWorkflow` rows in the window, grouped by the
 * `run_id` their args claim.
 *
 * These are **candidates**, not verdicts: the row only says the model saved that name then; whether the file exists and is the same one is
 * re-resolved agent-side via `workflows/forRun`. So no output reads here and nothing beyond success/failure --
 * non-`status === "success"` rows (compile failed, rejected, still streaming) never wrote a file anyway.
 *
 * Same discipline as the other joins: pure, one pass over the row window, identity via the args channel only (display has none).
 */
export type WorkflowSaveCandidate = ZCodeWorkflowsForRunCandidate;

function readWorkflowSaveCandidate(
  row: ConversationRow,
): { runId: string; candidate: WorkflowSaveCandidate } | undefined {
  if (row.kind !== "toolCall" || row.toolName !== "SaveWorkflow" || row.status !== "success") {
    return undefined;
  }
  const input = row.input;
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  const runId = typeof record.run_id === "string" ? record.run_id.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (runId.length === 0 || name.length === 0) return undefined;
  const scope = record.scope === "global" || record.scope === "project" ? record.scope : undefined;
  return { runId, candidate: { name, ...(scope === undefined ? {} : { scope }) } };
}

export function buildWorkflowSaveCandidatesByRunId(
  rows: readonly ConversationRow[] | undefined,
): ReadonlyMap<string, readonly WorkflowSaveCandidate[]> {
  const byRunId = new Map<string, WorkflowSaveCandidate[]>();
  for (const row of rows ?? []) {
    const found = readWorkflowSaveCandidate(row);
    if (found === undefined) continue;
    const list = byRunId.get(found.runId) ?? [];
    // A same-name re-save (metadata edited, saved again) keeps one candidate: resolving once equals resolving thrice.
    if (list.some((entry) => entry.name === found.candidate.name)) continue;
    // Hold the protocol's candidate cap here: keep the earliest few on overflow (the first save likeliest survives).
    if (list.length >= ZCODE_WORKFLOWS_FOR_RUN_MAX_CANDIDATES) continue;
    list.push(found.candidate);
    byRunId.set(found.runId, list);
  }
  return byRunId;
}
