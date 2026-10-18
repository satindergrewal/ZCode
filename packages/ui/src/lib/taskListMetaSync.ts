import type { InputId, ZCodeProvider, ZCodeTaskMeta } from "@zcode/shared";
import {
  getTaskMeta,
  resolveWorkspaceStateKey,
  useZCodeSessionStore,
} from "@/store/zcodeSessionStore.js";
import { mergeTaskMetaCandidates, mergeTaskWithOptimisticMeta } from "@/lib/zcodeTaskMetaMerge.js";
import {
  applyTaskQueryCacheMutation,
  removeTaskFromTaskQueryCaches,
  updateTaskQueryCacheTaskMetaPreservingMembership,
  upsertTaskQueryCacheTaskMeta,
  useTaskQueryCacheStore,
  type TaskListMembershipState,
} from "@/store/taskQueryCacheStore.js";
import { buildTaskEntityKey, buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

const ABSENT_MEMBERSHIP: TaskListMembershipState = {
  pinned: true,
  archived: true,
};

function inferTaskMembershipFromQueryCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}): TaskListMembershipState | null {
  const entityKey = buildTaskEntityKey(params);
  const workspaceKey = buildTaskWorkspaceKey(params.workspacePath, params.workspaceIdentity);
  const { resultsByQueryKey } = useTaskQueryCacheStore.getState();
  let foundActive = false;
  let foundPinned = false;

  for (const result of Object.values(resultsByQueryKey)) {
    if (!result.taskKeys.includes(entityKey)) {
      continue;
    }
    if (!result.descriptor.workspaceKeys.includes(workspaceKey)) {
      continue;
    }
    if (result.descriptor.kind === "archived") {
      return { pinned: false, archived: true };
    }
    if (result.descriptor.kind === "pinned") {
      foundPinned = true;
      continue;
    }
    if (
      result.descriptor.kind === "workspace" ||
      result.descriptor.kind === "timeline" ||
      // Bugfix: active is the canonical list used by search/Command Center.
      // Missing it infers active-only visible tasks as absent, skewing totals on pin/archive.
      result.descriptor.kind === "active"
    ) {
      foundActive = true;
    }
  }

  if (foundPinned) {
    return { pinned: true, archived: false };
  }
  if (foundActive) {
    return { pinned: false, archived: false };
  }

  return null;
}

function membershipForWorkspaceEventReason(
  reason: "task_archived" | "task_unarchived" | "task_pinned" | "task_unpinned",
): TaskListMembershipState {
  switch (reason) {
    case "task_archived":
      return { pinned: false, archived: true };
    case "task_pinned":
      return { pinned: true, archived: false };
    case "task_unarchived":
    case "task_unpinned":
      return { pinned: false, archived: false };
  }
}

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

export function syncTaskMembershipEventToTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  task: ZCodeTaskMeta;
  reason: "task_archived" | "task_unarchived" | "task_pinned" | "task_unpinned";
}): void {
  const previousMembership =
    inferTaskMembershipFromQueryCaches({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      taskId: params.task.taskId,
    }) ?? ABSENT_MEMBERSHIP;
  const nextMembership = membershipForWorkspaceEventReason(params.reason);

  // Bugfix: archive/pin from remote or another window leaves no local optimistic mutation here.
  // Whole-cache invalidation flickered lists; infer the old slot from cache and move incrementally.
  syncTaskMetaToTaskCaches({
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
    task: params.task,
    membership: nextMembership,
    applyQueryCacheMutation: false,
  });
  applyTaskQueryCacheMutation({
    previousTask: params.task,
    nextTask: params.task,
    previousState: previousMembership,
    nextState: nextMembership,
  });
}

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

export function patchTaskMetaInTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  patch: (task: ZCodeTaskMeta) => Partial<ZCodeTaskMeta>;
}): ZCodeTaskMeta | null {
  const store = useZCodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(params.workspacePath, params.workspaceIdentity);
  const identityWorkspaceState = params.workspaceIdentity
    ? store.workspaces[resolveWorkspaceStateKey(params.workspacePath, params.workspaceIdentity)]
    : undefined;
  const taskCacheState = identityWorkspaceState ?? workspaceState;
  const currentTask =
    getTaskMeta(workspaceState, params.taskId) ??
    (identityWorkspaceState ? getTaskMeta(identityWorkspaceState, params.taskId) : null);
  if (!currentTask) {
    return null;
  }

  const patch = params.patch(currentTask);
  const shouldPreserveManualTitle =
    currentTask.titleOverridden === true &&
    patch.title !== undefined &&
    patch.title !== currentTask.title &&
    patch.titleOverridden !== false;
  const patchedTask = {
    ...currentTask,
    ...patch,
    // Bugfix: after a manual rename, in-flight session_info_update can still return the auto title.
    // Such patches refresh runtime fields only, never briefly washing out a titleOverridden name.
    title: shouldPreserveManualTitle ? currentTask.title : (patch.title ?? currentTask.title),
    titleOverridden: patch.titleOverridden ?? currentTask.titleOverridden,
  };
  // Bugfix: session_info_update/snapshot patches may add runtime state but carry a New-session placeholder title.
  // Re-merge with current meta after the patch: keep status/target/updatedAt, keep placeholders out of task/query caches.
  const nextTask = mergeTaskWithOptimisticMeta(patchedTask, currentTask);

  store.upsertOptimisticTaskListItem(params.workspacePath, nextTask, params.workspaceIdentity);
  if (taskCacheState.taskListCache) {
    store.setTaskListCache(
      params.workspacePath,
      taskCacheState.taskListCache.map((task) => (task.taskId === params.taskId ? nextTask : task)),
      params.workspaceIdentity,
    );
  }
  // Bugfix: returning from chat on mobile, run start patches only status/updatedAt of that task.
  // Without a re-sort, the update-ordered remote home keeps the stale order.
  updateTaskQueryCacheTaskMetaPreservingMembership(nextTask);

  return nextTask;
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

export function initializeBackgroundTaskInTaskCaches(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  task: ZCodeTaskMeta;
  provider: ZCodeProvider;
  activeInputId: InputId;
}): void {
  const store = useZCodeSessionStore.getState();
  const workspaceState = store.getWorkspaceState(params.workspacePath, params.workspaceIdentity);
  const previousTask = getTaskMeta(workspaceState, params.task.taskId);
  const task = previousTask ? mergeTaskWithOptimisticMeta(params.task, previousTask) : params.task;

  store.initializeBackgroundTaskRuntime(params.workspacePath, {
    workspaceIdentity: params.workspaceIdentity,
    task,
    provider: params.provider,
    activeInputId: params.activeInputId,
  });
  upsertTaskQueryCacheTaskMeta(task);
  // Fix: background first-sends no longer write optimistic-then-insert; the query cache still needs the
  // absent->active membership insert so sidebar totals/show-more match normal first sends.
  applyTaskQueryCacheMutation({
    previousTask: previousTask ?? task,
    nextTask: task,
    previousState: ABSENT_MEMBERSHIP,
    nextState: { pinned: false, archived: false },
  });
}
