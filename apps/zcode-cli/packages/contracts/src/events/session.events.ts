import type { ExecutionOutputPreview } from "../interfaces/execution.port.js";
import type { RuntimeInputPresentation } from "../interfaces/runtime-input-presentation.js";
/* eslint-disable max-lines -- session event contracts live in one file on purpose; spreading them across app/agent protocol types invites drift. */
// ============================================================
// Session Events - All event types for the agent loop
// ============================================================

import type {
  CompactBoundaryPayload,
  CompactTimelinePayload,
  MicrocompactBoundaryPayload,
} from "../compact/index.js";
import type { HookRunLifecyclePayload } from "../hooks/index.js";
import type { HttpClientEgressInfo } from "../interfaces/http-client.port.js";
import type { PermissionOptionsPolicy, PermissionUpdate } from "../interfaces/permission.port.js";
import type {
  MessageVisibility,
  SessionTitleSource,
  SyntheticUserMessageSource,
} from "../interfaces/session-store.port.js";
import type {
  CollaborationMode,
  HighspeedMessageMetadata,
  RiskLevel,
  TurnInputIntentMetadata,
  TurnSteerCommandKind,
  TurnSteerDeliveryMode,
  TurnSteerRejectReason,
  TurnSteerSource,
} from "../interfaces/session.port.js";
import type {
  EventId,
  InteractionRequestOrigin,
  MessageId,
  PartId,
  QueryId,
  SessionId,
  ToolCallId,
  TraceId,
  TurnId,
} from "../interfaces/shared.js";
import type {
  ModelNetworkStatusEvent,
  ModelSelection,
  ModelUsage,
  ModelUsageSummary,
} from "../model/index.js";
import { createModelUsageSummary } from "../model/index.js";
import type { CheckpointCreatedPayload, RewindTriggeredPayload } from "../rewind/index.js";
import type { SkillTelemetryMetadata } from "../skills/index.js";
import type { ModelApiErrorPhase, ModelFailureExceptionKind } from "../telemetry/index.js";
import type { ToolSideEffectScope } from "../tools/contract.js";
import type { SavedWorkflowScope } from "../tools/saved-workflow.js";
import type { GoalCompletionVerificationOutput, SessionGoal } from "../tools/target.js";
import type { ToolResultDisplayPayload } from "../tools/tool-result-metadata.js";
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
  // guide closes without a usable tool batch: the original intent is requeued as a plain queue item in place.
  TurnSteerDeliveryChanged: "turn_steer_delivery_changed",
  // sendQueuedNow atomic promotion: reservation/promoting/rollback all enter the event stream; projections never guess locally.
  TurnSteerDispatchChanged: "turn_steer_dispatch_changed",
  TurnSteerDrained: "turn_steer_drained",
  TurnSteerRejected: "turn_steer_rejected",
  TurnSteerDiscarded: "turn_steer_discarded",
  // session_input and the user message/parts promoted in one transaction; CommandInbox may safely unpin.
  SessionInputPromoted: "session_input_promoted",
  // v4 queue reorder: queue item order changed (reducer reorders queue rows by orderedPendingInputIds).
  TurnSteerReordered: "turn_steer_reordered",
  // v4 input control: queue autoDrain switch (authorization bit behind held's heldQueueInputRequiresChoice).
  QueueAutoDrainChanged: "queue_auto_drain_changed",
  // v4 input control: followup routing mode (enqueue vs guide while running).
  FollowupModeChanged: "followup_mode_changed",
  TurnComplete: "turn_complete",
  TurnError: "turn_error",
  UserMessage: "user_message",
  AssistantMessage: "assistant_message",
  AssistantFeedbackUpdated: "assistant_feedback_updated",
  HighspeedMetricsUpdated: "highspeed_metrics_updated",
  // (2026-09-12): ToolWidgetStateUpdated / SessionPluginUiStateUpdated removed; plugin UI
  // widgetState falls back to renderer memory, no longer via the CLI event stream.
  SystemMessage: "system_message",
  ModelRequest: "model_request",
  ModelSelected: "model_selected",
  TurnExecutionModelFallback: "turn_execution_model_fallback",
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
  // Live progress of a workflow run: one event per engine RunEvent, appended to the **parent**
  // session (the run has no session of its own).
  // The v4 side reduces it into the workflowRuns state key; the v3 side strips it in
  // shouldExposeSessionEventToProtocol. Named with dynamic_ on purpose: the legacy `Workflow`
  // tool's script run events (workflow_started / workflow_completed, script-workflow-runtime.ts)
  // are a different log; identical names would genuinely confuse.
  DynamicWorkflowRunProgress: "dynamic_workflow_run_progress",
  PermissionRequested: "permission_requested",
  PermissionResolved: "permission_resolved",
  PermissionDenied: "permission_denied",
  // MCP resource changes for plugin UI subscription. Live projection only (v4Gateway.ingest, seq 0); never persisted, never cold-recovered.
  PluginUiResourceUpdated: "plugin_ui_resource_updated",
  PluginUiResourceListChanged: "plugin_ui_resource_list_changed",
  /** App-Provided Tools: page-initiated tool calls, live projection only (instance inbox), never persisted. */
  PluginUiInstanceClosed: "plugin_ui_instance_closed",
  PluginUiAppToolCallRequested: "plugin_ui_app_tool_call_requested",
  UserInputAutoResolutionUpdated: "user_input_auto_resolution_updated",
  WorkspaceHookReviewRequested: "workspace_hook_review_requested",
  WorkspaceHookReviewSettled: "workspace_hook_review_settled",
  WorkspaceHookReviewSuperseded: "workspace_hook_review_superseded",
  // Soft gate: emitted on admission state change; pendingCount=0 clears the snapshot field in the projection layer.
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
 * Attachment rendering (additive): lightweight display metadata for user-input attachments,
 * delivered with TurnStarted; the v4 projection fills the userInput row's attachments from it.
 * Carries display-needed fields only, never the content itself (content flows via
 * resolve/persist as FilePart/artifact).
 */
