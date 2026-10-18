import { create } from "zustand";
import type { RemoteTarget } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { remoteAgentServiceGeneration } from "@/lib/remoteAgentServiceGeneration.js";
import { createRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";

export interface RemoteWorkspaceSession {
  sessionId: string;
  target?: RemoteTarget;
  services: IServiceAccessor;
  dispose?: (reason?: Error) => void;
}

interface RemoteWorkspaceSessionState {
  baseServices: IServiceAccessor | null;
  sessionsById: Record<string, RemoteWorkspaceSession>;
  sessionIdByWorkspacePath: Record<string, string>;
  // Indexing by workspacePath alone let same-path different-remote entries overwrite each other.
  // The workspaceIdentity -> session mapping keeps the remote-session binding unique per host+path.
  sessionIdByWorkspaceIdentity: Record<string, string>;
  registerBaseServices: (services: IServiceAccessor) => void;
  registerSession: (session: RemoteWorkspaceSession) => void;
  unregisterSession: (sessionId: string) => void;
  bindWorkspacePath: (workspacePath: string, sessionId: string) => void;
  unbindWorkspacePath: (workspacePath: string) => void;
  bindWorkspaceIdentity: (workspaceIdentity: string, sessionId: string) => void;
  unbindWorkspaceIdentity: (workspaceIdentity: string) => void;
}

export const useRemoteWorkspaceSessionStore = create<RemoteWorkspaceSessionState>()((set) => ({
  baseServices: null,
  sessionsById: {},
  sessionIdByWorkspacePath: {},
  sessionIdByWorkspaceIdentity: {},
  registerBaseServices: (services) =>
    set({
      baseServices: services,
    }),
  registerSession: (session) =>
    set((state) => ({
      sessionsById: {
        ...state.sessionsById,
        [session.sessionId]: session,
      },
    })),
  unregisterSession: (sessionId) =>
    set((state) => {
      const nextSessionsById = { ...state.sessionsById };
      delete nextSessionsById[sessionId];

      const nextSessionIdByWorkspacePath = Object.fromEntries(
        Object.entries(state.sessionIdByWorkspacePath).filter(
          ([, currentSessionId]) => currentSessionId !== sessionId,
        ),
      );

      const nextSessionIdByWorkspaceIdentity = Object.fromEntries(
        Object.entries(state.sessionIdByWorkspaceIdentity).filter(
          ([, currentSessionId]) => currentSessionId !== sessionId,
        ),
      );

      return {
        sessionsById: nextSessionsById,
        sessionIdByWorkspacePath: nextSessionIdByWorkspacePath,
        sessionIdByWorkspaceIdentity: nextSessionIdByWorkspaceIdentity,
      };
    }),
  bindWorkspacePath: (workspacePath, sessionId) =>
    set((state) => ({
      sessionIdByWorkspacePath: {
        ...state.sessionIdByWorkspacePath,
        [workspacePath]: sessionId,
      },
    })),
  unbindWorkspacePath: (workspacePath) =>
    set((state) => {
      if (!(workspacePath in state.sessionIdByWorkspacePath)) {
        return state;
      }

      const nextSessionIdByWorkspacePath = {
        ...state.sessionIdByWorkspacePath,
      };
      delete nextSessionIdByWorkspacePath[workspacePath];

      return {
        ...state,
        sessionIdByWorkspacePath: nextSessionIdByWorkspacePath,
      };
    }),
  bindWorkspaceIdentity: (workspaceIdentity, sessionId) =>
    set((state) => ({
      sessionIdByWorkspaceIdentity: {
        ...state.sessionIdByWorkspaceIdentity,
        [workspaceIdentity]: sessionId,
      },
    })),
  unbindWorkspaceIdentity: (workspaceIdentity) =>
    set((state) => {
      if (!(workspaceIdentity in state.sessionIdByWorkspaceIdentity)) {
        return state;
      }

      const nextSessionIdByWorkspaceIdentity = {
        ...state.sessionIdByWorkspaceIdentity,
      };
      delete nextSessionIdByWorkspaceIdentity[workspaceIdentity];

      return {
        ...state,
        sessionIdByWorkspaceIdentity: nextSessionIdByWorkspaceIdentity,
      };
    }),
}));

export function registerRemoteWorkspaceSession(session: RemoteWorkspaceSession): void {
  // Proxies of one remoteSessionId can re-generation repeatedly, while effect commit order across React consumers is unreliable.
  // Session registration is the authoritative generation order: preallocate a monotonic generation in the shared module
  // so a late intermediate proxy cannot switch the transport back to an older generation.
  // Web/test fallback accessors may lack an agent transport for now; once subscribable, the registry still
  // assigns the generation at first observation - never break that compat shape for pre-registration.
  if (session.services.zcodeAgentService) {
    remoteAgentServiceGeneration(session.services.zcodeAgentService);
  }
  const previousSession = useRemoteWorkspaceSessionStore.getState().sessionsById[session.sessionId];
  if (previousSession && previousSession !== session) {
    // When an attachment re-generates, the old MessagePort may still hold in-flight RPCs.
    // Terminate the old transport first so provider-sync in-flight promises never dangle across generations.
    previousSession.dispose?.(createRemoteWorkspaceDisconnectedError());
  }
  useRemoteWorkspaceSessionStore.getState().registerSession(session);
}

export function registerBaseWorkspaceServices(services: IServiceAccessor): void {
  useRemoteWorkspaceSessionStore.getState().registerBaseServices(services);
}

export function unregisterRemoteWorkspaceSession(sessionId: string): void {
  const session = useRemoteWorkspaceSessionStore.getState().sessionsById[sessionId];
  useRemoteWorkspaceSessionStore.getState().unregisterSession(sessionId);
  // Sync may happen before the workspace bind, so index cleanup alone cannot flush in-flight work.
  // The injected disposer terminates the attachment directly, failing pending RPCs closed on the ChannelClient.
  session?.dispose?.(createRemoteWorkspaceDisconnectedError());
}

export function bindRemoteWorkspacePath(workspacePath: string, sessionId: string): void {
  useRemoteWorkspaceSessionStore.getState().bindWorkspacePath(workspacePath, sessionId);
}

export function unbindRemoteWorkspacePath(workspacePath: string): void {
  useRemoteWorkspaceSessionStore.getState().unbindWorkspacePath(workspacePath);
}

export function bindRemoteWorkspaceIdentity(workspaceIdentity: string, sessionId: string): void {
  useRemoteWorkspaceSessionStore.getState().bindWorkspaceIdentity(workspaceIdentity, sessionId);
}

export function unbindRemoteWorkspaceIdentity(workspaceIdentity: string): void {
  useRemoteWorkspaceSessionStore.getState().unbindWorkspaceIdentity(workspaceIdentity);
}

export function getRemoteWorkspaceSession(sessionId: string): RemoteWorkspaceSession | null {
  return useRemoteWorkspaceSessionStore.getState().sessionsById[sessionId] ?? null;
}

/** Remote session identity of the currently registered proxy; old-generation proxies do not match. Diagnostics only. */
export function findRemoteWorkspaceSessionIdForAgentService(agentService: object): string | null {
  for (const session of Object.values(useRemoteWorkspaceSessionStore.getState().sessionsById)) {
    if (session.services.zcodeAgentService === agentService) {
      return session.sessionId;
    }
  }
  return null;
}

export function getRemoteWorkspaceServicesForPath(workspacePath: string): IServiceAccessor | null {
  const state = useRemoteWorkspaceSessionStore.getState();
  const sessionId = state.sessionIdByWorkspacePath[workspacePath];
  if (!sessionId) {
    return null;
  }

  return state.sessionsById[sessionId]?.services ?? null;
}

export function getRemoteWorkspaceServicesForIdentity(
  workspaceIdentity: string,
): IServiceAccessor | null {
  const state = useRemoteWorkspaceSessionStore.getState();
  const sessionId = state.sessionIdByWorkspaceIdentity[workspaceIdentity];
  if (!sessionId) {
    return null;
  }

  return state.sessionsById[sessionId]?.services ?? null;
}

export function getRegisteredBaseWorkspaceServices(): IServiceAccessor | null {
  return useRemoteWorkspaceSessionStore.getState().baseServices;
}

export function resolveRegisteredWorkspaceServices(params: {
  workspacePath?: string;
  workspaceIdentity?: string;
}): IServiceAccessor | null {
  if (params.workspaceIdentity?.trim()) {
    return (
      getRemoteWorkspaceServicesForIdentity(params.workspaceIdentity) ??
      getRegisteredBaseWorkspaceServices()
    );
  }

  if (params.workspacePath?.trim()) {
    return (
      getRemoteWorkspaceServicesForPath(params.workspacePath) ??
      getRegisteredBaseWorkspaceServices()
    );
  }

  return getRegisteredBaseWorkspaceServices();
}
