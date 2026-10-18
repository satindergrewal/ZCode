import type { ExecutionOutputPreview } from "../interfaces/execution.port.js";
import type { RuntimeInputPresentation } from "../interfaces/runtime-input-presentation.js";
/* eslint-disable max-lines -- the session event contract lives in one file so app/agent protocol types cannot drift apart. */
// ============================================================
// Session Events - All event types for the agent loop
// ============================================================

import type {
  EventId,
  InteractionRequestOrigin,
  MessageId,
  PartId,
  QueryId,
  SessionId,
  TraceId,
  ToolCallId,
  TurnId,
} from "../interfaces/shared.js";
import type {
  CollaborationMode,
  RiskLevel,
  TurnSteerCommandKind,
  TurnSteerDeliveryMode,
  TurnSteerRejectReason,
  TurnSteerSource,
  TurnInputIntentMetadata,
} from "../interfaces/session.port.js";
import type {
  ModelNetworkStatusEvent,
  ModelSelection,
  ModelUsage,
  ModelUsageSummary,
} from "../model/index.js";
import type { HttpClientEgressInfo } from "../interfaces/http-client.port.js";
import { createModelUsageSummary } from "../model/index.js";
import type { ModelApiErrorPhase, ModelFailureExceptionKind } from "../telemetry/index.js";
import type {
  CompactBoundaryPayload,
  CompactTimelinePayload,
  MicrocompactBoundaryPayload,
} from "../compact/index.js";
import type { HookRunLifecyclePayload } from "../hooks/index.js";
import type { CheckpointCreatedPayload, RewindTriggeredPayload } from "../rewind/index.js";
import type { GoalCompletionVerificationOutput, SessionGoal } from "../tools/target.js";
import type { ToolSideEffectScope } from "../tools/contract.js";
import type { ToolResultDisplayPayload } from "../tools/tool-result-metadata.js";
import type { SkillTelemetryMetadata } from "../skills/index.js";
import type {
  MessageVisibility,
  SessionTitleSource,
  SyntheticUserMessageSource,
} from "../interfaces/session-store.port.js";
import type { SavedWorkflowScope } from "../tools/saved-workflow.js";
import type { PermissionOptionsPolicy, PermissionUpdate } from "../interfaces/permission.port.js";
import type {
  StreamRecoveryAnchorPayload,
  StreamRecoveryAnchorSelectedPayload,
  StreamRecoveryBlockedPayload,
  StreamRecoveryRetryStartedPayload,
  StreamRecoveryStartedPayload,
  StreamRecoveryTailDiscardedPayload,
  StreamingToolLedgerPayload,
} from "./stream-recovery.events.js";

// Re-export for convenience
export type { CollaborationMode, RiskLevel } from "../interfaces/session.port.js";

// Re-export ModelToolCall as ToolCall for core usage
export type { ModelToolCall as ToolCall } from "../model/index.js";

// Base Event
export interface SessionEvent {
  id: EventId;
  sessionId: SessionId;
  turnId?: TurnId;
  type: SessionEventType;
  timestamp: Date;
  traceId: TraceId;
  sequenceNumber: number;
  payload: unknown;
}

export const SessionEventType = {
  SessionCreated: "session_created",
  SessionResumed: "session_resumed",
  SessionForked: "session_forked",
  SessionCompacted: "session_compacted",
  SessionTitleUpdated: "session_title_updated",
  SessionModeChanged: "session_mode_changed",
  SessionEnded: "session_ended",
  TurnStarted: "turn_started",
  TurnInputReceived: "turn_input_received",
  TurnSteerQueued: "turn_steer_queued",
  // guide close with no usable tool batch: the original intent re-files onto the plain queue in place.
  // sendQueuedNow atomic promotion: reservation/promoting/rollback all enter the event stream; the projection never guesses locally.
  // session_input and user message/parts promote in one transaction; CommandInbox can safely unpin.
  // v4 queue reorder: queue entry order changed (reducer reorders queue rows by orderedPendingInputIds).
  // v4 input controls: queue autoDrain switch (held feeds heldQueueInputRequiresChoice's authorization bit).
  // v4 input controls: followup routing mode (enqueue vs guide while running).
  FollowupModeChanged: "followup_mode_changed",
  TurnComplete: "turn_complete",
  TurnError: "turn_error",
  UserMessage: "user_message",
  AssistantMessage: "assistant_message",
  AssistantFeedbackUpdated: "assistant_feedback_updated",
  SystemMessage: "system_message",
  ModelRequest: "model_request",
  ModelSelected: "model_selected",
  ModelStreaming: "model_streaming",
  StreamingToolLedgerUpdated: "streaming_tool_ledger_updated",
  StreamRecoveryAnchorCreated: "stream_recovery_anchor_created",
  StreamRecoveryStarted: "stream_recovery_started",
  StreamRecoveryAnchorSelected: "stream_recovery_anchor_selected",
  StreamRecoveryTailDiscarded: "stream_recovery_tail_discarded",
  StreamRecoveryRetryStarted: "stream_recovery_retry_started",
  StreamRecoveryBlocked: "stream_recovery_blocked",
  ModelNetworkStatus: "model_network_status",
  ModelAnomalyWarning: "model_anomaly_warning",
  NetworkRequestStatus: "network_request_status",
  ModelComplete: "model_complete",
  ModelError: "model_error",
  ToolCallScheduled: "tool_call_scheduled",
  ToolCallStarted: "tool_call_started",
  ToolCallProgress: "tool_call_progress",
  ToolCallResult: "tool_call_result",
  ToolCallError: "tool_call_error",
  ToolBatchComplete: "tool_batch_complete",
  BackgroundTaskStarted: "background_task_started",
  BackgroundTaskUpdated: "background_task_updated",
  BackgroundTaskCompleted: "background_task_completed",
  // Live workflow run progress: one event per engine RunEvent, appended to the **parent session** (the run has no session of its own).
  // v4 reduces these into the workflowRuns state key; v3 strips them before shouldExposeSessionEventToProtocol.
  // The dynamic_ prefix is deliberate: the legacy `Workflow` tool's script run events (workflow_started /
  // workflow_completed, script-workflow-runtime.ts) are a separate log; same names would genuinely confuse.
  DynamicWorkflowRunProgress: "dynamic_workflow_run_progress",
  PermissionRequested: "permission_requested",
  PermissionResolved: "permission_resolved",
  PermissionDenied: "permission_denied",
  UserInputAutoResolutionUpdated: "user_input_auto_resolution_updated",
  WorkspaceHookReviewRequested: "workspace_hook_review_requested",
  WorkspaceHookReviewSettled: "workspace_hook_review_settled",
  WorkspaceHookReviewSuperseded: "workspace_hook_review_superseded",
  // Soft gate: emitted on admission state change; the projection clears snapshot fields when pendingCount=0.
  WorkspaceHookAdmissionUpdated: "workspace_hook_admission_updated",
  HookRunStarted: "hook_run_started",
  HookRunProgress: "hook_run_progress",
  HookRunCompleted: "hook_run_completed",
  HookRunFailed: "hook_run_failed",
  HookRunBlocked: "hook_run_blocked",
  CompactStarted: "compact_started",
  CompactCompleted: "compact_completed",
  CompactFailed: "compact_failed",
  CompactBoundary: "compact_boundary",
  MicrocompactBoundary: "microcompact_boundary",
  RewindTriggered: "rewind_triggered",
  CheckpointCreated: "checkpoint_created",
  TargetChanged: "target_changed",
  TargetCompletionVerification: "target_completion_verification",
  SubagentSpawned: "subagent_spawned",
  SubagentMessage: "subagent_message",
  SubagentStopped: "subagent_stopped",
  Interrupt: "interrupt",
  Cancel: "cancel",
  Resume: "resume",
  Error: "error",
} as const;

