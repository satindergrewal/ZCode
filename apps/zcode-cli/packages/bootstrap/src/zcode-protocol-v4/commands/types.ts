// The v4 native command layer's core-capability contract (native remake).
//
// Layering discipline (no bridging):
// - this directory is the commands' native implementation: decision logic (steer split / draft promotion / abort lifecycle /
//   goal-pause barrier) drives core (ZCodeApp / runtime) directly, never through legacy protocol ops.
// - the session registry stays with the host: V4CommandCoreHost receives the legacy
//   ZCodeProtocolSessionRecord as a structured narrow view (same object reference, field changes visible both ways, no second registry).
// - environment capabilities (model readiness / legacy broadcast / shell parsing) are injected hooks: during the transition the legacy binder
//   provides them, lifetime like the legacy protocol — every hook notes its transition owner; new hooks must too.
import type {
  SessionTaskType,
  StableForkGoalBoundaryMetadata,
  TraceContext,
} from "@zcode/contracts";
import type { DynamicWorkflowMode, ZCodeAutomationBotDeliveryTarget } from "@zcode/shared";
import type {
  CommandAck,
  CommandEnvelope,
  CommandPayloadMap,
  ConversationInputIntent,
  QueueItem,
  StableForkTarget,
  StableForkTargetResolution,
  ConversationRowTarget,
} from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeApp } from "../../app/types.js";
import type { V4InteractionRegistry } from "../interaction-registry.js";
import type {
  ConversationEditTarget,
  ConversationRowTargetAction,
  ConversationRowTargetResolution,
} from "../product-projection.js";

/** Minimal log surface (structured fields straight to the host logger). */
export interface V4CommandLogger {
  info?(message: string, fields?: Record<string, unknown>): void;
  warn?(message: string, fields?: Record<string, unknown>): void;
}

export type V4QueueItemCommand = QueueItem;

/**
 * A queue item's single-turn execution material (protocol shape). The speed-up card's Selection already went to the
 // projection via QueueItem.modelSelection; only the non-projectable dynamic credentials stage here, frozen into ModelExecutionContext at promotion.
 */
export type V4QueuedTurnExecution = NonNullable<CommandPayloadMap["sendText"]["modelExecution"]>;

export type V4StableForkTargetResolution =
  | {
      ok: true;
      target: StableForkTarget;
      goalBoundary: StableForkGoalBoundaryMetadata;
    }
  | Extract<StableForkTargetResolution, { ok: false }>;

/**
 * Structured narrow view of the legacy ZCodeProtocolSessionRecord (only the fields the command layer needs).
 // Shape-compatible: the binder passes the legacy record object straight through; once v4 owns the session registry it supplies the same shape.
 */
export interface V4SessionRecordView {
  app: ZCodeApp;
  /**
   * Session-root traceContext (traceId above sessionId, spanning the task chain).
   * Reused verbatim when the command layer calls runtime methods / re-emits core events; never fork a trace
   * midway. The legacy record carries it; the narrow view passes it through.
   */
  traceContext: TraceContext;
  workspace: { workspacePath: string };
  /** Draft semantics: deferred = no first message sent, not in sqlite; promoted to immediate on first send. */
  persistence: "immediate" | "deferred";
  /** Active-turn lock: present = a turn is running (sendText steers, stop has a target). */
  activeAbortController?: AbortController;
  /** Refcount for post-ready-lock release still using the record/runtime during state-mutation finalization. */
  residencyFinalizationCount?: number;
  /** The automation-dispatch turn currently executing; exists only while a turn runs. */
  activeAutomationId?: string;
  /** The idle-dispatch turn currently executing; exists only while a turn runs. */
  activeOffPeakTaskId?: string;
  /** Stable reply address of the current Bot inbound turn; must be restored after the turn. */
  activeBotDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
  /** Restore-failure alarm: present, new turns are refused (corrupted history must not continue silently). */
  restoreWarning?: { message: string; type: string };
  taskType?: SessionTaskType;
}

export interface V4CommandCoreHost {
  /** Session lookup (same registry object reference; undefined when missing -> handler refuses). */
  getRecord(sessionId: string): V4SessionRecordView | undefined;
  logger?: V4CommandLogger;