export interface TurnAttachmentMeta {
  fileName: string;
  mime: string;
  bytes: number;
  /** Content reference (local path / artifact URI); absent when no stable reference (data URLs etc). */
  ref?: string;
}

/**
 * Structured payload of workflow notifications.
 * Minted by the emitter side, bounded (summary<=500 / result<=4000 / error<=2000 /
 * reports.preview<=500 each, <=8 items / artifacts<=8, title<=120 / question-context<=4000);
 * kept in manual sync with shared's workflowNotificationMetaSchema.
 * Batch notification turns deliberately carry none - the one-manifest-per-turn mapping does not
 * hold under batching.
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
       *
       * ⚠ Terminology: artifact here is a product the script published via `artifact.*`,
       * distinct from `result` on the same payload (the script's top-level return value, also
       * called artifact in engine terms).
       */
      artifacts?: {
        id: string;
        kind: "file" | "markdown" | "chart" | "table" | "metrics" | "board";
        title?: string;
        version: number;
        contentType?: string;
        /** The run's deliverable; leads the manifest. The only one with `description` (read by the completion card's deliverable row). */
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
  /**
   * The script reached a hole (the `hole` payload of
   * docs/dynamic-workflow/transcript-and-notifications.md): the main agent owes this run a piece
   * of code. `prompt` <=4000 (same bound as escalation questions); `before` / `after` are the
   * phase names around the hole; `draftPath` / `line` point into the run draft. Exactly one per
   * `hole-reached`.
   */
  | {
      kind: "hole";
      siteId: string;
      ordinal: number;
      name: string;
      type: string;
      prompt?: string;
      draftPath?: string;
      line?: number;
      before?: string;
      after?: string;
      reachedAt?: number;
    }
  /** Run-level stall: one per stall segment, not a terminal state. */
  | {
      kind: "stall";
      sinceMs: number;
      reason?: string;
      cap?: number;
    };

/** Display metadata of a standalone background-result turn; batch turns may reuse the representative task identity and synthesize a title, never parsed back from notification text. */
export interface BackgroundResultOriginMeta {
  /** `workflow` is a dynamic-workflow run (workId == runId) reusing the whole background notification pipeline. */
  backgroundSource: "bash" | "subagent" | "workflow";
  workId: string;
  title: string;
  /** Present only on single-notification turns with backgroundSource === "workflow"; the only data source of the manifest render. */
  workflowNotification?: WorkflowNotificationMeta;
}

/**
 * Whether the turn carries real Agent execution. controlOnly only creates timeline boundaries
 * for visible control inputs; it must not advance session running/activeWorks nor produce
 * "working/worked" states.
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
 * Launch-turn metadata of a hub-launched saved workflow. Written to both the user message's
 * `metadata` (cold-recovery source) and the `TurnStarted`
 * payload (live-projection source) - hot and cold share one shape; projections draw the launch
 * card from it instead of displaying text.
 */
/** Only the create_workflow projection is allowed in launch metadata display (same shape as the shared row schema). */
export type WorkflowLaunchDisplay = Extract<ToolResultDisplayPayload, { kind: "create_workflow" }>;

/**
 * "What changed" of the settings turn
 * (docs/dynamic-workflow/launch.md "The settings turn"): only changed settings present; a
 * missing from/to end means that end is the default (model = session model, cap = default
 * concurrency). `ceiling` is the default concurrency D (the online key predates the "default
 * concurrency" concept, kept for compatibility) for readings like "default 13 -> 4". Same shape
 * as shared's `workflowSettingsAmendMetaSchema`.
 */
export interface WorkflowSettingsAmendMeta {
  /**
   * The run replaced (or continued) by this adjustment. **Absent means applied in place**
   * (docs/dynamic-workflow/launch.md "The settings turn"): when only the concurrency cap changed
   * and the run is still in flight, the "configure" action neither stops the run nor starts
   * another, so there is no predecessor to point at - `runId` is the adjusted run itself.
   * Same shape as shared's `workflowSettingsAmendMetaSchema` (which notes the legacy-desktop skew).
   */
  predecessorRunId?: string;
  subagentModel?: { from?: string; to?: string };
  maxConcurrency?: { from?: number; to?: number };
  ceiling?: number;
}

export interface WorkflowLaunchMeta {
  /** Run identity (== backgroundTaskId == cancelBackgroundWork workId). */
  runId: string;
  /**
   * Synthetic toolCall id that launched the run (hub launch `launch-<uuid>`, settings turn
   * `settings-<uuid>`; tool card -> detail page linkage key).
   */
  toolCallId: string;
  /**
   * Workflow name (a resolution result, not user/model-overridable); both the launch card title
   * and the session title take it. Always present on hub launches; a settings turn takes the
   * adjusted run's own name, absent for unnamed runs (the UI uses fallback wording, never the
   * run id as title).
   */
  name?: string;
  /** Resolved effective scope (not the possibly-absent request scope). Hub launches only: a settings turn has no saved file to point at. */
  scope?: SavedWorkflowScope;
  /** Where the saved file lives, for detail/diagnostics; not used by execution. Hub launches only. */
  path?: string;
  /** This run's args (validated against declarations, defaults filled); bounded, see {@link boundWorkflowLaunchMeta}. */
  args?: Record<string, unknown>;
  /** Workflow description (saved metadata description), bounded <= 500 chars. */
  description?: string;
  /**
   * The `create_workflow` result display compiled before launch (bounded causality graph +
   * diagnostics), same projection and constructor as the CreateWorkflow tool row `display`. The
   * run-detail side panel finds the "launching row" by toolCallId to get the graph - a direct
   * launch has no tool row, so the graph comes from here.
   */
  display?: WorkflowLaunchDisplay;
  /**
   * Verbatim script this run actually executes (same bytes as `port.submit.scriptText`). The tool
   * path puts it on tool input `input.script` for the side panel's Script section; this is the
   * same fact landing on the launch turn; bounded, see {@link WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS}
   * (over-bounds drops the whole field, and the side panel's Script section with it).
   */
  script?: string;
  /** Settings turns only: which run this was amended from via "configure", and what changed. */
  amend?: WorkflowSettingsAmendMeta;
}

/** JSON serialization cap (bytes) of {@link WorkflowLaunchMeta.args}. Over the cap it is dropped for a marker key. */
export const WORKFLOW_LAUNCH_ARGS_MAX_BYTES = 4_096;
/** Character cap of {@link WorkflowLaunchMeta.description}. */
export const WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS = 500;
/**
 * Character cap of {@link WorkflowLaunchMeta.script}. The tool path's `input.script` already
 * enters the transcript unbounded; this picks a limit far above any reasonable dwf script yet
 * able to stop an accidentally-embedded whole repo. Over the cap the field is dropped whole
 * rather than truncated (half a script is meaningless for the Script section; the graph remains
 * in display).
 */
export const WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS = 256_000;
/**
 * Stand-in key when args overflow. True args always travel the model surface's canonical
 * sentence (untruncated there); this metadata only feeds the launch card - a 4KB arg bag has no
 * card rendering anyway, so it is wholesale replaced by one readable marker instead of being
 * crammed in. The ellipsis is the key: it falls outside `SAVED_WORKFLOW_NAME_PATTERN` and cannot
 * collide with a real arg name.
 */
export const WORKFLOW_LAUNCH_ARGS_TRUNCATED_KEY = "…";

/**
 * Pull launch-turn metadata within bounds. Args serialization over
 * {@link WORKFLOW_LAUNCH_ARGS_MAX_BYTES} is wholesale replaced by the
 * `{ "…": "arguments omitted (N bytes) }` marker (see {@link WORKFLOW_LAUNCH_ARGS_TRUNCATED_KEY});
 * description over {@link WORKFLOW_LAUNCH_DESCRIPTION_MAX_CHARS} is truncated with an ellipsis.
 * Called in place at minting so message metadata and the TurnStarted payload get the same
 * bounded values.
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
  // display was already bounded at construction (createCreateWorkflowDisplay + boundCausalityGraph); passed through verbatim.
  if (input.display !== undefined) bounded.display = input.display;
  if (input.script !== undefined && input.script.length <= WORKFLOW_LAUNCH_SCRIPT_MAX_CHARS) {
    bounded.script = input.script;
  }
  // The amend block is bounded itself (both model strings come from already-resolved canonical forms, under the same cap as run state).
  if (input.amend !== undefined) bounded.amend = input.amend;
  return bounded;
}

export interface TurnStartedPayloadBase {
  /** Monotonic epoch ms of the execution entry; hooks/persistence happen before TurnStarted is published, so publish time cannot backderive execution start. */
  executionStartedAt?: number;
  turnNumber: number;
  input: string;
  /**
   * The v4 file summary queries by turn rowId, but workspace checkpoint anchors recovery on the
   * user messageId; TurnStarted must carry the same persistent id so the projection can join the
   * userInput row to its checkpoint.
   */
  messageId?: MessageId;
  inputId?: string;
  /** Admission-only passthrough to the body-less telemetry fact; not derivable from session ownership. */
  /** Stable cancellation identity covering primary turn -> goal verify/continue within one runtime command. */
  foregroundExecutionId?: string;
  queryId?: QueryId;
  inputSource?: SyntheticUserMessageSource;
  inputVisibility?: MessageVisibility;
  /**
   * Launch-turn metadata of a hub-launched saved workflow (present when
   * `inputSource === "workflow_launch"`). The live projection draws the launch card from it;
   * aligned with the same copy in message metadata (hot/cold same shape).
   */
  workflowLaunch?: WorkflowLaunchMeta;
  /** Defaults to agent; keeps old events and historical transcripts parsing. */
  executionKind?: TurnExecutionKind;
  /**
   * Index in `input` from which the text is engine-appended (dwf ask epilogue / nudge); the GUI
   * folds it into a disclosure; 0 = all of it is; absent = none. Aligned with the same copy in
   * message metadata (hot/cold same shape).
   */
  epilogueStart?: number;
  /** Structured origin of an idle background wake; active-loop merges never create a standalone TurnStarted. */
  originMeta?: BackgroundResultOriginMeta;
  /** Passed through only when every member of one background notification batch shares a source; mixed sources stay empty. */
  backgroundSource?: BackgroundResultOriginMeta["backgroundSource"];
  targetId?: string;
  /** Attachment metadata of this turn's user input (absent when none). */
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
  /** Tool names hidden from the provider when the currently queued input is consumed. */
  toolDisallowlist?: readonly string[];
  /** Delivery semantics: queue = split a new product turn on consumption; guide = inline into the current turn. */
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
  /** Full intent after the redelivery; reducer/cold replay never guess delivery from side state. */
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
   * Drain facts carry their own text and persistent messageId so projections no longer depend on
   * in-memory queue state for text (a missing queue item would silently drop the user row).
   * `delivery` decides the split-turn semantics; default queue (one turn per item).
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
  // user_removed (v4 single-item queue delete): the user explicitly removed one item, distinct from turn-lifecycle drops.
  // promoted: sendQueuedNow has taken execution; only removed from the queue projection; session_input
  // must stay admitted until the user message's atomic promotion (or discarded after restart).
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
  /** Count of this query's model products successfully committed to provider-visible persistent history. */
  historyRoundCount?: number;
  duration: number;
  inputId?: string;
  resultType: TurnResultType;
  /** Whether this turn consumed a background result notification from a subagent. */
  backgroundSubagentResultConsumed?: boolean;
  /** Whether this turn consumed a background notification from a workflow (dynamic-workflow run). */
  workflowResultConsumed?: boolean;
  /** Internal preemption (e.g. sendQueuedNow) ends only the current turn; not the user's manual Stop of the queue. */
  preserveQueueAutoDrainOnCancel?: boolean;
}

