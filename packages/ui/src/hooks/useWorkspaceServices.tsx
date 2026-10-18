import type { IServiceAccessor } from "@zcode/services";
import { Event, ProxyChannel, type IChannel } from "@zcode/rpc";
import { useMemo } from "react";
import { useOptionalServices, useServices } from "@/hooks/useServices.js";
import {
  useRemoteWorkspaceSessionStore,
  type RemoteWorkspaceSession,
} from "@/store/remoteWorkspaceSessionStore.js";
import { useResolvedRemoteWorkspaceSessionId } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceTab } from "@/store/tabStore.js";
import { REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE } from "@/lib/remoteWorkspaceServiceError.js";

let disconnectedRemoteServices: IServiceAccessor | null = null;

interface WorkspaceServiceTargetTab {
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
}

function createDisconnectedRemoteServices(): IServiceAccessor {
  const createDisconnectedError = () => {
    const error = new Error(REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE) as Error & {
      code: string;
    };
    error.code = REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE;
    return error;
  };
  const disconnectedChannel: IChannel = {
    call: () => Promise.reject(createDisconnectedError()),
    listen: () => Event.None,
  };
  // The disconnected proxy used to keep its own plain-event allowlist; once
  // onAgentRuntimeRestarted was added it was misclassified as an RPC method returning a
  // Promise, and disposing the subscription crashed in Promise.dispose. Reuse the real RPC
  // proxy's event classification contract: commands reject explicitly, plain/dynamic events
  // return an empty subscription, so the two rule sets cannot drift apart again.
  const serviceProxy = ProxyChannel.toService<object>(disconnectedChannel);

  return new Proxy(Object.create(null), {
    get() {
      return serviceProxy;
    },
  }) as IServiceAccessor;
}

function getDisconnectedRemoteServices(): IServiceAccessor {
  if (!disconnectedRemoteServices) {
    disconnectedRemoteServices = createDisconnectedRemoteServices();
  }
  return disconnectedRemoteServices;
}

function resolveWorkspaceServicesForTarget(params: {
  currentContextServices: IServiceAccessor;
  resolvedRemoteSessionId: string | null;
  baseServices: IServiceAccessor | null;
  sessionsById: Record<string, Pick<RemoteWorkspaceSession, "services">>;
  isRemoteTarget: boolean;
}): IServiceAccessor {
  const resolvedServices = params.resolvedRemoteSessionId
    ? (params.sessionsById[params.resolvedRemoteSessionId]?.services ?? null)
    : params.isRemoteTarget
      ? getDisconnectedRemoteServices()
      : params.baseServices;

  if (params.isRemoteTarget && !resolvedServices) {
    return getDisconnectedRemoteServices();
  }

  return resolvedServices ?? params.currentContextServices;
}

function resolveBaseWorkspaceServices(
  contextServices: IServiceAccessor,
  registeredBaseServices: IServiceAccessor | null,
): IServiceAccessor {
  return registeredBaseServices ?? contextServices;
}

function hasRemoteWorkspaceMetadata(tab: WorkspaceServiceTargetTab | null | undefined): boolean {
  return Boolean(
    tab?.workspaceIdentity?.trim() || tab?.remoteSessionId?.trim() || tab?.remoteTarget,
  );
}

function resolveWorkspaceServiceIsRemoteTarget(params: {
  workspacePath: string | null | undefined;
  workspaceIdentity?: string | null;
  preferredRemoteSessionId?: string | null;
  activeWorkspacePath?: string | null;
  activeWorkspaceIdentity?: string | null;
  activeTab?: WorkspaceServiceTargetTab | null;
  workspaceTabs?: readonly WorkspaceServiceTargetTab[];
}): boolean {
  if (params.workspaceIdentity?.trim() || params.preferredRemoteSessionId?.trim()) {
    return true;
  }

  const workspacePath = params.workspacePath?.trim();
  if (!workspacePath) {
    return false;
  }

  if (params.activeWorkspacePath === params.workspacePath) {
    if (params.activeWorkspaceIdentity?.trim()) {
      return true;
    }

    // Logs showed a remote SSH workspace already restored as a tab while the draft-prewarm
    // path only received workspacePath, so /mnt/... was treated as local, hit base services,
    // and spawned a local agent on Windows. Guard these path-only calls with the active tab's
    // remote metadata so remote targets never fall back to the local host.
    if (
      params.activeTab?.workspacePath === params.workspacePath &&
      hasRemoteWorkspaceMetadata(params.activeTab)
    ) {
      return true;
    }
  }

  const matchingTabs = (params.workspaceTabs ?? []).filter(
    (tab) => tab.workspacePath === params.workspacePath,
  );
  return matchingTabs.length === 1 && hasRemoteWorkspaceMetadata(matchingTabs[0]);
}

