// React binding for sessions-index: one read-only SessionsIndexStore + transport per consumer.
// Sidebar/task lists read summaries here, replacing zustand task state (08-phasing M5 step 2);
// multiple list consumers on one workspace share via sessionsIndexRegistry (refcounted stores).
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import { useServices } from "@/hooks/useServices.js";
import { createAgentSessionsIndexTransport } from "@/v4/agentSessionsIndexTransport.js";
import { SessionsIndexStore, type SessionsIndexStoreStatus } from "@/v4/sessionsIndexStore.js";

export interface UseSessionsIndexResult {
  sessions: SessionSummary[];
  status: SessionsIndexStoreStatus;
}

/**
 * Subscribes to a workspace's sessions-index; returns summaries (lastActivityAt desc by default).
 * Lifecycle: rebuild+reconnect on workspace change; close (unsubscribe+unlisten) on unmount.
 */
export function useSessionsIndex(
  workspacePath: string,
  workspaceIdentity?: string,
): UseSessionsIndexResult {
  const { zcodeAgentService } = useServices();

  const store = useMemo(
    () => new SessionsIndexStore(),
    // One store per workspace (dep change -> cold-start a fresh store).
    [workspacePath, workspaceIdentity, zcodeAgentService],
  );

  useEffect(() => {
    const transport = createAgentSessionsIndexTransport(zcodeAgentService, {
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    });
    void store.connect(transport, { forceSnapshot: true });
    return () => store.close();
  }, [store, workspacePath, workspaceIdentity, zcodeAgentService]);

  // useSyncExternalStore: subscribe/getState are class-field arrows, referentially stable.
  const state = useSyncExternalStore(store.subscribe, store.getState);
  // Any state change may move the list; getSessions caches stable references internally.
  const sessions = useMemo(() => store.getSessions(), [store, state]);

  return { sessions, status: store.getStatus() };
}