export type SessionEventType = (typeof SessionEventType)[keyof typeof SessionEventType];

// -----------------------------------------------
// Event Payloads
// -----------------------------------------------

export interface SessionCreatedPayload {
  planEnabled?: boolean;
  mode: CollaborationMode;
  contextWindow: number;
}

export interface SessionResumedPayload {
  directory: string;
  interruptedToolCount: number;
  messageCount: number;
  partCount: number;
  recoveredCompactTimelineCount?: number;
  recoveredSteerInputCount?: number;
  resumedTodoCount?: number;
}

export interface SessionForkedPayload {
  forkedSessionId?: SessionId;
  originalSessionId: SessionId;
  restoredFileCount?: number;
  restoredSnapshotRef?: string;
  strategy?: "fork_required";
  targetCheckpointId?: string;
  targetMessageId?: MessageId;
  /** @deprecated Use targetMessageId for message-level forks. */
  forkPoint: number;
}

export interface SessionCompactedPayload {
  compactBoundary: CompactBoundaryPayload;
  summary?: string;
  preservedEventCount?: number;
  removedEventCount?: number;
}

export type CompactLifecyclePayload = CompactTimelinePayload;

export type MicrocompactBoundaryEventPayload = MicrocompactBoundaryPayload;

/**
 * Attachment rendering (additive): lightweight display metadata for user input attachments, sent with TurnStarted;
 * the v4 projection fills the userInput row's attachments from it.
 * Display fields only, never the content itself (content flows via resolve/persist into FilePart/artifact).
 */
export interface TurnAttachmentMeta {
  fileName: string;
  mime: string;
  bytes: number;
  /** Content reference (local path / artifact URI); absent for data URLs and other reference-less forms. */
  ref?: string;
}

/**
 * Structured payload of workflow notifications.
 * Minted by the emitter, bounded (summary<=500 / result<=4000 / error<=2000 / reports.preview<=500 each, <=8 items /
 * artifacts<=8, title<=120 / question-context<=4000); kept hand-synced with shared's
 * workflowNotificationMetaSchema.
 * Batch notification rounds deliberately carry none -- one manifest per round does not survive batching.
 */
export type WorkflowNotificationMeta =
  | {
      kind: "terminal";
      status: "completed" | "errored" | "stopped";
      /** Present only when `status === "stopped"`. */
      stopReason?: "user" | "model" | "provider" | "interrupted" | "superseded";
      summary: string;
      result?: string;
      resultForm?: "prose" | "json";
      resultTruncated?: true;
      error?: string;
      reports?: { count: number; shown: number; preview: string[] };
      /**
       * Chips payload of user-facing artifacts: <= 8 items;
       * overflow (including kind-filtered ones) sets `artifactsTruncated`.
       * Terminology: "artifact" here is output the script published to the user via `artifact.*` -- different from
       * the `result` on the same payload (the script's top-level return, also called artifact inside the engine).
       */
      artifacts?: {
        id: string;
        kind: "file" | "markdown" | "chart" | "table" | "metrics" | "board";
        title?: string;
        version: number;
        contentType?: string;
        /** The run's deliverable; leads the manifest. The only entry with `description` (the completion card reads it aloud). */
        primary?: true;
        description?: string;
      }[];
      artifactsTruncated?: true;
      durationMs?: number;
    }
  | {
      kind: "escalation";
      qid: string;
      actor: string;
      question: string;
      context?: string;
      askedAt?: number;
    }
  /** Run-level stall: one entry per stall segment; not terminal. */
  | {
      kind: "stall";
      sinceMs: number;
      reason?: string;
      cap?: number;
    };

