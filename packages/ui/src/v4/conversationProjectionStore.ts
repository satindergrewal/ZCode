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
  type ConversationDelta,
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
import { ConversationRowPool } from "@/v4/conversationRowSharing.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

/**
 * Backoff schedule for subscribes interrupted by a runtime generation change.
 *
 * CUA Helper cold-start readiness runs recycleUntilStable -> disposeWorkspace to recycle the agent
 * runtime, and in-flight subscribes get interrupted by rejectAll. Freezing that transient failure as status="error"
 * risks a lazy-started agent that nobody restarts after dispose: onRuntimeRestart never arrives and the panel depends on the user
 * clicking Reconnect. subscribeConversationV4 is start-if-needed -- resubscribing itself starts the runtime,
 * so bounded backoff here follows the established sessionsIndexStore pattern.
 */
const RUNTIME_RECYCLE_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;

/**
 * Grace period for the authoritative input projection after an accepted ACK.
 *
 * The Core admission ACK does not wait for the TurnStarted/QueueItem/userInput projections; normally the two paths
 * differ by one renderer/network round-trip. A 2s window absorbs normal desktop/mobile
 * latency while still self-healing fast from a half-open channel (CLI working, subscription silent). The timeout recovers the subscription only; no command replay.
 */
export const ACCEPTED_INPUT_PROJECTION_GRACE_MS = 2_000;
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
 * All three copies come from the same recycle: transport close has ZCodeProtocolClient.rejectAll interrupt in-flight requests
 * (transport closed), reusing a recycled client early-returns in assertNotDisposed (client disposed), and
 * fail-fast while the runtime is not yet restarted (runtime is not running).
 */
function isRuntimeRecycleError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    // A cold subscribe may start the runtime itself; once a restart invalidates in-flight ACKs, keep bounded resubscribing -- never park in error.
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
   * Invalidation generation for the question-navigator directory.
   * The not-enough-queries terminal state used to validate on logEpoch alone, but
   * "are there >=2 navigable queries" is a derived condition that moves with deltas, while logEpoch is a log generation, not
   * content quiescence. real-user query add/remove (row.appended/row.upserted hitting a realUser userInput,
   * or the row.removed truncation branch) and full snapshot replacement bump this revision, invalidating the terminal cache.
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
  // The interaction bug roots in subscription snapshot handoff, not the React DOM; log a light identity/watermark
  // only when the agent running-set changes, so a local repro can tell a legit terminal state from a late snapshot overwrite.
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
 * Older history exists iff the window's first row is not the total-order first row (firstRowId check).
 * Pure helper shared by store/components; missing snapshot/empty window/unknown firstRowId all return false.
 */
export function hasOlderRows(snapshot: ConversationSnapshot | null): boolean {
  if (!snapshot) return false;
  const first = snapshot.rows.window[0];
  if (!first || snapshot.rows.firstRowId === null) return false;
  return first.rowId > snapshot.rows.firstRowId;
}

