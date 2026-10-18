/* eslint-disable max-lines -- descriptor, membership and mutation of the task query cache must share one Zustand transaction; splitting raises consistency risk. */
import { create } from "zustand";
import type { ZCodeTaskListItem } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { matchesTaskListMembershipKind } from "@zcode/shared/zcode-protocol-v4";
import { mergeTaskMetaCandidates } from "@/lib/zcodeTaskMetaMerge.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { getTaskListRowActivity, mergeTaskListMembershipFields } from "@/v4/taskListRowActivity.js";
import {
  buildTaskEntityKey,
  buildTaskWorkspaceKey,
  type CachedTaskListResult,
  type TaskListCacheDescriptor,
  type TaskEntityKey,
  type TaskListCacheKey,
} from "@/lib/taskQueryCache.js";
import { notifyTaskLifecycle } from "@/lib/taskLifecycleEvents.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

export interface TaskListMembershipState {
  pinned: boolean;
  archived: boolean;
}

interface TaskQueryCacheState {
  resultsByQueryKey: Record<TaskListCacheKey, CachedTaskListResult>;
  taskMetaByEntityKey: Record<TaskEntityKey, CachedTaskListItem>;
  /** unreadAt overriding a committing/membership-pending value; null clears. */
  taskUnreadOverlayByEntityKey: Record<TaskEntityKey, number | null>;
  setQueryResult: (params: {
    queryKey: TaskListCacheKey;
    descriptor: TaskListCacheDescriptor;
    items: CachedTaskListItem[];
    total: number;
    hasMore: boolean;
    unreadTaskKeys?: TaskEntityKey[];
    partial?: boolean;
    loadingShardKeys?: string[];
    failedShardKeys?: string[];
  }) => void;
  setQueryResults: (
    entries: Array<{
      queryKey: TaskListCacheKey;
      descriptor: TaskListCacheDescriptor;
      items: CachedTaskListItem[];
      total: number;
      hasMore: boolean;
      unreadTaskKeys?: TaskEntityKey[];
      partial?: boolean;
      loadingShardKeys?: string[];
      failedShardKeys?: string[];
      /** invalidationVersion observed when this async query started; on mismatch the whole result is dropped. */
      expectedInvalidationVersion?: number;
    }>,
  ) => void;
  upsertTaskMeta: (task: ZCodeTaskMeta) => void;
  updateTaskMetaPreservingMembership: (task: ZCodeTaskMeta) => void;
  applyTaskMutation: (params: {
    previousTask: ZCodeTaskMeta;
    nextTask: ZCodeTaskMeta;
    previousState: TaskListMembershipState;
    nextState: TaskListMembershipState;
  }) => void;
  setTaskUnreadOverlay: (
    task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
    unreadAt: number | undefined,
  ) => void;
  reconcileTaskUnread: (
    task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
    unreadAt: number | undefined,
  ) => void;
  rollbackTaskUnread: (
    task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
    unreadAt: number | undefined,
  ) => void;
  removeTask: (
    task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  ) => boolean;
  markWorkspaceKeysStale: (workspaceKeys: string[]) => void;
  invalidateWorkspaceKeys: (workspaceKeys: string[]) => void;
  clearAll: () => void;
}

type CachedTaskListItem = ZCodeTaskListItem & { searchSnippets?: string[] };

function buildCachedTaskListResult(params: {
  descriptor: TaskListCacheDescriptor;
  taskKeys: TaskEntityKey[];
  unreadTaskKeys?: TaskEntityKey[];
  searchSnippetsByTaskKey?: Record<TaskEntityKey, string>;
  searchSnippetListsByTaskKey?: Record<TaskEntityKey, string[]>;
  total: number;
  hasMore: boolean;
  partial?: boolean;
  loadingShardKeys?: string[];
  failedShardKeys?: string[];
  invalidationVersion?: number;
}): CachedTaskListResult {
  return {
    taskKeys: params.taskKeys,
    unreadTaskKeys: params.unreadTaskKeys,
    searchSnippetsByTaskKey: params.searchSnippetsByTaskKey,
    searchSnippetListsByTaskKey: params.searchSnippetListsByTaskKey,
    total: params.total,
    hasMore: params.hasMore,
    fetchedAt: Date.now(),
    invalidationVersion: params.invalidationVersion ?? 0,
    stale: false,
    partial: params.partial ?? false,
    loadingShardKeys: params.loadingShardKeys ?? [],
    failedShardKeys: params.failedShardKeys ?? [],
    descriptor: params.descriptor,
  };
}

function matchesTaskMembership(
  descriptor: TaskListCacheDescriptor,
  membership: TaskListMembershipState,
): boolean {
  const kind = descriptor.kind === "workspace" ? "timeline" : descriptor.kind;
  return matchesTaskListMembershipKind(membership, kind);
}

function matchesTaskSearch(descriptor: TaskListCacheDescriptor, task: ZCodeTaskMeta): boolean {
  if (!descriptor.search) {
    return true;
  }

  return task.title.toLocaleLowerCase().includes(descriptor.search);
}

