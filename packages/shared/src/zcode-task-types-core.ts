/* oxlint-disable eslint(max-lines) -- re-home artifact: task projection load-bearing types are centralized here to keep a single-file contract surface. */
// Re-home migration artifact (paves the way for deleting the legacy protocol tree).
// This file hosts the star load-bearing types from the legacy task projection still consumed by live stacks: ZCodeTaskMeta / ZCodeProvider /
// ZCodeStreamEvent / TraceId/InputId/QueryId / ZCodePersistedMessage(Part) / ZCodeTaskSnapshot /
// ZCodePlanStep / ZCodePermissionRequest and their dependency closure (including realtime transport base types).
// zcode-task-types.ts / task-realtime.ts keep the legacy protocol compat surface and share the core types here.

import type { ZCodeBackgroundTaskControlItem } from "./background-task-controls.js";
import type { ToolCallDisplay } from "./zcode-protocol-v4/toolDisplay.js";
import type {
  ZCodeContextUsageBreakdownItem,
  ZCodeInteractionRequestOrigin,
  ZCodePermissionResponse,
  ZCodeSessionActiveTurnKind,
} from "./zcode-protocol-legacy-types.js";
import type { ErrorAttribution } from "./zcode-protocol-v4/snapshot.js";

/**
 * ZCode task/session projection shared type definitions
 *
 * Types shared across renderer, host process, and the ZCode agent service.
 */

// ---- Observability ----

/** Full-chain trace ID for logs and observability. */
export type TraceId = string;
/** Attribution ID per user input; used for stop/queue/terminal-state closeout. */
export type InputId = string;
/** Semantic attribution ID per real user query; used for model request headers and per-question observability. */
export type QueryId = string;
// ---- ZCode Provider ----

/** Supported ZCode agent providers; currently only glm. */
export type ZCodeProvider = "glm";
export type ZCodeGlmAgentModelStateUpdateReason =
  | "session_initialized"
  | "model_changed"
  | "thought_level_changed";
export interface ZCodeGlmAgentModelStateOption {
  value: string;
  name: string;
}
export interface ZCodeGlmAgentModelStateUpdatePayload {
  version: 1;
  sessionId: string;
  reason: ZCodeGlmAgentModelStateUpdateReason;
  model: {
    currentValue: string;
  };
  thoughtLevel: {
    enabled: boolean;
    currentValue?: string;
    options: ZCodeGlmAgentModelStateOption[];
  };
  contextWindow: {
    tokens: number;
  };
}
/** External history migration source. Currently only Claude Code; more sources land here later. */
export type ZCodeTaskMigrationSource = "claudeCode";
export type ZCodeTaskGoalStatus = "active" | "paused" | "budget_limited" | "complete";
export type ZCodeTaskTargetChangedAction =
  | "set"
  | "status_updated"
  | "cleared"
  | "usage_accounted"
  | "run_started"
  | "run_finished"
  | "summary_updated";
export type ZCodeTaskTargetChangedSource = "command" | "tool" | "runtime";
export interface ZCodeTaskGoal {
  sessionID: string;
  targetID: string;
  objective: string;
  summaryTitle: string | null;
  status: ZCodeTaskGoalStatus;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  activeInputId?: string | null;
  activeRunStartedAtMs?: number | null;
  activeRunLastSeenAtMs?: number | null;
  time: {
    created: number;
    updated: number;
  };
}
export interface ZCodeTaskGoalStats {
  /** Goal elapsed seconds; from the agent session_target or historical turn projection. */
  timeUsedSeconds: number;
  /** Goal cumulative tokens; prefers goal accounting, falls back to agent per-turn history when needed. */
  tokensUsed: number;
  /** User-set goal token budget; when empty the UI may show the context window. */
  tokenBudget: number | null;
  /** Tokens used in the current session context window. */
  contextUsed: number;
  /** Capacity of the current session context window. */
  contextWindow: number;
  /** Historical tool calls related to the goal. */
  toolCallCount: number;
  /** Triggered goal verifier lifecycle rounds; not the same as runtime turns or user continue count. */
  iterationCount: number;
}
export interface ZCodeGoalVerification {
  nextAction?: string | null;
  passed: boolean;
  reason: string;
}
export type ZCodeGoalVerificationTimelineStatus =
  | "started"
  | "completed"
  | "failed_closed"
  | "cancelled";
export interface ZCodeGoalVerificationTimelineMeta {
  version: 1;
  kind: "synthetic";
  type: "goal_verification";
  display: "separator";
  targetId: string;
  verificationId: string;
  status: ZCodeGoalVerificationTimelineStatus;
  verification?: ZCodeGoalVerification;
  goalIteration?: number;
  /** The verifier divider must anchor to the assistant message that finished the round, not drift by time. */
  anchorAssistantMessageId?: string;
  /** Helps restore same-turn boundary semantics; legacy history may lack it. */
  anchorTurnId?: string;
  startedAt?: number;
  updatedAt: number;
}
export interface ZCodeTodoGroup {
  id: string;
  source: "goal_iteration" | "session";
  goalIteration?: number;
  targetId?: string;
  startedAt?: number;
  updatedAt?: number;
  todos: ZCodePlanStep[];
}
export interface ZCodeTaskGoalChangedPatch {
  action: ZCodeTaskTargetChangedAction;
  source: ZCodeTaskTargetChangedSource;
  target: ZCodeTaskGoal | null;
  previousTarget?: ZCodeTaskGoal | null;
}
// ---- ZCode task modes ----

