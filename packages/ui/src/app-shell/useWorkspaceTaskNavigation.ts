/* eslint-disable max-lines -- Workspace tasks, automations, and the plugin store share browser-style history; centralizing keeps forward/back targets consistent. */
import { useCallback } from "react";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import {
  canGoBack as navCanGoBack,
  canGoForward as navCanGoForward,
  isAutomationsNavEntry,
  isPluginStoreNavEntry,
  type AutomationsNavigationTab,
} from "@/lib/taskNavigationHistory.js";
import { shouldBlockTaskSelectionDuringModelRestart } from "@/lib/taskSwitchGuard.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { getVisibleTaskMetas, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { buildTaskEntityKey, buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import {
  markTaskQueryCacheScopesStale,
  reconcileTaskQueryCacheUnread,
  rollbackTaskQueryCacheUnread,
  setTaskQueryCacheUnreadOverlay,
  useTaskQueryCacheStore,
} from "@/store/taskQueryCacheStore.js";
import { taskNavigationTargetExists } from "@/lib/taskNavigationTarget.js";
import { getRemoteWorkspaceSession } from "@/store/remoteWorkspaceSessionStore.js";
import { useTabStoreApi } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { bumpTaskListMembershipVersion } from "@/v4/taskListMembershipVersion.js";

export interface AutomationsNavigationTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  automationId?: string;
  automationTab?: AutomationsNavigationTab;
}

