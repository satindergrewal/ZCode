// SessionsIndexStore registry keyed by endpoint + workspaceKey (refcount) - the foundation for multi-pane/multi-list
// consumers subscribing in parallel: consumers on one endpoint+workspace share a single sessions-index subscription
// (sidebar data-source switches land here for consumers like useGlobalTaskList that take workspace scope arrays
// and cannot call hooks per scope). Isomorphic to the SessionDataLayer per-session acquire/release.
// The reuse key adds the endpoint dimension - a remote shard (web/phone-remote/SSH workspace) sessions-index
// runs on its own endpoint agentService proxy; the same key on different endpoints never shares a store.
import type { IZCodeAgentService } from "@zcode/services";
import { logger } from "@/logger.js";
import { remoteAgentServiceGeneration } from "@/lib/remoteAgentServiceGeneration.js";
import { findRemoteWorkspaceSessionIdForAgentService } from "@/store/remoteWorkspaceSessionStore.js";
import { createAgentSessionsIndexTransport } from "@/v4/agentSessionsIndexTransport.js";
import { SessionsIndexStore } from "@/v4/sessionsIndexStore.js";

/** The narrow agentService surface the registry needs (= the transport dependency surface, for test injection). */
export type SessionsIndexAgentService = Pick<
  IZCodeAgentService,
  | "subscribeSessionsIndexV4"
  | "resyncSessionsIndexV4"
  | "helloConversationV4"
  | "initializeConversationV4"
  | "unsubscribeSessionsIndexV4"
  | "onDynamicSessionsIndexFrame"
  | "onAgentRuntimeRestarted"
>;

interface RegistryEntry {
  key: string;
  agentService: SessionsIndexAgentService;
  agentServiceGeneration: number;
  store: SessionsIndexStore;
  refCount: number;
}

const registry = new Map<string, RegistryEntry>();
const entriesByStore = new WeakMap<SessionsIndexStore, RegistryEntry>();
/** Endpoint-mismatch scopes already reported; repeated acquires of one scope (rerender/multi-consumer) log once. */
const reportedScopeEndpointMismatches = new Set<string>();

/** Reserved key of the local endpoint (same convention as the task-list shardKey). */
export const LOCAL_SESSIONS_INDEX_ENDPOINT = "__base__";

export interface SessionsIndexScope {
  /** Workspace reuse key (= services resolveWorkspaceKey: workspaceIdentity ?? workspacePath). */
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /** Per endpoint: the remote-shard remoteSessionId; default = local __base__. */
  endpointKey?: string;
}

/**
 * Diagnostic: the endpoint a scope declares must match the remote session owning the agentService, or one
 * remote workspace registers twice and sends two subscriptions per topic; the CLI keeps only the
 * latest per connection/topic - the earlier one is silently replaced and the sidebar stops receiving frames, errorless.
 * Such key mismatches (e.g. Root losing remoteSessionId under a Settings overlay) leave no renderer trace in
 * production logs, only RPC-fingerprint guesswork; lifecycle logging makes them visible. Record only, never rewrite keys.
 */
function reportScopeEndpointMismatch(
  scope: SessionsIndexScope,
  agentService: SessionsIndexAgentService,
): void {
  const remoteSessionId = findRemoteWorkspaceSessionIdForAgentService(agentService);
  if (!remoteSessionId) return;
  const endpointKey = scope.endpointKey ?? LOCAL_SESSIONS_INDEX_ENDPOINT;
  if (endpointKey === remoteSessionId) return;
  const reportKey = `${endpointKey}\0${scope.workspaceKey}\0${remoteSessionId}`;
  if (reportedScopeEndpointMismatches.has(reportKey)) return;
  reportedScopeEndpointMismatches.add(reportKey);
  logger.lifecycle.warn(
    "[v4-sessions-index] scope endpoint disagrees with the remote proxy owner",
    {
      event: "v4.sessions_index.scope_endpoint_mismatch",
      endpointKey,
      remoteSessionId,
      workspaceKey: scope.workspaceKey,
      workspacePath: scope.workspacePath,
    },
  );
}