export type ZCodeTaskMode = "yolo" | "plan" | "edit" | "auto" | "autoEdit" | "build";

export type ZCodeOffPeakRunType = "init" | "resume";

/** Source attribution of a single auto-input round; the two background identities must not coexist. */
export type ZCodeBackgroundTurnAttribution =
  | { automationId: string; offPeakTaskId?: never; offPeakRunType?: never }
  | {
      offPeakTaskId: string;
      offPeakRunType?: ZCodeOffPeakRunType;
      automationId?: never;
    }
  | { automationId?: undefined; offPeakTaskId?: undefined; offPeakRunType?: never };
/** Runtime state of tasks under the current workspace */
export type ZCodeTaskRuntimeStatus =
  | "idle"
  | "creating"
  | "notReady"
  | "restoring"
  | "ready"
  | "streaming"
  | "completed"
  | "failed";
/** Persisted task state recording the result of the last prompt */
export type ZCodeTaskPersistStatus = "running" | "completed" | "error";
export interface ZCodeTaskLastError {
  attribution?: ErrorAttribution;
  code?: string;
  message: string;
  traceId?: TraceId;
  taskId?: string;
}
/**
 * Attachment types supported by the current prompt.
 * Small images go through the agent image block; local files/large images prefer localPath so the agent reads them with its own threshold.
 */
export interface ZCodePromptImageAttachment {
  kind: "image";
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  /** agent ImageContent already carries mimeType, so only the bare base64 payload is kept here. */
  dataBase64?: string;
  /** Real desktop-local path; large images no longer ride in the protocol body, the agent side handles them by path. */
  localPath?: string;
}
export interface ZCodePromptFileAttachment {
  kind: "file";
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Attachment source; clipboard-text means it was persisted from a long-text paste and the agent must treat it as a temp file reference. */
  sourceKind?: "clipboard-text";
  /** Compat fallback for legacy/pathless environments; the new desktop GUI no longer sends base64 for regular files. */
  dataBase64?: string;
  /** Small-text fallback when no local path exists; with localPath the agent reads it itself. */
  textContent?: string;
  localPath?: string;
}
export interface ZCodePromptAudioAttachment {
  kind: "audio";
  filename: string;
  mimeType: string;
  /** agent AudioContent already carries mimeType, so only the bare base64 payload is kept here. */
  dataBase64?: string;
  localPath?: string;
}
/** Video attachments: small web videos use dataBase64; desktop prefers zero-copy localPath. */
export interface ZCodePromptVideoAttachment {
  kind: "video";
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  /** Bare base64 payload; mimeType is carried in its own field. */
  dataBase64?: string;
  /** Real desktop-local path; the agent side reads by path and validates size. */
  localPath?: string;
}
export interface ZCodePromptPdfAttachment {
  kind: "pdf";
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  dataBase64?: string;
  localPath?: string;
}
export type ZCodePromptAttachment =
  | ZCodePromptImageAttachment
  | ZCodePromptAudioAttachment
  | ZCodePromptVideoAttachment
  | ZCodePromptPdfAttachment
  | ZCodePromptFileAttachment;
// ---- Task metadata ----

export type ZCodeTaskInteractionAutoResolution =
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

export interface ZCodeTaskPendingInteraction {
  interactionId: string;
  kind: "permission" | "userInput";
  /** Lightweight tool identity issued by sessions-index; kept for compat when the legacy summary is missing. */
  toolName?: string;
  autoResolution?: ZCodeTaskInteractionAutoResolution;
}

