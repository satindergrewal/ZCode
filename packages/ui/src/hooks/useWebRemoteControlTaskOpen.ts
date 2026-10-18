import { useCallback, useMemo, useState } from "react";
import type {
  WebRemoteControlMobileNavigationIntent,
  WebRemoteControlTaskTarget,
} from "@zcode/shared";
import { resolveWebRemoteControlWorkspaceKey } from "@zcode/shared";
import { logger } from "@/logger.js";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";

export function buildWebRemoteControlTaskRowKey(task: WebRemoteControlTaskTarget): string {
  return `${resolveWebRemoteControlWorkspaceKey(task)}:${task.taskId}`;
}

interface OpenWebRemoteControlTaskOptions {
  switcher: WebRemoteControlWorkspaceSwitcherApi;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  task: WebRemoteControlTaskTarget;
  markTaskReadOnOpen?: boolean;
  mobileNavigationIntent?: WebRemoteControlMobileNavigationIntent;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  onNavigateToChat?: () => void;
  onTaskOpen?: (options: { crossWorkspace: boolean }) => void;
  onSwitchingChange?: (switching: boolean) => void;
  onNavigateHome?: () => void;
  setSwitchingTaskKey?: (taskKey: string | null) => void;
  setError?: (error: string | null) => void;
}

function isDisconnectedRemoteWorkspaceBridgeError(message: string): boolean {
  // Match the desktop main copy verbatim (webRemoteControlManager): keep fragments stable.
  return (
    message.includes("remote workspace is not connected") ||
    message.includes("reconnect before creating a bridge")
  );
}

export async function openWebRemoteControlTask({
  activeWorkspaceIdentity,
  activeWorkspacePath,
  markTaskReadOnOpen,
  mobileNavigationIntent,
  onNavigateHome,
  onNavigateToChat,
  onSelectTask,
  onSwitchingChange,
  onTaskOpen,
  setError,
  setSwitchingTaskKey,
  switcher,
  task,
}: OpenWebRemoteControlTaskOptions): Promise<void> {
  const activeWorkspaceKey = resolveWebRemoteControlWorkspaceKey({
    workspacePath: activeWorkspacePath,
    workspaceIdentity: activeWorkspaceIdentity,
  });
  const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);
  const isCrossWorkspace = taskWorkspaceKey !== activeWorkspaceKey;
  onTaskOpen?.({ crossWorkspace: isCrossWorkspace });

  if (!isCrossWorkspace) {
    if (markTaskReadOnOpen && typeof task.unreadAt === "number" && switcher.markTaskRead) {
      const logReadFailure = (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        // A failed read must not block opening; the authoritative tasks-index snapshot restores the dot.
        logger.warn("[useWebRemoteControlTaskOpen] failed to mark phone task read", {
          error: message,
          taskId: task.taskId,
          workspaceKey: taskWorkspaceKey,
        });
      };
      try {
        // Fix: the dot comes from the desktop push and this Root's query cache may lag;
        // express user-seen explicitly, not via desktop selection cache hits.
        void switcher.markTaskRead(task).catch(logReadFailure);
      } catch (err) {
        logReadFailure(err);
      }
    }
    onSelectTask(task.workspacePath, task.taskId, task.workspaceIdentity);
    try {
      await switcher.updateMobileViewState?.(taskWorkspaceKey, task.taskId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("[useWebRemoteControlTaskOpen] failed to update phone seen state", {
        error: message,
        taskId: task.taskId,
        workspaceKey: taskWorkspaceKey,
      });
    }
    onNavigateToChat?.();
    return;
  }

  const rowKey = buildWebRemoteControlTaskRowKey(task);
  onSwitchingChange?.(true);
  setSwitchingTaskKey?.(rowKey);
  setError?.(null);
  logger.info("[useWebRemoteControlTaskOpen] switching remote workspace", {
    taskId: task.taskId,
    workspaceKey: taskWorkspaceKey,
  });

  try {
    await switcher.switchWorkspace(taskWorkspaceKey, {
      taskId: task.taskId,
      ...(mobileNavigationIntent ? { mobileNavigationIntent } : {}),
      ...(markTaskReadOnOpen && typeof task.unreadAt === "number"
        ? { markTaskReadExpectedUnreadAt: task.unreadAt }
        : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("[useWebRemoteControlTaskOpen] failed to open remote task", {
      error: message,
      taskId: task.taskId,
      workspaceKey: taskWorkspaceKey,
    });
    setSwitchingTaskKey?.(null);
    onSwitchingChange?.(false);
    if (isDisconnectedRemoteWorkspaceBridgeError(message)) {
      // Bugfix: after a phone reconnect the list may lag the new remoteSessionId and task open
      // gets rejected by desktop main; return home to show reconnect state instead of
      // a chat-page error.
      onNavigateHome?.();
      return;
    }
    setError?.(message);
  }
}

export function useWebRemoteControlTaskOpen({
  activeTaskId,
  activeWorkspaceIdentity,
  activeWorkspacePath,
  markTaskReadOnOpen,
  mobileNavigationIntent,
  onNavigateHome,
  onNavigateToChat,
  onSelectTask,
  onSwitchingChange,
  onTaskOpen,
  switcher,
}: Omit<OpenWebRemoteControlTaskOptions, "setError" | "setSwitchingTaskKey" | "task">) {
  const [switchingTaskKey, setSwitchingTaskKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeWorkspaceKey = useMemo(
    () =>
      resolveWebRemoteControlWorkspaceKey({
        workspacePath: activeWorkspacePath,
        workspaceIdentity: activeWorkspaceIdentity,
      }),
    [activeWorkspaceIdentity, activeWorkspacePath],
  );
  const openTask = useCallback(
    (task: WebRemoteControlTaskTarget) => {
      void openWebRemoteControlTask({
        activeTaskId,
        activeWorkspaceIdentity,
        activeWorkspacePath,
        markTaskReadOnOpen,
        mobileNavigationIntent,
        onNavigateHome,
        onNavigateToChat,
        onSelectTask,
        onSwitchingChange,
        onTaskOpen,
        setError,
        setSwitchingTaskKey,
        switcher,
        task,
      });
    },
    [
      activeTaskId,
      activeWorkspaceIdentity,
      activeWorkspacePath,
      markTaskReadOnOpen,
      mobileNavigationIntent,
      onNavigateHome,
      onNavigateToChat,
      onSelectTask,
      onSwitchingChange,
      onTaskOpen,
      switcher,
    ],
  );

  return {
    activeWorkspaceKey,
    error,
    openTask,
    switchingTaskKey,
  };
}
