/* oxlint-disable eslint(max-lines) -- ZCode task projection types stay in one file; new workspace events keep local declarations. */
// -- Legacy protocol compat surface (transitional) ---------------------------
// 29 exports remain: workspace warmup/events, turn-steer results, session binding/import,
// trace/input/query id factories, ZCodeError, ZCodeTaskCreateResult, etc.
// Consumers: the legacy services stack (zcodeAgentService/zcodeTaskServiceAdapter/zcodeTaskService),
// legacy UI stores/projections. The load-bearing stars (ZCodeTaskMeta/ZCodeStreamEvent/ZCodeTaskSnapshot, ...)
// live in zcode-task-types-core.ts now. This file lives and dies with the legacy task services.
import { createUuid } from "./uuid.js";
import type {
  TaskRealtimeReason,
  TraceId,
  InputId,
  QueryId,
  ZCodeTaskGoal,
  ZCodeProvider,
  ZCodeConfigOption,
  ZCodeSlashCommand,
  ZCodeTaskMeta,
  ZCodeTaskRuntimeCommand,
  ZCodeTaskRuntimeCommandStatus,
  ZCodeTaskSnapshotBodyField,
  ZCodeTaskSnapshotToolField,
  ZCodeTaskSnapshotFileContentField,
  ZCodePersistedToolCall,
} from "./zcode-task-types-core.js";

/** traceId factory; legacy name kept for callers, format matches the agent UUID trace. */
export function generateTraceId(_taskId: string): TraceId {
  return createUuid();
}

/** Creates the session-level observability traceId; later prompts inherit, never regenerate. */
export function createSessionTraceId(): TraceId {
  return createUuid();
}

export function createInputId(): InputId {
  return createUuid();
}

export function createQueryId(): QueryId {
  return createUuid();
}

/** Fixed system-group id for sessions created by scheduled (cron) runs. */
export const CRON_DEFAULT_GROUP_ID = "zcode-default-group-cron";

/** Fixed system-group id for dispatched off-peak sessions (mirrors the cron group). */
export const OFF_PEAK_DEFAULT_GROUP_ID = "zcode-default-group-off-peak";

type CronTaskIdentity = Pick<ZCodeTaskMeta, "cronAutomationId"> & {
  automationId?: string;
};

/** Whether a task/session came from a scheduled (cron) run. */
export function isCronTask(task: CronTaskIdentity): boolean {
  // Persisted meta says cronAutomationId; runtime dispatch/legacy paths say automationId.
  // Reading only the former leaves fresh/resumed scheduled tasks iconless.
  return Boolean(task.cronAutomationId || task.automationId);
}

/** Whether a task/phantom row is off-peak (persisted meta only; never query the off-peak store). */
export function isOffPeakTask(task: Pick<ZCodeTaskMeta, "offPeakTaskId">): boolean {
  return Boolean(task.offPeakTaskId);
}

// ---- ZCode Provider ----
export type ZCodeTaskTarget = ZCodeTaskGoal;
// ---- ZCode task modes ----
// ---- ZCode runtime state ----

/** Workspace-level ZCode initialization state */
export type ZCodeWorkspaceInitStatus = "idle" | "initializing" | "ready" | "failed";

/** Result of warming up a workspace */
export interface ZCodeWorkspacePrepareResult {
  workspacePath: string;
  preparedSessionId: string;
  version?: string;
  provider: ZCodeProvider;
  /** configOptions from session/new, surfaced during warmup so the model gets picked early */
  configOptions?: ZCodeConfigOption[];
  /** Slash commands already broadcast by the warmup session; draft state may show them */
  slashCommands?: ZCodeSlashCommand[];
}

/** Pre-warmup reachability check for Codex */
export interface ZCodeCodexConnectivityCheckResult {
  /** Host being checked */
  target: string;
  /** Whether the host reached the target */
  reachable: boolean;
  /** Raw error on failure, for UI logs and toasts */
  error?: string;
}

// ---- Task metadata ----

/** createTask result: persisted metadata plus transient data for first paint. */
export interface ZCodeTaskCreateResult extends ZCodeTaskMeta {
  /** Slash commands available at createTask, so none are lost before the UI subscribes. */
  initialSlashCommands?: ZCodeSlashCommand[];
}

/** Result of adopt-existing-session; never switches the active provider. */
export interface ZCodeSyncTaskSessionBindingResult {
  provider: ZCodeProvider;
  sessionId: string;
  lastSyncedTurnIndex: number;
  updated: boolean;
}

/** Uniform result of a successful `switchAgent`. */
export interface ZCodeSwitchAgentResult {
  meta: ZCodeTaskMeta;
  provider: ZCodeProvider;
  sessionId: string;
  reusedBinding: boolean;
}