/** Display metadata for a standalone background result round; batch rounds may reuse the representative task identity and synthesize a title -- never parsed back from notification text. */
export interface BackgroundResultOriginMeta {
  /** `workflow` is a dynamic-workflow run (workId == runId), reusing the whole background-notification pipeline. */
  backgroundSource: "bash" | "subagent" | "workflow";
  workId: string;
  title: string;
  /** Present only on single-notification rounds with backgroundSource === "workflow"; the manifest's only data source. */
  workflowNotification?: WorkflowNotificationMeta;
}

/**
 * Whether the turn carried real Agent execution. controlOnly exists to draw timeline boundaries for visible control
 * inputs; it must not advance session running/activeWorks nor produce "working/worked" states.
 */
export type TurnExecutionKind = "agent" | "controlOnly";

export type OffPeakRunType = "init" | "resume";

export type TurnBackgroundAttribution =
  | { automationId: string; offPeakTaskId?: never; offPeakRunType?: never }
  | {
      offPeakTaskId: string;
      offPeakRunType?: OffPeakRunType;
      automationId?: never;
    }
  | {
      automationId?: undefined;
      offPeakTaskId?: undefined;
      offPeakRunType?: never;
    };

/**
 * Launch-turn metadata when the hub starts a saved workflow directly. Written identically into the user message's
 * `metadata` (cold-recovery source) and the `TurnStarted` payload (live-projection source) -- cold and hot share one
 * shape, and the projection draws the launch card from it instead of showing text.
 */
/** Launch metadata display allows only the create_workflow projection (same shape as the shared row schema). */
export type WorkflowLaunchDisplay = Extract<ToolResultDisplayPayload, { kind: "create_workflow" }>;

/**
 * The settings turn's "what changed": only changed settings appear; a missing from/to end means that end is the
 * default (model = session model, ceiling = machine cap). `ceiling` is the machine cap, for "13 -> 4" readings.
 * Same shape as shared's `workflowSettingsAmendMetaSchema`.
 */
export interface WorkflowSettingsAmendMeta {
  /**
   * The run this adjustment replaced (or continues). **Absent means in-place**: when only the concurrency cap changes
   * and the run is still in flight, the "configuration" neither stops it nor starts another, so there is no
   * predecessor to point to -- `runId` is the adjusted run itself. Same shape as shared's workflowSettingsAmendMetaSchema.
   */
  predecessorRunId?: string;
  subagentModel?: { from?: string; to?: string };
  maxConcurrency?: { from?: number; to?: number };
  ceiling?: number;
}

export interface WorkflowLaunchMeta {
  /** The run's identity (== backgroundTaskId == cancelBackgroundWork's workId). */
  runId: string;
  /**
   * Synthetic toolCall id that launched this run (hub launch `launch-<uuid>`, settings turn `settings-<uuid>`;
   * the tool card -> detail page join key).
   */
  toolCallId: string;
  /**
   * Workflow name (resolved; not user/model-overridable); the launch card title and session title both take it.
   * Always present on hub launches; on settings turns, the adjusted run's own name -- absent for nameless runs
   * (the UI falls back to wording, never the raw run id as title).
   */
  name?: string;
  /** The resolved actual scope (not the possibly-absent request scope). Hub launches only: settings turns have no saved file to point to. */
  scope?: SavedWorkflowScope;
  /** Where the saved file lives, for detail/diagnostics; not used in execution. Hub launches only. */
  path?: string;
  /** This run's args (validated against declarations, defaults backfilled); bounds in {@link boundWorkflowLaunchMeta}. */
  args?: Record<string, unknown>;
  /** Workflow description (saved metadata description), bounded to 500 chars. */
  description?: string;
  /**
   * The pre-launch compiled `create_workflow` result display (bounded causality graph + diagnostics), same projection
   * and constructor as the CreateWorkflow tool row's `display`. The run detail sidebar looks up the "launching row" by
   * toolCallId for the graph -- a direct launch has no tool row, so the graph comes from here.
   */
  display?: WorkflowLaunchDisplay;
  /**
   * The script source this run actually executed (same text as `port.submit.scriptText`). The tool path puts it on
   * `input.script` for the sidebar's Script section; this is the same fact's launch-turn home. Bounded by
   * {@link WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS} (over bound: absent entirely, and the sidebar Script section with it).
   */
  script?: string;
  /** Settings turns only: which run this one was amended from, and what changed. */
  amend?: WorkflowSettingsAmendMeta;
}

/** JSON serialization cap (bytes) for {@link WorkflowLaunchMeta.args}. Over bound: dropped for a marker key. */
export const WORKFLOW_LAUNCH_ARGS_MAX_BYTES = 4_096;
/** Character cap for {@link WorkflowLaunchMeta.description}. */
export const WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS = 500;
/**
 * Character cap for {@link WorkflowLaunchMeta.script}. The tool path already transcripts `input.script` unbounded;
 * pick a cap far above any sane dwf script yet able to stop a whole-repo dump; over bound means absent, not
 * truncated (a half script is useless in the Script pane, and the graph still lives in display).
 */