export interface ZCodeTaskMeta {
  /** UI taskId matches the ZCode agent sessionId; used for list selection, log correlation, and session resume. */
  taskId: string;
  /** Session/task-level observability traceId; not used to distinguish single user inputs */
  traceId: TraceId;
  /** Task title (user input or truncated from the first message) */
  title: string;
  /**
   * Whether the user manually overrode the task title.
   *
   * A running agent keeps pushing auto-generated titles; the UI needs to know the current title is manual
   * so that updating status/target/updatedAt does not briefly clobber the manual title.
   */
  titleOverridden?: boolean;
  /** Absolute path of the associated workspace */
  workspacePath: string;
  /**
   * Stable identity of a remote workspace (authority + canonicalPath).
   *
   * Persisting by workspacePath alone writes "same path, different remote host" into the same directory,
   * making task lists, snapshots, and logs cross-read. workspaceIdentity participates in the isolation.
   */
  workspaceIdentity?: string;
  /** App-owned workspace kind; defaults to project and does not participate in workspaceKey. */
  workspacePurpose?: import("./workspacePurpose.js").WorkspacePurpose;
  createdAt: number;
  updatedAt: number;
  mode: ZCodeTaskMode;
  model?: string;
  /**
   * Task-level reasoning effort.
   *
   * When switching effort inside an active task, writing only workspace settings.json
   * would clobber other tasks in the same workspace; writing only the session lets the next prompt be
   * overwritten by workspace defaults. Persist task-local thoughtLevel here and replay it before sending.
   */
  thoughtLevel?: string;
  /**
   * Epoch of the task's last confirmed alignment with the workspace runtime baseline.
   *
   * Deciding "whether to override the current task model" from workspacePreferredModel alone
   * mistakes a within-task model switch on the same supplier for global convergence and clobbers other tasks.
   * runtimeEpoch distinguishes "task keeps its own model" from "runtime baseline changed, convergence needed".
   */
  runtimeEpoch?: number;
  /** Agent provider used when the task was created; treated as "glm" when absent (legacy data compat) */
  provider?: ZCodeProvider;
  /** Migration source; empty for normal tasks, identifies imported native Claude Code history. */
  migrationSource?: ZCodeTaskMigrationSource;
  /**
   * Cron identity marker: which automation this session belongs to.
   *
   * The cron identity must live on the shared ZCodeTaskMeta so persistence, the V4 UI, and service contracts
   * all see it, avoiding fields persisted yet unreachable through the type contract.
   */
  cronAutomationId?: string;
  /**
   * Off-peak identity marker: which off-peak task this session/phantom row belongs to.
   * Sibling of cronAutomationId (off-peak does not reuse cron markers); row id = the sessionId
   * preallocated at creation; the marker is constant from creation through run, for the moon icon and system grouping.
   */
  offPeakTaskId?: string;
  /** Fork artifacts keep the source taskId for localized-title fallback and later tracing. */
  forkedFromTaskId?: string;
  /** For unread tasks, the last time unread was marked/produced; preserves the blue dot across restarts. */
  unreadAt?: number;
  /** Persisted task state recording the result of the last prompt */
  status?: ZCodeTaskPersistStatus;
  /** Queue-head blocking interaction summary from sessions-index, for the sidebar state of unopened background tasks. */
  pendingInteraction?: ZCodeTaskPendingInteraction;
  /**
   * Last failure reason fit for display.
   *
   * When phone remote control disconnects, the realtime task_error may not arrive; recovery only sees meta.status=error
   * without the error body, so users think the send never fired. Persist the failure reason alongside task meta.
   */
  lastError?: ZCodeTaskLastError;
  /** Task-level file-change summary, for list/title display only; real rollback still uses fileChanges */
  changeSummary?: ZCodeTaskChangeSummary;
  /** zcode-cli /goal session objective; null means explicitly cleared. */
  target?: ZCodeTaskGoal | null;
}
export interface ZCodeTaskChangeSummary {
  /** Distinct files touched over the whole task */
  fileCount: number;
  /** Added lines aggregated by final per-file result */
  added: number;
  /** Deleted lines aggregated by final per-file result */
  removed: number;
  /** Summary of files touched by the task */
  files: ZCodeTaskChangedFileSummary[];
}
export interface ZCodeTaskChangedFileSummary {
  path: string;
  added: number;
  removed: number;
  /** Total times this file was written within the task */
  writeCount: number;
  /** Round of the last write; the rollback button reuses it directly */
  lastTurnIndex: number;
}
// ---- ZCode config and command types ----

/** UI projection of ZCode configOptions (extracted from the session/new response) */
export interface ZCodeConfigOption {
  id: string;
  name: string;
  description?: string;
  /** mode | model | thought_level | custom */
  category?: string;
  type: "select" | "boolean";
  currentValue: string | boolean;
  /** Options when type === "select" */
  options?: ZCodeConfigSelectValue[];
}
export interface ZCodeConfigSelectValue {
  value: string;
  name: string;
  description?: string;
  /** Value source: native model list or session-injected entry (for UI dedupe and display control) */
  origin?: "native" | "injected";
  /** Provider/group id owning this model option, for provider -> grouped selection */
  modelProviderId?: string;
  /** Provider/group display name owning this model option */
  modelProviderName?: string;
  /** Missing means capability unknown; empty array means known to have no selectable reasoning level */
  modelThoughtLevels?: string[];
  /** Default reasoning level declared by the model catalog; not a user choice */
  modelDefaultThoughtLevel?: string;
}
export interface ZCodeSlashCommand {
  name: string;
  description: string;
  inputHint?: string;
  /** Command origin; legacy protocol may leave it empty, clients should treat as builtin. */
  source?: "builtin" | "custom";
}
export interface ZCodeTaskModeInfo {
  id: string;
  name: string;
  description?: string;
}
// ---- ZCode streaming events (Host -> Renderer) ----