function createSessionsIndexTransport(
  scope: SessionsIndexScope,
  agentService: SessionsIndexAgentService,
) {
  const workspaceIdentity = scope.workspaceIdentity?.trim();
  return createAgentSessionsIndexTransport(agentService, {
    workspacePath: scope.workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  });
}

/** Registry entry key = endpoint + workspaceKey (same key, different endpoints never share). */
export function buildSessionsIndexEntryKey(
  scope: Pick<SessionsIndexScope, "workspaceKey" | "endpointKey">,
  agentService?: SessionsIndexAgentService,
): string {
  const entryKey = `${scope.endpointKey ?? LOCAL_SESSIONS_INDEX_ENDPOINT}\0${scope.workspaceKey}`;
  return agentService
    ? `${entryKey}\0service-generation:${remoteAgentServiceGeneration(agentService)}`
    : entryKey;
}

/** Acquire/create the shared sessions-index store for endpoint+workspace, refCount++ (first acquire subscribes). */
export function acquireSessionsIndex(
  scope: SessionsIndexScope,
  agentService: SessionsIndexAgentService,
): SessionsIndexStore {
  reportScopeEndpointMismatch(scope, agentService);
  const entryKey = buildSessionsIndexEntryKey(scope);
  const incomingServiceGeneration = remoteAgentServiceGeneration(agentService);
  const existing = registry.get(entryKey);
  if (existing?.agentService === agentService) {
    existing.refCount += 1;
    return existing.store;
  }
  if (
    existing &&
    (scope.endpointKey ?? LOCAL_SESSIONS_INDEX_ENDPOINT) !== LOCAL_SESSIONS_INDEX_ENDPOINT
  ) {
    existing.refCount += 1;
    // During a remote RPC proxy generation change, different React consumers may briefly hold old and new services.
    // The CLI keeps only the later subscription per connection/topic; a second store here would leave the old
    // store showing live/empty snapshots that never receive frames. Remote scopes reuse one store, the transport
    // switching one-way and serially by service generation; late old consumers may never switch it back.
    if (incomingServiceGeneration > existing.agentServiceGeneration) {
      existing.agentService = agentService;
      existing.agentServiceGeneration = incomingServiceGeneration;
      const transport = createSessionsIndexTransport(scope, agentService);
      // Any intermediate-proxy subscribe may pend forever; a generation change must not queue behind
      // the previous I/O. The store generation detaches the old transport synchronously and invalidates late results.
      void existing.store.replaceTransport(transport).catch((error) => {
        logger.warn("[v4-sessions-index] remote transport replacement failed", error);
      });
    }
    return existing.store;
  }
  if (existing) {
    // Local __base__ keeps its lifecycle: a service generation change mints a new store; old consumers
    // still release by store identity on cleanup, never decrementing the new entry refCount.
    registry.delete(entryKey);
    if (existing.refCount <= 0) {
      existing.store.close();
      entriesByStore.delete(existing.store);
    }
  }
  const store = new SessionsIndexStore();
  const transport = createSessionsIndexTransport(scope, agentService);
  // The initial subscribe may pend forever once the old RPC proxy dies; the generation queue must not
  // wait on that old I/O - replaceTransport invalidates its late results via the store generation.
  void store.connect(transport, { forceSnapshot: true });
  const entry: RegistryEntry = {
    key: entryKey,
    agentService,
    agentServiceGeneration: incomingServiceGeneration,
    store,
    refCount: 1,
  };
  registry.set(entryKey, entry);
  entriesByStore.set(store, entry);
  return store;
}

/** refCount--, at zero close + remove (unsubscribe + listeners). */
export function releaseSessionsIndex(
  scope: Pick<SessionsIndexScope, "workspaceKey" | "endpointKey">,
  store: SessionsIndexStore,
): void {
  const entryKey = buildSessionsIndexEntryKey(scope);
  const entry = entriesByStore.get(store);
  if (!entry || entry.key !== entryKey) return;
  entry.refCount -= 1;
  if (entry.refCount <= 0) {
    entry.store.close();
    entriesByStore.delete(entry.store);
    if (registry.get(entryKey) === entry) registry.delete(entryKey);
  }
}
