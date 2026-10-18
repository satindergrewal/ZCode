/* eslint-disable max-lines -- The grouped view hook keeps optimistic overlay, sort persistence, and ungroup persistence together; splitting it would let the same view state drift across hooks. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type {
  ZCodeGroupedTaskView,
  ZCodeGroupedTaskViewOrderInput,
  ZCodeGroupedTaskViewStructure,
  ZCodeGroupedTaskViewTopLevelNodeRef,
  ZCodeTaskGroup,
  ZCodeTaskGroupColor,
} from "@zcode/services";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useLocalWorkspaceScopes } from "@/hooks/useLocalWorkspaceScopes.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { logger } from "@/logger.js";
import { buildGroupedTaskViewFromSessions } from "@/lib/buildGroupedTaskViewFromSessions.js";
import { mergeTaskListMembershipFields } from "@/v4/taskListRowActivity.js";
import { fetchTaskListMembershipSets } from "@/lib/taskListMembershipSets.js";
import { useTaskListMembershipVersion } from "@/v4/taskListMembershipVersion.js";
import { useGlobalTaskList } from "@/hooks/useGlobalTaskList.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { buildTaskEntityKey, buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { mergeTaskWithOptimisticMeta } from "@/lib/zcodeTaskMetaMerge.js";
import {
  useWorkspaceTaskOptimisticOverlayByWorkspaceKey,
  type WorkspaceOptimisticTaskOverlay,
} from "@/hooks/workspaceTaskListOptimisticOverlay.js";
import { moveTaskToGroupStart } from "@/workspace-grouped-tasks/view.js";
import { areStabilizedValuesEquivalent } from "@/v4/taskListItemStabilization.js";
import { taskKey as groupedTaskKey } from "@/workspace-grouped-tasks/ids.js";

function applyPromotedGroupPlacements(
  view: ZCodeGroupedTaskView,
  promotedDraftByTaskKey: ReadonlyMap<
    string,
    WorkspaceOptimisticTaskOverlay["promotedGroupedDraftTaskByTaskId"][string]
  >,
  optimisticTaskByKey: ReadonlyMap<string, ZCodeTaskMeta>,
): ZCodeGroupedTaskView {
  let nextView = view;
  for (const [taskKey, promotedDraft] of promotedDraftByTaskKey) {
    if (promotedDraft.placement.type === "top") {
      const rootIndex = nextView.nodes.findIndex(
        (node) => node.type === "task" && buildTaskEntityKey(node.task) === taskKey,
      );
      if (rootIndex <= 0) continue;
      // When sessions-index and the grouped structure land out of order, a missing task is
      // temporarily appended to the end. Keep the draft's root-top slot until the promoted
      // state settles so the row does not jump to the bottom and back.
      const nodes = [...nextView.nodes];
      const [rootTask] = nodes.splice(rootIndex, 1);
      if (rootTask) nodes.unshift(rootTask);
      nextView = { nodes };
      continue;
    }
    const task = optimisticTaskByKey.get(taskKey);
    if (!task) {
      continue;
    }
    if (isTaskFirstInGroup(nextView, taskKey, promotedDraft.placement.groupId)) {
      continue;
    }
    nextView = moveTaskToGroupStart(nextView, {
      activeTaskKey: groupedTaskKey(task),
      groupId: promotedDraft.placement.groupId,
    });
  }
  return nextView;
}

function findTaskInGroupedView(
  view: ZCodeGroupedTaskView,
  taskEntityKey: string,
): ZCodeTaskMeta | undefined {
  for (const node of view.nodes) {
    if (node.type === "group") {
      const task = node.tasks.find((candidate) => buildTaskEntityKey(candidate) === taskEntityKey);
      if (task) return task;
      continue;
    }
    if (buildTaskEntityKey(node.task) === taskEntityKey) return node.task;
  }
  return undefined;
}

function isTaskFirstInGroup(
  view: ZCodeGroupedTaskView,
  taskEntityKey: string,
  groupId: string,
): boolean {
  const group = view.nodes.find((node) => node.type === "group" && node.group.id === groupId);
  return Boolean(
    group?.type === "group" &&
    group.tasks[0] &&
    buildTaskEntityKey(group.tasks[0]) === taskEntityKey,
  );
}

function buildWorkspaceScopes(workspaceTabs: WorkspaceTabState[]) {
  return workspaceTabs.map((tab) => ({
    workspacePath: tab.workspacePath,
    workspaceIdentity: tab.workspaceIdentity,
    workspacePurpose: tab.workspacePurpose,
  }));
}

function collectViewWorkspaceScopes(
  view: ZCodeGroupedTaskView,
): Array<{ workspacePath: string; workspaceIdentity?: string }> {
  const workspaceScopes = new Map<string, { workspacePath: string; workspaceIdentity?: string }>();
  const addTask = (task: ZCodeTaskMeta) => {
    const workspaceKey = buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity);
    workspaceScopes.set(workspaceKey, {
      workspacePath: task.workspacePath,
      workspaceIdentity: task.workspaceIdentity,
    });
  };

  for (const node of view.nodes) {
    if (node.type === "group") {
      node.tasks.forEach(addTask);
      continue;
    }
    addTask(node.task);
  }

  return [...workspaceScopes.values()];
}

export function mergeGroupedTaskViewWithOptimistic(params: {
  view: ZCodeGroupedTaskView;
  optimisticOverlays: Iterable<WorkspaceOptimisticTaskOverlay>;
  visibleMissingTaskKeys: ReadonlySet<string>;
}): ZCodeGroupedTaskView {
  const optimisticTaskByKey = new Map<string, ZCodeTaskMeta>();
  const placementTaskByKey = new Map<string, ZCodeTaskMeta>();
  const promotedDraftByTaskKey = new Map<
    string,
    WorkspaceOptimisticTaskOverlay["promotedGroupedDraftTaskByTaskId"][string]
  >();

  for (const node of params.view.nodes) {
    if (node.type === "group") {
      for (const task of node.tasks) placementTaskByKey.set(buildTaskEntityKey(task), task);
      continue;
    }
    placementTaskByKey.set(buildTaskEntityKey(node.task), node.task);
  }

  for (const overlay of params.optimisticOverlays) {
    for (const task of overlay.tasks) {
      const taskKey = buildTaskEntityKey(task);
      optimisticTaskByKey.set(taskKey, task);
      placementTaskByKey.set(taskKey, task);
      // The optimistic overlay is a cross-hook runtime object; older tests and callers may
      // not pass promotedGroupedDraftTaskByTaskId. Default the missing field to an empty
      // object so the grouped merge cannot crash on absent draft placement; when absent,
      // the task enters at top level like any optimistic task.
    }
    for (const [taskId, promotedDraft] of Object.entries(
      overlay.promotedGroupedDraftTaskByTaskId ?? {},
    )) {
      promotedDraftByTaskKey.set(
        buildTaskEntityKey({
          taskId,
          workspacePath: promotedDraft.workspacePath,
          workspaceIdentity: promotedDraft.workspaceIdentity,
        }),
        promotedDraft,
      );
    }
  }

  if (optimisticTaskByKey.size === 0 && promotedDraftByTaskKey.size === 0) {
    return params.view;
  }

  const visibleTaskKeys = new Set<string>();
  let changed = false;
  const nodes = params.view.nodes.map((node) => {
    if (node.type === "group") {
      let tasksChanged = false;
      const tasks = node.tasks.map((task) => {
        const taskKey = buildTaskEntityKey(task);
        visibleTaskKeys.add(taskKey);
        const optimisticTask = optimisticTaskByKey.get(taskKey);
        if (!optimisticTask) {
          return task;
        }
        tasksChanged = true;
        // Grouped optimistic meta must not overwrite the whole sessions-index object:
        // inline timestamp/phase would get polluted by tasks-index timestamps even though
        // explicit sort_order is unchanged. A promoted grouped draft's minimal overlay
        // title is empty; spreading the whole object would keep suppressing the real title
        // sessions-index delivers later. Merge authoritative task meta fields first, then
        // keep the membership/activity fields owned by sessions-index.
        return mergeTaskListMembershipFields(
          task,
          mergeTaskWithOptimisticMeta(task, optimisticTask),
        );
      });
      if (!tasksChanged) {
        return node;
      }
      changed = true;
      return { ...node, tasks };
    }

    const taskKey = buildTaskEntityKey(node.task);
    visibleTaskKeys.add(taskKey);
    const optimisticTask = optimisticTaskByKey.get(taskKey);
    if (!optimisticTask) {
      return node;
    }
    changed = true;
    return {
      ...node,
      task: mergeTaskListMembershipFields(
        node.task,
        mergeTaskWithOptimisticMeta(node.task, optimisticTask),
      ),
    };
  });

  const missingVisibleTasks = [...optimisticTaskByKey.entries()]
    .filter(
      ([taskKey]) => params.visibleMissingTaskKeys.has(taskKey) && !visibleTaskKeys.has(taskKey),
    )
    .map(([, task]) => task)
    .sort((left, right) => {
      if (right.updatedAt !== left.updatedAt) {
        return right.updatedAt - left.updatedAt;
      }
      if (right.createdAt !== left.createdAt) {
        return right.createdAt - left.createdAt;
      }
      return right.taskId.localeCompare(left.taskId);
    });

  if (missingVisibleTasks.length === 0) {
    return applyPromotedGroupPlacements(
      changed ? { nodes } : params.view,
      promotedDraftByTaskKey,
      placementTaskByKey,
    );
  }

  const groupMissingTasksByGroupId = new Map<string, ZCodeTaskMeta[]>();
  const topMissingTasks: ZCodeTaskMeta[] = [];
  for (const task of missingVisibleTasks) {
    const promotedDraft = promotedDraftByTaskKey.get(buildTaskEntityKey(task));
    if (promotedDraft?.placement.type === "group") {
      const groupTasks = groupMissingTasksByGroupId.get(promotedDraft.placement.groupId) ?? [];
      groupTasks.push(task);
      groupMissingTasksByGroupId.set(promotedDraft.placement.groupId, groupTasks);
      continue;
    }
    topMissingTasks.push(task);
  }

  const nodesWithGroupDraftTasks = nodes.map((node) => {
    if (node.type !== "group") {
      return node;
    }
    const groupTasks = groupMissingTasksByGroupId.get(node.group.id);
    if (!groupTasks?.length) {
      return node;
    }
    return { ...node, tasks: [...groupTasks, ...node.tasks] };
  });
  const missingGroupTasksWithoutGroup = [...groupMissingTasksByGroupId.entries()]
    .filter(([, tasks]) => tasks.length > 0)
    .flatMap(([groupId, tasks]) =>
      nodes.some((node) => node.type === "group" && node.group.id === groupId) ? [] : tasks,
    );

  // The grouped view used to render only the sqlite query result. A first-run task is
  // already in the local optimistic cache, but the server's initial snapshot delays its
  // broadcast to avoid a "New session" flash, so the grouped list would not show the task
  // until restart or the next full refresh. Fill in only optimistic tasks the grouped hook
  // marked temporarily visible; do not re-insert other local cache entries (archived,
  // pinned, ...). A task promoted from a grouped draft keeps the temp entity's group/top
  // slot until the sqlite sort persistence completes.
  return applyPromotedGroupPlacements(
    {
      nodes: [
        ...topMissingTasks.concat(missingGroupTasksWithoutGroup).map((task) => ({
          type: "task" as const,
          task,
        })),
        ...nodesWithGroupDraftTasks,
      ],
    },
    promotedDraftByTaskKey,
    placementTaskByKey,
  );
}

function collectGroupedViewTaskKeys(view: ZCodeGroupedTaskView): Set<string> {
  const taskKeys = new Set<string>();
  for (const node of view.nodes) {
    if (node.type === "group") {
      for (const task of node.tasks) {
        taskKeys.add(buildTaskEntityKey(task));
      }
      continue;
    }
    taskKeys.add(buildTaskEntityKey(node.task));
  }
  return taskKeys;
}

export function shouldHideGroupedTaskContent(params: {
  initialized: boolean;
  loading: boolean;
  hasNodes: boolean;
  /**
   * The gate blocks the first paint only. Returning to hidden after the list has painted
   * once is the "grouped block flashes" bug — ancestor remounts and background refreshes
   * both land here. After one paint, keep rendering the previous list: stale beats blank.
   */
  hasPaintedOnce?: boolean;
}): boolean {
  if (params.hasPaintedOnce) {
    return false;
  }
  return !params.initialized || (params.loading && !params.hasNodes);
}

