import type {
  V4ConversationWorkflowRunSummary,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * Pure model of the run directory; the journal is the single source of truth.
 *
 * The Ended-N footer on the task list and the directory rows MUST share one filter and one bucketing.
 * Two implementations would drift: the footer says 5, the directory opens with 4.
 * Hence only two exports, and the count equals the ended-list length by construction (see `countEndedWorkflowRuns` at the bottom).
 */

/**
 * Rows fetched per directory page.
 *
 * Both callers MUST share one value: the directory page and the task-list count hold separate hook instances; differing depths mean
 * differing denominators (CLI default 16, cap 64 - `DEFAULT_LIST_RUNS_LIMIT` in
 * `dynamic-workflow-run-service.ts`). Take the cap, not the default: this page is the whole history a user can see,
 * and 64 journal summary rows are a bounded cheap read.
 */
export const WORKFLOW_RUN_DIRECTORY_LIMIT = 64;

/**
 * One directory row: the discovery-query summary with `toolCallId` tightened to required - filtering happens at table build,
 * so downstream (page, counts) never sees a row that cannot open details and need not re-check.
 */
export type WorkflowRunDirectoryRow = V4ConversationWorkflowRunSummary & { toolCallId: string };

interface WorkflowRunDirectory {
  /** `pending` / `running`: still moving. */
  running: WorkflowRunDirectoryRow[];
  /** `completed` / `errored` / `stopped`: one bucket; the row status word tells the ending. */
  ended: WorkflowRunDirectoryRow[];
  /**
   * Whether this page is exhausted (more may exist). Judge by returned rows, never the filtered count:
   * a page of legacy runs without toolCallId shows zero rows yet must not claim the-end.
   */
  truncated: boolean;
}

/**
 * Runs without `toolCallId` cannot open details (the `workflow-run` tab needs it to find the graph row in the parent projection);
 * the product drops them entirely instead of graying out. Cost: runs recorded before the
 * `tool_call_id` column are unreachable in the GUI.
 */
function hasDetailAnchor(
  summary: V4ConversationWorkflowRunSummary,
): summary is WorkflowRunDirectoryRow {
  return summary.toolCallId !== undefined;
}

function isEnded(summary: V4ConversationWorkflowRunSummary): boolean {
  return summary.status !== "pending" && summary.status !== "running";
}

/**
 * A missing summary (not yet fetched / capability absent) is an empty directory just like zero rows: callers distinguish via the hook
 * `null` vs `[]`; the model stays out of it - it only buckets.
 *
 * No sorting: order = query order = most-recent-update first (sorting lives in the CLI storage layer). Re-sorting here would fight
 * the storage layer over one decision; any mismatch makes the list jump on every refetch.
 */
export function buildWorkflowRunDirectory(
  summaries: readonly V4ConversationWorkflowRunSummary[] | null | undefined,
): WorkflowRunDirectory {
  const rows = (summaries ?? []).filter(hasDetailAnchor);
  return {
    running: rows.filter((row) => !isEnded(row)),
    ended: rows.filter(isEnded),
    truncated: (summaries?.length ?? 0) >= WORKFLOW_RUN_DIRECTORY_LIMIT,
  };
}

/**
 * The task-list footer count. Built by the same table function, so it equals the directory ended-section length by construction -
 * this invariant is why the module exists; never shortcut with `summaries.filter(...)` at the call site.
 */
export function countEndedWorkflowRuns(
  summaries: readonly V4ConversationWorkflowRunSummary[] | null | undefined,
): number {
  return buildWorkflowRunDirectory(summaries).ended.length;
}

/**
 * The refetch trigger key for this journal summary, derived from the live projection.
 *
 * Shape: run count + settled count. The directory expresses two things only: presence and section. Hence
 * - a new run starts -> the former moves (it must appear under running);
 * - a run settles -> the latter moves (it moves to ended);
 * - node-level progress -> neither moves.
 *
 * The last rule is the point. The projection `revision` rises on every engine event; keying on it turns one paged read into a
 * stream following events, with no visible difference on the directory page.
 *
 * Both surfaces share this one derivation (task-list count and directory page), same reason as `countEndedWorkflowRuns`:
 * matching denominators is not enough; freshness must match too - the observed failure was island-updated, page-not.
 */
export function workflowRunDirectoryRefreshKey(
  runs: readonly WorkflowRunState[] | null | undefined,
): string {
  const all = runs ?? [];
  const settled = all.filter((run) => run.status !== "pending" && run.status !== "running").length;
  return `${all.length}:${settled}`;
}