export type TaskStreamMirrorableEvent = (
  | ZCodeAgentMessageChunk
  | ZCodeAgentThoughtChunk
  | ZCodeToolCall
  | ZCodeToolCallUpdate
  | ZCodePlan
  | ZCodePermissionRequest
  | ZCodeTaskPermissionResponse
  | ZCodeElicitationRequest
  | ZCodeElicitationResponse
  | ZCodeTaskComplete
  | ZCodeTaskRunStarted
  | ZCodeTaskWarning
  | ZCodeTaskError
  | ZCodeConfigOptionUpdate
  | ZCodeAvailableCommandsUpdate
  | ZCodeModeUpdate
  | ZCodeSessionInfoUpdate
  | ZCodeGoalVerificationUpdate
  | ZCodeTaskTokenUsageDelta
  | ZCodeTaskNetworkDebugStatus
  | ZCodeUsageUpdate
  | ZCodeBackgroundTaskControlItemsUpdate
) & { inputId?: InputId };
export type ZCodeStreamEvent = (
  | TaskStreamMirrorableEvent
  | ZCodeGlmAgentModelStateUpdate
  | ZCodeGoalIterationStarted
  | ZCodeTurnSteerQueued
  | ZCodeTurnSteerStatus
  | TaskStreamMirrorBatch
  | ZCodeTaskSnapshotUpdated
) & { inputId?: InputId };
export type ZCodeTurnSteerSource = "plan_approval_feedback" | "workflow_refine_feedback";
export type ZCodeTurnSteerCommandKind = "sendText" | "sendGoalCommand" | "compact";
export interface ZCodeTurnSteerQueued {
  type: "turn_steer_queued";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  queryId?: QueryId;
  pendingInputId: string;
  messageId?: string;
  commandKind?: ZCodeTurnSteerCommandKind;
  source?: ZCodeTurnSteerSource;
  targetTurnId?: string;
  content: string;
  raw?: unknown;
}
export interface ZCodeTurnSteerStatus {
  type: "turn_steer_status";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  queryIds?: QueryId[];
  status: "drained" | "discarded" | "rejected";
  pendingInputIds?: string[];
  injectedMessageIds?: string[];
  targetTurnId?: string;
  reason?: string;
  raw?: unknown;
}
export interface ZCodeAgentMessageChunk {
  type: "agent_message_chunk";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  /** Parent toolCallId; null means the main agent body. */
  parentToolUseId?: string | null;
  /** agent messageId; ZCode synthetic timeline messages use it as the upsert key. */
  messageId?: string;
  content: string;
  zcodeTimeline?: ZCodeTimelineMeta;
}
export interface ZCodeAgentThoughtChunk {
  type: "agent_thought_chunk";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  /** Parent toolCallId; null means main-agent thinking. */
  parentToolUseId?: string | null;
  content: string;
}
export type ZCodeTimelineStatus =
  | "started"
  | "retrying"
  | "skipped"
  | "completed"
  | "failed"
  | "interrupted";
export type ZCodeTimelineTrigger = "manual" | "auto" | "reactive" | "partial" | "session_memory";
export type ZCodeContextCompactionTimelinePhase =
  | "standalone_turn"
  | "pre_request"
  | "mid_turn"
  | "reactive";
export type ZCodeTimelineMeta =
  | ZCodeContextCompactionTimelineMeta
  | ZCodeGoalVerificationTimelineMeta
  | ZCodeSessionForkTimelineMeta;
