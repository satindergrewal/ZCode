import type { PipSessionEvent } from "@zcode/zcode-cua/pip-session";
import {
  createPipSessionClient,
  type PipSessionClient,
  type PipSessionClientOptions,
} from "@zcode/zcode-cua/pip-session/node";
import { createServiceLogger, type ServiceLogger } from "../logger/serviceLogger.js";
import type { CuaPipSessionService } from "./cuaPipSession.js";

export interface CuaPipPresentationCredentials {
  socketPath: string;
}

type PipSessionClientResolution =
  | { client: PipSessionClient; skipReason?: never }
  | {
      client: null;
      skipReason:
        | "service-disabled"
        | "service-disposed"
        | "credentials-unavailable"
        | "transport-disabled";
    };

function eventLogContext(event: PipSessionEvent): Record<string, unknown> {
  if (event.kind === "focus-changed") {
    return {
      kind: event.kind,
      revision: event.revision,
      sessionId: event.sessionId,
      sourceWindowId: event.sourceWindowId,
    };
  }
  return {
    eventId: event.eventId,
    kind: event.kind,
    sequenceNumber: event.sequenceNumber,
    sessionId: event.sessionId,
    ...(event.kind === "session-closed" ? {} : { turnId: event.turnId }),
    ...(event.kind === "turn-ended" ? { outcome: event.outcome } : {}),
  };
}

