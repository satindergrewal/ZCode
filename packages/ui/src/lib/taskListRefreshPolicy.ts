import type { ZCodeWorkspaceTaskListChanged } from "@zcode/shared";

export type TaskListMembershipWorkspaceEventReason =
  | "task_archived"
  | "task_unarchived"
  | "task_pinned"
  | "task_unpinned";

export type TaskMetaWorkspaceEventSyncMode = "insert-active" | "preserve-membership";

const TASK_META_INCREMENTAL_REASONS = new Set<ZCodeWorkspaceTaskListChanged["reason"]>([
  "user_message_saved",
  "assistant_message_saved",
  "task_status_changed",
  "task_meta_changed",
  // Bugfix: a model switch is a pure config change -- write back the meta delta (model field) only;
  // never a full refetch or membership re-pull. It used to ride task_meta_changed,
  // making every model switch re-pull membership and republish every sidebar list across workspaces.
  "task_model_changed",
  // Bugfix: title changes (first-message title/auto-title/rename) do not touch membership --
  // write the meta delta; no full refresh, no membership re-pull.
  "task_title_changed",
]);

const OPTIMISTIC_TASK_LIST_REASONS = new Set<ZCodeWorkspaceTaskListChanged["reason"]>([
  "task_meta_changed",
  "task_model_changed",
  "task_title_changed",
  "auto_archive",
]);

const TASK_LIST_MEMBERSHIP_REASONS = new Set<ZCodeWorkspaceTaskListChanged["reason"]>([
  "task_archived",
  "task_unarchived",
  "task_pinned",
  "task_unpinned",
]);

export function isTaskListMembershipWorkspaceEvent<
  T extends Pick<ZCodeWorkspaceTaskListChanged, "reason">,
>(
  event: T,
): event is T & {
  reason: TaskListMembershipWorkspaceEventReason;
} {
  return TASK_LIST_MEMBERSHIP_REASONS.has(event.reason);
}

export function isTaskListDeletionWorkspaceEvent(
  event: Pick<ZCodeWorkspaceTaskListChanged, "reason">,
): boolean {
  return event.reason === "task_deleted";
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

export function shouldRefreshTaskListForWorkspaceEvent(
  event: Pick<ZCodeWorkspaceTaskListChanged, "reason" | "taskId" | "taskMeta">,
): boolean {
  // Bugfix: send/stop/archive/meta saves already write back via the optimistic task cache / snapshot meta.
  // Treating realtime invalidations as full-refetch signals made sidebar tasks flash on each.
  // But message-save/state events carry only taskId/reason, and the remote observer has no local optimistic state --
  // keep the silent refresh for running/completed/error, or desktop lists never update after a phone send.
  if (getTaskMetaWorkspaceEventSyncMode(event)) {
    return false;
  }
  if (isTaskListMembershipWorkspaceEvent(event)) {
    // Bugfix: with taskMeta on membership events, infer the old slot from cache and move incrementally.
    // Full-refetch only as the fallback for legacy/abnormal broadcasts lacking meta.
    return !event.taskMeta;
  }
  if (isTaskListDeletionWorkspaceEvent(event)) {
    // Bugfix: deletes carry only a taskId -- collapsed/paged-hidden items' original lists are unknowable.
    // Callers skip early on visible-cache hits; otherwise re-derive total/hasMore from the server truth.
    return true;
  }

  return !OPTIMISTIC_TASK_LIST_REASONS.has(event.reason);
}

export function getTaskMetaWorkspaceEventSyncMode(
  event: Pick<ZCodeWorkspaceTaskListChanged, "reason" | "taskMeta">,
): TaskMetaWorkspaceEventSyncMode | null {
  if (!event.taskMeta) {
    return null;
  }
  if (event.reason === "task_created") {
    // Bugfix: tasks created from the phone on a shared host give the desktop renderer no optimistic insert.
    // task_created must insert into every matching query cache as an active-membership change, not just reorder existing rows.
    return "insert-active";
  }
  if (TASK_META_INCREMENTAL_REASONS.has(event.reason)) {
    return "preserve-membership";
  }
  return null;
}

export function shouldApplyTaskMetaFromWorkspaceEvent(
  event: Pick<ZCodeWorkspaceTaskListChanged, "reason" | "taskMeta">,
): event is Pick<ZCodeWorkspaceTaskListChanged, "reason"> & {
  taskMeta: NonNullable<ZCodeWorkspaceTaskListChanged["taskMeta"]>;
} {
  return Boolean(getTaskMetaWorkspaceEventSyncMode(event));
}