export interface ZCodeContextCompactionTimelineMeta {
  version: 1;
  kind: "synthetic";
  type: "context_compaction";
  operationId: string;
  status: ZCodeTimelineStatus;
  trigger: ZCodeTimelineTrigger;
  display: "separator";
  /**
   * `/compact` renders an optimistic banner locally before the agent lifecycle event arrives.
   * inputId merges the two, so one compaction does not show "compacting" plus an extra "compacted" row.
   */
  inputId?: InputId;
  /** Retrying after failure must keep the user's original `/compact ...` input. */
  command?: string;
  replace?: boolean;
  reason?: string;
  boundaryId?: string;
  summaryMessageId?: string;
  preCompactTokenCount?: number;
  postCompactTokenCount?: number;
  truePostCompactTokenCount?: number;
  attempt?: number;
  maxAttempts?: number;
  /** Lets the compact phase tell real compaction boundaries such as mid_turn / pre_request apart, instead of guessing by copy in UI/e2e. */
  phase?: ZCodeContextCompactionTimelinePhase;
  startedAt?: number;
  endedAt?: number;
}
export interface ZCodeSessionForkTimelineMeta {
  version: 1;
  kind: "synthetic";
  type: "session_fork";
  display: "separator";
  parentSessionId: string;
  targetMessageId: string;
  /** A pure conversation fork has no workspace checkpoint; jumping back to the parent message relies only on targetMessageId. */
  targetCheckpointId?: string;
  restoredFileCount?: number;
}
export interface ZCodeToolCall {
  type: "tool_call";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  toolId: string;
  /** Parent toolCallId; null means a tool call issued directly by the main agent. */
  parentToolUseId?: string | null;
  input: unknown;
  /** Fixed ZCode tool name; the extra field separates tool identity from legacy kind classification. */
  toolName?: string;
  /** Legacy classification compat; in current ZCode streams this usually equals toolName. */
  kind: string;
  /** agent ToolCall.title, a human-readable title of the current tool action */
  title: string;
  /** Raw agent ToolCall payload; the source of truth when debugging protocol fields */
  raw: unknown;
  /** Skill resolved metadata; for telemetry attribution only. */
  skillMetadata?: {
    qualifiedName?: string;
    pluginId?: string;
    source?: "agents" | "zcode" | "bundled" | "plugin" | "remote";
  };
}
export interface ZCodeToolCallUpdate {
  type: "tool_call_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  toolId: string;
  /** Parent toolCallId; null means a tool call issued directly by the main agent. */
  parentToolUseId?: string | null;
  status: "pending" | "in_progress" | "completed" | "failed" | "denied" | "stopped";
  /**
   * agent ToolCallUpdate.title, optional; may be empty when the agent did not update the title.
   */
  title?: string;
  /** Fixed ZCode tool name; ToolCallResult may carry only toolId, and the service layer backfills from the previous call cache. */
  toolName?: string;
  /** Legacy classification compat; in current ZCode streams this usually equals toolName. */
  kind?: string;
  input?: unknown;
  content?: unknown;
  error?: string;
  /** Raw agent ToolCallUpdate payload; the source of truth when debugging protocol fields */
  raw: unknown;
  /** Skill resolved metadata; for telemetry attribution only. */
  skillMetadata?: {
    qualifiedName?: string;
    pluginId?: string;
    source?: "agents" | "zcode" | "bundled" | "plugin" | "remote";
  };
}
export interface ZCodePlan {
  type: "plan";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  steps: ZCodePlanStep[];
}
export interface ZCodePlanStep {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
}
export interface ZCodePermissionRequest {
  type: "permission_request";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  requestId: string;
  description: string;
  kind: string;
  title?: string;
  options: ZCodePermissionOption[];
  /** Whether the V4 permission may attach user feedback on Deny. */
  freeText?: boolean;
  origin?: ZCodeInteractionRequestOrigin;
  /**
   * Tool-reported confirmation preview, reusing the tool call row display projection (same bounded shape).
   * Absent = plain-text ask (the legacy v3 path strips this field explicitly).
   */
  display?: ToolCallDisplay;
  /** Raw agent RequestPermissionRequest.toolCall payload */
  raw: unknown;
}
export interface ZCodeTaskPermissionResponse {
  type: "permission_response";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  requestId: string;
  optionId: string;
  response: ZCodePermissionResponse;
}
export interface ZCodePermissionOption {
  optionId: string;
  kind: string;
  name: string;
  description?: string;
  response: ZCodePermissionResponse;
}
/** ZCode Elicitation request event, for tools like AskUserQuestion that need user interaction */
export interface ZCodeElicitationRequest {
  type: "elicitation_request";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  requestId: string;
  message: string;
  header?: string;
  options: ZCodeElicitationOption[];
  multiSelect?: boolean;
  /** Multi-question shape of AskUserQuestion; when present the UI collects all answers at once via tabs. */
  questions?: ZCodeElicitationQuestion[];
  /** Current question index synced by the remote control path, keeping AskUserQuestion progress across devices. */
  currentQuestionIndex?: number;
  /** Draft answers synced by the remote control path, keyed answer_0 / answer_1. */
  answerDrafts?: Record<string, string[]>;
  origin?: ZCodeInteractionRequestOrigin;
  /** Raw ElicitationSchema payload */
  schema?: unknown;
}
/** A single ZCode Elicitation question */
export interface ZCodeElicitationQuestion {
  question: string;
  header: string;
  options: ZCodeElicitationOption[];
  multiSelect?: boolean;
}
/** A ZCode Elicitation option */
export interface ZCodeElicitationOption {
  value: string;
  label: string;
  description?: string;
}
/** ZCode Elicitation response event */
export interface ZCodeElicitationResponse {
  type: "elicitation_response";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  requestId: string;
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}
export interface ZCodeTaskComplete {
  type: "task_complete";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  stopReason: string;
  usage?: ZCodeUsage;
}
export interface ZCodeTaskRunStarted {
  type: "task_run_started";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  turnId?: string;
  startedAt: number;
}
export interface ZCodeGoalIterationStarted {
  type: "goal_iteration_started";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  turnId?: string;
  targetId?: string;
  startedAt: number;
}
export interface ZCodeTaskError {
  type: "task_error";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  error: string;
  code?: string;
  detail?: string;
  attribution?: ErrorAttribution;
}
export interface ZCodeTaskWarning {
  type: "task_warning";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  warning: string;
  code?: string;
  detail?: string;
}
export interface ZCodeUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Tokens consumed by reasoning/thinking; mirrors the agent `thoughtTokens`. */
  reasoningTokens?: number;
  /** Cache-hit input tokens */
  cachedInputTokens?: number;
  /** Cache-write input tokens */
  cachedWriteInputTokens?: number;
}
export interface ZCodeContextCacheUsage {
  /** Input tokens of the provider-reported latest main round. */
  inputTokens: number;
  /** Cache-hit tokens of the provider-reported latest main round. */
  cacheReadTokens: number;
  /** Cache-write tokens of the provider-reported latest main round. */
  cacheWriteTokens: number;
  /** Cache hit rate of the latest main-round provider usage; null when unknown. */
  latestHitRate?: number | null;
  /** Main-round requests participating in the cumulative average. */
  hitRateRequestCount?: number;
  /** Total main-round input tokens participating in the cumulative average. */
  totalInputTokens?: number;
  /** Total main-round cache-read tokens participating in the cumulative average. */
  totalCacheReadTokens?: number;
  /** Total main-round cache-write tokens participating in the cumulative average. */
  totalCacheWriteTokens?: number;
  /** Main-round cumulative average cache hit rate the agent returns to the app after normalization; null when unknown. */
  hitRate: number | null;
}
/** Cumulative task token delta pushed after each agent model request completes. */
export interface ZCodeTaskTokenUsageDelta {
  type: "task_token_usage_delta";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  queryId?: QueryId;
  /** Stable dedupe key, usually the ZCode Protocol eventId. */
  eventKey: string;
  eventId?: string;
  querySource?: string;
  usage: ZCodeUsage;
}
export type ZCodeTaskNetworkDebugStatusType =
  | "model_request_started"
  | "model_request_completed"
  | "model_request_failed"
  | "model_retry_scheduled"
  | "model_stream_stalled";
