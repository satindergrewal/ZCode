import type { ZCodeTaskMeta } from "@zcode/shared";
import { mergeTaskMetaCandidates } from "@/lib/zcodeTaskMetaMerge.js";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";
import { getTaskMeta, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  applyTaskQueryCacheMutation,
  removeTaskFromTaskQueryCaches,
  updateTaskQueryCacheTaskMetaPreservingMembership,
  upsertTaskQueryCacheTaskMeta,
  useTaskQueryCacheStore,
  type TaskListMembershipState,
} from "@/store/taskQueryCacheStore.js";

export function removeTaskFromTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}): boolean {
  const store = useZCodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(params.workspacePath, params.workspaceIdentity);
  if (workspaceState.taskListCache) {
    store.setTaskListCache(
      params.workspacePath,
      workspaceState.taskListCache.filter((task) => task.taskId !== params.taskId),
      params.workspaceIdentity,
    );
  }
  store.removeTaskState(params.workspacePath, params.taskId, params.workspaceIdentity);
  return removeTaskFromTaskQueryCaches(params);
}

const ABSENT_MEMBERSHIP: TaskListMembershipState = {
  pinned: true,
  archived: true,
};

function sortTasksByUpdatedAt(tasks: readonly ZCodeTaskMeta[]): ZCodeTaskMeta[] {
  return [...tasks].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    return right.taskId.localeCompare(left.taskId);
  });
}

export function syncTaskMetaToTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  task: ZCodeTaskMeta;
  membership?: TaskListMembershipState;
  forceInsertMembership?: boolean;
  ensureInWorkspaceTaskCache?: boolean;
  preserveListMembership?: boolean;
  applyQueryCacheMutation?: boolean;
}): void {
  const store = useZCodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(params.workspacePath, params.workspaceIdentity);
  const previousTask = getTaskMeta(workspaceState, params.task.taskId);
  const queryTask =
    useTaskQueryCacheStore.getState().taskMetaByEntityKey[
      buildTaskEntityKey({
        taskId: params.task.taskId,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity ?? params.task.workspaceIdentity,
      })
    ];
  // Bugfix: the session/readSession snapshot's updatedAt can lag the optimistic time written on first prompt.
  // Snapshot sync must monotonically merge with existing local task meta, or new tasks jump back down after the sqlite refresh.
  // Bugfix: on restart recovery the workspace store may not have the task yet while the query cache already holds sqlite-indexed meta.
  // Raw session snapshots lack titleOverridden; merge it too or a manual rename gets reverted in the renderer.
  const task = mergeTaskMetaCandidates(params.task, previousTask, queryTask) ?? params.task;
  const cachedTasks = workspaceState.taskListCache ?? [];
  const hasCachedTask = cachedTasks.some((cachedTask) => cachedTask.taskId === task.taskId);
  const shouldExistInWorkspaceTaskCache =
    params.membership?.pinned === false && params.membership.archived === false;
  const nextCachedTasks = params.preserveListMembership
    ? cachedTasks.map((cachedTask) => (cachedTask.taskId === task.taskId ? task : cachedTask))
    : shouldExistInWorkspaceTaskCache
      ? sortTasksByUpdatedAt([
          task,
          ...cachedTasks.filter((cachedTask) => cachedTask.taskId !== task.taskId),
        ])
      : cachedTasks.filter((cachedTask) => cachedTask.taskId !== task.taskId);

  // Bugfix: terminal/rollback ops used to bump the whole taskListVersion just to pull the latest
  // snapshot.meta back into the list. Write back per task into taskListCache instead of re-querying every list.
  if (
    workspaceState.taskListCache !== null &&
    ((params.preserveListMembership && hasCachedTask) ||
      params.ensureInWorkspaceTaskCache ||
      hasCachedTask ||
      !shouldExistInWorkspaceTaskCache)
  ) {
    store.setTaskListCache(params.workspacePath, nextCachedTasks, params.workspaceIdentity);
  }

  // Bugfix: header / current-session info prefers optimistic meta over the stale cache.
  // Patching only the query cache here would leave the active task on a stale title/summary.
  store.upsertOptimisticTaskListItem(params.workspacePath, task, params.workspaceIdentity);
  upsertTaskQueryCacheTaskMeta(task);

  if (params.preserveListMembership) {
    updateTaskQueryCacheTaskMetaPreservingMembership(task);
  } else if (params.membership && params.applyQueryCacheMutation !== false) {
    // Bugfix: when the phone creates a task on the shared host, the desktop renderer only sees the
    // workspace event, never the local first-send insertTaskIntoTaskCaches. With previousTask
    // missing, still insert under the active membership or the remote home screen keeps the stale order.
    // Bugfix: local first-send writes optimistic meta, then inserts list membership; previousTask
    // then exists but only means "has metadata", not "counted in the list total". A new task must be
    // treated as absent -> active, or the 6th workspace task keeps total at 5 and Show more never appears.
    applyTaskQueryCacheMutation({
      previousTask: previousTask ?? task,
      nextTask: task,
      previousState:
        previousTask && !params.forceInsertMembership ? params.membership : ABSENT_MEMBERSHIP,
      nextState: params.membership,
    });
  }
}

export function insertTaskIntoTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  task: ZCodeTaskMeta;
  membership: TaskListMembershipState;
}): void {
  // Bugfix: create/fork/remote shared-host task creation must all flow through one absent -> present membership change.
  // syncTaskMetaToTaskCaches already inserts with ABSENT_MEMBERSHIP when previousTask is missing;
  // applying the mutation twice here would double-increment total.
  syncTaskMetaToTaskCaches({
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    task: params.task,
    membership: params.membership,
    forceInsertMembership: true,
    ensureInWorkspaceTaskCache:
      params.membership.pinned === false && params.membership.archived === false,
  });
}
