import type { GitRepositorySummary } from "@zcode/shared";
import type {
  BackgroundWorkSummary,
  GoalState,
  PlanState,
  RunningSubagentSummary,
  ToolCallRow,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import type { SessionWorkflowPhaseSummary } from "@zcode/shared/zcode-protocol-v4";
import {
  deriveSessionWorkflowPhases,
  workflowRunStepCounts,
} from "@zcode/shared/zcode-protocol-v4";
import { extractPlanToolCallContent, getPlanDirectoryTitle } from "@/lib/planToolCall.js";
import { workflowRunParallelPhaseLabel } from "@/lib/workflowRunLine.js";

export interface ConversationStatusPanelGitModel {
  branchName: string | null;
  headRefType: GitRepositorySummary["headRefType"];
  dirtyFileCount: number;
  added: number;
  removed: number;
  ahead: number;
  behind: number;
  isClean: boolean;
}

export interface ConversationStatusPanelPlanModel {
  items: PlanState["items"];
  displayItems: PlanState["items"];
  completedCount: number;
  waitingCount: number;
  totalCount: number;
}

export interface ConversationStatusPanelSessionPlanItem {
  rowId: number;
  toolCallId: string;
  markdown: string;
  title?: string;
  planFilePath?: string;
}

export interface ConversationStatusPanelSessionPlansModel {
  items: ConversationStatusPanelSessionPlanItem[];
}

export interface ConversationStatusPanelRunningSubagent extends RunningSubagentSummary {
  controlWorkId?: string;
  cancellable?: boolean;
}

/**
 * One row of the Workflows section.
 *
 * Three field clusters, because each fact can be absent independently: `status`/`nodesSettled`/`nodesTotal` come from the
 * `workflowRuns` projection; `title`/`startedAt` are static background-task metadata; `workId`/`cancellable`
 * are the Stop preconditions and exist only while the work runs. **Absence is a missing field, never 0 or empty string** --
 * the renderer decides from that whether the row shows status words/steps, duration, or Stop; a fake
 * 0/0 would read as no steps ever run. Cluster rationale in `buildRunningWorkflowRuns`.
 */
export interface ConversationStatusPanelWorkflowRun {
  /** Identity and React key; skewed fallback rows substitute workId (the two are equivalent anyway). */
  runId: string;
  /** Missing -> the row is not clickable (no detail tab to open); same as a projection run without toolCallId. */
  toolCallId?: string;
  /** Status wording exists only with a backing run; fallback rows have none. */
  status?: "pending" | "running";
  nodesSettled?: number;
  nodesTotal?: number;
  /**
   * Phase table (declaration order) and current phase, same derivation as the side-pane running row (shared `deriveSessionWorkflowPhases`).
   * Same cluster as `status`: exists only with a run behind it; degraded rows have none. Empty array = the script declares no phases.
   */
  phases?: SessionWorkflowPhaseSummary[];
  currentPhase?: string;
  /**
   * Display name. **`title ≡ workId` means unnamed**; the renderer swaps in an i18n fallback: core's
   * `workflowTaskSubject` chain ends at taskId (= runId = workId), and the projection copies any non-empty
   * description into title verbatim -- title-equals-id is the only reliable unnamed signal.
   * The model does not swap (i18n is not model layer); it passes title through untouched.
   */
  title?: string;
  startedAt?: number;
  /** Control handle for Stop; present only while the work is running (a finished work has nothing to cancel). */
  workId?: string;
  cancellable?: boolean;
}

/**
 * Intent for which run detail page to open. Session/workspace identity is filled by the host;
 * the panel never knows the scope (same handler as the tool card, no second open path).
 *
 * Lives in the model file, not the component: the composer badge's direct-open test (`resolveSoleRunningWorkflowRunTarget`)
 * and the panel rows share one shape; components take the type from the model, never the reverse.
 */
export interface ConversationStatusPanelWorkflowRunTarget {
  runId: string;
  toolCallId: string;
  workflowName?: string;
}

/**
 * Panel row -> open intent. No `toolCallId`, null (no detail tab to open). The name rides only when real:
 * `title ≡ runId` is what an unnamed run degrades to (core workflowTaskSubject ends at taskId); freezing the runId
 * into the tab label is worse than a generic fallback. Panel rows and the badge direct-open share this one conversion.
 */
export function workflowRunOpenTarget(
  run: ConversationStatusPanelWorkflowRun,
): ConversationStatusPanelWorkflowRunTarget | null {
  if (!run.toolCallId) return null;
  return {
    runId: run.runId,
    toolCallId: run.toolCallId,
    ...(run.title && run.title !== run.runId ? { workflowName: run.title } : {}),
  };
}

export interface ConversationStatusPanelModel {
  hasContent: boolean;
  git: ConversationStatusPanelGitModel | null;
  goal: GoalState | null;
  sessionPlans: ConversationStatusPanelSessionPlansModel | null;
  plan: ConversationStatusPanelPlanModel | null;
  runningBashWorks: BackgroundWorkSummary[];
  runningSubagentWorks: ConversationStatusPanelRunningSubagent[];
  runningWorkflowRuns: ConversationStatusPanelWorkflowRun[];
}

export interface BuildConversationStatusPanelModelInput {
  isOfficeMode?: boolean;
  gitSummary?: GitRepositorySummary | null;
  gitDirtyFileCount?: number;
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
  goal?: GoalState | null;
  sessionPlans?: readonly ToolCallRow[];
  workspacePath?: string;
  plan?: PlanState | null;
  backgroundWorks?: readonly BackgroundWorkSummary[];
  runningSubagents?: readonly RunningSubagentSummary[];
  workflowRuns?: readonly WorkflowRunState[];
}

function buildGitModel({
  gitSummary,
  gitDirtyFileCount = 0,
  gitWorktreeChangeSummary,
}: Pick<
  BuildConversationStatusPanelModelInput,
  "gitSummary" | "gitDirtyFileCount" | "gitWorktreeChangeSummary"
>): ConversationStatusPanelGitModel | null {
  if (!gitSummary?.isGitAvailable || !gitSummary.isRepository) {
    return null;
  }
  const added = gitWorktreeChangeSummary?.added ?? 0;
  const removed = gitWorktreeChangeSummary?.removed ?? 0;
  // Pre-v4, any Git repository created the Git model, so even clean repos showed the top-right
  // status card; the old ChatView showed Git Tools only on worktree line-level changes.
  if (added + removed <= 0) {
    return null;
  }
  const isClean =
    !gitSummary.isDirty &&
    gitDirtyFileCount === 0 &&
    added === 0 &&
    removed === 0 &&
    gitSummary.ahead === 0;

  return {
    branchName: gitSummary.branchName,
    headRefType: gitSummary.headRefType,
    dirtyFileCount: gitDirtyFileCount,
    added,
    removed,
    ahead: gitSummary.ahead,
    behind: gitSummary.behind,
    isClean,
  };
}

function buildPlanModel(plan: PlanState | null | undefined) {
  if (!plan || plan.items.length === 0) {
    return null;
  }
  const completed = plan.items.filter((item) => item.status === "completed");
  return {
    items: plan.items,
    // Regrouping by state would jump finished todos to the list end, breaking TodoWrite
    // snapshot's authoritative order. Keep the original array intact; the renderer owns scrolling and state styling.
    displayItems: plan.items,
    completedCount: completed.length,
    waitingCount: plan.items.length - completed.length,
    totalCount: plan.items.length,
  };
}

function buildSessionPlansModel(
  rows: readonly ToolCallRow[] | undefined,
  workspacePath: string | undefined,
): ConversationStatusPanelSessionPlansModel | null {
  if (!rows?.length) return null;
  const items = rows
    .filter(
      (row) =>
        row.toolName === "ExitPlanMode" &&
        (row.status === "success" || row.status === "error" || row.status === "cancelled"),
    )
    .toSorted((left, right) => right.rowId - left.rowId)
    .flatMap((row) => {
      const content = extractPlanToolCallContent(row, workspacePath ?? "");
      if (!content.markdown) return [];
      const title = getPlanDirectoryTitle(content.markdown);
      return [
        {
          rowId: row.rowId,
          toolCallId: row.toolCallId,
          markdown: content.markdown,
          ...(title ? { title } : {}),
          ...(content.planFilePath ? { planFilePath: content.planFilePath } : {}),
        },
      ];
    });
  return items.length > 0 ? { items } : null;
}

/**
 * Workflows section: active runs join workflow background works on workId == runId.
 *
 * This equation is documented schema fact, not a guess (the kind note in `backgroundWorkSummarySchema` and the
 * "workflow" note in `backgroundResultOriginMetaSchema`); the join matches primary keys
 * directly -- none of the agent row's hide-on-ambiguous-identity disambiguation.
 *
 * Either side may be missing unilaterally; absence handling clusters by **field meaning**, not a single status cut:
 * - `title`/`startedAt` are static metadata, taken at any work status. Dropping them at resultPending
 *   would flash the i18n fallback name and drop the duration mid-run -- pure visual damage.
 * - `workId`/`cancellable` gate Stop and are granted **only while the work runs**: a finished work
 *   has nothing to cancel; keeping the button is a Stop that does nothing.
 * - run without work: still a row (status words and steps are the projection's own facts), minus title/duration/Stop.
 * - work without run: a CLI too old to emit the `workflowRuns` projection. Degrade to a title/duration/Stop-only row,
 * **appended after run-backed rows** -- it has no start-order position, and mid-list insertion would invent one.
 * The whole point of this fallback: **the cancel entry must survive any skew**; so degraded rows take only running
 *   works -- a finished work with no run has nothing actionable and would render as a dead row.
 */
function buildRunningWorkflowRuns(
  runs: readonly WorkflowRunState[] | undefined,
  workflowWorkByWorkId: ReadonlyMap<string, BackgroundWorkSummary>,
): ConversationStatusPanelWorkflowRun[] {
  const rows: ConversationStatusPanelWorkflowRun[] = [];
  const joinedWorkIds = new Set<string>();
  for (const run of runs ?? []) {
    // pending is an active state too: the run started but dispatched no node yet; hiding it
    // opens a window where the workflow started but the panel does not show it.
    if (run.status !== "pending" && run.status !== "running") continue;
    const work = workflowWorkByWorkId.get(run.runId);
    if (work) joinedWorkIds.add(run.runId);
    // Counts share the chat compact-card source (sole implementation workflowRunStepCounts in @zcode/shared: in-table + out-of-table).
    const steps = workflowRunStepCounts(run);
    rows.push({
      runId: run.runId,
      ...(run.toolCallId ? { toolCallId: run.toolCallId } : {}),
      status: run.status,
      nodesSettled: steps.settled,
      nodesTotal: steps.total,
      phases: deriveSessionWorkflowPhases(run),
      ...(run.currentPhase === undefined ? {} : { currentPhase: run.currentPhase }),
      ...(work ? { title: work.title, startedAt: work.startedAt } : {}),
      ...(work?.status === "running"
        ? {
            workId: work.workId,
            // Default to stoppable, same `!== false` as agent rows: hideable-capable without a button is worse than the reverse.
            cancellable: work.cancellable !== false,
          }
        : {}),
    });
  }
  // Order = projection runs order = launch order; the model never sorts. Reordering would make panel rows jump on every projection update.
  for (const [workId, work] of workflowWorkByWorkId) {
    if (joinedWorkIds.has(workId) || work.status !== "running") continue;
    rows.push({
      runId: workId,
      workId,
      title: work.title,
      startedAt: work.startedAt,
      cancellable: work.cancellable !== false,
    });
  }
  return rows;
}

/**
 * What the run is doing right now (docs/dynamic-workflow/presentation.md, Other places a run appears);
 * the run row's second line and the pill share one rule:
 * - pending -> the status word;
 * - no phases declared -> step counts (the only place steps still surface);
 * - multiple burning phases -> names joined with ` ∥ ` (in parallel none is more current);
 * - else the current phase; no current phase either (joined, before the first phase) -> the status word;
 * - degraded row (no status) -> null: unknown state, say nothing.
 * The model yields structure only; the renderer composes copy (status word, step key) via i18n.
 */
export type ConversationStatusPanelWorkflowRunWords =
  | { kind: "status"; status: "pending" | "running" }
  | { kind: "steps"; done: number; total: number }
  | { kind: "phases"; text: string };

export function workflowRunWords(
  run: ConversationStatusPanelWorkflowRun,
): ConversationStatusPanelWorkflowRunWords | null {
  if (run.status === undefined) return null;
  if (run.status === "pending") return { kind: "status", status: "pending" };
  const phases = run.phases ?? [];
  if (phases.length === 0) {
    return { kind: "steps", done: run.nodesSettled ?? 0, total: run.nodesTotal ?? 0 };
  }
  const parallel = workflowRunParallelPhaseLabel(phases);
  if (parallel !== undefined) return { kind: "phases", text: parallel };
  if (run.currentPhase !== undefined) return { kind: "phases", text: run.currentPhase };
  return { kind: "status", status: "running" };
}

/**
 * Composer badge direct-open: when this session's running set is **exactly**
 * one detail-openable workflow run, return its open intent; else null and the badge falls back to expanding the pill.
 *
 * Every condition has a reason: zero terminals/subagents -- the badge is their only entry; direct-open would hide them;
 * exactly one workflow -- choosing among several is the user's call; has `toolCallId` -- degraded rows (work, no run) and
 * legacy-CLI runs have no detail page, same as non-clickable panel rows; fall back to the pill so Stop stays reachable.
 * Input is `buildConversationStatusPanelModel` output: badge and pill share one running-state truth.
 */
export function resolveSoleRunningWorkflowRunTarget(
  model: Pick<
    ConversationStatusPanelModel,
    "runningBashWorks" | "runningSubagentWorks" | "runningWorkflowRuns"
  >,
): ConversationStatusPanelWorkflowRunTarget | null {
  if (model.runningBashWorks.length > 0 || model.runningSubagentWorks.length > 0) return null;
  if (model.runningWorkflowRuns.length !== 1) return null;
  return workflowRunOpenTarget(model.runningWorkflowRuns[0]!);
}

export function buildConversationStatusPanelModel(
  input: BuildConversationStatusPanelModelInput,
): ConversationStatusPanelModel {
  const git = input.isOfficeMode ? null : buildGitModel(input);
  const goal = input.goal ?? null;
  const sessionPlans = buildSessionPlansModel(input.sessionPlans, input.workspacePath);
  const plan = buildPlanModel(input.plan);
  const runningBashWorks: BackgroundWorkSummary[] = [];
  const workflowWorkByWorkId = new Map<string, BackgroundWorkSummary>();
  const subagentControlByChildSessionId = new Map<string, BackgroundWorkSummary | null>();
  for (const work of input.backgroundWorks ?? []) {
    if (work.kind === "workflow") {
      // "workflow" (workflow run) used to sit under Terminals with bash -- a recorded mislabel that kept Stop alive;
      // it has its own Workflows section now, so enter the workflow join **only** via workId ≡ runId.
      // Leaving it in runningBashWorks would list one run in both sections.
      //
      // This branch sits before the running gate: title/startedAt stay valid for finished works
      // (see the buildRunningWorkflowRuns cluster notes) and the status check happens there, per
      // field. workId is the primary key; duplicates mean broken upstream - no disambiguation.
      workflowWorkByWorkId.set(work.workId, work);
      continue;
    }
    if (work.status !== "running") continue;
    if (work.kind === "bash") {
      runningBashWorks.push(work);
    } else if (work.kind === "subagent" && work.childSessionId) {
      // Since the directory projection took over agent display, legacy backgroundWorks workId/cancellable
      // stopped re-associating, hiding Stop. Accept only an exact unique childSessionId match; with duplicates or
      // missing identity, show no control rather than guess by title/time and stop the wrong task.
      const existing = subagentControlByChildSessionId.get(work.childSessionId);
      subagentControlByChildSessionId.set(
        work.childSessionId,
        existing === undefined ? work : null,
      );
    }
  }
  const runningSubagentWorks: ConversationStatusPanelRunningSubagent[] = (
    input.runningSubagents ?? []
  ).map((subagent) => {
    const controlWork = subagentControlByChildSessionId.get(subagent.childSessionId);
    if (!controlWork) return subagent;
    return {
      ...subagent,
      controlWorkId: controlWork.workId,
      cancellable: controlWork.cancellable !== false,
    };
  });
  const projectedChildSessionIds = new Set(
    runningSubagentWorks.map((subagent) => subagent.childSessionId),
  );
  for (const [childSessionId, controlWork] of subagentControlByChildSessionId) {
    if (!controlWork || projectedChildSessionIds.has(childSessionId)) continue;
    // backgroundWorks holds precise childSessionId running facts, but the subagents cold/live handover window
    // can briefly miss rows; the old model hid the whole agent control
    // row. Restore the same control only from unique-identity authoritative works; duplicates still refuse to guess.
    runningSubagentWorks.push({
      agentId: controlWork.workId,
      childSessionId,
      controlWorkId: controlWork.workId,
      subagentType: "subagent",
      title: controlWork.title,
      status: controlWork.blocked ? "blocked" : "running",
      startedAt: controlWork.startedAt,
      cancellable: controlWork.cancellable !== false,
    });
  }

  const runningWorkflowRuns = buildRunningWorkflowRuns(input.workflowRuns, workflowWorkByWorkId);

  return {
    git,
    goal,
    sessionPlans,
    plan,
    runningBashWorks,
    runningSubagentWorks,
    runningWorkflowRuns,
    hasContent: Boolean(
      git ||
      goal ||
      sessionPlans ||
      plan ||
      runningBashWorks.length > 0 ||
      runningSubagentWorks.length > 0 ||
      runningWorkflowRuns.length > 0,
    ),
  };
}
