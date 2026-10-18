// Left-list projection: tasks-index owns the persistent row set and membership; sessions-index only adds live activity/detail.
// Kept pure so Project/Timeline/Pinned/Archived/Grouped share one field authority.
import type { ZCodeTaskMeta } from "@zcode/shared";
import { matchesTaskListMembershipKind } from "@zcode/shared/zcode-protocol-v4";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { attachTaskListRowActivity, getTaskListRowActivity } from "@/v4/taskListRowActivity.js";

export type TaskListKind = "pinned" | "archived" | "timeline" | "active";
export type TaskListSortBy = "created" | "updated";

export interface BuildTaskListParams {
  /** Union of task rows across the three persistent tasks-index partitions: active/pinned/archived. */
  taskIndexItems: ZCodeTaskMeta[];
  /** Session activity/detail derived from sessions-index; covers matched persistent rows only. */
  sessions: ZCodeTaskMeta[];
  kind: TaskListKind;
  /** Server-authoritative pin/archive id set (persisted in tasks-index.sqlite). */
  pinnedIds: ReadonlySet<string>;
  archivedIds: ReadonlySet<string>;
  /** tasks-index permanent-delete tombstone; once hit, the id belongs to no list kind. */
  deletedIds?: ReadonlySet<string>;
  search?: string;
  sortBy: TaskListSortBy;
  /** Collapse limit; undefined = all (expanded). */
  limit?: number;
  /**
   * taskId -> unreadAt (tasks-index organization state, fetched alongside pin/archive).
   * The sessions-index schema is frozen without unread; joined into meta at list-build time.
   */
  unreadAtByTaskId?: ReadonlyMap<string, number>;
  /** taskId -> terminal status (tasks-index historical terminal state; backs cold-start stored summary only). */
  terminalStatusByTaskId?: ReadonlyMap<
    string,
    Extract<ZCodeTaskMeta["status"], "completed" | "error">
  >;
  /** taskId -> legacy task-index manual title; covers session meta with titleOverridden !== true only. */
  titleOverrideByTaskId?: ReadonlyMap<string, string>;
  /** taskId -> cronAutomationId (tasks-index metadata; absent from SessionSummary). */
  cronAutomationIdByTaskId?: ReadonlyMap<string, string>;
}

export interface BuildTaskListResult {
  items: ZCodeTaskMeta[];
  total: number;
}

function mergeTaskIndexRowWithSession(
  taskIndexTask: ZCodeTaskMeta,
  sessionTask: ZCodeTaskMeta,
): ZCodeTaskMeta {
  const activity = getTaskListRowActivity(sessionTask);
  const sessionTitle = sessionTask.title.trim();
  const sessionTitleWins =
    sessionTitle.length > 0 &&
    (sessionTask.titleOverridden === true || taskIndexTask.titleOverridden !== true);
  const titleOverridden =
    sessionTask.titleOverridden === true || taskIndexTask.titleOverridden === true
      ? true
      : undefined;
  const merged: ZCodeTaskMeta = {
    ...taskIndexTask,
    title: sessionTitleWins ? sessionTask.title : taskIndexTask.title,
    titleOverridden,
    // Session activity is the live authority for created/active times and terminal state; the task row only backs up when summary is missing.
    createdAt: sessionTask.createdAt || taskIndexTask.createdAt,
    updatedAt: (activity?.lastActivityAt ?? sessionTask.updatedAt) || taskIndexTask.updatedAt,
    status: sessionTask.status ?? taskIndexTask.status,
    forkedFromTaskId: sessionTask.forkedFromTaskId ?? taskIndexTask.forkedFromTaskId,
    // Pending interaction belongs to the current session projection; when summary arrived but the field is empty, stale persisted values must go.
    pendingInteraction: sessionTask.pendingInteraction,
  };
  return activity ? attachTaskListRowActivity(merged, activity) : merged;
}

/**
 * Field-level join with tasks-index rows as the left table. Keeps the original task reference when summary is missing; session-only cold
 * summaries never enter persistent lists; the new-task short window is handled by the existing optimistic/live overlay.
 */
export function mergeTaskIndexRowsWithSessions(params: {
  taskIndexItems: ZCodeTaskMeta[];
  sessions: ZCodeTaskMeta[];
}): ZCodeTaskMeta[] {
  const sessionByEntityKey = new Map(
    params.sessions.map((session) => [buildTaskEntityKey(session), session]),
  );
  return params.taskIndexItems.map((task) => {
    const session = sessionByEntityKey.get(buildTaskEntityKey(task));
    return session ? mergeTaskIndexRowWithSession(task, session) : task;
  });
}

/** unreadAt join: tasks-index wins once its map is loaded; before that, leave meta untouched, avoiding first-frame flicker. */
export function joinTaskListUnreadAt(
  tasks: ZCodeTaskMeta[],
  unreadAtByTaskId: ReadonlyMap<string, number> | undefined,
): ZCodeTaskMeta[] {
  return joinTaskListMembershipMeta(tasks, { unreadAtByTaskId });
}

