// Sidebar persistent rows and the pin/archive/groups authority. tasks-index.sqlite owns the row set
// and membership; sessions-index only adds live activity/detail in later projections.
// unread is organization state too (setTaskUnread writes tasks-index), same class as pin/archive,
// absent from the frozen sessions-index schema; pull the unreadAt map in parallel, join at list build.
import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";

export interface TaskListMembershipScope {
  workspacePath: string;
  workspaceIdentity?: string;
}

export type TaskListMembershipService = Pick<
  IZCodeTaskService,
  "listPinnedTaskIds" | "listArchivedTasks" | "listTasks" | "listPinnedTasks"
> &
  Partial<Pick<IZCodeTaskService, "listDeletedTaskIds">>;

export interface TaskListMembershipSets {
  /** Union of task rows across the three persistent tasks-index partitions (active/pinned/archived). */
  taskIndexItems: ZCodeTaskMeta[];
  pinnedIds: Set<string>;
  archivedIds: Set<string>;
  /** tasks-index permanent-delete tombstone; outranks every list kind. */
  deletedIds: Set<string>;
  /** taskId -> unreadAt (tasks-index organization state; absent from sessions-index; for the join). */
  unreadAtByTaskId: Map<string, number>;
  /** taskId -> terminal status (tasks-index historical terminal state; colors cold-start stored summaries). */
  terminalStatusByTaskId: Map<string, Extract<ZCodeTaskMeta["status"], "completed" | "error">>;
  /**
   * taskId -> legacy task-index manual title.
   *
   * The v4 sessions-index main list comes from the CLI session store; legacy user renames live only in
   * tasks-index.title/titleOverridden. Carried along in the existing membership read, no table migration.
   */
  titleOverrideByTaskId: Map<string, string>;
  /** taskId -> cronAutomationId (persisted tasks-index identity; absent from the frozen sessions-index schema). */
  cronAutomationIdByTaskId: Map<string, string>;
}

export interface TaskListMembershipRefreshHoldState {
  armed: boolean;
  enteredCallCount: number;
  released: boolean;
}

interface ActiveTaskListMembershipRefreshHold {
  released: Promise<void>;
  release: () => void;
}

let activeTaskListMembershipRefreshHold: ActiveTaskListMembershipRefreshHold | null = null;
let taskListMembershipRefreshHoldState: TaskListMembershipRefreshHoldState = {
  armed: false,
  enteredCallCount: 0,
  released: true,
};

/**
 * E2E-only: hold an already-fetched membership snapshot before it returns to the renderer join.
 * T18 must deterministically create the window where a stale running snapshot lands after the Stop terminal state;
 * real SQLite is too fast for sleep-based luck. Exposed only via the guarded window.__testActions.
 */
export function armTaskListMembershipRefreshHoldForE2E(): void {
  if (activeTaskListMembershipRefreshHold) {
    throw new Error("task list membership refresh hold already started");
  }
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  activeTaskListMembershipRefreshHold = { released, release };
  taskListMembershipRefreshHoldState = {
    armed: true,
    enteredCallCount: 0,
    released: false,
  };
  clearTaskListMembershipCache();
}

export function releaseTaskListMembershipRefreshHoldForE2E(): void {
  const hold = activeTaskListMembershipRefreshHold;
  if (!hold) {
    return;
  }
  activeTaskListMembershipRefreshHold = null;
  taskListMembershipRefreshHoldState = {
    ...taskListMembershipRefreshHoldState,
    armed: false,
    released: true,
  };
  hold.release();
}

export function getTaskListMembershipRefreshHoldStateForE2E(): TaskListMembershipRefreshHoldState {
  return { ...taskListMembershipRefreshHoldState };
}

async function holdTaskListMembershipRefreshResultForE2E(): Promise<void> {
  const hold = activeTaskListMembershipRefreshHold;
  if (!hold) {
    return;
  }
  taskListMembershipRefreshHoldState = {
    ...taskListMembershipRefreshHoldState,
    enteredCallCount: taskListMembershipRefreshHoldState.enteredCallCount + 1,
  };
  await hold.released;
}