export function isGroupedTaskViewInitialized(params: {
  remoteDataInitialized: boolean;
  hydratingEndpointKeys: readonly string[];
  /**
   * First-paint gate only. It used to read the live hydrating state, so every tool
   * result a running task emitted re-queried the Controller list (loading=true), slamming
   * the gate shut and remounting the whole grouped body — the sidebar list visibly
   * jittered. Once ready, stay ready; background refreshes never return to first-paint.
   */
  previouslyInitialized?: boolean;
}): boolean {
  if (params.previouslyInitialized) {
    return true;
  }
  return params.remoteDataInitialized && params.hydratingEndpointKeys.length === 0;
}

/**
 * Per-key single-flight cache for grouped structure/membership.
 *
 * Hook mount and the first sessions-index frame race into refresh when the grouped view
 * activates; the old cache kept only completed results, so every miss re-requested every
 * workspace — an RPC storm with loading generations churning. Keep the in-flight Promise
 * too, and use generation/sequence to keep evicted-key or stale late results from writing
 * back.
 */
export class GroupedRemoteDataSingleFlight<T> {
  private generation = 0;
  private requestSequence = 0;
  private completed: { key: string; value: T } | null = null;
  private readonly inFlightByKey = new Map<
    string,
    {
      generation: number;
      latestRequestSequence: number;
      promise: Promise<T> | null;
    }
  >();