/** Agent model network-state debug event; metadata and redacted headers only, no response body/data. */
export interface ZCodeTaskNetworkDebugStatus {
  type: "task_network_debug_status";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  queryId?: QueryId;
  eventKey: string;
  eventId?: string;
  statusType: ZCodeTaskNetworkDebugStatusType;
  requestId?: string;
  providerId?: string;
  modelId?: string;
  providerKind?: string;
  transport?: string;
  baseURL?: string;
  querySource?: string;
  attempt?: number;
  maxAttempts?: number;
  nextAttempt?: number;
  retryable?: boolean;
  statusCode?: number;
  durationMs?: number;
  delayMs?: number;
  idleMs?: number;
  timeoutMs?: number;
  reason?: string;
  message?: string;
  timestamp?: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestHeaderCount: number;
  responseHeaderCount: number;
}
// ---- New streaming event types ----

/** Agent pushes config changes (e.g. rate-limit model downgrade, mode coupling changes) */
export interface ZCodeConfigOptionUpdate {
  type: "config_option_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  configOptions: ZCodeConfigOption[];
}
/** zcode-cli/GLM agent specific: sync thinking-level options and context window after a model change. */
export interface ZCodeGlmAgentModelStateUpdate extends ZCodeGlmAgentModelStateUpdatePayload {
  type: "glm_agent_model_state_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
}
/** Agent pushes the list of available slash commands */
export interface ZCodeAvailableCommandsUpdate {
  type: "available_commands_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  commands: ZCodeSlashCommand[];
}
/** Agent pushes a mode change (e.g. auto-switch from architect to code) */
export interface ZCodeModeUpdate {
  type: "mode_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  currentModeId: string;
  availableModes: ZCodeTaskModeInfo[];
}
/** Transient state while the agent API hits a retryable error; memory UI only, never persisted to the task.
 * attempt is the retry currently in flight, 1-based; not the total attempt count.
 */
export interface ZCodeApiRetryStatus {
  kind: "api_retry";
  attempt: number;
  maxRetries: number;
  retryDelayMs: number;
  errorStatus: number | null;
  error: string;
}
/** Agent pushes session title and other metadata updates */
export interface ZCodeSessionInfoUpdate {
  type: "session_info_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  title?: string | null;
  /**
   * Optional API retry-state patch.
   *
   * `undefined` means this session_info_update did not touch the field;
   * `null` means explicitly clearing retry state;
   * an object means entering/updating the retrying state.
   */
  apiRetry?: ZCodeApiRetryStatus | null;
  /**
   * /goal state patch projected by zcode-cli through the compat session_info_update._meta.zcode.target.
   * `undefined` means no target change this round; `target: null` clears it.
   */
  target?: ZCodeTaskGoalChangedPatch;
}
export interface ZCodeGoalVerificationUpdate {
  type: "goal_verification_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  verification: ZCodeGoalVerification;
}
/** Agent pushes realtime context-window usage */
export interface ZCodeUsageUpdate {
  type: "usage_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  /** Total context window size (tokens) */
  size: number;
  /** Tokens used so far */
  used: number;
  /** Cumulative cost */
  cost?: { amount: number; currency: string } | null;
  /** Cache-hit info exposed by the latest main-round provider usage. */
  cache?: ZCodeContextCacheUsage;
  /** Agent-estimated context characters by source, for UI ratio display only; not a token ledger. */
  breakdown?: ZCodeContextUsageBreakdownItem[];
}
/** Background task controls reported by the agent runtime; current host memory state only, not written to the session file. */
export interface ZCodeBackgroundTaskControlItemsUpdate {
  type: "background_bash_jobs_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  jobs: ZCodeBackgroundTaskControlItem[];
}
/** Notifies the UI to refetch the snapshot after residual data is flushed, so late streaming data gets rendered */
export interface ZCodeTaskSnapshotUpdated {
  type: "task_snapshot_updated";
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  taskId: string;
  traceId: TraceId;
  reason?: TaskRealtimeReason;
  eventId?: string;
  runId?: string;
  streamWatermark?: TaskStreamWatermark;
}
export type ZCodeTaskClientMode = "desktop-continuous" | "web-remote-replayable";
export type ZCodeTaskRuntimeCommandStatus = "accepted" | "running" | "failed";
export interface ZCodeTaskRuntimeCommandBase {
  commandId: string;
  taskId: string;
  traceId: TraceId;
  queryId?: QueryId;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  status: ZCodeTaskRuntimeCommandStatus;
  createdAt: number;
  updatedAt: number;
  clientId?: string;
  clientLabel?: string;
  error?: string;
}
export interface ZCodeTaskSendPromptCommand extends ZCodeTaskRuntimeCommandBase {
  type: "send_prompt";
  content: string;
  attachments?: ZCodePromptAttachment[];
  /** Host commands dispatched by scheduled tasks must keep the automation context, so CronCreate is not re-exposed after the queue drains. */
  automationId?: string;
}
export type ZCodeTaskRuntimeCommand = ZCodeTaskSendPromptCommand;
export interface TaskStreamMirrorBatch {
  type: "task_stream_mirror_batch";
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceKey: string;
  taskId: string;
  traceId: TraceId;
  runId: string;
  ownerClientId?: string;
  ownerDeviceLabel?: string;
  batchSeq: number;
  fromSeq: number;
  toSeq: number;
  ops: TaskStreamMirrorOp[];
  terminal: boolean;
}
// ---- Persisted format ----