export function joinTaskListMembershipMeta(
  tasks: ZCodeTaskMeta[],
  params: {
    unreadAtByTaskId?: ReadonlyMap<string, number>;
    terminalStatusByTaskId?: ReadonlyMap<
      string,
      Extract<ZCodeTaskMeta["status"], "completed" | "error">
    >;
    titleOverrideByTaskId?: ReadonlyMap<string, string>;
    cronAutomationIdByTaskId?: ReadonlyMap<string, string>;
  },
): ZCodeTaskMeta[] {
  const {
    unreadAtByTaskId,
    terminalStatusByTaskId,
    titleOverrideByTaskId,
    cronAutomationIdByTaskId,
  } = params;
  if (
    unreadAtByTaskId === undefined &&
    (!terminalStatusByTaskId || terminalStatusByTaskId.size === 0) &&
    (!titleOverrideByTaskId || titleOverrideByTaskId.size === 0) &&
    (!cronAutomationIdByTaskId || cronAutomationIdByTaskId.size === 0)
  ) {
    return tasks;
  }
  return tasks.map((task) => {
    const activity = getTaskListRowActivity(task);
    const unreadAt = unreadAtByTaskId?.get(task.taskId);
    const terminalStatus = terminalStatusByTaskId?.get(task.taskId);
    const titleOverride =
      task.titleOverridden === true ? undefined : titleOverrideByTaskId?.get(task.taskId);
    const cronAutomationId = cronAutomationIdByTaskId?.get(task.taskId);
    const shouldUpdateUnread =
      unreadAtByTaskId !== undefined &&
      (unreadAt !== task.unreadAt || (unreadAt === undefined && task.unreadAt !== undefined));
    // v4 cold-start stored summaries may lack the activity sidecar; historical terminal status can only be
    // filled from tasks-index. Once sessions-index has projected activity, all live terminal states
    // belong to it and must not be overwritten back by stale tasks-index error/completed.
    const shouldUpdateStatus =
      activity === null &&
      terminalStatus !== undefined &&
      (task.status === undefined || (terminalStatus === "error" && task.status === "completed"));
    const shouldUpdateTitle =
      titleOverride !== undefined &&
      (task.title !== titleOverride || task.titleOverridden !== true);
    const shouldUpdateCronAutomationId =
      cronAutomationId !== undefined && cronAutomationId !== task.cronAutomationId;
    if (
      !shouldUpdateUnread &&
      !shouldUpdateStatus &&
      !shouldUpdateTitle &&
      !shouldUpdateCronAutomationId
    ) {
      return task;
    }
    return {
      ...task,
      ...(shouldUpdateUnread ? { unreadAt } : {}),
      ...(shouldUpdateStatus ? { status: terminalStatus } : {}),
      ...(shouldUpdateTitle ? { title: titleOverride, titleOverridden: true } : {}),
      // The frozen sessions-index summary carries no cron identity; join it back from tasks-index,
      // or a DB-marked scheduled task still fails isCronTask in the meta handed to React.
      ...(shouldUpdateCronAutomationId ? { cronAutomationId } : {}),
    };
  });
}

/** Client-side filter/sort/pagination, producing { items, total } shaped like the legacy listTaskList. */
export function buildTaskListResult(params: BuildTaskListParams): BuildTaskListResult {
  const query = params.search?.trim().toLocaleLowerCase() ?? "";
  const rows = mergeTaskIndexRowsWithSessions({
    taskIndexItems: params.taskIndexItems,
    sessions: params.sessions,
  });
  const tasks = joinTaskListMembershipMeta(rows, {
    unreadAtByTaskId: params.unreadAtByTaskId,
    terminalStatusByTaskId: params.terminalStatusByTaskId,
    titleOverrideByTaskId: params.titleOverrideByTaskId,
    cronAutomationIdByTaskId: params.cronAutomationIdByTaskId,
  });
  const filtered = tasks.filter((task) => {
    // The CLI session store is not physically cleaned on archive-list permanent delete; without applying the
    // deleted negative membership first, cold-start sessions-index would revive it as a non-archived regular task.
    if (params.deletedIds?.has(task.taskId)) return false;
    const pinned = params.pinnedIds.has(task.taskId);
    const archived = params.archivedIds.has(task.taskId);
    if (!matchesTaskListMembershipKind({ pinned, archived }, params.kind)) return false;
    if (query && !task.title.toLocaleLowerCase().includes(query)) return false;
    return true;
  });
  filtered.sort((a, b) => compareZCodeTaskListItems(a, b, params.sortBy));
  const total = filtered.length;
  const items = params.limit === undefined ? filtered : filtered.slice(0, params.limit);
  return { items, total };
}
