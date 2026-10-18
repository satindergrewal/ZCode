import type { GitRepositorySummary } from "@zcode/shared";
import type {
  BackgroundWorkSummary,
  GoalState,
  PlanState,
  RunningSubagentSummary,
  ToolCallRow,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import { workflowRunStepCounts } from "@zcode/shared/zcode-protocol-v4";
import { extractPlanToolCallContent, getPlanDirectoryTitle } from "@/lib/planToolCall.js";

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
 * Fields come in three clusters because each fact source can be absent independently:
 * `status`/`nodesSettled`/`nodesTotal` come from the `workflowRuns` projection; `title`/
 * `startedAt` are background-task static metadata; `workId`/`cancellable` are the Stop
 * preconditions and exist only while the background work is running. Absence is expressed by
 * a missing field, never 0 or an empty string - the renderer uses that to decide whether the
 * row shows status wording/step counts, a duration, or a Stop; a fake 0/0 would read as
 * zero-steps-run. Cluster rationale in `buildRunningWorkflowRuns`.
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
   // Display name. title == workId means unnamed: the renderer swaps in an i18n fallback. The
   // core workflowTaskSubject fallback chain ends at taskId (== runId == workId) and the
   // projection copies any non-empty description into title verbatim, so title-equals-id is the
   // only reliable unnamed signal. The model never substitutes (i18n is not model layer); it
   // passes title through untouched.
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
 * Lives in the model file, not the component: the composer-badge direct-open check
 * (`resolveSoleRunningWorkflowRunTarget`) produces the same shape as panel rows; components
 * take the type from the model, never the reverse.
 */
export interface ConversationStatusPanelWorkflowRunTarget {
  runId: string;
  toolCallId: string;
  workflowName?: string;
}

/**
 * Panel row -> open intent. Without `toolCallId` the result is null (no detail tab). The name
 * is included only when real: title == runId is what an unnamed run's fallback looks like
 * (core workflowTaskSubject ends at taskId), and freezing the runId into a tab label beats a
 * generic fallback for worse. Panel rows and the composer-badge direct-open share this one
 * conversion.
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

interface BuildConversationStatusPanelModelInput {
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
    // Regrouping by status would jump a completed Todo to the list end, breaking the TodoWrite
    // snapshot's authoritative order. Keep the original array intact; scrolling and status
    // styling are renderer concerns.
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
 * That equality is documented schema fact, not a guess (the kind comment in
 * `backgroundWorkSummarySchema` and the "workflow" comment in
 * `backgroundResultOriginMetaSchema`), so the join matches primary keys directly - none of the
 * agent-row hide-on-duplicate-identity disambiguation.
 *
 * Either side may be absent unilaterally; absence handling clusters by field meaning, not a
 * blanket cut by work status:
 * - `title`/`startedAt` are static metadata, taken whatever the work status. Dropping them at
 *   resultPending would flash the i18n fallback name and drop the duration on a still-running
 *   row - a pure visual fault.
 * - `workId`/`cancellable` are Stop preconditions, present only while running: a finished work
 *   has nothing to cancel, and a leftover button is a dead Stop.
 * - run without work: still a row (status wording/step counts are projection facts), just
 *   without title/duration/Stop.
 * - work without run: the CLI is too old to emit the `workflowRuns` projection key. Degrade to
 *   a title/duration/Stop-only row, appended after run-backed rows - it has no launch-order
 *   place, and inserting mid-list would fabricate order. The whole point of this fallback is
 *   that the cancel entry must never disappear under any skew; hence fallback rows take
 *   running works only - a finished work with no run has nothing operable and would render as
 *   a dead row.
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
 * Composer-badge direct-open: when the session run state is exactly one workflow run with a
 * detail page, return its open intent; otherwise null and the badge falls back to the
 * expandable pill.
 *
 * Every criterion has a reason: zero terminals/subagents - the badge is their only entry and
 * direct-open would hide them; exactly one workflow - choosing among several is the user's
 // call; has `toolCallId` - fallback rows (work without run) and legacy-CLI runs have no
 // detail page, same as unclickable panel rows, so fall back to the pill and keep Stop
 // reachable. Input is exactly `buildConversationStatusPanelModel` output: badge and pill
 // share one run-state truth.
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
      // "workflow" runs used to sit under Terminals beside bash - a recorded mislabel kept to
      // preserve the stop entry. They now have the Workflows section, so they enter the
      // workflow join on workId == runId only; leaving them in runningBashWorks would show the
      // same run twice.
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
      // Once the directory projection took over Agent display, legacy backgroundWorks lost their
      // workId/cancellable join and the Stop entry vanished. Accept only an exact unique
      // childSessionId match; with duplicate/missing identity, hide the control rather than
      // guess by title/time and stop the wrong task.
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
    // backgroundWorks already carries the running fact with an exact childSessionId, but the
    // subagents cold/live handoff window can drop the row briefly, and the old model hid the
    // whole Agent control. Fill the same control from the unique-identity authoritative work
    // only; duplicates still refuse to guess.
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
