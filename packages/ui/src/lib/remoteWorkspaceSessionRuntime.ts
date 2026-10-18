import type { ZCodeTaskRuntimeStatus } from "@zcode/shared";
import { getWorkspaceDisplayedTaskState } from "@/store/zcodeSessionStore.js";
import type { ZCodeSessionStoreState, WorkspaceZCodeUIState } from "@/store/zcodeSessionStore.js";

interface RemoteWorkspaceRuntimeTab {
  workspacePath: string;
  workspaceIdentity?: string;
}

interface MarkRemoteWorkspaceRunningTasksFailedParams {
  tabs: RemoteWorkspaceRuntimeTab[];
  getWorkspaceState: ZCodeSessionStoreState["getWorkspaceState"];
  setTaskRuntimeState: ZCodeSessionStoreState["setTaskRuntimeState"];
  reason: string;
}

function isRunningRuntimeStatus(status: ZCodeTaskRuntimeStatus): boolean {
  return status === "creating" || status === "restoring" || status === "streaming";
}

function shouldTreatPersistedRunningTaskAsRunning(
  workspaceState: WorkspaceZCodeUIState,
  taskId: string,
): boolean {
  const runtimeState = workspaceState.taskRuntimeByTaskId[taskId];
  if (!runtimeState) {
    return true;
  }

  // The task meta cache can refresh later than the stream terminal event and linger on running.
  // Once local runtime has a definitive non-running state, disconnect finalization must not overwrite it with failed via stale meta.
  return isRunningRuntimeStatus(runtimeState.status);
}

function collectRemoteWorkspaceRunningTaskIds(workspaceState: WorkspaceZCodeUIState): string[] {
  const taskIds = new Set<string>();

  if (
    workspaceState.activeTaskId &&
    isRunningRuntimeStatus(getWorkspaceDisplayedTaskState(workspaceState).taskStatus)
  ) {
    taskIds.add(workspaceState.activeTaskId);
  }

  for (const [taskId, runtimeState] of Object.entries(workspaceState.taskRuntimeByTaskId)) {
    if (isRunningRuntimeStatus(runtimeState.status)) {
      taskIds.add(taskId);
    }
  }

  for (const task of workspaceState.taskListCache ?? []) {
    if (
      task.status === "running" &&
      shouldTreatPersistedRunningTaskAsRunning(workspaceState, task.taskId)
    ) {
      taskIds.add(task.taskId);
    }
  }

  for (const task of Object.values(workspaceState.optimisticTaskListByTaskId)) {
    if (
      task.status === "running" &&
      shouldTreatPersistedRunningTaskAsRunning(workspaceState, task.taskId)
    ) {
      taskIds.add(task.taskId);
    }
  }

  return [...taskIds];
}

export function markRemoteWorkspaceRunningTasksFailed({
  tabs,
  getWorkspaceState,
  setTaskRuntimeState,
  reason,
}: MarkRemoteWorkspaceRunningTasksFailedParams): number {
  const markedTaskKeys = new Set<string>();

  for (const tab of tabs) {
    const workspaceState = getWorkspaceState(tab.workspacePath, tab.workspaceIdentity);
    const workspaceKey = tab.workspaceIdentity?.trim() || tab.workspacePath;

    for (const taskId of collectRemoteWorkspaceRunningTaskIds(workspaceState)) {
      const taskKey = `${workspaceKey}\0${taskId}`;
      if (markedTaskKeys.has(taskKey)) {
        continue;
      }

      markedTaskKeys.add(taskKey);
      // On SSH half-open disconnect the remote task_error may never reach the renderer;
      // only clearing remoteSessionId would leave the task list showing running/streaming loading.
      // Finalize the local UI runtime only, never the remote snapshot; reconnection trusts remote state.
      setTaskRuntimeState(tab.workspacePath, taskId, "failed", reason, tab.workspaceIdentity);
    }
  }

  return markedTaskKeys.size;
}