export interface ZCodeSessionFile {
  meta: ZCodeTaskMeta;
  messages: ZCodePersistedMessage[];
  /** File-change records, stored per round */
  fileChanges?: ZCodePersistedFileChange[];
  /** Git checkpoint metadata per round, for undo orchestration only */
  turnCheckpoints?: ZCodePersistedTurnCheckpoint[];
}
export interface ZCodeSessionRuntimeSnapshot {
  pendingPermissions?: ZCodePermissionRequest[];
  pendingElicitations?: ZCodeElicitationRequest[];
  /** Active turn type of the current session; lets the UI tell normal streaming from compact maintenance. */
  activeTurnKind?: ZCodeSessionActiveTurnKind;
  /** Agent API network retries are runtime hints; restored with the snapshot, never written to the session JSON. */
  apiRetry?: ZCodeApiRetryStatus | null;
  /** Context-window usage in the ZCode Protocol projection, for the context meter of restored legacy task UI. */
  contextUsage?: {
    used: number;
    size: number;
    cost?: { amount: number; currency: string } | null;
    cache?: ZCodeContextCacheUsage;
    breakdown?: ZCodeContextUsageBreakdownItem[];
  };
  streamWatermark?: TaskStreamWatermark;
  pendingCommands?: ZCodeTaskRuntimeCommand[];
  /**
   * Restore state projected from the agent session store's persisted todos.
   * The UI only consumes it to restore the todo panel; never written back to the legacy session JSON.
   */
  plan?: ZCodePlanStep[] | null;
  /**
   * Runtime projection of the objective summary; computed on demand from the agent DB / message tool parts, not written to task-index.
   */
  goalStats?: ZCodeTaskGoalStats | null;
  goalVerifications?: ZCodeGoalVerification[] | null;
  goalVerificationTimeline?: ZCodeGoalVerificationTimelineMeta[] | null;
  /**
   * Grouped todos projected from session-history TodoWrite; for restore display only, not the todo source of truth.
   */
  todoGroups?: ZCodeTodoGroup[] | null;
  /** Compat field: host/runtime background task controls; restorable with a snapshot but not persisted to session JSON. */
  backgroundBashJobs?: ZCodeBackgroundTaskControlItem[];
}
export interface ZCodeTaskSnapshotHistory {
  /** Whether the response-state history window trimmed older messages; returned only by getTaskSnapshot, never in session JSON. */
  truncatedBefore: boolean;
  /** Visible message count before trimming, so the UI knows older history can still be fetched. */
  totalMessages: number;
}
export type ZCodeTaskSnapshot = ZCodeSessionFile & {
  /** Non-persisted runtime state, assembled only by getTaskSnapshot; must not be written to session JSON. */
  runtime?: ZCodeSessionRuntimeSnapshot;
  /** Non-persisted history-window metadata, only describing whether this snapshot response is a tail window. */
  history?: ZCodeTaskSnapshotHistory;
  /** Visible command list returned by agent/app communication; restores the `/` panel, never written to session JSON. */
  slashCommands?: ZCodeSlashCommand[];
  /** UI config projected from session settings; returned only with snapshots, never written to session JSON. */
  configOptions?: ZCodeConfigOption[];
};
export type ZCodeTurnFileState = "applied" | "reverted";
/** Persisted per-round file changes */
export interface ZCodePersistedFileChange {
  turnIndex: number;
  snapshots: ZCodePersistedFileSnapshot[];
  /** Whether this round's file changes are still applied to the workspace */
  fileState?: ZCodeTurnFileState;
}
/** Persisted per-round file checkpoint metadata */
export interface ZCodePersistedTurnCheckpoint {
  turnIndex: number;
  /** File-state checkpoint from before the round started */
  baseFileCheckpointId: string;
  /** File-state checkpoint after the round ended; may be empty when incomplete */
  resultFileCheckpointId?: string;
}
/** Persisted file snapshot */
export interface ZCodePersistedFileSnapshot {
  path: string;
  beforeContent: string | null;
  afterContent: string;
  writeCount: number;
  /** Response-state snapshot only: the file snapshot body was trimmed by the first-screen budget; fetch full content by ref. */
  contentRefs?: ZCodeTaskSnapshotFileContentRef[];
}
/** Parts element of a persisted message, recording the interleaved order of content / thought / tool-call.
 *  On history restore it rebuilds the UI-side parts array so text does not pile on top with tool calls below. */
export type ZCodePersistedMessagePart =
  | { type: "content"; content: string }
  | { type: "thought"; content: string }
  | { type: "tool-call"; toolIndex: number };