/** M5 ③：remote shard 的归属在各自 endpoint 的 tasks-index，按 endpoint 分片拉取后求并。 */
export interface TaskListMembershipEndpoint {
  service: TaskListMembershipService;
  scopes: TaskListMembershipScope[];
}

function scopeParams(scope: TaskListMembershipScope): {
  workspacePath: string;
  workspaceIdentity?: string;
} {
  return {
    workspacePath: scope.workspacePath,
    ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
  };
}

/** Optional auxiliary sets degrade to empty on failure. */
async function listOrEmpty<T>(list: () => Promise<T[]>): Promise<T[]> {
  try {
    return await list();
  } catch {
    return [];
  }
}

async function listWithAvailability<T>(
  list: () => Promise<T[]>,
): Promise<{ items: T[]; available: boolean }> {
  try {
    return { items: await list(), available: true };
  } catch {
    return { items: [], available: false };
  }
}

function collectUnreadAt(unreadAtByTaskId: Map<string, number>, tasks: ZCodeTaskMeta[]): void {
  for (const task of tasks) {
    if (typeof task.unreadAt === "number") {
      unreadAtByTaskId.set(task.taskId, task.unreadAt);
    }
  }
}

function collectTerminalStatuses(
  terminalStatusByTaskId: TaskListMembershipSets["terminalStatusByTaskId"],
  tasks: ZCodeTaskMeta[],
): void {
  for (const task of tasks) {
    if (task.status === "completed" || task.status === "error") {
      terminalStatusByTaskId.set(task.taskId, task.status);
    }
  }
}

function collectTitleOverrides(
  titleOverrideByTaskId: Map<string, string>,
  tasks: ZCodeTaskMeta[],
): void {
  for (const task of tasks) {
    if (task.titleOverridden === true && task.title.trim().length > 0) {
      titleOverrideByTaskId.set(task.taskId, task.title);
    }
  }
}

function collectCronAutomationIds(
  cronAutomationIdByTaskId: Map<string, string>,
  tasks: ZCodeTaskMeta[],
): void {
  for (const task of tasks) {
    if (task.cronAutomationId) {
      cronAutomationIdByTaskId.set(task.taskId, task.cronAutomationId);
    }
  }
}

function mergeTaskIndexItems(lists: ZCodeTaskMeta[][]): ZCodeTaskMeta[] {
  const itemByEntityKey = new Map<string, ZCodeTaskMeta>();
  for (const task of lists.flat()) {
    itemByEntityKey.set(buildTaskEntityKey(task), task);
  }
  return [...itemByEntityKey.values()];
}

