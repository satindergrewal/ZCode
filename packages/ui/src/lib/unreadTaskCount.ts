import { getVisibleTaskMetas } from "@/store/zcodeSessionStoreSelectors.js";
import type { WorkspaceZCodeUIState } from "@/store/zcodeSessionStoreTypes.js";

type WorkspaceUnreadState = Pick<
  WorkspaceZCodeUIState,
  "optimisticTaskListByTaskId" | "taskListCache"
> &
  Partial<Pick<WorkspaceZCodeUIState, "taskUnreadByTaskId">>;

export function countAllUnreadTasks(workspaces: Record<string, WorkspaceUnreadState>): number {
  const countedTaskKeys = new Set<string>();
  const visitedWorkspaceStates = new WeakSet<object>();

  for (const [workspaceKey, workspace] of Object.entries(workspaces)) {
    if (visitedWorkspaceStates.has(workspace)) {
      continue;
    }
    visitedWorkspaceStates.add(workspace);
    // Unread state now keys off task meta.unreadAt alone.
    // The Dock badge must read the same metadata as the list dot, never the legacy temp map.
    const visibleTasks = getVisibleTaskMetas(workspace);
    for (const task of visibleTasks) {
      if (!task.unreadAt) {
        continue;
      }
      countedTaskKeys.add(
        `${task.workspaceIdentity?.trim() || task.workspacePath}::${task.taskId}`,
      );
    }

    if (visibleTasks.length > 0) {
      continue;
    }

    // A remote workspace keeps compat state under both path key and workspaceIdentity key.
    // Dedupe by workspaceKey + taskId, skipping identical references, so the window badge never counts one remote task twice.
    for (const taskId of Object.keys(workspace.taskUnreadByTaskId ?? {})) {
      countedTaskKeys.add(`${workspaceKey}::${taskId}`);
    }
  }

  return countedTaskKeys.size;
}