export const WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS = 256_000;
/**
 * Stand-in key when args exceed the bound. The real args always reach the model surface canonical sentence
 * (untruncated there); this metadata only feeds the launch card, and a 4KB arg bag is unrenderable on a card
 * anyway -- so replace wholesale with one readable marker instead of cramming. Ellipsis as key: it falls outside
 * `SAVED_WORKFLOW_NAME_PATTERN`, so it cannot collide with a real arg name.
 */
export const WORKFLOW_LAUNCH_ARGS_TRUNCATED_KEY = "…";

/**
 * Bound the launch-turn metadata. Args serialized over {@link WORKFLOW_LAUNCH_ARGS_MAX_BYTES} become wholesale
 * `{ "…": "arguments omitted (N bytes) }"` (see {@link WORKFLOW_LAUNCH_ARGS_TRUNCATED_KEY});
 * description over {@link WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS} is truncated with an ellipsis. Called at the minting
 * site so message metadata and TurnStarted payload receive the same bounded values.
 */
export function boundWorkflowLaunchMeta(input: WorkflowLaunchMeta): WorkflowLaunchMeta {
  const bounded: WorkflowLaunchMeta = {
    runId: input.runId,
    toolCallId: input.toolCallId,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.scope === undefined ? {} : { scope: input.scope }),
    ...(input.path === undefined ? {} : { path: input.path }),
  };
  if (input.args !== undefined) {
    const serialized = JSON.stringify(input.args);
    const bytes = serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
    bounded.args =
      bytes > WORKFLOW_LAUNCH_ARGS_MAX_BYTES
        ? { [WORKFLOW_LAUNCH_ARGS_TRUNCATED_KEY]: `arguments omitted (${bytes} bytes)` }
        : input.args;
  }
  if (input.description !== undefined) {
    bounded.description =
      input.description.length > WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS
        ? `${input.description.slice(0, WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS - 1)}…`
        : input.description;
  }
  // display is length-capped at construction (createCreateWorkflowDisplay + boundCausalityGraph); forwarded verbatim.
  if (input.display !== undefined) bounded.display = input.display;
  if (input.script !== undefined && input.script.length <= WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS) {
    bounded.script = input.script;
  }
  // The amend block is bounded by construction (both model strings come from parsed canonical forms, same cap as run state).
  if (input.amend !== undefined) bounded.amend = input.amend;
  return bounded;
}

export interface TurnStartedPayloadBase {
  /** Monotonic epoch ms of execution entry; hooks/persistence happen before TurnStarted publishes, so publish time cannot infer execution start. */
  executionStartedAt?: number;
  turnNumber: number;
  input: string;
  /**
   * v4 file summaries query by turn rowId, but workspace checkpoint recovers by user messageId; TurnStarted must
   * carry that same persisted id so the projection can join userInput rows back to their checkpoint.
   */
  messageId?: MessageId;
  inputId?: string;
  /** Admission-only passthrough for content-less telemetry facts; not inferable from session ownership. */
  /** Stable cancel identity covering primary turn -> goal verify/continue within one runtime command. */
  foregroundExecutionId?: string;
  queryId?: QueryId;
  inputSource?: SyntheticUserMessageSource;
  inputVisibility?: MessageVisibility;
  /**
   * Launch-turn metadata when the hub starts a saved workflow directly (`inputSource === "workflow_launch"`).
   * The live projection draws the launch card from it; aligned with the same copy in message metadata (cold/hot same shape).
   */
  workflowLaunch?: WorkflowLaunchMeta;
  /** Defaults to agent, for legacy events and historical transcripts. */
  executionKind?: TurnExecutionKind;
  /**
   * Index from which `input` is engine-appended text (dwf ask epilogue / nudge); the GUI folds it into the reveal.
   * 0 = all engine text; absent = none. Aligned with the same copy in message metadata (cold/hot same shape).
   */
  epilogueStart?: number;
  /** Structured source for idle background wakes; active-loop merges never create a separate TurnStarted. */
  originMeta?: BackgroundResultOriginMeta;
  /** Forwarded only when every member of one background notification batch shares a source; mixed sources stay empty. */
  backgroundSource?: BackgroundResultOriginMeta["backgroundSource"];
  targetId?: string;
  /** Attachment metadata for this turn's user input (absent when none). */
  attachments?: TurnAttachmentMeta[];
  /** CLI admission metadata; inputId remains the sourceCommandId compatibility anchor. */
  intent?: TurnInputIntentMetadata;
}

export type TurnStartedPayload = TurnStartedPayloadBase & TurnBackgroundAttribution;

export interface TurnInputReceivedPayload {
  input: string;
  attachments?: Attachment[];
}

export interface TurnSteerQueuedPayload {
  pendingInputId: string;
  inputId?: string;
  queryId?: QueryId;
  input: string;
  inputPreview: string;
  inputSize: number;
  commandKind?: TurnSteerCommandKind;
  source?: TurnSteerSource;
  inputPresentation?: RuntimeInputPresentation;
  /** Tool names hidden from the provider when the queued input is consumed. */
  toolDisallowlist?: readonly string[];
  /** Delivery semantics: queue = new product turn on consume; guide = inline into the current turn. */
  delivery?: TurnSteerDeliveryMode;
  targetTurnId: TurnId;
  queueLength: number;
  intent?: TurnInputIntentMetadata;
}

export interface TurnSteerDeliveryChangedPayload {
  pendingInputId: string;
  targetTurnId: TurnId;
  requestedDelivery: "guide";
  admittedDelivery: "queue";
  fallbackReasonCode: string;
  /** The complete intent after re-filing; reducer/cold replay never guess delivery from side state. */
  intent?: TurnInputIntentMetadata;
}