/** Fetch server-authoritative task rows, pinned/archived id sets, and other persisted metadata. */
export async function fetchTaskListMembershipSets(params: {
  service: TaskListMembershipService;
  scopes: TaskListMembershipScope[];
}): Promise<TaskListMembershipSets> {
  const [
    pinnedList,
    archivedListResults,
    activeListResults,
    pinnedMetaListResults,
    deletedIdLists,
  ] = await Promise.all([
    listOrEmpty(() => params.service.listPinnedTaskIds()),
    Promise.all(
      params.scopes.map((scope) =>
        listWithAvailability(() => params.service.listArchivedTasks(scopeParams(scope))),
      ),
    ),
    // unread covers three memberships: active (listTasks = not pinned and not archived), pinned, archived.
    Promise.all(
      params.scopes.map((scope) =>
        listWithAvailability(() => params.service.listTasks(scopeParams(scope))),
      ),
    ),
    Promise.all(
      params.scopes.map((scope) =>
        listWithAvailability(() => params.service.listPinnedTasks(scopeParams(scope))),
      ),
    ),
    Promise.all(
      params.scopes.map((scope) =>
        params.service.listDeletedTaskIds
          ? listOrEmpty(() => params.service.listDeletedTaskIds!(scopeParams(scope)))
          : Promise.resolve([]),
      ),
    ),
  ]);
  await holdTaskListMembershipRefreshResultForE2E();
  // Task rows are now the left table of every sidebar list. A failed partition RPC must never
  // publish an authoritative-empty set, or whole cache groups would wipe; throw and let the hook keep the old view.
  if (
    activeListResults.some((result) => !result.available) ||
    archivedListResults.some((result) => !result.available) ||
    pinnedMetaListResults.some((result) => !result.available)
  ) {
    throw new Error("incomplete tasks-index task row read");
  }
  const archivedLists = archivedListResults.map((result) => result.items);
  const activeLists = activeListResults.map((result) => result.items);
  const pinnedMetaLists = pinnedMetaListResults.map((result) => result.items);
  const unreadAtByTaskId = new Map<string, number>();
  const terminalStatusByTaskId: TaskListMembershipSets["terminalStatusByTaskId"] = new Map();
  const titleOverrideByTaskId = new Map<string, string>();
  const cronAutomationIdByTaskId = new Map<string, string>();
  collectUnreadAt(unreadAtByTaskId, archivedLists.flat());
  collectUnreadAt(unreadAtByTaskId, activeLists.flat());
  collectUnreadAt(unreadAtByTaskId, pinnedMetaLists.flat());
  collectTerminalStatuses(terminalStatusByTaskId, archivedLists.flat());
  collectTerminalStatuses(terminalStatusByTaskId, activeLists.flat());
  collectTerminalStatuses(terminalStatusByTaskId, pinnedMetaLists.flat());
  collectTitleOverrides(titleOverrideByTaskId, archivedLists.flat());
  collectTitleOverrides(titleOverrideByTaskId, activeLists.flat());
  collectTitleOverrides(titleOverrideByTaskId, pinnedMetaLists.flat());
  // Since the V4 sidebar primary source moved to sessions-index, the frozen SessionSummary carries no
  // cronAutomationId; without collecting it from tasks-index here, the persisted column keeps a value while the UI task loses identity.
  collectCronAutomationIds(cronAutomationIdByTaskId, archivedLists.flat());
  collectCronAutomationIds(cronAutomationIdByTaskId, activeLists.flat());
  collectCronAutomationIds(cronAutomationIdByTaskId, pinnedMetaLists.flat());
  return {
    // Persistent task-row existence must be decided by tasks-index. This path used to keep only membership
    // sets and drop the already-read task meta, forcing every list to re-derive rows from sessions-index.
    taskIndexItems: mergeTaskIndexItems([
      activeLists.flat(),
      pinnedMetaLists.flat(),
      archivedLists.flat(),
    ]),
    // Pinned task rows are membership evidence themselves; even if the auxiliary id RPC fails briefly,
    // never misfile already-fetched pinned rows into timeline.
    pinnedIds: new Set([...pinnedList, ...pinnedMetaLists.flat().map((task) => task.taskId)]),
    archivedIds: new Set(archivedLists.flat().map((task) => task.taskId)),
    deletedIds: new Set(deletedIdLists.flat()),
    unreadAtByTaskId,
    terminalStatusByTaskId,
    titleOverrideByTaskId,
    cronAutomationIdByTaskId,
  };
}

// Delta-update correction: membership (pin/archive/unread) changes only with ownership mutations (membershipVersion bump),
// unrelated to sessions-index content frames (title/status/lastActivity). Refetching per frame meant one title change
// fired 1+3xscopes RPCs per list instance (hundreds of calls per frame across workspaces/instances).
// Cache the in-flight promise by membershipVersion + endpoint signature, shared across hook instances;
// a version bump or topology change rekeys naturally. The cache is bounded, avoiding history buildup.
const membershipPromiseByCacheKey = new Map<string, Promise<TaskListMembershipSets>>();
const MEMBERSHIP_CACHE_MAX_KEYS = 8;
// Service-instance identity belongs in the key: distinct endpoint services (test mocks, post-reconnect proxies) never share a cache.
const membershipServiceIds = new WeakMap<TaskListMembershipService, number>();
let nextMembershipServiceId = 1;

