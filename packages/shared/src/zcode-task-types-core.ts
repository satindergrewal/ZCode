/* oxlint-disable eslint(max-lines) -- re-home artifact: load-bearing task projection types centralized to keep a single-file contract surface. */
// re-home migration artifact (paves the way to delete the legacy protocol tree).
// This file hosts the load-bearing types of the legacy task projection still consumed by live stacks:
// ZCodeStreamEvent / TraceId/InputId/QueryId / ZCodePersistedMessage(Part) / ZCodeTaskSnapshot /
// ZCodeTaskMeta/ZCodeProvider/ZCodePlanStep/ZCodePermissionRequest and their closure (incl. realtime transport basics).
// zcode-task-types.ts / task-realtime.ts keep the legacy-compat surface and share these core types.

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
 * Shared type definitions for the ZCode task/session projection.
 *
 * Types shared across renderer, host process, and the ZCode agent service.
 */

// ---- Observability ----

/** End-to-end trace id for logs and observability. */
export type TraceId = string;
/** Ownership id per user input; used for stop/queue/terminal settling. */
export type InputId = string;
/** Semantic attribution id per real user query; model-request headers and per-question observability. */
export type QueryId = string;
// ---- ZCode Provider ----

/** Supported ZCode agent providers; only glm remains. */
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
/** External history migration source. Claude Code only today; extend here for future sources. */
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
  /** Cumulative goal seconds; from the agent session_target or the turn projection. */
  timeUsedSeconds: number;
  /** Cumulative goal tokens; goal ledger first, agent backfill from turn history when needed. */
  tokensUsed: number;
  /** User-set goal token budget; when empty the UI may show the context window. */
  tokenBudget: number | null;
  /** Context-window tokens used in the current session. */
  contextUsed: number;
  /** Context-window capacity of the current session. */
  contextWindow: number;
  /** Historical tool calls attributed to the goal. */
  toolCallCount: number;
  /** Goal-verifier lifecycle rounds fired; distinct from runtime turns or user continue count. */
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
  /** The verifier divider anchors to the assistant message that finished the round, never time-drifting. */
  anchorAssistantMessageId?: string;
  /** Recover the boundary semantics of the same turn; legacy history may lack it. */
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

export type ZCodeTaskMode =
  | "default"
  | "yolo"
  | "guarded"
  | "plan"
  | "edit"
  | "acceptEdits"
  | "auto"
  | "dontAsk"
  | "bypassPermissions"
  | "autoEdit"
  | "build";

export type ZCodeOffPeakRunType = "init" | "resume";

/** Source attribution of one auto-input turn; the two background identities are mutually exclusive. */
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
/** Persisted task state recording the last prompt outcome */
export type ZCodeTaskPersistStatus = "running" | "completed" | "error";
export interface ZCodeTaskLastError {
  attribution?: ErrorAttribution;
  code?: string;
  message: string;
  traceId?: TraceId;
  taskId?: string;
}
/**
 * Attachment kinds supported by the current prompt.
 * Small images ride the agent image block; local files/large images prefer localPath so the agent applies its own threshold.
 */
export interface ZCodePromptImageAttachment {
  kind: "image";
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  /** agent ImageContent carries mimeType itself; only the bare base64 body lives here. */
  dataBase64?: string;
  /** Real desktop-local path; large images skip the protocol body and the agent reads by path. */
  localPath?: string;
}
export interface ZCodePromptFileAttachment {
  kind: "file";
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Attachment origin; clipboard-text means spilled-from-paste, to be treated as a temp file reference. */
  sourceKind?: "clipboard-text" | "topic-history";
  messageCount?: number;
  /** Compat fallback for legacy/pathless environments; the desktop GUI no longer base64s regular files. */
  dataBase64?: string;
  /** Small-text fallback without a local path; with localPath the agent reads it itself. */
  textContent?: string;
  localPath?: string;
}
export interface ZCodePromptAudioAttachment {
  kind: "audio";
  filename: string;
  mimeType: string;
  /** agent AudioContent carries mimeType itself; only the bare base64 body lives here. */
  dataBase64?: string;
  localPath?: string;
}
/** Video attachment: web small clips via dataBase64; desktop prefers zero-copy localPath. */
export interface ZCodePromptVideoAttachment {
  kind: "video";
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  /** Bare base64 body; mimeType travels in its own field. */
  dataBase64?: string;
  /** Real desktop-local path; the agent reads by path and validates size. */
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
  /** Lightweight tool identity from sessions-index; tolerant of legacy summaries. */
  toolName?: string;
  autoResolution?: ZCodeTaskInteractionAutoResolution;
}