export interface TurnSteerReorderedPayload {
  orderedPendingInputIds: string[];
  targetTurnId: TurnId;
}

export interface TurnSteerDispatchChangedPayload {
  pendingInputId: string;
  reservationId?: string;
  state: "queued" | "reserved" | "promoting";
  targetTurnId: TurnId;
}

export interface QueueAutoDrainChangedPayload {
  autoDrain: boolean;
}

export interface FollowupModeChangedPayload {
  mode: "queue" | "guide";
}

export interface TurnSteerDrainedPayload {
  pendingInputIds: string[];
  queryIds?: QueryId[];
  targetTurnId: TurnId;
  injectedMessageIds: MessageId[];
  /**
   * Drain facts carry their own text and persisted messageId, so the projection no longer depends on in-memory
   * queue state for text (a missing queue item used to silently drop the user row).
   * delivery decides turn-split semantics; defaults to queue (one turn per item).
   */
  drainedInputs?: Array<{
    pendingInputId: string;
    messageId: MessageId;
    text: string;
    delivery?: TurnSteerDeliveryMode;
    intent?: TurnInputIntentMetadata;
    toolDisallowlist?: readonly string[];
  }>;
}

export interface TurnSteerRejectedPayload {
  reason: TurnSteerRejectReason;
  activeTurnId?: TurnId;
  expectedTurnId?: TurnId;
  inputPreview?: string;
  inputSize?: number;
}

export interface TurnSteerDiscardedPayload {
  pendingInputIds: string[];
  targetTurnId: TurnId;
  // user_removed (v4 per-item queue delete): the user explicitly removed one entry; distinct from turn-lifecycle drops.
  // promoted: sendQueuedNow took execution; remove from the queue projection only, while session_input stays
  // admitted until the user message promotes atomically (or is discarded after restart).
  reason: "turn_cancelled" | "turn_failed" | "session_resumed" | "user_removed" | "promoted";
}

export interface SessionInputPromotedPayload {
  pendingInputId: string;
  sourceCommandId: string;
  messageId: MessageId;
}

export interface TurnCompletePayload {
  response: string;
  tokenCount: number;
  usage?: ModelUsageSummary;
  toolCallCount: number;
  /** Model artifacts successfully committed to provider-visible persistent history for the current query. */
  historyRoundCount?: number;
  duration: number;
  inputId?: string;
  resultType: TurnResultType;
  /** Whether this turn consumed a background result notification from a subagent. */
  /** Whether this turn consumed a background notification from a workflow (dynamic-workflow run). */
  /** Internal preemption (sendQueuedNow) ends only the current turn; not the user's manual Stop of the queue. */
  preserveQueueAutoDrainOnCancel?: boolean;
}

export interface TurnErrorPayload {
  error: ErrorPayload;
  turnPhase: string;
  inputId?: string;
  /** Whether this turn consumed a background result notification from a subagent. */
  /** Whether this turn consumed a background notification from a workflow (dynamic-workflow run). */
  workflowResultConsumed?: boolean;
}

export type TurnResultType =
  | "success"
  // "cancelled": user-initiated interruption (TurnCancelled) is a normal ending; report via TurnComplete, not TurnError.
  | "cancelled"
  | "error_max_turns"
  | "error_max_budget"
  | "error_during_execution"
  | "error_max_tool_calls";

export interface UserMessagePayload {
  content: string;
  attachments?: Attachment[];
}

export interface AssistantMessagePayload {
  content: string;
  toolCalls?: ToolCallPayload[];
}

export interface AssistantFeedbackUpdatedPayload {
  entityId: string;
  feedback: "like" | "dislike" | null;
}

export interface SystemMessagePayload {
  type: "init" | "compact_boundary" | "interrupted";
  content: string;
  compactBoundary?: CompactBoundaryPayload;
}

export interface SessionTitleUpdatedPayload {
  messageID?: MessageId;
  previousTitle: string;
  source: SessionTitleSource;
  title: string;
}

export interface SessionModeChangedPayload {
  permissionGrant?: { interactionId: string; queueItemIds: string[] };
  planEnabled?: boolean;
  previousPlanEnabled?: boolean;
  mode: CollaborationMode;
  previousMode: CollaborationMode;
  source: "tool" | "command" | "system";
  toolCallId?: ToolCallId;
}

export type TargetCompletionVerificationStatus =
  | "started"
  | "completed"
  | "failed_closed"
  | "cancelled";

export interface TargetCompletionVerificationPayload {
  targetId: string;
  status: TargetCompletionVerificationStatus;
  verificationId: string;
  /** Shared with the foreground runtime command that triggered the verification, for Stop's stale guard. */
  /** When sendQueuedNow preempts the verifier, only the goal pauses -- never the future queue. */
  preserveQueueAutoDrainOnCancel?: boolean;
  verification?: GoalCompletionVerificationOutput;
  goalIteration?: number;
  anchorAssistantMessageId?: MessageId;
  anchorTurnId?: TurnId;
}

export interface ModelRequestPayload {
  messages: ModelMessage[];
  providerId: string;
  modelId: string;
  querySource?: string;
  temperature?: number;
  maxTokens?: number;
}

export type ModelSelectionOrigin = "registryFallback";

