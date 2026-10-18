import type { ZCodeProvider } from "@zcode/shared";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type { WorkspaceZCodeUIState } from "@/store/zcodeSessionStoreTypes.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";

export function resolveChatViewActiveTaskProvider(
  taskId: string | null,
  workspaceState: Pick<
    WorkspaceZCodeUIState,
    "selectedProvider" | "taskListCache" | "optimisticTaskListByTaskId"
  >,
): ZCodeProvider {
  if (!taskId) {
    return workspaceState.selectedProvider;
  }

  // The composer $/ skill list and / panel used to read only the workspace-selected provider.
  // Switching to a history task, forking, or a transient mismatch between the task provider and the workspace default
  // mixed in other agents' skills, and even the pre-send available_skills injection went wrong.
  // Read the current task own provider first, making the task on screen the single truth.
  // Also, after a successful agent switch the old provider in taskListCache may refresh a beat late;
  // the optimistic meta is the freshest confirmed result, so consume it first and the icon switches instantly.
  return (
    workspaceState.optimisticTaskListByTaskId[taskId]?.provider ??
    workspaceState.taskListCache?.find((task) => task.taskId === taskId)?.provider ??
    workspaceState.selectedProvider
  );
}

export function useChatViewActiveTaskProvider(
  taskId: string | null,
  workspacePath: string,
  workspaceIdentity?: string,
) {
  const activeTabWorkspaceIdentity = useTabStore((state) => {
    if (!state.activeTabId) {
      return undefined;
    }

    const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!activeTab || !isWorkspaceTab(activeTab) || activeTab.workspacePath !== workspacePath) {
      return undefined;
    }

    return activeTab.workspaceIdentity;
  });
  const resolvedWorkspaceIdentity = workspaceIdentity ?? activeTabWorkspaceIdentity;

  return useZCodeSessionStore((state) => {
    const workspaceState = selectWorkspaceZCodeState(
      state,
      workspacePath,
      resolvedWorkspaceIdentity,
    );

    return resolveChatViewActiveTaskProvider(taskId, workspaceState);
  });
}