function matchesTaskDescriptor(
  descriptor: TaskListCacheDescriptor,
  task: ZCodeTaskMeta,
  membership: TaskListMembershipState,
): boolean {
  const workspaceKey = buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity);
  if (!descriptor.workspaceKeys.includes(workspaceKey)) {
    return false;
  }

  return matchesTaskMembership(descriptor, membership) && matchesTaskSearch(descriptor, task);
}

function sortTaskKeysByDescriptor(params: {
  taskKeys: TaskEntityKey[];
  taskMetaByEntityKey: Record<TaskEntityKey, ZCodeTaskListItem>;
  descriptor: TaskListCacheDescriptor;
}): TaskEntityKey[] {
  const uniqueTaskKeys = [...new Set(params.taskKeys)];
  return uniqueTaskKeys.sort((leftKey, rightKey) => {
    const leftTask = params.taskMetaByEntityKey[leftKey];
    const rightTask = params.taskMetaByEntityKey[rightKey];
    if (!leftTask && !rightTask) {
      return leftKey.localeCompare(rightKey);
    }
    if (!leftTask) {
      return 1;
    }
    if (!rightTask) {
      return -1;
    }
    return compareZCodeTaskListItems(leftTask, rightTask, params.descriptor.sortBy);
  });
}

// republish (membership refetch, sessions-index frames) always mints fresh item references.
// Swapping references on unchanged content would renew taskMetaByEntityKey and derived items memos wholesale,
// invalidating every row. Compare field by field and keep the old reference when equal.
// Nested fields (lastError/target) compare via JSON; task meta is small, the cost is fine.
function areCachedTaskListItemsEquivalent(
  left: CachedTaskListItem,
  right: CachedTaskListItem,
): boolean {
  if (left === right) {
    return true;
  }
  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  if (leftKeys.length !== Object.keys(rightRecord).length) {
    return false;
  }
  for (const key of leftKeys) {
    const leftValue = leftRecord[key];
    const rightValue = rightRecord[key];
    if (leftValue === rightValue) {
      continue;
    }
    if (
      typeof leftValue === "object" &&
      leftValue !== null &&
      typeof rightValue === "object" &&
      rightValue !== null
    ) {
      if (JSON.stringify(leftValue) !== JSON.stringify(rightValue)) {
        return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

function mergeIncomingTaskListItem(params: {
  item: CachedTaskListItem;
  existingItem: CachedTaskListItem | undefined;
  descriptor: TaskListCacheDescriptor;
  hasUnreadOverlay: boolean;
  unreadAtOverlay: number | null | undefined;
}): CachedTaskListItem {
  const incomingActivity = getTaskListRowActivity(params.item);
  const existingActivity = params.existingItem ? getTaskListRowActivity(params.existingItem) : null;
  // Search results come from tasks-index, but the entity cache may already hold sessions-index activity.
  // Keep the sidecar on merge, or running/awaiting-confirm vanish as soon as the user types a query.
  const incomingWithActivity =
    params.descriptor.search && params.existingItem && existingActivity && !incomingActivity
      ? (mergeTaskListMembershipFields(params.existingItem, params.item) as CachedTaskListItem)
      : params.item;
  const keepExistingNonPlaceholderTitle =
    params.existingItem &&
    incomingActivity &&
    (params.item.title.trim().length === 0 ||
      params.item.title.trim().toLocaleLowerCase() === "new session") &&
    params.existingItem.title.trim().length > 0 &&
    params.existingItem.title.trim().toLocaleLowerCase() !== "new session";
  // Non-search incoming items are sessions-index activity + the latest membership join;
  // never let tasks-index updatedAt win whole-meta, or rename/unread replies overwrite live
  // phase/lastActivityAt. Keep only the first-seen title and non-activity display fields until sessions-index fills in.
  const mergedItem = params.descriptor.search
    ? incomingWithActivity
    : ({
        ...incomingWithActivity,
        ...(keepExistingNonPlaceholderTitle ? { title: params.existingItem?.title } : {}),
        changeSummary: incomingWithActivity.changeSummary ?? params.existingItem?.changeSummary,
        model: incomingWithActivity.model ?? params.existingItem?.model,
        provider: incomingWithActivity.provider ?? params.existingItem?.provider,
      } as CachedTaskListItem);
  const itemWithUnreadOverlay = params.hasUnreadOverlay
    ? ({
        ...mergedItem,
        unreadAt: params.unreadAtOverlay ?? undefined,
      } as CachedTaskListItem)
    : mergedItem;
  const nextItem =
    params.descriptor.search || !params.existingItem?.searchSnippet
      ? itemWithUnreadOverlay
      : {
          ...itemWithUnreadOverlay,
          searchSnippet: params.existingItem.searchSnippet,
          searchSnippets: params.existingItem.searchSnippets,
        };
  // Reference stability: when the merge equals the current value, keep the old object so downstream memos/shallow compares short-circuit.
  return params.existingItem && areCachedTaskListItemsEquivalent(nextItem, params.existingItem)
    ? params.existingItem
    : nextItem;
}

// When a republish is fully equivalent to the cache, skip the whole setState
// so resultsByQueryKey/taskMetaByEntityKey keep references and no list re-renders needlessly.
// fetchedAt/stale are excluded (keeping old values is correct; the preserve window just stays conservative).
function isQueryResultEquivalent(params: {
  previousResult: CachedTaskListResult | undefined;
  taskKeys: TaskEntityKey[];
  unreadTaskKeys?: TaskEntityKey[];
  searchSnippetsByTaskKey?: Record<TaskEntityKey, string>;
  searchSnippetListsByTaskKey?: Record<TaskEntityKey, string[]>;
  total: number;
  hasMore: boolean;
  partial: boolean;
  loadingShardKeys: string[];
  failedShardKeys: string[];
}): boolean {
  const previous = params.previousResult;
  if (!previous || previous.stale) {
    return false;
  }
  if (
    previous.total !== params.total ||
    previous.hasMore !== params.hasMore ||
    previous.partial !== params.partial
  ) {
    return false;
  }
  if (
    previous.taskKeys.length !== params.taskKeys.length ||
    previous.taskKeys.some((taskKey, index) => taskKey !== params.taskKeys[index])
  ) {
    return false;
  }
  const sameStringArray = (left: string[], right: string[]) =>
    left.length === right.length && left.every((value, index) => value === right[index]);
  if (
    !sameStringArray(previous.unreadTaskKeys ?? [], params.unreadTaskKeys ?? []) ||
    !sameStringArray(previous.loadingShardKeys, params.loadingShardKeys) ||
    !sameStringArray(previous.failedShardKeys, params.failedShardKeys)
  ) {
    return false;
  }
  return (
    JSON.stringify(previous.searchSnippetsByTaskKey ?? null) ===
      JSON.stringify(params.searchSnippetsByTaskKey ?? null) &&
    JSON.stringify(previous.searchSnippetListsByTaskKey ?? null) ===
      JSON.stringify(params.searchSnippetListsByTaskKey ?? null)
  );
}

function preserveFreshLocalTaskKeys(params: {
  incomingTaskKeys: TaskEntityKey[];
  previousResult: CachedTaskListResult | undefined;
  taskMetaByEntityKey: Record<TaskEntityKey, CachedTaskListItem>;
  descriptor: TaskListCacheDescriptor;
}): { taskKeys: TaskEntityKey[]; preservedCount: number } {
  if (!params.previousResult || params.descriptor.search) {
    return { taskKeys: params.incomingTaskKeys, preservedCount: 0 };
  }

  const previousResult = params.previousResult;
  const incomingTaskKeySet = new Set(params.incomingTaskKeys);
  const preservedTaskKeys = previousResult.taskKeys.filter((taskKey) => {
    if (incomingTaskKeySet.has(taskKey)) {
      return false;
    }
    const task = params.taskMetaByEntityKey[taskKey];
    return Boolean(task && task.updatedAt > previousResult.fetchedAt);
  });
  if (preservedTaskKeys.length === 0) {
    return { taskKeys: params.incomingTaskKeys, preservedCount: 0 };
  }

  const sortedTaskKeys = sortTaskKeysByDescriptor({
    // A sqlite list refresh can land after the first-send optimistic insert.
    // Keep only keys whose local update is newer than the last list snapshot, so a stale refresh never erases the new task from the sidebar.
    taskKeys: [...params.incomingTaskKeys, ...preservedTaskKeys],
    taskMetaByEntityKey: params.taskMetaByEntityKey,
    descriptor: params.descriptor,
  });
  const visibleTaskKeys =
    params.descriptor.visibleLimit === null
      ? sortedTaskKeys
      : sortedTaskKeys.slice(0, params.descriptor.visibleLimit);
  return {
    taskKeys: visibleTaskKeys,
    preservedCount: preservedTaskKeys.length,
  };
}

export const useTaskQueryCacheStore = create<TaskQueryCacheState>()((set) => ({
  resultsByQueryKey: {},
  taskMetaByEntityKey: {},
  taskUnreadOverlayByEntityKey: {},
  setQueryResult: ({
    queryKey,
    descriptor,
    items,
    total,
    hasMore,
    unreadTaskKeys,
    partial,
    loadingShardKeys,
    failedShardKeys,
  }) =>
    set((state) => {
      const nextTaskMetaByEntityKey = { ...state.taskMetaByEntityKey };
      let taskMetaChanged = false;
      let taskUnreadOverlayChanged = false;
      const nextTaskUnreadOverlayByEntityKey = {
        ...state.taskUnreadOverlayByEntityKey,
      };
      const searchSnippetsByTaskKey: Record<TaskEntityKey, string> = {};
      const searchSnippetListsByTaskKey: Record<TaskEntityKey, string[]> = {};
      const incomingTaskKeys = items.map((item) => {
        const entityKey = buildTaskEntityKey(item);
        if (item.searchSnippet) {
          searchSnippetsByTaskKey[entityKey] = item.searchSnippet;
        }
        if (item.searchSnippets?.length) {
          searchSnippetListsByTaskKey[entityKey] = item.searchSnippets;
        }
        const existingItem = nextTaskMetaByEntityKey[entityKey];
        const hasUnreadOverlay = Object.prototype.hasOwnProperty.call(
          state.taskUnreadOverlayByEntityKey,
          entityKey,
        );
        const unreadAtOverlay = state.taskUnreadOverlayByEntityKey[entityKey];
        const mergedItem = mergeIncomingTaskListItem({
          item,
          existingItem,
          descriptor,
          hasUnreadOverlay,
          unreadAtOverlay,
        });
        if (
          hasUnreadOverlay &&
          (unreadAtOverlay === null
            ? typeof item.unreadAt !== "number"
            : item.unreadAt === unreadAtOverlay)
        ) {
          // An RPC success does not mean every in-flight membership query has landed.
          // Release the overlay only once a query really publishes the same value; stale replies never overwrite newer state.
          delete nextTaskUnreadOverlayByEntityKey[entityKey];
          taskUnreadOverlayChanged = true;
        }
        if (mergedItem !== existingItem) {
          taskMetaChanged = true;
          nextTaskMetaByEntityKey[entityKey] = mergedItem;
        }
        return entityKey;
      });
      const { taskKeys, preservedCount } = preserveFreshLocalTaskKeys({
        incomingTaskKeys,
        previousResult: state.resultsByQueryKey[queryKey],
        taskMetaByEntityKey: nextTaskMetaByEntityKey,
        descriptor,
      });

      const resultParams = {
        descriptor,
        taskKeys,
        unreadTaskKeys,
        searchSnippetsByTaskKey:
          Object.keys(searchSnippetsByTaskKey).length > 0 ? searchSnippetsByTaskKey : undefined,
        searchSnippetListsByTaskKey:
          Object.keys(searchSnippetListsByTaskKey).length > 0
            ? searchSnippetListsByTaskKey
            : undefined,
        total:
          preservedCount > 0
            ? Math.max(total, state.resultsByQueryKey[queryKey]?.total ?? 0, taskKeys.length)
            : total,
        hasMore:
          hasMore ||
          (preservedCount > 0 &&
            Math.max(total, state.resultsByQueryKey[queryKey]?.total ?? 0, taskKeys.length) >
              taskKeys.length),
        partial,
        loadingShardKeys,
        failedShardKeys,
        invalidationVersion: state.resultsByQueryKey[queryKey]?.invalidationVersion ?? 0,
      };
      // Skip setState when content equals the cache, so a republish never invalidates whole lists.
      if (
        !taskMetaChanged &&
        !taskUnreadOverlayChanged &&
        isQueryResultEquivalent({
          previousResult: state.resultsByQueryKey[queryKey],
          taskKeys,
          unreadTaskKeys: resultParams.unreadTaskKeys,
          searchSnippetsByTaskKey: resultParams.searchSnippetsByTaskKey,
          searchSnippetListsByTaskKey: resultParams.searchSnippetListsByTaskKey,
          total: resultParams.total,
          hasMore: resultParams.hasMore,
          partial: partial ?? false,
          loadingShardKeys: loadingShardKeys ?? [],
          failedShardKeys: failedShardKeys ?? [],
        })
      ) {
        return state;
      }

      return {
        resultsByQueryKey: {
          ...state.resultsByQueryKey,
          [queryKey]: buildCachedTaskListResult(resultParams),
        },
        taskMetaByEntityKey: taskMetaChanged ? nextTaskMetaByEntityKey : state.taskMetaByEntityKey,
        taskUnreadOverlayByEntityKey: taskUnreadOverlayChanged
          ? nextTaskUnreadOverlayByEntityKey
          : state.taskUnreadOverlayByEntityKey,
      };
    }),
  setQueryResults: (entries) =>
    set((state) => {
      if (entries.length === 0) {
        return state;
      }

      const nextTaskMetaByEntityKey = { ...state.taskMetaByEntityKey };
      let taskMetaChanged = false;
      let taskUnreadOverlayChanged = false;
      const nextTaskUnreadOverlayByEntityKey = {
        ...state.taskUnreadOverlayByEntityKey,
      };
      const nextResultsByQueryKey = { ...state.resultsByQueryKey };
      let resultsChanged = false;

      for (const entry of entries) {
        const previousResult = state.resultsByQueryKey[entry.queryKey];
        const currentInvalidationVersion = previousResult?.invalidationVersion ?? 0;
        if (
          entry.expectedInvalidationVersion !== undefined &&
          entry.expectedInvalidationVersion !== currentInvalidationVersion
        ) {
          // sessions-index activity and tasks-index membership join asynchronously.
          // On re-invalidation while in flight, the stale result must not write entities, release the unread overlay or mark the query fresh;
          // the hook recomputes from the latest activity/membership revisions.
          continue;
        }
        const searchSnippetsByTaskKey: Record<TaskEntityKey, string> = {};
        const searchSnippetListsByTaskKey: Record<TaskEntityKey, string[]> = {};
        const incomingTaskKeys = entry.items.map((item) => {
          const entityKey = buildTaskEntityKey(item);
          if (item.searchSnippet) {
            searchSnippetsByTaskKey[entityKey] = item.searchSnippet;
          }
          if (item.searchSnippets?.length) {
            searchSnippetListsByTaskKey[entityKey] = item.searchSnippets;
          }
          const existingItem = nextTaskMetaByEntityKey[entityKey];
          const hasUnreadOverlay = Object.prototype.hasOwnProperty.call(
            state.taskUnreadOverlayByEntityKey,
            entityKey,
          );
          const unreadAtOverlay = state.taskUnreadOverlayByEntityKey[entityKey];
          const mergedItem = mergeIncomingTaskListItem({
            item,
            existingItem,
            descriptor: entry.descriptor,
            hasUnreadOverlay,
            unreadAtOverlay,
          });
          if (
            hasUnreadOverlay &&
            (unreadAtOverlay === null
              ? typeof item.unreadAt !== "number"
              : item.unreadAt === unreadAtOverlay)
          ) {
            delete nextTaskUnreadOverlayByEntityKey[entityKey];
            taskUnreadOverlayChanged = true;
          }
          if (mergedItem !== existingItem) {
            taskMetaChanged = true;
            nextTaskMetaByEntityKey[entityKey] = mergedItem;
          }
          return entityKey;
        });
        const { taskKeys, preservedCount } = preserveFreshLocalTaskKeys({
          incomingTaskKeys,
          previousResult,
          taskMetaByEntityKey: nextTaskMetaByEntityKey,
          descriptor: entry.descriptor,
        });

        const resultParams = {
          descriptor: entry.descriptor,
          taskKeys,
          unreadTaskKeys: entry.unreadTaskKeys,
          searchSnippetsByTaskKey:
            Object.keys(searchSnippetsByTaskKey).length > 0 ? searchSnippetsByTaskKey : undefined,
          searchSnippetListsByTaskKey:
            Object.keys(searchSnippetListsByTaskKey).length > 0
              ? searchSnippetListsByTaskKey
              : undefined,
          total:
            preservedCount > 0
              ? Math.max(entry.total, previousResult?.total ?? 0, taskKeys.length)
              : entry.total,
          hasMore:
            entry.hasMore ||
            (preservedCount > 0 &&
              Math.max(entry.total, previousResult?.total ?? 0, taskKeys.length) > taskKeys.length),
          partial: entry.partial,
          loadingShardKeys: entry.loadingShardKeys,
          failedShardKeys: entry.failedShardKeys,
          invalidationVersion: currentInvalidationVersion,
        };
        // Same equality short-circuit as the single setQueryResult: unchanged entries keep their result references.
        if (
          isQueryResultEquivalent({
            previousResult,
            taskKeys,
            unreadTaskKeys: resultParams.unreadTaskKeys,
            searchSnippetsByTaskKey: resultParams.searchSnippetsByTaskKey,
            searchSnippetListsByTaskKey: resultParams.searchSnippetListsByTaskKey,
            total: resultParams.total,
            hasMore: resultParams.hasMore,
            partial: entry.partial ?? false,
            loadingShardKeys: entry.loadingShardKeys ?? [],
            failedShardKeys: entry.failedShardKeys ?? [],
          })
        ) {
          continue;
        }
        resultsChanged = true;
        nextResultsByQueryKey[entry.queryKey] = buildCachedTaskListResult(resultParams);
      }

      if (!taskMetaChanged && !resultsChanged && !taskUnreadOverlayChanged) {
        return state;
      }

      return {
        resultsByQueryKey: resultsChanged ? nextResultsByQueryKey : state.resultsByQueryKey,
        taskMetaByEntityKey: taskMetaChanged ? nextTaskMetaByEntityKey : state.taskMetaByEntityKey,
        taskUnreadOverlayByEntityKey: taskUnreadOverlayChanged
          ? nextTaskUnreadOverlayByEntityKey
          : state.taskUnreadOverlayByEntityKey,
      };
    }),
  upsertTaskMeta: (task) =>
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      const existingTask = state.taskMetaByEntityKey[entityKey];
      // On restart restore, a raw session snapshot can land in the query cache before the list refresh.
      // Merge with existing indexed meta, or a snapshot missing titleOverridden clobbers the manual rename.
      const mergedTask = mergeTaskMetaCandidates(task, existingTask) ?? task;
      const nextTask = getTaskListRowActivity(task)
        ? mergeTaskListMembershipFields(task, mergedTask)
        : existingTask
          ? mergeTaskListMembershipFields(existingTask, mergedTask)
          : mergedTask;
      return {
        ...state,
        taskMetaByEntityKey: {
          ...state.taskMetaByEntityKey,
          [entityKey]: nextTask,
        },
      };
    }),
  updateTaskMetaPreservingMembership: (task) =>
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      const existingTask = state.taskMetaByEntityKey[entityKey];
      // workspace_task_list_changed may carry runtime-snapshot projected titles.
      // Keep the query-cache manual-rename truth; take only status/updatedAt runtime fields from the new meta.
      const mergedTask = mergeTaskMetaCandidates(task, existingTask) ?? task;
      // The tasks-index updatedAt on workspace_task_list_changed
      // is metadata, not real session activity. With a sessions-index sidecar present,
      // merge membership/meta fields only, or rename/unread bounce tasks to the top wrongly.
      const nextTask = existingTask
        ? mergeTaskListMembershipFields(existingTask, mergedTask)
        : mergedTask;
      const nextTaskMetaByEntityKey = {
        ...state.taskMetaByEntityKey,
        [entityKey]: nextTask,
      };
      const nextResultsByQueryKey = { ...state.resultsByQueryKey };

      for (const [queryKey, result] of Object.entries(state.resultsByQueryKey)) {
        if (!result.taskKeys.includes(entityKey)) {
          continue;
        }

        // The meta delta of workspace_task_list_changed says content/status changed,
        // not pinned/archived membership; re-sort only lists already containing the task, never pull it out of pinned.
        nextResultsByQueryKey[queryKey] = {
          ...result,
          taskKeys: sortTaskKeysByDescriptor({
            taskKeys: result.taskKeys,
            taskMetaByEntityKey: nextTaskMetaByEntityKey,
            descriptor: result.descriptor,
          }),
        };
      }

      return {
        resultsByQueryKey: nextResultsByQueryKey,
        taskMetaByEntityKey: nextTaskMetaByEntityKey,
      };
    }),
  applyTaskMutation: ({ previousTask, nextTask, previousState, nextState }) =>
    set((state) => {
      const previousEntityKey = buildTaskEntityKey(previousTask);
      const nextEntityKey = buildTaskEntityKey(nextTask);
      const existingTask =
        state.taskMetaByEntityKey[nextEntityKey] ?? state.taskMetaByEntityKey[previousEntityKey];
      const mergedNextTask = existingTask
        ? mergeTaskListMembershipFields(existingTask, nextTask)
        : nextTask;
      const nextTaskMetaByEntityKey = {
        ...state.taskMetaByEntityKey,
        [nextEntityKey]: mergedNextTask,
      };
      if (previousEntityKey !== nextEntityKey) {
        delete nextTaskMetaByEntityKey[previousEntityKey];
      }

      const nextResultsByQueryKey = { ...state.resultsByQueryKey };
      for (const [queryKey, result] of Object.entries(state.resultsByQueryKey)) {
        if (result.descriptor.search) {
          // Body search results follow server sqlite searchable_text; the front end holds only task meta/title,
          // so title-only rules must not decide incremental membership, or body-hit sessions get misfiltered locally.
          nextResultsByQueryKey[queryKey] = {
            ...result,
            invalidationVersion: result.invalidationVersion + 1,
            stale: true,
          };
          continue;
        }

        const previousIncluded = matchesTaskDescriptor(
          result.descriptor,
          previousTask,
          previousState,
        );
        const nextIncluded = matchesTaskDescriptor(result.descriptor, nextTask, nextState);
        const wasVisible =
          result.taskKeys.includes(previousEntityKey) || result.taskKeys.includes(nextEntityKey);

        if (!previousIncluded && !nextIncluded && !wasVisible) {
          continue;
        }

        const taskKeysWithoutTarget = result.taskKeys.filter(
          (taskKey) => taskKey !== previousEntityKey && taskKey !== nextEntityKey,
        );
        const unreadTaskKeysWithoutTarget = (result.unreadTaskKeys ?? []).filter(
          (taskKey) => taskKey !== previousEntityKey && taskKey !== nextEntityKey,
        );
        const visibleCandidateKeys = nextIncluded
          ? [...taskKeysWithoutTarget, nextEntityKey]
          : taskKeysWithoutTarget;
        const nextUnreadTaskKeys =
          nextIncluded && typeof mergedNextTask.unreadAt === "number"
            ? [...unreadTaskKeysWithoutTarget, nextEntityKey]
            : unreadTaskKeysWithoutTarget;
        const sortedTaskKeys = sortTaskKeysByDescriptor({
          taskKeys: visibleCandidateKeys,
          taskMetaByEntityKey: nextTaskMetaByEntityKey,
          descriptor: result.descriptor,
        });
        const visibleTaskKeys =
          result.descriptor.visibleLimit === null
            ? sortedTaskKeys
            : sortedTaskKeys.slice(0, result.descriptor.visibleLimit);
        const nextTotal = Math.max(
          0,
          result.total + Number(nextIncluded) - Number(previousIncluded),
        );
        const shouldBackgroundRefresh =
          result.descriptor.visibleLimit !== null &&
          previousIncluded !== nextIncluded &&
          nextTotal > visibleTaskKeys.length;

        nextResultsByQueryKey[queryKey] = {
          ...result,
          taskKeys: visibleTaskKeys,
          ...(result.unreadTaskKeys ? { unreadTaskKeys: nextUnreadTaskKeys } : {}),
          total: nextTotal,
          hasMore: nextTotal > visibleTaskKeys.length,
          stale: result.stale || shouldBackgroundRefresh,
        };
      }

      return {
        resultsByQueryKey: nextResultsByQueryKey,
        taskMetaByEntityKey: nextTaskMetaByEntityKey,
      };
    }),
  setTaskUnreadOverlay: (task, unreadAt) =>
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      const existingTask = state.taskMetaByEntityKey[entityKey];
      return {
        taskUnreadOverlayByEntityKey: {
          ...state.taskUnreadOverlayByEntityKey,
          [entityKey]: unreadAt ?? null,
        },
        taskMetaByEntityKey: existingTask
          ? {
              ...state.taskMetaByEntityKey,
              [entityKey]: {
                ...existingTask,
                unreadAt,
              },
            }
          : state.taskMetaByEntityKey,
      };
    }),
  reconcileTaskUnread: (task, unreadAt) =>
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      const existingTask = state.taskMetaByEntityKey[entityKey];
      // The server reply confirms persistence only; older membership requests may still return.
      // Hold the overlay at the server value until setQueryResult observes the same, then release automatically.
      return {
        taskUnreadOverlayByEntityKey: {
          ...state.taskUnreadOverlayByEntityKey,
          [entityKey]: unreadAt ?? null,
        },
        taskMetaByEntityKey: existingTask
          ? {
              ...state.taskMetaByEntityKey,
              [entityKey]: {
                ...existingTask,
                unreadAt,
              },
            }
          : state.taskMetaByEntityKey,
      };
    }),
  rollbackTaskUnread: (task, unreadAt) =>
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      const existingTask = state.taskMetaByEntityKey[entityKey];
      const nextOverlays = { ...state.taskUnreadOverlayByEntityKey };
      delete nextOverlays[entityKey];
      return {
        taskUnreadOverlayByEntityKey: nextOverlays,
        taskMetaByEntityKey: existingTask
          ? {
              ...state.taskMetaByEntityKey,
              [entityKey]: {
                ...existingTask,
                unreadAt,
              },
            }
          : state.taskMetaByEntityKey,
      };
    }),
  removeTask: (task) => {
    let removedFromVisibleCache = false;
    set((state) => {
      const entityKey = buildTaskEntityKey(task);
      if (!state.taskMetaByEntityKey[entityKey]) {
        const hasCachedResult = Object.values(state.resultsByQueryKey).some((result) =>
          result.taskKeys.includes(entityKey),
        );
        if (!hasCachedResult) {
          return state;
        }
      }

      const nextTaskMetaByEntityKey = { ...state.taskMetaByEntityKey };
      delete nextTaskMetaByEntityKey[entityKey];
      const nextTaskUnreadOverlayByEntityKey = {
        ...state.taskUnreadOverlayByEntityKey,
      };
      delete nextTaskUnreadOverlayByEntityKey[entityKey];

      const nextResultsByQueryKey: Record<TaskListCacheKey, CachedTaskListResult> = {};
      for (const [queryKey, result] of Object.entries(state.resultsByQueryKey)) {
        if (!result.taskKeys.includes(entityKey)) {
          nextResultsByQueryKey[queryKey] = result;
          continue;
        }

        const taskKeys = result.taskKeys.filter((taskKey) => taskKey !== entityKey);
        removedFromVisibleCache = true;
        // Deletion used to force a full refresh; decrement total only for lists whose visible cache actually has the task.
        // Never guess membership for hidden items outside the collapsed view, or other lists lose counts.
        const total = Math.max(0, result.total - 1);
        nextResultsByQueryKey[queryKey] = {
          ...result,
          taskKeys,
          total,
          hasMore: total > taskKeys.length,
        };
      }

      return {
        resultsByQueryKey: nextResultsByQueryKey,
        taskMetaByEntityKey: nextTaskMetaByEntityKey,
        taskUnreadOverlayByEntityKey: nextTaskUnreadOverlayByEntityKey,
      };
    });
    return removedFromVisibleCache;
  },
  markWorkspaceKeysStale: (workspaceKeys) =>
    set((state) => {
      if (workspaceKeys.length === 0) {
        return state;
      }

      const staleWorkspaceKeySet = new Set(workspaceKeys);
      const nextResultsByQueryKey = { ...state.resultsByQueryKey };
      let changed = false;

      for (const [queryKey, result] of Object.entries(state.resultsByQueryKey)) {
        if (
          !result.descriptor.workspaceKeys.some((workspaceKey) =>
            staleWorkspaceKeySet.has(workspaceKey),
          )
        ) {
          continue;
        }

        // A collapsed/paged hidden task cannot safely decrement total by taskId alone.
        // Keep the visible lists, mark matching workspaces dirty, and let the next hook effect refetch counts for real.
        nextResultsByQueryKey[queryKey] = {
          ...result,
          invalidationVersion: result.invalidationVersion + 1,
          stale: true,
        };
        changed = true;
      }

      if (!changed) {
        return state;
      }

      return {
        resultsByQueryKey: nextResultsByQueryKey,
      };
    }),
  invalidateWorkspaceKeys: (workspaceKeys) =>
    set((state) => {
      if (workspaceKeys.length === 0) {
        return state;
      }

      const invalidatedWorkspaceKeySet = new Set(workspaceKeys);
      const nextResultsByQueryKey = Object.fromEntries(
        Object.entries(state.resultsByQueryKey).filter(([queryKey]) => {
          return ![...invalidatedWorkspaceKeySet].some(
            (workspaceKey) =>
              queryKey.includes(`workspaces=${workspaceKey}`) ||
              queryKey.includes(`|${workspaceKey}`),
          );
        }),
      );
      const nextTaskMetaByEntityKey = Object.fromEntries(
        Object.entries(state.taskMetaByEntityKey).filter(([entityKey]) => {
          const workspaceKey = entityKey.split("::")[0] ?? "";
          return !invalidatedWorkspaceKeySet.has(workspaceKey);
        }),
      );

      return {
        resultsByQueryKey: nextResultsByQueryKey,
        taskMetaByEntityKey: nextTaskMetaByEntityKey,
      };
    }),
  clearAll: () =>
    set(() => ({
      // clearAll is a Zustand action and must write back via set.
      // Returning the object alone left stale task meta behind in tests/dev cache clears.
      resultsByQueryKey: {},
      taskMetaByEntityKey: {},
      taskUnreadOverlayByEntityKey: {},
    })),
}));