export interface ModelSelectedPayload {
  modelSelection: ModelSelection;
  /** Reasoning the Active Model resolved; execution-fact/display projection only, never part of the sparse Selection. */
  /** Absent: update current selection only; null: explicit empty-to-selection model boundary. */
  /** Carried only when the Agent auto-recovers the model; absent means ordinary selection or a legacy event. */
  /** Thinking-tier capability of the current selection; published atomically with the model selection. */
  /** Context window the runtime actually applied for this selection; null = explicitly cleared, absent = legacy event. */
  contextWindow?: number | null;
}

export type ModelStreamingKind =
  | "start"
  | "text_start"
  | "text_delta"
  | "text_end"
  | "reasoning_start"
  | "reasoning_delta"
  | "reasoning_end"
  | "tool_input_start"
  | "tool_input_delta"
  | "tool_input_end"
  | "tool_call"
  | "finish"
  | "error";

export interface ModelStreamingPayload {
  delta: string;
  done: boolean;
  kind?: ModelStreamingKind;
  assistantMessageId?: MessageId;
  partId?: PartId;
  toolCallId?: ToolCallId;
  toolName?: string;
  input?: unknown;
  providerExecuted?: boolean;
}

export type ModelNetworkStatusPayload = ModelNetworkStatusEvent;

export type ModelAnomalyWarningCategory =
  | "tool_call_budget"
  | "repeated_tool_call"
  | "provider_finish_mismatch"
  | "malformed_tool_call";

export type ModelAnomalyWarningSeverity = "info" | "warning";

export interface ModelAnomalyWarningPayload {
  category: ModelAnomalyWarningCategory;
  severity: ModelAnomalyWarningSeverity;
  observedCount?: number;
  threshold?: number;
  toolName?: string;
  toolCallId?: ToolCallId;
  warningInjected: boolean;
  modelVisibleMessageId?: MessageId;
}

export type NetworkRequestSource = "http_client" | "model" | "tool" | "mcp" | "plugin" | "unknown";

export type NetworkRequestLifecycleStatus = "pending" | "complete" | "error";

export interface NetworkRequestStatusPayload {
  requestId: string;
  source: NetworkRequestSource;
  status: NetworkRequestLifecycleStatus;
  method: string;
  url: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  statusCode?: number;
  error?: string;
  toolCallId?: ToolCallId | string;
  toolName?: string;
  attempt?: number;
  egress?: HttpClientEgressInfo;
}

export interface ModelCompletePayload {
  cacheHit?: {
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    latestHitRate: number | null;
    hitRate: number | null;
    hitRateRequestCount: number;
    totalInputTokens: number;
    totalCacheReadTokens: number;
    totalCacheWriteTokens: number;
  };
  content: string;
  contextUsageBreakdown?: ContextUsageBreakdownItem[];
  contextWindow?: number;
  fileChanges?: TurnFileChangeSummary;
  querySource?: string;
  stopReason: string;
  /** Complete tool calls assembled by the current model request; legacy events may lack it. */
  toolCallCount?: number;
  usage: TokenUsage | ModelUsage;
}

export interface TurnFileChangeSummary {
  additions: number;
  deletions: number;
  files: number;
  items: TurnFileChangeSummaryItem[];
}

export interface TurnFileChangeSummaryItem {
  additions: number;
  deletions: number;
  path: string;
  toolNames?: string[];
  writeCount: number;
}

export type ContextUsageBreakdownSource =
  | "system_prompt"
  | "meta_user_context"
  | "skills"
  | "tool_prompt"
  | "system_tool_schemas"
  | "mcp_tool_schemas"
  | "messages";

export interface ContextUsageBreakdownItem {
  source: ContextUsageBreakdownSource;
  chars: number;
}

export interface ModelErrorPayload {
  error: ErrorPayload;
  retryable: boolean;
}

export interface ToolCallScheduledPayload {
  toolCallId: ToolCallId;
  assistantMessageId?: MessageId;
  toolName: string;
  input: unknown;
  dependencies?: ToolCallId[];
  parallelGroupIndex?: number;
  canRunParallel?: boolean;
  display?: ToolResultDisplayPayload;
  schedule: ToolSchedulePayload;
}

export interface ToolCallStartedPayload {
  toolCallId: ToolCallId;
  toolName?: string;
  startedAt: Date;
  display?: ToolResultDisplayPayload;
  /**
   * The call's **post-resolution** side-effect capability (tool metadata plus input-resolved runtime capability, e.g.
   * Bash read-only command verdict). Emitted before the handler acts, so subscribers know "writes are coming" before
   * the first byte lands -- dynamic-workflow's driver closes the amend-resume import cache on this
   * (`isWorkspaceMutatingToolCall`). Optional: events predating the field lack it.
   */
  readOnly?: boolean;
  sideEffectScope?: ToolSideEffectScope;
}

export interface ToolCallProgressPayload {
  toolCallId: ToolCallId;
  toolName?: string;
  elapsedMs?: number;
  pid?: number;
  stdoutBytes?: number;
  stderrBytes?: number;
  outputBytes?: number;
  outputPreview?: ExecutionOutputPreview;
  stdoutTail?: string;
  stderrTail?: string;
}

export interface ToolCallResultPayload {
  toolCallId: ToolCallId;
  result: ToolResultPayload;
  duration: number;
  /** Skill metadata is telemetry-only; never enters the model-visible result.content. */
  skillMetadata?: SkillTelemetryMetadata;
}

export interface ToolCallErrorPayload {
  toolCallId: ToolCallId;
  error: ErrorPayload;
  /** Skill metadata is telemetry-only; never enters the model-visible error body. */
  skillMetadata?: SkillTelemetryMetadata;
}

export interface ToolBatchCompletePayload {
  toolCallIds: ToolCallId[];
  successCount: number;
  errorCount: number;
}

