// Aggregates sessions-index sessions across workspace scopes into ZCodeTaskMeta[] (reactive),
// feeding the sidebar lists' live activity/detail; persistent rows come from tasks-index.
// Shared across consumers: one endpoint+workspace subscription is refcounted via
// sessionsIndexRegistry (the foundation). A scope carries its endpoint dimension and that
// endpoint's agentService (from resolveWorkspaceServices); remote shards (web/phone-remote/SSH
// workspaces) ride the same sessions-index path via the @zcode/rpc proxy.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { compareZCodeTaskListItems } from "@/lib/taskListOrdering.js";
import { mapSessionSummaryToTaskMeta } from "@/v4/mapSessionSummaryToTaskMeta.js";
import {
  buildTaskListItemIdentityKey,
  stabilizeTaskListItems,
} from "@/v4/taskListItemStabilization.js";
import {
  LOCAL_SESSIONS_INDEX_ENDPOINT,
  buildSessionsIndexEntryKey,
  type SessionsIndexAgentService,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";
import type { SessionsIndexStore } from "@/v4/sessionsIndexStore.js";
import {
  WorkspaceSessionsIndexSubscriptionSet,
  type WorkspaceSessionsIndexBinding,
} from "@/v4/workspaceSessionsIndexSubscriptionSet.js";

export interface WorkspaceSessionsIndexScope {
  workspacePath: string;
  workspaceIdentity?: string;
  /** Endpoint dimension (the remote shard remoteSessionId); default = local __base__. */
  endpointKey?: string;
  /** The scope endpoint's agent service (from resolveWorkspaceServices); default = base services. */
  agentService?: SessionsIndexAgentService;
}

interface WorkspaceSessionsIndexItemsResult {
  /** Aggregated session metas (running first, rest by updatedAt desc; tick-driven recompute, stable references). */
  items: ZCodeTaskMeta[];
  /**
   * Read-only generation per endpoint+workspace scope: the service binding plus the store's
   * logEpoch/seq, letting the async tasks-index membership join reject stale activity snapshots
   * precisely.
   */
  sourceRevisionByScopeKey: Readonly<Record<string, string>>;
  /**
   * Endpoints subscribed but awaiting their first snapshot ("__base__" or a remoteSessionId).
   * Consumers keep loading/syncing hints with it, so a slow remote first frame never reads as
   * an empty list.
   */
  hydratingEndpointKeys: string[];
}

/** Workspace reuse key = the services resolveWorkspaceKey rule (identity ?? path). */
function workspaceKeyOf(scope: WorkspaceSessionsIndexScope): string {
  return scope.workspaceIdentity?.trim() || scope.workspacePath;
}

function entryKeyOf(scope: WorkspaceSessionsIndexScope): string {
  return buildSessionsIndexEntryKey({
    workspaceKey: workspaceKeyOf(scope),
    ...(scope.endpointKey ? { endpointKey: scope.endpointKey } : {}),
  });
}

export function buildWorkspaceSessionsIndexSourceKey(
  scope: Pick<WorkspaceSessionsIndexScope, "workspacePath" | "workspaceIdentity" | "endpointKey">,
): string {
  return entryKeyOf(scope);
}

function toRegistryScope(scope: WorkspaceSessionsIndexScope): SessionsIndexScope {
  return {
    workspaceKey: workspaceKeyOf(scope),
    workspacePath: scope.workspacePath,
    ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
    ...(scope.endpointKey ? { endpointKey: scope.endpointKey } : {}),
  };
}

function buildScopeBindingKey(
  scope: WorkspaceSessionsIndexScope,
  agentService: SessionsIndexAgentService,
): string {
  return `${buildSessionsIndexEntryKey(toRegistryScope(scope), agentService)}\0path:${scope.workspacePath}`;
}

/** The store holds no snapshot yet (connecting/first frame pending); error is not hydrating (avoids eternal loading). */
function isHydratingStore(store: SessionsIndexStore): boolean {
  return (
    store.getState().workspaceId === null &&
    (store.getStatus() === "idle" || store.getStatus() === "connecting")
  );
}

/**
 * Subscribes the given workspace scopes' sessions-index and aggregates ZCodeTaskMeta[]
 * (running first, rest by updatedAt desc). Lifecycle: scope-set changes acquire/release the
 * shared stores by refcount; any store change recomputes. sessions-index changes are conflated
 * low-frequency list events, not high-frequency snapshots.
 */
export function useWorkspaceSessionsIndexItems(
  scopes: WorkspaceSessionsIndexScope[],
): WorkspaceSessionsIndexItemsResult {
  const baseServices = useBaseWorkspaceServices();
  const baseAgentService = baseServices.zcodeAgentService;

  // Stabilize the scope signature so reconcile is not recomputed per render; effect/memo read
  // the latest content-equal scopes via ref. endpointKey, workspacePath, or agentService
  // generation changes all rotate the signature.
  const signature = useMemo(
    () =>
      scopes
        .map((scope) => {
          const agentService = scope.agentService ?? baseAgentService;
          return agentService
            ? buildScopeBindingKey(scope, agentService)
            : `${entryKeyOf(scope)} ${scope.workspacePath} service-unavailable`;
        })
        .sort()
        .join("|"),
    [scopes, baseAgentService],
  );
  const scopesRef = useRef(scopes);
  scopesRef.current = scopes;

  // tick: +1 on any store change, driving the aggregate memo recompute.
  const [tick, setTick] = useState(0);
  const bumpTick = useCallback(() => setTick((n) => n + 1), []);
  const subscriptionSetRef = useRef<WorkspaceSessionsIndexSubscriptionSet | null>(null);
  if (subscriptionSetRef.current === null) {
    subscriptionSetRef.current = new WorkspaceSessionsIndexSubscriptionSet(bumpTick);
  }
  const subscriptionSet = subscriptionSetRef.current;

  useEffect(() => {
    const bindings: WorkspaceSessionsIndexBinding[] = [];
    for (const scope of scopesRef.current) {
      // Guard: tests/degraded environments may lack zcodeAgentService (the sessions-index transport); skip subscribing such scopes.
      const agentService = scope.agentService ?? baseAgentService;
      if (!agentService) {
        continue;
      }
      bindings.push({ scope: toRegistryScope(scope), agentService });
    }
    subscriptionSet.reconcile(bindings);
    // The signature covers scope/endpoint/workspacePath/service-generation changes; reconcile
    // touches acquire/release only for bindings that actually changed.
  }, [signature, baseAgentService, subscriptionSet]);

  useEffect(
    () => () => {
      subscriptionSet.dispose();
    },
    [subscriptionSet],
  );

  // Aggregate per-store sessions -> ZCodeTaskMeta + hydration state (tick-driven recompute, stable references).
  const previousItemsRef = useRef<ZCodeTaskMeta[]>([]);
  const previousHydratingRef = useRef<string[]>([]);
  return useMemo(() => {
    const metas: ZCodeTaskMeta[] = [];
    const hydratingEndpointKeys = new Set<string>();
    const sourceRevisionByScopeKey: Record<string, string> = {};
    const previousByKey = new Map(
      previousItemsRef.current.map((meta) => [buildTaskListItemIdentityKey(meta), meta]),
    );
    for (const scope of scopesRef.current) {
      const sourceKey = entryKeyOf(scope);
      const agentService = scope.agentService ?? baseAgentService;
      const bindingRevision = agentService
        ? buildScopeBindingKey(scope, agentService)
        : `${sourceKey} service-unavailable`;
      const store = subscriptionSet.getStore({
        workspaceKey: workspaceKeyOf(scope),
        ...(scope.endpointKey ? { endpointKey: scope.endpointKey } : {}),
      });
      if (!store) {
        sourceRevisionByScopeKey[sourceKey] = `${bindingRevision}:missing`;
        continue;
      }
      const storeState = store.getState();
      sourceRevisionByScopeKey[sourceKey] =
        `${bindingRevision}:${storeState.logEpoch ?? "none"}:${storeState.seq}:${store.getStatus()}`;
      if (isHydratingStore(store)) {
        hydratingEndpointKeys.add(scope.endpointKey ?? LOCAL_SESSIONS_INDEX_ENDPOINT);
      }
      for (const summary of store.getSessions()) {
        metas.push(
          mapSessionSummaryToTaskMeta(summary, {
            workspacePath: scope.workspacePath,
            ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
            previous: previousByKey.get(buildSummaryIdentityKey(scope, summary.sessionId)),
          }),
        );
      }
    }
    metas.sort((a, b) => compareZCodeTaskListItems(a, b, "updated"));
    // Every tick rebuilds metas wholesale; even with identical content (say a cold restore
    // swapping the seed for the live projection, changing only preview fields the lists never
    // read), downstream treats a brand-new array reference as new data: the grouped view
    // refreshes whole-tree, workspace row caches invalidate, every list republishes - seen as
    // opening one historical task reloads the entire left sidebar. Stabilize per item: reuse the
    // old object when content-equal and the old array when the table is equal, so every
    // identity-dependent effect short-circuits.
    const items = stabilizeTaskListItems(previousItemsRef.current, metas);
    previousItemsRef.current = items;
    const nextHydrating = [...hydratingEndpointKeys].sort();
    const hydrating =
      nextHydrating.length === previousHydratingRef.current.length &&
      nextHydrating.every((key, index) => key === previousHydratingRef.current[index])
        ? previousHydratingRef.current
        : nextHydrating;
    previousHydratingRef.current = hydrating;
    return {
      items,
      sourceRevisionByScopeKey,
      hydratingEndpointKeys: hydrating,
    };
  }, [signature, subscriptionSet, tick]);
}

function buildSummaryIdentityKey(scope: WorkspaceSessionsIndexScope, sessionId: string): string {
  return `${scope.workspaceIdentity?.trim() || scope.workspacePath}::${sessionId}`;
}