export interface ZCodeTaskMeta {
  /** UI taskId mirrors the ZCode agent sessionId for list selection, log correlation, and resume. */
  taskId: string;
  /** Session/task-level observability traceId; never a per-input discriminator */
  traceId: TraceId;
  /** Task title (user input or clipped first message) */
  title: string;
  /**
   * Whether the user manually renamed the task.
   *
   * The agent keeps pushing generated titles; the UI must know the current title is manual
   * so status/target/updatedAt updates never momentarily wash it away.
   */
  titleOverridden?: boolean;
  /** Absolute path of the associated workspace */
  workspacePath: string;
  /**
   * Stable remote-workspace identity (authority + canonicalPath).
   *
   * Persisting by workspacePath alone lets same-path/different-host collide in one directory,
   * cross-reading lists, snapshots, and logs; workspaceIdentity joins the isolation key.
   */
  workspaceIdentity?: string;
  /** App-owned workspace kind; defaults to project, never part of workspaceKey. */
  workspacePurpose?: import("./workspacePurpose.js").WorkspacePurpose;
  createdAt: number;
  updatedAt: number;
  mode: ZCodeTaskMode;
  model?: string;
  /**
   * Task-level reasoning effort.
   *
   * Switching effort inside an active task: workspace settings.json alone would
   * bleed into sibling tasks; session-only changes get pushed back by workspace defaults on
   * the next prompt. Persist task-local thoughtLevel here and replay it into the session pre-send.
   */
  thoughtLevel?: string;
  /**
   * Last epoch where this task confirmed alignment with the workspace runtime baseline.
   *
   * Deciding from workspacePreferredModel alone misreads same-supplier in-task switches
   * as global convergence and clobbers sibling tasks.
   * runtimeEpoch separates model-kept from baseline-moved-needs-converge.
   */
  runtimeEpoch?: number;
  /** Agent provider at task creation; defaults to "glm" (legacy data) */
  provider?: ZCodeProvider;
  /** Migration source; empty for plain new tasks, flags Claude Code native imports. */
  migrationSource?: ZCodeTaskMigrationSource;
  /**
   * Cron identity: which automation owns this session.
   *
   * Cron identity lives on the shared ZCodeTaskMeta so persistence, the v4 UI, and service contracts
   * share it -- a persisted field unreachable through types is a trap.
   */
  cronAutomationId?: string;
  /**
   * Off-peak identity: which off-peak task owns this session/phantom row.
   * Sibling of cronAutomationId (no reuse); the row id is the sessionId preallocated
   * at creation and stable through the run, feeding the moon icon and system grouping.
   */
  offPeakTaskId?: string;
  /** Forks keep the source taskId for localized-title fallback and provenance. */
  forkedFromTaskId?: string;
  /** Last unread mark/raise time; keeps the blue dot across restarts. */
  unreadAt?: number;
  /** Persisted task state recording the last prompt outcome */
  status?: ZCodeTaskPersistStatus;
  /** Head-of-queue blocked-interaction summary from sessions-index, for closed background tasks' sidebar state. */
  pendingInteraction?: ZCodeTaskPendingInteraction;
  /**
   * Presentable reason for the last failure.
   *
   * On phone-remote disconnect the live task_error may never land; recovery sees only meta.status=error,
   * so the reason persists alongside task meta.
   */
  lastError?: ZCodeTaskLastError;
  /** Task-level history-repair state; keeps one-shot migrations from rerunning on snapshot reads. */
  repairState?: ZCodeTaskRepairState;
  /** Task-level file-change summary for list/title display; rollbacks still trust fileChanges */
  changeSummary?: ZCodeTaskChangeSummary;
  /** zcode-cli /goal objective; null means explicitly cleared. */
  target?: ZCodeTaskGoal | null;
}
export interface ZCodeTaskRepairState {
  /** Repair version of Claude-native log backfill for snapshot assistant bodies. */
  claudeNativeSnapshotAssistantContentVersion?: number;
  /** Repair version of Codex-native log backfill for snapshot subagent tool blocks. */
  codexNativeSnapshotSubagentToolsVersion?: number;
}
export interface ZCodeTaskChangeSummary {
  /** Distinct files touched over the whole task */
  fileCount: number;
  /** Added lines aggregated by final per-file outcome */
  added: number;
  /** Deleted lines aggregated by final per-file outcome */
  removed: number;
  /** Per-file summary for the task */
  files: ZCodeTaskChangedFileSummary[];
}
export interface ZCodeTaskChangedFileSummary {
  path: string;
  added: number;
  removed: number;
  /** Total writes to this file within the task */
  writeCount: number;
  /** Turn index of the last write; rollback buttons reuse it directly */
  lastTurnIndex: number;
}
// ---- ZCode config and command types ----

