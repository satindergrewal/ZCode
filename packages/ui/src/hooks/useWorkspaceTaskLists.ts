/* eslint-disable max-lines -- The per-workspace task list must keep sharded queries, cached display, and cross-end membership subscription in one hook; splitting raises cache-consistency risk. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeWorkspaceEvent } from "@zcode/shared";
import { logger } from "@/logger.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeSessionStore, selectWorkspaceZCodeState } from "@/store/zcodeSessionStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import {
  buildTaskEntityKey,
  buildTaskListCacheDescriptor,
  buildTaskListCacheKeyFromDescriptor,
  buildTaskWorkspaceKey,
} from "@/lib/taskQueryCache.js";
import {
  markTaskQueryCacheScopesStale,
  useTaskQueryCacheStore,
} from "@/store/taskQueryCacheStore.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import {
  isRemoteWorkspaceTarget,
  resolveWorkspaceRemoteSessionId,
  resolveWorkspaceServices,
} from "@/lib/workspaceServiceResolver.js";
import { useWorkspaceTaskOptimisticOverlayByWorkspaceKey } from "@/hooks/workspaceTaskListOptimisticOverlay.js";
import {
  buildWorkspaceTaskListDisplayGroups,
  type WorkspaceTaskListGroup,
} from "@/hooks/workspaceTaskListDisplayGroups.js";
import {
  buildWorkspaceRemoteSessionSignature,
  buildWorkspaceTaskListVersionSignature,
} from "@/hooks/workspaceTaskListRefreshSignatures.js";
import { shouldRefetchTaskListMembershipForWorkspaceEvent } from "@/lib/taskListRefreshPolicy.js";
import { syncTaskUnreadFromStatusWorkspaceEvent } from "@/lib/taskStatusUnreadSync.js";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { fetchTaskListMembershipSetsForEndpointsCached } from "@/lib/taskListMembershipSets.js";
import { buildTaskListResult } from "@/v4/buildTaskListResultFromSessions.js";
import {
  bumpTaskListMembershipVersionForWorkspaceEvent,
  useTaskListMembershipVersion,
} from "@/v4/taskListMembershipVersion.js";
import {
  buildWorkspaceSessionsIndexSourceKey,
  useWorkspaceSessionsIndexItems,
} from "@/v4/useWorkspaceSessionsIndexItems.js";
import { resolveWorkspaceTaskVisibleLimit } from "@/lib/workspaceTaskPagination.js";

interface WorkspaceTaskListQueryConfig {
  scope: {
    workspacePath: string;
    workspaceIdentity?: string;
  };
  workspaceKey: string;
  remoteSessionId?: string;
  isRemoteWorkspace: boolean;
  visibleLimit: number;
  descriptor: ReturnType<typeof buildTaskListCacheDescriptor>;
  queryKey: string;
}

interface WorkspaceTaskListEndpointShard {
  shardKey: string;
  services: IServiceAccessor;
  configs: WorkspaceTaskListQueryConfig[];
}

interface WorkspaceTaskListGroupResult {
  workspacePath: string;
  workspaceIdentity?: string;
  items: ZCodeTaskMeta[];
  total: number;
  hasMore: boolean;
  unreadTaskKeys: string[];
}

interface WorkspaceTaskListRefreshFlight {
  requestId: number;
  signature: string;
  activityRevision: string;
  membershipVersion: number;
}

function updateBlockingLoadingState(
  current: Record<string, boolean>,
  blockingWorkspaceKeys: string[],
): Record<string, boolean> {
  const uniqueKeys = [...new Set(blockingWorkspaceKeys)];
  const currentKeys = Object.keys(current);
  if (
    currentKeys.length === uniqueKeys.length &&
    uniqueKeys.every((workspaceKey) => current[workspaceKey] === true)
  ) {
    return current;
  }
  return Object.fromEntries(uniqueKeys.map((workspaceKey) => [workspaceKey, true]));
}

// Workspace groups treat tasks-index task rows as the persistent source; sessions-index only
// enriches activity/detail. Remote shards use their own endpoint task service, returning a group
// map shaped like the legacy protocol.
async function buildWorkspaceGroupsFromSessions(params: {
  service: IServiceAccessor["zcodeTaskService"];
  scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>;
  sessions: ZCodeTaskMeta[];
  sortBy: "created" | "updated";
  /** Delta update: membership changes only with membershipVersion; cache by version to avoid refetching per content frame. */
  membershipCacheKey: string;
}): Promise<Map<string, WorkspaceTaskListGroupResult>> {
  const {
    taskIndexItems,
    pinnedIds,
    archivedIds,
    deletedIds,
    unreadAtByTaskId,
    terminalStatusByTaskId,
    titleOverrideByTaskId,
    cronAutomationIdByTaskId,
  } = await fetchTaskListMembershipSetsForEndpointsCached({
    cacheKey: params.membershipCacheKey,
    endpoints: [{ service: params.service, scopes: params.scopes }],
  });
  const map = new Map<string, WorkspaceTaskListGroupResult>();
  for (const scope of params.scopes) {
    const scopeKey = buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity);
    const scopeSessions = params.sessions.filter(
      (task) => buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity) === scopeKey,
    );
    const scopeTaskIndexItems = taskIndexItems.filter(
      (task) => buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity) === scopeKey,
    );
    // "workspace" view rule = !pinned && !archived, same as "timeline" (matchesTaskMembership).
    const result = buildTaskListResult({
      taskIndexItems: scopeTaskIndexItems,
      sessions: scopeSessions,
      kind: "timeline",
      pinnedIds,
      archivedIds,
      deletedIds,
      unreadAtByTaskId,
      terminalStatusByTaskId,
      titleOverrideByTaskId,
      cronAutomationIdByTaskId,
      sortBy: params.sortBy,
    });
    map.set(scopeKey, {
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      items: result.items,
      total: result.total,
      hasMore: false,
      // Workspace tasks are paginated before entering the query cache; checking visible items
      // only would miss unread ones outside the page window. Freeze member keys over the full
      // regular-task result instead.
      unreadTaskKeys: result.items
        .filter((task) => typeof task.unreadAt === "number")
        .map((task) => buildTaskEntityKey(task)),
    });
  }
  return map;
}

