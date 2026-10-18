import type { IServiceAccessor } from "@zcode/services";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

interface WorkspaceServiceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remoteTarget?: unknown;
}

export interface WorkspaceServiceResolverState<TServices = IServiceAccessor> {
  sessionsById: Record<string, { services: TServices }>;
  sessionIdByWorkspaceIdentity: Record<string, string>;
  sessionIdByWorkspacePath: Record<string, string>;
}

interface ResolvedWorkspaceServices {
  services: IServiceAccessor;
  remoteSessionId?: string;
  isRemoteWorkspace: boolean;
}

export function resolveWorkspaceRemoteSessionId<TServices>(
  target: WorkspaceServiceTarget,
  state: WorkspaceServiceResolverState<TServices>,
): string | undefined {
  const workspaceIdentity = target.workspaceIdentity?.trim();
  const candidateSessionIds = [
    target.remoteSessionId,
    workspaceIdentity ? state.sessionIdByWorkspaceIdentity[workspaceIdentity] : undefined,
    // The same path can exist on several SSH/WSL/Docker endpoints. With an identity present but its
    // exact binding not yet restored, a path fallback would borrow another endpoint's services and
    // cross-wire sessions-index/provider/task RPC to the wrong Host. Without an identity, stay
    // remote-waiting; only legacy identity-less remote tabs keep the path-compat restoration.
    !workspaceIdentity && target.remoteTarget
      ? state.sessionIdByWorkspacePath[target.workspacePath]
      : undefined,
  ];

  return candidateSessionIds.find((sessionId): sessionId is string =>
    Boolean(sessionId && state.sessionsById[sessionId]),
  );
}

export function isRemoteWorkspaceTarget(
  target: WorkspaceServiceTarget,
  resolvedRemoteSessionId?: string,
): boolean {
  return Boolean(target.workspaceIdentity || target.remoteTarget || resolvedRemoteSessionId);
}

export function resolveWorkspaceServices(
  target: WorkspaceServiceTarget,
  baseServices: IServiceAccessor,
  state: WorkspaceServiceResolverState,
): ResolvedWorkspaceServices | null {
  const remoteSessionId = resolveWorkspaceRemoteSessionId(target, state);
  const isRemoteWorkspace = isRemoteWorkspaceTarget(target, remoteSessionId);

  // During remote history restore the tab may briefly have only workspaceIdentity, with remoteSessionId backfilled later.
  // That state must not fall back to baseServices, or local sqlite would query the remote workspace and cache empty results;
  // a remote target must resolve to a remote session before any services are returned.
  if (isRemoteWorkspace) {
    const services = remoteSessionId ? state.sessionsById[remoteSessionId]?.services : undefined;
    return services
      ? {
          services,
          remoteSessionId,
          isRemoteWorkspace,
        }
      : null;
  }

  return {
    services: baseServices,
    isRemoteWorkspace,
  };
}

export function buildWorkspaceServiceLookup(
  workspaceTabs: WorkspaceServiceTarget[],
  baseServices: IServiceAccessor,
  state: WorkspaceServiceResolverState,
): Map<string, ResolvedWorkspaceServices> {
  const lookup = new Map<string, ResolvedWorkspaceServices>();

  for (const tab of workspaceTabs) {
    const resolved = resolveWorkspaceServices(tab, baseServices, state);
    if (!resolved) {
      continue;
    }

    lookup.set(buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity), resolved);
  }

  return lookup;
}