  load(key: string, fetchValue: () => Promise<T>): Promise<T> {
    const requestSequence = this.requestSequence + 1;
    this.requestSequence = requestSequence;
    if (this.completed?.key === key) {
      return Promise.resolve(this.completed.value);
    }

    const generation = this.generation;
    const existing = this.inFlightByKey.get(key);
    if (existing?.generation === generation && existing.promise) {
      existing.latestRequestSequence = requestSequence;
      return existing.promise;
    }

    const inFlight = {
      generation,
      latestRequestSequence: requestSequence,
      promise: null as Promise<T> | null,
    };
    const promise = Promise.resolve()
      .then(fetchValue)
      .then((value) => {
        if (
          this.generation === generation &&
          this.requestSequence === inFlight.latestRequestSequence
        ) {
          this.completed = { key, value };
        }
        return value;
      })
      .finally(() => {
        if (this.inFlightByKey.get(key)?.promise === promise) {
          this.inFlightByKey.delete(key);
        }
      });
    inFlight.promise = promise;
    this.inFlightByKey.set(key, inFlight);
    return promise;
  }

  isCurrent(key: string, value: T): boolean {
    return this.completed?.key === key && this.completed.value === value;
  }

  invalidate(): void {
    this.generation += 1;
    this.completed = null;
    this.inFlightByKey.clear();
  }
}

export function prependTaskGroupToView(
  view: ZCodeGroupedTaskView,
  group: ZCodeTaskGroup,
): ZCodeGroupedTaskView {
  if (view.nodes.some((node) => node.type === "group" && node.group.id === group.id)) {
    return view;
  }
  const minimumSortOrder = view.nodes.reduce(
    (minimum, node) => Math.min(minimum, node.sortOrder ?? 0),
    0,
  );
  return {
    nodes: [
      {
        type: "group",
        group,
        tasks: [],
        sortOrder: minimumSortOrder - 1000,
      },
      ...view.nodes,
    ],
  };
}