export function createCuaPipSessionService(options: {
  enabled: boolean;
  resolveCredentials: () => Promise<CuaPipPresentationCredentials | undefined>;
  createClient?: (options: PipSessionClientOptions) => PipSessionClient;
  logger?: ServiceLogger;
}): CuaPipSessionService {
  const logger = options.logger ?? createServiceLogger("cua-pip-session");
  const clientFactory = options.createClient ?? createPipSessionClient;
  let current: {
    key: string;
    client: PipSessionClient;
  } | null = null;
  let disabledTransportKey: string | null = null;
  let tail: Promise<void> = Promise.resolve();
  let disposed = false;
  /**
   * The turn-started dropped by credentials-unavailable, re-sent once credentials exist.
   *
   * PiP is turn-scoped: no turn-started, no PiP window. And it ALWAYS precedes the Helper -
   * the Helper lazy-starts on the first CUA tool call while turn-started fires at turn start,
   * when resolveCredentials() has neither a managed host nor a stable socket to probe (that
   * path is probe-only, never launching), so it returns undefined. Log evidence: turn-started
   * (seq 3) -> credentials-unavailable; after the Helper came up, focus-changed
   * (rev 11/12/13) all applied:true; turn-ended (seq 3862) -> applied:false/turn-mismatch.
   * The channel works; only that opening event was lost.
   *
   * An earlier comment here already noted the silently dropped turn-started leaving PiP stuck
   * on the previous turn's completed state - but it only added a warn, no resend. A single-prompt
   * task has no second turn, so in practice PiP never appeared.
   *
   * Cache exactly one: a newer turn-started replaces the older (that turn is gone; resending it
   * would open a turn that should have closed). The coordinator dedupes on sequenceNumber, so
   * the resend is idempotent.
   */
  let pendingTurnStarted: { event: PipSessionEvent; turnId: string } | null = null;
  /**
   * Resend retry timer.
   *
   * Why waiting for whichever event happens next cannot trigger the resend:
   *   20:18:15.628  turn-started -> credentials-unavailable (Helper not up)
   *   20:18:23      Helper up -> first capture_app -> bindCapture -> pending-turn
   *                 (coordinator PIP_SESSION_CAPTURE_PENDING_TTL_MS = 2s, expiring ~20:18:25)
   *   20:18:30.420  next event finally arrives, resend applied:true - 5s too late
   * The staged capture is stale by the time the turn opens, captureAccepted never fires, and the
   * window still does not appear.
   *
   * So resend the moment credentials exist: stage the event AND start a bounded poll that stops
   * on first hit. 250ms interval, far below the coordinator's 2s TTL; the 30s cap covers Helper
   * cold start (including the first-run TCC dialog).
   */
  let replayTimer: ReturnType<typeof setTimeout> | null = null;
  const REPLAY_RETRY_MS = 250;
  const REPLAY_DEADLINE_MS = 30_000;
  let replayDeadline = 0;

  const cancelReplayRetry = () => {
    if (replayTimer !== null) {
      clearTimeout(replayTimer);
      replayTimer = null;
    }
  };

  const getClient = async (): Promise<PipSessionClientResolution> => {
    if (!options.enabled) return { client: null, skipReason: "service-disabled" };
    if (disposed) return { client: null, skipReason: "service-disposed" };
    const credentials = await options.resolveCredentials();
    if (!credentials) return { client: null, skipReason: "credentials-unavailable" };
    const key = credentials.socketPath;
    if (disabledTransportKey === key) {
      return { client: null, skipReason: "transport-disabled" };
    }
    if (current?.key === key) return { client: current.client };
    current?.client.close();
    const client = clientFactory({
      socketPath: credentials.socketPath,
      onDiagnostic: (diagnostic) => {
        const message = `[cua-pip-session] ${diagnostic.code}: ${diagnostic.message}`;
        if (diagnostic.code === "version_mismatch") logger.warn(undefined, message);
        else logger.debug(undefined, message);
      },
    });
    current = { key, client };
    try {
      await client.connect();
      return { client };
    } catch (error) {
      if (current?.client === client) current = null;
      client.close();
      if ((error as { code?: unknown }).code === "version_mismatch") {
        disabledTransportKey = key;
      }
      throw error;
    }
  };

  /**
   * Bounded poll: flush the staged turn-started as soon as credentials exist, not on the next
   * event. Serialized through the same tail so a race with publish cannot order the resend
   * behind the current event.
   */
  const scheduleReplayRetry = (): void => {
    cancelReplayRetry();
    if (disposed || pendingTurnStarted === null) return;
    if (Date.now() >= replayDeadline) {
      logger.warn(undefined, "[cua-pip-session] deferred turn-started expired before transport", {
        ...eventLogContext(pendingTurnStarted.event),
      });
      pendingTurnStarted = null;
      return;
    }
    replayTimer = setTimeout(() => {
      replayTimer = null;
      if (disposed || pendingTurnStarted === null) return;
      const operation = tail.then(async () => {
        if (disposed || pendingTurnStarted === null) return;
        let resolution;
        try {
          resolution = await getClient();
        } catch {
          // Connect failed (Helper just starting, not yet listening): keep waiting for the next round.
          scheduleReplayRetry();
          return;
        }
        if (!resolution.client) {
          scheduleReplayRetry();
          return;
        }
        const replay = pendingTurnStarted;
        pendingTurnStarted = null;
        try {
          const result = await resolution.client.send(replay.event);
          logger.info(undefined, "[cua-pip-session] replayed deferred turn-started", {
            ...eventLogContext(replay.event),
            applied: result.applied,
            reason: result.reason,
          });
        } catch (error) {
          logger.warn(undefined, "[cua-pip-session] replay of deferred turn-started failed", {
            ...eventLogContext(replay.event),
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
      });
      tail = operation;
    }, REPLAY_RETRY_MS);
    // The poll timer must not keep the process alive; it merely waits for a Helper that may never come.
    replayTimer.unref?.();
  };

  const publish = (event: PipSessionEvent): Promise<void> => {
    if (disposed) return Promise.resolve();
    const operation = tail.then(async () => {
      try {
        const resolution = await getClient();
        if (!resolution.client) {
          if (
            resolution.skipReason === "credentials-unavailable" ||
            resolution.skipReason === "transport-disabled"
          ) {
            // Bookkeeping (root cause under pendingTurnStarted): a lost turn-started is re-sent when
            // credentials exist; if the same turn's turn-ended was also lost, invalidate the cache
            // too - that turn finished with no transport, and a resend would only open a turn that
            // should have closed.
            if (event.kind === "turn-started") {
              pendingTurnStarted = { event, turnId: event.turnId };
              replayDeadline = Date.now() + REPLAY_DEADLINE_MS;
              scheduleReplayRetry();
            } else if (
              (event.kind === "turn-ended" || event.kind === "session-closed") &&
              pendingTurnStarted !== null &&
              ("turnId" in event
                ? pendingTurnStarted.turnId === event.turnId
                : pendingTurnStarted.event.sessionId === event.sessionId)
            ) {
              pendingTurnStarted = null;
              cancelReplayRetry();
            }
            // Diagnosis: with the Helper resident but the credential handoff failing, turn-started
            // used to vanish silently and PiP stuck on the previous turn's completed state. Only a
            // constant number of lifecycle events per turn, so the production warn cannot flood.
            logger.warn(undefined, "[cua-pip-session] event delivery skipped", {
              ...eventLogContext(event),
              skipReason: resolution.skipReason,
            });
          } else {
            // service-disabled/service-disposed used to return fully silently, making no-events-sent
            // indistinguishable from sent-but-rejected in logs; debugging meant inferring which of
            // four silent early-returns on the delivery path fired. Constant lifecycle events per
            // turn; the warn cannot flood.
            logger.warn(undefined, "[cua-pip-session] event delivery dropped", {
              ...eventLogContext(event),
              skipReason: resolution.skipReason,
            });
          }
          return;
        }
        // Credentials are in: replay the opening event first so the coordinator has an open turn to
        // receive the rest. Skip the replay when this event IS the turn-started (it already
        // replaced the cache).
        cancelReplayRetry();
        const replay = event.kind === "turn-started" ? null : pendingTurnStarted;
        pendingTurnStarted = null;
        if (replay !== null) {
          try {
            const replayed = await resolution.client.send(replay.event);
            logger.info(undefined, "[cua-pip-session] replayed deferred turn-started", {
              ...eventLogContext(replay.event),
              applied: replayed.applied,
              reason: replayed.reason,
            });
          } catch (error) {
            // A failed replay must not sink the current event; it still goes out, worst case falling back to turn-mismatch.
            logger.warn(undefined, "[cua-pip-session] replay of deferred turn-started failed", {
              ...eventLogContext(replay.event),
              errorMessage: error instanceof Error ? error.message : String(error),
            });
          }
        }
        const result = await resolution.client.send(event);
        // Diagnosis: PiP re-grouping spans Main, Host and broker processes. If success and
        // idempotent-rejection ACKs are debug-only, production cannot tell an unsent turn-started
        // from stale-sequence/turn-mismatch. Low-frequency lifecycle log with no screenshots,
        // tokens or prompts; safe to keep in production.
        logger.info(undefined, "[cua-pip-session] event delivery acknowledged", {
          ...eventLogContext(event),
          applied: result.applied,
          reason: result.reason,
        });
      } catch (error) {
        logger.warn(undefined, "[cua-pip-session] event delivery failed", {
          ...eventLogContext(event),
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    });
    tail = operation;
    return operation;
  };

  return {
    publishFocus: publish,
    publishLifecycle: publish,
    dispose() {
      disposed = true;
      cancelReplayRetry();
      pendingTurnStarted = null;
      current?.client.close();
      current = null;
    },
  };
}
