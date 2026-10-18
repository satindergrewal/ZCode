/* eslint-disable max-lines -- the ZCode task wrapper service interface carries the app/runtime API together; splitting makes the replacement phase harder to track. */
import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import type { CommandPayloadMap } from "@zcode/shared/zcode-protocol-v4";
import { createServiceDescriptor } from "#src/descriptors.js";
import type {
  ZCodeImportSessionsResult,
  ZCodeImportableSessionCandidate,
  ZCodeSessionCompactResult,
  ZCodeSessionGoalAction,
  ZCodeSessionGoalResult,
  ZCodeTaskCreateResult,
  ZCodeTaskMeta,
  ZCodeStreamEvent,
  ZCodeTaskMode,
  ZCodeConfigOption,
  ZCodeError,
  ZCodeAssistantMessageFeedback,
  ZCodePromptAttachment,
  ZCodeProvider,
  ZCodeWorkspaceEvent,
  TraceId,
  ZCodeSessionFile,
  ZCodeAgentMcpServer,
  ZCodeTaskSnapshot,
  ZCodeTaskSnapshotBody,
  ZCodeTaskSnapshotToolCallsSlice,
  ZCodeTaskSnapshotRefContent,
  ZCodeEnqueueTaskCommandResult,
  ZCodeCancelTaskCommandResult,
  ZCodeTaskClientMode,
  ZCodeTaskTokenUsageResult,
  ZCodePermissionResponse,
  ModelSelection,
  ZCodeBackgroundTurnAttribution,
  ZCodeAutomationBotDeliveryTarget,
} from "@zcode/shared";
import type {
  SessionMessageDeliveryResult,
  SessionMessageSendRequested,
} from "#src/session/sessionMailbox.js";
import type {
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
  ZCodeTaskListSortBy,
  ZCodeTaskListWorkspaceScope,
  ZCodeWorkspaceEventSubscriptionParams,
  ZCodeGroupedTaskView,
  ZCodeGroupedTaskViewOrderInput,
  ZCodeGroupedTaskViewQuery,
  ZCodeGroupedTaskViewStructure,
  ZCodeTaskGroup,
  ZCodeTaskGroupColor,
} from "#src/session/zcodeTaskListTypes.js";

export interface ZCodeTaskSnapshotWithEtagResult {
  snapshot: ZCodeTaskSnapshot | null;
  etag?: string;
  notModified?: boolean;
}

/** The fixed archive-delete set for one workspace; each deduped target falls into exactly one outcome. */
export interface ZCodeArchivedTaskDeletionResult {
  deletedTaskIds: string[];
  skippedTaskIds: string[];
  failedTaskIds: string[];
}

/** A message content piece within one model request (text / tool call / tool result / other raw structure). */
export type ZCodeModelTrajectoryContentPart =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool-call"; toolCallId?: string; toolName: string; input?: unknown }
  | { kind: "tool-result"; toolCallId?: string; toolName?: string; output?: unknown }
  | { kind: "image"; mediaType?: string }
  | { kind: "unknown"; raw: unknown };

/** One conversation message (system / user / assistant / tool). */
export interface ZCodeModelTrajectoryMessage {
  role: string;
  parts: ZCodeModelTrajectoryContentPart[];
}

/** Token usage normalized out of a model_io record. */
export interface ZCodeModelTrajectoryUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
}

export type ZCodeModelTrajectoryCallSourceKind =
  | "main"
  | "sidecar"
  | "subagent"
  | "compact"
  | "unknown";

export interface ZCodeModelTrajectoryCallSource {
  kind: ZCodeModelTrajectoryCallSourceKind;
  querySource?: string;
}

/**
 * One model call (one model_io record). The trail is the time-ordered sequence of calls.
 * request.messages is the full context sent to the model for that call (grows per turn);
 * response is the new content the model produced in that call.
 */