export interface TurnErrorPayload {
  error: ErrorPayload;
  turnPhase: string;
  inputId?: string;
  /** Whether this turn consumed a background result notification from a subagent. */
  backgroundSubagentResultConsumed?: boolean;
  /** Whether this turn consumed a background notification from a workflow (dynamic-workflow run). */
  workflowResultConsumed?: boolean;
}

export type TurnResultType =
  | "success"
  // "cancelled": a user-initiated interrupt (TurnCancelled) is a normal ending, reported via TurnComplete not TurnError.
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

export interface HighspeedMetricsUpdatedPayload {
  entityId: string;
  highspeed: HighspeedMessageMetadata;
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
  /** Shared with the foreground runtime command that triggered the verification; Stop's stale guard. */
  foregroundExecutionId?: string;
  /** When sendQueuedNow preempts the verifier, only the goal pauses, not the future queue. */
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
  /** Reasoning resolved by Active Model; execution-fact/display projections only, not part of the sparse Selection. */
  effectiveReasoningLevel?: string;
  /** Absent: only the current selection updated; null: an explicit empty->selection model boundary. */
  previousModelSelection?: ModelSelection | null;
  /** Carried only when the Agent auto-recovers the model; absent on normal selections and old events. */
  origin?: ModelSelectionOrigin;
  /** Thought-level capability of the current selection; published atomically with the model selection. */
  supportedThoughtLevels?: string[];
  /** Context window the runtime actually applied for this selection; null means explicitly cleared; absent on old events. */
  contextWindow?: number | null;
}

