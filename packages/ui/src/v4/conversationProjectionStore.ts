/* eslint-disable max-lines -- projection/base/recovery/optimistic must share one atomic store state machine; splitting it would reintroduce cross-object races. */
// Per-session, read-only projection store.
// The only writer is the subscription push; the UI is read-only. Client rules:
//   1. a snapshot replaces the whole state, never merges;
//   2. delta frames apply only when contiguous (frame.fromSeq === snapshot.seq); on gaps never guess and never patch from caches;
//   3. base lives and dies with the state - on a gap the state is still clean; resubscribe with the current watermark and let the server adjudicate resume/snapshot.
// Apart from the optimistic overlay (pending-command display) this store produces no conversation facts.
import {
  applyConversationDeltas,
  isDeterministicContentFault,
  parseConversationTopic,
  PROTOCOL_V4_LIMITS,
  SUBSCRIPTION_CONTENT_REJECTED,
  type ConversationRow,
  type ConversationSnapshot,
  type ConversationOpenTiming,
  type ConversationTopicFrame,
  type SessionModelTransition,
  type ToolCallRow,
  type TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import type { ConversationTurnNavigatorHydrationResult } from "@/v4/conversationTurnNavigatorHelpers.js";
import type { ConversationTransport } from "@/v4/transport.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

/**
 * Backoff schedule for subscribes interrupted by a runtime generation change.
 *
 * When the CUA Helper finishes cold start, recycleUntilStable -> disposeWorkspace recycles
 * the agent runtime and rejectAll cancels in-flight subscribes. Freezing that transient
 * failure as status="error" could leave a lazily started agent with no one to restart it
 * after dispose, onRuntimeRestart never arrives, and the stuck pane needs a manual
 * "reconnect". subscribeConversationV4 is start-if-needed, so resubscribing restarts the
 * runtime itself; hence bounded backoff per the established sessionsIndexStore pattern.
 */
const RUNTIME_RECYCLE_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;

/**
 * Grace period for the authoritative input projection after an accepted ACK.
 *
 * Core admission ACKs do not wait for the TurnStarted/QueueItem/userInput projections; the
 * two paths normally differ by one renderer/network round-trip. A 2s window covers normal
 * desktop/mobile latency yet recovers quickly from the half-open "CLI keeps working,
 * subscription fully silent" state. On timeout only the subscription is restored; commands
 * are never replayed.
 */
const ACCEPTED_INPUT_PROJECTION_GRACE_MS = 2_000;
const ACCEPTED_INPUT_COMMAND_TYPES = new Set(["sendText"]);

/** lastError shown to the user once backoff is exhausted (generation-change path with no underlying error to reference). */
const RUNTIME_RECYCLED_ERROR = "ZCode agent runtime was recycled; reconnect failed";

function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function roundedDuration(startedAt: number, endedAt: number): number {
  return Math.max(0, Math.round(endedAt - startedAt));
}

/**
 * Whether a subscribe failure is a transient runtime recycle/generation change.
 *
 * All of these messages come from the same recycle: rejectAll cancelling in-flight requests
 * when the transport closes ("transport closed"), the assertNotDisposed early return when
 * reusing a recycled client ("client disposed"), and fail-fast while the runtime has not
 * been restarted yet ("runtime is not running").
 */
function isRuntimeRecycleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    // A cold subscribe may start the runtime itself; once a restart invalidates in-flight
    // ACKs we must still bounded-retry, not park in error.
    message.includes("fault.subscription.runtimeRestarted") ||
    message.includes("ZCode agent transport closed") ||
    message.includes("ZCode Protocol client disposed") ||
    message.includes("ZCode Protocol client is disposed") ||
    message.includes("ZCode Agent runtime is not running")
  );
}

function hasAcceptedInputProjection(
  snapshot: ConversationSnapshot | null,
  commandId: string,
): boolean {
  if (!snapshot) return false;
  if (snapshot.queue.items.some((item) => item.sourceCommandId === commandId)) return true;
  return snapshot.rows.window.some(
    (row) =>
      row.kind === "userInput" && row.origin === "realUser" && row.sourceCommandId === commandId,
  );
}

export type ConversationStoreStatus =
  // Subscribe in flight (first connect or gap resubscribe).
  | "connecting"
  // Subscribed with a contiguous frame stream.
  | "live"
  // Subscribe failed; waiting for retry().
  | "error"
  // Released (unsubscribed by SessionDataLayer); no further operations accepted.
  | "closed";

/** Optimistic overlay entry: the command was sent but is not yet confirmed in the projection. */
export interface OptimisticCommand {
  commandId: string;
  type: string;
  issuedAt: number;
}

export interface ConversationStoreState {
  status: ConversationStoreStatus;
  snapshot: ConversationSnapshot | null;
  subscriptionId: string | null;
  lastError: string | null;
  /** One-shot Host/CLI timing of the first conversation subscribe; not part of snapshot facts. */
  openTiming?: ConversationOpenTiming;
  /** Renderer first-frame timing; announced together with the snapshot so the UI never reads half-updated diagnostics. */
  rendererTiming?: SessionOpenRendererTiming;
  optimisticCommands: readonly OptimisticCommand[];
  /** loadOlder in-flight flag (re-entry guard for automatic prefetch). */
  loadingOlder: boolean;
  /** Terminal plan directory returned by the CLI's full valid projection. */
  sessionPlans: readonly ToolCallRow[];
  /** Exists only to trigger the plan-directory read-only query; not a conversation protocol fact. */
  planDirectoryRevision: number;
  plansLoading: boolean;
  /**
   * Invalidation generation for the turn navigator directory.
   * The not-enough-queries terminal state used to be validated by logEpoch alone, but "at
   * least 2 navigable queries" is a derived condition that changes with deltas, while
   * logEpoch tracks log generations rather than content quiescence. Increment this revision
   * when real-user queries are added/removed (row.appended/row.upserted on realUser
   * userInput, or the row.removed truncation branch) and on full snapshot replacement, so
   * the terminal cache expires.
   */
  turnNavigatorDirectoryRevision: number;
}

export interface SessionOpenRendererTiming {
  rendererPrepareMs?: number;
  initialFrameTransportMs?: number;
  rendererSnapshotApplyMs?: number;
  snapshotAppliedAt?: number;
}

const INITIAL_STATE: ConversationStoreState = {
  status: "connecting",
  snapshot: null,
  subscriptionId: null,
  lastError: null,
  rendererTiming: undefined,
  optimisticCommands: [],
  loadingOlder: false,
  sessionPlans: [],
  planDirectoryRevision: 0,
  plansLoading: false,
  turnNavigatorDirectoryRevision: 0,
};

const TERMINAL_PLAN_STATUSES: ReadonlySet<ToolCallRow["status"]> = new Set([
  "success",
  "error",
  "cancelled",
]);

function shouldInvalidatePlanDirectory(frame: ConversationTopicFrame): boolean {
  if (frame.payload.kind === "snapshot") return true;
  return frame.payload.deltas.some((delta) => {
    if (delta.op === "row.removed") return true;
    if (delta.op !== "row.appended" && delta.op !== "row.upserted") return false;
    const row = delta.row;
    return (
      row.kind === "toolCall" &&
      row.toolName === "ExitPlanMode" &&
      TERMINAL_PLAN_STATUSES.has(row.status)
    );
  });
}