export function useWorkspaceTaskNavigation({
  intl,
  workspaceAbsPath,
  workspaceIdentity,
  activateTabByPath,
  onNavigateToTask,
  onNavigateToAutomations,
  onNavigateToPluginStore,
}: {
  intl: { formatMessage: (descriptor: { id: string }) => string };
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  onNavigateToTask?: () => void;
  onNavigateToAutomations?: (target: AutomationsNavigationTarget) => void;
  onNavigateToPluginStore?: (target: Omit<AutomationsNavigationTarget, "automationId">) => void;
}) {
  // Cross-workspace selection switches the tab first, but the ambient services captured in this
  // React render may still belong to the old remote attachment. Local targets must always originate
  // from the window base attachment and be routed by the Host Controller -- never feed a local path
  // into the stale remote scope.
  const baseServices = useBaseWorkspaceServices();
  const tabStoreApi = useTabStoreApi();
  const setActiveTaskId = useZCodeSessionStore((s) => s.setActiveTaskId);
  const taskNavHistory = useZCodeSessionStore((s) => s.taskNavHistory);
  const taskNavPushAutomations = useZCodeSessionStore((s) => s.taskNavPushAutomations);
  const taskNavPushPluginStore = useZCodeSessionStore((s) => s.taskNavPushPluginStore);
  const taskNavGoBack = useZCodeSessionStore((s) => s.taskNavGoBack);
  const taskNavGoForward = useZCodeSessionStore((s) => s.taskNavGoForward);
  const removeTaskFromNavHistory = useZCodeSessionStore((s) => s.removeTaskFromNavHistory);

  const handleSelectTask = useCallback(
    (
      targetWorkspacePath: string,
      taskId: string,
      targetWorkspaceIdentityHint?: string,
      selectedRowUnreadAt?: number,
    ) => {
      const targetWorkspaceState = useZCodeSessionStore
        .getState()
        .getWorkspaceState(targetWorkspacePath, targetWorkspaceIdentityHint);
      if (
        shouldBlockTaskSelectionDuringModelRestart(
          targetWorkspaceState.modelSwitchPending,
          targetWorkspaceState.modelSwitchStage,
        )
      ) {
        // A provider switch triggering runtime rebuild briefly recalls the current
        // provider-workspace's task handles. Switching tasks then would fire resumeTask
        // concurrently with the rebuild and misread switch failure as task-restore failure.
        // Intercept at the task-switch entry and allow switching only after the rebuild, avoiding
        // a false notReady/error UI state.
        logger.info(
          `[App] model runtime rebuilding; ignoring task switch workspace=${targetWorkspacePath} taskId=${taskId} stage=${targetWorkspaceState.modelSwitchStage}`,
        );
        toast(intl.formatMessage({ id: "taskList.switchBlockedByModelRestart" }));
        return;
      }

      // Remote-workspace unread clearing can no longer rely on looking the session up by
      // workspacePath alone: with multiple same-path remote tabs in one window the path map hits a
      // stale session and "open this task" writes read state to another remote connection.
      // Activate the target tab first, then read the more precise remoteSessionId off the now-active tab.
      activateTabByPath(
        targetWorkspacePath,
        targetWorkspaceIdentityHint
          ? { workspaceIdentity: targetWorkspaceIdentityHint }
          : undefined,
      );
      const activeTab = tabStoreApi
        .getState()
        .tabs.find((tab) => tab.id === tabStoreApi.getState().activeTabId);
      const targetWorkspaceKey = buildTaskWorkspaceKey(
        targetWorkspacePath,
        targetWorkspaceIdentityHint,
      );
      const activeWorkspaceTabMatchesTarget = Boolean(
        activeTab &&
        isWorkspaceTab(activeTab) &&
        buildTaskWorkspaceKey(activeTab.workspacePath, activeTab.workspaceIdentity) ===
          targetWorkspaceKey,
      );
      const resolvedRemoteSessionId =
        activeTab && isWorkspaceTab(activeTab) && activeWorkspaceTabMatchesTarget
          ? activeTab.remoteSessionId
          : undefined;
      const targetWorkspaceIdentity =
        activeTab && isWorkspaceTab(activeTab) && activeWorkspaceTabMatchesTarget
          ? (activeTab.workspaceIdentity ?? targetWorkspaceIdentityHint)
          : targetWorkspaceIdentityHint;
      const targetTask = {
        taskId,
        workspacePath: targetWorkspacePath,
        ...(targetWorkspaceIdentity ? { workspaceIdentity: targetWorkspaceIdentity } : {}),
      };
      const taskEntityKey = buildTaskEntityKey(targetTask);
      const cachedTaskMeta = useTaskQueryCacheStore.getState().taskMetaByEntityKey[taskEntityKey];
      const previousUnreadAt = cachedTaskMeta?.unreadAt;
      // The "tasks" timeline gets its rows directly from the Window Controller, which -- unlike
      // the project list -- never writes background-created tasks into the query cache. A click
      // transaction checking only the cache would misjudge a blue-dotted row as read. The clicked
      // row is the snapshot the user actually saw; prefer its unreadAt for compare-and-clear. Legacy
      // entries without a row snapshot keep falling back to the query cache for compatibility.
      const expectedUnreadAt =
        typeof selectedRowUnreadAt === "number" ? selectedRowUnreadAt : previousUnreadAt;
      const shouldClearUnread = typeof expectedUnreadAt === "number";
      const isRemoteWorkspace = Boolean(
        targetWorkspaceIdentity ||
        (activeTab &&
          isWorkspaceTab(activeTab) &&
          activeWorkspaceTabMatchesTarget &&
          (activeTab.remoteSessionId || activeTab.remoteTarget)),
      );

      if (shouldClearUnread) {
        // Unread used to be persisted-clear only after resumeTask in useTaskRestore. Re-clicking
        // the current task skips restore, leaving stale unreadAt on disk -- "already read, but
        // unread again after app restart". Treat explicit selection as a read entry too so
        // repeated entries clear the persisted unread. v4 task rows render from the query cache;
        // updating only the legacy Zustand unread map does not re-render the dot. Field-level
        // overlay on the exact entity key first, reconcile on server response; interim membership
        // refreshes must not write the dot back.
        setTaskQueryCacheUnreadOverlay(targetTask, undefined);
        const targetServices = resolvedRemoteSessionId
          ? (getRemoteWorkspaceSession(resolvedRemoteSessionId)?.services ?? null)
          : isRemoteWorkspace
            ? null
            : baseServices;
        if (!targetServices) {
          // With the remote workspace disconnected, do not fall back by the same workspacePath to
          // another remote session or local base services -- that would clear another workspace's
          // unread state.
          rollbackTaskQueryCacheUnread(targetTask, previousUnreadAt);
          logger.warn(
            `[App] skipped unread persist on task select; remote workspace disconnected workspace=${targetWorkspacePath} taskId=${taskId}`,
          );
        } else {
          void targetServices.zcodeTaskService
            .setTaskUnread({
              ...targetTask,
              unread: false,
              expectedUnreadAt,
            })
            .then((meta) => {
              reconcileTaskQueryCacheUnread(targetTask, meta.unreadAt);
              bumpTaskListMembershipVersion();
            })
            .catch((error: unknown) => {
              rollbackTaskQueryCacheUnread(targetTask, previousUnreadAt);
              markTaskQueryCacheScopesStale([targetTask]);
              bumpTaskListMembershipVersion();
              logger.warn(
                `[App] failed to clear unread on task select workspace=${targetWorkspacePath} taskId=${taskId}:`,
                error instanceof Error ? error.message : String(error),
              );
            });
        }
      }

      // slashCommands is a workspace-identity-level catalog, not a task projection. Clearing it on
      // selecting an existing task would leave only the conversation projection to restore, and the
      // composer's workspace catalog would never backfill. Keep the same identity bucket; cold
      // recovery that is genuinely empty is rehydrated independently by the workspace catalog.
      setActiveTaskId(targetWorkspacePath, taskId, targetWorkspaceIdentity);
      onNavigateToTask?.();
    },
    [activateTabByPath, intl, onNavigateToTask, baseServices, tabStoreApi, setActiveTaskId],
  );

  const handleOpenAutomations = useCallback(
    (automationId?: string, automationTab?: AutomationsNavigationTab) => {
      const normalizedAutomationId = automationId?.trim() || undefined;
      // Automations used to flip only a WorkspaceShellLayout local view, bypassing browser-style
      // history entirely, so the header's forward/back could not leave or restore the page. Push it
      // as a first-class workspace-identity-scoped navigation target; history replay only consumes
      // entries and never pushes again.
      taskNavPushAutomations(
        workspaceAbsPath,
        workspaceIdentity,
        normalizedAutomationId,
        automationTab,
      );
      onNavigateToAutomations?.({
        workspacePath: workspaceAbsPath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(normalizedAutomationId ? { automationId: normalizedAutomationId } : {}),
        ...(automationTab ? { automationTab } : {}),
      });
    },
    [onNavigateToAutomations, taskNavPushAutomations, workspaceAbsPath, workspaceIdentity],
  );

  const handleOpenPluginStore = useCallback(() => {
    taskNavPushPluginStore(workspaceAbsPath, workspaceIdentity);
    onNavigateToPluginStore?.({ workspacePath: workspaceAbsPath, workspaceIdentity });
  }, [onNavigateToPluginStore, taskNavPushPluginStore, workspaceAbsPath, workspaceIdentity]);

  const handleTaskNavBack = useCallback(() => {
    const currentWorkspaceState = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspaceAbsPath);
    if (
      shouldBlockTaskSelectionDuringModelRestart(
        currentWorkspaceState.modelSwitchPending,
        currentWorkspaceState.modelSwitchStage,
      )
    ) {
      logger.info(
        "[App] model runtime rebuilding; ignoring task back navigation workspace=" +
          workspaceAbsPath +
          " stage=" +
          currentWorkspaceState.modelSwitchStage,
      );
      toast(intl.formatMessage({ id: "taskList.switchBlockedByModelRestart" }));
      return;
    }

    let entry = taskNavGoBack();
    // Perf: task meta restore/stream sync refreshes the query cache at high frequency, while
    // history navigation needs an existence snapshot only at command time -- avoid subscribing the
    // whole meta table and re-rendering the shell.
    const taskMetaByEntityKey = useTaskQueryCacheStore.getState().taskMetaByEntityKey;
    while (entry) {
      const currentEntry = entry;
      if (isAutomationsNavEntry(currentEntry)) {
        activateTabByPath(
          currentEntry.workspacePath,
          currentEntry.workspaceIdentity
            ? { workspaceIdentity: currentEntry.workspaceIdentity }
            : undefined,
        );
        onNavigateToAutomations?.({
          workspacePath: currentEntry.workspacePath,
          ...(currentEntry.workspaceIdentity
            ? { workspaceIdentity: currentEntry.workspaceIdentity }
            : {}),
          ...(currentEntry.automationId ? { automationId: currentEntry.automationId } : {}),
          ...(currentEntry.automationTab ? { automationTab: currentEntry.automationTab } : {}),
        });
        return;
      }
      if (isPluginStoreNavEntry(currentEntry)) {
        activateTabByPath(
          currentEntry.workspacePath,
          currentEntry.workspaceIdentity
            ? { workspaceIdentity: currentEntry.workspaceIdentity }
            : undefined,
        );
        onNavigateToPluginStore?.(currentEntry);
        return;
      }
      const navWorkspaceState = useZCodeSessionStore
        .getState()
        .getWorkspaceState(currentEntry.workspacePath, currentEntry.workspaceIdentity);
      const exists = taskNavigationTargetExists({
        entry: currentEntry,
        visibleTasks: getVisibleTaskMetas(navWorkspaceState),
        taskMetaByEntityKey,
      });
      if (exists) {
        handleSelectTask(
          currentEntry.workspacePath,
          currentEntry.taskId,
          currentEntry.workspaceIdentity,
        );
        return;
      }

      // Target task deleted; prune it from history and keep trying.
      removeTaskFromNavHistory(currentEntry.taskId);
      entry = taskNavGoBack();
    }

    toast(intl.formatMessage({ id: "taskNav.noMoreBack" }));
  }, [
    activateTabByPath,
    handleSelectTask,
    intl,
    onNavigateToAutomations,
    onNavigateToPluginStore,
    removeTaskFromNavHistory,
    taskNavGoBack,
    workspaceAbsPath,
  ]);

  const handleTaskNavForward = useCallback(() => {
    const currentWorkspaceState = useZCodeSessionStore
      .getState()
      .getWorkspaceState(workspaceAbsPath);
    if (
      shouldBlockTaskSelectionDuringModelRestart(
        currentWorkspaceState.modelSwitchPending,
        currentWorkspaceState.modelSwitchStage,
      )
    ) {
      logger.info(
        "[App] model runtime rebuilding; ignoring task forward navigation workspace=" +
          workspaceAbsPath +
          " stage=" +
          currentWorkspaceState.modelSwitchStage,
      );
      toast(intl.formatMessage({ id: "taskList.switchBlockedByModelRestart" }));
      return;
    }

    let entry = taskNavGoForward();
    // Perf: read the latest query cache only when forward is invoked, keeping small task-meta
    // updates from subscribing this navigation hook wholesale.
    const taskMetaByEntityKey = useTaskQueryCacheStore.getState().taskMetaByEntityKey;
    while (entry) {
      const currentEntry = entry;
      if (isAutomationsNavEntry(currentEntry)) {
        activateTabByPath(
          currentEntry.workspacePath,
          currentEntry.workspaceIdentity
            ? { workspaceIdentity: currentEntry.workspaceIdentity }
            : undefined,
        );
        onNavigateToAutomations?.({
          workspacePath: currentEntry.workspacePath,
          ...(currentEntry.workspaceIdentity
            ? { workspaceIdentity: currentEntry.workspaceIdentity }
            : {}),
          ...(currentEntry.automationId ? { automationId: currentEntry.automationId } : {}),
          ...(currentEntry.automationTab ? { automationTab: currentEntry.automationTab } : {}),
        });
        return;
      }
      if (isPluginStoreNavEntry(currentEntry)) {
        activateTabByPath(
          currentEntry.workspacePath,
          currentEntry.workspaceIdentity
            ? { workspaceIdentity: currentEntry.workspaceIdentity }
            : undefined,
        );
        onNavigateToPluginStore?.(currentEntry);
        return;
      }
      const navWorkspaceState = useZCodeSessionStore
        .getState()
        .getWorkspaceState(currentEntry.workspacePath, currentEntry.workspaceIdentity);
      const exists = taskNavigationTargetExists({
        entry: currentEntry,
        visibleTasks: getVisibleTaskMetas(navWorkspaceState),
        taskMetaByEntityKey,
      });
      if (exists) {
        handleSelectTask(
          currentEntry.workspacePath,
          currentEntry.taskId,
          currentEntry.workspaceIdentity,
        );
        return;
      }

      removeTaskFromNavHistory(currentEntry.taskId);
      entry = taskNavGoForward();
    }

    toast(intl.formatMessage({ id: "taskNav.noMoreForward" }));
  }, [
    activateTabByPath,
    handleSelectTask,
    intl,
    onNavigateToAutomations,
    onNavigateToPluginStore,
    removeTaskFromNavHistory,
    taskNavGoForward,
    workspaceAbsPath,
  ]);

  const canGoBack = navCanGoBack(taskNavHistory);
  const canGoForward = navCanGoForward(taskNavHistory);
  const currentWorkspaceState = useZCodeSessionStore.getState().getWorkspaceState(workspaceAbsPath);
  const isTaskSwitchLockedByModelRestart = shouldBlockTaskSelectionDuringModelRestart(
    currentWorkspaceState.modelSwitchPending,
    currentWorkspaceState.modelSwitchStage,
  );
  const canTaskNavBack = canGoBack && !isTaskSwitchLockedByModelRestart;
  const canTaskNavForward = canGoForward && !isTaskSwitchLockedByModelRestart;

  return {
    handleSelectTask,
    handleOpenAutomations,
    handleOpenPluginStore,
    handleTaskNavBack,
    handleTaskNavForward,
    canGoBack,
    canGoForward,
    canTaskNavBack,
    canTaskNavForward,
  };
}