export function invalidateTaskQueryCacheByScopes(
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
): void {
  const workspaceKeys = scopes.map((scope) =>
    buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity),
  );
  useTaskQueryCacheStore.getState().invalidateWorkspaceKeys(workspaceKeys);
}

export function markTaskQueryCacheScopesStale(
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
): void {
  const workspaceKeys = scopes.map((scope) =>
    buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity),
  );
  useTaskQueryCacheStore.getState().markWorkspaceKeysStale(workspaceKeys);
}

export function upsertTaskQueryCacheTaskMeta(task: ZCodeTaskMeta): void {
  useTaskQueryCacheStore.getState().upsertTaskMeta(task);
}

export function updateTaskQueryCacheTaskMetaPreservingMembership(task: ZCodeTaskMeta): void {
  useTaskQueryCacheStore.getState().updateTaskMetaPreservingMembership(task);
}

export function applyTaskQueryCacheMutation(params: {
  previousTask: ZCodeTaskMeta;
  nextTask: ZCodeTaskMeta;
  previousState: TaskListMembershipState;
  nextState: TaskListMembershipState;
}): void {
  useTaskQueryCacheStore.getState().applyTaskMutation(params);
  if (!params.previousState.archived && params.nextState.archived) {
    notifyTaskLifecycle({
      type: "archived",
      taskId: params.nextTask.taskId,
      workspaceKey: buildTaskWorkspaceKey(
        params.nextTask.workspacePath,
        params.nextTask.workspaceIdentity,
      ),
    });
  }
}