export type BackgroundTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "spawn_error"
  | "lost";

export interface BackgroundTaskPayloadBase {
  taskId: string;
  toolCallId?: ToolCallId | string;
  toolName?: string;
  // "workflow" = workflow run (CreateWorkflow). The tracker already dispatches per-tool lifecycleProvider, so
  // taskKind only drives panel grouping and icons -- widening is a pure display fix, no lifecycle semantics change.
  taskKind?: "bash" | "subagent" | "workflow";
  childSessionId?: SessionId | string;
  blocked?: boolean;
  blockedReason?: "interactive_prompt_detected" | "no_output_progress" | string;
  cancellable?: boolean;
  cancelRequestedAt?: Date;
  command?: string;
  description?: string;
  status: BackgroundTaskStatus;
  pid?: number;
  startedAt?: Date;
  completedAt?: Date;
  outputPath?: string;
  stderrPersistedOutputPath?: string;
  stdoutPersistedOutputPath?: string;
  outputBytes?: number;
  outputTruncated?: boolean;
  outputTail?: string;
  stderrBytes?: number;
  stderrTail?: string;
  stdoutBytes?: number;
  stdoutTail?: string;
  terminalId?: string;
}

export type BackgroundTaskStartedPayload = BackgroundTaskPayloadBase & {
  status: "running";
};

export type BackgroundTaskUpdatedPayload = BackgroundTaskPayloadBase;

export type BackgroundTaskCompletedPayload = BackgroundTaskPayloadBase & {
  status: Exclude<BackgroundTaskStatus, "running">;
};

/**
 * One workflow run progress event (parent session). Fields mirror {@link DynamicWorkflowRunEvent} --
 * **serialized once, consumed twice**: the listEvents event page and this session event share one bounded payload,
 * so readers never need two interpretation rules. `type` is taken by the session envelope, hence `eventType`.
 */
export interface DynamicWorkflowRunProgressPayload {
  runId: string;
  /** The originating CreateWorkflow tool call (tool card -> detail page join key). */
  /** Journal sequence (monotonic via `appendEvent`); the event log's cursor uses the same ruler. */
  /** Engine event kind: run-started / actor-created / node-* / usage-updated / log / report / phase-entered / run-settled. */
  eventType: string;
  payload: Record<string, unknown>;
  truncated?: boolean;
  /** Derived (toProgressPayload): the child session id on `actor-created` (driver-minted `sess_dwf-...`). */
  actorSessionId?: string;
  /**
   * Derived (same family as `actorSessionId`, see toProgressPayload): the run's `run-launched.inputId`.
   * Only on `actor-created` / `run-settled`, so downstream can attribute the child to the launching turn. Pre-upgrade runs have no `run-launched`; field absent.

   */
  launchInputId?: string;
}

export interface PermissionRequestedPayload {
  requestId?: string;
  toolCallId: ToolCallId;
  toolName: string;
  riskLevel: RiskLevel;
  reason: string;
  input: unknown;
  suggestedPermissionUpdates?: PermissionUpdate[];
  origin?: InteractionRequestOrigin;
  /**
   * Tool-reported confirmation preview, produced by the `prepareApproval` hook. Reuses the result channel's display
   * projection so ask and result cards share one bounded shape, adding no unbounded field.
   */
  display?: ToolResultDisplayPayload;
  fullAccessSupported?: boolean;
  optionsPolicy?: PermissionOptionsPolicy;
}

export interface PermissionResolvedPayload {
  requestId?: string;
  toolCallId: ToolCallId;
  decision: PermissionDecision;
  reason?: string;
  modifiedInput?: unknown;
}

export interface PermissionDeniedPayload {
  toolCallId: ToolCallId;
  toolName: string;
  reason: string;
  inputSummary?: unknown;
}

export type UserInputAutoResolutionState =
  | {
      state: "hiddenGrace" | "visibleCountdown";
      startedAt: number;
      visibleAt: number;
      deadlineAt: number;
    }
  | {
      state: "snoozed";
      startedAt: number;
      snoozedAt: number;
    };

export interface UserInputAutoResolutionUpdatedPayload {
  interactionId: string;
  toolCallId: ToolCallId;
  autoResolution: UserInputAutoResolutionState;
}

export interface WorkspaceHookReviewRequestedPayload {
  request: unknown;
}

export interface WorkspaceHookReviewSettledPayload {
  interactionId: string;
  state: "resolved" | "timed_out" | "configuration_error";
  reasonCode?: string;
}

export interface WorkspaceHookReviewSupersededPayload {
  interactionId: string;
  supersededByInteractionId: string;
}

// Soft gate: the admission layer reports pending state after evaluation.
// pendingCount = declarations with configuredEnabled && admissionClass === "pending";
// pendingCount === 0 -> projection sets snapshot.workspaceHookAdmission to null (banner disappears).
export interface WorkspaceHookAdmissionUpdatedPayload {
  pendingCount: number;
  bundleDigest: string;
  workspaceIdentity?: string;
}

export type PermissionDecision = "allow" | "deny" | "escalate" | "modify";

export type TargetChangedAction =
  | "set"
  | "status_updated"
  | "cleared"
  | "usage_accounted"
  | "run_started"
  | "run_finished"
  | "summary_updated";

export type TargetChangedSource = "command" | "tool" | "runtime";

export interface TargetChangedPayload {
  action: TargetChangedAction;
  source: TargetChangedSource;
  target: SessionGoal | null;
  previousTarget?: SessionGoal | null;
}