/**
 * Whether the cold snapshot's tail window is cut mid-turn. turnHeader is the authoritative start of a full turn; the first row may
 * be a lightBoundary, so the first row's kind alone is not enough -- check whether the first turn already has a header within this window.
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
export function mergeOlderRows(
  window: readonly ConversationRow[],
  fetched: readonly ConversationRow[],
): ConversationRow[] | null {
  const firstRowId = window[0]?.rowId ?? Number.POSITIVE_INFINITY;
  const older = fetched.filter((row) => row.rowId < firstRowId);
  if (older.length === 0) return null;
  return [...older, ...window];
}

/**
 * External store (useSyncExternalStore-compatible: subscribe + getState return stable references).
 * Lifecycle is owned by SessionDataLayer (refcount + keep-warm); components never construct it directly.
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
  /** Side-channel listener for live-only deltas (plugin resource notices); fires only after delta frames, never on snapshot frames. */
  private readonly liveDeltaListeners = new Set<(deltas: readonly ConversationDelta[]) => void>();
  private observedModelTransitionEventId: string | null = null;
  // Subscription generation: concurrent connects honor only the newest; stale results unsubscribe at once so no server-side sub hangs.
  private generation = 0;
  // Before the first subscribe ACK, runtime available is just the normal completion signal of the current start flow;
  // track the in-flight count so lifecycle notices do not start another connect and race same-topic subscription replacement.
  private connectInFlight = 0;
  /**
   * The subscribe ACK mode persists until this generation's first logical frame; the synchronous activate stack alone is not enough,
   * because a notification may land asynchronously after the ACK promise resolves.
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
  // The hydrated/not-enough-queries terminal cache used to validate on
  // logEpoch alone, so real-user queries appended within an epoch hit forever. The
  // directoryRevision now participates: real-user add/remove bumps it, invalidating the terminal state for a re-probe.
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
    // Row structural-sharing pool (docs/performance/conversation-row-structural-sharing.md);
    // SessionDataLayer injectes the cross-store pool; standalone construction degrades to within-store sharing.
    private readonly rowPool: ConversationRowPool = new ConversationRowPool(),
  ) {
    liveProjectionStores.add(this);
    this.offAssemblyFault = transport.onAssemblyFault((fault) => {
      if (fault.topic === this.topic) {
        this.handleAssemblyFault(fault.subscriptionId, fault.deliveryKind, fault.reasonCode);
      }
    });
    // A runtime generation change (new CLI process) follows the sessionsIndexStore convention: lifecycle first. At dispose
    // only unavailable is observable, and onRuntimeRestart waits for the new process spawn -- possibly never, when lazy-started.
    if (transport.onRuntimeLifecycle) {
      this.offRuntimeLifecycle = transport.onRuntimeLifecycle((state) => {
        if (state === "available") this.handleRuntimeAvailable();
        else this.handleRuntimeUnavailable();
      });
      // A proxy handoff is not a runtime generation change; only the restart channel carries that semantics --
      // ReplaceableConversationTransport.replace() only broadcasts runtimeRestartListeners and emits no
      // lifecycle events. If this path abandoned the restart channel in an either/or choice, a remote workspace's proxy handover
      // would go unhandled: replace() best-effort unsubscribes the old proxy while the store stays live on the stale
      // subscriptionId -- the frame stream dies silently with no self-healing.
      // Honoring only transportReplaced keeps the two paths disjoint: a runtime restart forwarded via bindRuntimeRestartListener
      // invokes listener() with no reason and is already owned by the lifecycle available path.
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

  /**
   * Deltas applied by subscription frames so far. For the live-only `pluginUi.*` deltas (no row changes, never in snapshots);
   * regular row state still comes from subscribe + getState.
   */
  onLiveDeltas(listener: (deltas: readonly ConversationDelta[]) => void): () => void {
    this.liveDeltaListeners.add(listener);
    return () => this.liveDeltaListeners.delete(listener);
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
   * Start/resend the subscription. base comes from the current snapshot watermark (invariant: carry it only when a consistent
   * state at that point is actually held); forceSnapshot is the fallback when resume frames still gap -- drop base, go full.
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
      // Root cause of the production fault.subscription.notOwned stalls: connect() discards recovery only at start, so during the
      // subscribe-ACK await window an old subscription can still create a same-sub recovery;
      // meanwhile the host scope silently evicts the old subscription by ownershipKey at remember(), so that recovery's
      // in-flight resync is doomed to a notOwned rejection. Drop the old recovery once the generation change lands -- the new sub's initial
      // atomically replaces the whole projection, making the old recovery moot; its late failure would otherwise flag the live new sub as error.
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
      // The subscriptionId must enter the store first so activate can synchronously release the own-initial staged in the same read.
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
        // Before the ACK the physical batch is already broken and no active same-sub exists; the only option is a fresh
        // subscribe forcing a snapshot. Auto-recover once at most, so a broken peer cannot cause a retry storm.
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
          `[v4-store] subscribe ${this.topic} interrupted by a runtime generation change; backing off: ${message}`,
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
   * Bounded-backoff reconnect. The resubscribe goes start-if-needed (zcodeAgentService.subscribeConversationV4),
   * which itself starts a lazy runtime -- the only self-healing path when available never arrives.
   * Returns true once taken over; the caller must not then settle into error.
   */
  private scheduleRuntimeRecycleReconnect(generation: number): boolean {
    if (this.closed) return false;
    const delayMs = RUNTIME_RECYCLE_RETRY_DELAYS_MS[this.runtimeRecycleRetryAttempt];
    if (delayMs === undefined) return false;
    this.runtimeRecycleRetryAttempt += 1;
    this.clearRuntimeRecycleRetry();
    // Keep the old snapshot: the projection is unpolluted during the handover, and a successful reconnect replaces it atomically.
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
    // Do not just wait dormant for available: the agent is lazy-started, and after a dispose with nobody restarting the signal never comes
    // and the panel spins forever. The backoff reconnect starts the runtime itself; if available lands first, reset the count and reconnect at once.
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
      // A cold-start spawn broadcasts available before the first
      // subscribe ACK returns. An immediate reconnect here makes the server replace the old subscription on the same connection/topic;
      // the stale ACK is then unsubscribed by the local generation guard, the first-frame handover races, and the panel can be left without a snapshot forever.
      // The in-flight connect already owns this start; do not resubscribe redundantly.
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
    // RPC ordering cannot prove a frame's purpose. Only a publisher-marked initial may consume
    // awaitingInitial, and recovery must clear it first so a recovery gap is not misread as an
    // original subscribe gap and mint a new subId. Late online duplicates consume no gates.
    const initial = deliveryKind === "initial" ? awaitingInitial : null;
    if (initial || (deliveryKind === "recovery" && awaitingInitial)) {
      this.awaitingInitial = null;
    }
    if (deliveryKind === "online" && this.recovery && frame.payload.kind === "snapshot") {
      // An online overflow snapshot is complete authoritative state and may seed the applied base, but it does not pose
      // as recovery delivery -- the flight still waits for its own recovery frame/ACK to settle.
      this.applyFrame(frame, { subscribeMode: null, recovery: false, online: true });
      return;
    }
    if (deliveryKind === "online" && this.recovery) {
      // An online after the recovery reservation can arrive in the same read as the ACK; once the recovery
      // logical frame is applied, a non-duplicate online means the ACK settlement must open a successor flight.
      if (frame.toSeq > (this.state.snapshot?.seq ?? 0)) {
        this.recovery.postRecoveryGapPending ||= this.recovery.validFrameSeen;
      }
      return;
    }
    if (frame.payload.kind === "deltas" && !this.subscriptionHasAppliedBase) {
      // An ACK(snapshot) is not an applied base; after a lost initial, even a numerically matching fromSeq
      // against the old projection must not stitch new-epoch deltas onto stale state.
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
      const snapshot = this.shareSnapshotRows(frame.payload.snapshot);
      logSubagentProjectionTransition(this.topic, this.state.snapshot, snapshot, "snapshot");
      // Rule 1: full replacement -- drop everything for the new state (row objects reuse old references by value; the semantics remain full replacement).
      this.setState({
        snapshot,
        planDirectoryRevision: this.state.planDirectoryRevision + 1,
        // A full snapshot replacement may have changed the real-user query set; the terminal cache must expire.
        turnNavigatorDirectoryRevision: this.state.turnNavigatorDirectoryRevision + 1,
      });
      this.subscriptionHasAppliedBase = true;
      this.reconcileOptimistic(snapshot);
      this.reconcileAcceptedInputProjection(snapshot);
      // Cause: when the initial is lost, the publisher allows a full online snapshot to seed the first
      // applied base; its persistent transitions may predate this subscription and must not pose as live new events.
      // The first frame only seeds the observation baseline; later online transitions notify the pane.
      this.observeModelTransition(snapshot, context.online && hadAppliedBase);
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
      // Rule 2: never guess across gaps. The state is still the consistent projection at seq=current.seq (this frame did not touch it),
      // so the base stays valid -- resubscribe and let the server rule resume vs full; if the gap is on the subscribe's
      // resume frames (already adjudicated once, still disconnected), drop the base and force a snapshot to break the loop.
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
    // seq is the snapshot-alignment watermark (R-03); after a delta frame applies, advance to the frame's right endpoint.
    const next = this.shareDeltaRows({ ...applied, seq: frame.toSeq }, frame.payload.deltas);
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
      // row.removed gives the authoritative trim boundary, so stale branch plans leave the cached directory in the same pass;
      // the full-directory query still refills earlier plans beyond the wire tail that belong to the current branch.
      ...(removedFromRowId === null
        ? {}
        : {
            sessionPlans: this.state.sessionPlans.filter((row) => row.rowId < removedFromRowId),
          }),
      ...(shouldInvalidatePlanDirectory(frame)
        ? { planDirectoryRevision: this.state.planDirectoryRevision + 1 }
        : {}),
      // real-user query add/remove (row.appended/row.upserted hitting a realUser userInput,
      // or the row.removed truncation branch) bumps the navigator directory revision, invalidating the terminal cache for a re-probe.
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
    for (const listener of this.liveDeltaListeners) listener(frame.payload.deltas);
  }

  /**
   * Cause: every snapshot deserializes fresh row objects, and closures pinning historical snapshots keep one large-string set each
   * (hundreds of copies of the same inputText). Re-point value-equal rows/sub-values to the pooled references.
   */
  /** Rows fetched via rows/range share with pooled elders still alive (common when scrolling up after a cold open). */
  private shareRows(rows: readonly ConversationRow[]): ConversationRow[] {
    return rows.map((row) => this.rowPool.shareRow(this.topic, row));
  }

  private shareSnapshotRows(snapshot: ConversationSnapshot): ConversationSnapshot {
    const window = this.rowPool.shareWindow(
      this.topic,
      snapshot.rows.window,
      this.state.snapshot?.rows.window,
    );
    return window === snapshot.rows.window
      ? snapshot
      : { ...snapshot, rows: { ...snapshot.rows, window } };
  }

  /** Share rows from row.upserted/row.appended; row.delta only registers, avoiding per-frame deep compares while streaming. */
  private shareDeltaRows(
    snapshot: ConversationSnapshot,
    deltas: readonly ConversationDelta[],
  ): ConversationSnapshot {
    const shareIds = new Set<number>();
    const rememberIds = new Set<number>();
    for (const delta of deltas) {
      if (delta.op === "row.upserted" || delta.op === "row.appended") shareIds.add(delta.row.rowId);
      else if (delta.op === "row.delta") rememberIds.add(delta.rowId);
    }
    if (shareIds.size === 0 && rememberIds.size === 0) return snapshot;
    let window: ConversationRow[] | null = null;
    snapshot.rows.window.forEach((row, index) => {
      if (shareIds.has(row.rowId)) {
        const shared = this.rowPool.shareRow(this.topic, row);
        if (shared !== row) {
          window ??= [...snapshot.rows.window];
          window[index] = shared;
        }
      } else if (rememberIds.has(row.rowId)) {
        this.rowPool.remember(this.topic, row);
      }
    });
    return window === null ? snapshot : { ...snapshot, rows: { ...snapshot.rows, window } };
  }

  private observeModelTransition(snapshot: ConversationSnapshot, online: boolean): void {
    const transition = snapshot.modelTransition;
    const eventId = transition?.eventId ?? null;
    if (eventId === this.observedModelTransitionEventId) return;
    // Persistent transitions replay with initial/recovery snapshots; recording the ID only at toast time lets later plain online
    // snapshots mistake the old fallback for a new event. Every legit frame updates the observation baseline;
    // only the first live online transition notifies this client.
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
    // A content-deterministic failure skips the transient ladder (04-sync closed rule 11): resume redelivers the same deltas
    // and gets rejected again; the deliveryKind does not change the verdict -- this client cannot read that content. The only bytes that could differ come from a
    // forced snapshot -- jump straight there and stop if it too is content-rejected, instead of burning the sub on doomed retries.
    if (isDeterministicContentFault(reasonCode)) {
      this.requestRecovery(true, { contentFault: true });
      return;
    }
    // A missing/forged deliveryKind arrives as an undefined typed fault; if a recovery is in flight it
    // must fail closed/escalate -- never treat the broken recovery as a plain burst and wait forever.
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
      // Once this flight has seen a content failure the terminal state is content failure: later transient faults must not whitewash it.
      if (contentFault) existing.contentFault = true;
      if (!recoveryEvent) return;
      if (existing.forceSnapshot) {
        this.failRecovery("fault.subscription.recoveryFailed");
        return;
      }
      // A recovery logical/fault can land before the ACK promise continuation; remember the escalation intent and
      // force the snapshot as soon as ACK=resume. A plain burst gap never sets this flag.
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
    // Content failures skip the resume rung and force a snapshot; transient failures still try resume first per the ladder.
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
          // Production event: notOwned means some layer no longer honors this subscription
          // ownership (a scope handover's silent eviction, a misplaced unsubscribe, etc.) -- a deterministic invalidation,
          // not a transient fault; parking in error pending a manual reconnect wedges the session. The local snapshot is still a consistent
          // projection -- a fresh subscribe carrying the current watermark lets the server rule resume/snapshot (04-sync rule 3)
          // and completes the heal. Special-case notOwned only, so transient errors cannot storm reconnects.
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
   * contentEligible: false is for **timeout** terminals: a deadline expiring with no recovery frame is a transport symptom, so even a
   * content-born flight must not be rebranded contentRejected -- that would cancel a still-meaningful retry.
   */
  private failRecovery(reasonCode: string, options: { contentEligible?: boolean } = {}): void {
    if (!this.recovery) return;
    // Content-deterministic and transport failures must stay distinguishable: a reconnect does not fix the former, and telemetry aggregated by code
    // must not read a version mismatch as a network blip (reasonCode vocabulary in wire-fault.ts).
    const contentFault = this.recovery.contentFault && options.contentEligible !== false;
    const code = contentFault ? SUBSCRIPTION_CONTENT_REJECTED : reasonCode;
    this.discardRecovery();
    logger.warn(`[v4-store] ${this.topic} recovery fail-closed: ${code}`);
    this.setState({ status: "error", lastError: code });
  }

  private handleRuntimeRestart(reason?: "runtimeRestart" | "transportReplaced"): void {
    if (this.closed) return;
    // The transport already invalidated the old ownership/assembler; never unsubscribe with the old transport/runtime subId --
    // fresh-subscribe directly and keep the old snapshot until the new one replaces it atomically.
    this.generation += 1;
    this.discardRecovery();
    this.awaitingInitial = null;
    this.subscriptionHasAppliedBase = false;
    this.setState({ status: "connecting", subscriptionId: null });
    // A proxy handoff is not a CLI runtime restart; forcing a snapshot would swap the user's already-loaded
    // older rows back into the tail window. The handoff keeps the consistent projection watermark and lets the server rule
    // resume vs snapshot by logEpoch/seq; a real runtime restart still does a full subscribe.
    if (reason === "transportReplaced") void this.connect();
    else void this.connect({ forceSnapshot: true });
  }

  /**
   * loadOlder: uses the window's first row as the cursor to fetch one window of history and prepend it.
   * - Single-flight: repeat calls while in flight are no-ops (loadingOlder reentry guard);
   * - Stale-read guard: results with atLogEpoch != the current snapshot epoch are dropped wholesale (across CLI restarts);
   * - Merges keyed on rowId, consistent with the stream's row.upserted/removed;
   *   delta frames landing mid-flight are unaffected (they only touch rows >= the window head).
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
      // A cursor invalidated mid-flight (row.removed trim / full snapshot resync) voids the result
      // so history rows already removed upstream are not resurrected; the next trigger refetches per the new window.
      if (current.rows.window[0]?.rowId !== beforeRowId) return;
      const window = mergeOlderRows(current.rows.window, this.shareRows(result.rows));
      if (window === null) return;
      this.setState({
        snapshot: { ...current, rows: { ...current.rows, window } },
      });
    } catch (error) {
      // The query is read-only and re-sendable: failures never enter the error state; the next trigger retries.
      logger.warn(
        `[v4-store] rowsRange ${this.topic} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (!this.closed) this.setState({ loadingOlder: false });
    }
  }

  /**
   * Full question directory: walk the existing rows/range cursor to complete the current active branch in one pass.
   *
   * Question navigation used to scan the renderer tail window, so a 1000-turn session showed only the few loaded
   * dozens. This pages up to the protocol cap but swaps the snapshot once after all pages succeed,
   * instead of rebuilding the timeline render units and two virtualizers every 200 rows.
   */
  async loadAllOlder(): Promise<ConversationTurnNavigatorHydrationResult> {
    const stale = (logEpoch = this.state.snapshot?.logEpoch ?? "unknown") => ({
      status: "stale" as const,
      logEpoch,
    });
    if (this.closed || this.state.loadingOlder) return stale();
    const snapshot = this.state.snapshot;
    if (!snapshot) return stale();
    // The terminal state must match both logEpoch and directoryRevision. logEpoch is a log generation,
    // not content quiescence -- real-user add/remove bumps the revision and re-opens probing.
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
            "[v4-store] full question directory backfill hit a stale projection cursor; dropping the batch",
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
          const window = mergeOlderRows(current.rows.window, this.shareRows(olderRows));
          if (window === null) return stale(initialLogEpoch);
          committed = true;
          this.setState({
            loadingOlder: false,
            snapshot: { ...current, rows: { ...current.rows, window } },
          });
          // The navigator already holds the authoritative rows the first turn needs; commit them before hiding the rail.
          logger.debug(
            "[v4-store] full question directory has under two queries; keeping the first-turn completion rows",
            {
              loadedRows: window.length,
              pages: pages.length,
              sessionId,
            },
          );
        }
        // The wire snapshot keeps only the last 60 rows, so 0-1 queries in the tail cannot prove
        // the full branch is single-query too. Wide viewports must probe to the branch root; once under-two is confirmed, do not merge probe pages --
        // no reason to pin full history in the renderer projection for a rail that will not render.
        logger.debug("[v4-store] full question directory probed under two queries", {
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
      const window = mergeOlderRows(current.rows.window, this.shareRows(olderRows));
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
   * Merge concurrent plan-directory queries by the local invalidation revision.
   * Stale plans may predate the snapshot tail, and an edit/retry row.removed can invalidate an in-flight
   * query instantly -- validate on revision + epoch together; never write stale branch plans back into the UI.
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
   * After an accepted/duplicate ACK, register the input command as must-appear-in-authoritative-projection.
   *
   * The command RPC and the conversation topic are separate channels; only a later
   * delta reveals a gap. If the topic goes silent after the ACK, the CLI works on while the UI never sees the user row.
   * No message forging: after a bounded window, reuse the existing same-sub recovery; once the authoritative projection shows the
   * queue/user row, the watchdog settles at once.
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
