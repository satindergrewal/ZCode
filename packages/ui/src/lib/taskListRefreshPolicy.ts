import type { ZCodeWorkspaceTaskListChanged } from "@zcode/shared";

type TaskListMembershipWorkspaceEventReason =
  | "task_archived"
  | "task_unarchived"
  | "task_pinned"
  | "task_unpinned";

const TASK_LIST_MEMBERSHIP_REASONS = new Set<ZCodeWorkspaceTaskListChanged["reason"]>([
  "task_archived",
  "task_unarchived",
  "task_pinned",
  "task_unpinned",
]);

function isTaskListMembershipWorkspaceEvent<
  T extends Pick<ZCodeWorkspaceTaskListChanged, "reason">,
>(
  event: T,
): event is T & {
  reason: TaskListMembershipWorkspaceEventReason;
} {
  return TASK_LIST_MEMBERSHIP_REASONS.has(event.reason);
}

/**
 * The sidebar treats tasks-index rows and pin/archive/unread membership as authoritative; sessions-index
 * only supplements detail, re-fetched driven by membershipVersion. unread (setTaskUnread) and rename
 * travel via task_meta_changed; sessions-index carries no unread, so task_meta_changed is also a
 * membership-refetch signal (low frequency).
 * task_created grows the positive row set of tasks-index and must be read after the task row/grouped
 * order generation flips; relying only on sessions-index detail or legacy query-cache incremental inserts is not enough.
 * task_model_changed (model switch) is unrelated to membership and explicitly excluded -- it used to
 * ride inside task_meta_changed, so one model switch bumped membershipVersion globally and refetched every list.
 */
export function shouldRefetchTaskListMembershipForWorkspaceEvent(
  event: Pick<ZCodeWorkspaceTaskListChanged, "reason">,
): boolean {
  // After delete, sessions-index may keep publishing the session retained in the CLI store;
  // task_deleted must flip the deleted-tombstone join generation, not just remove from the query cache once.
  return (
    isTaskListMembershipWorkspaceEvent(event) ||
    // With tasks-index rows authoritative in the sidebar, task_created is no longer just a session meta event.
    // Without flipping the membership/task-row generation, the new row lands in SQLite but Project keeps the old set.
    event.reason === "task_created" ||
    event.reason === "task_meta_changed" ||
    event.reason === "task_deleted"
  );
}
