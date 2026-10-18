/* eslint-disable max-lines -- the ZCode task wrapper carries the app/runtime API in one place; splitting obscures the replacement. */
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
  ZCodeCodexConnectivityCheckResult,
  ZCodeSwitchAgentResult,
  ZCodeSyncTaskSessionBindingResult,
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

/** Fixed archived-delete sets per workspace; each deduped target lands in exactly one bucket. */
export interface ZCodeArchivedTaskDeletionResult {
  deletedTaskIds: string[];
  skippedTaskIds: string[];
  failedTaskIds: string[];
}

/** One content fragment of a model request (text / tool call / result / other raw). */
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

/** Token usage normalized from a model_io record. */
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
 * One model call (a model_io record); the trajectory is these in time order.
 * request.messages is the full context sent that call (grows per turn);
 * response is the new content the model produced.
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

/** Full model-call trajectory of a task/session. */
export interface ZCodeModelTrajectory {
  taskId: string;
  /** Whether the runtime exposes model-io (only ZCode Agent persists it). */
  available: boolean;
  records: ZCodeModelTrajectoryRecord[];
  /** Absolute path of the matched file, for triage. */
  sourceFiles: string[];
  /** True when truncated to the most recent N entries. */
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

/** Terminal result of a task input turn, for background dispatchers to record. */
export interface ZCodeTaskTerminalOutcome {
  taskId: string;
  /** Input turn id (= sendPrompt traceId/inputId) matching one dispatch. */
  inputId?: string;
  outcome: "succeeded" | "failed" | "stopped";
  /** Error message on failure. */
  error?: string;
}

/** An input turn fully settled; the session may accept the next input. */
export interface ZCodeTaskReadyOutcome {
  taskId: string;
  reason: "prompt_completed" | "prompt_failed";
}

/**
 * IZCodeTaskService - ZCode task wrapper API
 *
 * UI and remote controllers read wrapper state here; core session state lives in
 * the ZCode Agent server; prefer IZCodeSessionService for new work.
 */
export interface IZCodeTaskService {
  // ---- Lifecycle ----

  /** Whether the agent runtime is available */
  initialize(params: { workspacePath: string }): Promise<{ available: boolean; version?: string }>;

  /** Releases idle warmup sessions so switched-away tabs stop spinning */
  releaseWorkspacePreparation(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
  }): Promise<void>;

  /** Pre-warm network check for Codex drafts, warning early when chatgpt.com is unreachable */
  checkCodexConnectivity(): Promise<ZCodeCodexConnectivityCheckResult>;

  // ---- Task/session management ----

