/* eslint-disable max-lines -- the wide-screen task index owns index loading, grouping, and hover actions; row JSX lives in WebRemoteControlTaskIndexRow. */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  Cloud,
  FolderOpen,
  LoaderIcon,
  MessageCirclePlus,
} from "lucide-react";
import {
  resolveWebRemoteControlWorkspaceKey,
  type WebRemoteControlWorkspaceListResult,
  type WebRemoteControlTaskTarget,
} from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  applyWebRemoteControlTaskMembershipUpdate,
  buildWebRemoteControlTaskIndexModel,
  getWebRemoteControlTaskMutationWorkspaceTargets,
  shouldRetryWebRemoteControlTaskIndexLoad,
  type WebRemoteControlTaskIndexSortBy,
  type WebRemoteControlTaskIndexViewMode,
} from "@/lib/webRemoteControlTaskIndex.js";
import { buildWorkspaceServiceLookup } from "@/lib/workspaceServiceResolver.js";
import {
  buildWebRemoteControlTaskRowKey,
  useWebRemoteControlTaskOpen,
} from "@/hooks/useWebRemoteControlTaskOpen.js";
import { logger } from "@/logger.js";
import type { WebRemoteControlWorkspaceSwitcherApi } from "@/root/types.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { WebRemoteControlTaskIndexRow } from "@/WebRemoteControlTaskIndexRow.js";
import { DeleteAllArchivedTasksButton } from "@/DeleteAllArchivedTasksButton.js";

const WEB_REMOTE_CONTROL_TASK_INDEX_EMPTY_RETRY_DELAY_MS = 300;
const WEB_REMOTE_CONTROL_TASK_INDEX_EMPTY_RETRY_MAX_ATTEMPTS = 3;

function waitForWebRemoteControlTaskIndexRetry(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, WEB_REMOTE_CONTROL_TASK_INDEX_EMPTY_RETRY_DELAY_MS);
  });
}