  // ------------------------- native v4 capabilities (not transition hooks) -------------------------
  /** A queue item's full authoritative intent; sendQueuedNow must never degrade to a text-only resend. */
  getQueueItem?(sessionId: string, queueItemId: string): V4QueueItemCommand | null;
  /** Typed maintenance dedup; the test comes from the same projection queue, no side sets. */
  hasQueueItemKind?(sessionId: string, kind: QueueItem["kind"]): boolean;
  /** guide eligibility: blocks only an existing ordinary queue; an existing guide still admits via FIFO. */
  hasQueuedDelivery?(sessionId: string, delivery: "guide" | "queue"): boolean;
  getQueueLength?(sessionId: string): number;
  /** The Highspeed queue's execution material carries credentials: memory only, never into queue event/snapshot. */
  retainQueuedTurnExecution?(
    sessionId: string,
    sourceCommandId: string,
    execution: V4QueuedTurnExecution,
  ): void;
  readQueuedTurnExecution?(
    sessionId: string,
    sourceCommandId: string,
  ): V4QueuedTurnExecution | undefined;
  deleteQueuedTurnExecution?(sessionId: string, sourceCommandId: string): void;
  clearQueuedTurnExecutions?(sessionId: string): void;
  /** Persisted dedup facts for successful side effects without a user message (timeline/child). */
  recordPersistentCommandFact?(
    sessionId: string,
    source: "timeline" | "child",
    ack: CommandAck,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  /** The durable admission boundary shared by createSession.firstInput / selection side firstInput and plain send. */
  admitInputCommand?(
    envelope: CommandEnvelope,
    sessionId: string,
    admission: { admissionSeq: number; admittedAt: number; queueItemId: string },
  ): Promise<ConversationInputIntent | null>;
  cancelInputCommand?(sessionId: string, queueItemId: string, reason: string): Promise<void>;
  discardSharedContext?(sessionId: string, contextId: string): Promise<boolean>;
  /**
   * The current input-routing mode (source: the v4 projection inputRouting.mode).
   * sendText/sendGoalCommand's held-choice verdict (heldQueueInputRequiresChoice) uses it to decide whether
   * heldQueueDisposition is mandatory. No projection yet (no events) -> null (treated as not-held).
   */
  getInputRoutingMode?(
    sessionId: string,
  ): "startNow" | "enqueue" | "guide" | "reject" | "choice" | null;
  /** After the runtime event notification, wait until the target event finishes reorder drain + projection apply. */
  waitForProjectionEventCommit?(
    sessionId: string,
    eventId: string,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  /**
   * rowId -> authoritative messageId (source: the v4 projection rowId->messageId table).
   * Legacy-compat query: translate a projection rowId (assistant row) into the transcript messageId. No match
   * (non-assistant row / stale rowId) -> null -> handler rejects, never silently falling back to latestCheckpoint
   * (it would fork/rewind the wrong point).
   */
  getMessageIdForRow?(sessionId: string, rowId: number): string | null;
  /** The single row-target resolver shared by row.actions / CommandInbox / handlers. */
  resolveRowActionTarget?(
    sessionId: string,
    target: ConversationRowTarget,
    action: ConversationRowTargetAction,
  ): ConversationRowTargetResolution | null;
  /**
   * rowId -> every transcript messageId in the owning product turn (for file-summary undo).
   // Multi-segment assistant / multi-checkpoint must hand over atomically, or only the last segment's files get reverted.
   */
  getMessageIdsForTurnRow?(sessionId: string, rowId: number): string[];
  /**
   * Core-side strict check: forks attach only to a turn's final segment.
   * true=turn-tail segment; false=mid segment (reject); null=no projection/unknown (treated as translation failure).
   */
  isLatestAssistantSegmentRow?(sessionId: string, rowId: number): boolean | null;
  /** The single stable-fork resolver: projection gate plus transcript-persistent anchor/fallback. */
  resolveStableForkTarget?(sessionId: string, rowId: number): Promise<V4StableForkTargetResolution>;
  /**
   * latestAssistantRetryOnly core-side guard: retryTurn may target only the current projection's last
   * assistantText row. false/null are handler-refused, so legacy clients cannot bypass the UI.
   */
  isLatestRetryAssistantRow?(sessionId: string, rowId: number): boolean | null;
  /**
   * latestQueryEditOnly core-side guard: editUserQuery may target only the current projection's last realUser
   * userInput row. false/null are handler-refused, so legacy clients cannot bypass the UI.
   */
  isLatestEditableUserRow?(sessionId: string, rowId: number): boolean | null;
  /** rowId -> product turnId (editUserQuery's store lookup without an assistant anchor). */
  getTurnIdForRow?(sessionId: string, rowId: number): string | null;
  /**
   * restoreWarning self-heal probe: has this process's Registry published a usable model?
   * binder-implemented; host without it -> no self-heal, refusal stands.
   */
  hasUsableRuntimeModelTarget?(record: V4SessionRecordView): boolean;
  /**
   * rowId -> the owning turn's rewind anchor messageId (same source).
   * editUserQuery targets the user row (user rows have no messageId) while rewind needs one -
   * use the same turn's assistant row messageId as the anchor.
   */
  getTurnRewindAnchor?(sessionId: string, rowId: number): string | null;
  /**
   * Fallback for a running latest edit whose assistant anchor has not appeared yet:
   * after stop, look up the row's turn's real user messageId in sessionStore.
   */
  resolveUserMessageIdForRow?(sessionId: string, rowId: number): Promise<string | null>;
  /**
   * retryTurn original-prompt resolution: assistant messageId -> parentID (user message) -> text.
   * Source: core sessionStore (transcript authority), not the legacy protocol - binder implementation only
   * because the deps injection point is host-side; moves with the host once v4 owns the session registry.
   * Not found (no parent / no store) -> null -> handler truncates without resending.
   */
  resolveTurnUserPrompt?(sessionId: string, assistantMessageId: string): Promise<string | null>;
  /** Persist assistant feedback into transcript metadata first, then emit the same entity's projection event. */
  setAssistantFeedback?(
    sessionId: string,
    input: {
      entityId: string;
      messageId: string;
      feedback: "like" | "dislike" | null;
    },
  ): Promise<void>;
  /** Highspeed terminal stats update the user transcript metadata first, then publish the same entity's projection event. */
  setHighspeedMetrics?(
    sessionId: string,
    input: {
      entityId: string;
      messageId: string;
      metrics: {
        regularTps: number;
        outputTokens: number;
        durationMs: number;
        highspeedTps: number;
        savedDurationMs: number;
        modelDurationMs?: number;
        toolDurationMs?: number;
        otherDurationMs?: number;
      };
    },
  ): Promise<void>;
  /**
   * Interaction reply registry (native v4 infrastructure, not a transition hook): when interaction-broker raises
   * a reverse request (permission/AskUserQuestion) it registers the deferred; the resolveInteraction command
   * delivers answers through it. The binder injectes the broker's own instance; optional in type only for test
   * fixtures - untreated as a miss (idempotent-success close).
   */
  interactions?: V4InteractionRegistry;

  // ---------------- transition hooks (legacy compat window) ----------------
  /**
   * Model-readiness check before a turn starts (credentials/catalog resolution).
   * Currently the legacy binder's ensureSessionModelAvailableForNextTurn; destiny: replaced once core's app
   * layer owns model resolution.
   */
  ensureModelReady?(record: V4SessionRecordView): Promise<void>;
  /**
   * Validate the target Provider against the Agent process Registry before switching models. Plain model
   * commands carry a Selection only, so this cannot receive or install Host runtime snapshots.
   */
  ensureProviderAvailable?(
    sessionId: string,
    providerId: string,
  ): Promise<{ available: boolean; reason?: string }>;
  /**
   * Legacy broadcast (state.updated + record.stateRevision): legacy consumers (sidebar/task index) still sense
   * state changes through it until the sidebar migrates. v4's own projection feeds via gateway event ingest and
   * does not depend on this; retired together with the legacy broadcast.
   */
  afterLegacyStateMutation?(record: V4SessionRecordView, reason: string): Promise<void>;
  /**
   * Session close (deleteSession's execution face: unsubscribe events -> app.close -> registry removal -> gateway channel teardown).
   // Transitional shape: the session registry still belongs to the legacy protocol host, binder-inline (order aligned with the legacy closeSession op,
   // see zcode-protocol/server-operations.ts); once v4 owns the registry this becomes native.
   */
  closeSession?(sessionId: string): Promise<void>;
  /**
   * Session-record creation (createSession's execution: record creation / event wiring / model-catalog sync /
   * failure cleanup, all entangled with the legacy host). The binder implementation calls the legacy
   * createSession op; replaced by the native implementation once v4 owns the registry.
   * Semantic decisions (draft persistence / firstInput commit) stay in the native handler, not the hook.
   */
  createSessionRecord?(params: {
    workspaceId: string;
    permissionScope?: "session";
    mcpServers?: CommandPayloadMap["createSession"]["mcpServers"];
    /** Host-adjudicated Off-Peak tooling gate; absent, no tools registered. */
    offPeakToolEnabled?: boolean;
    /**
     * Host-adjudicated dynamic-workflow gate;
     * absent falls back to the process-level workspace verdict, still fail-closed.
     */
    dynamicWorkflowEnabled?: boolean;
    /** Gradation mode arriving with the boolean (launch.md "On demand: activation"); absent reads alwaysOn. */
    dynamicWorkflowMode?: DynamicWorkflowMode;
  }): Promise<{ sessionId: string }>;
  /** Create a hidden selection_side_chat child from the parent's stable persisted boundary. */
  createSelectionSideSession?(
    sessionId: string,
    options: {
      sourceCommandId: string;
      revisionAtDecision: number;
      modelSelection?: NonNullable<
        CommandPayloadMap["createSelectionSideSession"]["firstInput"]
      >["modelSelection"];
    },
  ): Promise<{ sessionId: string }>;
  /** conversation-only stable fork; never stop the parent, rewind the workspace, or copy active work/queue. */
  forkStableConversation?(
    sessionId: string,
    options: {
      target: StableForkTarget;
      goalBoundary: StableForkGoalBoundaryMetadata;
      sourceCommandId: string;
      revisionAtDecision: number;
    },
  ): Promise<{ forkedSessionId: string }>;
  /** @deprecated legacy-host shape compat only; the new editUserQuery never calls it, explicit forkAssistant unaffected. */
  forkConversationBeforeInput?(
    sessionId: string,
    options: {
      editTarget: ConversationEditTarget;
      envelope: CommandEnvelope;
      admission: { admissionSeq: number; admittedAt: number; queueItemId: string };
    },
  ): Promise<{ forkedSessionId: string }>;
  /** Runtime sync-start failed after the bundle committed: record child failure only; the parent fork ACK stays accepted. */
  recordForkStartFailure?(
    sessionId: string,
    envelope: CommandEnvelope,
    error: unknown,
  ): Promise<void>;
}