// -----------------------------------------------
// Supporting Types
// -----------------------------------------------

export interface Attachment {
  type: "file" | "image" | "pdf" | "url";
  path?: string;
  content?: string;
  mimeType?: string;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCallPayload[];
  toolCallId?: string;
}

export interface ToolCallPayload {
  id: ToolCallId;
  name: string;
  input: unknown;
}

export interface ToolResultPayload {
  success: boolean;
  content: string;
  display?: ToolResultDisplayPayload;
  perf?: import("../tools/performance.js").ToolExecutionTelemetry;
  error?: ErrorPayload;
  truncated?: boolean;
  originalBytes?: number;
  returnedBytes?: number;
  budgetStrategy?: string;
  artifactPath?: string;
}

export interface ToolSchedulePayload {
  parallelGroups: ToolCallId[][];
  executionOrder: ToolCallId[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheTokens?: number;
}

export interface ErrorPayload {
  code?: string;
  detail?: string;
  /** Raw message of the deepest non-wrapper frame in the chain, for client telemetry root-cause. */
  /** detail/errorDetails/details content of that same bottom frame. */
  underlyingErrorDetail?: string;
  type: string;
  message: string;
  attribution?: ErrorAttribution;
  retryable?: boolean;
  stack?: string;
  data?: unknown;
}

/** Carries only aggregatable failure facts -- never request bodies, credentials, URLs, or monitoring policy. */

export interface ErrorAttribution {
  source?: "provider" | "runtime" | "tool" | "network";
  reason?: string;
  errorPhase?: ModelApiErrorPhase;
  exceptionKind?: ModelFailureExceptionKind;
  providerId?: string;
  modelId?: string;
  providerKind?: string;
  transport?: "http" | "sse" | "websocket";
  statusCode?: number;
  providerErrorCode?: string;
  retryable?: boolean;
}

// CollaborationMode and RiskLevel are re-exported from ports

// -----------------------------------------------
// Event Factory
// -----------------------------------------------

export function createSessionEvent<T>(
  type: SessionEventType,
  sessionId: SessionId,
  payload: T,
  options?: {
    turnId?: TurnId;
    traceId?: TraceId;
    sequenceNumber?: number;
  },
): SessionEvent {
  return {
    id: crypto.randomUUID() as EventId,
    sessionId,
    turnId: options?.turnId,
    type,
    timestamp: new Date(),
    traceId: options?.traceId ?? (crypto.randomUUID() as TraceId),
    sequenceNumber: options?.sequenceNumber ?? 0,
    payload,
  };
}

export function createModelUsageSummaryFromEvents(
  events: readonly SessionEvent[],
): ModelUsageSummary | undefined {
  const usages: ModelUsage[] = [];

  for (const event of events) {
    if (event.type !== SessionEventType.ModelComplete) continue;
    const payload = event.payload as Partial<ModelCompletePayload>;
    if (payload.usage) {
      usages.push(payload.usage as ModelUsage);
    }
  }

  return createModelUsageSummary(usages);
}

export type SessionEventPayload =
  | SessionCreatedPayload
  | SessionResumedPayload
  | SessionForkedPayload
  | SessionCompactedPayload
  | SessionTitleUpdatedPayload
  | SessionModeChangedPayload
  | TurnStartedPayload
  | TurnInputReceivedPayload
  | TurnSteerQueuedPayload
  | TurnSteerDeliveryChangedPayload
  | TurnSteerDispatchChangedPayload
  | TurnSteerDrainedPayload
  | TurnSteerReorderedPayload
  | QueueAutoDrainChangedPayload
  | FollowupModeChangedPayload
  | TurnSteerRejectedPayload
  | TurnSteerDiscardedPayload
  | SessionInputPromotedPayload
  | TurnCompletePayload
  | TurnErrorPayload
  | UserMessagePayload
  | AssistantMessagePayload
  | SystemMessagePayload
  | ModelRequestPayload
  | ModelSelectedPayload
  | ModelStreamingPayload
  | StreamingToolLedgerPayload
  | StreamRecoveryAnchorPayload
  | StreamRecoveryStartedPayload
  | StreamRecoveryAnchorSelectedPayload
  | StreamRecoveryTailDiscardedPayload
  | StreamRecoveryRetryStartedPayload
  | StreamRecoveryBlockedPayload
  | ModelNetworkStatusPayload
  | ModelAnomalyWarningPayload
  | NetworkRequestStatusPayload
  | ModelCompletePayload
  | TargetCompletionVerificationPayload
  | ModelErrorPayload
  | ToolCallScheduledPayload
  | ToolCallStartedPayload
  | ToolCallProgressPayload
  | ToolCallResultPayload
  | ToolCallErrorPayload
  | ToolBatchCompletePayload
  | BackgroundTaskStartedPayload
  | BackgroundTaskUpdatedPayload
  | BackgroundTaskCompletedPayload
  | DynamicWorkflowRunProgressPayload
  | PermissionRequestedPayload
  | PermissionResolvedPayload
  | PermissionDeniedPayload
  | UserInputAutoResolutionUpdatedPayload
  | WorkspaceHookReviewRequestedPayload
  | WorkspaceHookReviewSettledPayload
  | WorkspaceHookReviewSupersededPayload
  | WorkspaceHookAdmissionUpdatedPayload
  | HookRunLifecyclePayload
  | CompactLifecyclePayload
  | MicrocompactBoundaryEventPayload
  | CheckpointCreatedPayload
  | RewindTriggeredPayload
  | CompactBoundaryPayload;