export function setTaskQueryCacheUnreadOverlay(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  unreadAt: number | undefined,
): void {
  useTaskQueryCacheStore.getState().setTaskUnreadOverlay(task, unreadAt);
}

export function reconcileTaskQueryCacheUnread(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  unreadAt: number | undefined,
): void {
  useTaskQueryCacheStore.getState().reconcileTaskUnread(task, unreadAt);
}

export function rollbackTaskQueryCacheUnread(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
  unreadAt: number | undefined,
): void {
  useTaskQueryCacheStore.getState().rollbackTaskUnread(task, unreadAt);
}

export function removeTaskFromTaskQueryCaches(
  task: Pick<ZCodeTaskMeta, "taskId" | "workspacePath" | "workspaceIdentity">,
): boolean {
  const removed = useTaskQueryCacheStore.getState().removeTask(task);
  notifyTaskLifecycle({
    type: "deleted",
    taskId: task.taskId,
    workspaceKey: buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
  });
  return removed;
}

// In-memory diagnostic counter: versioned queryKeys only grow, never shrink; log it.
uiMemoryDiagnosticsRegistry.register("taskQueryCache", () => {
  const state = useTaskQueryCacheStore.getState();
  return {
    queryKeys: Object.keys(state.resultsByQueryKey).length,
    taskMetas: Object.keys(state.taskMetaByEntityKey).length,
  };
});
