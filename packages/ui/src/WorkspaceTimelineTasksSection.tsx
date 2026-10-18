/* eslint-disable max-lines -- the timeline hosts local scoped queries, remote prefetch caches, and task actions; centralized for clarity. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { toast } from "@/components/ui/toast.js";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { useLocalWorkspaceScopes } from "@/hooks/useLocalWorkspaceScopes.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getTaskTimelineGroupMessage, groupTaskTimelineItems } from "@/lib/taskTimelineGroups.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { buildWorkspaceServiceLookup } from "@/lib/workspaceServiceResolver.js";
import { logger } from "@/logger.js";
import { MemoTaskItem, TaskListItemContextMenuContent } from "@/TaskListItem.js";
import { TaskListLoadingHint } from "@/TaskListLoadingHint.js";
import { TaskListRemoteSyncHint } from "@/TaskListRemoteSyncHint.js";
import { TaskRenameDialog } from "@/TaskRenameDialog.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useRemotePinnedTaskStore } from "@/store/remotePinnedTaskStore.js";
import { useRemoteTimelineTaskStore } from "@/store/remoteTimelineTaskStore.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { applyTaskQueryCacheMutation } from "@/store/taskQueryCacheStore.js";

function buildTimelineItemKey(workspacePath: string, taskId: string, workspaceIdentity?: string) {
  return `${buildTaskWorkspaceKey(workspacePath, workspaceIdentity)}:${taskId}`;
}

interface TimelineTaskItemHandlers {
  onSelectTask: (taskId: string) => void;
  onArchiveTaskInline: (event: ReactMouseEvent, taskId: string) => void;
  onTogglePinTask: (taskId: string, pinned: boolean) => void;
  onStartRenameTask: (taskId: string, currentTitle: string) => void;
  onArchiveTask: (taskId: string) => void;
  onMarkTaskAsUnread: (taskId: string) => void;
  onOpenTaskContextMenu: (taskId: string) => void;
}

export function WorkspaceTimelineTasksSection({
  workspaceTabs,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeTaskId,
  taskSortBy,
  groupByDate = true,
  taskRowVariant = "timeline",
  emptyMessage,
  mobileActiveTaskKey,
  onSelectTask,
}: {
  workspaceTabs: WorkspaceTabState[];
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  taskSortBy: "created" | "updated";
  groupByDate?: boolean;
  taskRowVariant?: "default" | "timeline";
  emptyMessage?: string;
  mobileActiveTaskKey?: string | null;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
    expectedUnreadAt?: number,
  ) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const baseServices = useBaseWorkspaceServices();
  const scopedWorkspaceTabs = useLocalWorkspaceScopes({
    workspaceTabs,
  });
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
  const removeTaskState = useZCodeSessionStore((state) => state.removeTaskState);
  const upsertOptimisticTaskListItem = useZCodeSessionStore(
    (state) => state.upsertOptimisticTaskListItem,
  );
  const removeOptimisticTaskListItem = useZCodeSessionStore(
    (state) => state.removeOptimisticTaskListItem,
  );
  const setTaskUnreadIndicator = useZCodeSessionStore((state) => state.setTaskUnreadIndicator);
  const [pendingArchiveItemKey, setPendingArchiveItemKey] = useState<string | null>(null);
  const [renamingItemKey, setRenamingItemKey] = useState<string | null>(null);
  const [contextMenuItemKey, setContextMenuItemKey] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  // No 10-row first page: match the 20-row baseline of every other sidebar list.
  // First page and show-more step both 20, so 10/20 never reads as the end.
  const collapsedLimit = 20;
  const [visibleTaskLimit, setVisibleTaskLimit] = useState(collapsedLimit);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const pendingArchiveItemKeyRef = useRef<string | null>(pendingArchiveItemKey);
  const renamingItemKeyRef = useRef<string | null>(renamingItemKey);
  const taskSortByRef = useRef(taskSortBy);
  const intlRef = useRef(intl);
  const onSelectTaskRef = useRef(onSelectTask);
  const removeTaskStateRef = useRef(removeTaskState);
  const upsertOptimisticTaskListItemRef = useRef(upsertOptimisticTaskListItem);
  const removeOptimisticTaskListItemRef = useRef(removeOptimisticTaskListItem);
  const setTaskUnreadIndicatorRef = useRef(setTaskUnreadIndicator);
  const taskItemHandlersByKeyRef = useRef(new Map<string, TimelineTaskItemHandlers>());
  pendingArchiveItemKeyRef.current = pendingArchiveItemKey;
  renamingItemKeyRef.current = renamingItemKey;
  taskSortByRef.current = taskSortBy;
  intlRef.current = intl;
  onSelectTaskRef.current = onSelectTask;
  removeTaskStateRef.current = removeTaskState;
  upsertOptimisticTaskListItemRef.current = upsertOptimisticTaskListItem;
  removeOptimisticTaskListItemRef.current = removeOptimisticTaskListItem;
  setTaskUnreadIndicatorRef.current = setTaskUnreadIndicator;
  const workspaceServiceLookup = useMemo(
    () => buildWorkspaceServiceLookup(workspaceTabs, baseServices, serviceResolverState),
    [baseServices, serviceResolverState, workspaceTabs],
  );
  const activeWorkspaceKey = buildTaskWorkspaceKey(activeWorkspacePath, activeWorkspaceIdentity);
  const workspaceTabsSignature = useMemo(
    () =>
      workspaceTabs
        .map((tab) => `${tab.workspaceIdentity?.trim() || tab.workspacePath}:${tab.workspacePath}`)
        .join("|"),
    [workspaceTabs],
  );
  const {
    items: localItems,
    total: localTotal,
    hasMore: localHasMore,
    loading: localLoading,
  } = useGlobalTaskList({
    kind: "timeline",
    workspaceTabs: scopedWorkspaceTabs,
    sortBy: taskSortBy,
    searchQuery: "",
    expanded: false,
    collapsedLimit: visibleTaskLimit,
  });
  const remoteTimelineItemsByWorkspaceKey = useRemoteTimelineTaskStore(
    (state) => state.itemsByWorkspaceKey,
  );
  const remoteTimelineLoadingByWorkspaceKey = useRemoteTimelineTaskStore(
    (state) => state.loadingByWorkspaceKey,
  );
  const remoteTimelineTotalByWorkspaceKey = useRemoteTimelineTaskStore(
    (state) => state.totalByWorkspaceKey,
  );
  const remoteTimelineHasMoreByWorkspaceKey = useRemoteTimelineTaskStore(
    (state) => state.hasMoreByWorkspaceKey,
  );
  const remoteWorkspaceKeys = useMemo(
    () => [
      ...new Set(
        workspaceTabs
          .filter((tab) => tab.workspaceIdentity || tab.remoteTarget || tab.remoteSessionId)
          .map((tab) => buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity)),
      ),
    ],
    [workspaceTabs],
  );
  const remoteItems = useMemo(() => {
    return remoteWorkspaceKeys.flatMap(
      (workspaceKey) => remoteTimelineItemsByWorkspaceKey[workspaceKey] ?? [],
    );
  }, [remoteTimelineItemsByWorkspaceKey, remoteWorkspaceKeys]);
  const sortedItems = useMemo(() => {
    return [...localItems, ...remoteItems].sort((left, right) =>
      compareZCodeTaskListItems(left, right, taskSortBy),
    );
  }, [localItems, remoteItems, taskSortBy]);
  const items = sortedItems.slice(0, visibleTaskLimit);
  const itemByKey = useMemo(() => {
    const nextItemByKey = new Map<string, ZCodeTaskMeta>();
    for (const item of items) {
      nextItemByKey.set(
        buildTimelineItemKey(item.workspacePath, item.taskId, item.workspaceIdentity),
        item,
      );
    }
    return nextItemByKey;
  }, [items]);
  const itemByKeyRef = useRef(itemByKey);
  const workspaceServiceLookupRef = useRef(workspaceServiceLookup);
  itemByKeyRef.current = itemByKey;
  workspaceServiceLookupRef.current = workspaceServiceLookup;
  const timelineGroups = useMemo(() => {
    const visibleItems = items.filter((item) =>
      workspaceServiceLookup.has(buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity)),
    );
    if (!groupByDate) {
      return [{ key: "all", label: null, items: visibleItems }];
    }
    return groupTaskTimelineItems(items, {
      sortBy: taskSortBy,
      now: Date.now(),
      locale,
    })
      .map((group) => ({
        ...group,
        items: group.items.filter((item) =>
          workspaceServiceLookup.has(
            buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity),
          ),
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [groupByDate, items, locale, taskSortBy, workspaceServiceLookup]);
  const remoteTotal = remoteWorkspaceKeys.reduce(
    (sum, workspaceKey) =>
      sum +
      (remoteTimelineTotalByWorkspaceKey[workspaceKey] ??
        remoteTimelineItemsByWorkspaceKey[workspaceKey]?.length ??
        0),
    0,
  );
  const total = localTotal + remoteTotal;
  const remoteHasMore = remoteWorkspaceKeys.some(
    (workspaceKey) => remoteTimelineHasMoreByWorkspaceKey[workspaceKey],
  );
  const syncingRemoteWorkspaces = workspaceTabs.some((tab) => {
    if (!tab.workspaceIdentity && !tab.remoteTarget && !tab.remoteSessionId) {
      return false;
    }
    return Boolean(
      remoteTimelineLoadingByWorkspaceKey[
        buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity)
      ],
    );
  });
  const loading = localLoading || syncingRemoteWorkspaces;
  const hasKnownMore = localHasMore || remoteHasMore || total > items.length;
  const currentLimitFilled = sortedItems.length >= visibleTaskLimit;
  // remote/local hasMore can lag one round;
  // when loaded < limit the round is the last: hide show more.
  const canLoadMore = loading ? hasKnownMore : currentLimitFilled && hasKnownMore;

  useEffect(() => {
    setVisibleTaskLimit(collapsedLimit);
  }, [taskSortBy, workspaceTabsSignature]);

  useEffect(() => {
    // This log fires on every remote sync and tab restore;
    // production keeps lifecycle/errors, sync details downgraded to debug.
    logger.debug("[WorkspaceTimelineTasksSection] scopedWorkspaceTabs", {
      workspaceTabs: workspaceTabs.map((tab) => ({
        workspacePath: tab.workspacePath,
        workspaceIdentity: tab.workspaceIdentity,
        remoteSessionId: tab.remoteSessionId,
        hasRemoteTarget: Boolean(tab.remoteTarget),
      })),
      scopedWorkspaceTabs: scopedWorkspaceTabs.map((tab) => ({
        workspacePath: tab.workspacePath,
        workspaceIdentity: tab.workspaceIdentity,
        remoteSessionId: tab.remoteSessionId,
        hasRemoteTarget: Boolean(tab.remoteTarget),
      })),
      remoteItemCount: remoteItems.length,
    });
  }, [remoteItems.length, scopedWorkspaceTabs, workspaceTabs]);

  useEffect(() => {
    const remoteTabs = workspaceTabs.filter(
      (tab) => tab.workspaceIdentity || tab.remoteTarget || tab.remoteSessionId,
    );
    if (remoteTabs.length === 0) {
      return;
    }

    for (const tab of remoteTabs) {
      const workspaceServices = workspaceServiceLookup.get(
        buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity),
      );
      if (!workspaceServices?.isRemoteWorkspace) {
        continue;
      }
      // Never reuse useGlobalTaskList's hybrid query: remote services would poison local cache.
      // Remote data lives in its own store like pinned; show-more steps limit by 20.
      void useRemoteTimelineTaskStore.getState().refreshWorkspace({
        workspacePath: tab.workspacePath,
        ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
        zcodeTaskService: workspaceServices.services.zcodeTaskService,
        sortBy: taskSortBy,
        limit: visibleTaskLimit,
      });
    }
  }, [taskSortBy, visibleTaskLimit, workspaceServiceLookup, workspaceTabs]);

  const handleCancelArchiveConfirm = useCallback(() => {
    setPendingArchiveItemKey(null);
  }, []);

  const handleCancelRenameTask = useCallback(() => {
    setRenamingItemKey(null);
    setRenameDraft("");
  }, []);

  const findItemByKey = useCallback(
    (itemKey: string) => itemByKey.get(itemKey) ?? null,
    [itemByKey],
  );
  const getCurrentItemContext = useCallback((itemKey: string) => {
    const item = itemByKeyRef.current.get(itemKey);
    if (!item) {
      return null;
    }

    const workspaceServices = workspaceServiceLookupRef.current.get(
      buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity),
    );
    if (!workspaceServices) {
      return null;
    }

    return { item, workspaceServices };
  }, []);
  const archiveTimelineItem = useCallback(
    (itemKey: string) => {
      const current = getCurrentItemContext(itemKey);
      if (!current) {
        return;
      }
      const { item, workspaceServices } = current;
      void workspaceServices.services.zcodeTaskService
        .archiveTask({
          taskId: item.taskId,
          workspacePath: item.workspacePath,
          ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
        })
        .then((meta) => {
          removeTaskStateRef.current(item.workspacePath, item.taskId, item.workspaceIdentity);
          if (item.workspaceIdentity) {
            useRemoteTimelineTaskStore
              .getState()
              .removeTask(item.workspacePath, item.taskId, item.workspaceIdentity);
            useRemotePinnedTaskStore
              .getState()
              .removeTask(item.workspacePath, item.taskId, item.workspaceIdentity);
          }
          applyTaskQueryCacheMutation({
            previousTask: item,
            nextTask: meta,
            previousState: {
              pinned: false,
              archived: false,
            },
            nextState: { pinned: false, archived: true },
          });
        });
    },
    [getCurrentItemContext],
  );
  const selectTimelineItem = useCallback((itemKey: string) => {
    const item = itemByKeyRef.current.get(itemKey);
    if (!item) {
      return;
    }
    onSelectTaskRef.current(item.workspacePath, item.taskId, item.workspaceIdentity, item.unreadAt);
  }, []);
  const archiveTimelineItemInline = useCallback(
    (event: ReactMouseEvent, itemKey: string) => {
      event.stopPropagation();
      if (renamingItemKeyRef.current) {
        handleCancelRenameTask();
      }
      if (pendingArchiveItemKeyRef.current !== itemKey) {
        setPendingArchiveItemKey(itemKey);
        return;
      }
      setPendingArchiveItemKey(null);
      archiveTimelineItem(itemKey);
    },
    [archiveTimelineItem, handleCancelRenameTask],
  );
  const toggleTimelineItemPin = useCallback(
    (itemKey: string, pinned: boolean) => {
      const current = getCurrentItemContext(itemKey);
      if (!current) {
        return;
      }
      const { item, workspaceServices } = current;
      if (item.workspaceIdentity && pinned) {
        useRemoteTimelineTaskStore
          .getState()
          .removeTask(item.workspacePath, item.taskId, item.workspaceIdentity);
        useRemotePinnedTaskStore.getState().upsertTask(item);
      }
      applyTaskQueryCacheMutation({
        previousTask: item,
        nextTask: item,
        previousState: { pinned: false, archived: false },
        nextState: { pinned, archived: false },
      });
      void workspaceServices.services.zcodeTaskService
        .setTaskPinned({
          taskId: item.taskId,
          workspacePath: item.workspacePath,
          ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
          pinned,
        })
        .then((meta) => {
          removeOptimisticTaskListItemRef.current(
            item.workspacePath,
            item.taskId,
            item.workspaceIdentity,
          );
          if (item.workspaceIdentity && pinned) {
            useRemotePinnedTaskStore.getState().upsertTask(meta);
            useRemoteTimelineTaskStore
              .getState()
              .removeTask(item.workspacePath, item.taskId, item.workspaceIdentity);
          }
          applyTaskQueryCacheMutation({
            previousTask: item,
            nextTask: meta,
            previousState: { pinned, archived: false },
            nextState: { pinned, archived: false },
          });
        })
        .catch(() => {
          if (item.workspaceIdentity && pinned) {
            useRemotePinnedTaskStore
              .getState()
              .removeTask(item.workspacePath, item.taskId, item.workspaceIdentity);
            useRemoteTimelineTaskStore.getState().upsertTask(item, taskSortByRef.current);
          }
          applyTaskQueryCacheMutation({
            previousTask: item,
            nextTask: item,
            previousState: {
              pinned: false,
              archived: false,
            },
            nextState: { pinned: false, archived: false },
          });
          toast(
            intlRef.current.formatMessage({
              id: "taskList.pinFailed",
            }),
          );
        });
    },
    [getCurrentItemContext],
  );
  const startTimelineItemRename = useCallback((itemKey: string, currentTitle: string) => {
    setPendingArchiveItemKey(null);
    setRenamingItemKey(itemKey);
    setRenameDraft(currentTitle ?? "");
  }, []);
  const archiveTimelineItemFromMenu = useCallback(
    (itemKey: string) => {
      setPendingArchiveItemKey(null);
      handleCancelRenameTask();
      archiveTimelineItem(itemKey);
    },
    [archiveTimelineItem, handleCancelRenameTask],
  );
  const markTimelineItemAsUnread = useCallback(
    (itemKey: string) => {
      const current = getCurrentItemContext(itemKey);
      if (!current) {
        return;
      }
      const { item, workspaceServices } = current;
      void workspaceServices.services.zcodeTaskService
        .setTaskUnread({
          taskId: item.taskId,
          workspacePath: item.workspacePath,
          ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
          unread: true,
        })
        .then((meta) => {
          setTaskUnreadIndicatorRef.current(
            item.workspacePath,
            item.taskId,
            true,
            item.workspaceIdentity,
          );
          upsertOptimisticTaskListItemRef.current(item.workspacePath, meta, item.workspaceIdentity);
          if (item.workspaceIdentity) {
            useRemoteTimelineTaskStore.getState().upsertTask(meta, taskSortByRef.current);
          }
          applyTaskQueryCacheMutation({
            previousTask: item,
            nextTask: meta,
            previousState: {
              pinned: false,
              archived: false,
            },
            nextState: { pinned: false, archived: false },
          });
        });
    },
    [getCurrentItemContext],
  );
  const openTimelineItemContextMenu = useCallback((itemKey: string) => {
    // Timeline rows cache action handlers per itemKey.
    // Menus read confirmation state via ref, so pendingArchiveItemKey never rebuilds callbacks.
    if (pendingArchiveItemKeyRef.current === itemKey) {
      setPendingArchiveItemKey(null);
    }
    setContextMenuItemKey(itemKey);
  }, []);
  const getTimelineTaskItemHandlers = useCallback(
    (itemKey: string) => {
      let handlers = taskItemHandlersByKeyRef.current.get(itemKey);
      if (!handlers) {
        // Trace: every action prop changed via inline closures in map.
        // One handler per itemKey; refs read live item/services at call time.
        handlers = {
          onSelectTask: () => {
            selectTimelineItem(itemKey);
          },
          onArchiveTaskInline: (event) => {
            archiveTimelineItemInline(event, itemKey);
          },
          onTogglePinTask: (_taskId, pinned) => {
            toggleTimelineItemPin(itemKey, pinned);
          },
          onStartRenameTask: (_taskId, currentTitle) => {
            startTimelineItemRename(itemKey, currentTitle);
          },
          onArchiveTask: () => {
            archiveTimelineItemFromMenu(itemKey);
          },
          onMarkTaskAsUnread: () => {
            markTimelineItemAsUnread(itemKey);
          },
          onOpenTaskContextMenu: () => {
            openTimelineItemContextMenu(itemKey);
          },
        };
        taskItemHandlersByKeyRef.current.set(itemKey, handlers);
      }
      return handlers;
    },
    [
      archiveTimelineItemFromMenu,
      archiveTimelineItemInline,
      markTimelineItemAsUnread,
      openTimelineItemContextMenu,
      selectTimelineItem,
      startTimelineItemRename,
      toggleTimelineItemPin,
    ],
  );
  const contextMenuItem = contextMenuItemKey ? findItemByKey(contextMenuItemKey) : null;
  const contextMenuWorkspaceServices = contextMenuItem
    ? workspaceServiceLookup.get(
        buildTaskWorkspaceKey(contextMenuItem.workspacePath, contextMenuItem.workspaceIdentity),
      )
    : null;

  useEffect(() => {
    if (!renamingItemKey) {
      return;
    }

    renameInputRef.current?.focus();
    renameInputRef.current?.select();
  }, [renamingItemKey]);

  useEffect(() => {
    if (!contextMenuItemKey) {
      return;
    }
    if (!findItemByKey(contextMenuItemKey)) {
      setContextMenuItemKey(null);
    }
  }, [contextMenuItemKey, findItemByKey]);

  useEffect(() => {
    for (const itemKey of taskItemHandlersByKeyRef.current.keys()) {
      if (!itemByKey.has(itemKey)) {
        taskItemHandlersByKeyRef.current.delete(itemKey);
      }
    }
  }, [itemByKey]);

  if (items.length === 0 && loading) {
    return (
      <div className="flex min-h-0 flex-col px-2">
        <TaskListLoadingHint />
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="px-3 py-2 text-ui-base text-foreground-subtle">
        {emptyMessage ?? intl.formatMessage({ id: "taskList.noTasks" })}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col">
      {renamingItemKey !== null ? (
        <TaskRenameDialog
          open
          value={renameDraft}
          inputRef={renameInputRef}
          intl={intl}
          onOpenChange={(open) => {
            if (!open) {
              handleCancelRenameTask();
            }
          }}
          onChange={setRenameDraft}
          onCancel={handleCancelRenameTask}
          onConfirm={() => {
            if (!renamingItemKey) {
              return;
            }
            const item = findItemByKey(renamingItemKey);
            if (!item) {
              handleCancelRenameTask();
              return;
            }
            const normalizedTitle = renameDraft.trim();
            if (normalizedTitle === item.title.trim()) {
              handleCancelRenameTask();
              return;
            }
            const workspaceServices = workspaceServiceLookup.get(
              buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity),
            );
            if (!workspaceServices) {
              handleCancelRenameTask();
              return;
            }
            void workspaceServices.services.zcodeTaskService
              .renameTask({
                taskId: item.taskId,
                workspacePath: item.workspacePath,
                ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
                title: normalizedTitle,
              })
              .then((meta) => {
                upsertOptimisticTaskListItem(item.workspacePath, meta, item.workspaceIdentity);
                if (item.workspaceIdentity) {
                  useRemoteTimelineTaskStore.getState().upsertTask(meta, taskSortBy);
                }
                applyTaskQueryCacheMutation({
                  previousTask: item,
                  nextTask: meta,
                  previousState: { pinned: false, archived: false },
                  nextState: { pinned: false, archived: false },
                });
                handleCancelRenameTask();
              })
              .catch(() => {
                toast(intl.formatMessage({ id: "taskList.renameFailed" }));
              });
          }}
        />
      ) : null}
      <ContextMenu
        onOpenChange={(open) => {
          if (!open) {
            setContextMenuItemKey(null);
          }
        }}
      >
        <ContextMenuTrigger asChild>
          <ul className="space-y-1">
            {timelineGroups.map((group) => {
              const labelMessage = group.label ? getTaskTimelineGroupMessage(group.label) : null;
              return (
                <li key={group.key} className="space-y-0.5">
                  {labelMessage ? (
                    <div className="px-3 pt-2 pb-1 text-ui-base font-medium text-foreground-subtle">
                      {intl.formatMessage({ id: labelMessage.id }, labelMessage.values)}
                    </div>
                  ) : null}
                  <ul className="space-y-0.5">
                    {group.items.map((item) => {
                      const itemKey = buildTimelineItemKey(
                        item.workspacePath,
                        item.taskId,
                        item.workspaceIdentity,
                      );
                      const workspaceServices = workspaceServiceLookup.get(
                        buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity),
                      );
                      if (!workspaceServices) {
                        return null;
                      }
                      const handlers = getTimelineTaskItemHandlers(itemKey);
                      return (
                        <MemoTaskItem
                          key={itemKey}
                          workspacePath={item.workspacePath}
                          remoteSessionId={workspaceServices.remoteSessionId}
                          task={item}
                          isPinned={false}
                          variant={taskRowVariant}
                          isActive={
                            // Bugfix: cross-workspace view: active by workspaceKey, or same-path remote cross-highlights.
                            buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity) ===
                              activeWorkspaceKey && item.taskId === activeTaskId
                          }
                          isMobileActive={mobileActiveTaskKey === itemKey}
                          onSelectTask={handlers.onSelectTask}
                          onArchiveTaskInline={handlers.onArchiveTaskInline}
                          onCancelArchiveConfirm={handleCancelArchiveConfirm}
                          isArchiveConfirming={pendingArchiveItemKey === itemKey}
                          onTogglePinTask={handlers.onTogglePinTask}
                          onStartRenameTask={handlers.onStartRenameTask}
                          onArchiveTask={handlers.onArchiveTask}
                          onMarkTaskAsUnread={handlers.onMarkTaskAsUnread}
                          onOpenTaskContextMenu={handlers.onOpenTaskContextMenu}
                          intl={intl}
                        />
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        </ContextMenuTrigger>
        {contextMenuItem && contextMenuWorkspaceServices && contextMenuItemKey ? (
          <TaskListItemContextMenuContent
            workspacePath={contextMenuItem.workspacePath}
            remoteSessionId={contextMenuWorkspaceServices.remoteSessionId}
            task={contextMenuItem}
            isPinned={false}
            intl={intl}
            onTogglePinTask={(_taskId, pinned) => {
              // Local and remote now cache separately; pinning must maintain both memberships
              // or remote tasks linger in the timeline cache after pinning.
              if (contextMenuItem.workspaceIdentity && pinned) {
                useRemoteTimelineTaskStore
                  .getState()
                  .removeTask(
                    contextMenuItem.workspacePath,
                    contextMenuItem.taskId,
                    contextMenuItem.workspaceIdentity,
                  );
                useRemotePinnedTaskStore.getState().upsertTask(contextMenuItem);
              }
              applyTaskQueryCacheMutation({
                previousTask: contextMenuItem,
                nextTask: contextMenuItem,
                previousState: { pinned: false, archived: false },
                nextState: { pinned, archived: false },
              });
              void contextMenuWorkspaceServices.services.zcodeTaskService
                .setTaskPinned({
                  taskId: contextMenuItem.taskId,
                  workspacePath: contextMenuItem.workspacePath,
                  ...(contextMenuItem.workspaceIdentity
                    ? { workspaceIdentity: contextMenuItem.workspaceIdentity }
                    : {}),
                  pinned,
                })
                .then((meta) => {
                  removeOptimisticTaskListItem(
                    contextMenuItem.workspacePath,
                    contextMenuItem.taskId,
                    contextMenuItem.workspaceIdentity,
                  );
                  if (contextMenuItem.workspaceIdentity && pinned) {
                    useRemotePinnedTaskStore.getState().upsertTask(meta);
                    useRemoteTimelineTaskStore
                      .getState()
                      .removeTask(
                        contextMenuItem.workspacePath,
                        contextMenuItem.taskId,
                        contextMenuItem.workspaceIdentity,
                      );
                  }
                  applyTaskQueryCacheMutation({
                    previousTask: contextMenuItem,
                    nextTask: meta,
                    previousState: { pinned, archived: false },
                    nextState: { pinned, archived: false },
                  });
                })
                .catch(() => {
                  if (contextMenuItem.workspaceIdentity && pinned) {
                    useRemotePinnedTaskStore
                      .getState()
                      .removeTask(
                        contextMenuItem.workspacePath,
                        contextMenuItem.taskId,
                        contextMenuItem.workspaceIdentity,
                      );
                    useRemoteTimelineTaskStore.getState().upsertTask(contextMenuItem, taskSortBy);
                  }
                  applyTaskQueryCacheMutation({
                    previousTask: contextMenuItem,
                    nextTask: contextMenuItem,
                    previousState: {
                      pinned: false,
                      archived: false,
                    },
                    nextState: { pinned: false, archived: false },
                  });
                  toast(
                    intl.formatMessage({
                      id: "taskList.pinFailed",
                    }),
                  );
                });
            }}
            onStartRenameTask={(_taskId, currentTitle) => {
              setPendingArchiveItemKey(null);
              setRenamingItemKey(contextMenuItemKey);
              setRenameDraft(currentTitle ?? "");
            }}
            onArchiveTask={() => {
              setPendingArchiveItemKey(null);
              handleCancelRenameTask();
              void contextMenuWorkspaceServices.services.zcodeTaskService
                .archiveTask({
                  taskId: contextMenuItem.taskId,
                  workspacePath: contextMenuItem.workspacePath,
                  ...(contextMenuItem.workspaceIdentity
                    ? { workspaceIdentity: contextMenuItem.workspaceIdentity }
                    : {}),
                })
                .then((meta) => {
                  removeTaskState(
                    contextMenuItem.workspacePath,
                    contextMenuItem.taskId,
                    contextMenuItem.workspaceIdentity,
                  );
                  if (contextMenuItem.workspaceIdentity) {
                    useRemoteTimelineTaskStore
                      .getState()
                      .removeTask(
                        contextMenuItem.workspacePath,
                        contextMenuItem.taskId,
                        contextMenuItem.workspaceIdentity,
                      );
                    useRemotePinnedTaskStore
                      .getState()
                      .removeTask(
                        contextMenuItem.workspacePath,
                        contextMenuItem.taskId,
                        contextMenuItem.workspaceIdentity,
                      );
                  }
                  applyTaskQueryCacheMutation({
                    previousTask: contextMenuItem,
                    nextTask: meta,
                    previousState: {
                      pinned: false,
                      archived: false,
                    },
                    nextState: { pinned: false, archived: true },
                  });
                });
            }}
            onMarkTaskAsUnread={() => {
              void contextMenuWorkspaceServices.services.zcodeTaskService
                .setTaskUnread({
                  taskId: contextMenuItem.taskId,
                  workspacePath: contextMenuItem.workspacePath,
                  ...(contextMenuItem.workspaceIdentity
                    ? { workspaceIdentity: contextMenuItem.workspaceIdentity }
                    : {}),
                  unread: true,
                })
                .then((meta) => {
                  setTaskUnreadIndicator(
                    contextMenuItem.workspacePath,
                    contextMenuItem.taskId,
                    true,
                    contextMenuItem.workspaceIdentity,
                  );
                  upsertOptimisticTaskListItem(
                    contextMenuItem.workspacePath,
                    meta,
                    contextMenuItem.workspaceIdentity,
                  );
                  if (contextMenuItem.workspaceIdentity) {
                    useRemoteTimelineTaskStore.getState().upsertTask(meta, taskSortBy);
                  }
                  applyTaskQueryCacheMutation({
                    previousTask: contextMenuItem,
                    nextTask: meta,
                    previousState: {
                      pinned: false,
                      archived: false,
                    },
                    nextState: { pinned: false, archived: false },
                  });
                });
            }}
          />
        ) : null}
      </ContextMenu>
      {syncingRemoteWorkspaces ? <TaskListRemoteSyncHint /> : null}
      {canLoadMore ? (
        <div className="cursor-pointer pl-8.5 pb-4">
          <span
            className="text-ui-base text-foreground-subtlest hover:text-foreground-subtle"
            onClick={() => {
              // One-way paging: each click adds one 20 step.
              // No show-fewer toggle; button state must match real pagination.
              setVisibleTaskLimit((current) => current + collapsedLimit);
            }}
          >
            {intl.formatMessage({
              id: "taskList.showMore",
            })}
          </span>
        </div>
      ) : null}
    </div>
  );
}
