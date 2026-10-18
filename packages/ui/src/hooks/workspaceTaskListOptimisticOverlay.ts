import { useMemo } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { buildTaskEntityKey, buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { mergeTaskWithOptimisticMeta } from "@/lib/zcodeTaskMetaMerge.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { GroupedDraftTaskState } from "@/store/zcodeSessionStoreTypes.js";
import { mergeTaskListMembershipFields } from "@/v4/taskListRowActivity.js";

export interface WorkspaceOptimisticTaskOverlay {
  activeTaskId: string | null;
  tasks: ZCodeTaskMeta[];
  promotedGroupedDraftTaskByTaskId: Record<string, GroupedDraftTaskState>;
}

type WorkspaceTaskListSortBy = "created" | "updated";

interface WorkspaceOptimisticScope {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
}

export function mergeWorkspaceTaskListItemsWithOptimistic(params: {
  items: readonly ZCodeTaskMeta[];
  optimisticTasks: readonly ZCodeTaskMeta[];
  activeTaskId: string | null;
  sortBy: WorkspaceTaskListSortBy;
  visibleLimit: number | null;
}): ZCodeTaskMeta[] {
  const taskByKey = new Map(params.items.map((task) => [buildTaskEntityKey(task), task] as const));

  for (const optimisticTask of params.optimisticTasks) {
    const taskKey = buildTaskEntityKey(optimisticTask);
    const existingTask = taskByKey.get(taskKey);
    if (!existingTask && optimisticTask.taskId !== params.activeTaskId) {
      continue;
    }

    // The workspace task list's server query may return after the first optimistic write.
    // Trusting stale query-cache meta would show the new task on top, then push it back
    // down via old updatedAt/title. Merge optimistic meta back only for already-visible
    // tasks and the active task, preserving true list membership boundaries.
    taskByKey.set(
      taskKey,
      existingTask
        ? mergeTaskListMembershipFields(existingTask, {
            ...mergeTaskWithOptimisticMeta(existingTask, optimisticTask),
            // unreadAt is a query-cache membership field; legacy optimistic tasks written
            // by context menus exist only for old consumers and must not overwrite the
            // query field overlay, or the read overlay and its failure rollback get
            // clobbered by stale values.
            unreadAt: existingTask.unreadAt,
          })
        : optimisticTask,
    );
  }

  const sortedItems = [...taskByKey.values()].sort((left, right) =>
    compareZCodeTaskListItems(left, right, params.sortBy),
  );
  return params.visibleLimit === null ? sortedItems : sortedItems.slice(0, params.visibleLimit);
}

export function useWorkspaceTaskOptimisticOverlayByWorkspaceKey(
  workspaceTabs: WorkspaceTabState[],
): Map<string, WorkspaceOptimisticTaskOverlay> {
  const workspaceScopeSignature = JSON.stringify(
    workspaceTabs
      .map((tab) => ({
        workspacePath: tab.workspacePath,
        workspaceIdentity: tab.workspaceIdentity,
        workspaceKey: buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity),
      }))
      .sort((left, right) => left.workspaceKey.localeCompare(right.workspaceKey)),
  );
  const workspaceScopes = useMemo(
    () => JSON.parse(workspaceScopeSignature) as WorkspaceOptimisticScope[],
    [workspaceScopeSignature],
  );
  const optimisticTaskListSignature = useZCodeSessionStore((state) =>
    JSON.stringify(
      workspaceScopes.map((scope) => {
        const workspaceState = selectWorkspaceZCodeState(
          state,
          scope.workspacePath,
          scope.workspaceIdentity,
        );
        return [
          scope.workspaceKey,
          workspaceState.activeTaskId,
          Object.values(workspaceState.optimisticTaskListByTaskId)
            .map((task) => {
              const promotedDraft = workspaceState.promotedGroupedDraftTaskByTaskId[task.taskId];
              return [
                task.taskId,
                task.title,
                task.createdAt,
                task.updatedAt,
                task.status,
                task.unreadAt,
                task.provider,
                task.model,
                promotedDraft?.createdAt,
                promotedDraft?.placement.type,
                promotedDraft?.placement.type === "group" ? promotedDraft.placement.groupId : null,
              ];
            })
            .sort(([leftTaskId], [rightTaskId]) =>
              String(leftTaskId).localeCompare(String(rightTaskId)),
            ),
        ] as const;
      }),
    ),
  );

  return useMemo(() => {
    const state = useZCodeSessionStore.getState();
    return new Map<string, WorkspaceOptimisticTaskOverlay>(
      workspaceScopes.map((scope) => {
        const workspaceState = selectWorkspaceZCodeState(
          state,
          scope.workspacePath,
          scope.workspaceIdentity,
        );
        return [
          scope.workspaceKey,
          {
            activeTaskId: workspaceState.activeTaskId,
            tasks: Object.values(workspaceState.optimisticTaskListByTaskId),
            promotedGroupedDraftTaskByTaskId: workspaceState.promotedGroupedDraftTaskByTaskId,
          },
        ];
      }),
    );
  }, [optimisticTaskListSignature, workspaceScopes]);
}