export function reconcileGroupedOptimisticTaskKeys(params: {
  view: ZCodeGroupedTaskView;
  optimisticOverlays: Iterable<WorkspaceOptimisticTaskOverlay>;
  previousVisibleMissingTaskKeys: ReadonlySet<string>;
}): Set<string> {
  const groupedViewTaskKeys = collectGroupedViewTaskKeys(params.view);
  const optimisticTaskKeys = new Set<string>();
  const nextVisibleMissingTaskKeys = new Set<string>();

  for (const overlay of params.optimisticOverlays) {
    for (const task of overlay.tasks) {
      const taskKey = buildTaskEntityKey(task);
      optimisticTaskKeys.add(taskKey);
      if (overlay.activeTaskId === task.taskId && !groupedViewTaskKeys.has(taskKey)) {
        nextVisibleMissingTaskKeys.add(taskKey);
      }
    }
  }

  for (const taskKey of params.previousVisibleMissingTaskKeys) {
    if (groupedViewTaskKeys.has(taskKey) || !optimisticTaskKeys.has(taskKey)) {
      continue;
    }
    nextVisibleMissingTaskKeys.add(taskKey);
  }

  return nextVisibleMissingTaskKeys;
}

function groupedNodeIdentityKey(node: ZCodeGroupedTaskView["nodes"][number]): string {
  if (node.type === "group") {
    return `group:${node.group.id}`;
  }
  return `task:${buildTaskWorkspaceKey(node.task.workspacePath, node.task.workspaceIdentity)}:${node.task.taskId}`;
}

function areGroupedNodesEquivalent(
  previous: ZCodeGroupedTaskView["nodes"][number],
  next: ZCodeGroupedTaskView["nodes"][number],
): boolean {
  if (previous.type !== next.type || previous.sortOrder !== next.sortOrder) {
    return false;
  }
  if (previous.type === "group" && next.type === "group") {
    // Structural comparison instead of JSON.stringify: after IPC/join rebuilds, group meta
    // key order is not stable, so string compare would make equivalence permanently false
    // and node stabilization would silently degrade to fresh references every frame.
    if (!areStabilizedValuesEquivalent(previous.group, next.group)) {
      return false;
    }
    // Task objects come from the sessions-index aggregation layer (references already
    // stabilized) plus joinTaskListUnreadAt (reference kept when unchanged); identical
    // references imply identical content.
    return (
      previous.tasks.length === next.tasks.length &&
      next.tasks.every((task, index) => task === previous.tasks[index])
    );
  }
  return previous.type === "task" && next.type === "task" && previous.task === next.task;
}

/**
 * Every grouped refresh rebuilds the whole view object tree; even unchanged content (or a
 * single changed row) hands every group/task row a fresh reference and re-renders the lot —
 * the sidebar list visibly "reloads". This stabilizes references per node: equivalent nodes
 * reuse the old object; a fully equivalent tree returns the old view (same-reference
 * setState bails out immediately).
 */
function stabilizeGroupedView(
  previous: ZCodeGroupedTaskView,
  next: ZCodeGroupedTaskView,
): ZCodeGroupedTaskView {
  if (previous.nodes.length === 0) {
    return next;
  }
  const previousByKey = new Map(previous.nodes.map((node) => [groupedNodeIdentityKey(node), node]));
  let identical = previous.nodes.length === next.nodes.length;
  const nodes = next.nodes.map((node, index) => {
    const previousNode = previousByKey.get(groupedNodeIdentityKey(node));
    if (previousNode && areGroupedNodesEquivalent(previousNode, node)) {
      if (identical && previous.nodes[index] !== previousNode) {
        identical = false;
      }
      return previousNode;
    }
    identical = false;
    return node;
  });
  return identical ? previous : { nodes };
}

function nodeToTopLevelRef(
  node: ZCodeGroupedTaskView["nodes"][number],
): ZCodeGroupedTaskViewTopLevelNodeRef {
  if (node.type === "group") {
    return { type: "group", groupId: node.group.id };
  }
  return {
    type: "task",
    task: {
      workspacePath: node.task.workspacePath,
      workspaceIdentity: node.task.workspaceIdentity,
      taskId: node.task.taskId,
    },
  };
}

function viewToOrderInput(params: { view: ZCodeGroupedTaskView }): ZCodeGroupedTaskViewOrderInput {
  return {
    workspaceScopes: collectViewWorkspaceScopes(params.view),
    topLevelNodes: params.view.nodes.map(nodeToTopLevelRef),
    groups: params.view.nodes
      .filter((node) => node.type === "group")
      .map((node) => ({
        groupId: node.group.id,
        taskRefs: node.tasks.map((task) => ({
          workspacePath: task.workspacePath,
          workspaceIdentity: task.workspaceIdentity,
          taskId: task.taskId,
        })),
      })),
  };
}

/**
 * Cross-mount grouped view cache (bucketed by scope signature).
 *
 * grouped is the only sidebar view holding the whole list in component instance useState;
 * timeline/pinned render from the module-level query cache. Once a section remounts
 * (ancestor remount / HMR), grouped falls back to "empty view + first-paint gate closed"
 * until both RPCs return — the whole grouped list flashes. Keep the last authoritative view
 * at module level so a remount paints immediately; RPCs only converge.
 *
 * Stale-read window (explicit contract, not a bug): the cache is written only on successful
 * refresh and has no active invalidation. Deletes/archives/group changes that happen while
 * the component is unmounted do not evict it, so after remount those stale rows are visible
 * and clickable until the mount-effect refresh returns — bounded by one RPC round trip.
 * That is the agreed "stale beats blank" trade-off; if stale-click reports come in, consider
 * a per-entry TTL or placeholder degradation rather than widening the window.
 */