/**
 * Whether the turn navigator directory must be invalidated.
 * The not-enough-queries terminal state was keyed on logEpoch alone, so a real-user query
 * appended within the same epoch stayed cached forever. Conditions:
 * - full snapshot replacement -> true (fresh state, terminal result void);
 * - row.removed -> true (rewind/branch pruning changes the navigable query set);
 * - row.appended/row.upserted on realUser userInput -> true (question added/changed);
 * - other deltas (assistant text, tool, reasoning streams) -> false, no re-probe.
 */
function shouldInvalidateTurnNavigatorDirectory(frame: ConversationTopicFrame): boolean {
  if (frame.payload.kind === "snapshot") return true;
  return frame.payload.deltas.some((delta) => {
    if (delta.op === "row.removed") return true;
    if (delta.op !== "row.appended" && delta.op !== "row.upserted") return false;
    const row = delta.row;
    return row.kind === "userInput" && row.origin === "realUser";
  });
}

function logSubagentProjectionTransition(
  topic: string,
  previous: ConversationSnapshot | null,
  next: ConversationSnapshot,
  delivery: "snapshot" | "deltas",
): void {
  const previousIds = previous?.subagents?.running.map((item) => item.childSessionId) ?? [];
  const nextIds = next.subagents?.running.map((item) => item.childSessionId) ?? [];
  if (
    previousIds.length === nextIds.length &&
    previousIds.every((childSessionId, index) => childSessionId === nextIds[index])
  ) {
    return;
  }
  // The root cause of the interaction bug is in the subscription snapshot handoff, not the
  // React DOM; log a light identity/watermark only when the agent running set changes so a
  // local repro can tell a legitimate terminal state from a late snapshot overwrite.
  logger.info("[v4-store] running subagent projection changed", {
    delivery,
    nextBackgroundWorkIds: next.backgroundWorks
      .filter((work) => work.kind === "subagent" && work.status === "running")
      .map((work) => work.childSessionId ?? work.workId),
    nextIds,
    nextSeq: next.seq,
    previousIds,
    previousSeq: previous?.seq ?? null,
    topic,
  });
}

/**
 * Older history remains iff the window's first row is not the total-order first row
 * (firstRowId check). Pure helper shared by store/components; a missing snapshot, empty
 * window, or unknown firstRowId always yields false.
 */
export function hasOlderRows(snapshot: ConversationSnapshot | null): boolean {
  if (!snapshot) return false;
  const first = snapshot.rows.window[0];
  if (!first || snapshot.rows.firstRowId === null) return false;
  return first.rowId > snapshot.rows.firstRowId;
}

/**
 * Whether the cold-snapshot tail window is truncated mid-turn. turnHeader is the authoritative
 * start of a complete turn, and the first row may be a lightBoundary, so we must check whether
 * the first turn already has a header in the window, not just the first row's kind.
 */
export function shouldAutoLoadIncompleteLeadingTurn(
  snapshot: ConversationSnapshot | null,
  loadingOlder: boolean,
): boolean {
  if (loadingOlder || !hasOlderRows(snapshot) || !snapshot) return false;
  const leadingTurnId = snapshot.rows.window[0]?.turnId;
  if (!leadingTurnId) return false;
  return !snapshot.rows.window.some(
    (row) => row.turnId === leadingTurnId && row.kind === "turnHeader",
  );
}

/**
 * Merges rows/range results into the local window (merge canon): keyed by rowId, keep only
 * rows before the window head, dedupe and prepend; order key = ascending rowId (total order).
 * Returns null when nothing can be merged (window unchanged, caller keeps its reference).
 */
function mergeOlderRows(
  window: readonly ConversationRow[],
  fetched: readonly ConversationRow[],
): ConversationRow[] | null {
  const firstRowId = window[0]?.rowId ?? Number.POSITIVE_INFINITY;
  const older = fetched.filter((row) => row.rowId < firstRowId);
  if (older.length === 0) return null;
  return [...older, ...window];
}

/**
 * External store (useSyncExternalStore-compatible: subscribe + getState return stable
 * references). Lifecycle is owned by SessionDataLayer (refcount + keep-warm); components
 * never construct it directly.
 */
// Memory diagnostics counter: tracks the live store count and the sum of rows.window
// lengths to watch window-memory growth. Added on construction, removed on close().
const liveProjectionStores = new Set<ConversationProjectionStore>();
uiMemoryDiagnosticsRegistry.register("projection", () => {
  let rows = 0;
  for (const store of liveProjectionStores) {
    rows += store.countProjectionRows();
  }
  return { stores: liveProjectionStores.size, rows };
});

