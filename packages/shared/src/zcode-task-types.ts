/* oxlint-disable eslint(max-lines) -- ZCode task projection types stay in one file for now; new workspace events keep declaring locally. */
// -- Legacy protocol compat surface (transition) ------------------------------
// Remaining 29 exports: workspace prewarm/workspace events, turn-steer results, session binding/import,
// trace/input/query id factories, ZCodeError, ZCodeTaskCreateResult, etc.
// Consumers: the services legacy stack (zcodeAgentService / zcodeTaskServiceAdapter / zcodeTaskService),
// legacy UI stores/projection. The star load-bearing types (ZCodeTaskMeta / ZCodeStreamEvent / ZCodeTaskSnapshot etc.)
// moved to zcode-task-types-core.ts (the surviving surface). This file lives and dies with the legacy task service group.
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

/** Mints a traceId; legacy name kept for callers, format aligned with the agent's UUID traces. */
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

/** Fixed id of the system group that cron-scheduled sessions join by default. */
export const CRON_DEFAULT_GROUP_ID = "zcode-default-group-cron";

/** Fixed id of the system group for dispatched off-peak sessions (isomorphic to the cron group). */
export const OFF_PEAK_DEFAULT_GROUP_ID = "zcode-default-group-off-peak";

type CronTaskIdentity = Pick<ZCodeTaskMeta, "cronAutomationId"> & {
  automationId?: string;
};

/** Whether a task/session was produced by a scheduled trigger. */
export function isCronTask(task: CronTaskIdentity): boolean {
  // Persisted task meta uses cronAutomationId; runtime dispatch/legacy paths name it automationId.
  // Reading only the former leaves fresh/restored scheduled tasks iconless for a while.
  return Boolean(task.cronAutomationId || task.automationId);
}

/** Whether a task/phantom row belongs to off-peak (persisted meta marker only; the UI never queries the off-peak store). */
export function isOffPeakTask(task: Pick<ZCodeTaskMeta, "offPeakTaskId">): boolean {
  return Boolean(task.offPeakTaskId);
}

// ---- ZCode Provider ----
export type ZCodeTaskTarget = ZCodeTaskGoal;
// ---- ZCode task modes ----
// ---- ZCode runtime state ----

/** Workspace-level ZCode initialization state */
export type ZCodeWorkspaceInitStatus = "idle" | "initializing" | "ready" | "failed";

/** Result of prewarming a workspace */
export interface ZCodeWorkspacePrepareResult {
  workspacePath: string;
  preparedSessionId: string;
  version?: string;
  provider: ZCodeProvider;
  /// configOptions from session/new, pushed to the UI during prewarm so the model is chosen early
  configOptions?: ZCodeConfigOption[];
  /// Slash commands the prewarm session already broadcast; draft state may show them directly
  slashCommands?: ZCodeSlashCommand[];
}

// ---- Task metadata ----

/** createTask's result; beyond persisted meta, temporary initialization data for the first screen. */
export interface ZCodeTaskCreateResult extends ZCodeTaskMeta {
  /// First slash commands available at createTask, so none are lost before the UI subscription exists.
  initialSlashCommands?: ZCodeSlashCommand[];
}

/** Source provider of imported native sessions; decoupled from the agent runtime's ZCodeProvider, currently Claude Code only. */
export type ZCodeImportSessionSourceProvider = "claude";

/** Import candidates of external native sessions. */
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
// ---- ZCode streaming events (Host -> Renderer) ----
// ---- New streaming event types ----

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

// ---- Workspace-level events (async notices before task creation, during prewarm) ----

/**
 * Workspace-level events carrying the ZCode agent's async pushes
 *(slash commands, configOptions...) to the UI before a task exists.
 *
 * Versus ZCodeStreamEvent: that binds to a taskId; ZCodeWorkspaceEvent binds to workspacePath, covering the pre-task gap.
 * ZCodeWorkspaceEvent binds to workspacePath, covering the gap before a task exists.
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
   * A remote workspace's / commands are identity-scoped state; workspacePath alone cannot route them.
   * One path may come from several SSH/WSL/Docker sessions; with workspaceIdentity the service/UI converge by workspaceKey.
   */
  workspaceIdentity?: string;
  commands: ZCodeSlashCommand[];
}

export interface ZCodeWorkspaceConfigOptionsUpdate {
  type: "workspace_config_options_update";
  workspacePath: string;
  /**
   * Prewarm config is workspace-identity state too; remote scenarios must carry workspaceIdentity on the event.
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
  /// The host confirmed this terminal state should create background unread; plain status/resume/snapshot closeouts never carry it.
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

// ---- Persisted format ----

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