const GROUPED_VIEW_CACHE_MAX_KEYS = 8;
const groupedViewCacheBySignature = new Map<string, ZCodeGroupedTaskView>();

function readCachedGroupedView(signature: string): ZCodeGroupedTaskView | undefined {
  return groupedViewCacheBySignature.get(signature);
}

function writeCachedGroupedView(signature: string, view: ZCodeGroupedTaskView): void {
  groupedViewCacheBySignature.delete(signature);
  groupedViewCacheBySignature.set(signature, view);
  while (groupedViewCacheBySignature.size > GROUPED_VIEW_CACHE_MAX_KEYS) {
    const oldestKey = groupedViewCacheBySignature.keys().next().value;
    if (oldestKey === undefined) break;
    groupedViewCacheBySignature.delete(oldestKey);
  }
}

export function clearCachedGroupedViewsForTest(): void {
  groupedViewCacheBySignature.clear();
}

export function useGroupedTaskView(params: { workspaceTabs: WorkspaceTabState[] }) {
  const services = useBaseWorkspaceServices();
  // grouped remains local-workspace-only, but task facts must come from the window
  // Controller — no Renderer-side sessions-index join. Grouping structure/order keeps using
  // the local task service to avoid capability creep.
  const localWorkspaceTabs = useLocalWorkspaceScopes({
    workspaceTabs: params.workspaceTabs,
  });
  // scopes used to memo on the tabs array identity. A parent rebuilding an equal-value
  // array would change the refresh identity, re-running the "refresh changed => refresh"
  // effect with another setState, triggering the next render — a self-exciting refresh
  // loop firing RPCs every frame and giving the gate/empty state a chance to flash. Use a
  // value signature instead, matching useGlobalTaskList.
  const localWorkspaceScopeSignature = JSON.stringify(
    localWorkspaceTabs
      .map(
        (tab) =>
          [
            buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity),
            tab.workspacePath,
            tab.workspaceIdentity ?? null,
            tab.workspacePurpose ?? null,
          ] as const,
      )
      .sort(
        (
          [leftKey, leftPath, leftIdentity, leftPurpose],
          [rightKey, rightPath, rightIdentity, rightPurpose],
        ) =>
          // Per-level tie-break: sorting by workspaceKey alone compares two tabs with the
          // same key but different purposes as 0; stable sort keeps input order, so swapped
          // positions in the tabs array would produce a new signature and one extra
          // refresh.
          String(leftKey).localeCompare(String(rightKey)) ||
          String(leftPath).localeCompare(String(rightPath)) ||
          String(leftIdentity ?? "").localeCompare(String(rightIdentity ?? "")) ||
          String(leftPurpose ?? "").localeCompare(String(rightPurpose ?? "")),
      ),
  );
  const scopes = useMemo(
    () => buildWorkspaceScopes(localWorkspaceTabs),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- equal value signature reuses the memo; avoids a refresh loop from parent array identity changes.
    [localWorkspaceScopeSignature],
  );
  const sessionsIndexScopes = useMemo(
    () =>
      scopes.map((scope) => ({
        workspacePath: scope.workspacePath,
        ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      })),
    [scopes],
  );
  const [view, setView] = useState<ZCodeGroupedTaskView>(
    () => readCachedGroupedView(localWorkspaceScopeSignature) ?? { nodes: [] },
  );
  const viewRef = useRef(view);
  viewRef.current = view;
  const [loading, setLoading] = useState(false);
  const [remoteDataInitialized, setRemoteDataInitialized] = useState(
    () => readCachedGroupedView(localWorkspaceScopeSignature) !== undefined,
  );
  const [saving, setSaving] = useState(false);
  const requestIdRef = useRef(0);
  const taskListVersionSignature = useZCodeSessionStore((state) =>
    JSON.stringify(
      params.workspaceTabs.map((tab) => {
        const workspaceKey = buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity);
        const workspaceState = selectWorkspaceZCodeState(
          state,
          tab.workspacePath,
          tab.workspaceIdentity,
        );
        return [workspaceKey, workspaceState.taskListVersion] as const;
      }),
    ),
  );
  const controllerTaskFacts = useGlobalTaskList({
    kind: "active",
    workspaceTabs: localWorkspaceTabs,
    sortBy: "updated",
    searchQuery: "",
    expanded: true,
    collapsedLimit: 1,
  });
  const sessionsIndexItems = controllerTaskFacts.items;
  // A cache hit counts as initialized: after remount the Controller list re-enters loading,
  // and without seeding the latch from the cache the first frame still flashes.
  const initializedLatchRef = useRef(
    readCachedGroupedView(localWorkspaceScopeSignature) !== undefined,
  );
  const initialized = isGroupedTaskViewInitialized({
    remoteDataInitialized,
    hydratingEndpointKeys: controllerTaskFacts.loading ? ["window-controller"] : [],
    previouslyInitialized: initializedLatchRef.current,
  });
  // Preconditions for writing a ref during render (do not copy to non-monotonic state):
  // this ref is a monotonic latch (false->true, never falls back) and its value derives
  // entirely from this render's inputs. Under React 18 concurrent, discarded renders also
  // run this assignment, but for a monotonic latch "set early" equals "ready early" — the
  // gate opens sooner, no wrong state. With any fallback-capable or commit-order-dependent
  // state, this pattern drops frames unreproducibly; that state belongs in an effect.
  initializedLatchRef.current = initialized;
  const sessionsIndexItemsRef = useRef(sessionsIndexItems);
  sessionsIndexItemsRef.current = sessionsIndexItems;
  // pin/archive membership version: bumped after mutations so the grouped view (non-pinned,
  // non-archived) re-filters authoritatively.
  const membershipVersion = useTaskListMembershipVersion();
  const optimisticTaskOverlayByWorkspaceKey = useWorkspaceTaskOptimisticOverlayByWorkspaceKey(
    params.workspaceTabs,
  );
  const clearPromotedGroupedDraftTask = useZCodeSessionStore(
    (state) => state.clearPromotedGroupedDraftTask,
  );
  const visibleMissingTaskKeysRef = useRef<Set<string>>(new Set());
  const promotedGroupPersistenceRef = useRef<Set<string>>(new Set());
  const displayedViewRef = useRef<ZCodeGroupedTaskView>({ nodes: [] });
  const displayedView = useMemo(() => {
    const optimisticOverlays = [...optimisticTaskOverlayByWorkspaceKey.values()];
    const visibleMissingTaskKeys = reconcileGroupedOptimisticTaskKeys({
      view,
      optimisticOverlays,
      previousVisibleMissingTaskKeys: visibleMissingTaskKeysRef.current,
    });
    visibleMissingTaskKeysRef.current = visibleMissingTaskKeys;
    // Overlay frames (optimistic meta write-back from running tasks) bypass the view's
    // node stabilization, producing fresh group/task node objects every time and making the
    // whole sidebar list re-render and re-measure the virtualizer. Run the displayed view
    // through the same node-level stabilization; on equivalence even the array identity is
    // preserved.
    const nextDisplayedView = stabilizeGroupedView(
      displayedViewRef.current,
      mergeGroupedTaskViewWithOptimistic({
        view,
        optimisticOverlays,
        visibleMissingTaskKeys,
      }),
    );
    displayedViewRef.current = nextDisplayedView;
    return nextDisplayedView;
  }, [optimisticTaskOverlayByWorkspaceKey, view]);

  // Delta refresh: grouped structure (grouping/order) and membership (pin/archive/unread)
  // do not change with sessions-index content frames (title/status). Cache by
  // "membershipVersion + structure version + scope signature" so content-frame refreshes
  // only join in memory, no RPC. Group mutations invalidate explicitly.
  const [remoteDataLoader] = useState(
    () =>
      new GroupedRemoteDataSingleFlight<{
        structure: ZCodeGroupedTaskViewStructure;
        membership: Awaited<ReturnType<typeof fetchTaskListMembershipSets>>;
      }>(),
  );
  const invalidateRemoteData = useCallback(() => {
    remoteDataLoader.invalidate();
  }, [remoteDataLoader]);

  const refresh = useCallback(async () => {
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    // loading only means "first paint has no authoritative nodes yet". A running task's
    // every tool result triggers a background refresh; setting the flag unconditionally
    // would flash the empty state and the first-paint gate along with it.
    if (viewRef.current.nodes.length === 0) {
      setLoading(true);
    }
    try {
      // tasks-index provides both persistent task rows and grouping structure; sessions-index
      // only enriches activity/detail. The grouped sidebar must follow the currently open
      // workspace scope; do not pass includeAllWorkspaces, or other workspaces' groups leak
      // in.
      const remoteDataKey = [
        membershipVersion,
        taskListVersionSignature,
        scopes
          .map((scope) => buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity))
          .join("|"),
      ].join("::");
      const remoteData = await remoteDataLoader.load(remoteDataKey, async () => {
        const [structureResult, membershipResult] = await Promise.all([
          services.zcodeTaskService.listGroupedTaskViewStructure({
            workspaceScopes: scopes,
          }),
          fetchTaskListMembershipSets({
            service: services.zcodeTaskService,
            scopes: sessionsIndexScopes,
          }),
        ]);
        return {
          structure: structureResult,
          membership: membershipResult,
        };
      });
      if (
        requestIdRef.current === requestId &&
        remoteDataLoader.isCurrent(remoteDataKey, remoteData)
      ) {
        const { structure, membership } = remoteData;
        const nextView = buildGroupedTaskViewFromSessions({
          structure,
          taskIndexItems: membership.taskIndexItems,
          sessions: sessionsIndexItemsRef.current,
          pinnedIds: membership.pinnedIds,
          archivedIds: membership.archivedIds,
          deletedIds: membership.deletedIds,
        });
        // With unchanged content, reuse the old view/node references; same-reference
        // setState bails out, avoiding a pointless whole-list re-render. Read the current
        // view via viewRef instead of side effects in the updater: StrictMode calls
        // updaters twice.
        const stabilizedView = stabilizeGroupedView(viewRef.current, nextView);
        writeCachedGroupedView(localWorkspaceScopeSignature, stabilizedView);
        setView(stabilizedView);
      }
    } catch (error) {
      // One remote Promise may be shared by several refreshes; only the latest request
      // logs the failure once, so the error path cannot become a log storm. Older requests
      // still reach finally, but must not close the latest generation's loading.
      if (requestIdRef.current === requestId) {
        logger.error("[useGroupedTaskView] failed to load grouped task view", error);
      }
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
        // The first request ends the initialization gate on success or failure; failures are
        // logged and fall into the empty state instead of loading forever. Later refreshes
        // keep the existing list and never return to first-load state.
        setRemoteDataInitialized(true);
      }
    }
  }, [
    localWorkspaceScopeSignature,
    membershipVersion,
    remoteDataLoader,
    scopes,
    sessionsIndexScopes,
    services.zcodeTaskService,
    taskListVersionSignature,
  ]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    const authoritativeTaskKeys = collectGroupedViewTaskKeys(view);
    const promotedGroupTasks: ZCodeTaskMeta[] = [];
    const settledRootTasks: ZCodeTaskMeta[] = [];
    for (const overlay of optimisticTaskOverlayByWorkspaceKey.values()) {
      for (const [taskId, promotedDraft] of Object.entries(
        overlay.promotedGroupedDraftTaskByTaskId ?? {},
      )) {
        const key = buildTaskEntityKey({
          taskId,
          workspacePath: promotedDraft.workspacePath,
          workspaceIdentity: promotedDraft.workspaceIdentity,
        });
        const task = findTaskInGroupedView(displayedView, key);
        if (promotedDraft?.placement.type === "top") {
          const firstNode = view.nodes[0];
          if (task && firstNode?.type === "task" && buildTaskEntityKey(firstNode.task) === key) {
            settledRootTasks.push(task);
          }
        } else if (
          task &&
          (authoritativeTaskKeys.has(key) || visibleMissingTaskKeysRef.current.has(key)) &&
          !isTaskFirstInGroup(view, key, promotedDraft.placement.groupId)
        ) {
          promotedGroupTasks.push(task);
        }
      }
    }
    for (const task of settledRootTasks) {
      clearPromotedGroupedDraftTask(task.workspacePath, task.taskId, task.workspaceIdentity);
    }
    if (promotedGroupTasks.length === 0) {
      return;
    }
    const signature = promotedGroupTasks.map(buildTaskEntityKey).sort().join("|");
    if (promotedGroupPersistenceRef.current.has(signature)) {
      return;
    }
    promotedGroupPersistenceRef.current.add(signature);
    // A New task inside a group used to inherit the draft position in the optimistic view
    // only, while SQLite still pinned it to the root top — the task fell out of the group on
    // refresh. Once the task is in the optimistic index, persist the same displayed view as
    // one full ordering transaction so membership and first-in-group order converge
    // together.
    void services.zcodeTaskService
      .applyGroupedTaskViewOrder(viewToOrderInput({ view: displayedView }))
      .then(() => {
        invalidateRemoteData();
        return refreshRef.current().then(() => {
          for (const task of promotedGroupTasks) {
            clearPromotedGroupedDraftTask(task.workspacePath, task.taskId, task.workspaceIdentity);
          }
        });
      })
      .catch((error) => {
        promotedGroupPersistenceRef.current.delete(signature);
        logger.error(
          "[useGroupedTaskView] failed to persist promoted grouped draft placement",
          error,
        );
      });
  }, [
    clearPromotedGroupedDraftTask,
    displayedView,
    invalidateRemoteData,
    optimisticTaskOverlayByWorkspaceKey,
    services.zcodeTaskService,
    view,
  ]);

  useEffect(() => {
    const disposables = scopes.map((scope) =>
      services.zcodeTaskService.onDynamicWorkspaceEvent(scope)((event) => {
        if (event.type !== "workspace_task_list_changed" || event.reason !== "task_created") {
          return;
        }
        // The sessions-index visible frame may land before the SQLite grouped sort_order
        // write. task_created is the boundary where first-time ordering is committed: drop
        // the stale structure cache and re-fetch, otherwise running sessions keep the
        // missing-order node appended at the end until a restart rebuilds the cache.
        invalidateRemoteData();
        void refreshRef.current();
      }),
    );
    return () => disposables.forEach((disposable) => disposable.dispose());
  }, [invalidateRemoteData, scopes, services.zcodeTaskService]);

  // The only automatic refresh entry. The refresh identity already includes
  // membership/structure/scope versions; sessions-index content changes then trigger only
  // the in-memory join. Prevents the mount effect and index effect from double-fetching on
  // the first frame.
  useEffect(() => {
    void refresh();
  }, [refresh, sessionsIndexItems]);

  const createGroup = useCallback(async (): Promise<ZCodeTaskGroup> => {
    setSaving(true);
    try {
      const group = await services.zcodeTaskService.createTaskGroup();
      // The new group's SQLite order is already top, but waiting for the async refresh
      // would briefly keep the old tree and drop the group to the end among missing-order
      // nodes; optimally prepend with the same sort_order semantics and let refresh
      // converge on SQLite.
      setView((current) => prependTaskGroupToView(current, group));
      // Grouping structure changed: invalidate the remote cache and rebuild (the
      // membershipVersion bump may lag the local refresh).
      invalidateRemoteData();
      await refresh();
      return group;
    } catch (error) {
      logger.error("[useGroupedTaskView] failed to create task group", error);
      throw error;
    } finally {
      setSaving(false);
    }
  }, [invalidateRemoteData, refresh, services.zcodeTaskService]);

  const renameGroup = useCallback(
    async (groupId: string, title: string) => {
      const previousView = view;
      const groupNode = view.nodes.find(
        (node) => node.type === "group" && node.group.id === groupId,
      );
      const nextTitle = title.trim() || (groupNode?.type === "group" ? groupNode.group.title : "");
      if (!groupNode || groupNode.type !== "group" || groupNode.group.title === nextTitle) {
        return;
      }

      const optimisticView: ZCodeGroupedTaskView = {
        nodes: view.nodes.map((node) =>
          node.type === "group" && node.group.id === groupId
            ? {
                ...node,
                group: {
                  ...node.group,
                  title: nextTitle,
                  updatedAt: Date.now(),
                },
              }
            : node,
        ),
      };
      setView(optimisticView);
      setSaving(true);
      try {
        const renamedGroup = await services.zcodeTaskService.renameTaskGroup({
          groupId,
          title: nextTitle,
          workspaceScopes: collectViewWorkspaceScopes(optimisticView),
        });
        invalidateRemoteData();
        setView({
          nodes: optimisticView.nodes.map((node) =>
            node.type === "group" && node.group.id === groupId
              ? { ...node, group: renamedGroup }
              : node,
          ),
        });
      } catch (error) {
        setView(previousView);
        logger.error("[useGroupedTaskView] failed to rename task group", error);
        throw error;
      } finally {
        setSaving(false);
      }
    },
    [invalidateRemoteData, scopes, services.zcodeTaskService, view],
  );

  const updateGroupColor = useCallback(
    async (groupId: string, color: ZCodeTaskGroupColor) => {
      const previousView = view;
      const groupNode = view.nodes.find(
        (node) => node.type === "group" && node.group.id === groupId,
      );
      if (!groupNode || groupNode.type !== "group" || groupNode.group.color === color) {
        return;
      }

      const optimisticView: ZCodeGroupedTaskView = {
        nodes: view.nodes.map((node) =>
          node.type === "group" && node.group.id === groupId
            ? {
                ...node,
                group: {
                  ...node.group,
                  color,
                  updatedAt: Date.now(),
                },
              }
            : node,
        ),
      };
      setView(optimisticView);
      setSaving(true);
      try {
        const updatedGroup = await services.zcodeTaskService.updateTaskGroupColor({
          groupId,
          color,
          workspaceScopes: collectViewWorkspaceScopes(optimisticView),
        });
        invalidateRemoteData();
        setView({
          nodes: optimisticView.nodes.map((node) =>
            node.type === "group" && node.group.id === groupId
              ? { ...node, group: updatedGroup }
              : node,
          ),
        });
      } catch (error) {
        setView(previousView);
        logger.error("[useGroupedTaskView] failed to update task group color", error);
        throw error;
      } finally {
        setSaving(false);
      }
    },
    [invalidateRemoteData, scopes, services.zcodeTaskService, view],
  );

  const applyOrder = useCallback(
    async (nextView: ZCodeGroupedTaskView) => {
      const previousView = view;
      setView(nextView);
      setSaving(true);
      try {
        // The apply response's view is still joined from the tasks table (legacy source);
        // do not trust it. After persistence succeeds, converge via the
        // structure + sessions-index rebuild (refresh).
        await services.zcodeTaskService.applyGroupedTaskViewOrder(
          viewToOrderInput({
            view: nextView,
          }),
        );
        invalidateRemoteData();
        await refreshRef.current();
      } catch (error) {
        // On grouped-view write failure, roll back the local optimistic view and refresh
        // once to converge on the sqlite source of truth.
        setView(previousView);
        void refresh();
        logger.error("[useGroupedTaskView] failed to save grouped task order", error);
        throw error;
      } finally {
        setSaving(false);
      }
    },
    [invalidateRemoteData, refresh, services.zcodeTaskService, view],
  );

  const ungroupGroup = useCallback(
    async (groupId: string) => {
      const groupNode = view.nodes.find(
        (node) => node.type === "group" && node.group.id === groupId,
      );
      if (!groupNode || groupNode.type !== "group") {
        return;
      }
      const nextView: ZCodeGroupedTaskView = {
        nodes: view.nodes.flatMap((node) =>
          node.type === "group" && node.group.id === groupId
            ? node.tasks.map((task) => ({ type: "task" as const, task }))
            : [node],
        ),
      };

      setSaving(true);
      try {
        await applyOrder(nextView);
        await services.zcodeTaskService.deleteTaskGroup({
          groupId,
          workspaceScopes: collectViewWorkspaceScopes(nextView),
        });
        invalidateRemoteData();
        await refresh();
      } catch (error) {
        logger.error("[useGroupedTaskView] failed to ungroup task group", error);
        throw error;
      } finally {
        setSaving(false);
      }
    },
    [applyOrder, invalidateRemoteData, refresh, scopes, services.zcodeTaskService, view],
  );

  return {
    view: displayedView,
    setView,
    loading,
    initialized,
    saving,
    refresh,
    createGroup,
    renameGroup,
    updateGroupColor,
    ungroupGroup,
    applyOrder,
  };
}