/**
 * Why the execution Selection fell back to the session Selection; same value domain as
 * @zcode/shared's selectionFallback rules: card expiry hits the declared provider error codes,
 * any other accelerated-request failure is request_failed.
 */
export type TurnExecutionModelFallbackReason =
  | "highspeed_card_expired"
  | "highspeed_request_failed";

export interface TurnExecutionModelFallbackPayload {
  inputId?: string;
  reason: TurnExecutionModelFallbackReason;
  /**
   * Post-refactor, the per-turn execution model is expressed uniformly as a sparse Selection
   * (the old ModelRef is gone): from is this turn's execution-scope accelerated Selection, to is
   * the session's resident Selection.
   */
  fromModelSelection: ModelSelection;
  toModelSelection: ModelSelection;
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
  /** Total tool calls assembled by the current model request; may be absent on old events. */
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
   * This call's **resolved** side-effect capability (tool metadata + runtime capability resolved
   * from the input, e.g. Bash's read-only command detection). Emitted before the handler acts,
   * so subscribers know "writes are coming" before the first byte lands - dynamic-workflow's
   * driver closes amend-resume's import cache on it (`isWorkspaceMutatingToolCall`). Optional:
   * events predating this field lack it.
   */
  readOnly?: boolean;
  sideEffectScope?: ToolSideEffectScope;
}

