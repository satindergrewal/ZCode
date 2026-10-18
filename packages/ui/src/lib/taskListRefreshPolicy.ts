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
  // Bugfix: 切模型是纯配置变更，只需按 meta 增量回写（model 字段），
  // 绝不能触发整表刷新或 membership 重拉——之前它混在 task_meta_changed 里，
  // 每次切模型都会让左侧所有列表（跨 workspace）重拉归属并整体重发布。
  "task_model_changed",
  // Bugfix: 标题变更（首条消息写 title/自动标题/手动重命名）与归属无关，
  // 按 meta 增量回写即可，不触发整表刷新或 membership 重拉。
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
  // Bugfix: 发送、停止、归档和元数据保存已经通过乐观 task cache / snapshot meta 增量写回。
  // 如果这里继续把 realtime invalidation 当成整表查询信号，左侧 task 会在这些操作时闪一下。
  // 但消息保存和状态变更事件只携带 taskId/reason，不携带最新 meta；远控 observer 没有本地乐观状态，
  // 必须保留静默刷新来同步 running/completed/error，否则手机端发送后桌面任务列表状态不会更新。
  if (getTaskMetaWorkspaceEventSyncMode(event)) {
    return false;
  }
  if (isTaskListMembershipWorkspaceEvent(event)) {
    // Bugfix: membership 事件带 taskMeta 时，UI 可以根据当前缓存位置推断旧 membership 并增量移动。
    // 只有旧版本/异常广播缺 meta 时才整表刷新兜底。
    return !event.taskMeta;
  }
  if (isTaskListDeletionWorkspaceEvent(event)) {
    // Bugfix: 删除事件通常只有 taskId，无法判断折叠/分页隐藏项原本属于 active/pinned/archived 哪些列表。
    // 调用方确认命中可见缓存时会提前跳过刷新；否则必须回到服务端事实源补齐 total/hasMore。
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
    // Bugfix: 手机 shared-host 创建 task 时，桌面 renderer 没有本地乐观插入。
    // task_created 必须作为 active 成员变更插入所有匹配 query cache，不能只重排已存在项。
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