export class ConversationProjectionStore {
  private state: ConversationStoreState = INITIAL_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly modelTransitionListeners = new Set<
    (transition: SessionModelTransition) => void
  >();
  private observedModelTransitionEventId: string | null = null;
  // Subscription generation: concurrent connects honor only the newest; stale results
  // unsubscribe immediately so no server-side subscription is left dangling.
  private generation = 0;
  // Before the first subscribe ACK, runtime available is just the normal completion signal
  // of the in-flight startup; count it so the lifecycle notification does not trigger yet
  // another connect and race a same-topic subscription replacement.
  private connectInFlight = 0;
  /**
   * The subscribe ACK mode persists until this generation's first logical frame; relying on
   * the synchronous activate stack alone is unsafe because the notification can arrive
   * asynchronously after the ACK promise resolves.
   */
  private awaitingInitial: { subscriptionId: string; mode: "snapshot" | "resume" } | null = null;
  /** Whether the current subscription has proven its watermark via an applied base or this generation's logical frame. */
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
    /** This flight was started for a deterministic content fault: terminal state is contentRejected, kept out of transient stats. */
    contentFault: boolean;
  } | null = null;
  private readonly offAssemblyFault: () => void;
  private readonly offRuntimeRestart: (() => void) | null = null;
  private readonly offRuntimeLifecycle: (() => void) | null = null;
  private runtimeRecycleRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeRecycleRetryAttempt = 0;
  private sessionOpenRendererTiming: SessionOpenRendererTiming = {};
  private initialSubscribeAckAt: number | null = null;
  private planQueryInFlight = false;
  private planQueryPending = false;
  /** Projection-confirmation watchdog for accepted inputs; carries no commands and creates no local facts. */
  private readonly acceptedInputProjectionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Terminal-state cache for hydrated/not-enough-queries. Validity used to be keyed on
  // logEpoch alone, so a real-user query appended in the same epoch stayed cached forever.
  // directoryRevision now participates too: real-user query add/remove bumps it, expiring
  // the terminal state for a fresh probe.
  private turnNavigatorHydrationTerminal:
    | (Extract<
        ConversationTurnNavigatorHydrationResult,
        { status: "hydrated" | "not-enough-queries" }
      > & { directoryRevision: number })
    | null = null;
  private closed = false;

  constructor(
    readonly topic: string,
    private readonly transport: ConversationTransport,
  ) {
    liveProjectionStores.add(this);
    this.offAssemblyFault = transport.onAssemblyFault((fault) => {
      if (fault.topic === this.topic) {
        this.handleAssemblyFault(fault.subscriptionId, fault.deliveryKind, fault.reasonCode);
      }
    });
    // A runtime generation change (CLI restart) goes through lifecycle first, per the
    // sessionsIndexStore convention: at dispose time only unavailable is observable, and
    // onRuntimeRestart waits for the new process to spawn - possibly never, under lazy start.
    if (transport.onRuntimeLifecycle) {
      this.offRuntimeLifecycle = transport.onRuntimeLifecycle((state) => {
        if (state === "available") this.handleRuntimeAvailable();
        else this.handleRuntimeUnavailable();
      });
      // A proxy handoff is not a runtime generation change; only the restart channel carries
      // that semantic - ReplaceableConversationTransport.replace() broadcasts to
      // runtimeRestartListeners and fires no lifecycle events. Dropping the restart channel
      // here would leave remote-workspace proxy handoffs unhandled: replace() already
      // best-effort unsubscribes the old proxy while the store stays live on a stale
      // subscriptionId, silently breaking the frame stream with no self-healing.
      // Reacting only to transportReplaced keeps the two paths from overlapping: an underlying
      // runtime restart forwarded via bindRuntimeRestartListener invokes listener() with no
      // reason and is already handled by the lifecycle available path.
      this.offRuntimeRestart = transport.onRuntimeRestart((reason) => {
        if (reason !== "transportReplaced") return;
        this.handleRuntimeRestart(reason);
      });
    } else {
      this.offRuntimeRestart = transport.onRuntimeRestart((reason) =>
        this.handleRuntimeRestart(reason),
      );
    }
  }

  getState(): ConversationStoreState {
    return this.state;
  }

  getSessionOpenRendererTiming(): SessionOpenRendererTiming {
    return { ...this.sessionOpenRendererTiming };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onOnlineModelTransition(listener: (transition: SessionModelTransition) => void): () => void {
    this.modelTransitionListeners.add(listener);
    return () => this.modelTransitionListeners.delete(listener);
  }

  private setState(patch: Partial<ConversationStoreState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  /**
   * Starts/resumes the subscription. base comes from the current snapshot watermark
   * (watermark invariant: attach it only when we truly hold a consistent state at that seq);
   * forceSnapshot is the fallback when resume frames still leave a gap - drop base, go full.
   */
  async connect(
    options: {
      forceSnapshot?: boolean;
      initialOverflowRetry?: boolean;
      rendererPrepareStartedAt?: number;
    } = {},
  ): Promise<void> {
    if (this.closed) return;
    const generation = ++this.generation;
    this.discardRecovery();
    const snapshot = options.forceSnapshot ? null : this.state.snapshot;
    const connectStartedAt = options.rendererPrepareStartedAt ?? monotonicNow();
    const subscribeStartedAt = monotonicNow();
    logger.lifecycle.info("v4 conversation store connect started", {
      event: "v4.conversation.store.connect.started",
      generation,
      hasBase: Boolean(snapshot),
      module: "ui.v4.conversation_projection_store",
      status: "started",
      topic: this.topic,
    });
    this.sessionOpenRendererTiming = {
      rendererPrepareMs: roundedDuration(connectStartedAt, subscribeStartedAt),
    };
    this.initialSubscribeAckAt = null;
    this.connectInFlight += 1;
    this.setState({ status: "connecting", rendererTiming: this.sessionOpenRendererTiming });
    try {
      const result = await this.transport.subscribe({
        topic: this.topic,
        base: snapshot ? { logEpoch: snapshot.logEpoch, seq: snapshot.seq } : undefined,
      });
      if (generation !== this.generation || this.closed) {
        // Stale generation: nobody consumes this subscription anymore; unsubscribe now.
        logger.lifecycle.warn("v4 conversation store connect ACK became stale", {
          event: "v4.conversation.store.connect.stale_ack",
          generation,
          currentGeneration: this.generation,
          module: "ui.v4.conversation_projection_store",
          status: "failed",
          subscriptionId: result.ack.subscriptionId,
          topic: this.topic,
        });
        void this.transport.unsubscribe(result.ack.subscriptionId);
        return;
      }
      // Root cause of the production fault.subscription.notOwned stalls: connect() discards
      // recovery only at entry, so during the subscribe-ACK await window the old subscription
      // can still create a same-sub recovery; the host scope has already evicted that
      // subscription by ownershipKey on the new ACK remember(), dooming its in-flight resync
      // to a notOwned rejection. Drop the old recovery as soon as the generation succeeds -
      // the new subscription's initial atomically replaces the whole projection, making the
      // old recovery stream moot; otherwise its late failure would flag the live new
      // subscription as error.
      this.discardRecovery();
      this.runtimeRecycleRetryAttempt = 0;
      this.initialSubscribeAckAt = monotonicNow();
      this.setState({
        status: "live",
        subscriptionId: result.ack.subscriptionId,
        lastError: null,
        openTiming: result.ack.openTiming,
      });
      this.subscriptionHasAppliedBase = Boolean(
        snapshot && result.ack.mode === "resume" && result.ack.logEpoch === snapshot.logEpoch,
      );
      // The public result is ACK-only; initial and online both arrive via notification.
      // subscriptionId must enter the store first so activate can synchronously release the
      // own-initial parked within the same read.
      this.awaitingInitial = {
        subscriptionId: result.ack.subscriptionId,
        mode: result.ack.mode,
      };
      this.transport.activate(result.ack.subscriptionId);
      logger.lifecycle.info("v4 conversation store connect completed", {
        durationMs: roundedDuration(subscribeStartedAt, monotonicNow()),
        event: "v4.conversation.store.connect.completed",
        generation,
        logEpoch: result.ack.logEpoch,
        mode: result.ack.mode,
        module: "ui.v4.conversation_projection_store",
        status: "completed",
        subscriptionId: result.ack.subscriptionId,
        topic: this.topic,
      });
    } catch (error) {
      if (generation !== this.generation || this.closed) return;
      const message = error instanceof Error ? error.message : String(error);
      this.awaitingInitial = null;
      this.subscriptionHasAppliedBase = false;
      if (
        message.includes("fault.subscription.initialFrameStagingOverflow") &&
        !options.initialOverflowRetry
      ) {
        // The physical batch is already broken before the ACK and no active same-sub exists;
        // the only option is a fresh subscribe forcing a snapshot. Retry this automatically
        // at most once to avoid a retry storm from a misbehaving peer.
        await this.connect({ forceSnapshot: true, initialOverflowRetry: true });
        return;
      }
      if (this.scheduleRuntimeRecycleRetry(error, generation)) {
        logger.lifecycle.warn("v4 conversation store connect retry scheduled", {
          durationMs: roundedDuration(subscribeStartedAt, monotonicNow()),
          errorMessage: message,
          event: "v4.conversation.store.connect.retry_scheduled",
          generation,
          module: "ui.v4.conversation_projection_store",
          status: "retrying",
          topic: this.topic,
        });
        logger.warn(
          `[v4-store] subscribe ${this.topic} interrupted by runtime generation change, backing off: ${message}`,
        );
        return;
      }
      logger.lifecycle.warn("v4 conversation store connect failed", {
        durationMs: roundedDuration(subscribeStartedAt, monotonicNow()),
        errorMessage: message,
        event: "v4.conversation.store.connect.failed",
        generation,
        module: "ui.v4.conversation_projection_store",
        status: "failed",
        topic: this.topic,
      });
      logger.warn(`[v4-store] subscribe ${this.topic} failed: ${message}`);
      this.setState({ status: "error", lastError: message });
    } finally {
      this.connectInFlight -= 1;
    }
  }

  private clearRuntimeRecycleRetry(): void {
    if (this.runtimeRecycleRetryTimer === null) return;
    clearTimeout(this.runtimeRecycleRetryTimer);
    this.runtimeRecycleRetryTimer = null;
  }

  /**
   * Subscribe failure caused by a runtime generation change: stay connecting and bounded-retry.
   * Returns true when this failure has been handled; the caller must not then set error.
   */
  private scheduleRuntimeRecycleRetry(error: unknown, generation: number): boolean {
    if (!isRuntimeRecycleError(error)) return false;
    return this.scheduleRuntimeRecycleReconnect(generation);
  }

  /**
   * Bounded-backoff reconnect. Resubscription goes through start-if-needed
   * (zcodeAgentService.subscribeConversationV4), which starts a lazily created runtime by
   * itself - the only self-healing path when available never arrives.
   * Returns true when handled; the caller must not then set error.
   */
  private scheduleRuntimeRecycleReconnect(generation: number): boolean {
    if (this.closed) return false;
    const delayMs = RUNTIME_RECYCLE_RETRY_DELAYS_MS[this.runtimeRecycleRetryAttempt];
    if (delayMs === undefined) return false;
    this.runtimeRecycleRetryAttempt += 1;
    this.clearRuntimeRecycleRetry();
    // Keep the old snapshot: the projection stays clean throughout the generation change and
    // a successful reconnect replaces it atomically.
    this.setState({ status: "connecting" });
    this.runtimeRecycleRetryTimer = setTimeout(() => {
      this.runtimeRecycleRetryTimer = null;
      if (this.closed || generation !== this.generation) return;
      void this.connect();
    }, delayMs);
    return true;
  }

  /** Immediate workspace dispose: the old runtime is dead and no new one exists; resubscribe impossible. */
  private handleRuntimeUnavailable(): void {
    if (this.closed) return;
    this.clearRuntimeRecycleRetry();
    this.discardRecovery();
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.generation += 1;
    // The old subscriptionId belongs to a dead runtime; never unsubscribe it (its host-side owner is gone).
    this.setState({ status: "connecting", subscriptionId: null });
    // Waiting dormant for available is not enough: the agent starts lazily, so after dispose
    // with nobody to restart it that signal never arrives and the pane spins forever. The
    // backoff reconnect restarts the runtime by itself; if available lands first, reset the
    // attempt counter and reconnect immediately.
    if (this.scheduleRuntimeRecycleReconnect(this.generation)) return;
    // Backoff exhausted (runtime recycled repeatedly): fall to error to surface the
    // "reconnect" affordance; connecting without a timer spins forever with no manual retry.
    this.setState({ status: "error", lastError: RUNTIME_RECYCLED_ERROR });
  }

  /** New runtime ready: same semantic as onRuntimeRestart; resubscribe with the original watermark. */
  private handleRuntimeAvailable(): void {
    if (this.closed) return;
    this.clearRuntimeRecycleRetry();
    this.runtimeRecycleRetryAttempt = 0;
    if (this.connectInFlight > 0) {
      // A cold-start spawn broadcasts available before the first subscribe ACK returns.
      // Reconnecting here immediately would make the server replace the old subscription on
      // the same connection/topic; the old ACK is then unsubscribed by the local generation
      // guard, the first-frame handoff races, and the pane may never receive a snapshot.
      // The in-flight connect already owns this startup; do not resubscribe here.
      return;
    }
    this.handleRuntimeRestart("runtimeRestart");
  }

  /** Manual retry entry after a subscribe failure (target of the pane-level "reconnect" button). */
  retry(): Promise<void> {
    this.clearRuntimeRecycleRetry();
    this.runtimeRecycleRetryAttempt = 0;
    return this.connect();
  }

  /** Epoch/entity authority invalidated for a row command/query; converge via same-sub recovery. */
  recoverFromStaleAuthority(): void {
    this.requestRecovery();
  }

  /** Frame-routing entry point from SessionDataLayer. */
  handleFrame(
    frame: ConversationTopicFrame,
    delivery?: { deliveryKind: TopicFrameDeliveryKind },
  ): void {
    if (this.closed) return;
    // Generation guard: drop late frames from stale subscriptions.
    if (frame.subscriptionId !== this.state.subscriptionId) return;
    const awaitingInitial =
      this.awaitingInitial?.subscriptionId === frame.subscriptionId ? this.awaitingInitial : null;
    const deliveryKind = delivery?.deliveryKind ?? "online";
    const frameReceivedAt = monotonicNow();
    // RPC ordering cannot prove a frame's purpose. Only a publisher-marked initial consumes
    // awaitingInitial; recovery must clear that state first so a recovery gap is not misread
    // as the original subscribe gap and migrated to a new subId. Late online duplicates must
    // not consume any gate.
    const initial = deliveryKind === "initial" ? awaitingInitial : null;
    if (initial || (deliveryKind === "recovery" && awaitingInitial)) {
      this.awaitingInitial = null;
    }
    if (deliveryKind === "online" && this.recovery && frame.payload.kind === "snapshot") {
      // An online overflow snapshot is a complete authoritative state and may establish the
      // applied base, but it does not count as recovery delivery: the flight still waits for
      // its own recovery frame/ACK to close.
      this.applyFrame(frame, { subscribeMode: null, recovery: false, online: true });
      return;
    }
    if (deliveryKind === "online" && this.recovery) {
      // An online frame after the recovery reservation may arrive in the same read as the
      // ACK; once the recovery logical frame has been applied, a non-duplicate online seen at
      // ACK close requires a successor flight.
      if (frame.toSeq > (this.state.snapshot?.seq ?? 0)) {
        this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      }
      return;
    }
    if (frame.payload.kind === "deltas" && !this.subscriptionHasAppliedBase) {
      // ACK(snapshot) does not establish an applied base; once the initial is lost, a
      // numerically matching fromSeq must not be used to stitch the new epoch's deltas onto
      // the old state.
      this.requestRecovery(deliveryKind === "recovery");
      return;
    }
    this.applyFrame(frame, {
      subscribeMode: initial?.mode ?? null,
      recovery: deliveryKind === "recovery",
      online: deliveryKind === "online",
      frameReceivedAt,
    });
  }

  private applyFrame(
    frame: ConversationTopicFrame,
    context: {
      subscribeMode: "snapshot" | "resume" | null;
      recovery: boolean;
      online: boolean;
      frameReceivedAt?: number;
    },
  ): void {
    if (frame.payload.kind === "snapshot") {
      const hadAppliedBase = this.subscriptionHasAppliedBase;
      logSubagentProjectionTransition(
        this.topic,
        this.state.snapshot,
        frame.payload.snapshot,
        "snapshot",
      );
      // Rule 1: full replacement - drop everything held and take the new state.
      this.setState({
        snapshot: frame.payload.snapshot,
        planDirectoryRevision: this.state.planDirectoryRevision + 1,
        // A full snapshot replacement may have changed the real-user query set; the terminal cache must expire.
        turnNavigatorDirectoryRevision: this.state.turnNavigatorDirectoryRevision + 1,
      });
      this.subscriptionHasAppliedBase = true;
      this.reconcileOptimistic(frame.payload.snapshot);
      this.reconcileAcceptedInputProjection(frame.payload.snapshot);
      // When the initial is lost, the publisher allows a full online snapshot to establish the
      // first applied base; persistent transitions within it may predate this subscription and
      // must not masquerade as live events. The first frame only seeds the observation
      // baseline; later online transitions notify the pane.
      this.observeModelTransition(frame.payload.snapshot, context.online && hadAppliedBase);
      if (context.subscribeMode !== null && context.frameReceivedAt !== undefined) {
        const snapshotAppliedAt = monotonicNow();
        this.sessionOpenRendererTiming = {
          ...this.sessionOpenRendererTiming,
          ...(this.initialSubscribeAckAt === null
            ? {}
            : {
                initialFrameTransportMs: roundedDuration(
                  this.initialSubscribeAckAt,
                  context.frameReceivedAt,
                ),
              }),
          rendererSnapshotApplyMs: roundedDuration(context.frameReceivedAt, snapshotAppliedAt),
          snapshotAppliedAt,
        };
        this.setState({ rendererTiming: this.sessionOpenRendererTiming });
      }
      if (context.recovery) this.markRecoveryFrameSeen();
      return;
    }
    const current = this.state.snapshot;
    // Rule 2a: late/duplicate logical frames are always dropped silently. If it is the
    // post-ACK aligned recovery `(N,N]`, only close the flight; do not apply it again.
    if (current && frame.toSeq <= current.seq) {
      if (context.recovery) this.markRecoveryFrameSeen();
      return;
    }
    if (!current || frame.fromSeq !== current.seq) {
      // Rule 2: never guess across a gap. The state is still the consistent projection at
      // seq=current.seq (this frame did not touch it), so the base remains valid - resubscribe
      // and let the server adjudicate resume vs full. If the gap persists within the
      // subscribe's resume frames (already adjudicated once), drop base and force a snapshot
      // to break the loop.
      logger.warn(
        `[v4-store] ${this.topic} frame gap fromSeq=${frame.fromSeq} local=${current?.seq ?? "none"}; resubscribing`,
      );
      if (context.subscribeMode !== null) {
        // A fresh subscribe whose resume initial still leaves a gap migrates the subscription
        // and forces a snapshot; an active subscription's online/recovery gap stays same-sub.
        void this.connect({ forceSnapshot: true });
      } else {
        this.requestRecovery(context.recovery);
      }
      return;
    }
    const applied = applyConversationDeltas(current, frame.payload.deltas);
    // seq is the snapshot-aligned watermark; applying a delta frame advances it to the frame's right endpoint.
    const next = { ...applied, seq: frame.toSeq };
    logSubagentProjectionTransition(this.topic, current, next, "deltas");
    const removedFromRowId = frame.payload.deltas.reduce<number | null>(
      (earliest, delta) =>
        delta.op === "row.removed"
          ? Math.min(earliest ?? delta.fromRowId, delta.fromRowId)
          : earliest,
      null,
    );
    this.setState({
      snapshot: next,
      // row.removed provides the authoritative pruning boundary, so stale branch plans can be
      // dropped from the cached directory in step; the full query still refetches earlier
      // plans of the current branch that fall outside the wire tail.
      ...(removedFromRowId === null
        ? {}
        : {
            sessionPlans: this.state.sessionPlans.filter((row) => row.rowId < removedFromRowId),
          }),
      ...(shouldInvalidatePlanDirectory(frame)
        ? { planDirectoryRevision: this.state.planDirectoryRevision + 1 }
        : {}),
      // Real-user query add/remove (row.appended/row.upserted on realUser userInput, or the
      // row.removed truncation branch) bumps the navigator directory revision, expiring the
      // terminal cache and permitting a re-probe.
      ...(shouldInvalidateTurnNavigatorDirectory(frame)
        ? {
            turnNavigatorDirectoryRevision: this.state.turnNavigatorDirectoryRevision + 1,
          }
        : {}),
    });
    this.subscriptionHasAppliedBase = true;
    this.reconcileOptimistic(next);
    this.reconcileAcceptedInputProjection(next);
    this.observeModelTransition(next, context.online);
    if (context.recovery) this.markRecoveryFrameSeen();
  }

  private observeModelTransition(snapshot: ConversationSnapshot, online: boolean): void {
    const transition = snapshot.modelTransition;
    const eventId = transition?.eventId ?? null;
    if (eventId === this.observedModelTransitionEventId) return;
    // Persistent transitions replay inside initial/recovery snapshots; recording the ID only
    // at toast time would let a later plain online snapshot mistake the old fallback for a
    // new event. Every valid frame updates the observation baseline; only the first live
    // online transition notifies this client.
    this.observedModelTransitionEventId = eventId;
    if (!online || !transition) return;
    for (const listener of this.modelTransitionListeners) listener(transition);
  }

  /** Physical assembly fault: keep the old projection visible; single-flight recovery on the active subscription. */
  handleAssemblyFault(
    subscriptionId: string,
    deliveryKind?: TopicFrameDeliveryKind,
    reasonCode?: string,
  ): void {
    if (this.closed || subscriptionId !== this.state.subscriptionId) return;
    if (
      this.awaitingInitial?.subscriptionId === subscriptionId &&
      (deliveryKind === "initial" || deliveryKind === "recovery" || deliveryKind === undefined)
    ) {
      this.awaitingInitial = null;
    }
    // Deterministic content faults skip the transient ladder (04-sync closed rule 11): resume
    // would redeliver the same deltas and be rejected again, and deliveryKind does not change
    // the verdict - this client cannot parse that content. Only a forced snapshot can produce
    // different bytes, so jump straight to it; if the snapshot is content-rejected too, stop
    // instead of burning the subscription on doomed retries.
    if (isDeterministicContentFault(reasonCode)) {
      this.requestRecovery(true, { contentFault: true });
      return;
    }
    // Missing/forged deliveryKind arrives as an undefined typed fault; if a recovery is in
    // flight it must fail closed/escalate, not wait forever treating the bad recovery as a
    // normal burst.
    const recoveryFault =
      deliveryKind === "recovery" || (deliveryKind === undefined && this.recovery !== null);
    if (deliveryKind === "online" && this.recovery) {
      this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      return;
    }
    this.requestRecovery(recoveryFault);
  }

  private requestRecovery(recoveryEvent = false, options: { contentFault?: boolean } = {}): void {
    if (this.closed) return;
    const subscriptionId = this.state.subscriptionId;
    if (!subscriptionId) {
      void this.connect({ forceSnapshot: true });
      return;
    }
    const contentFault = options.contentFault === true;
    const existing = this.recovery;
    if (existing) {
      // Once a content failure occurs within a flight, the terminal state is the content
      // failure: later transient faults must not whitewash it.
      if (contentFault) existing.contentFault = true;
      if (!recoveryEvent) return;
      if (existing.forceSnapshot) {
        this.failRecovery("fault.subscription.recoveryFailed");
        return;
      }
      // A recovery logical/fault may precede the ACK promise continuation; remember the
      // escalation intent and force a snapshot as soon as ACK=resume lands. Plain burst gaps
      // never set this flag.
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
      ackMode: null,
      forceSnapshot: false,
      postRecoveryGapPending: false,
      frameDeadline: null,
      contentFault,
    };
    this.recovery = recovery;
    // Content failures skip the resume rung and force a snapshot directly; transient failures
    // still try resume first per the original ladder.
    this.issueRecovery(recovery, contentFault);
  }

  private issueRecovery(
    recovery: NonNullable<ConversationProjectionStore["recovery"]>,
    forceSnapshot: boolean,
  ): void {
    this.clearRecoveryDeadline(recovery);
    const snapshot = this.state.snapshot;
    const effectiveForceSnapshot = forceSnapshot || !this.subscriptionHasAppliedBase;
    recovery.requestInFlight = true;
    recovery.ackReceived = false;
    recovery.ackMode = null;
    recovery.upgradePending = false;
    recovery.validFrameSeen = false;
    recovery.forceSnapshot = effectiveForceSnapshot;
    recovery.postRecoveryGapPending = false;
    void this.transport
      .resync({
        subscriptionId: recovery.subscriptionId,
        base:
          this.subscriptionHasAppliedBase && snapshot
            ? { logEpoch: snapshot.logEpoch, seq: snapshot.seq }
            : null,
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
        logger.warn(`[v4-store] resync ${this.topic} failed: ${message}`);
        if (message.includes("fault.subscription.notOwned")) {
          // Production event: notOwned means some layer no longer recognizes this
          // subscription ownership (silent scope-generation eviction, misplaced unsubscribe,
          // similar state divergence) - a deterministic invalidation, not a transient fault.
          // Parking in error for a manual reconnect would stall the session for good. The
          // local snapshot is still a consistent projection: fresh-subscribe with the current
          // watermark and let the server adjudicate resume/snapshot (04-sync rule 3) to
          // self-heal. Special-case notOwned only, so transient errors cannot trigger
          // reconnect storms.
          void this.connect();
          return;
        }
        this.setState({ status: "error", lastError: message });
      });
  }

  private markRecoveryFrameSeen(): void {
    const recovery = this.recovery;
    if (!recovery) return;
    recovery.validFrameSeen = true;
    this.settleRecovery(recovery);
  }

  private settleRecovery(recovery: NonNullable<ConversationProjectionStore["recovery"]>): void {
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
      if (recovery.postRecoveryGapPending) {
        this.issueRecovery(recovery, false);
      } else {
        this.recovery = null;
      }
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

  private clearRecoveryDeadline(
    recovery: NonNullable<ConversationProjectionStore["recovery"]>,
  ): void {
    if (!recovery.frameDeadline) return;
    clearTimeout(recovery.frameDeadline);
    recovery.frameDeadline = null;
  }

  private discardRecovery(): void {
    if (this.recovery) this.clearRecoveryDeadline(this.recovery);
    this.recovery = null;
  }

  /**
   * `contentEligible: false` is for **timeout** terminal states: a deadline expiring without a
   * recovery frame is a transport symptom, so even a flight that originated from a content
   * failure must not be relabeled contentRejected - that would also cancel a still-meaningful
   * retry.
   */
  private failRecovery(reasonCode: string, options: { contentEligible?: boolean } = {}): void {
    if (!this.recovery) return;
    // Deterministic content failures and transport failures must stay distinguishable: the
    // former never improves on reconnect, and telemetry aggregated by code must not read a
    // version mismatch as network jitter (reasonCode vocabulary in wire-fault.ts).
    const contentFault = this.recovery.contentFault && options.contentEligible !== false;
    const code = contentFault ? SUBSCRIPTION_CONTENT_REJECTED : reasonCode;
    this.discardRecovery();
    logger.warn(`[v4-store] ${this.topic} recovery fail-closed: ${code}`);
    this.setState({ status: "error", lastError: code });
  }

  private handleRuntimeRestart(reason?: "runtimeRestart" | "transportReplaced"): void {
    if (this.closed) return;
    // The transport already invalidated the old ownership/assembler; never unsubscribe with
    // the old transport/runtime subId - fresh-subscribe directly and keep the old snapshot
    // until the new one replaces it atomically.
    this.generation += 1;
    this.discardRecovery();
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.setState({ status: "connecting", subscriptionId: null });
    // A proxy handoff is not a CLI runtime restart; forcing a snapshot would swap the user's
    // already-loaded older rows back to the tail window. A handoff keeps the consistent
    // projection watermark and lets the server adjudicate resume vs snapshot by logEpoch/seq;
    // a genuine runtime restart keeps the full subscribe.
    if (reason === "transportReplaced") void this.connect();
    else void this.connect({ forceSnapshot: true });
  }

  /**
   * loadOlder: fetch one window of history above the window-head cursor and prepend.
   * - Single flight: repeat calls no-op while in flight (loadingOlder re-entry guard);
   * - Stale-read guard: results whose atLogEpoch differs from the current snapshot epoch are
   *   dropped wholesale (across CLI restarts);
   * - Merge keyed by rowId: consistent with the subscription stream's row.upserted/removed,
   *   so delta frames arriving mid-flight are unaffected (they only touch rows at/after the
   *   window head).
   */
  async loadOlder(limit: number = PROTOCOL_V4_LIMITS.snapshotTailWindowRows): Promise<void> {
    if (this.closed || this.state.loadingOlder) return;
    const snapshot = this.state.snapshot;
    if (!hasOlderRows(snapshot) || !snapshot) return;
    const sessionId = parseConversationTopic(this.topic);
    if (!sessionId) return;
    const beforeRowId = snapshot.rows.window[0]?.rowId;
    if (beforeRowId === undefined) return;
    this.setState({ loadingOlder: true });
    try {
      const result = await this.transport.rowsRange({
        sessionId,
        beforeRowId,
        limit,
      });
      if (this.closed) return;
      const current = this.state.snapshot;
      if (!current || result.atLogEpoch !== current.logEpoch) {
        logger.warn(
          `[v4-store] ${this.topic} rows/range epoch mismatch (${result.atLogEpoch}); dropping the batch`,
        );
        return;
      }
      // Cursor invalidated mid-flight (row.removed truncation / full snapshot resync) voids
      // the result, preventing resurrected history rows already removed upstream; the next
      // trigger refetches against the new window.
      if (current.rows.window[0]?.rowId !== beforeRowId) return;
      const window = mergeOlderRows(current.rows.window, result.rows);
      if (window === null) return;
      this.setState({
        snapshot: { ...current, rows: { ...current.rows, window } },
      });
    } catch (error) {
      // The query is read-only and safe to reissue: a failure never enters the error state;
      // the next trigger retries.
      logger.warn(
        `[v4-store] rowsRange ${this.topic} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (!this.closed) this.setState({ loadingOlder: false });
    }
  }

  /**
   * Full question directory: complete the current valid branch in one pass along the existing
   * rows/range cursor.
   *
   * The problem navigator used to scan the renderer's tail window directly, so a 1000-turn
   * session showed only the few dozen turns already loaded. This pages at protocol limits but
   * swaps the snapshot once after every page succeeds, avoiding a timeline render-units
   * rebuild plus two virtualizer remounts per 200 rows.
   */
  async loadAllOlder(): Promise<ConversationTurnNavigatorHydrationResult> {
    const stale = (logEpoch = this.state.snapshot?.logEpoch ?? "unknown") => ({
      status: "stale" as const,
      logEpoch,
    });
    if (this.closed || this.state.loadingOlder) return stale();
    const snapshot = this.state.snapshot;
    if (!snapshot) return stale();
    // A terminal state must match both logEpoch and directoryRevision. logEpoch tracks log
    // generations, not content quiescence - real-user query add/remove bumps the revision,
    // expiring the terminal state and permitting a re-probe.
    const directoryRevision = this.state.turnNavigatorDirectoryRevision;
    if (
      this.turnNavigatorHydrationTerminal?.logEpoch === snapshot.logEpoch &&
      this.turnNavigatorHydrationTerminal.directoryRevision === directoryRevision
    ) {
      return this.turnNavigatorHydrationTerminal;
    }
    if (!hasOlderRows(snapshot)) return stale(snapshot.logEpoch);
    const sessionId = parseConversationTopic(this.topic);
    const initialBeforeRowId = snapshot.rows.window[0]?.rowId;
    if (!sessionId || initialBeforeRowId === undefined) return stale(snapshot.logEpoch);

    const initialLogEpoch = snapshot.logEpoch;
    const preserveIncompleteLeadingTurn = shouldAutoLoadIncompleteLeadingTurn(snapshot, false);
    const pages: ConversationRow[][] = [];
    let beforeRowId = initialBeforeRowId;
    let committed = false;
    this.setState({ loadingOlder: true });
    logger.debug("[v4-store] full question directory backfill of history rows started", {
      beforeRowId,
      loadedRows: snapshot.rows.window.length,
      sessionId,
      totalRows: snapshot.rows.totalCount,
    });

    try {
      while (true) {
        const result = await this.transport.rowsRange({
          sessionId,
          beforeRowId,
          limit: PROTOCOL_V4_LIMITS.rowsRangeMaxLimit,
        });
        if (this.closed) return stale(initialLogEpoch);
        const current = this.state.snapshot;
        if (
          !current ||
          result.atLogEpoch !== initialLogEpoch ||
          current.logEpoch !== initialLogEpoch ||
          current.rows.window[0]?.rowId !== initialBeforeRowId
        ) {
          logger.warn(
            "[v4-store] full question directory projection cursor invalidated during backfill; dropping the batch",
            {
              currentBeforeRowId: current?.rows.window[0]?.rowId,
              expectedBeforeRowId: initialBeforeRowId,
              resultLogEpoch: result.atLogEpoch,
              sessionId,
            },
          );
          return stale(initialLogEpoch);
        }

        const older = result.rows.filter((row) => row.rowId < beforeRowId);
        const nextBeforeRowId = older[0]?.rowId;
        if (nextBeforeRowId === undefined || nextBeforeRowId >= beforeRowId) {
          logger.warn(
            "[v4-store] full question directory rows/range made no cursor progress; stopping backfill",
            {
              beforeRowId,
              hasMore: result.hasMore,
              sessionId,
            },
          );
          return { status: "retryable-failure", logEpoch: initialLogEpoch };
        }
        pages.push(older);
        beforeRowId = nextBeforeRowId;
        if (!result.hasMore) break;
      }

      const current = this.state.snapshot;
      if (
        !current ||
        current.logEpoch !== initialLogEpoch ||
        current.rows.window[0]?.rowId !== initialBeforeRowId
      ) {
        return stale(initialLogEpoch);
      }
      const olderRows = [...pages].reverse().flat();
      const realUserQueryCount = [...olderRows, ...current.rows.window].reduce(
        (count, row) => (row.kind === "userInput" && row.origin === "realUser" ? count + 1 : count),
        0,
      );
      if (realUserQueryCount < 2) {
        if (preserveIncompleteLeadingTurn) {
          const window = mergeOlderRows(current.rows.window, olderRows);
          if (window === null) return stale(initialLogEpoch);
          committed = true;
          this.setState({
            loadingOlder: false,
            snapshot: { ...current, rows: { ...current.rows, window } },
          });
          // The navigator already holds the authoritative rows needed to complete the first
          // round; they must be committed before the rail is hidden.
          logger.debug(
            "[v4-store] full question directory has fewer than two queries; keeping first-round backfill rows",
            {
              loadedRows: window.length,
              pages: pages.length,
              sessionId,
            },
          );
        }
        // The wire snapshot keeps only the last 60 rows, so 0/1 queries in the tail do not
        // prove the full branch is single-query too. Wide layouts must probe back to the
        // branch origin; once confirmed under two queries, stop merging probe pages to avoid
        // pinning full history in the renderer projection for a rail that will not render.
        logger.debug("[v4-store] full question directory still under two queries after probing", {
          pages: pages.length,
          preservedIncompleteLeadingTurn: preserveIncompleteLeadingTurn,
          realUserQueryCount,
          sessionId,
        });
        const result = {
          status: "not-enough-queries" as const,
          logEpoch: initialLogEpoch,
          directoryRevision,
        };
        this.turnNavigatorHydrationTerminal = result;
        return result;
      }
      const window = mergeOlderRows(current.rows.window, olderRows);
      if (window === null) return stale(initialLogEpoch);
      committed = true;
      this.setState({
        loadingOlder: false,
        snapshot: { ...current, rows: { ...current.rows, window } },
      });
      logger.debug("[v4-store] full question directory history backfill complete", {
        loadedRows: window.length,
        pages: pages.length,
        sessionId,
      });
      const result = {
        status: "hydrated" as const,
        logEpoch: initialLogEpoch,
        directoryRevision,
      };
      this.turnNavigatorHydrationTerminal = result;
      return result;
    } catch (error) {
      logger.warn(
        `[v4-store] full question directory rowsRange ${this.topic} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { status: "retryable-failure", logEpoch: initialLogEpoch };
    } finally {
      if (!this.closed && !committed) this.setState({ loadingOlder: false });
    }
  }

  /**
   * Merge concurrent plan-directory queries under the local invalidation revision.
   * Old plans may predate the snapshot tail, and row.removed from edit/retry can expire an
   * in-flight query instantly; validate on both revision and epoch so stale branch plans are
   * never written back into the UI.
   */
  async refreshPlans(): Promise<void> {
    if (this.closed) return;
    if (this.planQueryInFlight) {
      this.planQueryPending = true;
      return;
    }
    const snapshot = this.state.snapshot;
    const sessionId = parseConversationTopic(this.topic);
    if (!snapshot || !sessionId) return;
    const requestedGeneration = this.generation;
    const requestedRevision = this.state.planDirectoryRevision;
    this.planQueryInFlight = true;
    this.setState({ plansLoading: true });
    try {
      const result = await this.transport.plans({ sessionId });
      if (this.closed) return;
      if (this.generation !== requestedGeneration) return;
      const current = this.state.snapshot;
      if (!current || current.logEpoch !== result.atLogEpoch) {
        return;
      }
      if (this.state.planDirectoryRevision !== requestedRevision) {
        this.planQueryPending = true;
        return;
      }
      this.setState({ sessionPlans: result.plans });
    } catch (error) {
      if (!this.closed) {
        logger.warn(
          `[v4-store] plans ${this.topic} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      this.planQueryInFlight = false;
      if (!this.closed) this.setState({ plansLoading: false });
      if (this.planQueryPending && !this.closed) {
        this.planQueryPending = false;
        void this.refreshPlans();
      }
    }
  }

  /** Registers the overlay before the command is sent (for pending/stopping display). */
  markCommandPending(command: OptimisticCommand): void {
    if (this.closed) return;
    this.setState({
      optimisticCommands: [...this.state.optimisticCommands, command],
    });
  }

  /**
   * After an accepted/duplicate ACK, register input commands that must become visible in the
   * authoritative projection.
   *
   * The command RPC and the conversation topic are independent channels; a gap is only
   * discovered once a later delta arrives, and if the topic stays fully silent after the ACK,
   * the CLI keeps working while the UI never sees the user row. This forges no messages:
   * after a bounded window it reuses the existing same-sub recovery; the watchdog closes as
   * soon as a queue/user row appears in the authoritative projection.
   */
  expectAcceptedInputProjection(commandId: string): void {
    if (this.closed || this.acceptedInputProjectionTimers.has(commandId)) return;
    const command = this.state.optimisticCommands.find((item) => item.commandId === commandId);
    if (!command || !ACCEPTED_INPUT_COMMAND_TYPES.has(command.type)) return;
    if (hasAcceptedInputProjection(this.state.snapshot, commandId)) {
      this.settleCommand(commandId);
      return;
    }
    const timer = setTimeout(() => {
      this.acceptedInputProjectionTimers.delete(commandId);
      if (
        this.closed ||
        !this.state.optimisticCommands.some((item) => item.commandId === commandId)
      ) {
        return;
      }
      if (hasAcceptedInputProjection(this.state.snapshot, commandId)) {
        this.settleCommand(commandId);
        return;
      }
      logger.warn("[v4-store] accepted input projection silent, trigger same-sub recovery", {
        commandId,
        topic: this.topic,
      });
      this.requestRecovery();
    }, ACCEPTED_INPUT_PROJECTION_GRACE_MS);
    this.acceptedInputProjectionTimers.set(commandId, timer);
  }

  private clearAcceptedInputProjectionWatch(commandId: string): void {
    const timer = this.acceptedInputProjectionTimers.get(commandId);
    if (timer !== undefined) clearTimeout(timer);
    this.acceptedInputProjectionTimers.delete(commandId);
  }

  /** Removes the overlay when the command settles locally (rejected/failed/etc.). */
  settleCommand(commandId: string): void {
    this.clearAcceptedInputProjectionWatch(commandId);
    const remaining = this.state.optimisticCommands.filter(
      (command) => command.commandId !== commandId,
    );
    if (remaining.length !== this.state.optimisticCommands.length) {
      this.setState({ optimisticCommands: remaining });
    }
  }

  // Once the server projection shows the same commandId (pendingCommands / userInput.sourceCommandId anchors), the authoritative side has taken over display and the overlay entry retires.
  private reconcileOptimistic(snapshot: ConversationSnapshot): void {
    if (this.state.optimisticCommands.length === 0) return;
    const acknowledged = new Set<string>(
      snapshot.pendingCommands.map((command) => command.commandId),
    );
    const inputProjectionIds = new Set<string>();
    for (const item of snapshot.queue.items) {
      inputProjectionIds.add(item.sourceCommandId);
    }
    for (const row of snapshot.rows.window) {
      if (row.kind === "userInput" && row.sourceCommandId) {
        acknowledged.add(row.sourceCommandId);
        if (row.origin === "realUser") inputProjectionIds.add(row.sourceCommandId);
      }
    }
    const remaining = this.state.optimisticCommands.filter((command) =>
      ACCEPTED_INPUT_COMMAND_TYPES.has(command.type)
        ? !inputProjectionIds.has(command.commandId)
        : !acknowledged.has(command.commandId),
    );
    if (remaining.length !== this.state.optimisticCommands.length) {
      this.setState({ optimisticCommands: remaining });
    }
  }

  private reconcileAcceptedInputProjection(snapshot: ConversationSnapshot): void {
    for (const commandId of this.acceptedInputProjectionTimers.keys()) {
      if (!hasAcceptedInputProjection(snapshot, commandId)) continue;
      this.clearAcceptedInputProjectionWatch(commandId);
      this.settleCommand(commandId);
    }
  }

  /** Memory diagnostics: current rows.window length; read-only. */
  countProjectionRows(): number {
    return this.state.snapshot?.rows.window.length ?? 0;
  }

  /** Unsubscribes and terminates this store (called only by SessionDataLayer). */
  async close(): Promise<void> {
    if (this.closed) return;
    liveProjectionStores.delete(this);
    const closeStartedAt = monotonicNow();
    logger.lifecycle.info("v4 conversation store close started", {
      event: "v4.conversation.store.close.started",
      generation: this.generation,
      module: "ui.v4.conversation_projection_store",
      status: "started",
      subscriptionId: this.state.subscriptionId,
      topic: this.topic,
    });
    this.closed = true;
    this.offAssemblyFault();
    this.offRuntimeRestart?.();
    this.offRuntimeLifecycle?.();
    this.clearRuntimeRecycleRetry();
    for (const timer of this.acceptedInputProjectionTimers.values()) clearTimeout(timer);
    this.acceptedInputProjectionTimers.clear();
    this.modelTransitionListeners.clear();
    this.discardRecovery();
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.generation++;
    const { subscriptionId } = this.state;
    this.setState({ status: "closed", subscriptionId: null });
    if (subscriptionId) {
      try {
        await this.transport.unsubscribe(subscriptionId);
      } catch (error) {
        logger.lifecycle.warn("v4 conversation store close unsubscribe failed", {
          durationMs: roundedDuration(closeStartedAt, monotonicNow()),
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "v4.conversation.store.close.unsubscribe_failed",
          module: "ui.v4.conversation_projection_store",
          status: "failed",
          subscriptionId,
          topic: this.topic,
        });
        logger.warn(`[v4-store] unsubscribe ${this.topic} failed (ignored): ${String(error)}`);
      }
    }
    logger.lifecycle.info("v4 conversation store close completed", {
      durationMs: roundedDuration(closeStartedAt, monotonicNow()),
      event: "v4.conversation.store.close.completed",
      module: "ui.v4.conversation_projection_store",
      status: "completed",
      topic: this.topic,
    });
  }
}
