import type { ZCodeTaskMeta } from "@zcode/shared";
import type {
  PendingInteractionSummary,
  SessionSummary,
  SessionWorkflowActivity,
} from "@zcode/shared/zcode-protocol-v4";

// UI-only sidecar: never enters shared task meta/schema, never writes back to tasks-index.
// Field names carry an explicit internal prefix so callers never mistake them for persisted task properties.
const TASK_LIST_ROW_ACTIVITY_FIELD = "__zcodeSessionActivity" as const;

export interface TaskListRowActivity {
  phase: SessionSummary["phase"];
  lastActivityAt: number;
  hasBackgroundWork: boolean;
  pendingInteractions?: PendingInteractionSummary;
  /** Data of the sidebar workflow-run row; absent without a run. */
  workflowActivity?: SessionWorkflowActivity;
}

export type TaskListMetaWithActivity = ZCodeTaskMeta & {
  [TASK_LIST_ROW_ACTIVITY_FIELD]: TaskListRowActivity;
};

export function attachTaskListRowActivity<T extends ZCodeTaskMeta>(
  task: T,
  activity: TaskListRowActivity,
): T & TaskListMetaWithActivity {
  return {
    ...task,
    [TASK_LIST_ROW_ACTIVITY_FIELD]: activity,
  };
}

export function getTaskListRowActivity(task: ZCodeTaskMeta): TaskListRowActivity | null {
  const activity = (task as Partial<TaskListMetaWithActivity>)[TASK_LIST_ROW_ACTIVITY_FIELD];
  return activity ?? null;
}

/** Trust live sessions-index phase only; a stale tasks-index status=running must not pin historical tasks. */
function isTaskListRowRunning(task: ZCodeTaskMeta): boolean {
  const phase = getTaskListRowActivity(task)?.phase;
  return phase === "prewarming" || phase === "running";
}

/**
 * Running-layer membership for the list: turn in flight (prewarming/running) OR background work attached (hasBackgroundWork).
 *
 * A dynamic workflow run is background work - once the launch turn closes, the parent phase is back to completedSuccess,
 * yet every run progress event still advances lastActivityAt. Judged by phase alone, two sessions each running a workflow
 * would sit in the non-running layer ordered by updatedAt and swap as events land. Same for background bash / detached subagents.
 * The spinner still follows phase only (isTaskListRowRunning); this decides the sorting layer alone.
 */
export function isTaskListRowActive(task: ZCodeTaskMeta): boolean {
  return isTaskListRowRunning(task) || getTaskListRowActivity(task)?.hasBackgroundWork === true;
}

export function getTaskListAttention(
  task: ZCodeTaskMeta,
): { kind: "permission" | "userInput"; count: number } | null {
  const summary = getTaskListRowActivity(task)?.pendingInteractions;
  if (!summary) {
    return null;
  }
  const count = summary.permissionCount + summary.userInputCount;
  if (count === 0) {
    return null;
  }
  return {
    kind: summary.userInputCount > 0 ? "userInput" : "permission",
    count,
  };
}

export function mergeTaskListMembershipFields(
  activityTask: ZCodeTaskMeta,
  membershipTask: ZCodeTaskMeta,
): ZCodeTaskMeta {
  const activity = getTaskListRowActivity(activityTask);
  if (!activity) {
    return membershipTask;
  }
  const membershipOwnsUnreadAt = Object.prototype.hasOwnProperty.call(membershipTask, "unreadAt");
  // tasks-index responses for rename/pin/archive/unread carry their own updatedAt/status,
  // but sidebar activity and the Updated order belong to sessions-index. A mutation may override membership/meta
  // fields only; never replace the row wholesale, or tasks without real activity jump the order or lose live phase.
  return attachTaskListRowActivity(
    {
      ...activityTask,
      ...membershipTask,
      createdAt: activityTask.createdAt,
      updatedAt: activity.lastActivityAt,
      status: activityTask.status,
      unreadAt: membershipOwnsUnreadAt ? membershipTask.unreadAt : activityTask.unreadAt,
    },
    activity,
  );
}
