import { useCallback, useEffect, useReducer, useRef } from "react";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

/**
 * Rebuild-window bound. Measured agent start->ready ~550-650ms plus createSession hundreds more; 5s leaves ample room.
 * Timeout only lifts the gate, never cancels: a late binding still updates effectiveSessionId and wakes attachment resend.
 */
export const DRAFT_RUNTIME_REBUILD_TIMEOUT_MS = 5000;

export interface DraftRuntimeRebuildGateState {
  rebuilding: boolean;
  /** Prewarm session id at generation-change time; any different non-empty id means rebuilt. */
  pendingFrom: string | null;
  /** Monotonic; exists only so the timer effect restarts when another change lands mid-rebuild. */
  epoch: number;
}

export type DraftRuntimeRebuildGateEvent =
  | { type: "runtimeRestart"; prewarmSessionId: string | null }
  | { type: "prewarmSessionChanged"; prewarmSessionId: string | null }
  | { type: "rebuildTimeout" };

export const DRAFT_RUNTIME_REBUILD_GATE_IDLE: DraftRuntimeRebuildGateState = {
  epoch: 0,
  pendingFrom: null,
  rebuilding: false,
};

export function reduceDraftRuntimeRebuildGate(
  state: DraftRuntimeRebuildGateState,
  event: DraftRuntimeRebuildGateEvent,
): DraftRuntimeRebuildGateState {
  switch (event.type) {
    case "runtimeRestart":
      return {
        epoch: state.epoch + 1,
        pendingFrom: event.prewarmSessionId,
        rebuilding: true,
      };
    case "prewarmSessionChanged":
      if (!state.rebuilding) return state;
      // Between retire and rebuild-done the binding is null; never lift the gate on that alone.
      if (event.prewarmSessionId === null) return state;
      if (event.prewarmSessionId === state.pendingFrom) return state;
      return { epoch: state.epoch, pendingFrom: null, rebuilding: false };
    case "rebuildTimeout":
      if (!state.rebuilding) return state;
      return { ...state, rebuilding: false };
  }
}

export interface DraftRuntimeRebuildGate {
  /** The prewarm session is rebuilding; while true, sending is forbidden or attachments hang off a vanished session. */
  rebuilding: boolean;
}

/**
 * CUA Helper readiness, liveness recovery, etc. recycle the agent runtime (workspace-dispose), wiping draft-state
 * prewarm sessions that never persisted. This hook bumps draftRuntimeInvalidationVersion on generation changes
 * to trigger the rebuild, reporting rebuilding=true for the send gate inside the window.
 *
 * Prefer onRuntimeLifecycle unavailable as the generation signal: it fires at dispose. onRuntimeRestart
 * fires only on agent spawn, and agents are lazy -- no request, no spawn -- so the notice
 * never arrives, prewarm never rebuilds, attachments stick in waitingSession until a manual send kicks them
 * (production: helper-ready-to-rebuild 2.3s/6.0s/26.3s, each exactly a user click).
 *
 * Not enabled for real sessions (sessionId !== null): the CLI cold-session-resume path owns that.
 */
export function useDraftRuntimeRebuildGate(params: {
  /** Enabled only in draft state (sessionId === null). */
  enabled: boolean;
  workspacePath: string;
  workspaceIdentity?: string;
  /** Current prewarm session id; a new non-empty value means rebuilt. */
  prewarmSessionId: string | null;
  onRuntimeRestart?: (listener: () => void) => () => void;
  /** When the transport exposes runtime liveness, prefer this over onRuntimeRestart. */
  onRuntimeLifecycle?: (listener: (state: "available" | "unavailable") => void) => () => void;
  timeoutMs?: number;
}): DraftRuntimeRebuildGate {
  const {
    enabled,
    onRuntimeLifecycle,
    onRuntimeRestart,
    prewarmSessionId,
    timeoutMs = DRAFT_RUNTIME_REBUILD_TIMEOUT_MS,
    workspaceIdentity,
    workspacePath,
  } = params;
  const [state, dispatch] = useReducer(
    reduceDraftRuntimeRebuildGate,
    DRAFT_RUNTIME_REBUILD_GATE_IDLE,
  );

  // enabled/prewarmSessionId live in refs: keying handleRuntimeRestart on them would
  // unsubscribe/resubscribe per id change, and the transport disposes upstream when listeners
  // empty - generation events in that window would be lost.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const prewarmSessionIdRef = useRef(prewarmSessionId);
  prewarmSessionIdRef.current = prewarmSessionId;

  const handleRuntimeRestart = useCallback(() => {
    if (!enabledRef.current) return;
    dispatch({ prewarmSessionId: prewarmSessionIdRef.current, type: "runtimeRestart" });
    useZCodeSessionStore.getState().invalidateDraftRuntime(workspacePath, workspaceIdentity);
  }, [workspaceIdentity, workspacePath]);

  useEffect(() => {
    // One channel, not both: dual subscription handles one generation change twice, wasting a prewarm build and re-uploading attachments.
    if (onRuntimeLifecycle) {
      return onRuntimeLifecycle((state) => {
        // available needs no handling: the rebuild started at unavailable; the gate lifts via prewarmSessionChanged.
        if (state === "unavailable") handleRuntimeRestart();
      });
    }
    if (!onRuntimeRestart) return;
    return onRuntimeRestart(handleRuntimeRestart);
  }, [handleRuntimeRestart, onRuntimeLifecycle, onRuntimeRestart]);

  useEffect(() => {
    dispatch({ prewarmSessionId, type: "prewarmSessionChanged" });
  }, [prewarmSessionId]);

  // Key the timer on epoch, not rebuilding: rebuilding stays true across a mid-rebuild change,
  // and only an epoch bump restarts the countdown.
  useEffect(() => {
    if (!state.rebuilding) return;
    const timer = setTimeout(() => dispatch({ type: "rebuildTimeout" }), timeoutMs);
    return () => clearTimeout(timer);
  }, [state.epoch, state.rebuilding, timeoutMs]);

  return { rebuilding: state.rebuilding };
}