export interface ToolCallProgressPayload {
  toolCallId: ToolCallId;
  toolName?: string;
  elapsedMs?: number;
  /** MCP `notifications/progress` (A8): progress / total / message forwarded verbatim. */
  progress?: number;
  total?: number;
  message?: string;
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
  /** Skill metadata is telemetry-only, never enters the model-visible result.content. */
  skillMetadata?: SkillTelemetryMetadata;
}

export interface ToolCallErrorPayload {
  toolCallId: ToolCallId;
  error: ErrorPayload;
  /** Skill metadata is telemetry-only, never enters the model-visible error body. */
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
  // "workflow" = a workflow run (CreateWorkflow). The tracker already dispatches behavior per
  // lifecycleProvider; taskKind only drives panel grouping and icon, so widening it is a pure
  // display fix touching no lifecycle semantics.
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
 * One workflow run progress event (parent session). Fields match {@link DynamicWorkflowRunEvent} -
 * **one serialization, two consumers**: listEvents' event page and this session event share the
 * same bounded payload, so readers need no second interpretation rule. `type` is taken by the
 * session-event envelope, hence the engine event kind is `eventType`.
 */
export interface DynamicWorkflowRunProgressPayload {
  runId: string;
  /** CreateWorkflow tool call that launched this run (tool card -> detail page linkage key). */
  toolCallId?: ToolCallId | string;
  /** Journal sequence (monotonically assigned by `appendEvent`); same ruler as the event log cursor. */
  sequence: number;
  /** Engine event kind: run-started / actor-created / node-* / usage-updated / log / report / phase-entered / run-settled. */
  eventType: string;
  payload: Record<string, unknown>;
  truncated?: boolean;
  /** Derived (toProgressPayload): the subagent session id on `actor-created` (the driver-minted `sess_dwf-...`). */
  actorSessionId?: string;
  /**
   * Derived (same family as `actorSessionId`, see toProgressPayload): the run's
   * `run-launched.inputId`. Only on `actor-created` / `run-settled`, so downstream can attach
   * subagents to the launching turn. Pre-upgrade runs have no `run-launched`; field absent.
   */
  launchInputId?: string;
}

export interface PermissionRequestedPayload {
  approvalMode?: "user-once";
  requestId?: string;
  toolCallId: ToolCallId;
  toolName: string;
  riskLevel: RiskLevel;
  reason: string;
  input: unknown;
  suggestedPermissionUpdates?: PermissionUpdate[];
  origin?: InteractionRequestOrigin;
  /**
   * Tool-declared confirmation preview, produced by the `prepareApproval` hook. Reuses the
   * result channel's display projection so the ask and the result card share one bounded shape,
   * adding no unbounded field.
   */
  display?: ToolResultDisplayPayload;
  fullAccessSupported?: boolean;
  optionsPolicy?: PermissionOptionsPolicy;
}

/** Subscribers identify sandbox instances by (scopeId, generation); the renderer delivers only to generation-matching instances. */
export interface PluginUiResourceSubscriberRef {
  instance: import("@zcode/shared/mcp-apps").McpAppInstance;
  scopeId: string;
  generation: number;
}
export interface PluginUiResourceUpdatedPayload {
  pluginId: string;
  serverName: string;
  uri: string;
  subscribers: PluginUiResourceSubscriberRef[];
}
export interface PluginUiResourceListChangedPayload {
  pluginId: string;
  serverName: string;
  subscribers: PluginUiResourceSubscriberRef[];
}
/** App-Provided Tools: one page tool call awaiting execution, delivered to the single instance among subscribers. */
export interface PluginUiAppToolCallRequestedPayload {
  activity?: boolean;
  cancelled?: boolean;
  pluginId: string;
  serverName: string;
  subscribers: PluginUiResourceSubscriberRef[];
  callId: string;
  toolName: string;
  arguments: Record<string, unknown>;
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
// pendingCount === 0 -> the projection layer nulls snapshot.workspaceHookAdmission (hint bar disappears).
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
  /** Raw message of the deepest non-wrapper frame in the error chain, for client telemetry root-cause. */
  underlyingErrorMessage?: string;
  /** detail/errorDetails/details of the same underlying frame. */
  underlyingErrorDetail?: string;
  type: string;
  message: string;
  attribution?: ErrorAttribution;
  retryable?: boolean;
  stack?: string;
  data?: unknown;
}

/** Carries only aggregatable failure facts - never request bodies, credentials, URLs, or monitoring policy. */
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
  | TurnExecutionModelFallbackPayload
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
  | PluginUiResourceUpdatedPayload
  | PluginUiResourceListChangedPayload
  | PluginUiAppToolCallRequestedPayload
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