export interface ZCodeModelTrajectoryRecord {
  requestId: string;
  attempt: number;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  turnId?: string;
  traceId?: string;
  callSource?: ZCodeModelTrajectoryCallSource;
  model: {
    modelId?: string;
    providerId?: string;
    role?: string;
    source?: string;
  };
  request: {
    messages: ZCodeModelTrajectoryMessage[];
    toolNames: string[];
  };
  response?: {
    finishReason?: string;
    text?: string;
    reasoningText?: string;
    toolCalls: ZCodeModelTrajectoryContentPart[];
    usage?: ZCodeModelTrajectoryUsage;
    responseId?: string;
    modelId?: string;
  };
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

/** The full model-call trail of one task/session. */
export interface ZCodeModelTrajectory {
  taskId: string;
  /** Whether the runtime supports reading model-io trails (only ZCode Agent persists model-io). */
  available: boolean;
  records: ZCodeModelTrajectoryRecord[];
  /** Absolute path of the matched source file, for triage. */
  sourceFiles: string[];
  /** Whether truncation hit the cap (keeping the most recent N). */
  truncated: boolean;
}

export type {
  ZCodeTaskListKind,
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
  ZCodeTaskListSortBy,
  ZCodeTaskListWorkspaceScope,
  ZCodeWorkspaceEventSubscriptionParams,
  ZCodeGroupedTaskRef,
  ZCodeGroupedTaskView,
  ZCodeGroupedTaskViewNode,
  ZCodeGroupedTaskViewOrderInput,
  ZCodeGroupedTaskViewQuery,
  ZCodeGroupedTaskViewStructure,
  ZCodeGroupedTaskViewStructureMember,
  ZCodeGroupedTaskViewStructureTopOrder,
  ZCodeGroupedTaskViewTopLevelNodeRef,
  ZCodeTaskGroup,
  ZCodeTaskGroupColor,
} from "#src/session/zcodeTaskListTypes.js";

/** Terminal result of one task input round, for background dispatch (scheduled tasks) to write back outcomes. */
export interface ZCodeTaskTerminalOutcome {
  taskId: string;
  /** The input round id (= sendPrompt traceId/inputId) matching exactly one dispatch. */
  inputId?: string;
  outcome: "succeeded" | "failed" | "stopped";
  /** Error message on failure. */
  error?: string;
}

/** One input round fully closed out; the session may safely accept the next input. */
export interface ZCodeTaskReadyOutcome {
  taskId: string;
  reason: "prompt_completed" | "prompt_failed";
}

/**
 * IZCodeTaskService - ZCode task wrapper API service interface
 *
 * UI and the remote controller reach task wrapper state through this layer; core session state lives in
 * the ZCode Agent server, and new features should prefer IZCodeSessionService.
 */
export interface IZCodeTaskService {
  // ---- Lifecycle ----

  /** Whether the agent runtime is available */
  initialize(params: { workspacePath: string }): Promise<{ available: boolean; version?: string }>;

  /** Release idle workspace sessions held only for warmup, so switched-away tabs stop idling */
  releaseWorkspacePreparation(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
  }): Promise<void>;

  // ---- Task/Session management ----