/** UI projection of ZCode configOptions (from the session/new response) */
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
  /** Value origin: native model list or session-injected (UI dedup/display control) */
  origin?: "native" | "injected";
  /** Provider/group id owning this model option, for provider->grouped selection */
  modelProviderId?: string;
  /** Display name of the owning provider/group */
  modelProviderName?: string;
  /** Absent = capability unknown; empty array = known to have no reasoning levels */
  modelThoughtLevels?: string[];
  /** Catalog-declared default reasoning level, never a user choice */
  modelDefaultThoughtLevel?: string;
}
export interface ZCodeSlashCommand {
  name: string;
  description: string;
  inputHint?: string;
  /** Command origin; legacy may omit it -- treat as builtin. */
  source?: "builtin" | "custom";
}
export interface ZCodeTaskModeInfo {
  id: string;
  name: string;
  description?: string;
}
// ---- ZCode stream events (host -> renderer) ----

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
  /** Parent toolCallId; null = main agent prose. */
  parentToolUseId?: string | null;
  /** agent messageId; ZCode synthetic timeline messages upsert by it. */
  messageId?: string;
  content: string;
  zcodeTimeline?: ZCodeTimelineMeta;
}
export interface ZCodeAgentThoughtChunk {
  type: "agent_thought_chunk";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  /** Parent toolCallId; null = main agent thinking. */
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
   * `/compact` renders an optimistic bar locally before the agent lifecycle event lands.
   * inputId merges them so one compaction never shows running-then-appended-done.
   */
  inputId?: InputId;
  /** Retries after failure must keep the original `/compact ...` invocation. */
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
  /** Compaction phase distinguishes real boundaries (mid_turn/pre_request) so UI and e2e never guess from copy. */
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
  /** Pure conversation forks have no workspace checkpoint; jumping back relies on targetMessageId only. */
  targetCheckpointId?: string;
  restoredFileCount?: number;
}
export interface ZCodeToolCall {
  type: "tool_call";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  toolId: string;
  /** Parent toolCallId; null = a tool call issued by the main agent directly. */
  parentToolUseId?: string | null;
  input: unknown;
  //** ZCode canonical tool name; the new field splits tool identity from legacy kind taxonomy. */
  toolName?: string;
  /** Legacy kind taxonomy; on the current stream it usually equals toolName. */
  kind: string;
  /** agent ToolCall.title, a human-readable label for the running action */
  title: string;
  /** Raw agent ToolCall payload; the debug source of truth for protocol fields */
  raw: unknown;
  /** Skill resolved metadata; telemetry attribution only. */
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
  /** Parent toolCallId; null = a tool call issued by the main agent directly. */
  parentToolUseId?: string | null;
  status: "pending" | "in_progress" | "completed" | "failed" | "denied" | "stopped";
  /**
   * agent ToolCallUpdate.title, optional; empty when the agent never renamed it.
   */
  title?: string;
  /** ZCode canonical tool name; ToolCallResult may carry only toolId -- services backfill from the call cache. */
  toolName?: string;
  /** Legacy kind taxonomy; on the current stream it usually equals toolName. */
  kind?: string;
  input?: unknown;
  content?: unknown;
  error?: string;
  /** Raw agent ToolCallUpdate payload; the debug source of truth for protocol fields */
  raw: unknown;
  /** Skill resolved metadata; telemetry attribution only. */
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
  /** Whether the v4 permission flow allows user feedback on Deny. */
  freeText?: boolean;
  origin?: ZCodeInteractionRequestOrigin;
  /**
   * Tool-declared confirmation preview, reusing the tool-call row display projection (same bounded shape).
   * Absent = plain-text ask (the legacy v3 path strips it explicitly).
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
/** ZCode elicitation request, for tools like AskUserQuestion that need user interaction */
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
  /** AskUserQuestion multi-question form; when present the UI collects all answers via tabs at once. */
  questions?: ZCodeElicitationQuestion[];
  /** Current question index synced over remote control; keeps AskUserQuestion progress across devices. */
  currentQuestionIndex?: number;
  /** Draft answers synced over remote control, keyed answer_0/answer_1. */
  answerDrafts?: Record<string, string[]>;
  origin?: ZCodeInteractionRequestOrigin;
  /** Raw ElicitationSchema payload */
  schema?: unknown;
}
/** One ZCode elicitation question */
export interface ZCodeElicitationQuestion {
  question: string;
  header: string;
  options: ZCodeElicitationOption[];
  multiSelect?: boolean;
}
/** One ZCode elicitation option */
export interface ZCodeElicitationOption {
  value: string;
  label: string;
  description?: string;
}
/** ZCode elicitation response event */
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
  inputOrigin?: "desktop" | "mobile";
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
  /** Tokens spent on reasoning/thinking; mirrors the agent's `thoughtTokens`. */
  reasoningTokens?: number;
  /** Cache-hit input tokens */
  cachedInputTokens?: number;
  /** Cache-write input tokens */
  cachedWriteInputTokens?: number;
}
export interface ZCodeContextCacheUsage {
  /** Input tokens of the latest main-turn provider report. */
  inputTokens: number;
  /** Cache-hit tokens of the latest main-turn provider report. */
  cacheReadTokens: number;
  /** Cache-write tokens of the latest main-turn provider report. */
  cacheWriteTokens: number;
  /** Cache hit ratio of the latest main-turn provider usage; null when unknown. */
  latestHitRate?: number | null;
  /** Main-turn requests folded into the running average. */
  hitRateRequestCount?: number;
  /** Main-turn input tokens folded into the average. */
  totalInputTokens?: number;
  /** Main-turn cache-read tokens folded into the average. */
  totalCacheReadTokens?: number;
  /** Main-turn cache-write tokens folded into the average. */
  totalCacheWriteTokens?: number;
  /** Agent-normalized running cache-hit ratio returned to the app; null when unknown. */
  hitRate: number | null;
}
/** Task-level cumulative token delta pushed after each model request. */
export interface ZCodeTaskTokenUsageDelta {
  type: "task_token_usage_delta";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  queryId?: QueryId;
  /** Stable dedup key, usually the ZCode Protocol eventId. */
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
/** Agent model-network status debug event; metadata and redacted headers only, never response bodies. */
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
// ---- Newer stream event types ----

/** Agent-pushed config change (rate-limit model downgrade, mode coupling, ...). */
export interface ZCodeConfigOptionUpdate {
  type: "config_option_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  configOptions: ZCodeConfigOption[];
}
/** zcode-cli/GLM-specific: after a model switch, sync reasoning options and the context window. */
export interface ZCodeGlmAgentModelStateUpdate extends ZCodeGlmAgentModelStateUpdatePayload {
  type: "glm_agent_model_state_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
}
/** Agent pushes the available slash-command list */
export interface ZCodeAvailableCommandsUpdate {
  type: "available_commands_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  commands: ZCodeSlashCommand[];
}
/** Agent pushes a mode change (e.g. architect auto-switching to code) */
export interface ZCodeModeUpdate {
  type: "mode_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  currentModeId: string;
  availableModes: ZCodeTaskModeInfo[];
}
/** Transient state while the agent API hits a retryable error; memory-UI only, never persisted.
 * attempt is the in-flight retry ordinal starting at 1, not the total attempts.
 */
export interface ZCodeApiRetryStatus {
  kind: "api_retry";
  attempt: number;
  maxRetries: number;
  retryDelayMs: number;
  errorStatus: number | null;
  error: string;
}
/** Agent pushes metadata updates such as the session title */
export interface ZCodeSessionInfoUpdate {
  type: "session_info_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  title?: string | null;
  /**
   * Optional API-retry state patch.
   *
   * `undefined`: this session_info_update left the field untouched;
   * `null`: explicitly clear the retry state;
   * object: enter/update the retrying state.
   */
  apiRetry?: ZCodeApiRetryStatus | null;
  /**
   * zcode-cli /goal state patch via the compat session_info_update._meta.zcode.target projection.
   * `undefined`: no target change; `target: null`: cleared.
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
/** Agent pushes live context-window usage */
export interface ZCodeUsageUpdate {
  type: "usage_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  /** Context-window size in tokens */
  size: number;
  /** Tokens used so far */
  used: number;
  /** Cumulative cost */
  cost?: { amount: number; currency: string } | null;
  //** Cache-hit info exposed by the latest main-turn provider usage. */
  cache?: ZCodeContextCacheUsage;
  /** Source-attributed context character estimate for UI ratios; never a token ledger. */
  breakdown?: ZCodeContextUsageBreakdownItem[];
}
/** Background-task control item from the agent runtime; host-memory state only, never written to session files. */
export interface ZCodeBackgroundTaskControlItemsUpdate {
  type: "background_bash_jobs_update";
  taskId: string;
  traceId: TraceId;
  inputId?: InputId;
  jobs: ZCodeBackgroundTaskControlItem[];
}
/** After flushing residual data, tell the UI to re-pull the snapshot so late stream data renders */
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
  /** Scheduled-dispatch host commands must keep the automation context or queue drain re-exposes CronCreate. */
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
// ---- Persisted shape ----

export interface ZCodeSessionFile {
  meta: ZCodeTaskMeta;
  messages: ZCodePersistedMessage[];
  /** File-change records, per turn */
  fileChanges?: ZCodePersistedFileChange[];
  /** Git checkpoint metadata per turn, for undo orchestration only */
  turnCheckpoints?: ZCodePersistedTurnCheckpoint[];
}
export interface ZCodeSessionRuntimeSnapshot {
  pendingPermissions?: ZCodePermissionRequest[];
  pendingElicitations?: ZCodeElicitationRequest[];
  /** Active turn kind of this session; lets UI separate streaming from compact maintenance. */
  activeTurnKind?: ZCodeSessionActiveTurnKind;
  /** Agent API network retries are runtime hints: snapshot-restored only, never in session JSON. */
  apiRetry?: ZCodeApiRetryStatus | null;
  /** Context usage from the ZCode Protocol projection; restores the legacy task UI's context meter. */
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
   * Recovery view mapped from the agent session store's persisted todos.
   * The UI consumes it to restore the todo panel; never written back to legacy session JSON.
   */
  plan?: ZCodePlanStep[] | null;
  /**
   * Runtime projection of the goal summary; computed on demand from agent DB/message tool parts, never into task-index.
   */
  goalStats?: ZCodeTaskGoalStats | null;
  goalVerifications?: ZCodeGoalVerification[] | null;
  goalVerificationTimeline?: ZCodeGoalVerificationTimelineMeta[] | null;
  /**
   * Grouped todos projected from session TodoWrite history; restore display only, never the todo authority.
   */
  todoGroups?: ZCodeTodoGroup[] | null;
  /** Compat field carrying host/runtime background-task control; snapshot-restorable, never in session JSON. */
  backgroundBashJobs?: ZCodeBackgroundTaskControlItem[];
}
export interface ZCodeTaskSnapshotHistory {
  /** Whether the response window trimmed earlier messages; getTaskSnapshot-only, never in session JSON. */
  truncatedBefore: boolean;
  /** Visible message count before trimming; the UI uses it to offer older-history fetch. */
  totalMessages: number;
}
export type ZCodeTaskSnapshot = ZCodeSessionFile & {
  /** Non-persisted runtime state, assembled by getTaskSnapshot only; never into session JSON. */
  runtime?: ZCodeSessionRuntimeSnapshot;
  /** Non-persisted window metadata: whether this snapshot response is the tail window. */
  history?: ZCodeTaskSnapshotHistory;
  /** Visible commands from the agent/app channel; restores the `/` panel, never in session JSON. */
  slashCommands?: ZCodeSlashCommand[];
  /** UI config projected from session settings; snapshot-only, never written back. */
  configOptions?: ZCodeConfigOption[];
};
export type ZCodeTurnFileState = "applied" | "reverted";
/** Persisted per-turn file changes */
export interface ZCodePersistedFileChange {
  turnIndex: number;
  snapshots: ZCodePersistedFileSnapshot[];
  /** Whether this turn's changes are still applied to the workspace */
  fileState?: ZCodeTurnFileState;
}
/** Persisted per-turn file checkpoint metadata */
export interface ZCodePersistedTurnCheckpoint {
  turnIndex: number;
  /** File checkpoint from before the turn */
  baseFileCheckpointId: string;
  /** File checkpoint after the turn; nullable while incomplete */
  resultFileCheckpointId?: string;
}
/** Persisted file snapshot */
export interface ZCodePersistedFileSnapshot {
  path: string;
  beforeContent: string | null;
  afterContent: string;
  writeCount: number;
  /** Response-snapshot only: the body was first-paint-trimmed; fetch full content by ref. */
  contentRefs?: ZCodeTaskSnapshotFileContentRef[];
}
/** Persisted message part recording the content/thought/tool-call interleave.
 *  History restore rebuilds the UI parts array from it, so prose never piles above and tools below. */
export type ZCodePersistedMessagePart =
  | { type: "content"; content: string }
  | { type: "thought"; content: string }
  | { type: "tool-call"; toolIndex: number };
export type ZCodeAssistantMessageFeedback = "like" | "dislike";
export type ZCodeAssistantCheckpointState = "partial";
export type ZCodeAssistantCheckpointReason = "tool_completed" | "part_boundary" | "periodic";
export interface ZCodePersistedMessage {
  /** Protocol-level original messageId; keeps live messages and snapshot-restored dividers the same identity. */
  id?: string;
  /** Original messageIds preserved through assistant merge, so timeline anchors still hit merged children. */
  mergedMessageIds?: string[];
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  /** Legacy goal iteration owning the assistant body; history-row display only, never verifier round logic. */
  goalIteration?: number;
  /** Model owning this message when sent; readers fall back to task.meta.model for legacy rows. */
  model?: string;
  /** Plain-text char count; token estimates divide by a constant, recomputable on policy change. */
  characterCount?: number;
  /** Final assistant duration, persisted at round end so history restore never re-derives it from timestamps */
  durationMs?: number;
  /** Whether the assistant ended by user stop/abort; suppresses latest-reply promotion. */
  interrupted?: boolean;
  /** Local feedback on the assistant reply; ZCode display/stats only, never injected into agent context. */
  feedback?: ZCodeAssistantMessageFeedback;
  attachments?: ZCodePromptAttachment[];
  tools?: ZCodePersistedToolCall[];
  thought?: string;
  /** Part interleaving so history restore keeps the original content/tool-call order */
  parts?: ZCodePersistedMessagePart[];
  /** In-flight assistant snapshot; restores to the last parts boundary after crashes, not a natural completion. */
  checkpointState?: ZCodeAssistantCheckpointState;
  checkpointReason?: ZCodeAssistantCheckpointReason;
  checkpointUpdatedAt?: number;
  /** Conversation turn owning this message; links per-turn change summaries and rollbacks */
  turnIndex?: number;
  /** Response-snapshot only: bulky fields first-paint-trimmed; fetch the full body by ref. */
  bodyRefs?: ZCodeTaskSnapshotBodyRef[];
  /** Response-snapshot only: slice info when tools were count-trimmed; fetch more calls with it. */
  toolSlice?: ZCodeTaskSnapshotToolSlice;
  /** Synthetic divider metadata (context_compaction/session_fork), snapshot-restored for the UI separator. */
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
  /** ZCode canonical tool name; legacy snapshots may have parked title here -- stay tolerant. */
  toolName?: string;
  title?: string;
  kind?: string;
  status?: "completed" | "failed" | "denied" | "stopped";
  input: unknown;
  output?: unknown;
  error?: string;
  raw?: unknown;
  /** Response-snapshot only: bulky tool fields first-paint-trimmed; fetch full content by ref. */
  snapshotRefs?: ZCodeTaskSnapshotToolFieldRef[];
}
export type TaskRealtimeReason =
  | "task_created"
  | "user_message_saved"
  | "assistant_message_saved"
  | "task_status_changed"
  | "task_meta_changed"
  // Pure config changes such as model switches used to ride task_meta_changed, leaving the UI unable to tell
  // ownership meta changes (rename/unread) from ownership-irrelevant config changes --
  // every switch triggered a global membership re-pull plus a full refresh. This reason lets policy degrade precisely.
  | "task_model_changed"
  // Title updates (first-message title, post-turn auto-title) are equally ownership-irrelevant and high-frequency;
  // inside task_meta_changed they would trigger a global membership re-pull on every send/settle.
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
