import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ZCodePluginReferenceCatalogEntry,
  ZCodePluginsReferenceCatalogResult,
} from "@zcode/shared";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

interface PluginReferenceCatalogState {
  entries: ZCodePluginReferenceCatalogEntry[];
  authority: "session" | "workspace" | null;
  loading: boolean;
  error: string | null;
}

const EMPTY_STATE: PluginReferenceCatalogState = {
  entries: [],
  authority: null,
  loading: false,
  error: null,
};

interface ScopedPluginReferenceCatalogState {
  scope: object | null;
  value: PluginReferenceCatalogState;
}

const EMPTY_SCOPED_STATE: ScopedPluginReferenceCatalogState = {
  scope: null,
  value: EMPTY_STATE,
};

interface PluginReferenceCatalogOptions {
  preferredRemoteSessionId?: string;
  /** Explicit retry generation; re-queries when the menu reopens, keeps the catalog on close. */
  refreshRevision?: number;
  /** Dedupe only unfinished same-Session requests within the current runtime; release on settle. */
  dedupeSessionRequest?: boolean;
  suppressErrorLog?: boolean;
}

let sessionCatalogRequests = new WeakMap<
  object,
  Map<string, Promise<ZCodePluginsReferenceCatalogResult>>
>();

function releaseSessionCatalogRequest(
  services: object,
  serviceCache: Map<string, Promise<ZCodePluginsReferenceCatalogResult>>,
  requestKey: string,
  request: Promise<ZCodePluginsReferenceCatalogResult>,
): void {
  // Settled promises used to stay cached forever and kept impersonating the new runtime's
  // Session authority after an agent runtime generation change. The cache only provides
  // mount-time in-flight single-flight; on settle/unmount, never delete a newer request that
  // has already replaced the same key.
  if (serviceCache.get(requestKey) !== request) return;
  serviceCache.delete(requestKey);
  if (serviceCache.size === 0) {
    sessionCatalogRequests.delete(services);
  }
}

function releaseSessionCatalogRequestWhenSettled(
  services: object,
  serviceCache: Map<string, Promise<ZCodePluginsReferenceCatalogResult>>,
  requestKey: string,
  request: Promise<ZCodePluginsReferenceCatalogResult>,
): void {
  const release = () => releaseSessionCatalogRequest(services, serviceCache, requestKey, request);
  void request.then(release, release);
}

/**
 * Plugin chat reference catalog.
 * The authority is derived from sessionId: null (new draft) resolves to the workspace's
 * current catalog; non-null (existing session) resolves to the session-owned catalog frozen
 * at session creation. Async results are validated against
 * `workspaceKey + sessionId + runtime-restart generation + request sequence`: once the key
 * changes or a newer request is issued, responses from older workspace/session/process
 * generations are dropped and never backfilled into the new target.
 */
export function usePluginReferenceCatalog(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  sessionId: string | null,
  enabled: boolean,
  options?: PluginReferenceCatalogOptions,
): PluginReferenceCatalogState {
  const resolution = useWorkspaceServicesResolution(
    workspacePath,
    options?.preferredRemoteSessionId,
    workspaceIdentity,
  );
  const [scopedState, setScopedState] =
    useState<ScopedPluginReferenceCatalogState>(EMPTY_SCOPED_STATE);
  const [runtimeRevision, setRuntimeRevision] = useState(0);
  const requestSeqRef = useRef(0);
  // Identity/isolation semantics: workspaceKey = workspaceIdentity?.trim() || workspacePath.
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  const remoteSessionId =
    resolution.remoteSessionId ?? options?.preferredRemoteSessionId ?? undefined;
  // Remote attachment is also an authority boundary. When the same workspace/session switches
  // remote runtimes, the catalog Promise frozen by the old process must not be reused.
  const requestKey = `${workspaceKey}|${remoteSessionId ?? "local"}|${sessionId ?? "draft"}|runtime:${runtimeRevision}|refresh:${options?.refreshRevision ?? 0}`;
  const services = resolution.services;
  const rpcReady = resolution.rpcReady;

  useEffect(() => {
    if (!enabled || !workspacePath || !sessionId || !rpcReady) return;
    const subscription = services.zcodeAgentService.onAgentRuntimeRestarted((event) => {
      if (event.workspaceKey !== workspaceKey) return;
      // After a runtime restart workspace/session/attachment may all be unchanged; bump the
      // generation explicitly so the old authority goes invalid on the first frame and the
      // new runtime must re-run the RPC.
      setRuntimeRevision((current) => current + 1);
    });
    return () => subscription.dispose();
  }, [enabled, rpcReady, services, sessionId, workspaceKey, workspacePath]);
  // Create a fresh request identity whenever the Picker reopens, workspace/session/remote
  // attachment changes, or the services instance reconnects. Renders only accept results for
  // the same scope, so the first frame before the effect issues a new request cannot briefly
  // leak the previous authority's catalog.
  const requestScope = useMemo(
    () => ({}),
    [enabled, remoteSessionId, requestKey, rpcReady, services, workspacePath],
  );

  useEffect(() => {
    if (!enabled || !workspacePath || !rpcReady) {
      return;
    }
    const seq = ++requestSeqRef.current;
    let cancelled = false;
    setScopedState({
      scope: requestScope,
      value: { entries: [], authority: null, loading: true, error: null },
    });
    const params = {
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
    let request: Promise<ZCodePluginsReferenceCatalogResult>;
    let requestServiceCache: Map<string, Promise<ZCodePluginsReferenceCatalogResult>> | undefined;
    if (options?.dedupeSessionRequest && sessionId) {
      let serviceCache = sessionCatalogRequests.get(services);
      if (!serviceCache) {
        serviceCache = new Map();
        sessionCatalogRequests.set(services, serviceCache);
      }
      const cached = serviceCache.get(requestKey);
      request = cached ?? services.pluginManagementService.getPluginReferenceCatalog(params);
      requestServiceCache = serviceCache;
      if (!cached) {
        serviceCache.set(requestKey, request);
        releaseSessionCatalogRequestWhenSettled(services, serviceCache, requestKey, request);
      }
    } else {
      request = services.pluginManagementService.getPluginReferenceCatalog(params);
    }
    request
      .then((result) => {
        if (cancelled || seq !== requestSeqRef.current) return;
        setScopedState({
          scope: requestScope,
          value: {
            entries: result.plugins,
            authority: result.authority,
            loading: false,
            error: null,
          },
        });
      })
      .catch((error: unknown) => {
        if (cancelled || seq !== requestSeqRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        // Fail closed: on query failure the Picker shows an error state instead of falling
        // back to another authority's data.
        if (!options?.suppressErrorLog) {
          logger.warn("[usePluginReferenceCatalog] Failed to load plugin reference catalog", {
            error: message,
            requestKey,
          });
        }
        setScopedState({
          scope: requestScope,
          value: {
            entries: [],
            authority: null,
            loading: false,
            error: message,
          },
        });
      });
    return () => {
      cancelled = true;
      if (requestServiceCache) {
        releaseSessionCatalogRequest(services, requestServiceCache, requestKey, request);
      }
    };
    // requestKey already covers the workspaceKey/sessionId combination changes.
  }, [
    enabled,
    options?.dedupeSessionRequest,
    options?.suppressErrorLog,
    remoteSessionId,
    requestKey,
    requestScope,
    rpcReady,
    services,
    sessionId,
    workspaceIdentity,
    workspacePath,
  ]);

  if (!enabled || !workspacePath || !rpcReady || scopedState.scope !== requestScope) {
    return EMPTY_STATE;
  }
  return scopedState.value;
}