  /** Create a ZCode session and sync the task index. */
  createTask(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    mode?: ZCodeTaskMode;
    /** The formal model selection; once the product submission boundary lands, no model/thoughtLevel split. */
    modelSelection?: ModelSelection;
    /** @deprecated For not-yet-migrated legacy call boundaries only. */
    model?: string;
    /** @deprecated For not-yet-migrated legacy call boundaries only. */
    thoughtLevel?: string;
    draftSessionId?: string;
    forkedFromTaskId?: string;
    mcpServers?: ZCodeAgentMcpServer[];
    /** On scheduled dispatch, mark the owning automation: tasks-index cron_automation_id plus the cron group. */
    automationId?: string;
    /** On off-peak dispatch, mark the owning off-peak task: tasks-index off_peak_task_id. */
    offPeakTaskId?: string;
    /**
     * Headless dispatch creates an empty session then immediately sends the first V4 input. With deferred,
     // input admission persists the session root record before writing the session_input FK ledger.
     */
    deferPersistenceUntilFirstPrompt?: boolean;
    /** Bots/hosts build drafts via native v4 createSession, then configure and send. */
    v4Create?: boolean;
  }): Promise<ZCodeTaskCreateResult>;

  /** Send a prompt to the given task */
  sendPrompt(
    params: {
      taskId: string;
      remoteSessionId?: string;
      traceId: TraceId;
      queryId?: string;
      messageId?: string;
      content: string;
      attachments?: ZCodePromptAttachment[];
      clientId?: string;
      clientLabel?: string;
      clientMode?: ZCodeTaskClientMode;
      /** Extra tools hidden for this turn; merged with session/automation built-in isolation rules. */
      toolDenylist?: string[];
      /** Stable reply-back address for bot-sourced turns; injected by BotsService, not model-controlled. */
      botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
      /** Standard model selection; off-peak tasks also build the Model via Registry / ModelFactory. */
      modelSelection?: CommandPayloadMap["sendText"]["modelSelection"];
      /** Per-run constraints and dynamic auth; idle start-now only, never the normal queue. */
      modelExecution?: CommandPayloadMap["sendText"]["modelExecution"];
    } & ZCodeBackgroundTurnAttribution,
  ): Promise<void>;

  deliverSessionMessage(
    request: SessionMessageSendRequested,
  ): Promise<SessionMessageDeliveryResult>;

  sendSessionMessageDeliveryResult(result: SessionMessageDeliveryResult): Promise<void>;

  /** Submit a task runtime command to the host; on return the owner host has accepted it. */
  enqueueTaskCommand(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    commandId: string;
    traceId: TraceId;
    queryId?: string;
    type: "send_prompt";
    content: string;
    attachments?: ZCodePromptAttachment[];
    clientId?: string;
    clientLabel?: string;
    /** Scheduled dispatch delayed via the host command queue must still carry the automation context. */
    automationId?: string;
    ownerRunId?: TraceId;
  }): Promise<ZCodeEnqueueTaskCommandResult>;

  promoteTaskCommand(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    commandId: string;
    ownerRunId: TraceId;
    clientMode: ZCodeTaskClientMode;
  }): Promise<ZCodeEnqueueTaskCommandResult>;

  cancelTaskCommand(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    commandId: string;
    ownerRunId?: TraceId;
    clientMode: ZCodeTaskClientMode;
  }): Promise<ZCodeCancelTaskCommandResult>;

  /** Stop the generation in progress */
  stopGeneration(params: {
    taskId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    runId?: TraceId;
  }): Promise<void>;

  /** Run the built-in agent /compact; phone replayable still routes via the shared host. */
  compactSession(params: {
    taskId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    inputId?: string;
    instructions?: string;
    expectedRevision?: number;
  }): Promise<ZCodeSessionCompactResult>;

  /** Run the built-in agent /goal; never send /goal as plain body text. */
  goalSession(params: {
    taskId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    inputId?: string;
    action: ZCodeSessionGoalAction;
    objective?: string;
    expectedRevision?: number;
  }): Promise<ZCodeSessionGoalResult>;

  /** Answer a permission request */
  respondPermission(params: {
    taskId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    runId?: TraceId;
    requestId: string;
    optionId: string;
    response: ZCodePermissionResponse;
  }): Promise<boolean>;

  /** Answer a user question request (Elicitation) */
  respondElicitation(params: {
    taskId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    runId?: TraceId;
    requestId: string;
    action: "accept" | "decline" | "cancel";
    content?: Record<string, unknown>;
    clientMode?: ZCodeTaskClientMode;
  }): Promise<boolean>;

  /** Close a task (session/close first; recycle the shared process when the workspace's last task ends) */
  closeTask(params: { taskId: string }): Promise<void>;

  /** Resume a task (reuse the workspace agent process, spawn if absent, then session/load) */
  resumeTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    mode?: ZCodeTaskMode;
    model?: string;
    thoughtLevel?: string;
    /** Resume a scheduled dispatch's targetTaskId with automation tool-surface isolation. */
    automationId?: string;
    /** Off-peak resume of a pre-existing session re-stamps the off-peak mark (new sessions stamped in createTask). */
    offPeakTaskId?: string;
    mcpServers?: ZCodeAgentMcpServer[];
  }): Promise<ZCodeTaskMeta>;

  /** List every persisted task under the workspace */
  listTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta[]>;

  /** Read the global pinned task id list; source of truth tasks-index.sqlite */
  listPinnedTaskIds(): Promise<string[]>;

  /** List pinned tasks of this workspace per tasks-index.sqlite pinned state */
  listPinnedTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta[]>;

  /** Read the workspace's deleted task ids; the persistent negative membership join for sessions-index lists */
  listDeletedTaskIds(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<string[]>;

  /**
   * Aggregate the task list over currently open workspace scopes; source of truth tasks-index.sqlite.
   // Consumers: full-text search (searchable_text/snippets) and the remoteTimelineTaskStore supplement path;
   // no-search lists take listTasks/listPinnedTasks/listArchivedTasks, workspace rows built
   // client-side from endpoint task rows + session detail (converged across surfaces).
   */
  listTaskList(params: ZCodeTaskListQuery): Promise<ZCodeTaskListResult>;

  /** Create a minimal task group; full delete arrives later with group management */
  createTaskGroup(params?: {
    title?: string;
    color?: ZCodeTaskGroupColor;
  }): Promise<ZCodeTaskGroup>;

  /** Rename a task group; workspaceScopes only notifies visible grouped views to refresh */
  renameTaskGroup(params: {
    groupId: string;
    title: string;
    workspaceScopes?: ZCodeTaskListWorkspaceScope[];
  }): Promise<ZCodeTaskGroup>;

  /** Update task group color; workspaceScopes only notifies visible grouped views to refresh */
  updateTaskGroupColor(params: {
    groupId: string;
    color: ZCodeTaskGroupColor;
    workspaceScopes?: ZCodeTaskListWorkspaceScope[];
  }): Promise<ZCodeTaskGroup>;

  /** Delete a task group; callers move its tasks back to root first */
  deleteTaskGroup(params: {
    groupId: string;
    workspaceScopes?: ZCodeTaskListWorkspaceScope[];
  }): Promise<void>;

  // The server-side grouped query returns raw structure only (no tasks join);
  // the renderer projects via task-row partitions + session detail.

  /**
   * Query the grouped view's raw structure (group/member/root order, no tasks join).
   // The client left-joins task-row partitions against this; sessions-index only adds live detail.
   */
  listGroupedTaskViewStructure(params: {
    workspaceScopes: ZCodeTaskListWorkspaceScope[];
  }): Promise<ZCodeGroupedTaskViewStructure>;

  /** Commit grouped view final order and membership in one call; the service persists via a sqlite transaction */
  applyGroupedTaskViewOrder(params: ZCodeGroupedTaskViewOrderInput): Promise<ZCodeGroupedTaskView>;

  /** List every archived task under the workspace */
  listArchivedTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta[]>;

  /** Batch-archive expired tasks; only completed, unread-free, non-pinned, not-currently-open tasks */
  archiveStaleTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    olderThanDays: number;
  }): Promise<ZCodeTaskMeta[]>;

  /** On workspace removal, archive every unarchived task including pinned ones */
  archiveWorkspaceTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta[]>;

  /** Read one task's local persisted snapshot, for history first screen */
  getTaskSnapshot(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    messageLimit?: number;
    byteBudget?: number;
    toolLimit?: number;
    clientMode?: ZCodeTaskClientMode;
    resumeModelPolicy?: "task-index" | "ui-resolved-only";
    model?: string;
    thoughtLevel?: string;
  }): Promise<ZCodeTaskSnapshot | null>;

  /** Read the task snapshot with an ETag, supporting if-none-match to avoid repeated large payloads. */
  getTaskSnapshotWithEtag(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    messageLimit?: number;
    ifNoneMatch?: string;
    byteBudget?: number;
    toolLimit?: number;
    clientMode?: ZCodeTaskClientMode;
    resumeModelPolicy?: "task-index" | "ui-resolved-only";
    model?: string;
    thoughtLevel?: string;
  }): Promise<ZCodeTaskSnapshotWithEtagResult>;

  /** Read the full body of a large message trimmed by the first-screen budget, by bodyRef. */
  getTaskSnapshotBody(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    refId: string;
  }): Promise<ZCodeTaskSnapshotBody | null>;

  /** Read full tool/file-change fields trimmed by the first-screen budget, by ref. */
  getTaskSnapshotRef(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    refId: string;
  }): Promise<ZCodeTaskSnapshotRefContent | null>;

  /** Fetch a tools slice by message + index range, the incremental load after count-based first-screen trimming. */
  getTaskSnapshotToolCallsSlice(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    messageIndex: number;
    startToolIndex: number;
    limit: number;
  }): Promise<ZCodeTaskSnapshotToolCallsSlice | null>;

  /** Read one task's light meta (no messages/fileChanges), the fallback for title/provider display */
  getTaskMeta(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta | null>;

  /** Read the active task's in-memory config options; no workspace warmup fallback */
  getTaskConfigOptions(params: { taskId: string }): Promise<ZCodeConfigOption[]>;

  /** Read the bound session's original model selection; never inferred from menus, no resolution or writes. */
  getTaskModelSelection(params: { taskId: string }): Promise<ModelSelection | null>;

  /** Persist the user's local feedback on an assistant reply; never injected into provider context. */
  setAssistantMessageFeedback(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    turnIndex: number;
    feedback: ZCodeAssistantMessageFeedback | null;
  }): Promise<ZCodeSessionFile>;

  /** Scan importable Claude native sessions; optional workspace filter. */
  scanImportableClaudeSessions(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    modifiedSince?: number;
    limit?: number;
  }): Promise<ZCodeImportableSessionCandidate[]>;

  /** Import chosen Claude native sessions, generating a minimal task snapshot; without workspacePath, import under the original workspace. */
  importClaudeSessions(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    sessionIds: string[];
  }): Promise<ZCodeImportSessionsResult>;

  /** Switch the task mode */
  setMode(params: { taskId: string; mode: ZCodeTaskMode }): Promise<void>;

  /** Switch configOption (model, thought level, ...), returning the updated configOptions list */
  setConfigOption(params: {
    taskId: string;
    traceId: TraceId;
    configId: string;
    value: string;
  }): Promise<ZCodeConfigOption[]>;

  /** Switch model, returning the server-authoritative configOptions */
  setModel(params: {
    taskId: string;
    traceId: TraceId;
    modelSelection: ModelSelection;
  }): Promise<ZCodeConfigOption[]>;

  /** Scheduled-dispatch only: converge model, Think, and permission mode, updating the V4 conversation projection. */
  setAutomationSessionConfig(params: {
    taskId: string;
    traceId: TraceId;
    modelSelection: ModelSelection;
    thoughtLevel?: string;
    mode?: ZCodeTaskMode;
  }): Promise<ZCodeConfigOption[]>;

  /** Get the ZCode Agent's current structured log file path. */
  getTaskNativeSessionLogFile(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{
    provider: ZCodeProvider | null;
    path: string | null;
    exists: boolean;
  }>;

  /**
   * Read the task's model-call trail (model-io JSONL under ~/.zcode/cli/{debug,rollout}).
   // The taskId is the ZCode Agent sessionId; match model-io records by sessionId.
   */
  getModelTrajectory(params: {
    taskId: string;
    /** Max calls returned (newest N by time), default 200. */
    limit?: number;
  }): Promise<ZCodeModelTrajectory>;

  /** Read a task/session's cumulative model token usage from the agent usage DB. */
  getTaskTokenUsage(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskTokenUsageResult>;

  /** The task persisted-snapshot file path ({taskId}.json; soft-deleted uses .deleted.json) */
  getTaskSessionFilePath(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{
    path: string;
    exists: boolean;
  }>;

  /**
   * Restart the workspace's ZCode Agent shared process.
   // Used when config changes require re-reading the process environment.
   // Pass resumeTaskId to reattach the current chat right after restart.
   */
  restartWorkspaceProcess(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    resumeTaskId?: string;
    bumpRuntimeEpoch?: boolean;
  }): Promise<void>;

  /** Mark a persisted task list-invisible; CLI session content stays */
  deleteTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void>;

  /** Delete only while still archived; false when restored/deleted/missing, and never cleans the CLI session. */
  deleteArchivedTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<boolean>;

  /** Archive-conditioned delete per item, one list notification per batch; never cleans CLI sessions. */
  deleteArchivedTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskIds: string[];
  }): Promise<ZCodeArchivedTaskDeletionResult>;

  /** Rename a persisted task */
  renameTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    title: string;
  }): Promise<ZCodeTaskMeta>;

  /** Update task pinned state */
  setTaskPinned(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    pinned: boolean;
  }): Promise<ZCodeTaskMeta>;

  /** Update task read state */
  setTaskUnread(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    unread: boolean;
    /** Read compare-and-clear only; absent keeps the legacy unconditional write. */
    expectedUnreadAt?: number;
  }): Promise<ZCodeTaskMeta>;

  /** Archive a task, hiding it from the default list */
  archiveTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta>;

  /** Unarchive a task, back into the default list */
  unarchiveTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta>;

  /** Branch a blank new session from the source task's config, for re-editing one user input. */
  branchTaskFromPrompt(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sourceTaskId: string;
  }): Promise<ZCodeTaskCreateResult>;

  // ---- Streaming events ----

  /** Subscribe to a task's streaming updates (ProxyChannel dynamic event) */
  onDynamicStreamEvent(taskId: string): Event<ZCodeStreamEvent>;

  /**
   * Subscribe to a task's terminal results (succeeded / failed / stopped).
   // Built on the task index's always-on session subscription, independent of whether the renderer watches,
   // so background dispatch (scheduled tasks) reliably gets terminals; writes automation_runs.outcome.
   */
  onDynamicTaskTerminalOutcome(taskId: string): Event<ZCodeTaskTerminalOutcome>;

  /**
   * Subscribe to a task's input-ready boundary. sendPrompt returns only the remote ACK, not agent idleness;
   // Host runtime recycle waits for this event, so closing a workspace never cuts a running Agent.
   */
  onDynamicTaskReady(taskId: string): Event<ZCodeTaskReadyOutcome>;

  /** Subscribe to workspace+task streaming updates, avoiding same-taskId cross-workspace crosstalk. */
  onDynamicTaskEvent(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    clientId?: string;
    deliveryKind?: "continuous" | "bot-channel-continuous" | "replayable" | "mixed";
  }): Event<ZCodeStreamEvent>;

  /**
   * Subscribe to workspace-level async notices (e.g. slash commands/configOptions pushed by the prewarming Agent).
   // Covers the pre-creation gap so the UI updates draft toolbar/command lists live.
   // Named per the ProxyChannel onDynamic prefix so the RPC proxy treats it as a dynamic event.
   */
  onDynamicWorkspaceEvent(
    workspace: string | ZCodeWorkspaceEventSubscriptionParams,
  ): Event<ZCodeWorkspaceEvent>;

  /** Global error event */
  onError: Event<ZCodeError>;
}

export const IZCodeTaskService = createServiceDescriptor<IZCodeTaskService>(
  ServiceChannels.ZCodeTask,
);