export function WebRemoteControlTaskIndex({
  switcher,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeTaskId,
  taskSortBy = "updated",
  taskViewMode = "workspace",
  searchQuery = "",
  collapsedWorkspaceKeys = new Set(),
  initialResult,
  onToggleWorkspaceCollapsed,
  onWorkspaceGroupKeysChange,
  renderBeforePinnedTasks,
  archivedActionsContainer,
  onSelectTask,
  onTaskOpen,
  onCrossWorkspaceSwitchingChange,
}: {
  switcher: WebRemoteControlWorkspaceSwitcherApi;
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  taskSortBy?: WebRemoteControlTaskIndexSortBy;
  taskViewMode?: WebRemoteControlTaskIndexViewMode;
  searchQuery?: string;
  collapsedWorkspaceKeys?: ReadonlySet<string>;
  initialResult?: WebRemoteControlWorkspaceListResult;
  onToggleWorkspaceCollapsed?: (workspaceKey: string) => void;
  onWorkspaceGroupKeysChange?: (workspaceKeys: string[]) => void;
  renderBeforePinnedTasks?: () => ReactNode;
  archivedActionsContainer?: HTMLElement | null;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  onTaskOpen?: (options: { crossWorkspace: boolean }) => void;
  onCrossWorkspaceSwitchingChange?: (switching: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const baseServices = useBaseWorkspaceServices();
  const removeTaskState = useZCodeSessionStore((state) => state.removeTaskState);
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const sessionIdByWorkspaceIdentity = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspaceIdentity,
  );
  const sessionIdByWorkspacePath = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspacePath,
  );
  const serviceResolverState = useMemo(
    () => ({
      sessionsById,
      sessionIdByWorkspaceIdentity,
      sessionIdByWorkspacePath,
    }),
    [sessionIdByWorkspaceIdentity, sessionIdByWorkspacePath, sessionsById],
  );
  const [result, setResult] = useState<WebRemoteControlWorkspaceListResult>(
    initialResult ?? {
      workspaces: [],
      tasks: [],
    },
  );
  const [loading, setLoading] = useState(false);
  const [pendingArchiveTaskKey, setPendingArchiveTaskKey] = useState<string | null>(null);
  const [mutatingTaskKey, setMutatingTaskKey] = useState<string | null>(null);
  const {
    activeWorkspaceKey,
    error: taskOpenError,
    openTask,
    switchingTaskKey,
  } = useWebRemoteControlTaskOpen({
    activeTaskId,
    activeWorkspaceIdentity,
    activeWorkspacePath,
    onSelectTask,
    onSwitchingChange: onCrossWorkspaceSwitchingChange,
    onTaskOpen,
    switcher,
  });
  const [loadError, setLoadError] = useState<string | null>(null);
  const error = loadError ?? taskOpenError;
  const model = useMemo(
    () =>
      buildWebRemoteControlTaskIndexModel({
        result,
        viewMode: taskViewMode,
        sortBy: taskSortBy,
        searchQuery,
        collapsedWorkspaceKeys,
      }),
    [collapsedWorkspaceKeys, result, searchQuery, taskSortBy, taskViewMode],
  );
  const visibleTaskCount = model.pinnedTasks.length + model.totalTaskCount;
  const workspaceGroupKeys = useMemo(
    () => model.groups.map((group) => group.workspaceKey),
    [model.groups],
  );
  const mutationWorkspaceTargets = useMemo(
    () =>
      getWebRemoteControlTaskMutationWorkspaceTargets({
        activeWorkspaceIdentity,
        workspaces: result.workspaces,
      }),
    [activeWorkspaceIdentity, result.workspaces],
  );
  const workspaceServiceLookup = useMemo(
    () => buildWorkspaceServiceLookup(mutationWorkspaceTargets, baseServices, serviceResolverState),
    [baseServices, mutationWorkspaceTargets, serviceResolverState],
  );

  const loadTasks = useCallback(
    async (isCancelled: () => boolean = () => false) => {
      setLoading(true);
      setLoadError(null);
      try {
        for (
          let attempt = 0;
          attempt <= WEB_REMOTE_CONTROL_TASK_INDEX_EMPTY_RETRY_MAX_ATTEMPTS;
          attempt += 1
        ) {
          const nextResult = await switcher.listWorkspaces();
          if (isCancelled()) {
            return;
          }

          setResult(nextResult);
          if (
            !shouldRetryWebRemoteControlTaskIndexLoad({
              activeTaskId,
              attempt,
              maxAttempts: WEB_REMOTE_CONTROL_TASK_INDEX_EMPTY_RETRY_MAX_ATTEMPTS,
              taskCount: nextResult.tasks?.length ?? 0,
            })
          ) {
            return;
          }

          // Bugfix: across workspace switches the web root attaches the new bridge while
          // the desktop task snapshot may still load; empty is not final, retry briefly before the empty state.
          logger.debug(
            "[WebRemoteControlTaskIndex] task index empty; waiting for desktop snapshot sync",
            {
              activeTaskId,
              activeWorkspaceIdentity,
              activeWorkspacePath,
              attempt,
            },
          );
          await waitForWebRemoteControlTaskIndexRetry();
          if (isCancelled()) {
            return;
          }
        }
      } catch (err) {
        if (isCancelled()) {
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        logger.error("[WebRemoteControlTaskIndex] failed to load remote task index", {
          error: message,
        });
        setLoadError(message);
      } finally {
        if (!isCancelled()) {
          setLoading(false);
        }
      }
    },
    [activeTaskId, activeWorkspaceIdentity, activeWorkspacePath, switcher],
  );

  useEffect(() => {
    let cancelled = false;
    void loadTasks(() => cancelled);
    return () => {
      cancelled = true;
    };
  }, [loadTasks]);

  useEffect(() => {
    return switcher.onWorkspaceListUpdated?.((nextResult) => {
      // Bugfix: desktop archive/pin pushes the newest task index to web remote;
      // adopt the desktop-synced snapshot so tasks hidden on the other end never linger here.
      setResult(nextResult);
      setLoadError(null);
      setLoading(false);
    });
  }, [switcher]);

  useEffect(() => {
    onWorkspaceGroupKeysChange?.(workspaceGroupKeys);
  }, [onWorkspaceGroupKeysChange, workspaceGroupKeys]);

  const updateTaskMembership = useCallback(
    (task: WebRemoteControlTaskTarget, membership: { pinned: boolean; archived: boolean }) => {
      setResult((current) =>
        applyWebRemoteControlTaskMembershipUpdate({
          result: current,
          target: task,
          membership,
        }),
      );
    },
    [],
  );

  const removeTaskFromIndex = useCallback((task: WebRemoteControlTaskTarget) => {
    setResult((current) => ({
      ...current,
      tasks: (current.tasks ?? []).filter(
        (candidate) =>
          candidate.taskId !== task.taskId ||
          resolveWebRemoteControlWorkspaceKey(candidate) !==
            resolveWebRemoteControlWorkspaceKey(task),
      ),
    }));
  }, []);

  const handleToggleTaskPin = useCallback(
    (event: ReactMouseEvent, task: WebRemoteControlTaskTarget) => {
      event.preventDefault();
      event.stopPropagation();
      const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);
      const workspaceServices = workspaceServiceLookup.get(taskWorkspaceKey);
      if (!workspaceServices) {
        return;
      }

      const rowKey = buildWebRemoteControlTaskRowKey(task);
      const pinned = !task.pinned;
      setPendingArchiveTaskKey(null);
      setMutatingTaskKey(rowKey);
      void workspaceServices.services.zcodeTaskService
        .setTaskPinned({
          taskId: task.taskId,
          workspacePath: task.workspacePath,
          ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
          pinned,
        })
        .then(() => {
          updateTaskMembership(task, { pinned, archived: false });
        })
        .catch((error) => {
          logger.warn("[WebRemoteControlTaskIndex] failed to update remote task pin state", {
            error: error instanceof Error ? error.message : String(error),
            taskId: task.taskId,
            workspaceKey: taskWorkspaceKey,
          });
          toast(intl.formatMessage({ id: "taskList.pinFailed" }));
        })
        .finally(() => {
          setMutatingTaskKey((current) => (current === rowKey ? null : current));
        });
    },
    [intl, updateTaskMembership, workspaceServiceLookup],
  );

  const handleArchiveTask = useCallback(
    (event: ReactMouseEvent, task: WebRemoteControlTaskTarget) => {
      event.preventDefault();
      event.stopPropagation();
      const rowKey = buildWebRemoteControlTaskRowKey(task);
      if (pendingArchiveTaskKey !== rowKey) {
        // Bugfix: wide remote had no hover actions; archiving keeps the desktop confirm against mis-taps.
        setPendingArchiveTaskKey(rowKey);
        return;
      }

      const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);
      const workspaceServices = workspaceServiceLookup.get(taskWorkspaceKey);
      if (!workspaceServices) {
        return;
      }

      setPendingArchiveTaskKey(null);
      setMutatingTaskKey(rowKey);
      void workspaceServices.services.zcodeTaskService
        .archiveTask({
          taskId: task.taskId,
          workspacePath: task.workspacePath,
          ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
        })
        .then(() => {
          updateTaskMembership(task, { pinned: false, archived: true });
        })
        .catch((error) => {
          logger.warn("[WebRemoteControlTaskIndex] failed to archive remote task", {
            error: error instanceof Error ? error.message : String(error),
            taskId: task.taskId,
            workspaceKey: taskWorkspaceKey,
          });
          toast(intl.formatMessage({ id: "taskList.archiveFailed" }));
        })
        .finally(() => {
          setMutatingTaskKey((current) => (current === rowKey ? null : current));
        });
    },
    [intl, pendingArchiveTaskKey, updateTaskMembership, workspaceServiceLookup],
  );

  const handleUnarchiveTask = useCallback(
    (event: ReactMouseEvent, task: WebRemoteControlTaskTarget) => {
      event.preventDefault();
      event.stopPropagation();
      const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);
      const workspaceServices = workspaceServiceLookup.get(taskWorkspaceKey);
      if (!workspaceServices) {
        return;
      }

      const rowKey = buildWebRemoteControlTaskRowKey(task);
      setPendingArchiveTaskKey(null);
      setMutatingTaskKey(rowKey);
      void workspaceServices.services.zcodeTaskService
        .unarchiveTask({
          taskId: task.taskId,
          workspacePath: task.workspacePath,
          ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
        })
        .then(() => {
          updateTaskMembership(task, { pinned: false, archived: false });
        })
        .catch((error) => {
          logger.warn("[WebRemoteControlTaskIndex] failed to unarchive remote task", {
            error: error instanceof Error ? error.message : String(error),
            taskId: task.taskId,
            workspaceKey: taskWorkspaceKey,
          });
        })
        .finally(() => {
          setMutatingTaskKey((current) => (current === rowKey ? null : current));
        });
    },
    [updateTaskMembership, workspaceServiceLookup],
  );

  const handleDeleteArchivedTask = useCallback(
    (event: ReactMouseEvent, task: WebRemoteControlTaskTarget) => {
      event.preventDefault();
      event.stopPropagation();
      void (async () => {
        const confirmed = await confirmDialog({
          title: intl.formatMessage({ id: "confirmDialog.archivedTaskDeleteTitle" }),
          description: intl.formatMessage({
            id: "confirmDialog.archivedTaskDeleteDescription",
          }),
          confirmLabel: intl.formatMessage({ id: "taskList.delete" }),
        });
        if (!confirmed) {
          return;
        }

        const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);
        const workspaceServices = workspaceServiceLookup.get(taskWorkspaceKey);
        if (!workspaceServices) {
          return;
        }

        const rowKey = buildWebRemoteControlTaskRowKey(task);
        setPendingArchiveTaskKey(null);
        setMutatingTaskKey(rowKey);
        try {
          await workspaceServices.services.zcodeTaskService.deleteTask({
            taskId: task.taskId,
            workspacePath: task.workspacePath,
            ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
          });
          // Bugfix: archive deletion had no local query-cache fallback, so removed entries lingered
          // until the next desktop push. Remove from the current workspace-list snapshot directly.
          removeTaskFromIndex(task);
          removeTaskState(task.workspacePath, task.taskId, task.workspaceIdentity);
        } catch (error) {
          logger.warn("[WebRemoteControlTaskIndex] failed to delete archived remote task", {
            error: error instanceof Error ? error.message : String(error),
            taskId: task.taskId,
            workspaceKey: taskWorkspaceKey,
          });
        } finally {
          setMutatingTaskKey((current) => (current === rowKey ? null : current));
        }
      })();
    },
    [confirmDialog, intl, removeTaskFromIndex, removeTaskState, workspaceServiceLookup],
  );

  const renderTaskRow = useCallback(
    (task: WebRemoteControlTaskTarget, options: { showWorkspaceLabel?: boolean } = {}) => {
      const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);
      return (
        <WebRemoteControlTaskIndexRow
          key={buildWebRemoteControlTaskRowKey(task)}
          activeTaskId={activeTaskId}
          activeWorkspaceKey={activeWorkspaceKey}
          canMutateTask={workspaceServiceLookup.has(taskWorkspaceKey)}
          intl={intl}
          mutatingTaskKey={mutatingTaskKey}
          onArchiveTask={handleArchiveTask}
          onDeleteArchivedTask={handleDeleteArchivedTask}
          onOpenTask={(targetTask) => {
            setPendingArchiveTaskKey(null);
            openTask(targetTask);
          }}
          onToggleTaskPin={handleToggleTaskPin}
          onUnarchiveTask={handleUnarchiveTask}
          pendingArchiveTaskKey={pendingArchiveTaskKey}
          showWorkspaceLabel={options.showWorkspaceLabel}
          switchingTaskKey={switchingTaskKey}
          task={task}
          taskSortBy={taskSortBy}
        />
      );
    },
    [
      activeTaskId,
      activeWorkspaceKey,
      handleArchiveTask,
      handleDeleteArchivedTask,
      handleToggleTaskPin,
      handleUnarchiveTask,
      intl,
      mutatingTaskKey,
      openTask,
      pendingArchiveTaskKey,
      switchingTaskKey,
      taskSortBy,
      workspaceServiceLookup,
    ],
  );

  return (
    <section className="flex min-h-0 flex-col gap-2 px-2">
      {/* Bugfix: pinned tasks in the workspace view render below the slider/filter toolbar.
          The parent keeps the toolbar slot; task source of truth and replayable resume bounds unchanged. */}
      {renderBeforePinnedTasks ? renderBeforePinnedTasks() : null}
      {taskViewMode === "archived" ? (
        <DeleteAllArchivedTasksButton
          actionsContainer={archivedActionsContainer}
          count={result.tasks?.filter((task) => task.archived).length ?? 0}
          disabled={loading || !result.tasks?.some((task) => task.archived)}
          workspaces={result.workspaces.map((workspace) => ({
            workspacePath: workspace.workspacePath,
            workspaceIdentity: workspace.workspaceIdentity,
            label: workspace.label,
            service:
              workspace.connectionState === "disconnected" ||
              workspace.connectionState === "reconnecting"
                ? undefined
                : workspaceServiceLookup.get(resolveWebRemoteControlWorkspaceKey(workspace))
                    ?.services.zcodeTaskService,
          }))}
          onDeleted={(target) => {
            setResult((current) => ({
              ...current,
              tasks: current.tasks?.filter(
                (task) =>
                  task.taskId !== target.taskId ||
                  resolveWebRemoteControlWorkspaceKey(task) !==
                    resolveWebRemoteControlWorkspaceKey(target),
              ),
            }));
            removeTaskState(target.workspacePath, target.taskId, target.workspaceIdentity);
          }}
        />
      ) : null}
      {model.pinnedTasks.length > 0 ? (
        <div className="space-y-1">
          <div className="px-2 py-1 text-ui-base text-foreground-subtlest">
            {intl.formatMessage({ id: "taskList.pinnedSection" })}
          </div>
          <ul className="space-y-0.5">{model.pinnedTasks.map((task) => renderTaskRow(task))}</ul>
        </div>
      ) : null}
      {loading && visibleTaskCount === 0 ? (
        <div className="flex items-center gap-2 px-2 py-1 text-ui-base text-foreground-subtle">
          <LoaderIcon className="size-3.5 animate-spin" />
          {intl.formatMessage({ id: "common.loading" })}
        </div>
      ) : null}
      {error ? <div className="px-2 py-1 text-ui-base text-foreground-subtle">{error}</div> : null}
      {!loading && !error && visibleTaskCount === 0 ? (
        <div className="px-2 py-1 text-ui-base text-foreground-subtle">
          {intl.formatMessage({
            id:
              taskViewMode === "archived" ? "taskList.noArchivedTasks" : "webRemoteControl.noTasks",
          })}
        </div>
      ) : null}
      {taskViewMode === "workspace" && model.totalTaskCount > 0 ? (
        <ul className="space-y-2">
          {model.groups.map((group) => (
            <li key={group.workspaceKey} className="space-y-1">
              <button
                type="button"
                className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg pl-2.5 pr-1 text-left text-foreground hover:bg-surface-hover hover:text-foreground"
                aria-expanded={!group.collapsed}
                onClick={() => onToggleWorkspaceCollapsed?.(group.workspaceKey)}
              >
                <span className="flex size-3 shrink-0 items-center justify-center text-foreground-subtlest">
                  {group.collapsed ? (
                    <ChevronRight className="size-3" />
                  ) : (
                    <ChevronDown className="size-3" />
                  )}
                </span>
                <span className="flex size-4 shrink-0 items-center justify-center text-foreground-subtle">
                  {group.workspace.workspacePurpose === "conversation" ? (
                    <MessageCirclePlus className="size-4" />
                  ) : group.workspace.kind === "remote" ? (
                    <Cloud className="size-4" />
                  ) : (
                    <FolderOpen className="size-4" />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate text-ui-base text-foreground-subtle">
                  {group.workspace.workspacePurpose === "conversation"
                    ? intl.formatMessage({ id: "workspaceSidebar.conversationsSection" })
                    : group.workspace.label}
                </span>
                {group.collapsed && group.hasUnread ? (
                  <span
                    aria-hidden="true"
                    data-workspace-unread-indicator="true"
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-sky-500 dark:bg-sky-400"
                  />
                ) : null}
                <span className="shrink-0 text-ui-base text-foreground-subtlest">
                  {group.totalTaskCount ?? group.tasks.length}
                </span>
              </button>
              {group.collapsed ? null : (
                <ul className="space-y-0.5">{group.tasks.map((task) => renderTaskRow(task))}</ul>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {taskViewMode === "timeline" && model.timelineTasks.length > 0 ? (
        <ul className="space-y-0.5">
          {model.timelineTasks.map((task) => renderTaskRow(task, { showWorkspaceLabel: true }))}
        </ul>
      ) : null}
      {taskViewMode === "archived" && model.archivedTasks.length > 0 ? (
        <ul className="space-y-0.5 pb-4">
          {model.archivedTasks.map((task) => renderTaskRow(task, { showWorkspaceLabel: true }))}
        </ul>
      ) : null}
    </section>
  );
}
