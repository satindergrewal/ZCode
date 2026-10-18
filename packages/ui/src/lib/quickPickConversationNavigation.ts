import type { ZCodeTaskMeta } from "@zcode/shared";
import type { CachedTaskListResult, TaskEntityKey } from "@/lib/taskQueryCache.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

interface QuickPickConversationNavigationState {
  canSelectPreviousConversation: boolean;
  canSelectNextConversation: boolean;
  previousTaskId: string | null;
  nextTaskId: string | null;
}

export function resolveQuickPickConversationNavigation(params: {
  taskIds: readonly string[];
  activeTaskId: string | null;
}): QuickPickConversationNavigationState {
  const taskIds = [...new Set(params.taskIds.filter((taskId) => taskId.length > 0))];
  const activeIndex = params.activeTaskId ? taskIds.indexOf(params.activeTaskId) : -1;
  const previousBaseIndex = activeIndex === -1 ? taskIds.length : activeIndex;
  const nextBaseIndex = activeIndex === -1 ? -1 : activeIndex;
  const previousTaskId = taskIds[previousBaseIndex - 1] ?? null;
  const nextTaskId = taskIds[nextBaseIndex + 1] ?? null;

  return {
    canSelectPreviousConversation: previousTaskId !== null,
    canSelectNextConversation: nextTaskId !== null,
    previousTaskId,
    nextTaskId,
  };
}

export function selectQuickPickConversationTaskIds(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  resultsByQueryKey: Record<string, CachedTaskListResult>;
  taskMetaByEntityKey: Record<TaskEntityKey, ZCodeTaskMeta>;
  fallbackTaskIds: readonly string[];
}): string[] {
  const workspaceKey = buildTaskWorkspaceKey(params.workspacePath, params.workspaceIdentity);
  const candidates = Object.values(params.resultsByQueryKey)
    .filter((result) => {
      const descriptor = result.descriptor;
      return (
        descriptor.kind === "workspace" &&
        descriptor.search === "" &&
        descriptor.workspaceKeys.length === 1 &&
        descriptor.workspaceKeys[0] === workspaceKey
      );
    })
    .sort((left, right) => {
      if (left.stale !== right.stale) {
        return Number(left.stale) - Number(right.stale);
      }
      if (left.descriptor.visibleLimit !== right.descriptor.visibleLimit) {
        return left.descriptor.visibleLimit === null ? -1 : 1;
      }
      return right.fetchedAt - left.fetchedAt;
    });

  for (const candidate of candidates) {
    const taskIds: string[] = [];
    for (const taskKey of candidate.taskKeys) {
      const task = params.taskMetaByEntityKey[taskKey];
      if (!task) {
        continue;
      }

      if (buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity) !== workspaceKey) {
        continue;
      }

      taskIds.push(task.taskId);
    }

    if (taskIds.length > 0) {
      return taskIds;
    }
  }

  // Quick-pick prev/next task used to read only zcodeSessionStore.taskListCache.
  // Since the list moved to the task query cache, the old cache can be empty or stale-ordered;
  // use it only as a fallback until the new cache arrives.
  return [...params.fallbackTaskIds];
}
