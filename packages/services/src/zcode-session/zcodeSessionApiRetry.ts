import {
  normalizeZCodeApiRetryStatus,
  isZCodeModelRetryRecoveryProgressPayload,
  resolveWorkspaceKey,
  type ZCodeSessionApiRetryStatus,
  type ZCodeSessionStateSnapshot,
  zcodeApiRetryFromModelNetworkStatusPayload,
  zcodeApiRetryFromStreamRecoveryPayload,
} from "@zcode/shared";
import type { ZCodeSessionServiceEvent, ZCodeTaskTarget } from "#src/zcode-session/zcodeSession.js";

export function createZCodeSessionApiRetryRuntimeTracker(): {
  trackApiRetryFromSessionEvent: (
    params: ZCodeTaskTarget,
    event: ZCodeSessionServiceEvent,
  ) => ZCodeSessionServiceEvent;
  withApiRetryRuntime: (snapshot: ZCodeSessionStateSnapshot) => ZCodeSessionStateSnapshot;
} {
  const apiRetryBySessionKey = new Map<string, ZCodeSessionApiRetryStatus | null>();

  function trackApiRetryFromSessionEvent(
    params: ZCodeTaskTarget,
    event: ZCodeSessionServiceEvent,
  ): ZCodeSessionServiceEvent {
    if (
      event.type === "session.event" &&
      (event.event.type === "session.updated" || event.event.type === "streamRecovery.updated")
    ) {
      // The desktop-continuous snapshot runtime must track core recovery progress, or switching
      // back to a recovering session shows an empty retry state.
      const apiRetry = apiRetryFromSessionPayload(asRecord(event.event.payload));
      const key = sessionKey({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        sessionId: event.event.sessionId,
      });
      if (apiRetry !== undefined) {
        apiRetryBySessionKey.set(key, apiRetry);
      } else if (
        apiRetryBySessionKey.get(key) != null &&
        isZCodeModelRetryRecoveryProgressPayload(asRecord(event.event.payload))
      ) {
        // Snapshot runtime and live UI share one recovery-success boundary: keep the state during
        // retries and clear on first model progress, avoiding flicker or stale states on switch-back.
        apiRetryBySessionKey.set(key, null);
      }
      return event;
    }
    if (event.type === "snapshot") {
      return {
        ...event,
        snapshot: withApiRetryRuntime(event.snapshot),
      };
    }
    return event;
  }

  function withApiRetryRuntime(snapshot: ZCodeSessionStateSnapshot): ZCodeSessionStateSnapshot {
    const sessionId = snapshot.session?.sessionId;
    const workspacePath = snapshot.session?.workspace?.workspacePath;
    if (!sessionId || !workspacePath) {
      return snapshot;
    }
    const key = sessionKey({
      workspacePath,
      workspaceIdentity: snapshot.session.workspace.workspaceIdentity,
      sessionId,
    });
    if (snapshot.runtime?.apiRetry !== undefined) {
      apiRetryBySessionKey.set(key, snapshot.runtime.apiRetry);
      return snapshot;
    }
    if (snapshot.session.status === "completed" || snapshot.session.status === "error") {
      apiRetryBySessionKey.set(key, null);
      return {
        ...snapshot,
        runtime: {
          ...snapshot.runtime,
          apiRetry: null,
        },
      };
    }
    if (!apiRetryBySessionKey.has(key)) {
      return snapshot;
    }
    return {
      ...snapshot,
      runtime: {
        ...snapshot.runtime,
        // The desktop-continuous main path reads protocol snapshots without the task adapter;
        // mirror the network-retry transient into the snapshot so the current turn keeps its hint.
        apiRetry: apiRetryBySessionKey.get(key) ?? null,
      },
    };
  }

  function sessionKey(params: ZCodeTaskTarget): string {
    return `${resolveWorkspaceKey(params)}\u0000${params.sessionId}`;
  }

  return {
    trackApiRetryFromSessionEvent,
    withApiRetryRuntime,
  };
}

function apiRetryFromSessionPayload(
  payload: Record<string, unknown>,
): ZCodeSessionApiRetryStatus | null | undefined {
  if ("apiRetry" in payload) {
    return normalizeZCodeApiRetryStatus(payload.apiRetry);
  }
  const runtimeRetry = normalizeZCodeApiRetryStatus(asRecord(payload.runtime).apiRetry);
  if (runtimeRetry !== undefined) {
    return runtimeRetry;
  }
  const metaRetry = normalizeZCodeApiRetryStatus(asRecord(asRecord(payload._meta).zcode).apiRetry);
  if (metaRetry !== undefined) {
    return metaRetry;
  }
  return (
    zcodeApiRetryFromStreamRecoveryPayload(payload) ??
    zcodeApiRetryFromModelNetworkStatusPayload(payload)
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