/**
 * Relies on the sessions-index aggregation layer's reference stabilization: identical entry
 * references = equal content. Only workspaces owning entries whose references differ between
 * rounds count as "changed".
 */
function diffChangedWorkspaceKeys(previous: ZCodeTaskMeta[], next: ZCodeTaskMeta[]): Set<string> {
  const changed = new Set<string>();
  const previousSet = new Set(previous);
  const nextSet = new Set(next);
  for (const item of next) {
    if (!previousSet.has(item)) {
      changed.add(buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity));
    }
  }
  for (const item of previous) {
    if (!nextSet.has(item)) {
      changed.add(buildTaskWorkspaceKey(item.workspacePath, item.workspaceIdentity));
    }
  }
  return changed;
}

function buildWorkspaceEventSubscriptionSignature(
  shards: WorkspaceTaskListEndpointShard[],
): string {
  return shards
    .map((shard) => {
      const workspaceKeys = [...new Set(shard.configs.map((config) => config.workspaceKey))].sort(
        (left, right) => left.localeCompare(right),
      );
      return `${shard.shardKey}:${workspaceKeys.join("|")}`;
    })
    .join("||");
}

export function useWorkspaceTaskLists(params: {
  workspaceTabs: WorkspaceTabState[];
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  sortBy: "created" | "updated";
  visibleLimitByWorkspaceKey: Readonly<Record<string, number>>;
  defaultVisibleLimit: number;
}) {
  const baseServices = useBaseWorkspaceServices();
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
  const setQueryResults = useTaskQueryCacheStore((state) => state.setQueryResults);
  const resultsByQueryKey = useTaskQueryCacheStore((state) => state.resultsByQueryKey);
  const taskMetaByEntityKey = useTaskQueryCacheStore((state) => state.taskMetaByEntityKey);
  const taskUnreadOverlayByEntityKey = useTaskQueryCacheStore(
    (state) => state.taskUnreadOverlayByEntityKey,
  );
  const inFlightRequestRef = useRef<WorkspaceTaskListRefreshFlight | null>(null);
  const nextRequestIdRef = useRef(0);
  const rerunRequestedRef = useRef(false);
  const groupCacheRef = useRef<Map<string, WorkspaceTaskListGroup>>(new Map());
  const taskListVersionSignature = useZCodeSessionStore((state) =>
    buildWorkspaceTaskListVersionSignature(
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
  const optimisticTaskOverlayByWorkspaceKey = useWorkspaceTaskOptimisticOverlayByWorkspaceKey(
    params.workspaceTabs,
  );
  const taskListVersionByWorkspaceKey = useMemo(
    () => new Map<string, number>(JSON.parse(taskListVersionSignature) as Array<[string, number]>),
    [taskListVersionSignature],
  );
  const remoteSessionSignature = useMemo(
    () =>
      buildWorkspaceRemoteSessionSignature(
        params.workspaceTabs.map((tab) => {
          const workspaceKey = buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity);
          const resolvedRemoteSessionId = resolveWorkspaceRemoteSessionId(
            tab,
            serviceResolverState,
          );
          return {
            workspaceKey,
            remoteSessionId: resolvedRemoteSessionId,
            ready: resolvedRemoteSessionId ? Boolean(sessionsById[resolvedRemoteSessionId]) : true,
          };
        }),
      ),
    [params.workspaceTabs, serviceResolverState, sessionsById],
  );
  const activeWorkspaceKey = useMemo(
    () => buildTaskWorkspaceKey(params.activeWorkspacePath, params.activeWorkspaceIdentity),
    [params.activeWorkspaceIdentity, params.activeWorkspacePath],
  );
  const activeWorkspaceRef = useRef({
    workspacePath: params.activeWorkspacePath,
    ...(params.activeWorkspaceIdentity
      ? { workspaceIdentity: params.activeWorkspaceIdentity }
      : {}),
  });
  // On workspace switch the old workspace keeps its own activeTaskId, and terminal-status
  // subscriptions are reused long-term per endpoint/workspace set. A callback looking only at the
  // old workspace's activeTaskId, or capturing first-render global focus, would misread a
  // backgrounded task as "still reading" and miss its unread flag.
  activeWorkspaceRef.current = {
    workspacePath: params.activeWorkspacePath,
    ...(params.activeWorkspaceIdentity
      ? { workspaceIdentity: params.activeWorkspaceIdentity }
      : {}),
  };
  const queryConfigs = useMemo(
    () =>
      params.workspaceTabs.map((tab) => {
        const scope = {
          workspacePath: tab.workspacePath,
          workspaceIdentity: tab.workspaceIdentity,
        };
        const resolvedRemoteSessionId = resolveWorkspaceRemoteSessionId(tab, serviceResolverState);
        const isRemoteWorkspace = isRemoteWorkspaceTarget(tab, resolvedRemoteSessionId);
        const workspaceKey = buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity);
        const visibleLimit = resolveWorkspaceTaskVisibleLimit(
          params.visibleLimitByWorkspaceKey,
          workspaceKey,
          params.defaultVisibleLimit,
        );
        const descriptor = buildTaskListCacheDescriptor({
          kind: "workspace",
          workspaceScopes: [scope],
          sortBy: params.sortBy,
          search: "",
          expanded: false,
          visibleLimit,
        });
        return {
          scope,
          workspaceKey,
          remoteSessionId: resolvedRemoteSessionId,
          isRemoteWorkspace,
          visibleLimit,
          descriptor,
          // Every workspace group's queryKey used to fold in a signature of ALL tabs' versions.
          // Archiving one local task refreshed every workspace's queryKey at once, instantly
          // invalidating caches, slowing refresh while a remote connects, and showing "No tasks
          // yet" across all local workspaces. Use only this workspace's own version so unrelated
          // workspaces are not cleared collaterally.
          queryKey:
            buildTaskListCacheKeyFromDescriptor(descriptor) +
            `::version=${taskListVersionByWorkspaceKey.get(workspaceKey) ?? 0}`,
        };
      }),
    [
      params.defaultVisibleLimit,
      params.sortBy,
      params.visibleLimitByWorkspaceKey,
      params.workspaceTabs,
      serviceResolverState,
      taskListVersionByWorkspaceKey,
    ],
  );
  const endpointShards = useMemo(() => {
    const shardMap = new Map<
      string,
      {
        services: IServiceAccessor;
        configs: WorkspaceTaskListQueryConfig[];
      }
    >();

    for (const config of queryConfigs) {
      const resolvedServices = resolveWorkspaceServices(
        {
          ...config.scope,
          remoteSessionId: config.remoteSessionId,
        },
        baseServices,
        serviceResolverState,
      );
      if (!resolvedServices) {
        continue;
      }

      const shardKey = resolvedServices.remoteSessionId ?? "__base__";

      const shard = shardMap.get(shardKey) ?? {
        services: resolvedServices.services,
        configs: [],
      };
      shard.configs.push(config);
      shardMap.set(shardKey, shard);
    }

    return [...shardMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map<WorkspaceTaskListEndpointShard>(([shardKey, shard]) => ({
        shardKey,
        services: shard.services,
        configs: shard.configs,
      }));
  }, [baseServices, queryConfigs, serviceResolverState]);
  const endpointShardsRef = useRef(endpointShards);
  endpointShardsRef.current = endpointShards;
  const workspaceEventSubscriptionSignature = useMemo(
    () => buildWorkspaceEventSubscriptionSignature(endpointShards),
    [endpointShards],
  );
  // List source = sessions-index. Remote shards (web/phone remote control/SSH workspaces) also
  // go through sessions-index -- the scope carries the endpoint dimension and that endpoint's
  // agentService proxy. Tabs without a resolved remote session (disconnected placeholders) are
  // absent from endpointShards and subscribe automatically after reconnect.
  const sessionsIndexScopes = useMemo(
    () =>
      endpointShards.flatMap((shard) =>
        shard.configs.map((config) => ({
          workspacePath: config.scope.workspacePath,
          ...(config.scope.workspaceIdentity
            ? { workspaceIdentity: config.scope.workspaceIdentity }
            : {}),
          ...(shard.shardKey === "__base__" ? {} : { endpointKey: shard.shardKey }),
          agentService: shard.services.zcodeAgentService,
        })),
      ),
    [endpointShards],
  );
  const { items: sessionsIndexItems, sourceRevisionByScopeKey } =
    useWorkspaceSessionsIndexItems(sessionsIndexScopes);
  // pin/archive membership version: bumped after a mutation (local optimistic or remote event)
  // to drive an authoritative re-filter.
  const membershipVersion = useTaskListMembershipVersion();
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const pendingConfigs = useMemo(() => {
    const pending = queryConfigs.filter((config) => {
      const cachedResult = resultsByQueryKey[config.queryKey];
      return cachedResult == null || cachedResult.stale;
    });
    const activePending = pending.filter((config) => config.workspaceKey === activeWorkspaceKey);
    if (activePending.length > 0) {
      // Querying every historical workspace at once on cold start competes with the current
      // workspace's model readState, leaving "manage models/loading" stuck under the composer.
      // Let the current workspace's task list and model state finish first; backfill the rest in
      // the background once the current cache settles.
      return activePending;
    }
    return pending;
  }, [activeWorkspaceKey, queryConfigs, resultsByQueryKey]);
  const sessionsIndexRevision = useMemo(
    () =>
      pendingConfigs
        .map((config) => {
          const sourceKey = buildWorkspaceSessionsIndexSourceKey({
            workspacePath: config.scope.workspacePath,
            ...(config.scope.workspaceIdentity
              ? { workspaceIdentity: config.scope.workspaceIdentity }
              : {}),
            ...(config.remoteSessionId ? { endpointKey: config.remoteSessionId } : {}),
          });
          return `${sourceKey}=${sourceRevisionByScopeKey[sourceKey] ?? "missing"}`;
        })
        .sort()
        .join("|"),
    [pendingConfigs, sourceRevisionByScopeKey],
  );
  const requestSignature = useMemo(
    () =>
      [
        params.sortBy,
        taskListVersionSignature,
        remoteSessionSignature,
        `activity=${sessionsIndexRevision}`,
        `membership=${membershipVersion}`,
        ...pendingConfigs.map(
          (config) =>
            `${config.workspaceKey}:${config.remoteSessionId ?? "base"}:limit=${config.visibleLimit}:${config.queryKey}:invalidation=${resultsByQueryKey[config.queryKey]?.invalidationVersion ?? 0}`,
        ),
      ].join("||"),
    [
      membershipVersion,
      pendingConfigs,
      params.sortBy,
      remoteSessionSignature,
      resultsByQueryKey,
      sessionsIndexRevision,
      taskListVersionSignature,
    ],
  );
  const latestRefreshInputRef = useRef({
    requestSignature,
    sessionsIndexRevision,
    membershipVersion,
  });
  latestRefreshInputRef.current = {
    requestSignature,
    sessionsIndexRevision,
    membershipVersion,
  };

  const refresh = useCallback(async () => {
    if (pendingConfigs.length === 0) {
      if (inFlightRequestRef.current === null) {
        setLoading((current) => updateBlockingLoadingState(current, []));
      }
      return;
    }

    const currentFlight = inFlightRequestRef.current;
    if (currentFlight) {
      if (currentFlight.signature !== requestSignature) {
        // While a membership RPC for the same list query is in flight, sessions-index can still
        // converge from running to completed/error. Single-flighting by query signature alone
        // swallows the second invalidation; record the latest input here and run one more round
        // after the current flight settles.
        rerunRequestedRef.current = true;
      }
      return;
    }

    const requestId = ++nextRequestIdRef.current;
    const flight: WorkspaceTaskListRefreshFlight = {
      requestId,
      signature: requestSignature,
      activityRevision: sessionsIndexRevision,
      membershipVersion,
    };
    inFlightRequestRef.current = flight;
    const sessionsForRequest = sessionsIndexItems;
    const expectedInvalidationVersionByQueryKey = new Map(
      pendingConfigs.map((config) => [
        config.queryKey,
        resultsByQueryKey[config.queryKey]?.invalidationVersion ?? 0,
      ]),
    );
    // sessions-index status/title changes mark existing queries stale and recompute in the
    // background. Stale results remain safe to show; toggling loading here too would flip the
    // whole workspace row's loading prop on click/restore-of-history and, combined with hard
    // invalidation, flash "fetching tasks". Only first hydration with no cache at all is blocking
    // loading; everything cached goes stale-while-revalidate.
    const blockingWorkspaceKeys = pendingConfigs
      .filter((config) => {
        if (resultsByQueryKey[config.queryKey] != null) {
          return false;
        }
        const previousGroup = groupCacheRef.current.get(config.workspaceKey);
        return !previousGroup || (previousGroup.items.length === 0 && previousGroup.total === 0);
      })
      .map((config) => config.workspaceKey);
    setLoading((current) => updateBlockingLoadingState(current, blockingWorkspaceKeys));

    try {
      const pendingConfigKeys = new Set(pendingConfigs.map((config) => config.queryKey));
      const entries = (
        await Promise.all(
          endpointShards.map(async (shard) => {
            const shardConfigs = shard.configs.filter((config) =>
              pendingConfigKeys.has(config.queryKey),
            );
            if (shardConfigs.length === 0) {
              return [];
            }

            // Local and remote shards both take task rows from their endpoint's tasks-index,
            // then enrich with same-endpoint/workspace sessions-index activity/detail.
            const groupByWorkspaceKey = await buildWorkspaceGroupsFromSessions({
              service: shard.services.zcodeTaskService,
              scopes: shardConfigs.map((config) => config.scope),
              sessions: sessionsForRequest,
              sortBy: params.sortBy,
              membershipCacheKey: `${membershipVersion}::workspace::${shard.shardKey}::${shardConfigs
                .map((config) => `${config.workspaceKey}@${taskListVersionSignature}`)
                .join("|")}`,
            });

            return shardConfigs.map((config) => {
              const group = groupByWorkspaceKey.get(config.workspaceKey) ?? {
                workspacePath: config.scope.workspacePath,
                workspaceIdentity: config.scope.workspaceIdentity,
                items: [],
                total: 0,
                hasMore: false,
                unreadTaskKeys: [],
              };
              const visibleItems = group.items.slice(0, config.visibleLimit);
              return {
                queryKey: config.queryKey,
                descriptor: config.descriptor,
                items: visibleItems,
                total: group.total,
                hasMore: group.total > visibleItems.length,
                unreadTaskKeys: group.unreadTaskKeys,
                expectedInvalidationVersion: expectedInvalidationVersionByQueryKey.get(
                  config.queryKey,
                ),
              };
            });
          }),
        )
      ).flat();

      // Each workspace queryKey used to set the cache separately while the effect depended on
      // the whole resultsByQueryKey, so "first result batch written -> still missing -> next
      // refresh round" chained. One batched write per query round yields a single store update
      // and cuts the cascade.
      // A remote workspace's task index lives in the remote sqlite; base services must not query
      // the local one. Shard requests by remoteSessionId, and skip writing an empty cache while
      // the remote session is unregistered -- it re-queries once the session exists.
      const latestInput = latestRefreshInputRef.current;
      const canCommit =
        inFlightRequestRef.current?.requestId === requestId &&
        latestInput.requestSignature === flight.signature &&
        latestInput.sessionsIndexRevision === flight.activityRevision &&
        latestInput.membershipVersion === flight.membershipVersion;
      if (entries.length > 0 && canCommit) {
        setQueryResults(entries);
      } else if (!canCommit) {
        // Stale activity/membership results must not write the entity cache or clear stale flags;
        // finally triggers the latest round.
        rerunRequestedRef.current = true;
      }
    } catch (error) {
      logger.error("[useWorkspaceTaskLists] Failed to load workspace task lists", error);
    } finally {
      if (inFlightRequestRef.current?.requestId === requestId) {
        inFlightRequestRef.current = null;
        setLoading((current) => updateBlockingLoadingState(current, []));
        const latestInput = latestRefreshInputRef.current;
        const shouldRerun =
          rerunRequestedRef.current ||
          latestInput.requestSignature !== flight.signature ||
          latestInput.sessionsIndexRevision !== flight.activityRevision ||
          latestInput.membershipVersion !== flight.membershipVersion;
        rerunRequestedRef.current = false;
        if (shouldRerun) {
          setRefreshTrigger((generation) => generation + 1);
        }
      }
    }
  }, [
    endpointShards,
    membershipVersion,
    pendingConfigs,
    params.sortBy,
    requestSignature,
    resultsByQueryKey,
    sessionsIndexItems,
    sessionsIndexRevision,
    setQueryResults,
  ]);
  useEffect(() => {
    if (pendingConfigs.length === 0) {
      return;
    }

    void refresh();
  }, [pendingConfigs.length, refresh, refreshTrigger, requestSignature]);

  // sessions-index list change / pin-archive membership version change -> mark local scope
  // caches stale so the refresh above recomputes with fresh data. sessions-index is a conflated
  // low-frequency list event, not a high-frequency snapshot.
  // Loop guard: marking caches stale re-renders, and a parent rebuilding the workspaceTabs array
  // per render would refresh scope array identity too. Only real "items reference / membership
  // version" changes count, avoiding a setState loop.
  const lastSessionsRefreshRef = useRef<{
    items: ZCodeTaskMeta[];
    membershipVersion: number;
  } | null>(null);
  useEffect(() => {
    if (sessionsIndexScopes.length === 0) {
      return;
    }
    const last = lastSessionsRefreshRef.current;
    if (last && last.items === sessionsIndexItems && last.membershipVersion === membershipVersion) {
      return;
    }
    const membershipChanged = !last || last.membershipVersion !== membershipVersion;
    const previousItems = last?.items ?? null;
    lastSessionsRefreshRef.current = {
      items: sessionsIndexItems,
      membershipVersion,
    };
    if (membershipChanged || previousItems === null) {
      markTaskQueryCacheScopesStale(sessionsIndexScopes);
      return;
    }
    // The sessions-index aggregation layer reference-stabilizes entries: identical reference =
    // equal content. Previously any frame marked every workspace's row cache stale,
    // reloading all sidebar workspace lists on each open/settle of one task. Diff the workspaces
    // that really changed and stale only those scopes.
    const changedWorkspaceKeys = diffChangedWorkspaceKeys(previousItems, sessionsIndexItems);
    if (changedWorkspaceKeys.size === 0) {
      return;
    }
    const changedScopes = sessionsIndexScopes.filter((scope) =>
      changedWorkspaceKeys.has(buildTaskWorkspaceKey(scope.workspacePath, scope.workspaceIdentity)),
    );
    if (changedScopes.length > 0) {
      markTaskQueryCacheScopesStale(changedScopes);
    }
  }, [sessionsIndexItems, membershipVersion, sessionsIndexScopes]);

  useEffect(() => {
    const subscribedEndpointShards = endpointShardsRef.current;
    if (subscribedEndpointShards.length === 0) {
      return;
    }

    const disposables: Array<{ dispose(): void }> = [];
    for (const shard of subscribedEndpointShards) {
      const configByWorkspaceKey = new Map(
        shard.configs.map((config) => [config.workspaceKey, config]),
      );

      for (const config of configByWorkspaceKey.values()) {
        const disposable = shard.services.zcodeTaskService.onDynamicWorkspaceEvent({
          workspacePath: config.scope.workspacePath,
          ...(config.scope.workspaceIdentity
            ? { workspaceIdentity: config.scope.workspaceIdentity }
            : {}),
        })((event: ZCodeWorkspaceEvent) => {
          if (event.type !== "workspace_task_list_changed") {
            return;
          }
          const eventWorkspaceKey = buildTaskWorkspaceKey(
            event.workspacePath,
            event.workspaceIdentity,
          );
          if (eventWorkspaceKey !== config.workspaceKey) {
            return;
          }
          syncTaskUnreadFromStatusWorkspaceEvent({
            activeWorkspace: activeWorkspaceRef.current,
            event,
            service: shard.services.zcodeTaskService,
          });
          if (!shouldRefetchTaskListMembershipForWorkspaceEvent(event)) {
            return;
          }

          // Archive/pin initiated from web remote control has no local optimistic mutation on
          // the desktop workspace row. Listen only to low-frequency membership events and stale
          // the affected workspace query, keeping transcript events from triggering full refetches.
          logger.info(
            `[useWorkspaceTaskLists] workspace_task_list_changed needs full refresh; refreshing workspace row workspace=${config.scope.workspacePath} reason=${event.reason}`,
          );
          // pin/archive/unread membership persists in tasks-index, invisible to sessions-index.
          // Membership events (local mutations emit too; unread/rename via task_meta_changed) bump
          // the version so derived lists re-pull the membership join surface.
          // useGlobalTaskList's shared subscription forwards the same event and bumps as well;
          // dedupe by event content so one event triggers one global membership refresh.
          bumpTaskListMembershipVersionForWorkspaceEvent(event);
          markTaskQueryCacheScopesStale([config.scope]);
        });
        disposables.push(disposable);
      }
    }

    return () => {
      for (const disposable of disposables) {
        disposable.dispose();
      }
    };
  }, [workspaceEventSubscriptionSignature]);

  const groups = useMemo(() => {
    const result = buildWorkspaceTaskListDisplayGroups({
      queryConfigs,
      resultsByQueryKey,
      taskMetaByEntityKey,
      taskUnreadOverlayByEntityKey,
      optimisticTaskOverlayByWorkspaceKey,
      previousGroupsByWorkspaceKey: groupCacheRef.current,
      sortBy: params.sortBy,
    });
    groupCacheRef.current = result.cache;
    return result.groups;
  }, [
    optimisticTaskOverlayByWorkspaceKey,
    params.sortBy,
    queryConfigs,
    resultsByQueryKey,
    taskMetaByEntityKey,
    taskUnreadOverlayByEntityKey,
  ]);

  return {
    groups,
    loadingByWorkspaceKey: loading,
    refresh,
  };
}