/** Source provider of a foreign native import; decoupled from the runtime ZCodeProvider, Claude Code only today. */
export type ZCodeImportSessionSourceProvider = "claude";

/** A foreign native session import candidate. */
export interface ZCodeImportableSessionCandidate {
  provider: ZCodeImportSessionSourceProvider;
  sessionId: string;
  workspacePath: string;
  sourcePath: string;
  updatedAt: number;
  createdAt?: number;
  previewTitle?: string;
}

export interface ZCodeImportedSessionResultItem {
  provider: ZCodeImportSessionSourceProvider;
  sessionId: string;
  taskId: string;
  workspacePath: string;
}

export interface ZCodeImportedSessionSkippedItem {
  provider: ZCodeImportSessionSourceProvider;
  sessionId: string;
  reason: string;
  workspacePath?: string;
}

export interface ZCodeImportSessionsResult {
  imported: ZCodeImportedSessionResultItem[];
  skipped: ZCodeImportedSessionSkippedItem[];
  failed: ZCodeImportedSessionSkippedItem[];
}

// ---- ZCode config and command types ----
// ---- ZCode stream events (host -> renderer) ----
// ---- Newer stream event types ----

export interface ZCodeEnqueueTaskCommandResult {
  accepted: true;
  command: ZCodeTaskRuntimeCommand;
}

export interface ZCodeCancelTaskCommandResult {
  canceled: boolean;
  commandId: string;
  status?: ZCodeTaskRuntimeCommandStatus;
  reason?: "not_found" | "already_running";
}

// ---- Workspace-level events (warmup, pre-task async notices) ----

/**
 * Workspace-level events carrying agent-pushed notices (slash commands, configOptions)
 * to the UI before any task exists.
 *
 * Versus ZCodeStreamEvent: that one binds to a taskId,
 * this one binds to workspacePath across the pre-task window.
 */
export type ZCodeWorkspaceEvent =
  | ZCodeWorkspaceSlashCommandsUpdate
  | ZCodeWorkspaceConfigOptionsUpdate
  | ZCodeWorkspaceTaskListChanged
  | ZCodeWorkspaceSessionMessageSendRequested;

export interface ZCodeWorkspaceSlashCommandsUpdate {
  type: "workspace_slash_commands_update";
  workspacePath: string;
  /**
   * Remote slash commands are identity-scoped; workspacePath alone cannot route them.
   * One path, many SSH/WSL/Docker sessions: workspaceIdentity lets service/UI converge on workspaceKey.
   */
  workspaceIdentity?: string;
  commands: ZCodeSlashCommand[];
}

export interface ZCodeWorkspaceConfigOptionsUpdate {
  type: "workspace_config_options_update";
  workspacePath: string;
  /**
   * Warmup config is identity-scoped too; remote flows carry workspaceIdentity on the event.
   */
  workspaceIdentity?: string;
  configOptions: ZCodeConfigOption[];
}

export interface ZCodeWorkspaceTaskListChanged {
  type: "workspace_task_list_changed";
  workspacePath: string;
  workspaceIdentity?: string;
  taskId?: string;
  reason: "auto_archive" | "realtime_sync" | TaskRealtimeReason;
  taskMeta?: ZCodeTaskMeta;
  /** Host confirmed this terminal state raises a background unread; plain settles never carry it. */
  unreadSignal?: "background_terminal";
}

export interface ZCodeWorkspaceSessionMessageSendRequested {
  type: "workspace_session_message_send_requested";
  workspacePath: string;
  workspaceIdentity?: string;
  request: {
    content: string;
    createdAt: string;
    fromSessionId: string;
    messageId: string;
    requestId: string;
    toSessionId: string;
  };
}

// ---- Errors ----

export interface ZCodeError {
  code: string;
  message: string;
  traceId?: TraceId;
  taskId?: string;
}

// ---- Persisted shape ----

export interface ZCodeTaskSnapshotBody {
  refId: string;
  field: ZCodeTaskSnapshotBodyField;
  content: string;
  hash: string;
  fullBytes: number;
}

export type ZCodeTaskSnapshotRefKind = "tool_field" | "file_change_field";

export interface ZCodeTaskSnapshotRefContent {
  kind: ZCodeTaskSnapshotRefKind;
  refId: string;
  field: ZCodeTaskSnapshotToolField | ZCodeTaskSnapshotFileContentField;
  content: unknown;
  hash: string;
  fullBytes: number;
}

export interface ZCodeTaskSnapshotToolCallsSlice {
  taskId: string;
  messageIndex: number;
  totalTools: number;
  startToolIndex: number;
  endToolIndexExclusive: number;
  tools: ZCodePersistedToolCall[];
}