function membershipServiceIdOf(service: TaskListMembershipService): number {
  let id = membershipServiceIds.get(service);
  if (id === undefined) {
    id = nextMembershipServiceId++;
    membershipServiceIds.set(service, id);
  }
  return id;
}

export function fetchTaskListMembershipSetsForEndpointsCached(params: {
  /** Recommended shape: `${membershipVersion}::${endpoints signature}`. */
  cacheKey: string;
  endpoints: TaskListMembershipEndpoint[];
}): Promise<TaskListMembershipSets> {
  const fullCacheKey = `${params.cacheKey}::svc=${params.endpoints
    .map((endpoint) => membershipServiceIdOf(endpoint.service))
    .join(",")}`;
  const cached = membershipPromiseByCacheKey.get(fullCacheKey);
  if (cached) {
    return cached;
  }
  const promise = fetchTaskListMembershipSetsForEndpoints(params.endpoints);
  membershipPromiseByCacheKey.set(fullCacheKey, promise);
  // Auxiliary sets may degrade to empty, but an incomplete task-row partition read rejects; never cache failures,
  // or one transient RPC error sticks for the current version.
  promise.catch(() => membershipPromiseByCacheKey.delete(fullCacheKey));
  while (membershipPromiseByCacheKey.size > MEMBERSHIP_CACHE_MAX_KEYS) {
    const oldestKey = membershipPromiseByCacheKey.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    membershipPromiseByCacheKey.delete(oldestKey);
  }
  return promise;
}

/** For tests/recovery: clear the membership cache. */
export function clearTaskListMembershipCache(): void {
  membershipPromiseByCacheKey.clear();
}

/** Fetch ownership per endpoint in parallel and union (taskId = sessionId; no cross-endpoint collisions). */
export async function fetchTaskListMembershipSetsForEndpoints(
  endpoints: TaskListMembershipEndpoint[],
): Promise<TaskListMembershipSets> {
  const results = await Promise.all(
    endpoints
      .filter((endpoint) => endpoint.scopes.length > 0)
      .map((endpoint) =>
        fetchTaskListMembershipSets({
          service: endpoint.service,
          scopes: endpoint.scopes,
        }),
      ),
  );
  const merged: TaskListMembershipSets = {
    taskIndexItems: [],
    pinnedIds: new Set<string>(),
    archivedIds: new Set<string>(),
    deletedIds: new Set<string>(),
    unreadAtByTaskId: new Map<string, number>(),
    terminalStatusByTaskId: new Map(),
    titleOverrideByTaskId: new Map<string, string>(),
    cronAutomationIdByTaskId: new Map<string, string>(),
  };
  const taskIndexItemByEntityKey = new Map<string, ZCodeTaskMeta>();
  for (const result of results) {
    for (const task of result.taskIndexItems) {
      taskIndexItemByEntityKey.set(buildTaskEntityKey(task), task);
    }
    for (const taskId of result.pinnedIds) merged.pinnedIds.add(taskId);
    for (const taskId of result.archivedIds) merged.archivedIds.add(taskId);
    for (const taskId of result.deletedIds) merged.deletedIds.add(taskId);
    for (const [taskId, unreadAt] of result.unreadAtByTaskId) {
      merged.unreadAtByTaskId.set(taskId, unreadAt);
    }
    for (const [taskId, status] of result.terminalStatusByTaskId) {
      merged.terminalStatusByTaskId.set(taskId, status);
    }
    for (const [taskId, title] of result.titleOverrideByTaskId) {
      merged.titleOverrideByTaskId.set(taskId, title);
    }
    for (const [taskId, automationId] of result.cronAutomationIdByTaskId) {
      merged.cronAutomationIdByTaskId.set(taskId, automationId);
    }
  }
  merged.taskIndexItems = [...taskIndexItemByEntityKey.values()];
  return merged;
}