export function useBaseWorkspaceServices(): IServiceAccessor {
  const contextServices = useServices();
  const registeredBaseServices = useRemoteWorkspaceSessionStore((state) => state.baseServices);

  // The app wraps a ServiceProvider around the active workspace. With a remote tab active,
  // useServices() returns the remote host; but the local shard of cross-workspace queries
  // (timeline/search/workspace) must keep querying the local host. Prefer the root services
  // registered at renderer startup so remote connections never pollute local task lists.
  return resolveBaseWorkspaceServices(contextServices, registeredBaseServices);
}

export function useOptionalBaseWorkspaceServices(): IServiceAccessor | null {
  const contextServices = useOptionalServices();
  const registeredBaseServices = useRemoteWorkspaceSessionStore((state) => state.baseServices);

  // App-global capabilities such as the usage entitlement used to resolve services from the
  // current workspace's ServiceProvider; a remote tab before attachment-ready got the
  // disconnected proxy and produced invalid RPCs. The base host is the app-global authority;
  // keep the previous context/null degradation when Web/SSR has no base services registered.
  return registeredBaseServices ?? contextServices;
}

interface WorkspaceServicesResolution {
  services: IServiceAccessor;
  remoteSessionId: string | null;
  isRemoteTarget: boolean;
  connectionKind: "local-ready" | "remote-waiting" | "remote-ready";
  rpcReady: boolean;
}

export function useWorkspaceServicesResolution(
  workspacePath: string | null | undefined,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
  remoteTarget?: unknown,
): WorkspaceServicesResolution {
  const currentContextServices = useServices();
  const resolvedRemoteSessionId = useResolvedRemoteWorkspaceSessionId(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
    remoteTarget,
  );
  const isRemoteTarget = useTabStore((state) =>
    resolveWorkspaceServiceIsRemoteTarget({
      workspacePath,
      workspaceIdentity,
      preferredRemoteSessionId,
      activeWorkspacePath: state.activeWorkspacePath,
      activeWorkspaceIdentity: state.activeWorkspaceIdentity,
      activeTab: (() => {
        const activeTab = state.activeTabId
          ? state.tabs.find((tab) => tab.id === state.activeTabId)
          : null;
        return activeTab && isWorkspaceTab(activeTab) ? activeTab : null;
      })(),
      workspaceTabs: state.tabs.filter(isWorkspaceTab),
    }),
  );
  const resolvedServices = useRemoteWorkspaceSessionStore((state) =>
    resolveWorkspaceServicesForTarget({
      currentContextServices,
      resolvedRemoteSessionId,
      baseServices: state.baseServices,
      sessionsById: state.sessionsById,
      isRemoteTarget,
    }),
  );
  const connectionKind = isRemoteTarget
    ? resolvedRemoteSessionId
      ? "remote-ready"
      : "remote-waiting"
    : "local-ready";

  // After a remote SSH host disconnect, falling back to baseServices while
  // resolvedRemoteSessionId is empty would query remote tasks like /root against the local host
  // and report "task not found". A remote target without a session must stay disconnected: the
  // disconnected proxy above yields a recoverable error instead of misrouting requests to the
  // local workspace.
  // During startup reconnect, tab metadata alone with real remote services not yet registered is
  // remote-waiting; callers must pause workspace RPCs. The disconnected proxy is only a final
  // out-of-bounds guard, not a failure to retry.
  return useMemo(
    () => ({
      services: resolvedServices,
      remoteSessionId: resolvedRemoteSessionId,
      isRemoteTarget,
      connectionKind,
      rpcReady: connectionKind !== "remote-waiting",
    }),
    [connectionKind, isRemoteTarget, resolvedRemoteSessionId, resolvedServices],
  );
}

export function useWorkspaceServices(
  workspacePath: string | null | undefined,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
  remoteTarget?: unknown,
): IServiceAccessor {
  return useWorkspaceServicesResolution(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
    remoteTarget,
  ).services;
}