  /** Creates a ZCode session and synces the task index. */
  createTask(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    mode?: ZCodeTaskMode;
    /** Canonical model selection; never split model/thoughtLevel again. */
    modelSelection?: ModelSelection;
    /** @deprecated Legacy call sites only. */
    model?: string;
    /** @deprecated Legacy call sites only. */
    thoughtLevel?: string;
    draftSessionId?: string;
    forkedFromTaskId?: string;
    mcpServers?: ZCodeAgentMcpServer[];
    /** Automation owner for scheduled dispatch; lands cron_automation_id and the cron group. */
    automationId?: string;
    /** Off-peak owner on dispatch; lands tasks-index off_peak_task_id. */
    offPeakTaskId?: string;
    /**
     * Headless dispatch creates an empty session then immediately sends the first V4 input.
     * deferred makes admission persist the session row before the session_input FK ledger.
     */
    deferPersistenceUntilFirstPrompt?: boolean;
    /** Bots/hosts draft via native v4 createSession, then configure and send. */
    v4Create?: boolean;
    permissionScope?: "session";
  }): Promise<ZCodeTaskCreateResult>;

  readBotTopicSummaries?(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
  }): Promise<Array<{ checkpoint: string; text: string }>>;

  invalidateBotTopicInputs?(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
  }): Promise<void>;
  readBotTopicExecution?(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
  }): Promise<{ executionId: string; sourceCommandId?: string } | undefined>;
  stopBotTopicExecution?(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    executionId: string;
  }): Promise<void>;

  /** Blocker reason for group task switches from CLI truth; null when idle. */
  getBotGroupTaskBlockReason?(params: {
    taskId: string;
    remoteSessionId?: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<"running" | "queued" | "interaction" | null>;
  cancelBotGroupInput?(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    taskId: string;
    remoteSessionId?: string;
    commandId: string;
    sourceCommandId: string;
    actorId: string;
    ownerId: string;
    botId: string;
    chatId: string;
  }): Promise<import("@zcode/shared/zcode-protocol-v4").CommandAck>;
  submitBotGroupInput?(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    taskId: string;
    remoteSessionId?: string;
    commandId: string;
    content: string;
    conversationQuotes?: import("@zcode/shared").ConversationSelectionText[];
    attachments?: ZCodePromptAttachment[];
    source: import("@zcode/shared").BotGroupInputSource;
  }): Promise<import("@zcode/shared/zcode-protocol-v4").CommandAck>;

  /** Sends a prompt to a task */
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
      /** Extra hidden tools this turn; merged with session/automation isolation rules. */
      toolDenylist?: string[];
      /** Stable callback address for bot turns; BotsService-injected, never model-set. */
      botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
      /** Standard selection; off-peak builds models via Registry/ModelFactory too. */
      modelSelection?: CommandPayloadMap["sendText"]["modelSelection"];
      /** One-shot constraints and dynamic auth; idle start-now only, never queued. */
      modelExecution?: CommandPayloadMap["sendText"]["modelExecution"];
    } & ZCodeBackgroundTurnAttribution,
  ): Promise<void>;

  deliverSessionMessage(
    request: SessionMessageSendRequested,
  ): Promise<SessionMessageDeliveryResult>;

  sendSessionMessageDeliveryResult(result: SessionMessageDeliveryResult): Promise<void>;

  /** Submits a runtime command to the host; return means the owner host took it. */
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
    /** Deferred scheduled dispatch keeps its automation context through the host queue. */
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

  /** Stops the in-flight generation */
  stopGeneration(params: {
    taskId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    runId?: TraceId;
    /** Execution identity from CLI activeWorks so late stops miss newer turns. */
    expectedForegroundExecutionId?: string;
  }): Promise<void>;

  /** Runs the built-in /compact; phone replayable still routes via the shared host. */
  compactSession(params: {
    taskId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    inputId?: string;
    instructions?: string;
    expectedRevision?: number;
  }): Promise<ZCodeSessionCompactResult>;

  /** Runs built-in /goal; never send it as plain body text. */
  goalSession(params: {
    taskId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    inputId?: string;
    action: ZCodeSessionGoalAction;
    objective?: string;
    expectedRevision?: number;
  }): Promise<ZCodeSessionGoalResult>;

  /** Responds to a permission request */
  respondPermission(params: {
    taskId: string;
    workspacePath?: string;
    workspaceIdentity?: string;
    runId?: TraceId;
    requestId: string;
    optionId: string;
    response: ZCodePermissionResponse;
  }): Promise<boolean>;

  /** Responds to an elicitation question */
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

  /** Closes a task (session/close first; shared process reaped on workspace-last) */
  closeTask(params: { taskId: string }): Promise<void>;

  /** Resumes a task (reusing the workspace agent process, spawning if needed, then session/load) */
  resumeTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    mode?: ZCodeTaskMode;
    model?: string;
    thoughtLevel?: string;
    /** Scheduled resumption of targetTaskId keeps automation tool isolation. */
    automationId?: string;
    /** Off-peak resume stamps pre-existing sessions (new ones got stamped in createTask). */
    offPeakTaskId?: string;
    mcpServers?: ZCodeAgentMcpServer[];
  }): Promise<ZCodeTaskMeta>;

  /** Lists persisted tasks for the workspace */
  listTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta[]>;

  /** Global pinned ids; source of truth tasks-index.sqlite */
  listPinnedTaskIds(): Promise<string[]>;

  /** Pinned tasks for this workspace per tasks-index.sqlite */
  listPinnedTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta[]>;

  /** Deleted ids for the workspace; persistent negative membership for sessions-index joins */
  listDeletedTaskIds(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<string[]>;

  /**
   * Aggregates the task list across open workspace scopes; source of truth tasks-index.sqlite.
   * Consumers: full-text search (searchable_text/snippets) and the remoteTimelineTaskStore path;
   * non-search lists use listTasks/listPinnedTasks/listArchivedTasks, with workspace rows built
   * client-side from endpoint rows + session detail (converged across surfaces).
   */
  listTaskList(params: ZCodeTaskListQuery): Promise<ZCodeTaskListResult>;

  /** Creates a minimal task group; full delete arrives with group management */
  createTaskGroup(params?: {
    title?: string;
    color?: ZCodeTaskGroupColor;
  }): Promise<ZCodeTaskGroup>;

  /** Renames a group; workspaceScopes only scopes refresh notices */
  renameTaskGroup(params: {
    groupId: string;
    title: string;
    workspaceScopes?: ZCodeTaskListWorkspaceScope[];
  }): Promise<ZCodeTaskGroup>;

  /** Recolors a group; workspaceScopes only scopes refresh notices */
  updateTaskGroupColor(params: {
    groupId: string;
    color: ZCodeTaskGroupColor;
    workspaceScopes?: ZCodeTaskListWorkspaceScope[];
  }): Promise<ZCodeTaskGroup>;

  /** Deletes a group; callers must move members to root first */
  deleteTaskGroup(params: {
    groupId: string;
    workspaceScopes?: ZCodeTaskListWorkspaceScope[];
  }): Promise<void>;

  // Server grouped queries return raw structure (no tasks join);
  // renderers project from task-row partitions + session detail.

  /**
   * Raw grouped structure (group/member/top-order, no tasks join).
   * Clients left-join task-row partitions; sessions-index adds live detail only.
   */
  listGroupedTaskViewStructure(params: {
    workspaceScopes: ZCodeTaskListWorkspaceScope[];
  }): Promise<ZCodeGroupedTaskViewStructure>;

  /** Commits final grouped order+membership in one sqlite transaction */
  applyGroupedTaskViewOrder(params: ZCodeGroupedTaskViewOrderInput): Promise<ZCodeGroupedTaskView>;

  /** Lists archived tasks for the workspace */
  listArchivedTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta[]>;

  /** Bulk-archives stale tasks: completed, unread-free, unpinned, not open */
  archiveStaleTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    olderThanDays: number;
  }): Promise<ZCodeTaskMeta[]>;

  /** On workspace removal, archives every unarchived task incl. pinned */
  archiveWorkspaceTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta[]>;

  /** Local persisted snapshot of one task, for history first paint */
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

  /** Snapshot with ETag and if-none-match, trimming repeat large transfers. */
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

  /** Full body of a budget-truncated message by bodyRef. */
  getTaskSnapshotBody(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    refId: string;
  }): Promise<ZCodeTaskSnapshotBody | null>;

  /** Full tool/file-change fields trimmed by the first-paint budget. */
  getTaskSnapshotRef(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    refId: string;
  }): Promise<ZCodeTaskSnapshotRefContent | null>;

  /** Range-fetch tools by message+index for count-truncated remote first paints. */
  getTaskSnapshotToolCallsSlice(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    messageIndex: number;
    startToolIndex: number;
    limit: number;
  }): Promise<ZCodeTaskSnapshotToolCallsSlice | null>;

  /** Light meta without messages/fileChanges, for title/provider fallbacks */
  getTaskMeta(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta | null>;

  /** In-memory config options of the active task; no warmup fallback */
  getTaskConfigOptions(params: { taskId: string }): Promise<ZCodeConfigOption[]>;

  /** The bound session's original selection; never inferred from menus nor written. */
  getTaskModelSelection(params: { taskId: string }): Promise<ModelSelection | null>;

  /** Persists user feedback on an assistant reply; no provider context injected. */
  setAssistantMessageFeedback(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    turnIndex: number;
    feedback: ZCodeAssistantMessageFeedback | null;
  }): Promise<ZCodeSessionFile>;

  /**
   * Backfills the provider session so it spans the canonical task's full history.
   * Native-log backfill only; never switches the active provider.
   */
  syncTaskSessionBinding(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    provider: ZCodeProvider;
    validate?: boolean;
  }): Promise<ZCodeSyncTaskSessionBindingResult>;

  /**
   * Switches the active provider within one task.
   * Targets: claude / codex / gemini.
   */
  switchAgent(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    provider: ZCodeProvider;
  }): Promise<ZCodeSwitchAgentResult>;

  /** Scans importable Claude-native sessions; optional workspace filter. */
  scanImportableClaudeSessions(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    modifiedSince?: number;
    limit?: number;
  }): Promise<ZCodeImportableSessionCandidate[]>;

  /** Imports selected Claude-native sessions into minimal task snapshots; defaults to the original workspace. */
  importClaudeSessions(params: {
    workspacePath?: string;
    workspaceIdentity?: string;
    sessionIds: string[];
  }): Promise<ZCodeImportSessionsResult>;

  /** Switches the task mode */
  setMode(params: { taskId: string; mode: ZCodeTaskMode }): Promise<void>;

  /** Sets a config option (model/thinking), returning updated configOptions */
  setConfigOption(params: {
    taskId: string;
    traceId: TraceId;
    configId: string;
    value: string;
  }): Promise<ZCodeConfigOption[]>;

  /** Sets the model; returns authoritative server configOptions */
  setModel(params: {
    taskId: string;
    traceId: TraceId;
    modelSelection: ModelSelection;
  }): Promise<ZCodeConfigOption[]>;

  /** Scheduled-dispatch only: pins model/thinking/permission mode and syncs the V4 conversation projection. */
  setAutomationSessionConfig(params: {
    taskId: string;
    traceId: TraceId;
    modelSelection: ModelSelection;
    thoughtLevel?: string;
    mode?: ZCodeTaskMode;
  }): Promise<ZCodeConfigOption[]>;

  /** Main config path for workspace+provider */
  getWorkspaceProviderConfigFile(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
  }): Promise<{
    provider: ZCodeProvider;
    path: string;
    exists: boolean;
  }>;

  /** Native session log path (e.g. Claude jsonl) for the task */
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
   * Model-call trajectory from ~/.zcode/cli/{debug,rollout} model-io JSONL.
   * taskId is the ZCode Agent sessionId; records match on it.
   */
  getModelTrajectory(params: {
    taskId: string;
    /** Max calls returned (most recent N), default 200. */
    limit?: number;
  }): Promise<ZCodeModelTrajectory>;

  /** Cumulative token usage for a task from the agent usage DB. */
  getTaskTokenUsage(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskTokenUsageResult>;

  /** Persisted snapshot path ({taskId}.json; .deleted.json for soft deletes) */
  getTaskSessionFilePath(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<{
    path: string;
    exists: boolean;
  }>;

  /**
   * Restarts the workspace's shared ZCode Agent process.
   * For config changes that require re-reading process env.
   * Pass resumeTaskId to reattach the conversation right after.
   */
  restartWorkspaceProcess(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    resumeTaskId?: string;
    bumpRuntimeEpoch?: boolean;
  }): Promise<void>;

  /** Marks a persisted task list-invisible; CLI session content stays */
  deleteTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<void>;

  /** Deletes only still-archived rows; false when restored/deleted/missing. CLI sessions stay. */
  deleteArchivedTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<boolean>;

  /** Runs archived-conditional deletes item by item, notifying once per batch; CLI sessions stay. */
  deleteArchivedTasks(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskIds: string[];
  }): Promise<ZCodeArchivedTaskDeletionResult>;

  /** Renames a persisted task */
  renameTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    title: string;
  }): Promise<ZCodeTaskMeta>;

  /** Updates pinned state */
  setTaskPinned(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    pinned: boolean;
  }): Promise<ZCodeTaskMeta>;

  /** Updates unread state */
  setTaskUnread(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
    unread: boolean;
    /** Read compare-and-clear only; absent keeps the unconditional write. */
    expectedUnreadAt?: number;
  }): Promise<ZCodeTaskMeta>;

  /** Archives a task out of the default list */
  archiveTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta>;

  /** Unarchives a task back into the default list */
  unarchiveTask(params: {
    taskId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeTaskMeta>;

  /** Branches a blank task from the source's config, for re-editing one user input. */
  branchTaskFromPrompt(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sourceTaskId: string;
  }): Promise<ZCodeTaskCreateResult>;

  // ---- Streaming events ----

  /** Streams updates for a task (ProxyChannel dynamic event) */
  onDynamicStreamEvent(taskId: string): Event<ZCodeStreamEvent>;

  /**
   * Terminal results (succeeded/failed/stopped) for one task.
   * Rides the always-on task-index session subscription, independent of any watcher,
   * so background dispatch still learns the outcome (automation_runs.outcome).
   */
  onDynamicTaskTerminalOutcome(taskId: string): Event<ZCodeTaskTerminalOutcome>;

  /**
   * Input-settled edge. sendPrompt's ACK is not idle proof;
   * host teardown waits for it or kills a running agent.
   */
  onDynamicTaskReady(taskId: string): Event<ZCodeTaskReadyOutcome>;

  /** Streams workspace+task updates, keeping same-id tasks on different workspaces apart. */
  onDynamicTaskEvent(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
    clientId?: string;
    deliveryKind?: "continuous" | "bot-channel-continuous" | "replayable" | "mixed";
  }): Event<ZCodeStreamEvent>;

  /**
   * Workspace-level async notices (warmup slash commands, configOptions).
   * Covers the pre-create gap so UI updates draft toolbar/commands live.
   * Named per the ProxyChannel onDynamic convention so RPC proxies auto-flag it dynamic.
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