export type ZCodeAssistantMessageFeedback = "like" | "dislike";
export type ZCodeAssistantCheckpointState = "partial";
export type ZCodeAssistantCheckpointReason = "tool_completed" | "part_boundary" | "periodic";
export interface ZCodePersistedMessage {
  /** Protocol-side original messageId; keeps realtime messages and post-restore timeline dividers the same identity. */
  id?: string;
  /** Original messageIds kept after assistant merge projection, so timeline anchors still hit merged child messages. */
  mergedMessageIds?: string[];
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  /** Legacy goal display iteration the assistant belongs to; UI history status line only, not a verifier round. */
  goalIteration?: number;
  /** Model owning the message when sent; legacy data without it falls back to task.meta.model on read. */
  model?: string;
  /** Plain-text character snapshot; token estimates divide by a constant, recomputable when the formula changes. */
  characterCount?: number;
  /** Final duration of the assistant history entry; persisted at round end so history restore avoids timestamp back-calculation drift */
  durationMs?: number;
  /** Whether the assistant ended by user stop or abnormal interrupt; suppresses promotion into the latest reply area. */
  interrupted?: boolean;
  /** Local user feedback on the assistant reply; ZCode display/stats only, never injected into agent context. */
  feedback?: ZCodeAssistantMessageFeedback;
  attachments?: ZCodePromptAttachment[];
  tools?: ZCodePersistedToolCall[];
  thought?: string;
  /** Interleave order of the message parts, preserving content/tool-call layout on history restore */
  parts?: ZCodePersistedMessagePart[];
  /** While-running assistant snapshot; recovers to the last parts boundary after crash/restart, not a natural round completion. */
  checkpointState?: ZCodeAssistantCheckpointState;
  checkpointReason?: ZCodeAssistantCheckpointReason;
  checkpointUpdatedAt?: number;
  /** Conversation round owning this message, linking per-turn file-change summaries and rollback */
  turnIndex?: number;
  /** Response-state snapshot only: large fields trimmed by the first-screen budget; fetch the full body by ref. */
  bodyRefs?: ZCodeTaskSnapshotBodyRef[];
  /** Response-state snapshot only: slice info when tools were trimmed by count; fetch more tool calls with it. */
  toolSlice?: ZCodeTaskSnapshotToolSlice;
  /** Synthetic divider metadata (context_compaction / session_fork), restored with snapshots for UI dividers. */
  syntheticTimeline?: ZCodeTimelineMeta;
}
export type ZCodeTaskSnapshotBodyField = "content" | "thought";
export interface ZCodeTaskSnapshotBodyRef {
  field: ZCodeTaskSnapshotBodyField;
  refId: string;
  hash: string;
  fullBytes: number;
  previewBytes: number;
}
export type ZCodeTaskSnapshotToolField = "input" | "output" | "raw";
export type ZCodeTaskSnapshotFileContentField = "beforeContent" | "afterContent";
export interface ZCodeTaskSnapshotToolFieldRef {
  field: ZCodeTaskSnapshotToolField;
  refId: string;
  hash: string;
  fullBytes: number;
  previewBytes: number;
}
export interface ZCodeTaskSnapshotFileContentRef {
  field: ZCodeTaskSnapshotFileContentField;
  refId: string;
  hash: string;
  fullBytes: number;
  previewBytes: number;
}
export interface ZCodeTaskSnapshotToolSlice {
  persistedMessageIndex: number;
  totalTools: number;
  startToolIndex: number;
  endToolIndexExclusive: number;
}
export interface ZCodePersistedToolCall {
  /** Fixed ZCode tool name; legacy snapshots may have persisted the title here, readers must stay compat. */
  toolName?: string;
  title?: string;
  kind?: string;
  status?: "completed" | "failed" | "denied" | "stopped";
  input: unknown;
  output?: unknown;
  error?: string;
  raw?: unknown;
  /** Response-state snapshot only: large tool fields trimmed by the first-screen budget; fetch full content by ref. */
  snapshotRefs?: ZCodeTaskSnapshotToolFieldRef[];
}
export type TaskRealtimeReason =
  | "task_created"
  | "user_message_saved"
  | "assistant_message_saved"
  | "task_status_changed"
  | "task_meta_changed"
  // Pure config changes like model switches used to broadcast inside task_meta_changed, so the UI could not tell
  // "membership-related meta changes (rename/unread)" from "config changes unrelated to list membership",
  // making every model switch trigger a global membership refetch plus a full-table refresh. A dedicated reason lets the policy layer downgrade precisely.
  | "task_model_changed"
  // Title updates (first-message title write / post-close auto title) are also membership-unrelated and high-frequency;
  // keeping them in task_meta_changed makes every send/close-out trigger a global membership refetch.
  | "task_title_changed"
  | "task_pinned"
  | "task_unpinned"
  | "task_archived"
  | "task_unarchived"
  | "task_deleted"
  | "stream_mirror_gap"
  | "stream_mirror_owner_lost";
export interface TaskStreamMirrorUserMessageOp {
  kind: "user_message";
  messageId: string;
  content: string;
  attachments?: ZCodePromptAttachment[];
  timestamp: number;
}
export interface TaskStreamMirrorStreamEventOp {
  kind: "stream_event";
  event: TaskStreamMirrorableEvent;
}
export type TaskStreamMirrorOp =
  | (TaskStreamMirrorUserMessageOp & { seq: number })
  | (TaskStreamMirrorStreamEventOp & { seq: number });
export interface TaskStreamWatermark {
  runId: string;
  opSeq: number;
}
