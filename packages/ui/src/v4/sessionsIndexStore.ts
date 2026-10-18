/* eslint-disable max-lines -- index projection, applied-base, and recovery flights must be adjudicated by one atomic store. */
// Read-only renderer store for the sessions-index topic:
// snapshot frames replace wholesale; delta frames apply only when contiguous (frame.fromSeq === watermark);
// never guess across gaps nor cache-compensate -- resubscribe and let the server rule resume vs full (same policy as ConversationProjectionStore).
import {
  isDeterministicContentFault,
  PROTOCOL_V4_LIMITS,
  SUBSCRIPTION_CONTENT_REJECTED,
  type SessionSummary,
  type SessionsIndexTopicFrame,
  type TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";
import { isZCodeFileLockTimeoutError } from "@zcode/shared";
import { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from "@zcode/services";
import { logger } from "@/logger.js";
import type { SessionsIndexTransport } from "@/v4/agentSessionsIndexTransport.js";

export interface SessionsIndexState {
  /** workspaceId -> known; null = no snapshot yet. */
  workspaceId: string | null;
  logEpoch: string | null;
  /** Frame-range watermark (= the latest frame toSeq). */
  seq: number;
  /** Session summaries keyed by sessionId (conflated). */
  sessions: Map<string, SessionSummary>;
}

export const EMPTY_SESSIONS_INDEX_STATE: SessionsIndexState = {
  workspaceId: null,
  logEpoch: null,
  seq: 0,
  sessions: new Map(),
};

export type SessionsIndexStoreStatus = "idle" | "dormant" | "connecting" | "live" | "error";

const RUNTIME_RESTART_RECONNECT_BASE_DELAY_MS = 100;
const RUNTIME_RESTART_RECONNECT_MAX_DELAY_MS = 5_000;
const RUNTIME_RESTART_BURST_RESET_MS = 30_000;
const TRANSIENT_SUBSCRIBE_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;
const ERROR_RECOVERY_RETRY_DELAYS_MS = [5_000, 15_000, 60_000] as const;

function isTransientSubscribeError(error: unknown): boolean {
  if (isZCodeFileLockTimeoutError(error)) {
    return true;
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  if (["EBUSY", "EMFILE", "ENFILE"].includes(code)) {
    return true;
  }
  if (code === "EEXIST" && message.includes("config.json.lock")) {
    return true;
  }
  return /\b(?:EBUSY|EMFILE|ENFILE)\b/.test(message) || message.includes("config.json.lock");
}

function isRuntimeUnavailableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE
  );
}

async function unsubscribeIgnoringFailure(
  transport: SessionsIndexTransport,
  subscriptionId: string,
): Promise<void> {
  try {
    await transport.unsubscribe(subscriptionId);
  } catch (error) {
    // After a service-proxy generation change, a stale store cleanup can still hit a disconnected RPC.
    // A failing cleanup must not become an unhandled rejection nor touch the newer registry entry.
    logger.warn(
      `[v4-sessions-index] unsubscribe ${subscriptionId} failed (ignored): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export interface ApplySessionsIndexResult {
  state: SessionsIndexState;
  /** true = frame-range gap (fromSeq does not join the watermark); the caller must resubscribe. */
  gap: boolean;
}

/** Pure apply: snapshots replace wholesale; deltas upsert/remove one by one only when contiguous. */
export function applySessionsIndexFrame(
  current: SessionsIndexState,
  frame: SessionsIndexTopicFrame,
): ApplySessionsIndexResult {
  if (frame.payload.kind === "snapshot") {
    const snapshot = frame.payload.snapshot;
    const sessions = new Map<string, SessionSummary>();
    for (const session of snapshot.sessions) {
      sessions.set(session.sessionId, session);
    }
    return {
      gap: false,
      state: {
        workspaceId: snapshot.workspaceId,
        logEpoch: snapshot.logEpoch,
        seq: frame.toSeq,
        sessions,
      },
    };
  }
  if (frame.toSeq <= current.seq) {
    return { state: current, gap: false };
  }
  // deltas: the range must be contiguous (fromSeq === current watermark), otherwise a gap.
  if (frame.fromSeq !== current.seq) {
    return { state: current, gap: true };
  }
  const sessions = new Map(current.sessions);
  for (const delta of frame.payload.deltas) {
    if (delta.op === "session.upserted") {
      sessions.set(delta.session.sessionId, delta.session);
    } else {
      sessions.delete(delta.sessionId);
    }
  }
  return {
    gap: false,
    state: { ...current, seq: frame.toSeq, sessions },
  };
}

/**
 * useSyncExternalStore-compatible read-only store: subscribe + getState return stable references.
 * The state and pure applyFrame unit-test standalone; the transport binding
 * (connect/handleFrame/close) owns subscription lifecycle and gap resubscription.
 */
export class SessionsIndexStore {
  private state: SessionsIndexState = EMPTY_SESSIONS_INDEX_STATE;
  private readonly listeners = new Set<() => void>();
  // Cached ordered list (getSessions returns a stable reference so no per-call array re-renders).
  private cachedList: SessionSummary[] | null = null;
  // Transport binding (optional; pure applyFrame tests need none).
  private transport: SessionsIndexTransport | null = null;
  private frameUnsub: (() => void) | null = null;
  private faultUnsub: (() => void) | null = null;
  private restartUnsub: (() => void) | null = null;
  private lifecycleUnsub: (() => void) | null = null;
  private subscriptionId: string | null = null;
  private awaitingInitial: { subscriptionId: string; mode: "snapshot" | "resume" } | null = null;
  private subscriptionHasAppliedBase = false;
  private recovery: {
    subscriptionId: string;
    requestInFlight: boolean;
    ackReceived: boolean;
    validFrameSeen: boolean;
    upgradePending: boolean;
    ackMode: "snapshot" | "resume" | null;
    forceSnapshot: boolean;
    postRecoveryGapPending: boolean;
    frameDeadline: ReturnType<typeof setTimeout> | null;
    /** This flight stems from a deterministic content fault: terminal state contentRejected, no endless backoff resubscribe. */
    contentFault: boolean;
  } | null = null;
  private status: SessionsIndexStoreStatus = "idle";
  private generation = 0;
  private closed = false;
  private runtimeRestartReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeRestartBurstCount = 0;
  private lastRuntimeRestartAt = 0;
  private subscribeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private errorRecoveryRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private errorRecoveryRetryAttempt = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): SessionsIndexState => this.state;

  getStatus(): SessionsIndexStoreStatus {
    return this.status;
  }

  /**
   * Bind the transport and subscribe: register the frame listener + subscribe (watermark invariant: carry base only when a consistent state is held).
   * Gap frames -> drop base and resubscribe (via handleFrame). After close, connect again (React
   * unmount/remount, StrictMode double-invoke -- revives through the same path).
   */
  async connect(
    transport: SessionsIndexTransport,
    options: {
      forceSnapshot?: boolean;
      initialOverflowRetry?: boolean;
      subscribeRetryAttempt?: number;
      errorRecoveryRetryAttempt?: number;
    } = {},
  ): Promise<void> {
    if (this.runtimeRestartReconnectTimer) {
      clearTimeout(this.runtimeRestartReconnectTimer);
      this.runtimeRestartReconnectTimer = null;
    }
    this.clearSubscribeRetry();
    if (options.errorRecoveryRetryAttempt === undefined) {
      this.clearErrorRecoveryRetry();
      this.errorRecoveryRetryAttempt = 0;
    }
    this.closed = false;
    this.transport = transport;
    if (!this.frameUnsub) {
      this.frameUnsub = transport.onFrame((frame, context) => this.handleFrame(frame, context));
      this.faultUnsub = transport.onAssemblyFault((fault) => {
        if (fault.subscriptionId === this.subscriptionId) {
          this.handleAssemblyFault(fault.subscriptionId, fault.deliveryKind, fault.reasonCode);
        }
      });
      if (transport.onRuntimeLifecycle) {
        this.lifecycleUnsub = transport.onRuntimeLifecycle((state) => {
          if (state === "available") this.handleRuntimeAvailable();
          else this.handleRuntimeUnavailable();
        });
      } else {
        this.restartUnsub = transport.onRuntimeRestart(() => this.handleRuntimeRestart());
      }
    }
    const generation = ++this.generation;
    this.discardRecovery();
    this.status = "connecting";
    this.emit();
    const base =
      options.forceSnapshot || this.state.logEpoch === null
        ? undefined
        : { logEpoch: this.state.logEpoch, seq: this.state.seq };
    try {
      const result = await transport.subscribe(base ? { base } : {});
      if (generation !== this.generation || this.closed) {
        void unsubscribeIgnoringFailure(transport, result.ack.subscriptionId);
        return;
      }
      // Same root as conversationProjectionStore.connect (production notOwned stalls):
      // during the subscribe-ACK await an old subscription can still create a same-sub recovery, while the host scope
      // silently evicts the old ownership at remember(). Drop the old recovery once the generation lands, so its
      // late failure cannot flag the live new subscription as error.
      this.discardRecovery();
      this.subscriptionId = result.ack.subscriptionId;
      this.status = "live";
      this.clearErrorRecoveryRetry();
      this.errorRecoveryRetryAttempt = 0;
      this.subscriptionHasAppliedBase = Boolean(
        base && result.ack.mode === "resume" && result.ack.logEpoch === base.logEpoch,
      );
      this.awaitingInitial = {
        subscriptionId: result.ack.subscriptionId,
        mode: result.ack.mode,
      };
      // The initial arrives only via notification; bind the generation first, then activate to release pre-ACK early frames.
      transport.activate(result.ack.subscriptionId);
      this.emit();
    } catch (error) {
      if (generation !== this.generation || this.closed) return;
      this.awaitingInitial = null;
      this.subscriptionHasAppliedBase = false;
      if (isRuntimeUnavailableError(error)) {
        // Passive list subscribes on restored workspaces used to treat a missing runtime as a plain failure and
        // backoff-retry, mass-starting CLIs via getClient. Wait dormant for lifecycle; no timer.
        this.handleRuntimeUnavailable();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("fault.subscription.initialFrameStagingOverflow") &&
        !options.initialOverflowRetry
      ) {
        await this.connect(transport, {
          forceSnapshot: true,
          initialOverflowRetry: true,
          ...(options.errorRecoveryRetryAttempt !== undefined
            ? { errorRecoveryRetryAttempt: options.errorRecoveryRetryAttempt }
            : {}),
        });
        return;
      }
      const retryAttempt = options.subscribeRetryAttempt ?? 0;
      const retryDelay = TRANSIENT_SUBSCRIBE_RETRY_DELAYS_MS[retryAttempt];
      if (isTransientSubscribeError(error) && retryDelay !== undefined) {
        // On host cold start the provider registry's config lock can conflict briefly. Freezing the first
        // subscribe failure as error makes the aggregation publish an empty list -- no conversations yet.
        // Keep hydrating on transient lock errors with bounded-backoff resubscribe; keep any snapshot already held.
        this.status = "connecting";
        logger.warn(
          `[v4-sessions-index] transient subscribe failure; retrying in ${retryDelay}ms: ${message}`,
        );
        this.subscribeRetryTimer = setTimeout(() => {
          this.subscribeRetryTimer = null;
          if (this.closed || generation !== this.generation) return;
          void this.connect(transport, {
            ...(options.forceSnapshot ? { forceSnapshot: true } : {}),
            subscribeRetryAttempt: retryAttempt + 1,
            ...(options.errorRecoveryRetryAttempt !== undefined
              ? { errorRecoveryRetryAttempt: options.errorRecoveryRetryAttempt }
              : {}),
          });
        }, retryDelay);
        this.emit();
        return;
      }
      this.failAndScheduleRecovery(`subscribe:${message}`);
    }
  }

  /**
   // Swaps the transport in place on a remote RPC proxy generation change.
   *
      * Detach the old transport's local listeners synchronously, then force a snapshot on the new one; the remote unsubscribe is
      * best-effort and must not block the handover. The server unsubscribes by subscriptionId, so a late cleanup
      * never kills the new generation. Concurrent handovers invalidate via the store generation; identity and the last projection hold.
   */
  async replaceTransport(transport: SessionsIndexTransport): Promise<void> {
    if (!this.closed && this.transport === transport) return;

    const generation = ++this.generation;
    const previous = this.detachTransport();
    this.status = "connecting";
    this.emit();

    if (previous.transport && previous.subscriptionId) {
      // After a proxy handoff the old RPC may never settle; waiting on it parks the new transport
      // in connecting forever. Finish the local detach first; let the remote unsubscribe settle async.
      void unsubscribeIgnoringFailure(previous.transport, previous.subscriptionId);
    }
    if (generation !== this.generation || this.closed) return;

    await this.connect(transport, { forceSnapshot: true });
  }

  /** Frame-routing entry (initial/online notification). Gap -> resubscribe. */
  handleFrame(
    frame: SessionsIndexTopicFrame,
    delivery?: { deliveryKind: TopicFrameDeliveryKind },
  ): void {
    if (this.closed) return;
    // Generation gate: workspace-level fan-out delivers other subscribers' frames on the same topic here too
    // (the host task-index syncer holds a resident sessions-index subscription on its own connectionId).
    // Without filtering by own subscriptionId, foreign (fromSeq, toSeq] windows read as gaps and storm resubscribes.
    // The own initial, pre-subscriptionId, is bounded-staged by the transport; activate releases it after binding.
    // Stale-generation/foreign frames keep dropping here.
    if (this.subscriptionId === null || frame.subscriptionId !== this.subscriptionId) {
      return;
    }
    const awaitingInitial =
      this.awaitingInitial?.subscriptionId === frame.subscriptionId ? this.awaitingInitial : null;
    const deliveryKind = delivery?.deliveryKind ?? "online";
    const initial = deliveryKind === "initial" ? awaitingInitial : null;
    if (initial || (deliveryKind === "recovery" && awaitingInitial)) {
      this.awaitingInitial = null;
    }
    if (deliveryKind === "online" && this.recovery && frame.payload.kind === "snapshot") {
      const gap = this.applyFrame(frame);
      if (!gap) this.subscriptionHasAppliedBase = true;
      return;
    }
    if (deliveryKind === "online" && this.recovery) {
      if (frame.toSeq > this.state.seq) {
        this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      }
      return;
    }
    if (frame.payload.kind === "deltas" && !this.subscriptionHasAppliedBase) {
      this.requestRecovery(deliveryKind === "recovery");
      return;
    }
    const gap = this.applyFrame(frame);
    if (gap && this.transport) {
      logger.warn(
        `[v4-sessions-index] frame gap fromSeq=${frame.fromSeq} local=${this.state.seq}; resubscribing`,
      );
      if (initial) void this.connect(this.transport, { forceSnapshot: true });
      else this.requestRecovery(deliveryKind === "recovery");
      return;
    }
    this.subscriptionHasAppliedBase = true;
    if (deliveryKind === "recovery") this.markRecoveryFrameSeen();
  }

  private handleAssemblyFault(
    subscriptionId: string,
    deliveryKind?: TopicFrameDeliveryKind,
    reasonCode?: string,
  ): void {
    if (subscriptionId !== this.subscriptionId) return;
    if (
      this.awaitingInitial?.subscriptionId === subscriptionId &&
      (deliveryKind === "initial" || deliveryKind === "recovery" || deliveryKind === undefined)
    ) {
      this.awaitingInitial = null;
    }
    // Content-deterministic failures skip the transient ladder (04-sync closed rule 11): resume redelivers the same rejected content.
    // Jump straight to the forced snapshot, the only bytes that could differ; stop if it too is rejected. This store's fail
    // closed clears the projection and backoff-resubscribes -- for a deterministic failure, an endless resubscribe loop.
    if (isDeterministicContentFault(reasonCode)) {
      this.requestRecovery(true, { contentFault: true });
      return;
    }
    if (deliveryKind === "online" && this.recovery) {
      this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      return;
    }
    this.requestRecovery(
      deliveryKind === "recovery" || (deliveryKind === undefined && this.recovery !== null),
    );
  }

  private requestRecovery(recoveryEvent = false, options: { contentFault?: boolean } = {}): void {
    const transport = this.transport;
    const subscriptionId = this.subscriptionId;
    if (this.closed || !transport || !subscriptionId) return;
    const contentFault = options.contentFault === true;
    const existing = this.recovery;
    if (existing) {
      // Once a content failure occurs in a flight, the terminal state is the content failure; later transient faults must not whitewash it.
      if (contentFault) existing.contentFault = true;
      if (!recoveryEvent) return;
      if (existing.forceSnapshot) {
        this.failRecovery("fault.subscription.recoveryFailed");
        return;
      }
      if (existing.requestInFlight || !existing.ackReceived) {
        existing.upgradePending = true;
        return;
      }
      if (existing.ackMode === "resume") this.issueRecovery(existing, true);
      else this.failRecovery("fault.subscription.recoveryFailed");
      return;
    }
    const recovery = {
      subscriptionId,
      requestInFlight: false,
      ackReceived: false,
      validFrameSeen: false,
      upgradePending: false,
      ackMode: null as "snapshot" | "resume" | null,
      forceSnapshot: false,
      postRecoveryGapPending: false,
      frameDeadline: null,
      contentFault,
    };
    this.recovery = recovery;
    // Content failures skip the resume rung and force a snapshot; transient failures still try resume first.
    this.issueRecovery(recovery, contentFault);
  }

  private issueRecovery(
    recovery: NonNullable<SessionsIndexStore["recovery"]>,
    forceSnapshot: boolean,
  ): void {
    const transport = this.transport;
    if (!transport) return;
    this.clearRecoveryDeadline(recovery);
    const effectiveForceSnapshot = forceSnapshot || !this.subscriptionHasAppliedBase;
    recovery.requestInFlight = true;
    recovery.ackReceived = false;
    recovery.ackMode = null;
    recovery.validFrameSeen = false;
    recovery.upgradePending = false;
    recovery.forceSnapshot = effectiveForceSnapshot;
    recovery.postRecoveryGapPending = false;
    void transport
      .resync({
        subscriptionId: recovery.subscriptionId,
        base:
          !this.subscriptionHasAppliedBase || this.state.logEpoch === null
            ? null
            : { logEpoch: this.state.logEpoch, seq: this.state.seq },
        ...(effectiveForceSnapshot ? { forceSnapshot: true } : {}),
      })
      .then((result) => {
        if (this.closed || this.recovery !== recovery) return;
        if (result.ack.subscriptionId !== recovery.subscriptionId) {
          throw new Error("fault.subscription.resyncGenerationMismatch");
        }
        recovery.requestInFlight = false;
        recovery.ackReceived = true;
        recovery.ackMode = result.ack.mode;
        this.settleRecovery(recovery);
      })
      .catch((error) => {
        if (this.closed || this.recovery !== recovery) return;
        this.clearRecoveryDeadline(recovery);
        this.recovery = null;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`[v4-sessions-index] transient subscribe failure; retrying: ${message}`);
        if (isRuntimeUnavailableError(error)) {
          this.handleRuntimeUnavailable();
          return;
        }
        if (message.includes("fault.subscription.notOwned") && this.transport) {
          // Same root as conversationProjectionStore.issueRecovery (production event):
          // notOwned is deterministic ownership divergence, not a transient; parking in error wedges the
          // session list forever. A fresh subscribe with the current watermark lets the server rule resume/snapshot
          // and heals. Special-case notOwned only, so transients cannot storm reconnects.
          void this.connect(this.transport);
          return;
        }
        this.failAndScheduleRecovery(`resync:${message}`);
      });
  }

  private markRecoveryFrameSeen(): void {
    const recovery = this.recovery;
    if (!recovery) return;
    recovery.validFrameSeen = true;
    this.settleRecovery(recovery);
  }

  private settleRecovery(recovery: NonNullable<SessionsIndexStore["recovery"]>): void {
    if (this.recovery !== recovery || !recovery.ackReceived || recovery.requestInFlight) return;
    if (recovery.upgradePending) {
      this.clearRecoveryDeadline(recovery);
      if (!recovery.forceSnapshot && recovery.ackMode === "resume") {
        this.issueRecovery(recovery, true);
      } else {
        this.failRecovery("fault.subscription.recoveryFailed");
      }
      return;
    }
    if (recovery.validFrameSeen) {
      this.clearRecoveryDeadline(recovery);
      if (recovery.postRecoveryGapPending) this.issueRecovery(recovery, false);
      else this.recovery = null;
      return;
    }
    if (recovery.frameDeadline) return;
    recovery.frameDeadline = setTimeout(() => {
      recovery.frameDeadline = null;
      if (this.closed || this.recovery !== recovery || recovery.validFrameSeen) return;
      if (!recovery.forceSnapshot) this.issueRecovery(recovery, true);
      else
        this.failRecovery("fault.subscription.recoveryFrameTimedOut", { contentEligible: false });
    }, PROTOCOL_V4_LIMITS.logicalFrameAssemblyTimeoutMs);
  }

  private clearRecoveryDeadline(recovery: NonNullable<SessionsIndexStore["recovery"]>): void {
    if (!recovery.frameDeadline) return;
    clearTimeout(recovery.frameDeadline);
    recovery.frameDeadline = null;
  }

  private discardRecovery(): void {
    if (this.recovery) this.clearRecoveryDeadline(this.recovery);
    this.recovery = null;
  }

  private clearSubscribeRetry(): void {
    if (!this.subscribeRetryTimer) return;
    clearTimeout(this.subscribeRetryTimer);
    this.subscribeRetryTimer = null;
  }

  private clearErrorRecoveryRetry(): void {
    if (!this.errorRecoveryRetryTimer) return;
    clearTimeout(this.errorRecoveryRetryTimer);
    this.errorRecoveryRetryTimer = null;
  }

  /**
   * Content-deterministic failure: the terminal code distinguishes it from transport failures and schedules **no backoff resubscribe** -- a resubscribe gets the same unreadable
   * content, turning this store's backoff into a never-converging loop (clear -> resubscribe -> rejected -> ...). Self-healing survives via
   * runtime handover, fresh connects, and user reconnects -- only the loop is removed.
   *
   * `contentEligible: false` is for **timeout** terminals: a deadline without a recovery frame is a transport symptom -- never rebrand it
   * contentRejected, nor cancel the still-meaningful retry.
   */
  private failRecovery(reasonCode: string, options: { contentEligible?: boolean } = {}): void {
    // contentFault must be read before discardRecovery.
    const contentFault = this.recovery?.contentFault === true && options.contentEligible !== false;
    this.failAndScheduleRecovery(contentFault ? SUBSCRIPTION_CONTENT_REJECTED : reasonCode, {
      scheduleRetry: !contentFault,
    });
  }

  /**
      * On recovery/subscribe failure, revoke the old projection's live proof and re-fetch authority via bounded backoff.
      * error stays externally visible; retries run only while transport/runtime remain current-generation.
   *
   // `scheduleRetry: false` is for deterministic failures: never schedule a retry doomed to the same result.
   */
  private failAndScheduleRecovery(
    reasonCode: string,
    options: { scheduleRetry?: boolean } = {},
  ): void {
    const transport = this.transport;
    const previousSubscriptionId = this.subscriptionId;
    this.discardRecovery();
    this.subscriptionId = null;
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.state = EMPTY_SESSIONS_INDEX_STATE;
    this.cachedList = null;
    this.status = "error";
    logger.warn(`[v4-sessions-index] recovery fail-closed: ${reasonCode}`);
    if (transport && previousSubscriptionId) {
      void unsubscribeIgnoringFailure(transport, previousSubscriptionId);
    }
    this.clearErrorRecoveryRetry();
    if (transport && !this.closed && options.scheduleRetry !== false) {
      const attempt = this.errorRecoveryRetryAttempt;
      const delayMs =
        ERROR_RECOVERY_RETRY_DELAYS_MS[
          Math.min(attempt, ERROR_RECOVERY_RETRY_DELAYS_MS.length - 1)
        ];
      const nextAttempt = Math.min(attempt + 1, ERROR_RECOVERY_RETRY_DELAYS_MS.length - 1);
      const generation = this.generation;
      this.errorRecoveryRetryAttempt = nextAttempt;
      this.errorRecoveryRetryTimer = setTimeout(() => {
        this.errorRecoveryRetryTimer = null;
        if (this.closed || this.transport !== transport || this.generation !== generation) {
          return;
        }
        void this.connect(transport, {
          forceSnapshot: true,
          errorRecoveryRetryAttempt: nextAttempt,
        });
      }, delayMs);
    }
    this.emit();
  }

  private handleRuntimeRestart(): void {
    if (this.closed || !this.transport) return;
    const transport = this.transport;
    const now = Date.now();
    if (now - this.lastRuntimeRestartAt >= RUNTIME_RESTART_BURST_RESET_MS) {
      this.runtimeRestartBurstCount = 0;
    }
    this.lastRuntimeRestartAt = now;
    const delayMs =
      this.runtimeRestartBurstCount === 0
        ? 0
        : Math.min(
            RUNTIME_RESTART_RECONNECT_BASE_DELAY_MS *
              2 ** Math.min(this.runtimeRestartBurstCount - 1, 16),
            RUNTIME_RESTART_RECONNECT_MAX_DELAY_MS,
          );
    this.runtimeRestartBurstCount += 1;
    this.generation += 1;
    this.clearErrorRecoveryRetry();
    this.errorRecoveryRetryAttempt = 0;
    this.subscriptionId = null;
    this.awaitingInitial = null;
    this.discardRecovery();
    this.subscriptionHasAppliedBase = false;
    if (this.status !== "connecting") {
      this.status = "connecting";
      this.emit();
    }
    if (this.runtimeRestartReconnectTimer) {
      clearTimeout(this.runtimeRestartReconnectTimer);
    }
    // Do not connect on every runtimeRestarted. A pathological restart burst would make each subscribe
    // trigger more runtime starts -- an unbounded reconnect storm. Merge the burst into one fresh
    // subscribe with exponential backoff per consecutive count; after 30 quiet seconds, restore immediate first-hop.
    this.runtimeRestartReconnectTimer = setTimeout(() => {
      this.runtimeRestartReconnectTimer = null;
      if (this.closed || this.transport !== transport) return;
      void this.connect(transport, { forceSnapshot: true });
    }, delayMs);
  }

  private handleRuntimeAvailable(): void {
    if (this.closed || !this.transport) return;
    this.handleRuntimeRestart();
  }

  private handleRuntimeUnavailable(): void {
    if (this.closed) return;
    this.generation += 1;
    this.subscriptionId = null;
    this.awaitingInitial = null;
    this.discardRecovery();
    this.subscriptionHasAppliedBase = false;
    this.clearSubscribeRetry();
    this.clearErrorRecoveryRetry();
    this.errorRecoveryRetryAttempt = 0;
    if (this.runtimeRestartReconnectTimer) {
      clearTimeout(this.runtimeRestartReconnectTimer);
      this.runtimeRestartReconnectTimer = null;
    }
    // With the runtime gone, a stale summary's running/attention loses its live proof; persisted task rows live in
    // tasks-index -- clear the sessions-index projection to avoid orphan spinners.
    this.state = EMPTY_SESSIONS_INDEX_STATE;
    this.cachedList = null;
    this.status = "dormant";
    this.emit();
  }

  /** Releases the subscription and listeners (unmount / workspace switch). */
  close(): void {
    this.closed = true;
    this.generation += 1;
    this.status = "idle";
    const previous = this.detachTransport();
    if (previous.subscriptionId && previous.transport) {
      void unsubscribeIgnoringFailure(previous.transport, previous.subscriptionId);
    }
  }

  private detachTransport(): {
    transport: SessionsIndexTransport | null;
    subscriptionId: string | null;
  } {
    const previous = {
      transport: this.transport,
      subscriptionId: this.subscriptionId,
    };
    if (this.runtimeRestartReconnectTimer) {
      clearTimeout(this.runtimeRestartReconnectTimer);
      this.runtimeRestartReconnectTimer = null;
    }
    this.runtimeRestartBurstCount = 0;
    this.lastRuntimeRestartAt = 0;
    this.clearSubscribeRetry();
    this.clearErrorRecoveryRetry();
    this.errorRecoveryRetryAttempt = 0;
    this.frameUnsub?.();
    this.frameUnsub = null;
    this.faultUnsub?.();
    this.faultUnsub = null;
    this.restartUnsub?.();
    this.restartUnsub = null;
    this.lifecycleUnsub?.();
    this.lifecycleUnsub = null;
    this.transport = null;
    this.subscriptionId = null;
    this.awaitingInitial = null;
    this.discardRecovery();
    this.subscriptionHasAppliedBase = false;
    return previous;
  }

  /** Applies one frame; returns true on a gap (caller resubscribes). */
  applyFrame(frame: SessionsIndexTopicFrame): boolean {
    const { state, gap } = applySessionsIndexFrame(this.state, frame);
    if (gap) return true;
    if (state !== this.state) {
      this.state = state;
      this.cachedList = null;
      this.emit();
    }
    return false;
  }

  // Cleared on gap/reconnect; waits for a fresh snapshot.
  reset(): void {
    this.discardRecovery();
    this.subscriptionHasAppliedBase = false;
    this.state = EMPTY_SESSIONS_INDEX_STATE;
    this.cachedList = null;
    this.emit();
  }

  /** Session list (lastActivityAt descending by default; grouping/pinning live upstream). */
  getSessions(): SessionSummary[] {
    if (this.cachedList === null) {
      this.cachedList = [...this.state.sessions.values()].sort(
        (a, b) => b.lastActivityAt - a.lastActivityAt,
      );
    }
    return this.cachedList;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
