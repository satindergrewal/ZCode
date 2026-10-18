import { createBotTopicAdmission } from "#src/zcode-agent/botTopicAdmission.js";
import {
  readBotGroupRuntimeSnapshot,
  waitBotGroupExecutionEnd,
} from "#src/zcode-agent/groupRuntimeSnapshot.js";
import { uploadBotGroupAttachments } from "./groupAttachmentUpload.js";
/* oxlint-disable eslint(max-lines) -- Migration period: the legacy task projection to ZCode session protocol adapter lives in this one facade. */
import { createHash, randomUUID } from "node:crypto";
import { createZCodeAgentConnectionScope } from "#src/zcode-agent/zcodeAgentConnectionScope.js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Emitter,
  Event,
  emitNetworkTelemetryObservation,
  type NetworkObservation,
} from "@zcode/rpc";
import {
  coalesceConsecutiveZCodeAssistants,
  createSessionTraceId,
  decodeCustomModelValue,
  deriveZCodeTaskStatusFromSessionSnapshot,
  extractPlanStepsFromToolInput,
  extractPlanStepsFromToolOutput,
  generateTraceId,
  getZCodeGoalActiveIterationCount,
  getZCodeGoalIterationByAssistantMessageId,
  getZCodeUserVisibleMessages,
  isMainAgentToolProjectionSource,
  normalizeZCodeApiRetryStatus,
  attachZCodeBackgroundTaskNotificationToRaw,
  collectZCodeBackgroundTaskNotificationsByToolUseId,
  mergeZCodeBackgroundTaskControlItems,
  parseZCodeBackgroundTaskControlItems,
  parseZCodeBackgroundTaskNotificationText,
  parseModelPickerValue as parseSharedModelSelection,
  resolveWorkspaceKey,
  resolveZCodeVisibleSessionTitle,
  textFromZCodeMessageParts,
  ZCODE_AGENT_PROVIDER,
  zcodeBackgroundTaskNotificationToolUpdateStatus,
  appendZCodeStreamingToolInputDelta,
  buildZCodeStreamingToolInputPreview,
  createZCodeToolProjectionMemory,
  finalizeZCodeToolProjectionInput,
  forgetZCodeToolProjectionMetadata,
  isZCodeModelRetryRecoveryProgressPayload,
  markZCodeStreamingToolInputPreviewMaterialized,
  resolveZCodeToolProjectionMetadata,
  zcodeApiRetryFromModelNetworkStatusPayload,
  zcodeApiRetryFromStreamRecoveryPayload,
  zcodeTaskNetworkDebugStatusFromPayload,
  shouldMaterializeZCodeStreamingToolInputPreview,
  type ZCodeApiRetryStatus,
  type ZCodeAssistantMessageFeedback,
  type ZCodeBackgroundTaskNotificationInfo,
  type ZCodeBackgroundTaskControlItem,
  type ZCodeBackgroundTurnAttribution,
  type ZCodeAutomationBotDeliveryTarget,
  type ZCodeCancelTaskCommandResult,
  type ZCodeCodexConnectivityCheckResult,
  type ZCodeConfigOption,
  type ZCodeEnqueueTaskCommandResult,
  type ZCodeError,
  type ZCodeGoalVerificationTimelineMeta,
  type ZCodeImportSessionsResult,
  type ZCodeImportableSessionCandidate,
  type ZCodeUsage,
  type ZCodePersistedMessage,
  type ZCodePersistedMessagePart,
  type ZCodePersistedToolCall,
  type ZCodePromptAttachment,
  type ZCodeProvider,
  type ZCodeSessionFile,
  type ZCodeTaskGoal,
  type ZCodeTaskGoalStats,
  type ZCodeTaskMode,
  type ZCodePlanStep,
  type ZCodeSlashCommand,
  type ZCodeStreamEvent,
  type ZCodeSwitchAgentResult,
  type ZCodeSyncTaskSessionBindingResult,
  type ZCodeTaskCreateResult,
  type ZCodeTaskMeta,
  type ZCodeTaskClientMode,
  type ZCodeTaskRuntimeCommand,
  type ZCodeTaskSnapshot,
  type ZCodeTaskSnapshotBody,
  type ZCodeTaskSnapshotRefContent,
  type ZCodeTaskSnapshotToolCallsSlice,
  type ZCodeTaskTokenUsageResult,
  type ZCodeTodoGroup,
  type ZCodeTurnSteerCommandKind,
  type ZCodeTurnSteerSource,
  type ZCodeWorkspaceEvent,
  type ZCodeWorkspaceTaskListChanged,
  type InputId,
  type TraceId,
  zcodeContextUsageBreakdownSchema,
  zcodeSessionSettingsStateSchema,
  type ZCodeDeliveryKind,
  type ZCodeMessagePart,
  type ZCodeMessageWithParts,
  type ModelSelection,
  type ZCodePermissionOption,
  type ZCodePermissionRequestParams,
  type ZCodePermissionRequest,
  type ZCodeSessionEvent,
  type ZCodeSessionMode,
  type ZCodeSessionSettingsState,
  type ZCodeSessionStateSnapshot,
  type ZCodeStateUpdatedNotification,
  type ZCodeContextCompactionTimelineMeta,
  type ZCodeTimelineMeta,
  type ZCodeTimelineStatus,
  type ZCodeTimelineTrigger,
  type ZCodeToolProjectionMemory,
  type ZCodeUserInputRequestParams,
  type ZCodeUserInputResponse,
  type ZCodeAgentMcpServer,
} from "@zcode/shared";
import type {
  ZCodeTaskListQuery,
  ZCodeTaskListResult,
  ZCodeWorkspaceEventSubscriptionParams,
  IZCodeTaskService,
  ZCodeArchivedTaskDeletionResult,
  ZCodeTaskReadyOutcome,
  ZCodeTaskTerminalOutcome,
} from "../session/zcodeTaskService.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  AUTOMATION_MUTATION_TOOL_NAMES,
  OFF_PEAK_MUTATION_TOOL_NAMES,
} from "#src/zcode-agent/automationToolPolicy.js";
import type { ISettingService } from "#src/setting/setting.js";
import type {
  SessionMessageDeliveryResult,
  SessionMessageSendRequested,
} from "#src/session/sessionMailbox.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";
import type {
  IZCodeAgentService,
  ZCodeAgentServiceEvent,
  ZCodeAgentWorkspaceTarget,
} from "./zcodeAgent.js";
import type {
  ZCodeTaskIndexReadyEvent,
  ZCodeTaskIndexSyncer,
  ZCodeTaskIndexTerminalEvent,
} from "./zcodeTaskIndexSyncer.js";
import { readModelTrajectory } from "./modelTrajectory.js";
import { errorAttributionSchema, type CommandPayloadMap } from "@zcode/shared/zcode-protocol-v4";
import {
  assertV4CommandAckOk,
  createHostCommandEnvelope,
  sendHostCasCommandV4,
} from "./zcodeV4HostCommand.js";
import {
  getLegacyDeletedTaskSessionSnapshotPath,
  getLegacyTaskSessionSnapshotPath,
} from "#src/paths.js";
import { claudeNativeSessionImportRepo } from "#src/session/claude-native/claudeNativeSessionImportRepo.js";
import { importClaudeNativeSessions } from "#src/session/claude-native/claudeNativeSessionImportService.js";
import { buildImportedClaudeTaskId } from "#src/session/claude-native/buildImportedClaudeTaskFile.js";
import { repairImportedClaudeSessionSnapshot } from "#src/session/claude-native/importedClaudeHistoryRepair.js";
import { safeParseLegacyTaskSessionFile } from "#src/session/legacyTaskSessionFile.js";
import {
  MODEL_CONFIG_ID,
  MODE_CONFIG_ID,
  THOUGHT_LEVEL_CONFIG_ID,
  formatTaskMetaModelSelectionFromSnapshot,
  formatModelPickerValue,
  getZCodeAgentAvailableModes,
  normalizeAvailableZCodeMode,
  settingsToConfigOptions,
} from "./zcodeConfigOptions.js";
import type { CuaProductMcpServerResolver } from "#src/cua-permission-broker/index.js";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

interface TaskOverlay {
  archived?: boolean;
  deleted?: boolean;
  pinned?: boolean;
  title?: string;
  unreadAt?: number;
}

interface CreateZCodeTaskServiceAdapterOptions {
  zcodeAgentService: IZCodeAgentService;
  taskIndexRepo?: TaskIndexRepo;
  // The syncer now owns the workspace emitter and broadcast entry; the adapter must share
  // the same instance, or desktop-continuous and task-adapter event subscriptions split in
  // two and the UI misses events.
  taskIndexSyncer: ZCodeTaskIndexSyncer;
  settingService?: Pick<ISettingService, "get">;
  cuaProductMcpServerResolver?: CuaProductMcpServerResolver;
}

interface TaskTarget {
  taskId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  cronAutomationId?: string;
  remoteSessionId?: string;
}

interface TaskTargetWithMcpServers extends TaskTarget {
  model?: string;
  thoughtLevel?: string;
  mcpServers?: ZCodeAgentMcpServer[];
  toolDenylist?: string[];
}

type WorkspaceEventInput = string | ZCodeWorkspaceEventSubscriptionParams;
type ZCodeSendPromptRuntimeCommand = Extract<ZCodeTaskRuntimeCommand, { type: "send_prompt" }>;
type ZCodeTerminalStreamEvent =
  | Extract<ZCodeStreamEvent, { type: "task_complete" }>
  | Extract<ZCodeStreamEvent, { type: "task_error" }>;

const GLM_PROVIDER: ZCodeProvider = ZCODE_AGENT_PROVIDER;
const EMPTY_SLASH_COMMANDS: ZCodeSlashCommand[] = [];
const logger = createServiceLogger("zcode-task-service");
const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
const EXIT_PLAN_MODE_TOOL_NAME = "ExitPlanMode";
const EXIT_PLAN_MODE_APPROVAL_QUESTION = "Review this implementation plan.";
const EXIT_PLAN_MODE_APPROVAL_APPROVE = "approve";

function sameModelSelection(
  left: ModelSelection | undefined,
  right: ModelSelection | undefined,
): boolean {
  return (
    left?.providerId === right?.providerId &&
    left?.modelId === right?.modelId &&
    left?.options?.reasoningLevel === right?.options?.reasoningLevel
  );
}
const MAX_LIVE_TOOL_PROJECTION_TASKS = 128;
const MAX_LIVE_TOOL_PROJECTION_TOOLS_PER_TASK = 2000;

interface LiveToolProjection {
  order: number;
  parentToolUseId: string | null;
  tool: ZCodePersistedToolCall;
  toolId: string;
}

function padDatePart(value: number): string {
  return value.toString().padStart(2, "0");
}

function formatZCodeAgentLogDate(now: Date): string {
  return [now.getFullYear(), padDatePart(now.getMonth() + 1), padDatePart(now.getDate())].join("-");
}

function resolveZCodeAgentCurrentLogFilePath(now = new Date()): string {
  const configuredLogDir = process.env.ZCODE_LOG_DIR?.trim();
  const logDir = configuredLogDir || join(homedir(), ".zcode", "cli", "log");
  return join(logDir, `zcode-${formatZCodeAgentLogDate(now)}.jsonl`);
}

export function createZCodeTaskServiceAdapter(
  options: CreateZCodeTaskServiceAdapterOptions,
): IZCodeTaskService {
  // Bots used to bypass the connection facade, leaving real attachment admission without a
  // trusted identity; reuse one scope per bot so attachments, commands, and reconciliation
  // share the connection, without changing desktop or phone transports.
  const botConnectionScopes = new Map<string, ReturnType<typeof createZCodeAgentConnectionScope>>();
  function botAgent(workspace: ZCodeAgentWorkspaceTarget) {
    const key = JSON.stringify([resolveWorkspaceKey(workspace), workspace.remoteSessionId ?? ""]);
    let scope = botConnectionScopes.get(key);
    if (!scope) {
      scope = createZCodeAgentConnectionScope(options.zcodeAgentService, {
        connectionId: `bot-${randomUUID()}`,
        clientMode: "desktop-continuous",
        role: "trusted-host-relay",
      });
      botConnectionScopes.set(key, scope);
    }
    return scope.service;
  }
  const errorEmitter = new Emitter<ZCodeError>();
  const taskEmitters = new Map<string, Emitter<ZCodeStreamEvent>>();
  const globalTaskEmitters = new Map<string, Emitter<ZCodeStreamEvent>>();
  const overlays = new Map<string, TaskOverlay>();
  const taskTargets = new Map<string, TaskTarget>();
  const topicAdmission = createBotTopicAdmission();
  const runtimeCommands = new Map<string, ZCodeTaskRuntimeCommand[]>();
  const runtimeCommandDrains = new Map<string, Promise<void>>();
  const apiRetryByTaskKey = new Map<string, ZCodeApiRetryStatus | null>();
  const backgroundTaskControlsByTaskKey = new Map<string, ZCodeBackgroundTaskControlItem[]>();
  const streamedTurnText = new Map<string, { messageId?: string; text: string }>();
  const activePromptInputIds = new Map<string, InputId>();
  const toolProjectionMemoryByTaskKey = new Map<string, ZCodeToolProjectionMemory>();
  const liveToolProjectionsByTaskKey = new Map<string, Map<string, LiveToolProjection>>();
  let liveToolProjectionOrder = 0;
  const legacySnapshotTaskKeys = new Set<string>();
  // Memory diagnostics counters (docs/monitoring/memory-diagnostics-log.md): read-only
  // sizes of the per-task maps the audit found leaking on closeTask/deleteTask.
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("task", () => ({
    runtimeCommands: runtimeCommands.size,
    toolMemoryTasks: toolProjectionMemoryByTaskKey.size,
    taskEmitters: taskEmitters.size,
    overlays: overlays.size,
  }));
  const taskIndexRepo = options.taskIndexRepo ?? new TaskIndexRepo();
  const taskIndexSyncer = options.taskIndexSyncer;

  // notifySyncerSession used to treat the syncer as optional; it is now a required ctor
  // arg, so call it directly instead of null-checking at every callsite.
  function notifySyncerSession(target: TaskTarget): void {
    taskIndexSyncer.ensureSessionSubscription({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
      sessionId: target.taskId,
    });
  }

  function unsupported(name: string): never {
    throw Object.assign(
      new Error(`ZCode task service adapter does not support IZCodeTaskService.${name} yet.`),
      {
        code: "ZCODE_AGENT_UNSUPPORTED_LEGACY_TASK_METHOD",
      },
    );
  }

  function resolvePromptToolDenylist(params: {
    automationId?: string;
    offPeakTaskId?: string;
    toolDenylist?: string[];
  }): string[] | undefined {
    const toolDenylist = new Set(params.toolDenylist);
    // The persisted cronAutomationId is not the current turn's execution identity; after a
    // scheduled run, user edits to the schedule in the same session would never see
    // CronUpdate again. Permissions must use only this turn's automationId; cronAutomationId
    // stays ownership/UI-display only.
    if (params.automationId) {
      for (const toolName of AUTOMATION_MUTATION_TOOL_NAMES) {
        toolDenylist.add(toolName);
      }
    }
    // Hide OffPeakCreate on idle-dispatch turns; kept separate from the automation branch (cron turns pass).
    if (params.offPeakTaskId) {
      for (const toolName of OFF_PEAK_MUTATION_TOOL_NAMES) {
        toolDenylist.add(toolName);
      }
    }
    return toolDenylist.size > 0 ? [...toolDenylist] : undefined;
  }

  function turnAttributionOf(
    params: ZCodeBackgroundTurnAttribution,
  ): ZCodeBackgroundTurnAttribution {
    if (params.automationId) return { automationId: params.automationId };
    if (params.offPeakTaskId) {
      return {
        offPeakTaskId: params.offPeakTaskId,
        ...(params.offPeakRunType ? { offPeakRunType: params.offPeakRunType } : {}),
      };
    }
    return {};
  }

  async function resolveProductMcpServers(
    servers: ZCodeAgentMcpServer[] | undefined,
  ): Promise<ZCodeAgentMcpServer[] | undefined> {
    const configuredServers = (servers?.length ?? 0) > 0 ? servers : undefined;
    if (!configuredServers || !options.cuaProductMcpServerResolver) {
      return configuredServers;
    }
    return options.cuaProductMcpServerResolver.resolveMcpServers(configuredServers);
  }

  function workspaceKey(params: { workspacePath: string; workspaceIdentity?: string }): string {
    return resolveWorkspaceKey(params);
  }

  function taskKey(params: { workspacePath: string; workspaceIdentity?: string; taskId: string }) {
    return `${workspaceKey(params)}\u0000${params.taskId}`;
  }

  function createTaskOwnerCommandError(
    message: string,
    code: "NO_ACTIVE_TASK_OWNER" | "STALE_TASK_OWNER_COMMAND",
  ): Error & { code: "NO_ACTIVE_TASK_OWNER" | "STALE_TASK_OWNER_COMMAND" } {
    return Object.assign(new Error(message), { code });
  }

  function assertCurrentOwnerRun(params: TaskTarget, ownerRunId: TraceId | undefined): void {
    if (!ownerRunId) {
      return;
    }
    const key = taskKey(params);
    const activeRunId = activePromptInputIds.get(key);
    if (!activeRunId) {
      // By the time a phone owner command reaches the host, the task may already be terminal.
      // Without an active run, do not enqueue the stale command or the desktop shared host
      // would re-send old input.
      throw createTaskOwnerCommandError("No active task owner.", "NO_ACTIVE_TASK_OWNER");
    }
    if (activeRunId !== ownerRunId) {
      // ownerRunId is the stale-guard boundary for remote-control requests: enqueue/promote
      // from an old run must not touch the current task command queue.
      throw createTaskOwnerCommandError("Stale task owner command.", "STALE_TASK_OWNER_COMMAND");
    }
  }

  async function sendPromptToAgent(
    target: TaskTarget,
    params: {
      traceId: TraceId;
      queryId?: string;
      messageId?: string;
      content: string;
      attachments?: ZCodePromptAttachment[];
      toolDenylist?: string[];
      botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
      clientId?: string;
      clientMode?: ZCodeTaskClientMode;
      logReason?: string;
      modelSelection?: CommandPayloadMap["sendText"]["modelSelection"];
      modelExecution?: CommandPayloadMap["sendText"]["modelExecution"];
    } & ZCodeBackgroundTurnAttribution,
  ): Promise<void> {
    const startedAt = Date.now();
    notifySyncerSession(target);
    // Live tool projection exists only to settle the current run's terminal state.
    // Clear the previous turn's live-only subtools on new input, or later snapshots append
    // old tools to the tail of the new reply.
    clearLiveToolProjection(target);
    clearStreamingToolInputCache(target);
    // The ZCode task wrapper still names this field traceId, but here it is a single-input
    // inputId. Record it up front so the UI can settle terminals per input turn when ZCode
    // session events project back.
    activePromptInputIds.set(taskKey(target), params.traceId);
    logger.info(params.traceId, "ZCode task facade sendPrompt start", {
      attachmentCount: params.attachments?.length ?? 0,
      queryId: params.queryId ?? null,
      reason: params.logReason ?? "direct",
      taskId: target.taskId,
      textLength: params.content.length,
      workspaceIdentity: target.workspaceIdentity ?? null,
      workspaceKey: resolveWorkspaceKey(target),
      workspacePath: target.workspacePath,
    });
    try {
      const promptToolDenylist = resolvePromptToolDenylist(params);
      if (params.attachments?.length) {
        // Legacy (attachment command surface): v4 sendText attachments use the attachmentRef
        // reference model and upload/staging commands are not modeled yet (same CLI ruling in
        // fork-edit-retry.ts). Keep legacy session/send for attachments so phone replayable
        // image/file input does not regress; endgame = the v4 attachment command surface.
        await options.zcodeAgentService.sendPrompt({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
          sessionId: target.taskId,
          inputId: params.traceId,
          queryId: params.queryId,
          messageId: params.messageId,
          content: params.content,
          attachments: params.attachments.map((attachment) => ({
            ...attachment,
          })),
          // The attachment fallback only changes payload transport; never drop the resolved model or execution scope.
          modelSelection: params.modelSelection,
          modelExecution: params.modelExecution,
          ...turnAttributionOf(params),
          toolDenylist: promptToolDenylist,
          botDeliveryTarget: params.botDeliveryTarget,
          ...(params.clientMode ? { clientMode: params.clientMode } : {}),
        });
      } else {
        // The send main path converges on v4 sendText. Idempotency key inputId->commandId
        // alignment: the CLI starts the turn with commandId as inputId so terminal event
        // inputId reconciles with the host command queue traceId
        // (completeRuntimeCommandByInputId unchanged). heldQueueDisposition=keepQueueAndSend:
        // legacy session/send had no held-choice gate; replayable no-interaction paths keep
        // the equivalent send-now-leave-queue behavior.
        const ack = await options.zcodeAgentService.sendConversationCommandV4({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
          ...(params.clientMode ? { clientMode: params.clientMode } : {}),
          envelope: createHostCommandEnvelope({
            type: "sendText",
            payload: {
              text: params.content,
              heldQueueDisposition: "keepQueueAndSend",
              ...(params.modelSelection ? { modelSelection: params.modelSelection } : {}),
              ...(params.modelExecution ? { modelExecution: params.modelExecution } : {}),
              ...turnAttributionOf(params),
              ...(params.botDeliveryTarget ? { botDeliveryTarget: params.botDeliveryTarget } : {}),
              ...(promptToolDenylist ? { toolDisallowlist: promptToolDenylist } : {}),
            },
            sessionId: target.taskId,
            commandId: params.traceId,
            clientId: params.clientId,
          }),
        });
        assertV4CommandAckOk("sendText", ack, `session=${target.taskId}`);
      }
      logger.info(params.traceId, "ZCode task facade sendPrompt ACK", {
        durationMs: Date.now() - startedAt,
        queryId: params.queryId ?? null,
        reason: params.logReason ?? "direct",
        taskId: target.taskId,
        workspaceIdentity: target.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(target),
        workspacePath: target.workspacePath,
      });
    } catch (error) {
      activePromptInputIds.delete(taskKey(target));
      logger.warn(params.traceId, "ZCode task facade sendPrompt failed", {
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        queryId: params.queryId ?? null,
        reason: params.logReason ?? "direct",
        taskId: target.taskId,
        workspaceIdentity: target.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(target),
        workspacePath: target.workspacePath,
      });
      throw error;
    }
  }

  function setRuntimeCommands(params: TaskTarget, commands: ZCodeTaskRuntimeCommand[]): void {
    const key = taskKey(params);
    if (commands.length === 0) {
      runtimeCommands.delete(key);
      return;
    }
    runtimeCommands.set(key, commands);
  }

  function markRuntimeCommandRunning(
    params: TaskTarget,
    command: ZCodeSendPromptRuntimeCommand,
  ): ZCodeSendPromptRuntimeCommand {
    const key = taskKey(params);
    const runningCommand: ZCodeSendPromptRuntimeCommand = {
      ...command,
      status: "running",
      updatedAt: Date.now(),
    };
    runtimeCommands.set(
      key,
      (runtimeCommands.get(key) ?? []).map((item) =>
        item.commandId === command.commandId ? runningCommand : item,
      ),
    );
    return runningCommand;
  }

  function markRuntimeCommandFailed(
    params: TaskTarget,
    command: ZCodeSendPromptRuntimeCommand,
    error: unknown,
  ): void {
    const key = taskKey(params);
    const failedCommand: ZCodeSendPromptRuntimeCommand = {
      ...command,
      status: "failed",
      updatedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
    };
    runtimeCommands.set(
      key,
      (runtimeCommands.get(key) ?? []).map((item) =>
        item.commandId === command.commandId ? failedCommand : item,
      ),
    );
  }

  function removeRuntimeCommand(params: TaskTarget, commandId: string): void {
    setRuntimeCommands(
      params,
      (runtimeCommands.get(taskKey(params)) ?? []).filter(
        (command) => command.commandId !== commandId,
      ),
    );
  }

  function emitRuntimeCommandSnapshotUpdated(params: TaskTarget, traceId?: TraceId): void {
    emitTaskEvent(params, {
      type: "task_snapshot_updated",
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      workspaceKey: workspaceKey(params),
      taskId: params.taskId,
      traceId: traceId ?? generateTraceId(params.taskId),
      reason: "task_status_changed",
    });
  }

  function completeRuntimeCommandByInputId(
    params: TaskTarget,
    terminalInputId: string | undefined,
    terminalType: string,
  ): void {
    if (!terminalInputId) {
      return;
    }
    const command = (runtimeCommands.get(taskKey(params)) ?? []).find(
      (candidate) =>
        candidate.type === "send_prompt" &&
        candidate.status === "running" &&
        candidate.traceId === terminalInputId,
    );
    if (!command) {
      return;
    }
    // Phone host commands must stay running after the sendPrompt ACK, or a phone refresh
    // loses the send-started pendingCommands. Remove from the host queue on real terminal only.
    removeRuntimeCommand(params, command.commandId);
    logger.info(command.traceId, "ZCode task command terminal settled", {
      commandId: command.commandId,
      terminalType,
      taskId: params.taskId,
      workspaceIdentity: params.workspaceIdentity ?? null,
      workspaceKey: resolveWorkspaceKey(params),
      workspacePath: params.workspacePath,
    });
  }

  function completeRuntimeCommandForTerminalEvent(
    params: TaskTarget,
    event: ZCodeTerminalStreamEvent,
  ): void {
    completeRuntimeCommandByInputId(params, event.inputId ?? event.traceId, event.type);
  }

  async function drainRuntimeCommands(params: TaskTarget, reason: string): Promise<void> {
    const key = taskKey(params);
    if (activePromptInputIds.has(key)) {
      return;
    }
    const commands = runtimeCommands.get(key) ?? [];
    if (commands.some((command) => command.status === "running")) {
      return;
    }
    const command = commands.find(
      (candidate): candidate is ZCodeSendPromptRuntimeCommand =>
        candidate.type === "send_prompt" && candidate.status === "accepted",
    );
    if (!command) {
      return;
    }

    const runningCommand = markRuntimeCommandRunning(params, command);
    logger.info(runningCommand.traceId, "ZCode task command drain start", {
      commandId: runningCommand.commandId,
      queryId: runningCommand.queryId ?? null,
      reason,
      taskId: params.taskId,
      workspaceIdentity: params.workspaceIdentity ?? null,
      workspaceKey: resolveWorkspaceKey(params),
      workspacePath: params.workspacePath,
    });
    try {
      await sendPromptToAgent(params, {
        traceId: runningCommand.traceId,
        queryId: runningCommand.queryId,
        messageId: runningCommand.commandId,
        content: runningCommand.content,
        attachments: runningCommand.attachments,
        ...turnAttributionOf(
          runningCommand.automationId ? { automationId: runningCommand.automationId } : {},
        ),
        // Keep the phone submitter clientId in the v4 sendText envelope (pendingCommands display and idempotency key by submitter).
        clientId: runningCommand.clientId,
        logReason: "host-command-drain",
      });
    } catch (error) {
      markRuntimeCommandFailed(params, runningCommand, error);
      logger.warn(runningCommand.traceId, "ZCode task command drain failed", {
        commandId: runningCommand.commandId,
        error: error instanceof Error ? error.message : String(error),
        reason,
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
    }
  }

  async function drainRuntimeCommandsSafely(params: TaskTarget, reason: string): Promise<void> {
    try {
      await drainRuntimeCommands(params, reason);
    } catch (error) {
      logger.warn(undefined, "ZCode task command drain scheduling failed", {
        error: error instanceof Error ? error.message : String(error),
        reason,
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
    }
  }

  function scheduleRuntimeCommandDrain(params: TaskTarget, reason: string): void {
    const key = taskKey(params);
    const existingDrain = runtimeCommandDrains.get(key);
    if (existingDrain) {
      const nextDrainPromise = existingDrain
        .finally(() => drainRuntimeCommandsSafely(params, reason))
        .finally(() => {
          if (runtimeCommandDrains.get(key) === nextDrainPromise) {
            runtimeCommandDrains.delete(key);
          }
        });
      runtimeCommandDrains.set(key, nextDrainPromise);
      return;
    }
    const drainPromise = (async () => {
      await drainRuntimeCommandsSafely(params, reason);
    })().finally(() => {
      if (runtimeCommandDrains.get(key) === drainPromise) {
        runtimeCommandDrains.delete(key);
      }
    });
    runtimeCommandDrains.set(key, drainPromise);
  }

  function getLiveToolProjectionMap(params: TaskTarget): Map<string, LiveToolProjection> {
    const key = taskKey(params);
    let projection = liveToolProjectionsByTaskKey.get(key);
    if (!projection) {
      projection = new Map<string, LiveToolProjection>();
      liveToolProjectionsByTaskKey.set(key, projection);
      while (liveToolProjectionsByTaskKey.size > MAX_LIVE_TOOL_PROJECTION_TASKS) {
        const oldestKey = liveToolProjectionsByTaskKey.keys().next().value;
        if (typeof oldestKey !== "string") break;
        liveToolProjectionsByTaskKey.delete(oldestKey);
      }
    }
    return projection;
  }

  function trimLiveToolProjectionMap(projection: Map<string, LiveToolProjection>): void {
    while (projection.size > MAX_LIVE_TOOL_PROJECTION_TOOLS_PER_TASK) {
      let oldestKey: string | undefined;
      let oldestOrder = Number.POSITIVE_INFINITY;
      for (const [toolId, item] of projection) {
        if (item.order < oldestOrder) {
          oldestOrder = item.order;
          oldestKey = toolId;
        }
      }
      if (!oldestKey) return;
      projection.delete(oldestKey);
    }
  }

  function clearLiveToolProjection(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }): void {
    liveToolProjectionsByTaskKey.delete(taskKey(params));
  }

  function normalizeLiveToolRaw(
    raw: unknown,
    toolId: string,
    parentToolUseId: string | null | undefined,
  ): unknown {
    const rawRecord = asRecord(raw);
    const rawBase =
      Object.keys(rawRecord).length > 0 ? rawRecord : raw === undefined ? {} : { raw };
    const parentFromRaw =
      stringValue(rawRecord.parentToolUseId) ??
      stringValue(rawRecord.parentToolCallId) ??
      parentToolUseId ??
      null;
    return {
      ...rawBase,
      toolCallId: stringValue(rawRecord.toolCallId) ?? toolId,
      ...(parentFromRaw
        ? {
            parentToolCallId: stringValue(rawRecord.parentToolCallId) ?? parentFromRaw,
          }
        : {}),
    };
  }

  function persistedStatusFromToolUpdate(
    status: Extract<ZCodeStreamEvent, { type: "tool_call_update" }>["status"],
  ): ZCodePersistedToolCall["status"] | undefined {
    return status === "completed" ||
      status === "failed" ||
      status === "denied" ||
      status === "stopped"
      ? status
      : undefined;
  }

  function rememberLiveToolProjection(params: TaskTarget, event: ZCodeStreamEvent): void {
    if (event.type !== "tool_call" && event.type !== "tool_call_update") {
      return;
    }

    const projection = getLiveToolProjectionMap(params);
    const existing = projection.get(event.toolId);
    const parentToolUseId = event.parentToolUseId ?? existing?.parentToolUseId ?? null;
    const raw = normalizeLiveToolRaw(event.raw, event.toolId, parentToolUseId);
    const nextTool: ZCodePersistedToolCall =
      event.type === "tool_call"
        ? {
            ...existing?.tool,
            toolName: event.toolName ?? existing?.tool.toolName,
            title: event.title ?? existing?.tool.title ?? event.toolName,
            kind: event.kind ?? existing?.tool.kind ?? event.toolName,
            input: event.input,
            raw,
          }
        : {
            ...existing?.tool,
            toolName: event.toolName ?? existing?.tool.toolName,
            title: event.title ?? existing?.tool.title ?? event.toolName ?? event.kind,
            kind: event.kind ?? existing?.tool.kind ?? event.toolName ?? existing?.tool.toolName,
            input: event.input !== undefined ? event.input : existing?.tool.input,
            output: event.content !== undefined ? event.content : existing?.tool.output,
            error: event.error ?? existing?.tool.error,
            raw,
            status: persistedStatusFromToolUpdate(event.status) ?? existing?.tool.status,
          };
    projection.set(event.toolId, {
      order: existing?.order ?? ++liveToolProjectionOrder,
      parentToolUseId,
      tool: nextTool,
      toolId: event.toolId,
    });
    trimLiveToolProjectionMap(projection);
  }

  function persistedToolId(tool: ZCodePersistedToolCall): string | undefined {
    return stringValue(asRecord(tool.raw).toolCallId);
  }

  function mergeToolRaw(snapshotRaw: unknown, liveRaw: unknown): unknown {
    const snapshotRecord = asRecord(snapshotRaw);
    const liveRecord = asRecord(liveRaw);
    if (Object.keys(snapshotRecord).length === 0) {
      return liveRaw;
    }
    if (Object.keys(liveRecord).length === 0) {
      return snapshotRaw;
    }
    return {
      ...liveRecord,
      ...snapshotRecord,
      parentToolCallId:
        stringValue(snapshotRecord.parentToolCallId) ?? stringValue(liveRecord.parentToolCallId),
      toolCallId: stringValue(snapshotRecord.toolCallId) ?? stringValue(liveRecord.toolCallId),
    };
  }

  function mergePersistedToolCall(
    snapshotTool: ZCodePersistedToolCall | undefined,
    liveTool: ZCodePersistedToolCall,
  ): ZCodePersistedToolCall {
    if (!snapshotTool) {
      return liveTool;
    }
    return {
      ...liveTool,
      ...snapshotTool,
      // Terminal snapshots come from parent session message parts and may lack the live
      // mirror's subagent parentToolCallId/raw/output. Treat the snapshot as terminal truth
      // while keeping the parentage and large fields from live events, so the tool tree
      // survives task_complete instead of being overwritten.
      input: snapshotTool.input ?? liveTool.input,
      output: snapshotTool.output ?? liveTool.output,
      raw: mergeToolRaw(snapshotTool.raw, liveTool.raw),
      error: snapshotTool.error ?? liveTool.error,
      status: snapshotTool.status ?? liveTool.status,
      snapshotRefs: snapshotTool.snapshotRefs ?? liveTool.snapshotRefs,
    };
  }

  function findToolLocation(
    messages: readonly ZCodePersistedMessage[],
    toolId: string,
  ): { messageIndex: number; toolIndex: number } | null {
    for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
      const message = messages[messageIndex];
      if (!message?.tools) continue;
      const toolIndex = message.tools.findIndex((tool) => persistedToolId(tool) === toolId);
      if (toolIndex >= 0) {
        return { messageIndex, toolIndex };
      }
    }
    return null;
  }

  function latestAssistantMessageIndex(messages: readonly ZCodePersistedMessage[]): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "assistant") {
        return index;
      }
    }
    return -1;
  }

  function upsertPersistedToolPart(
    parts: readonly ZCodePersistedMessagePart[] | undefined,
    toolIndex: number,
  ): ZCodePersistedMessagePart[] {
    if (parts?.some((part) => part.type === "tool-call" && part.toolIndex === toolIndex)) {
      return [...parts];
    }
    return [...(parts ?? []), { type: "tool-call", toolIndex }];
  }

  function updateSnapshotMessageTool(
    message: ZCodePersistedMessage,
    toolIndex: number,
    tool: ZCodePersistedToolCall,
  ): ZCodePersistedMessage {
    const tools = [...(message.tools ?? [])];
    tools[toolIndex] = mergePersistedToolCall(tools[toolIndex], tool);
    return {
      ...message,
      tools,
      parts:
        message.role === "assistant"
          ? upsertPersistedToolPart(message.parts, toolIndex)
          : message.parts,
    };
  }

  function appendSnapshotMessageTool(
    message: ZCodePersistedMessage,
    tool: ZCodePersistedToolCall,
  ): ZCodePersistedMessage {
    const tools = [...(message.tools ?? []), tool];
    const toolIndex = tools.length - 1;
    return {
      ...message,
      tools,
      parts:
        message.role === "assistant"
          ? upsertPersistedToolPart(message.parts, toolIndex)
          : message.parts,
    };
  }

  function mergeLiveToolProjectionIntoSnapshotMessages(
    meta: ZCodeTaskMeta,
    messages: ZCodePersistedMessage[],
  ): ZCodePersistedMessage[] {
    const projection = liveToolProjectionsByTaskKey.get(taskKey(meta));
    if (!projection || projection.size === 0 || messages.length === 0) {
      return messages;
    }

    let nextMessages = messages;
    let changed = false;
    let mergedToolCount = 0;
    const liveTools = [...projection.values()].sort((a, b) => a.order - b.order);
    for (const liveTool of liveTools) {
      const existingLocation = findToolLocation(nextMessages, liveTool.toolId);
      if (existingLocation) {
        nextMessages = nextMessages.map((message, index) =>
          index === existingLocation.messageIndex
            ? updateSnapshotMessageTool(message, existingLocation.toolIndex, liveTool.tool)
            : message,
        );
        changed = true;
        mergedToolCount += 1;
        continue;
      }

      const parentLocation = liveTool.parentToolUseId
        ? findToolLocation(nextMessages, liveTool.parentToolUseId)
        : null;
      const targetMessageIndex =
        parentLocation?.messageIndex ?? latestAssistantMessageIndex(nextMessages);
      if (targetMessageIndex < 0) {
        continue;
      }

      nextMessages = nextMessages.map((message, index) =>
        index === targetMessageIndex ? appendSnapshotMessageTool(message, liveTool.tool) : message,
      );
      changed = true;
      mergedToolCount += 1;
    }

    if (changed) {
      logger.debug(undefined, "ZCode snapshot merged live tool projection", {
        event: "zcode_task.snapshot.live_tool_projection.merged",
        liveToolCount: liveTools.length,
        mergedToolCount,
        taskId: meta.taskId,
        workspaceIdentity: meta.workspaceIdentity,
        workspacePath: meta.workspacePath,
      });
    }
    return changed ? nextMessages : messages;
  }

  function rememberTaskTarget(params: TaskTarget): void {
    const existing = taskTargets.get(params.taskId);
    taskTargets.set(params.taskId, {
      ...params,
      // cronAutomationId is the session's sticky ownership marker for UI grouping; it does
      // not affect the current turn's tool permissions. Keep the authoritative value when
      // resume/onDynamicTaskEvent omit it; only rememberIndexedTaskMeta may set or clear it.
      cronAutomationId: params.cronAutomationId ?? existing?.cronAutomationId,
    });
  }

  function getTaskTarget(taskId: string): TaskTarget {
    const target = taskTargets.get(taskId);
    if (!target) {
      throw Object.assign(new Error(`ZCode session target is not loaded: ${taskId}`), {
        code: "ZCODE_SESSION_TARGET_NOT_FOUND",
      });
    }
    return target;
  }

  function getOverlay(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    taskId: string;
  }) {
    return overlays.get(taskKey(params)) ?? {};
  }

  function getToolProjectionMemory(params: TaskTarget): ZCodeToolProjectionMemory {
    const key = taskKey(params);
    let memory = toolProjectionMemoryByTaskKey.get(key);
    if (!memory) {
      memory = createZCodeToolProjectionMemory();
      toolProjectionMemoryByTaskKey.set(key, memory);
    }
    return memory;
  }

  function clearStreamingToolInputCache(params: TaskTarget): void {
    toolProjectionMemoryByTaskKey.get(taskKey(params))?.streamingToolInputById?.clear();
  }

  function setOverlay(
    params: {
      workspacePath: string;
      workspaceIdentity?: string;
      taskId: string;
    },
    patch: Partial<TaskOverlay>,
  ) {
    const key = taskKey(params);
    overlays.set(key, { ...overlays.get(key), ...patch });
  }

  // The workspace emitter moved up into the syncer; the adapter gets the shared emitter via
  // the syncer so task-adapter and desktop-continuous paths share one subscription and the
  // UI misses nothing.
  function getWorkspaceEmitter(workspace: WorkspaceEventInput): Emitter<ZCodeWorkspaceEvent> {
    return taskIndexSyncer.getWorkspaceEmitter(workspace);
  }

  function getTaskEmitter(params: TaskTarget): Emitter<ZCodeStreamEvent> {
    const key = taskKey(params);
    let emitter = taskEmitters.get(key);
    if (!emitter) {
      emitter = new Emitter<ZCodeStreamEvent>();
      taskEmitters.set(key, emitter);
    }
    return emitter;
  }

  function getGlobalTaskEmitter(taskId: string): Emitter<ZCodeStreamEvent> {
    let emitter = globalTaskEmitters.get(taskId);
    if (!emitter) {
      emitter = new Emitter<ZCodeStreamEvent>();
      globalTaskEmitters.set(taskId, emitter);
    }
    return emitter;
  }

  function emitTaskEvent(params: TaskTarget, event: ZCodeStreamEvent): void {
    getTaskEmitter(params).fire(event);
    getGlobalTaskEmitter(params.taskId).fire(event);
  }

  // Delegate to the syncer so task metadata changes (archive/rename/pin/delete) and the
  // desktop-continuous path (turn.completed etc.) share one broadcast channel.
  // Design correction: reason is required; emit sites must declare the change kind.
  function emitWorkspaceTaskListChanged(
    params: {
      workspacePath: string;
      workspaceIdentity?: string;
      taskId?: string;
    },
    taskMeta: ZCodeTaskMeta | undefined,
    reason: ZCodeWorkspaceTaskListChanged["reason"],
  ) {
    taskIndexSyncer.emitWorkspaceTaskListChanged(params, taskMeta, reason);
  }

  function emitWorkspaceConfig(
    params: ZCodeAgentWorkspaceTarget,
    settings: ZCodeSessionSettingsState,
  ) {
    getWorkspaceEmitter(params).fire({
      type: "workspace_config_options_update",
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      configOptions: settingsToConfigOptions(settings),
    });
  }

  async function readTaskAutoArchiveConfig(): Promise<{
    olderThanDays: number;
  } | null> {
    if (!options.settingService) {
      return null;
    }
    try {
      const settings = await options.settingService.get();
      if (!settings.taskAutoArchiveEnabled) {
        return null;
      }
      return {
        olderThanDays: settings.taskAutoArchiveOlderThanDays ?? 7,
      };
    } catch (error) {
      logger.warn(undefined, "Auto-archive settings read failed; skipping this round", error);
      return null;
    }
  }

  async function runWorkspaceTaskAutoArchive(
    scopes: Array<{ workspacePath: string; workspaceIdentity?: string }>,
  ): Promise<void> {
    if (scopes.length === 0) {
      return;
    }
    const config = await readTaskAutoArchiveConfig();
    if (!config) {
      return;
    }
    const seenWorkspaceKeys = new Set<string>();
    let archivedCount = 0;
    for (const scope of scopes) {
      const key = resolveWorkspaceKey(scope);
      if (seenWorkspaceKeys.has(key)) {
        continue;
      }
      seenWorkspaceKeys.add(key);
      // Auto-archive covers every existing task by workspace/age/completion, including history hidden from lists.
      const archivedTasks = await taskIndexRepo.archiveStaleTasks({
        workspacePath: scope.workspacePath,
        workspaceIdentity: scope.workspaceIdentity,
        olderThanDays: config.olderThanDays,
      });
      archivedCount += archivedTasks.length;
      for (const task of archivedTasks) {
        setOverlay(task, { archived: true });
        rememberIndexedTaskMeta(task);
        // Ownership change (auto-archive): keep the task_meta_changed membership-refetch
        // convergence for now.
        emitWorkspaceTaskListChanged(task, task, "task_meta_changed");
      }
    }
    if (archivedCount > 0) {
      logger.info(
        undefined,
        `Auto-archived old tasks count=${archivedCount} olderThanDays=${config.olderThanDays}`,
      );
    }
  }

  async function resumeSnapshot(
    params: TaskTargetWithMcpServers,
  ): Promise<ZCodeSessionStateSnapshot> {
    rememberTaskTarget(params);
    const thoughtLevel = params.thoughtLevel?.trim();
    const mcpServers = await resolveProductMcpServers(params.mcpServers);
    return options.zcodeAgentService.resumeSession({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      sessionId: params.taskId,
      // Phone replayable resume still goes through the task adapter, and the stale-model
      // guard runs inside session resume; pass the current UI model so the guard is not
      // desktop-continuous-only.
      model: params.model ? parseModelPickerValue(params.model) : undefined,
      ...(thoughtLevel ? { thoughtLevel } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(params.toolDenylist ? { toolDenylist: params.toolDenylist } : {}),
    });
  }

  /**
   * Submits session-level config writes (model/thought level/mode) as v4 CAS commands.
   * The host keeps no local v4 projection; revision converges via the stale ACK's
   * revisionAtDecision (sendHostCasCommandV4).
   * Same caveat as compact/goal: legacy stateRevision and the v4 conversation revision are
   * two counters. Use only the revision reported by the v4 ACK; never mix in expectedRevision.
   */
  async function sendConfigCasCommandV4<T extends "switchModelConfig" | "switchCollaborationMode">(
    target: TaskTarget,
    type: T,
    payload: CommandPayloadMap[T],
    contextMessage: string,
  ): Promise<void> {
    await sendHostCasCommandV4({
      send: (envelope) =>
        options.zcodeAgentService.sendConversationCommandV4({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          envelope,
        }),
      type,
      payload,
      sessionId: target.taskId,
      contextMessage,
    });
  }

  /**
   * session/setMode → v4 switchCollaborationMode。
   * auto exception: the v4 command value domain deliberately excludes auto (not
   * user-switchable, not in the UI command surface, per command.ts) while the legacy
   * ZCodeSessionMode includes it. For zero UI behavior change, auto keeps the legacy op and
   * every other value goes native v4. Endgame = settle once v4 rules on auto semantics.
   */
  async function switchCollaborationModeViaProtocol(
    target: TaskTarget,
    mode: ZCodeSessionMode,
  ): Promise<void> {
    if (mode === "auto") {
      await options.zcodeAgentService.setMode({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        sessionId: target.taskId,
        mode,
      });
      return;
    }
    await sendConfigCasCommandV4(
      target,
      "switchCollaborationMode",
      { mode },
      `session=${target.taskId} mode=${mode}`,
    );
  }

  async function repairEmptyImportedClaudeSnapshot(
    params: TaskTargetWithMcpServers,
    snapshot: ZCodeSessionStateSnapshot,
  ): Promise<ZCodeSessionStateSnapshot> {
    const repaired = await repairImportedClaudeSessionSnapshot({
      snapshot,
      target: params,
      createSession: (input) => options.zcodeAgentService.createSession(input),
      onRepair: (history) => {
        logger.warn(
          undefined,
          `Claude import protocol history abnormal; backfilled from ${history.source} taskId=${params.taskId}`,
        );
      },
    });
    if (!repaired) {
      return snapshot;
    }
    const meta = await syncTaskIndexSnapshot(repaired);
    await syncTaskIndexMeta({ ...meta, migrationSource: "claudeCode" });
    return repaired;
  }

  function isSessionMissingError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /\bSession (not found|is not active):/i.test(message);
  }

  async function readLegacyTaskSnapshot(params: TaskTarget): Promise<ZCodeTaskSnapshot | null> {
    const paths = [
      getLegacyTaskSessionSnapshotPath(
        params.workspacePath,
        params.taskId,
        params.workspaceIdentity,
      ),
      getLegacyDeletedTaskSessionSnapshotPath(
        params.workspacePath,
        params.taskId,
        params.workspaceIdentity,
      ),
    ];
    const snapshotPath = paths.find((path) => existsSync(path));
    if (!snapshotPath) {
      return null;
    }

    try {
      const rawSnapshot = JSON.parse(readFileSync(snapshotPath, "utf-8")) as unknown;
      const parsed = safeParseLegacyTaskSessionFile(rawSnapshot);
      if (!parsed.success) {
        logger.warn(
          undefined,
          `Invalid legacy task snapshot taskId=${params.taskId}`,
          parsed.error.flatten(),
        );
        return null;
      }

      const legacyFile = parsed.data;
      const indexedMeta = await taskIndexRepo.getTaskMeta(params).catch(() => null);
      const legacyMeta: ZCodeTaskMeta = {
        ...legacyFile.meta,
        // Bugfix: legacy ACP tasks live only in ~/.zcode/v2/sessions/*.json, never in the
        // zcode-cli sqlite session table, so protocol resume treats taskId as sessionId and
        // fails with Session not found. Restore read-only history from the legacy snapshot and
        // backfill rename/archive/terminal status from the task index instead of treating the
        // old task as a subscribable new session.
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity ?? legacyFile.meta.workspaceIdentity,
        title: indexedMeta?.title ?? legacyFile.meta.title,
        updatedAt: indexedMeta?.updatedAt ?? legacyFile.meta.updatedAt,
        mode: legacyFile.meta.mode ?? indexedMeta?.mode ?? "default",
        provider: legacyFile.meta.provider ?? indexedMeta?.provider ?? GLM_PROVIDER,
        status: legacyFile.meta.status ?? indexedMeta?.status ?? "completed",
        lastError: legacyFile.meta.lastError ?? indexedMeta?.lastError,
      };
      const snapshot: ZCodeTaskSnapshot = {
        ...legacyFile,
        meta: applyOverlayToMeta(legacyMeta, getOverlay(params)),
        runtime: {
          apiRetry: apiRetryByTaskKey.get(taskKey(params)) ?? null,
          pendingCommands: runtimeCommands.get(taskKey(params)) ?? [],
        },
      };
      legacySnapshotTaskKeys.add(taskKey(params));
      rememberIndexedTaskMeta(snapshot.meta);
      return snapshot;
    } catch (error) {
      logger.warn(undefined, `Legacy task snapshot read failed taskId=${params.taskId}`, error);
      return null;
    }
  }

  async function resumeSnapshotOrLegacy(
    params: TaskTargetWithMcpServers,
  ): Promise<
    | { kind: "session"; snapshot: ZCodeSessionStateSnapshot }
    | { kind: "legacy"; snapshot: ZCodeTaskSnapshot }
  > {
    try {
      const snapshot = await resumeSnapshot(params);
      return {
        kind: "session",
        snapshot: await repairEmptyImportedClaudeSnapshot(params, snapshot),
      };
    } catch (error) {
      if (!isSessionMissingError(error)) {
        throw error;
      }
      const legacySnapshot = await readLegacyTaskSnapshot(params);
      if (!legacySnapshot) {
        throw error;
      }
      if (legacySnapshot.meta.migrationSource === "claudeCode") {
        try {
          const mcpServers = await resolveProductMcpServers(params.mcpServers);
          const snapshot = await options.zcodeAgentService.createSession({
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
            sessionId: params.taskId,
            sessionTraceId: legacySnapshot.meta.traceId ?? createSessionTraceId(),
            persistence: "immediate",
            model: params.model ? parseModelPickerValue(params.model) : undefined,
            ...(mcpServers ? { mcpServers } : {}),
            ...(params.toolDenylist ? { toolDenylist: params.toolDenylist } : {}),
            importedHistory: {
              source: "claudeCode",
              title: legacySnapshot.meta.title,
              createdAt: legacySnapshot.meta.createdAt,
              updatedAt: legacySnapshot.meta.updatedAt,
              messages: legacySnapshot.messages.map((message) => ({
                role: message.role,
                content: message.content,
                timestamp: message.timestamp,
              })),
            },
          });
          const meta = await syncTaskIndexSnapshot(snapshot);
          await syncTaskIndexMeta({ ...meta, migrationSource: "claudeCode" });
          logger.info(
            undefined,
            `Legacy Claude import promoted to ZCode session taskId=${params.taskId}`,
          );
          return { kind: "session", snapshot };
        } catch (upgradeError) {
          logger.warn(
            undefined,
            `Legacy promotion failed; read-only resume continues taskId=${params.taskId}`,
            upgradeError,
          );
        }
      }
      logger.warn(
        undefined,
        `ZCode session missing; restored from legacy snapshot taskId=${params.taskId}`,
        error,
      );
      return { kind: "legacy", snapshot: legacySnapshot };
    }
  }

  function snapshotToMeta(snapshot: ZCodeSessionStateSnapshot): ZCodeTaskMeta {
    const target = {
      taskId: snapshot.session.sessionId,
      workspacePath: snapshot.session.workspace.workspacePath,
      workspaceIdentity: snapshot.session.workspace.workspaceIdentity,
    };
    rememberTaskTarget(target);
    return applyOverlayToMeta(
      {
        taskId: snapshot.session.sessionId,
        traceId: snapshot.session.traceId ?? generateTraceId(snapshot.session.sessionId),
        title: deriveTitleFromSnapshot(snapshot),
        workspacePath: snapshot.session.workspace.workspacePath,
        workspaceIdentity: snapshot.session.workspace.workspaceIdentity,
        createdAt: snapshot.session.createdAt,
        updatedAt: snapshot.session.updatedAt,
        mode: fromZCodeMode(snapshot.session.mode),
        model: formatTaskMetaModelSelectionFromSnapshot(snapshot),
        thoughtLevel: snapshot.settings.thoughtLevel.current,
        provider: GLM_PROVIDER,
        status: deriveZCodeTaskStatusFromSessionSnapshot(snapshot),
        lastError: snapshot.projection.lastError
          ? {
              code: snapshot.projection.lastError.code ?? snapshot.projection.lastError.type,
              ...(snapshot.projection.lastError.detail
                ? { detail: snapshot.projection.lastError.detail }
                : {}),
              // The service snapshot feeds mobile replayable/cold task meta; keep its
              // lastError attribution aligned with the UI projection.
              ...(snapshot.projection.lastError.attribution
                ? { attribution: snapshot.projection.lastError.attribution }
                : {}),
              message: snapshot.projection.lastError.message,
            }
          : undefined,
        target: snapshot.projection.target
          ? fromZCodeGoal(snapshot.projection.target)
          : snapshot.projection.target,
      },
      getOverlay(target),
    );
  }

  function rememberIndexedTaskMeta(meta: ZCodeTaskMeta): ZCodeTaskMeta {
    const existing = taskTargets.get(meta.taskId);
    // Authoritative ownership refresh: index meta is the only source allowed to set/clear
    // cronAutomationId; write it verbatim (bypassing rememberTaskTarget's merge-preserve) so
    // unlinking/deleting an automation truly clears it.
    taskTargets.set(meta.taskId, {
      ...existing,
      taskId: meta.taskId,
      workspacePath: meta.workspacePath,
      workspaceIdentity: meta.workspaceIdentity,
      cronAutomationId: meta.cronAutomationId,
    });
    return meta;
  }

  async function resolveTaskIndexResumeHints(
    params: TaskTarget,
    reason: "replayable_snapshot" | "resume_task",
  ): Promise<{ model?: string; thoughtLevel?: string }> {
    const meta = await taskIndexRepo.getTaskMeta(params).catch((error) => {
      logger.warn(undefined, "Resume hint read failed; resuming without saved config", {
        error: error instanceof Error ? error.message : String(error),
        reason,
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
      return null;
    });
    const model = meta?.model?.trim();
    const thoughtLevel = meta?.thoughtLevel?.trim();
    if (model || thoughtLevel) {
      // Task-local thoughtLevel is a history-restore hint, same as model. Without backfill,
      // the workspace draft default overwrites the active task after session/resume.
      logger.info(undefined, "Resume config backfilled from the task index", {
        model: model || null,
        thoughtLevel: thoughtLevel || null,
        reason,
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
    }
    return {
      ...(model ? { model } : {}),
      ...(thoughtLevel ? { thoughtLevel } : {}),
    };
  }

  async function syncTaskIndexMeta(meta: ZCodeTaskMeta): Promise<ZCodeTaskMeta> {
    const indexedMeta = await taskIndexRepo.syncTaskMeta({ meta });
    return rememberIndexedTaskMeta(indexedMeta);
  }

  async function syncTaskIndexSnapshot(
    snapshot: ZCodeSessionStateSnapshot,
  ): Promise<ZCodeTaskMeta> {
    const meta = snapshotToMeta(snapshot);
    // Explicit restore of a stale polluted tab must not write the read-only child into the main task index again.
    if (snapshot.session.sessionKind === "subagent_child") return meta;
    return syncTaskIndexMeta(meta);
  }

  async function updateIndexedTaskState(
    params: TaskTarget,
    patch: {
      pinned?: boolean;
      archived?: boolean;
      deleted?: boolean;
      title?: string;
      titleOverridden?: boolean;
      updatedAt?: number;
      unreadAt?: number;
    },
  ): Promise<ZCodeTaskMeta> {
    try {
      return await taskIndexRepo.updateTaskState({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        taskId: params.taskId,
        patch,
      });
    } catch (error) {
      // A legacy ZCode session may have no lightweight task index row yet. State actions
      // happen only after a task is opened, so seeding the index on demand is fine; the
      // sidebar full list still reads sqlite only and never starts every workspace agent.
      logger.warn(undefined, "Task index missing; seeding current task from the agent", error);
      await syncTaskIndexSnapshot(await resumeSnapshot(params));
      return taskIndexRepo.updateTaskState({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        taskId: params.taskId,
        patch,
      });
    }
  }

  function updateTaskIndexFromStreamEvent(params: TaskTarget, event: ZCodeStreamEvent): void {
    if (event.type === "session_info_update") {
      const patch: Parameters<typeof taskIndexRepo.applyAgentPatch>[0]["patch"] = {
        title: typeof event.title === "string" ? event.title : undefined,
        updatedAt: Date.now(),
      };
      if (event.target) {
        // session_info_update often carries only title/updatedAt; overwrite the task-index
        // target only when the event includes it, or goals restored from db.sqlite become
        // undefined.
        patch.target = event.target.target;
      }
      void taskIndexRepo
        .applyAgentPatch({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          taskId: params.taskId,
          patch,
        })
        .catch((error) => {
          logger.warn(undefined, "session_info_update index sync failed", error);
        });
      return;
    }

    if (event.type === "task_complete") {
      void taskIndexRepo
        .applyAgentPatch({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          taskId: params.taskId,
          patch: {
            status: "completed",
            lastError: undefined,
            updatedAt: Date.now(),
          },
        })
        .catch((error) => {
          logger.warn(undefined, "task_complete index sync failed", error);
        });
      return;
    }

    if (event.type === "task_error") {
      void taskIndexRepo
        .applyAgentPatch({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          taskId: params.taskId,
          patch: {
            status: "error",
            lastError: {
              code: event.code,
              ...(event.detail ? { detail: event.detail } : {}),
              message: event.error,
              traceId: event.traceId,
              taskId: params.taskId,
              ...(event.attribution ? { attribution: event.attribution } : {}),
            },
            updatedAt: Date.now(),
          },
        })
        .catch((error) => {
          logger.warn(undefined, "task_error index sync failed", error);
        });
    }
  }

  function updateTaskApiRetryFromStreamEvent(params: TaskTarget, event: ZCodeStreamEvent): void {
    const key = taskKey(params);
    if (event.type === "session_info_update" && event.apiRetry !== undefined) {
      apiRetryByTaskKey.set(key, event.apiRetry ?? null);
      return;
    }
    if (event.type === "task_complete" || event.type === "task_error") {
      apiRetryByTaskKey.set(key, null);
    }
  }

  function hasActiveTaskApiRetry(params: TaskTarget): boolean {
    return apiRetryByTaskKey.get(taskKey(params)) != null;
  }

  function snapshotToZCode(
    snapshot: ZCodeSessionStateSnapshot,
    options?: { includeEmptyPendingElicitations?: boolean },
  ): ZCodeTaskSnapshot {
    const meta = snapshotToMeta(snapshot);
    const activeGoalIterationCount = getSnapshotGoalActiveIterationCount(snapshot);
    const goalIterationByAssistantMessageId = getZCodeGoalIterationByAssistantMessageId(
      snapshot.messages,
      {
        ...(activeGoalIterationCount > 0 ? { maxGoalIteration: activeGoalIterationCount } : {}),
        target: snapshot.projection.target,
      },
    );
    const backgroundTaskNotifications = collectZCodeBackgroundTaskNotificationsByToolUseId(
      snapshot.messages,
    );
    const messages = mergeLiveToolProjectionIntoSnapshotMessages(
      meta,
      normalizeGoalVerificationTimelineMessageOrder(
        addGoalVerificationTimelineSnapshotFallback(
          addSessionForkSnapshotFallback(
            coalesceConsecutiveZCodeAssistants(
              getZCodeUserVisibleMessages(snapshot.messages, {
                target: snapshot.projection.target,
              }).map((message) =>
                mapMessage(
                  message,
                  message.info.role === "assistant"
                    ? goalIterationByAssistantMessageId.get(message.info.messageId)
                    : undefined,
                  backgroundTaskNotifications,
                ),
              ),
            ),
            snapshot,
          ),
          snapshot,
        ),
      ),
    );
    const pendingPermissions: ZCodePermissionRequest[] = snapshot.projection.pendingPermissions
      .filter((permission) => !isUserInputBackedPermissionToolName(permission.toolName))
      .map((permission) => pendingPermissionToStreamEvent(snapshot.session.sessionId, permission));
    const pendingElicitations = snapshot.projection.pendingPermissions
      .filter((permission) => isUserInputBackedPermissionToolName(permission.toolName))
      .map((permission) =>
        pendingUserInputBackedPermissionToElicitationEvent(snapshot.session.sessionId, permission),
      )
      .filter(
        (event): event is Extract<ZCodeStreamEvent, { type: "elicitation_request" }> =>
          event !== null,
      );
    const backgroundTaskControls = parseZCodeBackgroundTaskControlItems(
      snapshot.projection.backgroundJobs,
    );
    setTaskBackgroundTaskControlCache(
      backgroundTaskControlsByTaskKey,
      taskKey(meta),
      backgroundTaskControls,
    );
    return {
      meta,
      messages,
      fileChanges: [],
      configOptions: settingsToConfigOptions(snapshot.settings),
      // The agent protocol snapshot carries commands like /compact; the task facade must
      // keep them or replayable/legacy restore blanks the UI slashCommands.
      slashCommands: snapshot.slashCommands ?? EMPTY_SLASH_COMMANDS,
      runtime: {
        activeTurnKind: snapshot.runtime.activeTurnKind,
        apiRetry: apiRetryByTaskKey.get(taskKey(meta)) ?? null,
        contextUsage:
          contextUsageFromRuntime(snapshot.runtime.contextUsage) ??
          contextUsageFromProjection(snapshot.projection) ??
          undefined,
        pendingPermissions,
        backgroundBashJobs: backgroundTaskControls,
        // Phone replayable snapshots need an empty array to mean user-input-queue-cleared.
        // Keep the desktop-continuous projection unchanged so replayable restore semantics
        // do not leak into it.
        ...(pendingElicitations.length > 0 || options?.includeEmptyPendingElicitations
          ? { pendingElicitations }
          : {}),
        pendingCommands: runtimeCommands.get(taskKey(meta)) ?? [],
        // Todo truth lives in the agent DB; history restore must map it to the UI via the
        // snapshot, not rely on plan stream events the renderer happened to receive.
        plan: sessionTodosToPlanSteps(snapshot.todos),
        goalStats: sessionGoalStatsToRuntime(snapshot.goalStats),
        goalVerifications: snapshot.runtime.goalVerifications ?? null,
        goalVerificationTimeline: snapshot.runtime.goalVerificationTimeline ?? null,
        todoGroups: sessionTodoGroupsToRuntime(snapshot.todoGroups),
      },
    };
  }

  function mapServiceEvent(params: TaskTarget, event: ZCodeAgentServiceEvent): void {
    if (event.type === "snapshot") {
      void syncTaskIndexSnapshot(event.snapshot).catch((error) => {
        logger.warn(undefined, "ZCode snapshot index sync failed", error);
      });
      const snapshotEvent: ZCodeStreamEvent = {
        type: "task_snapshot_updated",
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        workspaceKey: workspaceKey(params),
        taskId: params.taskId,
        traceId: generateTraceId(params.taskId),
      };
      emitTaskEvent(params, snapshotEvent);
      emitWorkspaceConfig(params, event.snapshot.settings);
      return;
    }

    if (event.type === "state.updated") {
      for (const streamEvent of mapStateUpdated(params, event.notification)) {
        emitTaskEvent(params, streamEvent);
      }
      return;
    }

    if (event.type === "permission.request") {
      emitTaskEvent(params, permissionRequestToStreamEvent(params.taskId, event.request));
      return;
    }

    if (event.type === "userInput.request") {
      emitTaskEvent(params, userInputRequestToElicitationStreamEvent(params.taskId, event.request));
      return;
    }

    if (event.type === "userInput.response") {
      emitTaskEvent(
        params,
        userInputResponseToElicitationStreamEvent(params.taskId, event.requestId, event.response),
      );
      return;
    }

    if (event.type === "providerRuntimeHeaders.request") {
      return;
    }

    if (event.type === "session.event") {
      recordAgentModelNetworkTelemetry(event.event);
      if (event.event.type === "turn.started") {
        const payload = asRecord(event.event.payload);
        const inputId = stringValue(payload.inputId);
        if (inputId) {
          // remote/replayable/fallback subscriptions are not always created by sendPrompt.
          // turn.started is the protocol fact attributing later model.streaming events to
          // this input; record it in the services projection layer too.
          activePromptInputIds.set(taskKey(params), inputId);
        }
      }
    }

    const activePromptInputId = activePromptInputIds.get(taskKey(params));
    const streamEvents = mapSessionEvent(
      params,
      event.event,
      streamedTurnText,
      activePromptInputId,
      getToolProjectionMemory(params),
      backgroundTaskControlsByTaskKey,
      hasActiveTaskApiRetry(params),
    );
    for (const streamEvent of streamEvents) {
      rememberLiveToolProjection(params, streamEvent);
      updateTaskApiRetryFromStreamEvent(params, streamEvent);
      updateTaskIndexFromStreamEvent(params, streamEvent);
      emitTaskEvent(params, streamEvent);
      if (streamEvent.type === "task_complete" || streamEvent.type === "task_error") {
        completeRuntimeCommandForTerminalEvent(params, streamEvent);
      }
    }
    if (event.event.type === "turn.completed" || event.event.type === "turn.failed") {
      activePromptInputIds.delete(taskKey(params));
    }
  }

  let disposed = false;

  function handleTaskIndexTerminalEvent(event: ZCodeTaskIndexTerminalEvent): void {
    const params: TaskTarget = {
      taskId: event.target.sessionId,
      workspacePath: event.target.workspacePath,
      workspaceIdentity: event.target.workspaceIdentity,
    };
    const key = taskKey(params);
    if (!activePromptInputIds.has(key) && !runtimeCommands.has(key)) {
      return;
    }
    // Terminal events now come from v4 sessions-index phase transitions whose summaries
    // carry no inputId; always settle with the locally recorded active input (the same
    // fallback as legacy missing payload.inputId, semantics unchanged).
    const terminalInputId = activePromptInputIds.get(key);
    completeRuntimeCommandByInputId(params, terminalInputId, event.kind);
    // A turn terminal only means the stream closed, not that the agent server released its
    // active lock. Settle this input only; the next host command waits for the ready event.
    activePromptInputIds.delete(key);
  }

  const taskIndexTerminalDisposable = taskIndexSyncer.onSessionTerminalEvent((event) => {
    queueMicrotask(() => {
      if (!disposed) {
        handleTaskIndexTerminalEvent(event);
      }
    });
  });

  function handleTaskIndexReadyEvent(event: ZCodeTaskIndexReadyEvent): void {
    const params: TaskTarget = {
      taskId: event.target.sessionId,
      workspacePath: event.target.workspacePath,
      workspaceIdentity: event.target.workspaceIdentity,
    };
    const key = taskKey(params);
    if (!activePromptInputIds.has(key) && !runtimeCommands.has(key)) {
      return;
    }
    const activeInputId = activePromptInputIds.get(key);
    completeRuntimeCommandByInputId(params, activeInputId, event.reason);
    // prompt_completed/prompt_failed are emitted after the agent server releases
    // activeAbortController. The phone host command queue uses them as the next-send-ok ready
    // boundary instead of fixed-delay retries; the desktop continuous renderer-local queue
    // is unchanged.
    activePromptInputIds.delete(key);
    scheduleRuntimeCommandDrain(params, "session-ready");
  }

  const taskIndexReadyDisposable = taskIndexSyncer.onSessionReadyEvent((event) => {
    queueMicrotask(() => {
      if (!disposed) {
        handleTaskIndexReadyEvent(event);
      }
    });
  });

  function disposeLocalTaskState(): void {
    taskIndexTerminalDisposable.dispose();
    taskIndexReadyDisposable.dispose();
    taskIndexRepo.close();
    for (const emitter of taskEmitters.values()) emitter.dispose();
    for (const emitter of globalTaskEmitters.values()) emitter.dispose();
    errorEmitter.dispose();
    taskEmitters.clear();
    globalTaskEmitters.clear();
    runtimeCommandDrains.clear();
    streamedTurnText.clear();
  }

  async function disposeZCodeAgentServiceAndWait(): Promise<void> {
    const agentService = options.zcodeAgentService as IZCodeAgentService & {
      disposeAllAndWait?: () => Promise<void>;
    };
    if (agentService.disposeAllAndWait) {
      await agentService.disposeAllAndWait();
      return;
    }
    agentService.disposeAll();
  }

  const service: IZCodeTaskService & {
    disposeAll(): void;
    disposeAllAndWait(): Promise<void>;
  } = {
    async initialize(params) {
      const result = await options.zcodeAgentService.initialize(params);
      return {
        available: result.available,
        version: result.protocolName
          ? `${result.protocolName}/${result.protocolVersion ?? 1}`
          : undefined,
      };
    },

    async releaseWorkspacePreparation(params): Promise<void> {
      // Closing the workspace UI only releases the RPC consumer; it does not stop a prewarmed
      // agent. Shared WSL hosts keep living, so reclaim the runtime by workspaceKey.
      await options.zcodeAgentService.disposeWorkspace(normalizeWorkspaceParams(params));
    },

    async checkCodexConnectivity(): Promise<ZCodeCodexConnectivityCheckResult> {
      return { target: "zcode-agent", reachable: true };
    },

    async createTask(params): Promise<ZCodeTaskCreateResult> {
      const target = normalizeWorkspaceParams(params);
      const requestedSelection =
        params.modelSelection ??
        (params.model
          ? {
              ...parseModelPickerValue(params.model),
              ...(params.thoughtLevel ? { options: { reasoningLevel: params.thoughtLevel } } : {}),
            }
          : undefined);
      const draftSessionId = params.draftSessionId?.trim();
      const mcpServers = await resolveProductMcpServers(params.mcpServers);
      let snapshot: ZCodeSessionStateSnapshot | null = null;
      if (draftSessionId && !mcpServers) {
        try {
          snapshot = await options.zcodeAgentService.readSession({
            ...target,
            sessionId: draftSessionId,
          });
          if (requestedSelection) {
            if (!sameModelSelection(snapshot.settings.model.current, requestedSelection)) {
              // When replayable first-send reuses a draft session, the draft may still be on
              // the prewarm-time model. Sync the UI model before reuse or the phone shows the
              // new model while the request uses the old one.
              snapshot = await options.zcodeAgentService.setModel({
                ...target,
                sessionId: draftSessionId,
                model: requestedSelection,
              });
            }
          }
          if (
            requestedSelection?.options?.reasoningLevel &&
            snapshot.settings.thoughtLevel.current !== requestedSelection.options.reasoningLevel
          ) {
            // Replayable first-send reuse must also honor the current UI thought_level, or a
            // reused draft session sends with a stale reasoning level.
            snapshot = await options.zcodeAgentService.setThoughtLevel({
              ...target,
              sessionId: draftSessionId,
              thoughtLevel: requestedSelection.options.reasoningLevel,
            });
          }
        } catch (error) {
          if (!isSessionMissingError(error)) {
            throw error;
          }
          // Phone draft sessions live only in agent runtime memory, like on desktop. A
          // reconnect/agent restart can invalidate the draftSessionId; fall back to a fresh
          // task at first send instead of stranding the user.
          logger.warn(undefined, "Phone replayable draft expired; creating a fresh task", {
            draftSessionId,
            workspaceIdentity: target.workspaceIdentity ?? null,
            workspacePath: target.workspacePath,
          });
        }
      }
      if (!snapshot) {
        // The v4 createSession command is native (the desktop v4 UI uses it), but replayable
        // createTask needs mcpServers/model/importedHistory payloads plus a snapshot return
        // value (task index sync); none are modeled on the v4 command surface yet.
        if (params.v4Create === true) {
          const model = requestedSelection;
          const ack = assertV4CommandAckOk(
            "createSession",
            await options.zcodeAgentService.sendConversationCommandV4({
              ...target,
              envelope: createHostCommandEnvelope({
                type: "createSession",
                sessionId: null,
                payload: {
                  workspaceId: target.workspaceIdentity?.trim() || target.workspacePath,
                  ...(params.permissionScope ? { permissionScope: params.permissionScope } : {}),
                  config: {
                    ...(model ? { provider: model.providerId, model: model.modelId } : {}),
                    ...(model?.options?.reasoningLevel
                      ? { thought: model.options.reasoningLevel }
                      : {}),
                    ...(params.mode ? { mode: toZCodeMode(params.mode) } : {}),
                  },
                  ...(mcpServers ? { mcpServers } : {}),
                },
              }),
            }),
            `workspace=${target.workspacePath}`,
          );
          const sessionId = ack.result?.type === "createSession" ? ack.result.sessionId : undefined;
          if (!sessionId) {
            throw new Error("v4 createSession accepted without sessionId result");
          }
          snapshot = await options.zcodeAgentService.readSession({
            ...target,
            sessionId,
          });
        } else {
          snapshot = await options.zcodeAgentService.createSession({
            ...target,
            sessionTraceId: createSessionTraceId(),
            mode: toZCodeMode(params.mode),
            model: requestedSelection,
            thoughtLevel: requestedSelection?.options?.reasoningLevel,
            ...(params.automationId || params.deferPersistenceUntilFirstPrompt
              ? {
                  // Fix: automation/off-peak tasks sendText right after creating an empty
                  // session. session_input has a session FK, so V4 admission must persist the
                  // session row before the first send, or the first prompt deterministically
                  // fails with FOREIGN KEY constraint failed.
                  persistence: "deferred" as const,
                }
              : {}),
            ...(params.automationId
              ? {
                  titleGenerationEnabled: false,
                }
              : {}),
            // Bugfix: the replayable task facade also starts a runtime on session create;
            // dropping mcpServers here made phone remote-control MCP behavior differ from
            // desktop-continuous.
            mcpServers,
          });
        }
      }
      const baseMeta = snapshotToMeta(snapshot);
      const meta = await syncTaskIndexMeta({
        ...baseMeta,
        ...(params.automationId ? { cronAutomationId: params.automationId } : {}),
        // Off-peak dispatch stamps persistent ownership at creation; the moon icon and later system grouping read only this marker.
        ...(params.offPeakTaskId ? { offPeakTaskId: params.offPeakTaskId } : {}),
      });
      await taskIndexRepo.initializeGroupedTaskAtTop({
        workspacePath: meta.workspacePath,
        workspaceIdentity: meta.workspaceIdentity,
        taskId: meta.taskId,
      });
      notifySyncerSession({
        taskId: meta.taskId,
        workspacePath: meta.workspacePath,
        workspaceIdentity: meta.workspaceIdentity,
      });
      emitWorkspaceConfig(target, snapshot.settings);
      // Tasks created via shared-host get no local optimistic insert on the desktop renderer.
      // Keep task_created semantics or the UI merely re-sorts existing items on meta events
      // and the remote home page never shows the new task.
      emitWorkspaceTaskListChanged(target, meta, "task_created");
      // The create result must carry the slash commands from the agent snapshot or the replayable first paint blanks them.
      return {
        ...meta,
        initialSlashCommands: snapshot.slashCommands ?? EMPTY_SLASH_COMMANDS,
      };
    },

    async readBotTopicSummaries(params) {
      const target = taskTargets.get(params.taskId);
      if (target && taskKey(target) !== taskKey(params))
        throw new Error("Topic task workspace mismatch");
      const messages = await options.zcodeAgentService.readSessionMessages({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        remoteSessionId: params.remoteSessionId ?? target?.remoteSessionId,
        sessionId: params.taskId,
        limit: 200,
      });
      return messages
        .flatMap(({ info, parts }) => {
          if (info.role !== "user" || info.source !== "bot_topic_context") return [];
          return [
            {
              checkpoint: String(info.metadata?.checkpoint ?? ""),
              text:
                typeof info.metadata?.displayText === "string"
                  ? info.metadata.displayText
                  : textFromParts(parts),
            },
          ];
        })
        .slice(-20);
    },

    async invalidateBotTopicInputs(params) {
      const target = getTaskTarget(params.taskId);
      if (taskKey(target) !== taskKey(params)) throw new Error("Group task workspace mismatch");
      const key = JSON.stringify([
        taskKey(params),
        params.remoteSessionId ?? target.remoteSessionId ?? null,
      ]);
      await topicAdmission.invalidate(key);
    },
    async readBotTopicExecution(params) {
      const target = getTaskTarget(params.taskId);
      if (taskKey(target) !== taskKey(params)) throw new Error("Group task workspace mismatch");
      const workspace = {
        ...params,
        remoteSessionId: params.remoteSessionId ?? target.remoteSessionId,
      };
      const snapshot = await readBotGroupRuntimeSnapshot(botAgent(workspace), {
        ...workspace,
        sessionId: params.taskId,
      });
      if (snapshot.control.stopState === "idle") return undefined;
      const execution = snapshot.control.activeWorks.find((work) => work.foregroundExecutionId);
      if (!execution?.foregroundExecutionId)
        throw new Error("Topic execution identity is unavailable");
      return {
        executionId: execution.foregroundExecutionId,
        sourceCommandId: execution.sourceCommandId,
      };
    },
    async stopBotTopicExecution(params) {
      const target = getTaskTarget(params.taskId);
      if (taskKey(target) !== taskKey(params)) throw new Error("Group task workspace mismatch");
      const workspace = {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        remoteSessionId: params.remoteSessionId ?? target.remoteSessionId,
      };
      const agent = botAgent(workspace);
      // Register the terminal listener before stopping so a fast finish cannot land between ACK and subscribe.
      const observation = new AbortController();
      const ended = waitBotGroupExecutionEnd(
        agent,
        { ...workspace, sessionId: params.taskId },
        params.executionId,
        observation.signal,
      );
      void ended.catch(() => undefined);
      try {
        const ack = await agent.sendConversationCommandV4({
          ...workspace,
          envelope: createHostCommandEnvelope({
            type: "stop",
            sessionId: params.taskId,
            payload: { expectedForegroundExecutionId: params.executionId },
          }),
        });
        assertV4CommandAckOk("stop", ack, `session=${params.taskId}`);
        await ended;
      } finally {
        observation.abort();
      }
    },

    async getBotGroupTaskBlockReason(params) {
      const target = taskTargets.get(params.taskId);
      if (target && taskKey(target) !== taskKey({ ...params, taskId: params.taskId }))
        throw new Error("Group task workspace mismatch");
      const snapshot = await readBotGroupRuntimeSnapshot(botAgent(params), {
        ...params,
        ...((params.remoteSessionId ?? target?.remoteSessionId)
          ? { remoteSessionId: params.remoteSessionId ?? target?.remoteSessionId }
          : {}),
        sessionId: params.taskId,
      });
      if (snapshot.pendingInteractions.length > 0) return "interaction";
      if (snapshot.control.phase === "running" || snapshot.control.phase === "prewarming")
        return "running";
      if (snapshot.queue.items.length > 0) return "queued";
      return null;
    },
    async cancelBotGroupInput(params) {
      const target = getTaskTarget(params.taskId);
      if (
        params.workspacePath &&
        taskKey(target) !== taskKey({ ...params, workspacePath: params.workspacePath })
      )
        throw new Error("Group task workspace mismatch");
      const workspace = {
        workspacePath: params.workspacePath ?? target.workspacePath,
        workspaceIdentity: params.workspaceIdentity ?? target.workspaceIdentity,
        ...((params.remoteSessionId ?? target.remoteSessionId)
          ? { remoteSessionId: params.remoteSessionId ?? target.remoteSessionId }
          : {}),
      };
      const snapshot = await readBotGroupRuntimeSnapshot(botAgent(workspace), {
        ...workspace,
        sessionId: target.taskId,
      });
      const item = snapshot.queue.items.find(
        (entry) => entry.sourceCommandId === params.sourceCommandId,
      );
      if (!item || item.dispatch.state !== "queued") throw new Error("Input is no longer queued");
      const source = item.botGroupSource;
      if (
        !source ||
        source.botId !== params.botId ||
        source.chatId !== params.chatId ||
        (params.actorId !== params.ownerId && source.senderId !== params.actorId)
      )
        throw new Error("Queue cancellation is not authorized");
      return botAgent(workspace).sendConversationCommandV4({
        ...workspace,
        envelope: createHostCommandEnvelope({
          type: "deleteQueueItem",
          sessionId: target.taskId,
          commandId: params.commandId,
          baseRevision: snapshot.revision,
          payload: { queueItemId: item.queueItemId },
        }),
      });
    },

    async submitBotGroupInput(params) {
      const target = getTaskTarget(params.taskId);
      if (
        params.workspacePath &&
        taskKey(target) !== taskKey({ ...params, workspacePath: params.workspacePath })
      )
        throw new Error("Group task workspace mismatch");
      const workspace = {
        workspacePath: params.workspacePath ?? target.workspacePath,
        workspaceIdentity: params.workspaceIdentity ?? target.workspaceIdentity,
        ...((params.remoteSessionId ?? target.remoteSessionId)
          ? { remoteSessionId: params.remoteSessionId ?? target.remoteSessionId }
          : {}),
      };
      const admissionKey = JSON.stringify([
        taskKey({ ...workspace, taskId: target.taskId }),
        workspace.remoteSessionId ?? null,
      ]);
      const version = topicAdmission.capture(admissionKey);
      // Bug: after a host restart the task index survives but the CLI has not loaded the
      // session, so immediate admission returns sessionNotFound. Reuse the background
      // subscription's cold-resume barrier instead of requiring the desktop to open the task.
      await readBotGroupRuntimeSnapshot(botAgent(workspace), {
        ...workspace,
        sessionId: target.taskId,
      });
      const attachments = await uploadBotGroupAttachments(
        botAgent(workspace),
        { ...workspace, sessionId: target.taskId },
        params.attachments ?? [],
      );
      // Stop can land mid-upload; a finished upload does not mean the old input is still accepted.
      if (params.source.threadId && version !== topicAdmission.capture(admissionKey)) {
        throw new Error("Topic input was cancelled during preparation");
      }
      const envelope = createHostCommandEnvelope({
        type: "sendText",
        sessionId: target.taskId,
        commandId: params.commandId,
        clientId: `bot:${params.source.botId}:${params.source.chatId}:${params.source.senderId}`,
        payload: {
          text: params.content,
          attachments,
          requestedDelivery: params.source.threadId ? "startNow" : "queue",
          botGroupSource: params.source,
          conversationQuotes: params.conversationQuotes,
          botDeliveryTarget: {
            provider: params.source.provider,
            botId: params.source.botId,
            providerUserId: params.source.chatId,
            chatType: "group",
            ...(params.source.threadId
              ? { threadId: params.source.threadId, rootMessageId: params.source.rootMessageId }
              : {}),
          },
        },
      });
      const send = async () => {
        try {
          return await botAgent(workspace).sendConversationCommandV4({
            ...workspace,
            envelope,
          });
        } catch (error) {
          // On a lost ACK, query the same command; never regenerate an ID and resend.
          const query = await botAgent(workspace)
            .queryConversationCommandsV4({
              ...workspace,
              commands: [{ sessionId: target.taskId, commandId: params.commandId }],
            })
            .catch(() => null);
          const result = query?.results[0]?.result;
          if (result && result !== "unknown") return result;
          throw error;
        }
      };
      return params.source.threadId ? topicAdmission.run(admissionKey, version, send) : send();
    },

    async sendPrompt(params): Promise<void> {
      const storedTarget = getTaskTarget(params.taskId);
      const target = {
        ...storedTarget,
        ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
      };
      await sendPromptToAgent(target, {
        traceId: params.traceId,
        queryId: params.queryId,
        messageId: params.messageId,
        content: params.content,
        attachments: params.attachments,
        ...turnAttributionOf(params),
        toolDenylist: params.toolDenylist,
        botDeliveryTarget: params.botDeliveryTarget,
        clientId: params.clientId,
        clientMode: params.clientMode,
        modelSelection: params.modelSelection,
        modelExecution: params.modelExecution,
      });
    },

    async deliverSessionMessage(
      _request: SessionMessageSendRequested,
    ): Promise<SessionMessageDeliveryResult> {
      unsupported("deliverSessionMessage");
    },

    async sendSessionMessageDeliveryResult(): Promise<void> {
      unsupported("sendSessionMessageDeliveryResult");
    },

    async enqueueTaskCommand(params): Promise<ZCodeEnqueueTaskCommandResult> {
      assertCurrentOwnerRun(params, params.ownerRunId);
      const workspaceKeyValue = workspaceKey(params);
      const command: ZCodeTaskRuntimeCommand = {
        commandId: params.commandId,
        taskId: params.taskId,
        traceId: params.traceId,
        queryId: params.queryId,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        workspaceKey: workspaceKeyValue,
        status: "accepted",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        clientId: params.clientId,
        clientLabel: params.clientLabel,
        type: "send_prompt",
        content: params.content,
        attachments: params.attachments,
        // manual run / phone replayable prompts may sit in the host command queue first;
        // dropping automationId here would drain them as plain user input and re-expose
        // CronCreate.
        automationId: params.automationId,
      };
      const key = taskKey(params);
      runtimeCommands.set(key, [...(runtimeCommands.get(key) ?? []), command]);
      // After a phone replayable host command is accepted, the frontend drain skips
      // hostCommand itself, so the host must consume it once the task is idle. Desktop
      // continuous never hits this entry.
      scheduleRuntimeCommandDrain(params, "enqueue");
      return { accepted: true, command };
    },

    async promoteTaskCommand(params): Promise<ZCodeEnqueueTaskCommandResult> {
      assertCurrentOwnerRun(params, params.ownerRunId);
      const key = taskKey(params);
      const commands = runtimeCommands.get(key) ?? [];
      const command = commands.find((candidate) => candidate.commandId === params.commandId);
      if (!command) {
        throw Object.assign(new Error("Task command not found."), {
          code: "OWNER_COMMAND_FAILED",
        });
      }
      if (command.status === "running") {
        return { accepted: true, command };
      }
      const nextCommand = {
        ...command,
        status: "accepted" as const,
        updatedAt: Date.now(),
      };
      runtimeCommands.set(key, [nextCommand, ...commands.filter((item) => item !== command)]);
      scheduleRuntimeCommandDrain(params, "promote");
      return { accepted: true, command: nextCommand };
    },

    async cancelTaskCommand(params): Promise<ZCodeCancelTaskCommandResult> {
      assertCurrentOwnerRun(params, params.ownerRunId);
      const key = taskKey(params);
      const commands = runtimeCommands.get(key) ?? [];
      const command = commands.find((candidate) => candidate.commandId === params.commandId);
      if (!command) {
        logger.info(undefined, "ZCode task command already gone at cancel", {
          commandId: params.commandId,
          taskId: params.taskId,
          workspaceIdentity: params.workspaceIdentity ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return {
          canceled: true,
          commandId: params.commandId,
          reason: "not_found",
        };
      }
      if (command.status === "running") {
        logger.info(command.traceId, "ZCode task command already running; skipping cancel", {
          commandId: command.commandId,
          taskId: params.taskId,
          workspaceIdentity: params.workspaceIdentity ?? null,
          workspaceKey: resolveWorkspaceKey(params),
          workspacePath: params.workspacePath,
        });
        return {
          canceled: false,
          commandId: command.commandId,
          reason: "already_running",
          status: command.status,
        };
      }
      // Truth for the phone replayable queue is the host runtime command queue. Deletion must
      // not only clear renderer state, or the next snapshot resurrect accepted commands.
      setRuntimeCommands(
        params,
        commands.filter((item) => item.commandId !== command.commandId),
      );
      emitRuntimeCommandSnapshotUpdated(params, command.traceId);
      logger.info(command.traceId, "ZCode task command cancelled", {
        commandId: command.commandId,
        status: command.status,
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(params),
        workspacePath: params.workspacePath,
      });
      return {
        canceled: true,
        commandId: command.commandId,
        status: command.status,
      };
    },

    async stopGeneration(params): Promise<void> {
      const startedAt = Date.now();
      const target = params.workspacePath
        ? {
            taskId: params.taskId,
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
          }
        : getTaskTarget(params.taskId);
      logger.info(params.runId, "ZCode task facade stopGeneration start", {
        hasRunId: Boolean(params.runId),
        taskId: params.taskId,
        workspaceIdentity: target.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(target),
        workspacePath: target.workspacePath,
      });
      // session/stop -> v4 stop command (goal-pause barrier semantics live in the CLI native handler).
      const ack = await options.zcodeAgentService.sendConversationCommandV4({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        envelope: createHostCommandEnvelope({
          type: "stop",
          // Topic stop must keep the observed execution identity; a log traceId is not the CLI execution identity.
          payload: params.expectedForegroundExecutionId
            ? { expectedForegroundExecutionId: params.expectedForegroundExecutionId }
            : {},
          sessionId: params.taskId,
        }),
      });
      assertV4CommandAckOk("stop", ack, `session=${params.taskId}`);
      logger.info(params.runId, "ZCode task facade stopGeneration ACK", {
        durationMs: Date.now() - startedAt,
        taskId: params.taskId,
        workspaceIdentity: target.workspaceIdentity ?? null,
        workspaceKey: resolveWorkspaceKey(target),
        workspacePath: target.workspacePath,
      });
    },

    async compactSession(params) {
      // v4 compact is a CAS command (baseRevision from the v4 conversation revision) while
      // this facade's expectedRevision is the legacy stateRevision: two counters, not
      // interchangeable. Migrating before replayable sees a v4 revision would fake staleness.
      // v4 compact also has no instructions/runtimeModel payload.
      const target = params.workspacePath
        ? {
            taskId: params.taskId,
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
          }
        : getTaskTarget(params.taskId);
      notifySyncerSession(target);
      if (params.inputId) {
        activePromptInputIds.set(taskKey(target), params.inputId);
      }
      try {
        const result = await options.zcodeAgentService.compactSession({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          sessionId: params.taskId,
          inputId: params.inputId,
          instructions: params.instructions,
          expectedRevision: params.expectedRevision,
        });
        if (result.compact?.state === "accepted") {
          return result;
        }
        const meta = await syncTaskIndexSnapshot(result.snapshot);
        // The compact settle is a state sync, not ownership; the default task_meta_changed would trigger a global membership refetch.
        emitWorkspaceTaskListChanged(target, meta, "task_status_changed");
        activePromptInputIds.delete(taskKey(target));
        return result;
      } catch (error) {
        activePromptInputIds.delete(taskKey(target));
        throw error;
      }
    },

    async goalSession(params) {
      // v4 sendGoalCommand covers only set (verbatim text); this facade's
      // action=resume/clear/replace/status needs the legacy op's structured actions (v4
      // resumeGoal is CAS, with the same revision-counter caveat as compactSession).
      // Endgame = the replayable v4 read-path batch, together with compactSession.
      const startedAt = Date.now();
      const target = params.workspacePath
        ? {
            taskId: params.taskId,
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
          }
        : getTaskTarget(params.taskId);
      notifySyncerSession(target);
      const mayStartContinuation =
        params.action === "set" || params.action === "replace" || params.action === "resume";
      if (mayStartContinuation) {
        // goal resume can also start a new model turn; do not inherit the previous turn's live-only tools.
        clearLiveToolProjection(target);
        clearStreamingToolInputCache(target);
      }
      if (params.inputId && mayStartContinuation) {
        activePromptInputIds.set(taskKey(target), params.inputId);
      }
      logger.info(params.inputId, "[zcode-task-service] goalSession start", {
        action: params.action,
        hasObjective: Boolean(params.objective?.trim()),
        mayStartContinuation,
        taskId: params.taskId,
        workspaceIdentity: target.workspaceIdentity,
        workspacePath: target.workspacePath,
      });
      const result = await options.zcodeAgentService.goalSession({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        sessionId: params.taskId,
        inputId: params.inputId,
        action: params.action,
        objective: params.objective,
        expectedRevision: params.expectedRevision,
      });
      logger.info(params.inputId, "[zcode-task-service] goalSession agent returned", {
        action: params.action,
        durationMs: Date.now() - startedAt,
        responseLength: result.response?.length ?? 0,
        startedTurn: result.startedTurn,
        status: result.snapshot.session.status,
        taskId: params.taskId,
        workspaceIdentity: target.workspaceIdentity,
        workspacePath: target.workspacePath,
      });
      const syncStartedAt = Date.now();
      const meta = await syncTaskIndexSnapshot(result.snapshot);
      // The post-goal snapshot settle is likewise a state sync, not ownership; avoid the global membership refetch.
      emitWorkspaceTaskListChanged(target, meta, "task_status_changed");
      logger.info(params.inputId, "[zcode-task-service] goalSession index sync complete", {
        action: params.action,
        durationMs: Date.now() - startedAt,
        startedTurn: result.startedTurn,
        status: result.snapshot.session.status,
        syncDurationMs: Date.now() - syncStartedAt,
        taskId: params.taskId,
        workspaceIdentity: target.workspaceIdentity,
        workspacePath: target.workspacePath,
      });
      if (!mayStartContinuation || result.snapshot.session.status !== "running") {
        activePromptInputIds.delete(taskKey(target));
      }
      return result;
    },

    async respondPermission(params): Promise<boolean> {
      const target = params.workspacePath
        ? {
            taskId: params.taskId,
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
          }
        : getTaskTarget(params.taskId);
      // Permission responses converge on v4 resolveInteraction.
      // interactionId equals the business requestId (registered in the CLI interaction-broker);
      // optionId maps back exactly via the CLI's buildProtocolPermissionOptions, keeping the
      // allow_project permissionUpdates persistence rule (see interaction-broker
      // v4AnswerToPermissionResponse).
      const ack = await options.zcodeAgentService.sendConversationCommandV4({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        envelope: createHostCommandEnvelope({
          type: "resolveInteraction",
          payload: {
            interactionId: params.requestId,
            answer: { optionId: params.optionId },
          },
          sessionId: params.taskId,
        }),
      });
      assertV4CommandAckOk("resolveInteraction", ack, `permission ${params.requestId}`);
      return true;
    },

    async respondElicitation(params): Promise<boolean> {
      const target = params.workspacePath
        ? {
            taskId: params.taskId,
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
          }
        : getTaskTarget(params.taskId);
      // AskUserQuestion/plan-approval responses converge on v4 resolveInteraction.
      // answer.action/content are additive extensions (lossless multi-question answers and
      // annotations; the CLI interaction-broker maps by action first, falling back to
      // optionId/freeText for compatibility).
      const ack = await options.zcodeAgentService.sendConversationCommandV4({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        envelope: createHostCommandEnvelope({
          type: "resolveInteraction",
          payload: {
            interactionId: params.requestId,
            answer: {
              action: params.action,
              ...(params.content ? { content: params.content } : {}),
            },
          },
          sessionId: params.taskId,
        }),
      });
      assertV4CommandAckOk("resolveInteraction", ack, `elicitation ${params.requestId}`);
      if (params.clientMode === "web-remote-replayable") {
        // Semantics preserved from agentService.respondUserInput's web-remote-replayable
        // branch: after the phone answers, desktop/other observers need an explicit response
        // event to clear the dialog for the same requestId. The v4 path bypasses the legacy
        // respondUserInput, so the adapter re-emits the event locally.
        emitTaskEvent(
          target,
          userInputResponseToElicitationStreamEvent(params.taskId, params.requestId, {
            action: params.action,
            content: params.content,
          }),
        );
      }
      return true;
    },

    async closeTask(params): Promise<void> {
      // This compat entry still closes via closeSession; a runtime-only close does not exist yet.
      const target = getTaskTarget(params.taskId);
      await options.zcodeAgentService.closeSession({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        sessionId: params.taskId,
      });
      setOverlay(target, { deleted: true });
      await updateIndexedTaskState(target, { deleted: true });
      clearLiveToolProjection(target);
      clearStreamingToolInputCache(target);
      // Deleted-list convergence is driven by sessions-index session.removed; this broadcast is the legacy fallback.
      emitWorkspaceTaskListChanged(target, undefined, "task_meta_changed");
    },

    async resumeTask(params): Promise<ZCodeTaskMeta> {
      // v4 resume already goes through the subscribe cold-resume hook (CLI cold-resume), but
      // replayable resumeTask also backfills model/thoughtLevel and reindexes the snapshot
      // body into the task index; keep the legacy resumeSession op until the v4 lifecycle lands.
      const explicitModel = params.model?.trim();
      const explicitThoughtLevel = params.thoughtLevel?.trim();
      const indexHints =
        explicitModel && explicitThoughtLevel
          ? {}
          : await resolveTaskIndexResumeHints(params, "resume_task");
      const model = explicitModel || indexHints.model;
      const thoughtLevel = explicitThoughtLevel || indexHints.thoughtLevel;
      const restored = await resumeSnapshotOrLegacy({
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        model,
        thoughtLevel,
        mcpServers: params.mcpServers,
      });
      if (restored.kind === "legacy") {
        const meta = await syncTaskIndexMeta({
          ...restored.snapshot.meta,
          ...(params.automationId ? { cronAutomationId: params.automationId } : {}),
          // D48: backfill ownership when a pre-marked session is resumed by an off-peak continuation; belt-and-suspenders beyond the backfill.
          ...(params.offPeakTaskId ? { offPeakTaskId: params.offPeakTaskId } : {}),
        });
        // Open/resume is a snapshot settle, not ownership; same broadcast semantics as resumeSession.
        emitWorkspaceTaskListChanged(params, meta, "task_status_changed");
        return meta;
      }
      const snapshot = restored.snapshot;
      emitWorkspaceConfig(params, snapshot.settings);
      const snapshotMeta = await syncTaskIndexSnapshot(snapshot);
      const meta =
        params.automationId || params.offPeakTaskId
          ? await syncTaskIndexMeta({
              ...snapshotMeta,
              ...(params.automationId ? { cronAutomationId: params.automationId } : {}),
              // Re-stamp the off-peak ownership marker on continuation.
              ...(params.offPeakTaskId ? { offPeakTaskId: params.offPeakTaskId } : {}),
            })
          : snapshotMeta;
      notifySyncerSession({
        taskId: meta.taskId,
        workspacePath: meta.workspacePath,
        workspaceIdentity: meta.workspaceIdentity,
      });
      return meta;
    },

    async listTasks(params): Promise<ZCodeTaskMeta[]> {
      const tasks = await taskIndexRepo.listTaskMetas({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        provider: GLM_PROVIDER,
        pinned: false,
        archived: false,
      });
      return tasks.map(rememberIndexedTaskMeta);
    },

    async listPinnedTaskIds(): Promise<string[]> {
      const tasks = await taskIndexRepo.listTaskMetas({
        provider: GLM_PROVIDER,
        pinned: true,
        archived: false,
      });
      return tasks.map((task) => task.taskId);
    },

    async listPinnedTasks(params): Promise<ZCodeTaskMeta[]> {
      const tasks = await taskIndexRepo.listTaskMetas({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        provider: GLM_PROVIDER,
        pinned: true,
        archived: false,
      });
      return tasks.map(rememberIndexedTaskMeta);
    },

    async listDeletedTaskIds(params): Promise<string[]> {
      return taskIndexRepo.listDeletedTaskIds({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        provider: GLM_PROVIDER,
      });
    },

    // listTaskList serves full-text search (searchable_text/snippets) and the
    // remoteTimelineTaskStore supplement path; sidebar views and remote-shard rows without
    // search use the three partitioned reads above. Workspace rows are joined client-side from
    // per-endpoint task rows + session detail.
    async listTaskList(params: ZCodeTaskListQuery): Promise<ZCodeTaskListResult> {
      const result = await taskIndexRepo.queryTaskList({
        ...params,
        provider: GLM_PROVIDER,
      });
      return {
        ...result,
        items: result.items.map(rememberIndexedTaskMeta),
      };
    },

    async createTaskGroup(params) {
      const group = await taskIndexRepo.createTaskGroup(params);
      return group;
    },

    async renameTaskGroup(params) {
      const group = await taskIndexRepo.renameTaskGroup(params);
      for (const scope of params.workspaceScopes ?? []) {
        // Grouped structure changes carry no per-task meta; keep task_meta_changed to refetch the grouped view.
        emitWorkspaceTaskListChanged(scope, undefined, "task_meta_changed");
      }
      return group;
    },

    async updateTaskGroupColor(params) {
      const group = await taskIndexRepo.updateTaskGroupColor(params);
      for (const scope of params.workspaceScopes ?? []) {
        emitWorkspaceTaskListChanged(scope, undefined, "task_meta_changed");
      }
      return group;
    },

    async deleteTaskGroup(params) {
      await taskIndexRepo.deleteTaskGroup(params);
      for (const scope of params.workspaceScopes ?? []) {
        emitWorkspaceTaskListChanged(scope, undefined, "task_meta_changed");
      }
    },

    // Grouped-view task content comes from sessions-index; provider filtering and meta
    // translation happen in the client join. This path stays structure-only.

    async listGroupedTaskViewStructure(params) {
      // Raw grouped structure (no tasks-table join); content comes from sessions-index, joined client-side.
      // Keep the auto-archive trigger on par with listGroupedTaskView (expire stale tasks on view entry).
      await runWorkspaceTaskAutoArchive(params.workspaceScopes);
      return taskIndexRepo.queryGroupedTaskViewStructure(params);
    },

    async applyGroupedTaskViewOrder(params) {
      const result = await taskIndexRepo.applyGroupedTaskViewOrder({
        ...params,
        // The grouped reorder response must inherit the list query's glm provider boundary,
        // or legacy external-provider tasks reappear briefly via the unfiltered second query.
        provider: GLM_PROVIDER,
      });
      for (const scope of params.workspaceScopes) {
        emitWorkspaceTaskListChanged(scope, undefined, "task_meta_changed");
      }
      return {
        nodes: result.nodes.map((node) =>
          node.type === "task"
            ? { ...node, task: rememberIndexedTaskMeta(node.task) }
            : {
                ...node,
                tasks: node.tasks.map(rememberIndexedTaskMeta),
              },
        ),
      };
    },

    async listArchivedTasks(params): Promise<ZCodeTaskMeta[]> {
      const tasks = await taskIndexRepo.listTaskMetas({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        provider: GLM_PROVIDER,
        archived: true,
      });
      return tasks.map(rememberIndexedTaskMeta);
    },

    async archiveStaleTasks(params): Promise<ZCodeTaskMeta[]> {
      // The stale-archive API matches the settings auto-archive: sweep every legacy provider.
      const archivedTasks = await taskIndexRepo.archiveStaleTasks({
        ...params,
      });
      for (const task of archivedTasks) {
        setOverlay(task, { archived: true });
        rememberIndexedTaskMeta(task);
        // Same as runWorkspaceTaskAutoArchive: task_meta_changed drives the membership-refetch convergence.
        emitWorkspaceTaskListChanged(task, task, "task_meta_changed");
      }
      return archivedTasks;
    },

    async archiveWorkspaceTasks(params): Promise<ZCodeTaskMeta[]> {
      const tasks = await taskIndexRepo.listTaskMetas({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        provider: GLM_PROVIDER,
        archived: false,
      });
      for (const task of tasks) {
        setOverlay(task, { archived: true });
        await taskIndexRepo.updateTaskState({
          workspacePath: task.workspacePath,
          workspaceIdentity: task.workspaceIdentity,
          taskId: task.taskId,
          patch: { archived: true },
        });
      }
      // Bulk archive has no per-task meta; task_meta_changed drives the membership-refetch convergence.
      emitWorkspaceTaskListChanged(params, undefined, "task_meta_changed");
      return taskIndexRepo.listTaskMetas({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        provider: GLM_PROVIDER,
        archived: true,
      });
    },

    async getTaskSnapshot(params): Promise<ZCodeTaskSnapshot | null> {
      const startedAt = Date.now();
      const resumeStartedAt = Date.now();
      const explicitModel = params.model?.trim();
      const explicitThoughtLevel = params.thoughtLevel?.trim();
      const shouldBackfillTaskIndexResumeHints =
        params.clientMode === "web-remote-replayable" &&
        params.resumeModelPolicy !== "ui-resolved-only" &&
        (!explicitModel || !explicitThoughtLevel);
      const indexHints = shouldBackfillTaskIndexResumeHints
        ? await resolveTaskIndexResumeHints(params, "replayable_snapshot")
        : {};
      const model = explicitModel || indexHints.model;
      const thoughtLevel = explicitThoughtLevel || indexHints.thoughtLevel;
      const restored = await resumeSnapshotOrLegacy({
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        // The phone replayable first paint snapshots before any later resumeTask. Feed the
        // model/thoughtLevel resolved from task meta into session/resume so cold restore does
        // not pollute context window or reasoning level with workspace/draft defaults.
        model,
        thoughtLevel,
      });
      const resumeDurationMs = Date.now() - resumeStartedAt;
      if (restored.kind === "legacy") {
        const limitStartedAt = Date.now();
        const legacySnapshot = limitTaskSnapshotMessages(restored.snapshot, params.messageLimit);
        const limitDurationMs = Date.now() - limitStartedAt;
        const indexStartedAt = Date.now();
        const indexedMeta =
          (await taskIndexRepo.getTaskMeta(params)) ??
          (await syncTaskIndexMeta(legacySnapshot.meta));
        const indexDurationMs = Date.now() - indexStartedAt;
        logger.info(undefined, "[zcode-task-service] history snapshot loaded", {
          clientMode: params.clientMode ?? "unknown",
          durationMs: Date.now() - startedAt,
          indexDurationMs,
          limitDurationMs,
          messageLimit: params.messageLimit ?? null,
          resumeDurationMs,
          snapshotKind: "legacy",
          stats: getTaskSnapshotMessageDiagnostics(legacySnapshot),
          taskId: params.taskId,
          workspaceIdentity: params.workspaceIdentity ?? null,
          workspacePath: params.workspacePath,
        });
        return { ...legacySnapshot, meta: indexedMeta };
      }
      const snapshot = restored.snapshot;
      const projectionStartedAt = Date.now();
      const zcodeSnapshot = limitTaskSnapshotMessages(
        snapshotToZCode(snapshot, {
          includeEmptyPendingElicitations: params.clientMode === "web-remote-replayable",
        }),
        params.messageLimit,
      );
      const projectionDurationMs = Date.now() - projectionStartedAt;
      // The session owner's snapshot refreshes the index projection; syncTaskMeta keeps user-renamed titles.
      const indexStartedAt = Date.now();
      const indexedMeta = await syncTaskIndexMeta(zcodeSnapshot.meta);
      const indexDurationMs = Date.now() - indexStartedAt;
      logger.info(undefined, "[zcode-task-service] history snapshot loaded", {
        clientMode: params.clientMode ?? "unknown",
        durationMs: Date.now() - startedAt,
        indexDurationMs,
        messageLimit: params.messageLimit ?? null,
        projectionDurationMs,
        resumeDurationMs,
        snapshotKind: "session",
        stats: getTaskSnapshotMessageDiagnostics(zcodeSnapshot),
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
      return { ...zcodeSnapshot, meta: indexedMeta };
    },

    async getTaskSnapshotWithEtag(params) {
      const startedAt = Date.now();
      const snapshot = await service.getTaskSnapshot(params);
      if (!snapshot) {
        logger.info(undefined, "[zcode-task-service] history snapshot ETag empty", {
          clientMode: params.clientMode ?? "unknown",
          durationMs: Date.now() - startedAt,
          messageLimit: params.messageLimit ?? null,
          taskId: params.taskId,
          workspaceIdentity: params.workspaceIdentity ?? null,
          workspacePath: params.workspacePath,
        });
        return { snapshot: null };
      }
      const etagStartedAt = Date.now();
      const etag = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
      const etagDurationMs = Date.now() - etagStartedAt;
      if (params.ifNoneMatch && params.ifNoneMatch === etag) {
        logger.info(undefined, "[zcode-task-service] history snapshot ETag hit", {
          clientMode: params.clientMode ?? "unknown",
          durationMs: Date.now() - startedAt,
          etagDurationMs,
          messageLimit: params.messageLimit ?? null,
          stats: getTaskSnapshotMessageDiagnostics(snapshot),
          taskId: params.taskId,
          workspaceIdentity: params.workspaceIdentity ?? null,
          workspacePath: params.workspacePath,
        });
        return { snapshot: null, etag, notModified: true };
      }
      logger.info(undefined, "[zcode-task-service] history snapshot ETag computed", {
        clientMode: params.clientMode ?? "unknown",
        durationMs: Date.now() - startedAt,
        etagDurationMs,
        messageLimit: params.messageLimit ?? null,
        stats: getTaskSnapshotMessageDiagnostics(snapshot),
        taskId: params.taskId,
        workspaceIdentity: params.workspaceIdentity ?? null,
        workspacePath: params.workspacePath,
      });
      return { snapshot, etag };
    },

    async getTaskSnapshotBody(): Promise<ZCodeTaskSnapshotBody | null> {
      return null;
    },

    async getTaskSnapshotRef(): Promise<ZCodeTaskSnapshotRefContent | null> {
      return null;
    },

    async getTaskSnapshotToolCallsSlice(): Promise<ZCodeTaskSnapshotToolCallsSlice | null> {
      return null;
    },

    async getTaskMeta(params): Promise<ZCodeTaskMeta | null> {
      const meta = await taskIndexRepo.getTaskMeta(params);
      return meta ? rememberIndexedTaskMeta(meta) : null;
    },

    async getTaskConfigOptions(params): Promise<ZCodeConfigOption[]> {
      const snapshot = await resumeSnapshot(getTaskTarget(params.taskId));
      return settingsToConfigOptions(snapshot.settings);
    },

    async getTaskModelSelection(params): Promise<ModelSelection | null> {
      const target = getTaskTarget(params.taskId);
      const snapshot = await options.zcodeAgentService.readSession({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        sessionId: params.taskId,
      });
      return snapshot.settings.model.current ?? null;
    },

    async setAssistantMessageFeedback(params): Promise<ZCodeSessionFile> {
      const snapshot = await service.getTaskSnapshot(params);
      if (!snapshot) {
        unsupported("setAssistantMessageFeedback");
      }
      const assistantMessages = snapshot.messages.filter((message) => message.role === "assistant");
      const targetMessage = assistantMessages[params.turnIndex];
      if (targetMessage) {
        targetMessage.feedback = params.feedback as ZCodeAssistantMessageFeedback | undefined;
      }
      return snapshot;
    },

    async syncTaskSessionBinding(): Promise<ZCodeSyncTaskSessionBindingResult> {
      unsupported("syncTaskSessionBinding");
    },

    async switchAgent(): Promise<ZCodeSwitchAgentResult> {
      unsupported("switchAgent");
    },

    async scanImportableClaudeSessions(params: {
      workspacePath?: string;
      workspaceIdentity?: string;
      modifiedSince?: number;
      limit?: number;
    }): Promise<ZCodeImportableSessionCandidate[]> {
      // After legacy ACP sunset this stayed a stub and the migration wizard missed
      // ~/.claude/projects. workspaceIdentity only affects the import destination; scanning
      // filters by the jsonl cwd and an optional workspacePath.
      void params.workspaceIdentity;
      return claudeNativeSessionImportRepo.scanImportableSessions({
        workspacePath: params.workspacePath,
        modifiedSince: params.modifiedSince,
        limit: params.limit,
      });
    },

    async importClaudeSessions(params: {
      workspacePath?: string;
      workspaceIdentity?: string;
      sessionIds: string[];
    }): Promise<ZCodeImportSessionsResult> {
      return importClaudeNativeSessions({
        taskIndexRepo,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        sessionIds: params.sessionIds,
        createImportedSession: async (source) => {
          const targetWorkspaceIdentity = params.workspacePath
            ? params.workspaceIdentity
            : undefined;
          const snapshot = await options.zcodeAgentService.createSession({
            workspacePath: source.workspacePath,
            workspaceIdentity: targetWorkspaceIdentity,
            sessionId: buildImportedClaudeTaskId(source.workspacePath, source.sessionId),
            sessionTraceId: createSessionTraceId(),
            persistence: "immediate",
            importedHistory: {
              source: "claudeCode",
              title: source.title,
              createdAt: source.createdAt,
              updatedAt: source.updatedAt,
              messages: source.messages.map((message) => ({
                role: message.role,
                content: message.content,
                timestamp: message.timestamp,
              })),
            },
          });
          const meta = await syncTaskIndexSnapshot(snapshot);
          // Imported tasks must be real ZCode sessions or setModel/sendPrompt miss the runtime.
          // Keep migrationSource so the task list does not treat Claude Code imports as new local sessions.
          return syncTaskIndexMeta({ ...meta, migrationSource: "claudeCode" });
        },
        onTaskImported: (meta) => {
          rememberIndexedTaskMeta(meta);
          emitWorkspaceTaskListChanged(
            {
              workspacePath: meta.workspacePath,
              workspaceIdentity: meta.workspaceIdentity,
              taskId: meta.taskId,
            },
            meta,
            // Imports keep the legacy task_meta_changed semantics.
            "task_meta_changed",
          );
        },
      });
    },

    async setMode(params): Promise<void> {
      // session/setMode -> v4 switchCollaborationMode (CAS; revision convergence in
      // sendHostCasCommandV4). The v4 handler emits no legacy state.updated; observer
      // consistency lands with the desktop v4 toolbar batch (read path converges on the v4
      // store) and the initiator stays faithful via resumeSnapshot below.
      const target = getTaskTarget(params.taskId);
      await switchCollaborationModeViaProtocol(target, toZCodeMode(params.mode) ?? "build");
      const snapshot = await resumeSnapshot(target);
      await syncTaskIndexSnapshot(snapshot);
    },

    async setConfigOption(params): Promise<ZCodeConfigOption[]> {
      const target = getTaskTarget(params.taskId);
      if (params.configId === MODEL_CONFIG_ID) {
        return service.setModel({
          taskId: params.taskId,
          traceId: params.traceId,
          modelSelection: parseModelPickerValue(params.value),
        });
      }
      if (params.configId === THOUGHT_LEVEL_CONFIG_ID) {
        // session/setThoughtLevel -> v4 switchModelConfig (no dedicated v4 thought command;
        // the thought field carries it, with provider/model from the current session selection,
        // same command surface as the desktop v4 toolbar). Same provider+model switches
        // directly with no runtimeModel (provider credentials) resolution, which is exactly why
        // setModel cannot move yet (see the setModel note below).
        const current = await options.zcodeAgentService.readSession({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          sessionId: params.taskId,
        });
        const model = current.settings.model.current;
        // Unbound sessions may view, but a bare level switch must not guess Provider/Model.
        if (!model) throw new Error("Select a model before setting the thought level");
        await sendConfigCasCommandV4(
          target,
          "switchModelConfig",
          {
            provider: model.providerId,
            model: model.modelId,
            thought: params.value,
          },
          `session=${params.taskId} thought=${params.value}`,
        );
      } else if (params.configId === MODE_CONFIG_ID) {
        await switchCollaborationModeViaProtocol(
          target,
          toZCodeMode(params.value as ZCodeTaskMode) ?? "build",
        );
      }
      const snapshot = await resumeSnapshot(target);
      await syncTaskIndexSnapshot(snapshot);
      return settingsToConfigOptions(snapshot.settings);
    },

    async setModel(params): Promise<ZCodeConfigOption[]> {
      // The replayable facade still needs the Session Snapshot returned by the legacy op;
      // model-execution truth moved to the target Worker Registry and the host sends only the
      // Selection. Endgame = the task facade consuming V4 config projection and revision natively.
      const target = getTaskTarget(params.taskId);
      await options.zcodeAgentService.setModel({
        workspacePath: target.workspacePath,
        workspaceIdentity: target.workspaceIdentity,
        sessionId: params.taskId,
        // A replayable/legacy modelId may be just a UI runtime name (e.g. gpt-5.5); with
        // same-named custom providers, only the structured ModelSelection from the UI is trustworthy.
        model: params.modelSelection,
      });
      const snapshot = await resumeSnapshot(target);
      await syncTaskIndexSnapshot(snapshot);
      return settingsToConfigOptions(snapshot.settings);
    },

    async setAutomationSessionConfig(params): Promise<ZCodeConfigOption[]> {
      const target = getTaskTarget(params.taskId);
      const model = params.modelSelection;
      const thoughtLevel = params.thoughtLevel?.trim() ?? "";
      // Automation used to run legacy session/setModel and then a V4 Think. When the target
      // model's default Think matches, the second step noops without ModelSelected, leaving
      // the runtime switched but the conversation projection stale. One V4 command updates
      // both atomically.
      await sendConfigCasCommandV4(
        target,
        "switchModelConfig",
        {
          provider: model.providerId,
          model: model.modelId,
          thought: thoughtLevel,
        },
        `automation session=${params.taskId} model=${model.providerId}/${model.modelId} thought=${thoughtLevel}`,
      );
      if (thoughtLevel) {
        // Cross-model switchModelConfig adopts the target model's default Think first, avoiding
        // the source model's level. Automation thought is validated against the target model by
        // the create/edit form, so once the model event lands, re-converge with a same-model
        // command: noop on the default, else a second config delta.
        await sendConfigCasCommandV4(
          target,
          "switchModelConfig",
          {
            provider: model.providerId,
            model: model.modelId,
            thought: thoughtLevel,
          },
          `automation session=${params.taskId} thought=${thoughtLevel}`,
        );
      }
      if (params.mode?.trim()) {
        await switchCollaborationModeViaProtocol(target, toZCodeMode(params.mode) ?? "build");
      }
      const snapshot = await resumeSnapshot(target);
      await syncTaskIndexSnapshot(snapshot);
      return settingsToConfigOptions(snapshot.settings);
    },

    async getWorkspaceProviderConfigFile(params) {
      return {
        provider: GLM_PROVIDER,
        path: params.workspacePath,
        exists: false,
      };
    },

    async getTaskNativeSessionLogFile() {
      const path = resolveZCodeAgentCurrentLogFilePath();
      // Returns the ZCode Agent structured JSONL log; the per-line sessionId filters to this task.
      return { provider: GLM_PROVIDER, path, exists: existsSync(path) };
    },

    async getModelTrajectory(params) {
      // The ZCode Agent persists model-io keyed by sessionId = taskId (see the other
      // sessionId: params.taskId uses in this file); rebuild this task's model calls by
      // sessionId for the UI sidebar timeline.
      const trajectory = await readModelTrajectory(params.taskId, params.limit);
      logger.info(
        `[ZCodeTaskService] getModelTrajectory taskId=${params.taskId} records=${trajectory.records.length} files=${trajectory.sourceFiles.length} truncated=${trajectory.truncated}`,
      );
      return trajectory;
    },

    async getTaskTokenUsage(params): Promise<ZCodeTaskTokenUsageResult> {
      // The usage panel needs the task's cumulative model spend, not usage_update's context
      // window. Read the model_usage aggregate from agent SQLite via the ZCode Protocol so
      // desktop and remote share one source of truth.
      return options.zcodeAgentService.getTaskTokenUsage({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        sessionId: params.taskId,
      });
    },

    async getTaskSessionFilePath(params) {
      return {
        path: `${params.workspacePath}/${params.taskId}.zcode-session`,
        exists: false,
      };
    },

    async restartWorkspaceProcess(params): Promise<void> {
      await options.zcodeAgentService.disposeWorkspace(normalizeWorkspaceParams(params));
    },

    async deleteTask(params): Promise<void> {
      setOverlay(params, { deleted: true });
      const meta = await updateIndexedTaskState(params, { deleted: true });
      // task_meta_changed only refetches normal membership and cannot express hard deletion;
      // sessions-index still returns sessions kept in the CLI. task_deleted makes the UI drop
      // cached entries and bump the deleted-tombstone generation so tasks do not resurrect
      // after restart or live upsert. meta rides along so duplicate desktop/remote subscriptions
      // dedupe the membership bump by event.
      emitWorkspaceTaskListChanged(params, meta, "task_deleted");
    },

    async deleteArchivedTask(params): Promise<boolean> {
      const meta = await taskIndexRepo.deleteArchivedTask(params);
      if (!meta) return false;
      // Persist before the overlay, or failures get hidden early by the in-memory deleted flag.
      setOverlay(params, { deleted: true });
      emitWorkspaceTaskListChanged(params, meta, "task_deleted");
      return true;
    },

    async deleteArchivedTasks(params): Promise<ZCodeArchivedTaskDeletionResult> {
      const result: ZCodeArchivedTaskDeletionResult = {
        deletedTaskIds: [],
        skippedTaskIds: [],
        failedTaskIds: [],
      };
      const taskIds = [...new Set(params.taskIds)];
      if (taskIds.length === 0) return result;
      const startedAt = Date.now();
      for (const taskId of taskIds) {
        const target = {
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          taskId,
        };
        try {
          // Keep per-item transactions and the archived guard: one failure rolls nothing back and hides nothing early.
          const meta = await taskIndexRepo.deleteArchivedTask(target);
          if (!meta) {
            result.skippedTaskIds.push(taskId);
            continue;
          }
          setOverlay(target, { deleted: true });
          result.deletedTaskIds.push(taskId);
        } catch (error) {
          result.failedTaskIds.push(taskId);
          logger.warn(undefined, "[ArchivedTaskDeletion] batch item delete failed", {
            ...target,
            error,
          });
        }
      }
      if (result.deletedTaskIds.length > 0) {
        // Root cause: per-item calls broadcast each time, driving full re-reads on host and UI.
        // One workspace event per batch still bumps deleted membership on every observer so
        // tasks cannot resurrect.
        emitWorkspaceTaskListChanged(params, undefined, "task_deleted");
      }
      logger.info(undefined, "[ArchivedTaskDeletion] batch completed", {
        workspaceKey: resolveWorkspaceKey(params),
        requested: taskIds.length,
        deleted: result.deletedTaskIds.length,
        skipped: result.skippedTaskIds.length,
        failed: result.failedTaskIds.length,
        durationMs: Date.now() - startedAt,
      });
      return result;
    },

    async renameTask(params): Promise<ZCodeTaskMeta> {
      const renamedAt = Date.now();
      logger.info(undefined, "[ZCodeTaskService] renameTask start", {
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        workspaceKey: resolveWorkspaceKey(params),
        titleLength: params.title.length,
      });
      try {
        setOverlay(params, { title: params.title });
        logger.info(undefined, "[ZCodeTaskService] renameTask overlay set", {
          taskId: params.taskId,
          workspaceKey: resolveWorkspaceKey(params),
        });
        const meta = await updateIndexedTaskState(params, {
          title: params.title,
          // Manual rename is an app-side meta change. The title used to be written without
          // bumping updatedAt, so optimistic merge treated the old same-timestamp longer title
          // as stronger meta and the rename waited for task completion.
          updatedAt: renamedAt,
          titleOverridden: true,
        });
        logger.info(undefined, "[ZCodeTaskService] renameTask index updated", {
          taskId: params.taskId,
          workspaceKey: resolveWorkspaceKey(params),
          updatedAt: meta.updatedAt,
          titleLength: meta.title.length,
        });
        try {
          const ack = await options.zcodeAgentService.sendConversationCommandV4({
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
            envelope: createHostCommandEnvelope({
              type: "renameSession",
              sessionId: params.taskId,
              payload: { title: params.title },
            }),
          });
          assertV4CommandAckOk("renameSession", ack, `session=${params.taskId}`);
        } catch (error) {
          // The legacy sidebar rename wrote only tasks-index, while v4 sessions-index reads
          // the CLI session store, losing manual titles. Best-effort renameSession sync; never
          // fail the rename over tasks with no live v4 session.
          logger.warn(
            undefined,
            "Renaming the v4 session store failed; keeping the task-index title",
            {
              taskId: params.taskId,
              workspacePath: params.workspacePath,
              workspaceIdentity: params.workspaceIdentity,
              message: error instanceof Error ? error.message : String(error),
            },
          );
        }
        // A manual rename is a title change, unrelated to pin/archive/unread; use the dedicated reason.
        emitWorkspaceTaskListChanged(params, meta, "task_title_changed");
        logger.info(undefined, "[ZCodeTaskService] renameTask event emitted", {
          taskId: params.taskId,
          workspaceKey: resolveWorkspaceKey(params),
        });
        return meta;
      } catch (error) {
        logger.error(undefined, "[ZCodeTaskService] renameTask failed", {
          taskId: params.taskId,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          workspaceKey: resolveWorkspaceKey(params),
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },

    async setTaskPinned(params): Promise<ZCodeTaskMeta> {
      setOverlay(params, { pinned: params.pinned });
      const meta = await updateIndexedTaskState(params, {
        pinned: params.pinned,
      });
      emitWorkspaceTaskListChanged(params, meta, params.pinned ? "task_pinned" : "task_unpinned");
      return meta;
    },

    async setTaskUnread(params): Promise<ZCodeTaskMeta> {
      if (!params.unread && typeof params.expectedUnreadAt === "number") {
        const result = await taskIndexRepo.clearTaskUnreadIfMatches({
          taskId: params.taskId,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          expectedUnreadAt: params.expectedUnreadAt,
        });
        // A stale phone tap can land after a newer terminal unread. On CAS miss, reconcile the
        // service overlay to current meta instead of optimistically clearing into a renderer-only
        // read state.
        setOverlay(params, { unreadAt: result.meta.unreadAt });
        if (result.cleared) {
          emitWorkspaceTaskListChanged(params, result.meta, "task_meta_changed");
        }
        return result.meta;
      }

      const unreadAt = params.unread ? Date.now() : undefined;
      setOverlay(params, { unreadAt });
      const meta = await updateIndexedTaskState(params, { unreadAt });
      // The repository may bump unreadAt to avoid same-millisecond CAS collisions; reconcile
      // the overlay to the persisted value or later snapshots keep exposing the old marker.
      setOverlay(params, { unreadAt: meta.unreadAt });
      // unread ownership is absent from tasks-index/sessions-index; task_meta_changed must trigger the membership refetch.
      emitWorkspaceTaskListChanged(params, meta, "task_meta_changed");
      return meta;
    },

    async archiveTask(params): Promise<ZCodeTaskMeta> {
      setOverlay(params, { archived: true });
      const meta = await updateIndexedTaskState(params, { archived: true });
      emitWorkspaceTaskListChanged(params, meta, "task_archived");
      return meta;
    },

    async unarchiveTask(params): Promise<ZCodeTaskMeta> {
      setOverlay(params, { archived: false });
      const meta = await updateIndexedTaskState(params, { archived: false });
      emitWorkspaceTaskListChanged(params, meta, "task_unarchived");
      return meta;
    },

    async branchTaskFromPrompt(): Promise<ZCodeTaskCreateResult> {
      unsupported("branchTaskFromPrompt");
    },

    onDynamicStreamEvent(taskId: string): Event<ZCodeStreamEvent> {
      return getGlobalTaskEmitter(taskId).event;
    },

    onDynamicTaskTerminalOutcome(taskId: string): Event<ZCodeTaskTerminalOutcome> {
      // Merge migration: the V4 syncer exposes only normalized terminal kinds, no legacy
      // event payload. Automation needs a stable result, so completed/failed map to the public
      // outcome here.
      return (listener) =>
        taskIndexSyncer.onSessionTerminalEvent((terminal) => {
          if (terminal.target.sessionId !== taskId) {
            return;
          }
          const target = {
            taskId,
            workspacePath: terminal.target.workspacePath,
            workspaceIdentity: terminal.target.workspaceIdentity,
          };
          const inputId = activePromptInputIds.get(taskKey(target));
          listener({
            taskId,
            ...(inputId ? { inputId } : {}),
            outcome: terminal.kind === "turn.failed" ? "failed" : "succeeded",
          });
        });
    },

    onDynamicTaskReady(taskId: string): Event<ZCodeTaskReadyOutcome> {
      return (listener) =>
        taskIndexSyncer.onSessionReadyEvent((ready) => {
          if (ready.target.sessionId !== taskId) {
            return;
          }
          listener({ taskId, reason: ready.reason });
        });
    },

    onDynamicTaskEvent(params): Event<ZCodeStreamEvent> {
      const target = {
        taskId: params.taskId,
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
      };
      rememberTaskTarget(target);
      return (listener) => {
        const localDisposable = getTaskEmitter(target).event(listener);
        if (legacySnapshotTaskKeys.has(taskKey(target))) {
          // Bugfix: legacy ACP tasks have no zcode-cli sqlite session and restore read-only.
          // Subscribing them to the ZCode Protocol retriggers Session-not-active log floods;
          // the local emitter already covers rename/archive metadata events.
          return localDisposable;
        }
        // M5 3-2 review (2026-07-06): this remains the last consumer of the legacy
        // session/subscribe vocabulary in services/ (stream projection source for
        // replayable/bots). Write paths (send/stop/interaction replies) already converged on
        // v4 commands; read-side consumers are bots handleStreamEvent (10-event vocabulary) and
        // the host-mirror taskRealtimePort (same ZCodeStreamEvent vocabulary). Moving both to
        // v4 frames means redoing relay protocol + phone store + bots projection in one wave
        // (ui/store is owned by a parallel agent this wave; keep clear).
        // Removal rescheduled to the replayable read-path v4 store wave (wave 3), torn down
        // together with the host/index.ts mirror, mapStateUpdated/mapServiceEvent, and
        // agentService.onDynamicSessionEvent.
        const upstreamDisposable = options.zcodeAgentService.onDynamicSessionEvent({
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
          sessionId: params.taskId,
          deliveryKind: toZCodeDeliveryKind(params.deliveryKind),
          includeSnapshot: params.deliveryKind === "replayable",
        })((event) => mapServiceEvent(target, event));
        return {
          dispose() {
            upstreamDisposable.dispose();
            localDisposable.dispose();
          },
        };
      };
    },

    onDynamicWorkspaceEvent(workspace): Event<ZCodeWorkspaceEvent> {
      return taskIndexSyncer.onDynamicWorkspaceEvent(workspace);
    },

    onError: errorEmitter.event,

    disposeAll(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      memoryDiagnostics.dispose();
      // The syncer holds the agentService v4 frame subscriptions (sessions-index and
      // workspace-config); dispose them before agentService.disposeAll or emitter dispose
      // callbacks hit a dead syncer. workspaceEmitters moved into the syncer and are reclaimed
      // by syncer.disposeAll.
      taskIndexSyncer.disposeAll();
      for (const scope of botConnectionScopes.values()) void scope.dispose();
      botConnectionScopes.clear();
      options.zcodeAgentService.disposeAll();
      disposeLocalTaskState();
    },

    async disposeAllAndWait(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      // On app exit, detach the task index syncer before waiting on the agent process tree,
      // or the host exit takes zcode-cli's SIGKILL fallback timer down with it.
      taskIndexSyncer.disposeAll();
      await Promise.all([...botConnectionScopes.values()].map((scope) => scope.dispose()));
      botConnectionScopes.clear();
      await disposeZCodeAgentServiceAndWait();
      disposeLocalTaskState();
    },
  };

  return service;
}

function normalizeWorkspaceParams(params: {
  workspacePath: string;
  workspaceIdentity?: string;
}): ZCodeAgentWorkspaceTarget {
  return {
    workspacePath: params.workspacePath,
    workspaceIdentity: params.workspaceIdentity,
  };
}

function applyOverlayToMeta(meta: ZCodeTaskMeta, overlay: TaskOverlay): ZCodeTaskMeta {
  return {
    ...meta,
    title: overlay.title ?? meta.title,
    unreadAt: overlay.unreadAt,
  };
}

function deriveTitleFromSnapshot(snapshot: ZCodeSessionStateSnapshot): string {
  return resolveZCodeVisibleSessionTitle({
    title: snapshot.session.title,
    messages: snapshot.messages,
    target: snapshot.projection.target,
  });
}

function normalizeSnapshotMessageLimit(messageLimit: number | undefined): number | undefined {
  if (!messageLimit || !Number.isFinite(messageLimit) || messageLimit <= 0) {
    return undefined;
  }
  return Math.floor(messageLimit);
}

function buildSnapshotHistory(
  totalMessages: number,
  messageLimit: number,
): NonNullable<ZCodeTaskSnapshot["history"]> {
  return {
    truncatedBefore: totalMessages > messageLimit,
    totalMessages,
  };
}

function getTaskSnapshotMessageDiagnostics(snapshot: ZCodeTaskSnapshot) {
  let assistantMessages = 0;
  let userMessages = 0;
  let toolCalls = 0;
  let bodyRefs = 0;
  let toolSliceMessages = 0;
  let contentChars = 0;
  let thoughtChars = 0;

  for (const message of snapshot.messages) {
    if (message.role === "assistant") {
      assistantMessages += 1;
    } else {
      userMessages += 1;
    }
    toolCalls += message.tools?.length ?? 0;
    bodyRefs += message.bodyRefs?.length ?? 0;
    if (message.toolSlice) {
      toolSliceMessages += 1;
    }
    contentChars += message.content.length;
    thoughtChars += message.thought?.length ?? 0;
  }

  return {
    assistantMessages,
    bodyRefs,
    contentChars,
    fileChanges: snapshot.fileChanges?.length ?? 0,
    historyTotalMessages: snapshot.history?.totalMessages ?? snapshot.messages.length,
    messages: snapshot.messages.length,
    slashCommands: snapshot.slashCommands?.length ?? 0,
    thoughtChars,
    toolCalls,
    toolSliceMessages,
    truncatedBefore: snapshot.history?.truncatedBefore ?? false,
    userMessages,
  };
}

function limitTaskSnapshotMessages(
  snapshot: ZCodeTaskSnapshot,
  messageLimit: number | undefined,
): ZCodeTaskSnapshot {
  const limit = normalizeSnapshotMessageLimit(messageLimit);
  if (!limit) {
    return snapshot;
  }
  const history = buildSnapshotHistory(snapshot.messages.length, limit);
  return {
    ...snapshot,
    messages: history.truncatedBefore ? snapshot.messages.slice(-limit) : snapshot.messages,
    // The phone replayable first paint takes a tail window for performance.
    // Returned-count-equals-limit is no longer a has-older-history heuristic: short terminal
    // snapshots can be truncated windows too.
    history,
  };
}

function parseModelPickerValue(value: string): ModelSelection {
  const customModel = decodeCustomModelValue(value);
  if (customModel?.providerId && customModel.modelName) {
    // The dropdown's custom:provider:model is display-only; passed verbatim, zcode-cli
    // truncated at the first colon and sent glm/custom, triggering Unsupported model.
    return {
      providerId: customModel.providerId,
      modelId: customModel.modelName,
    };
  }

  return parseSharedModelSelection(value);
}

function toZCodeMode(mode: ZCodeTaskMode | undefined): ZCodeSessionMode | undefined {
  switch (mode) {
    case "plan":
      return "plan";
    case "edit":
      // The automation UI's auto-edit maps to canonical edit; the old mapping missed it and
      // the caller's ?? build silently downgraded the permission mode to confirm-before-edit.
      return "edit";
    case "guarded":
      return "guarded";
    case "yolo":
    case "bypassPermissions":
    case "dontAsk":
      return "yolo";
    case "auto":
      return "auto";
    case "build":
    case "default":
    case "acceptEdits":
    case "autoEdit":
      return "build";
    default:
      return undefined;
  }
}

function fromZCodeMode(mode: ZCodeSessionMode): ZCodeTaskMode {
  return mode === "build" ? "build" : mode;
}

function addSessionForkSnapshotFallback(
  messages: ZCodePersistedMessage[],
  snapshot: ZCodeSessionStateSnapshot,
): ZCodePersistedMessage[] {
  const parentSessionId = snapshot.session.parentSessionId;
  if (
    !parentSessionId ||
    messages.some((message) => message.syntheticTimeline?.type === "session_fork")
  ) {
    return messages;
  }

  return [
    ...messages,
    {
      id: `zcode-timeline-fork-${parentSessionId}-`,
      role: "user",
      content: "",
      timestamp: snapshot.session.createdAt,
      // Legacy chat-only forks stored no synthetic notice; recover a non-navigable separator
      // from session.parentSessionId so the fork origin stays visible.
      syntheticTimeline: {
        version: 1,
        kind: "synthetic",
        type: "session_fork",
        display: "separator",
        parentSessionId,
        targetMessageId: "",
      },
    },
  ];
}

function addGoalVerificationTimelineSnapshotFallback(
  messages: ZCodePersistedMessage[],
  snapshot: ZCodeSessionStateSnapshot,
): ZCodePersistedMessage[] {
  const timeline = snapshot.runtime.goalVerificationTimeline ?? [];
  if (timeline.length === 0) {
    return messages;
  }
  const existingIds = new Set(
    messages
      .map((message) =>
        message.syntheticTimeline?.type === "goal_verification"
          ? goalVerificationTimelineIdentityKey(message.syntheticTimeline)
          : null,
      )
      .filter((id): id is string => Boolean(id)),
  );
  const timelineMessages = timeline
    .filter((item) => !existingIds.has(goalVerificationTimelineIdentityKey(item)))
    .map<ZCodePersistedMessage>((item) => ({
      id: goalVerificationTimelineMessageId(item),
      role: "assistant",
      content: "",
      timestamp: item.startedAt ?? item.updatedAt,
      // The goal verifier lifecycle is persistent agent-snapshot state and may have no message
      // history; the task facade must also backfill dividers by target+iteration and anchor so
      // restore neither duplicates nor misplaces them.
      syntheticTimeline: item,
    }));
  if (timelineMessages.length === 0) {
    return messages;
  }
  return insertGoalVerificationTimelineMessages(messages, timelineMessages);
}

function goalVerificationTimelineIdentityKey(
  item: Extract<ZCodeGoalVerificationTimelineMeta, { type: "goal_verification" }>,
): string {
  if (typeof item.goalIteration === "number") {
    return `${item.targetId}:${item.goalIteration}`;
  }
  return `verification:${item.verificationId}`;
}

function goalVerificationTimelineMessageId(
  item: Extract<ZCodeGoalVerificationTimelineMeta, { type: "goal_verification" }>,
): string {
  if (typeof item.goalIteration === "number") {
    return `zcode-goal-verification-${item.targetId}-${item.goalIteration}`;
  }
  return `zcode-goal-verification-${item.verificationId}`;
}

function insertGoalVerificationTimelineMessages(
  messages: ZCodePersistedMessage[],
  timelineMessages: ZCodePersistedMessage[],
): ZCodePersistedMessage[] {
  const result = [...messages];
  for (const message of [...timelineMessages].sort(
    (left, right) => left.timestamp - right.timestamp,
  )) {
    const timeline = message.syntheticTimeline;
    const anchorIndex =
      timeline?.type === "goal_verification" && timeline.anchorAssistantMessageId
        ? findPersistedMessageIndexById(result, timeline.anchorAssistantMessageId)
        : -1;
    if (anchorIndex >= 0) {
      result.splice(goalVerificationAnchorInsertIndex(result, anchorIndex), 0, message);
      continue;
    }
    result.splice(timestampInsertIndex(result, message.timestamp), 0, message);
  }
  return result;
}

function normalizeGoalVerificationTimelineMessageOrder(
  messages: ZCodePersistedMessage[],
): ZCodePersistedMessage[] {
  const timelineMessages = messages.filter(
    (message) => message.syntheticTimeline?.type === "goal_verification",
  );
  if (timelineMessages.length === 0) {
    return messages;
  }
  // Verifier dividers already in agent history can also land after the next user input due to
  // async arrival; the snapshot must reproject by anchor, not only backfill missing dividers.
  return insertGoalVerificationTimelineMessages(
    messages.filter((message) => message.syntheticTimeline?.type !== "goal_verification"),
    timelineMessages,
  );
}

function goalVerificationAnchorInsertIndex(
  messages: readonly ZCodePersistedMessage[],
  anchorIndex: number,
): number {
  let index = anchorIndex + 1;
  while (
    index < messages.length &&
    messages[index]?.syntheticTimeline?.type === "goal_verification"
  ) {
    index += 1;
  }
  return index;
}

function timestampInsertIndex(
  messages: readonly ZCodePersistedMessage[],
  timestamp: number,
): number {
  const index = messages.findIndex((message) => message.timestamp > timestamp);
  return index >= 0 ? index : messages.length;
}

function findPersistedMessageIndexById(
  messages: readonly ZCodePersistedMessage[],
  messageId: string,
): number {
  return messages.findIndex(
    (message) => message.id === messageId || message.mergedMessageIds?.includes(messageId) === true,
  );
}

function getSnapshotGoalActiveIterationCount(snapshot: ZCodeSessionStateSnapshot): number {
  const targetId = snapshot.projection.target?.targetId;
  const timeline =
    snapshot.runtime.goalVerificationTimeline?.filter(
      (item) => !targetId || item.targetId === targetId,
    ) ?? [];
  return getZCodeGoalActiveIterationCount({
    targetStatus: snapshot.projection.target?.status ?? null,
    timeline,
  });
}

function toZCodeDeliveryKind(
  deliveryKind: "continuous" | "bot-channel-continuous" | "replayable" | "mixed" | undefined,
): ZCodeDeliveryKind {
  return deliveryKind === "replayable" ? "web-remote-replayable" : "desktop-continuous";
}

function backgroundTaskNotificationToolUpdateFromInput(params: {
  input: string | undefined;
  inputId: InputId | undefined;
  taskId: string;
  traceId: TraceId;
}): Extract<ZCodeStreamEvent, { type: "tool_call_update" }> | null {
  const parsed = parseZCodeBackgroundTaskNotificationText(params.input);
  if (!parsed) {
    return null;
  }
  const status = zcodeBackgroundTaskNotificationToolUpdateStatus(parsed.notification.status);
  return {
    type: "tool_call_update",
    taskId: params.taskId,
    traceId: params.traceId,
    ...(params.inputId ? { inputId: params.inputId } : {}),
    toolId: parsed.toolUseId,
    status,
    content: parsed.notification.result ?? parsed.notification.summary,
    // Replayable dynamic events must also surface the notification error as the standard tool
    // error, or phone remote and desktop continuous diverge on failure details.
    ...(status === "failed" && parsed.notification.error
      ? { error: parsed.notification.error }
      : {}),
    raw: attachZCodeBackgroundTaskNotificationToRaw(
      { toolCallId: parsed.toolUseId },
      parsed.notification,
    ),
  };
}

function mapMessage(
  message: ZCodeMessageWithParts,
  goalIteration?: number,
  backgroundTaskNotifications?: ReadonlyMap<string, ZCodeBackgroundTaskNotificationInfo>,
): ZCodePersistedMessage {
  const tools: ZCodePersistedToolCall[] = [];
  const parts: ZCodePersistedMessagePart[] = [];
  const attachments =
    message.info.role === "user" ? mapPromptAttachmentsFromParts(message.parts) : undefined;
  let syntheticTimeline: ZCodeTimelineMeta | undefined;
  for (const part of message.parts) {
    if (part.type === "text") {
      // Structured synthetic messages (fork notice etc.) carry timeline meta in part.metadata;
      // persistence drops that field, so hoist a copy onto the message for the UI separator.
      if (!syntheticTimeline) {
        const fromText = extractSyntheticTimelineFromTextPart(part);
        if (fromText) {
          syntheticTimeline = fromText;
        }
      }
    } else if (part.type === "compaction" && !syntheticTimeline) {
      // The compact summary/timelineText is agent-internal context, not chat body. Restore
      // synthesizes only the divider from structured fields; copy comes from UI/TUI i18n.
      syntheticTimeline = synthesizeCompactionTimeline(part);
    }
  }
  for (const part of message.parts) {
    if (part.type === "text") {
      parts.push({ type: "content", content: part.text });
    } else if (part.type === "reasoning") {
      parts.push({ type: "thought", content: part.text });
    } else if (part.type === "tool") {
      const toolIndex = tools.length;
      tools.push(mapToolPart(part, backgroundTaskNotifications));
      parts.push({ type: "tool-call", toolIndex });
    }
  }
  return {
    id: message.info.messageId,
    role: message.info.role,
    content: textFromParts(message.parts),
    timestamp: message.info.time.created,
    // Unbound restores still show full history; never fabricate a model for missing attribution.
    model: message.info.model ? formatModelPickerValue(message.info.model) : undefined,
    ...(syntheticTimeline ? { syntheticTimeline } : {}),
    ...(attachments ? { attachments } : {}),
    ...(message.info.role === "assistant"
      ? {
          ...(goalIteration ? { goalIteration } : {}),
          durationMs: message.info.time.completed
            ? message.info.time.completed - message.info.time.created
            : undefined,
          thought: reasoningFromParts(message.parts),
          tools: tools.length > 0 ? tools : undefined,
          parts: parts.length > 0 ? parts : undefined,
        }
      : {}),
  };
}

function mapPromptAttachmentsFromParts(
  parts: readonly ZCodeMessagePart[],
): ZCodePromptAttachment[] | undefined {
  const attachments = parts
    .filter((part): part is Extract<ZCodeMessagePart, { type: "file" }> => part.type === "file")
    .map(mapPromptAttachmentFromFilePart)
    .filter((attachment): attachment is ZCodePromptAttachment => attachment !== undefined);
  return attachments.length > 0 ? attachments : undefined;
}

function mapPromptAttachmentFromFilePart(
  part: Extract<ZCodeMessagePart, { type: "file" }>,
): ZCodePromptAttachment | undefined {
  const mimeType = part.mime || "application/octet-stream";
  const metadata = asRecord(part.metadata);
  const filename = part.filename?.trim() || filenameFromPathLike(part.url) || "attachment";
  const sizeBytes = numberValue(metadata.sizeBytes);
  const dataBase64 = dataBase64FromDataUrl(part.url);
  const localPath = localPathFromAttachmentPart(part.url, metadata);

  // History restore used to treat file parts as model context only, never backfilling the UI
  // attachments field, so attachment chips vanished. Re-project persisted file parts into
  // their original sent-attachment shapes here.
  if (mimeType.startsWith("image/")) {
    return {
      kind: "image",
      filename,
      mimeType,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(dataBase64 ? { dataBase64 } : {}),
      ...(localPath ? { localPath } : {}),
    };
  }

  if (mimeType.startsWith("audio/")) {
    return {
      kind: "audio",
      filename,
      mimeType,
      ...(dataBase64 ? { dataBase64 } : {}),
      ...(localPath ? { localPath } : {}),
    };
  }

  if (mimeType.startsWith("video/")) {
    return {
      kind: "video",
      filename,
      mimeType,
      ...(sizeBytes !== undefined ? { sizeBytes } : {}),
      ...(dataBase64 ? { dataBase64 } : {}),
      ...(localPath ? { localPath } : {}),
    };
  }

  const preview = asRecord(metadata.preview);
  const textContent = !localPath ? stringValue(preview.text) : undefined;
  return {
    kind: "file",
    filename,
    mimeType,
    sizeBytes: sizeBytes ?? 0,
    ...(dataBase64 ? { dataBase64 } : {}),
    ...(textContent !== undefined ? { textContent } : {}),
    ...(localPath ? { localPath } : {}),
  };
}

function dataBase64FromDataUrl(value: string): string | undefined {
  const match = /^data:[^;,]+;base64,(.*)$/i.exec(value);
  return match?.[1] || undefined;
}

function localPathFromAttachmentPart(
  url: string,
  metadata: Record<string, unknown>,
): string | undefined {
  const originalUrl = stringValue(metadata.originalUrl);
  if (originalUrl && isAbsolutePathLike(originalUrl)) {
    return originalUrl;
  }
  return isAbsolutePathLike(url) ? url : undefined;
}

function isAbsolutePathLike(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\");
}

function filenameFromPathLike(value: string): string | undefined {
  if (value.startsWith("data:")) {
    return undefined;
  }
  const pathPart = value.split(/[?#]/u)[0] ?? "";
  const segments = pathPart.split(/[\\/]/u).filter(Boolean);
  const filename = segments.at(-1)?.trim();
  return filename && !filename.includes("://") ? filename : undefined;
}

function extractSyntheticTimelineFromTextPart(
  part: Extract<ZCodeMessagePart, { type: "text" }>,
): ZCodeTimelineMeta | undefined {
  const metadata = part.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const forkContext = (metadata as Record<string, unknown>)["forkContext"];
  if (!forkContext || typeof forkContext !== "object") return undefined;
  const ctx = forkContext as Record<string, unknown>;
  if (ctx["kind"] !== "session_fork") return undefined;
  const parentSessionId = typeof ctx["parentSessionId"] === "string" ? ctx["parentSessionId"] : "";
  const targetMessageId = typeof ctx["targetMessageId"] === "string" ? ctx["targetMessageId"] : "";
  const targetCheckpointId =
    typeof ctx["targetCheckpointId"] === "string" ? ctx["targetCheckpointId"] : undefined;
  if (!parentSessionId || !targetMessageId) return undefined;
  return {
    version: 1,
    kind: "synthetic",
    type: "session_fork",
    display: "separator",
    parentSessionId,
    targetMessageId,
    ...(targetCheckpointId ? { targetCheckpointId } : {}),
    ...(typeof ctx["restoredFileCount"] === "number"
      ? { restoredFileCount: ctx["restoredFileCount"] }
      : {}),
  };
}

function synthesizeCompactionTimeline(
  part: Extract<ZCodeMessagePart, { type: "compaction" }>,
): ZCodeTimelineMeta | undefined {
  const metadata = asRecord(part.metadata);
  const operationId = stringValue(metadata.operationId) ?? part.partId;
  const status = timelineStatusValue(metadata.timelineStatus);
  if (!status && !part.summaryMessageId) {
    // The compact summary user message also carries compaction metadata, but it is model
    // context, not a UI timeline; rendering it would add a stray divider on restore.
    return undefined;
  }
  const trigger = timelineTriggerValue(metadata.trigger) ?? (part.auto ? "auto" : "manual");
  const replace = booleanValue(metadata.replace);
  const reason = part.reason ?? stringValue(metadata.reason);
  const boundaryId = stringValue(metadata.boundaryId) ?? part.summaryMessageId;
  const summaryMessageId = part.summaryMessageId ?? stringValue(metadata.summaryMessageId);
  const preCompactTokenCount = numberValue(metadata.preCompactTokenCount);
  const postCompactTokenCount = numberValue(metadata.postCompactTokenCount);
  const truePostCompactTokenCount = numberValue(metadata.truePostCompactTokenCount);
  const attempt = numberValue(metadata.attempt);
  const maxAttempts = numberValue(metadata.maxAttempts);
  const startedAt = numberValue(metadata.startedAt);
  const endedAt = numberValue(metadata.endedAt);
  return {
    version: 1,
    kind: "synthetic",
    type: "context_compaction",
    operationId,
    status: status ?? "completed",
    trigger,
    display: "separator",
    ...(replace !== undefined ? { replace } : {}),
    ...(reason ? { reason } : {}),
    ...(boundaryId ? { boundaryId } : {}),
    ...(summaryMessageId ? { summaryMessageId } : {}),
    ...(preCompactTokenCount !== undefined ? { preCompactTokenCount } : {}),
    ...(postCompactTokenCount !== undefined ? { postCompactTokenCount } : {}),
    ...(truePostCompactTokenCount !== undefined ? { truePostCompactTokenCount } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
}

function mapToolPart(
  part: Extract<ZCodeMessagePart, { type: "tool" }>,
  backgroundTaskNotifications?: ReadonlyMap<string, ZCodeBackgroundTaskNotificationInfo>,
): ZCodePersistedToolCall {
  const state = part.state;
  const taskNotification = backgroundTaskNotifications?.get(part.callId);
  // part.callId is the tool identity shared by the live stream and the terminal snapshot.
  // Saving metadata alone lost toolCallId, leaving result-only transient tools uncovered by
  // the terminal snapshot in phone replayable.
  const raw = attachZCodeBackgroundTaskNotificationToRaw(
    attachToolCallIdToRaw("metadata" in state ? (state.metadata ?? state) : state, part.callId),
    taskNotification,
  );
  if (state.status === "completed") {
    // A completed snapshot here is the background-agent launch ACK; the failed notification
    // must override it during replayable restore without touching stopped and other statuses.
    const notificationStatus = taskNotification?.status
      ? zcodeBackgroundTaskNotificationToolUpdateStatus(taskNotification.status)
      : undefined;
    const notificationFailed = notificationStatus === "failed";
    return {
      toolName: part.tool,
      title: state.title || part.tool,
      kind: part.tool,
      status: notificationFailed ? "failed" : "completed",
      input: state.input,
      output: state.output,
      ...(notificationFailed && taskNotification?.error ? { error: taskNotification.error } : {}),
      raw,
    };
  }
  if (state.status === "error") {
    return {
      toolName: part.tool,
      title: part.tool,
      kind: part.tool,
      status: "failed",
      input: state.input,
      error: state.error,
      raw,
    };
  }
  return {
    toolName: part.tool,
    title: "title" in state && state.title ? state.title : part.tool,
    kind: part.tool,
    input: state.input,
    raw,
  };
}

function attachToolCallIdToRaw(raw: unknown, toolCallId: string): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { toolCallId, raw };
  }
  return {
    ...raw,
    toolCallId:
      typeof (raw as Record<string, unknown>).toolCallId === "string"
        ? (raw as Record<string, unknown>).toolCallId
        : toolCallId,
  };
}

function textFromParts(parts: readonly ZCodeMessagePart[]): string {
  return textFromZCodeMessageParts(parts);
}

function reasoningFromParts(parts: readonly ZCodeMessagePart[]): string | undefined {
  const text = parts
    .filter(
      (part): part is Extract<ZCodeMessagePart, { type: "reasoning" }> => part.type === "reasoning",
    )
    .map((part) => part.text)
    .join("");
  return text || undefined;
}

function fromZCodeGoal(goal: unknown): ZCodeTaskGoal {
  const record = asRecord(goal);
  const time = asRecord(record.time);
  const status = stringValue(record.status);
  return {
    sessionID: stringValue(record.sessionID) ?? stringValue(record.sessionId) ?? "",
    targetID: stringValue(record.targetID) ?? stringValue(record.targetId) ?? "",
    objective: stringValue(record.objective) ?? "",
    summaryTitle: stringValue(record.summaryTitle) ?? null,
    status: isZCodeTaskGoalStatus(status) ? status : "active",
    tokenBudget: typeof record.tokenBudget === "number" ? record.tokenBudget : null,
    tokensUsed: numberValue(record.tokensUsed) ?? 0,
    timeUsedSeconds: numberValue(record.timeUsedSeconds) ?? 0,
    time: {
      created: numberValue(time.created) ?? numberValue(record.createdAt) ?? 0,
      updated: numberValue(time.updated) ?? numberValue(record.updatedAt) ?? 0,
    },
  };
}

function isZCodeTaskGoalStatus(status: string | undefined): status is ZCodeTaskGoal["status"] {
  return (
    status === "active" ||
    status === "paused" ||
    status === "budget_limited" ||
    status === "complete"
  );
}

function sessionTodosToPlanSteps(
  todos: ZCodeSessionStateSnapshot["todos"],
): ZCodePlanStep[] | null {
  if (!todos || todos.length === 0) {
    return null;
  }
  return todos.map((todo, index) => ({
    id: `todo-${index}`,
    status: todo.status,
    title: todo.content,
  }));
}

function sessionGoalStatsToRuntime(
  stats: ZCodeSessionStateSnapshot["goalStats"],
): ZCodeTaskGoalStats | null {
  return stats ? { ...stats } : null;
}

function sessionTodoGroupsToRuntime(
  groups: ZCodeSessionStateSnapshot["todoGroups"],
): ZCodeTodoGroup[] | null {
  if (!groups || groups.length === 0) {
    return null;
  }
  return groups.map((group) => ({
    id: group.id,
    source: group.source,
    ...(group.goalIteration ? { goalIteration: group.goalIteration } : {}),
    ...(group.targetId ? { targetId: group.targetId } : {}),
    ...(group.startedAt ? { startedAt: group.startedAt } : {}),
    ...(group.updatedAt ? { updatedAt: group.updatedAt } : {}),
    todos: group.todos.map((todo, index) => ({
      id: `${group.id}-todo-${index}`,
      status: todo.status,
      title: todo.content,
    })),
  }));
}

function mapStateUpdated(
  params: TaskTarget,
  notification: ZCodeStateUpdatedNotification,
): ZCodeStreamEvent[] {
  const parsedSettings = zcodeSessionSettingsStateSchema.safeParse(notification.patch);
  if (!parsedSettings.success) {
    return [];
  }
  const traceId = generateTraceId(params.taskId);
  return [
    {
      type: "mode_update",
      taskId: params.taskId,
      traceId,
      currentModeId: normalizeAvailableZCodeMode(parsedSettings.data.mode.current),
      availableModes: getZCodeAgentAvailableModes(),
    },
    {
      type: "glm_agent_model_state_update",
      taskId: params.taskId,
      traceId,
      version: 1,
      sessionId: params.taskId,
      reason:
        notification.reason === "thought_level_changed"
          ? "thought_level_changed"
          : notification.reason === "model_changed"
            ? "model_changed"
            : "session_initialized",
      model: {
        currentValue: formatModelPickerValue(parsedSettings.data.model.current),
      },
      thoughtLevel: {
        enabled: parsedSettings.data.thoughtLevel.enabled,
        currentValue: parsedSettings.data.thoughtLevel.current,
        options: parsedSettings.data.thoughtLevel.available.map((option) => ({
          value: option.value,
          name: option.label,
        })),
      },
      contextWindow: {
        tokens:
          parsedSettings.data.model.available.find(
            (option) =>
              formatModelPickerValue(option.ref) ===
              formatModelPickerValue(parsedSettings.data.model.current),
          )?.contextWindow ?? 0,
      },
    },
  ];
}

function mapSessionEvent(
  params: TaskTarget,
  event: ZCodeSessionEvent,
  streamedTurnText: Map<string, { messageId?: string; text: string }>,
  activePromptInputId?: InputId,
  toolProjectionMemory?: ZCodeToolProjectionMemory,
  backgroundTaskControlsByTaskKey?: Map<string, ZCodeBackgroundTaskControlItem[]>,
  hasActiveApiRetry = false,
): ZCodeStreamEvent[] {
  const protocolTraceId = event.traceId ?? generateTraceId(params.taskId);
  const payload = asRecord(event.payload);
  const inputId = stringValue(payload.inputId);
  const queryId = stringValue(payload.queryId);
  // The compat layer's traceId means one user input through the end of its reply. The ZCode
  // Protocol runtime trace is fallback-only when the event has no inputId, so one turn's
  // chunk/tool/complete stay under a single trace.
  const eventInputId = inputId ?? activePromptInputId;
  const traceId = eventInputId ?? protocolTraceId;
  if (eventInputId && eventInputId !== protocolTraceId) {
    logger.debug(
      eventInputId,
      `Aligned ZCode prompt inputId eventType=${event.type} protocolTrace=${protocolTraceId}`,
    );
  }
  const turnKey = `${resolveWorkspaceKey(params)}:${event.sessionId}:${event.turnId ?? eventInputId ?? traceId}`;

  if (event.type === "turn.started") {
    streamedTurnText.delete(turnKey);
    const inputOrigin = asRecord(payload.intent).inputOrigin;
    const runStartedEvent: ZCodeStreamEvent = {
      ...(inputOrigin === "desktop" || inputOrigin === "mobile" ? { inputOrigin } : {}),
      type: "task_run_started",
      taskId: params.taskId,
      traceId,
      ...(eventInputId ? { inputId: eventInputId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      startedAt: event.timestamp,
    };
    const taskNotificationToolUpdate = backgroundTaskNotificationToolUpdateFromInput({
      input: stringValue(payload.input),
      taskId: params.taskId,
      traceId,
      inputId: eventInputId,
    });
    if (taskNotificationToolUpdate) {
      return [runStartedEvent, taskNotificationToolUpdate];
    }
    if (
      stringValue(payload.inputSource) === "goal-continuation" &&
      stringValue(payload.inputVisibility) === "model-only"
    ) {
      return [
        runStartedEvent,
        {
          type: "goal_iteration_started",
          taskId: params.taskId,
          traceId,
          ...(eventInputId ? { inputId: eventInputId } : {}),
          ...(stringValue(payload.targetId) ? { targetId: stringValue(payload.targetId) } : {}),
          startedAt: event.timestamp,
        },
      ];
    }
    return [runStartedEvent];
  }

  const compactTimeline = mapCompactTimelinePayload(params.taskId, traceId, eventInputId, payload);
  if (compactTimeline) {
    return [compactTimeline];
  }

  const partTimeline = mapSyntheticTimelinePartPayload(
    params.taskId,
    traceId,
    eventInputId,
    payload,
  );
  if (partTimeline) {
    return [partTimeline];
  }

  const modelStreaming = mapModelStreaming(
    params.taskId,
    traceId,
    eventInputId,
    payload,
    toolProjectionMemory,
  );
  const apiRetryClearEvent = maybeBuildApiRetryClearOnModelProgress(
    hasActiveApiRetry,
    params.taskId,
    traceId,
    eventInputId,
    payload,
  );
  if (modelStreaming) {
    if (modelStreaming.type === "agent_message_chunk" && !modelStreaming.parentToolUseId) {
      const previous = streamedTurnText.get(turnKey);
      const messageId = modelStreaming.messageId;
      const sameMessage = !messageId || !previous?.messageId || messageId === previous.messageId;
      streamedTurnText.set(turnKey, {
        messageId: messageId ?? previous?.messageId,
        text: (sameMessage ? (previous?.text ?? "") : "") + modelStreaming.content,
      });
    }
    return apiRetryClearEvent ? [apiRetryClearEvent, modelStreaming] : [modelStreaming];
  }
  if (apiRetryClearEvent) {
    return [apiRetryClearEvent];
  }

  if (event.type === "tool.updated") {
    // The pre-tool preamble is not the final answer; the next model message needs its own received-body check.
    if (payload.kind === "scheduled" && !parentToolUseIdFromToolPayload(payload)) {
      streamedTurnText.delete(turnKey);
    }
    return mapToolUpdated(params.taskId, traceId, eventInputId, payload, toolProjectionMemory);
  }

  if (event.type === "permission.requested") {
    const toolCallId = stringValue(payload.toolCallId);
    const toolName = stringValue(payload.toolName);
    if (toolCallId && toolName) {
      toolProjectionMemory?.toolNameById?.set(toolCallId, toolName);
    }
    if (isUserInputBackedPermissionToolName(toolName)) {
      // For AskUserQuestion/ExitPlanMode, permission.requested is only a core waiting marker;
      // the real questions arrive via interaction/requestUserInput. Projecting it as a normal
      // permission shows an Allow/Deny dialog that cannot write answers into tool input.
      return [];
    }
    return [permissionPayloadToStreamEvent(params.taskId, traceId, eventInputId, payload)];
  }

  if (event.type === "permission.resolved") {
    return permissionResolvedPayloadToStreamEvents(
      params.taskId,
      traceId,
      eventInputId,
      payload,
      toolProjectionMemory?.toolNameById,
    );
  }

  if (event.type === "turn.steerQueued") {
    const source = turnSteerSourceValue(payload.source);
    return [
      {
        type: "turn_steer_queued",
        taskId: params.taskId,
        traceId,
        ...(eventInputId ? { inputId: eventInputId } : {}),
        ...(queryId ? { queryId } : {}),
        pendingInputId: stringValue(payload.pendingInputId) ?? event.eventId,
        messageId: eventInputId,
        ...(turnSteerCommandKindValue(payload.commandKind)
          ? { commandKind: turnSteerCommandKindValue(payload.commandKind) }
          : {}),
        ...(source ? { source } : {}),
        targetTurnId: stringValue(payload.targetTurnId),
        content: stringValue(payload.input) ?? "",
        raw: payload,
      },
    ];
  }

  if (event.type === "turn.steerDrained") {
    return [
      {
        type: "turn_steer_status",
        taskId: params.taskId,
        traceId,
        ...(eventInputId ? { inputId: eventInputId } : {}),
        ...(stringArray(payload.queryIds).length > 0
          ? { queryIds: stringArray(payload.queryIds) }
          : {}),
        status: "drained",
        pendingInputIds: stringArray(payload.pendingInputIds),
        injectedMessageIds: stringArray(payload.injectedMessageIds),
        targetTurnId: stringValue(payload.targetTurnId),
        raw: payload,
      },
    ];
  }

  if (event.type === "turn.completed") {
    const events: ZCodeStreamEvent[] = [];
    const response = stringValue(payload.response);
    // Bugfix: tracking only saw-text-this-turn lets tool preambles mask the final-answer
    // fallback. Append the current model message's missing suffix before terminal; skip when
    // the full body already arrived.
    const streamed = streamedTurnText.get(turnKey)?.text ?? "";
    const missingResponse = response?.startsWith(streamed)
      ? response.slice(streamed.length)
      : response;
    if (missingResponse) {
      events.push({
        type: "agent_message_chunk",
        taskId: params.taskId,
        traceId,
        ...(eventInputId ? { inputId: eventInputId } : {}),
        content: missingResponse,
      });
    }
    events.push({
      type: "task_complete",
      taskId: params.taskId,
      traceId,
      ...(eventInputId ? { inputId: eventInputId } : {}),
      stopReason: stringValue(payload.resultType) ?? "complete",
      usage: usageFromPayload(payload.usage),
    });
    toolProjectionMemory?.streamingToolInputById?.clear();
    streamedTurnText.delete(turnKey);
    return events;
  }

  if (event.type === "turn.failed") {
    toolProjectionMemory?.streamingToolInputById?.clear();
    streamedTurnText.delete(turnKey);
    const errorPayload = asRecord(payload.error);
    if (stringValue(payload.turnPhase) === "compact") {
      return [
        compactFailureToTimelineEvent(
          params.taskId,
          traceId,
          eventInputId,
          stringValue(errorPayload.message) ?? "ZCode compact failed",
        ),
      ];
    }
    const attribution = errorAttributionSchema.safeParse(errorPayload.attribution);
    // Dynamic task events also write the task index; fixing only the snapshot read path still loses live attribution.
    return [
      {
        type: "task_error",
        taskId: params.taskId,
        traceId,
        ...(eventInputId ? { inputId: eventInputId } : {}),
        error: stringValue(errorPayload.message) ?? "ZCode session failed",
        // type is the outer classification; code is the real provider/subagent error to display.
        code: stringValue(errorPayload.code) ?? stringValue(errorPayload.type),
        detail: stringValue(errorPayload.detail),
        ...(attribution.success ? { attribution: attribution.data } : {}),
      },
    ];
  }

  return mapSessionInfoLikePayload(
    params.taskId,
    traceId,
    eventInputId,
    event.eventId,
    payload,
    backgroundTaskControlsByTaskKey,
    `${resolveWorkspaceKey(params)}\u0000${params.taskId}`,
  );
}

function maybeBuildApiRetryClearOnModelProgress(
  hasActiveApiRetry: boolean,
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "session_info_update" }> | null {
  if (!hasActiveApiRetry || !isZCodeModelRetryRecoveryProgressPayload(payload)) {
    return null;
  }
  // A retry attempt starting is not recovery; clearing immediately flickers the input bar.
  // Clear the retrying state only once an attempt produces model content.
  return {
    type: "session_info_update",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    apiRetry: null,
  };
}

function mapModelStreaming(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
  toolProjectionMemory?: ZCodeToolProjectionMemory,
): ZCodeStreamEvent | null {
  const kind = stringValue(payload.kind);
  const delta = stringValue(payload.delta);
  const parentToolUseId = parentToolUseIdFromToolPayload(payload);
  if (kind === "text_delta") {
    if (!delta) {
      return null;
    }
    return {
      type: "agent_message_chunk",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      ...(parentToolUseId ? { parentToolUseId } : {}),
      messageId: stringValue(payload.assistantMessageId),
      content: delta,
    };
  }
  if (kind === "reasoning_delta") {
    if (!delta) {
      return null;
    }
    return {
      type: "agent_thought_chunk",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      ...(parentToolUseId ? { parentToolUseId } : {}),
      content: delta,
    };
  }
  return mapToolInputStreaming(taskId, traceId, inputId, payload, toolProjectionMemory);
}

function mapToolInputStreaming(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
  toolProjectionMemory?: ZCodeToolProjectionMemory,
): ZCodeStreamEvent | null {
  const streamingToolInputById = toolProjectionMemory?.streamingToolInputById;
  const toolNameById = toolProjectionMemory?.toolNameById;
  const kind = stringValue(payload.kind);
  const toolId = stringValue(payload.toolCallId);
  if (!toolId) {
    return null;
  }
  const toolName = stringValue(payload.toolName) ?? toolNameById?.get(toolId);
  if (toolName) {
    toolNameById?.set(toolId, toolName);
  }
  const title = toolName ?? "tool";
  const parentToolUseId = parentToolUseIdFromToolPayload(payload);
  const buildRaw = (input: unknown, rawInput: string | undefined) => ({
    ...payload,
    ...(input !== undefined ? { input } : {}),
    ...(rawInput ? { streamingRawInputLength: rawInput.length } : {}),
  });

  if (kind === "tool_input_start") {
    streamingToolInputById?.set(toolId, { rawInput: "" });
    logStreamingToolInputProjection(traceId, {
      inputKeys: [],
      kind,
      projectedType: "tool_call",
      rawInputLength: 0,
      taskId,
      toolId,
      toolName,
    });
    return {
      type: "tool_call",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      input: {},
      toolName,
      kind: title,
      title,
      raw: buildRaw({}, undefined),
    };
  }

  if (kind === "tool_input_delta") {
    const state = appendZCodeStreamingToolInputDelta(
      streamingToolInputById?.get(toolId),
      stringValue(payload.delta) ?? "",
    );
    streamingToolInputById?.set(toolId, state);
    if (!shouldMaterializeZCodeStreamingToolInputPreview(state, { toolName })) {
      // Perf fix: the compat projection used to parse the accumulated JSON on every delta and
      // ship the full rawInput inside raw. Keep only a tombstone buffer and emit at budget and
      // control boundaries, avoiding O(n^2) on host and renderer.
      return null;
    }
    const preview = buildZCodeStreamingToolInputPreview(state.rawInput);
    markZCodeStreamingToolInputPreviewMaterialized(state);
    const previewToolName = toolName ?? inferStreamingToolInputToolName(preview.input);
    const previewTitle = previewToolName ?? title;
    if (previewToolName && !toolName) {
      toolNameById?.set(toolId, previewToolName);
    }
    logStreamingToolInputProjection(traceId, {
      inputKeys: inputPreviewKeys(preview.input),
      kind,
      projectedType: "tool_call_update",
      rawInputLength: state.rawInput.length,
      taskId,
      toolId,
      toolName: previewToolName,
    });
    return {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      status: "pending",
      title: previewTitle,
      toolName: previewToolName,
      kind: previewTitle,
      input: preview.input,
      raw: buildRaw(preview.input, preview.rawInput),
    };
  }

  if (kind === "tool_input_end") {
    const state = streamingToolInputById?.get(toolId) ?? { rawInput: "" };
    const previewToolName = toolName ?? title;
    const previewTitle = previewToolName ?? title;
    logStreamingToolInputProjection(traceId, {
      inputKeys: [],
      kind,
      projectedType: "tool_call_update",
      rawInputLength: state.rawInput.length,
      taskId,
      toolId,
      toolName: previewToolName,
    });
    return {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      status: "pending",
      title: previewTitle,
      toolName: previewToolName,
      kind: previewTitle,
      // Perf fix: when tool_input_end is adjacent to the final tool_call, stop re-parsing the
      // same large JSON; end is a lifecycle marker and tool_call persists/renders the full input once.
      raw: buildRaw(undefined, state.rawInput),
    };
  }

  if (kind === "tool_call") {
    const state = streamingToolInputById?.get(toolId);
    const rawInput = state?.rawInput ?? "";
    const hasCompleteInput = "input" in payload;
    const completeInput = hasCompleteInput ? payload.input : undefined;
    const preview = buildZCodeStreamingToolInputPreview(
      rawInput,
      hasCompleteInput ? completeInput : undefined,
    );
    const previewToolName = toolName ?? inferStreamingToolInputToolName(preview.input);
    const previewTitle = previewToolName ?? title;
    if (previewToolName && !toolName) {
      toolNameById?.set(toolId, previewToolName);
    }
    if ((hasCompleteInput || preview.complete) && toolProjectionMemory) {
      finalizeZCodeToolProjectionInput(toolId, preview.input, toolProjectionMemory);
    }
    streamingToolInputById?.set(toolId, {
      // Perf fix: the final tool_call already holds the full input, so the compat projection
      // drops the long-lived streaming raw buffer, cutting host memory and serialization cost
      // on long concurrent tasks.
      rawInput: "",
      deltaCount: state?.deltaCount,
      lastPreviewAt: Date.now(),
      lastPreviewRawInputLength: rawInput.length,
    });
    logStreamingToolInputProjection(traceId, {
      inputKeys: inputPreviewKeys(preview.input),
      kind,
      projectedType: "tool_call_update",
      rawInputLength: rawInput.length,
      taskId,
      toolId,
      toolName: previewToolName,
    });
    return {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      status: "pending",
      title: previewTitle,
      toolName: previewToolName,
      kind: previewTitle,
      input: preview.input,
      raw: buildRaw(preview.input, preview.rawInput),
    };
  }

  return null;
}

function logStreamingToolInputProjection(
  traceId: TraceId,
  details: {
    inputKeys: string[];
    kind: string;
    projectedType: "tool_call" | "tool_call_update";
    rawInputLength: number;
    taskId: string;
    toolId: string;
    toolName?: string;
  },
): void {
  logger.debug(traceId, "ZCode streaming tool input projected", {
    ...details,
    event: "zcode.task.streaming_tool_input.projected",
  });
}

function inputPreviewKeys(input: unknown): string[] {
  return Object.keys(asRecord(input));
}

function inferStreamingToolInputToolName(input: unknown): string | undefined {
  const record = asRecord(input);
  const filePath = readStreamingToolInputStringField(record, [
    "file_path",
    "filePath",
    "path",
    "target_path",
    "targetPath",
    "filename",
    "file",
  ]);
  if (!filePath) {
    return undefined;
  }
  if (
    readStreamingToolInputStringField(record, ["old_string", "oldString", "old_text", "oldText"])
  ) {
    return "Edit";
  }
  if (
    readStreamingToolInputStringField(record, [
      "content",
      "new_string",
      "newString",
      "new_text",
      "newText",
    ]) !== undefined
  ) {
    return "Write";
  }
  return undefined;
}

function readStreamingToolInputStringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

function mapCompactTimelinePayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }> | null {
  const timeline = compactTimelineMetaFromPayload(payload, inputId);
  if (!timeline) {
    return null;
  }
  const messageId = stringValue(payload.messageId);
  return {
    type: "agent_message_chunk",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    ...(messageId ? { messageId } : {}),
    // The compact lifecycle is a structured state event, not assistant body; even if upstream
    // misattaches text, keep internal summary/prompt out of the chat area.
    content: "",
    zcodeTimeline: timeline,
  };
}

function mapSyntheticTimelinePartPayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }> | null {
  const part = asRecord(payload.part);
  if (part.type !== "text") {
    return null;
  }
  const timeline = extractSyntheticTimelineFromTextPart(
    part as Extract<ZCodeMessagePart, { type: "text" }>,
  );
  if (!timeline) {
    return null;
  }
  const messageId = stringValue(part.messageId) ?? stringValue(payload.messageId);
  return {
    type: "agent_message_chunk",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    ...(messageId ? { messageId } : {}),
    content: stringValue(part.text) ?? "",
    // The fork notice is structured synthetic text in part.upserted, not a body delta; project
    // it as a timeline divider early or the UI renders it as a plain message and loses the rule.
    zcodeTimeline: timeline,
  };
}

function compactTimelineMetaFromPayload(
  payload: Record<string, unknown>,
  inputId: InputId | undefined,
): ZCodeContextCompactionTimelineMeta | null {
  const operationId = stringValue(payload.operationId);
  const status = timelineStatusValue(payload.status ?? payload.timelineStatus);
  if (!operationId || !status) {
    return null;
  }
  const trigger = timelineTriggerValue(payload.trigger) ?? "manual";
  const replace = booleanValue(payload.replace);
  const reason = stringValue(payload.reason);
  const boundaryId = stringValue(payload.boundaryId);
  const summaryMessageId = stringValue(payload.summaryMessageId);
  const preCompactTokenCount = numberValue(payload.preCompactTokenCount);
  const postCompactTokenCount = numberValue(payload.postCompactTokenCount);
  const truePostCompactTokenCount = numberValue(payload.truePostCompactTokenCount);
  const attempt = numberValue(payload.attempt);
  const maxAttempts = numberValue(payload.maxAttempts);
  const startedAt = numberValue(payload.startedAt);
  const endedAt = numberValue(payload.endedAt);
  return {
    version: 1,
    kind: "synthetic",
    type: "context_compaction",
    operationId,
    status,
    trigger,
    display: "separator",
    ...(inputId ? { inputId } : {}),
    ...(replace !== undefined ? { replace } : {}),
    ...(reason ? { reason } : {}),
    ...(boundaryId ? { boundaryId } : {}),
    ...(summaryMessageId ? { summaryMessageId } : {}),
    ...(preCompactTokenCount !== undefined ? { preCompactTokenCount } : {}),
    ...(postCompactTokenCount !== undefined ? { postCompactTokenCount } : {}),
    ...(truePostCompactTokenCount !== undefined ? { truePostCompactTokenCount } : {}),
    ...(attempt !== undefined ? { attempt } : {}),
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
}

function compactFailureToTimelineEvent(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  reason: string,
): Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }> {
  return {
    type: "agent_message_chunk",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    content: "",
    zcodeTimeline: {
      version: 1,
      kind: "synthetic",
      type: "context_compaction",
      operationId: `compact-failed-${inputId ?? traceId}`,
      status: /abort|cancel|interrupt|stop/i.test(reason) ? "interrupted" : "failed",
      trigger: "manual",
      display: "separator",
      ...(inputId ? { inputId } : {}),
      reason,
      endedAt: Date.now(),
    },
  };
}

function mapToolUpdated(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
  toolProjectionMemory?: ZCodeToolProjectionMemory,
): ZCodeStreamEvent[] {
  const toolId = stringValue(payload.toolCallId);
  if (!toolId) {
    return [];
  }
  const parentToolUseId = parentToolUseIdFromToolPayload(payload);
  const memory = toolProjectionMemory ?? {};
  const toolNameById = memory.toolNameById;
  const rememberedTool = resolveZCodeToolProjectionMetadata(payload, toolId, memory);
  const rememberedToolName = rememberedTool.toolName;
  const rememberedInput = rememberedTool.hasInput ? rememberedTool.input : undefined;
  if ("input" in payload && "toolName" in payload) {
    const toolName = rememberedToolName ?? "tool";
    toolNameById?.set(toolId, toolName);
    finalizeZCodeToolProjectionInput(toolId, payload.input, memory);
    const toolEvent: ZCodeStreamEvent = {
      type: "tool_call",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      input: payload.input,
      toolName,
      kind: toolName,
      title: toolName,
      raw: payload,
    };
    const planSteps = isMainAgentToolProjectionSource(payload)
      ? extractPlanStepsFromToolInput({
          title: toolName,
          kind: toolName,
          input: payload.input,
        })
      : null;
    if (!planSteps) {
      return [toolEvent];
    }
    return [
      toolEvent,
      {
        type: "plan",
        taskId,
        traceId,
        ...(inputId ? { inputId } : {}),
        steps: planSteps,
      },
    ];
  }
  if ("result" in payload) {
    const result = asRecord(payload.result);
    // The ZCode Protocol ToolCallResult carries only toolCallId/result, no toolName. Without
    // remembering the earlier ToolCallScheduled TodoWrite name, result todos degrade to plain
    // string output and never become todo/plan events.
    const toolName = rememberedToolName;
    const content = normalizeToolResultContent(toolName, result);
    const status = toolResultStatus(toolName, result);
    const toolEvent: ZCodeStreamEvent = {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      toolName,
      kind: toolName,
      title: toolName,
      ...(rememberedInput !== undefined ? { input: rememberedInput } : {}),
      status,
      content,
      error: stringValue(asRecord(result.error).message),
      raw: payload,
    };
    if (status !== "in_progress") {
      forgetZCodeToolProjectionMetadata(toolId, memory);
    }
    const planSteps = isMainAgentToolProjectionSource(payload)
      ? extractPlanStepsFromToolOutput({
          title: toolName,
          kind: toolName,
          output: content ?? result,
        })
      : null;
    if (!planSteps) {
      return [toolEvent];
    }
    return [
      toolEvent,
      {
        type: "plan",
        taskId,
        traceId,
        ...(inputId ? { inputId } : {}),
        steps: planSteps,
      },
    ];
  }
  if ("error" in payload) {
    forgetZCodeToolProjectionMetadata(toolId, memory);
    return [
      {
        type: "tool_call_update",
        taskId,
        traceId,
        ...(inputId ? { inputId } : {}),
        toolId,
        parentToolUseId,
        toolName: rememberedToolName,
        kind: rememberedToolName,
        title: rememberedToolName,
        ...(rememberedInput !== undefined ? { input: rememberedInput } : {}),
        status: "failed",
        error: stringValue(asRecord(payload.error).message) ?? "Tool failed",
        raw: payload,
      },
    ];
  }
  return [
    {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId,
      parentToolUseId,
      toolName: rememberedToolName,
      kind: rememberedToolName,
      title: rememberedToolName,
      ...(rememberedInput !== undefined && payload.inputOmitted !== true
        ? { input: rememberedInput }
        : {}),
      status: "in_progress",
      raw: payload,
    },
  ];
}

function toolResultStatus(
  toolName: string | undefined,
  result: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "tool_call_update" }>["status"] {
  if (result.success === false) {
    return "failed";
  }
  if (isBackgroundAgentLaunchResult(toolName, result)) {
    // The background-agent launch ACK means created, not completed; projecting completed marks
    // the subagent card done before the real completion.
    return "in_progress";
  }
  return "completed";
}

function isBackgroundAgentLaunchResult(
  toolName: string | undefined,
  result: Record<string, unknown>,
): boolean {
  const content = stringValue(result.content);
  if (!content) {
    return false;
  }
  if (
    (isSubagentDispatchToolName(toolName) || toolName === undefined) &&
    isBackgroundAgentLaunchAcknowledgement(content)
  ) {
    return true;
  }
  const parsed = parseJsonRecord(content);
  const parsedStatus = stringValue(parsed?.status);
  return (
    parsed !== null &&
    (isSubagentDispatchToolName(toolName) || stringValue(parsed.agentId) !== undefined) &&
    ((parsedStatus === "backgrounded" && stringValue(parsed.backgroundTaskId) !== undefined) ||
      (parsedStatus === "async_launched" &&
        stringValue(parsed.agentId) !== undefined &&
        stringValue(parsed.outputFile) !== undefined))
  );
}

function isBackgroundAgentLaunchAcknowledgement(content: string): boolean {
  // The model-visible async-launch ACK moved from backgroundTaskId/outputFile wording to
  // output_file wording; the projection must recognize both or it forwards the launch ack as a
  // completed result.
  return (
    isLegacyBackgroundAgentLaunchAcknowledgement(content) ||
    isPreviousBackgroundAgentLaunchAcknowledgement(content) ||
    isCurrentBackgroundAgentLaunchAcknowledgement(content)
  );
}

function isLegacyBackgroundAgentLaunchAcknowledgement(content: string): boolean {
  return (
    content.includes("backgroundTaskId:") &&
    content.includes("Runtime will wait for this background Agent")
  );
}

function isPreviousBackgroundAgentLaunchAcknowledgement(content: string): boolean {
  return (
    content.startsWith("Agent ") &&
    content.includes(" started in background.") &&
    content.includes("agentId:") &&
    content.includes("outputFile:") &&
    content.includes("You will be notified when the Agent completes.")
  );
}

function isCurrentBackgroundAgentLaunchAcknowledgement(content: string): boolean {
  return (
    content.startsWith("Async agent launched successfully.") &&
    content.includes("agentId:") &&
    content.includes("The agent is working in the background.") &&
    content.includes("notified automatically when it completes")
  );
}

function isSubagentDispatchToolName(toolName: string | undefined): boolean {
  return toolName === "Agent" || toolName === "Task";
}

function parentToolUseIdFromToolPayload(payload: Record<string, unknown>): string | null {
  // The ZCode Protocol names the parent field parentToolCallId while the UI stream model
  // consumes parentToolUseId; normalize once here in the service projection.
  return (
    stringValue(payload.parentToolUseId) ??
    stringValue(payload.parentToolCallId) ??
    rawClaudeParentToolUseId(payload)
  );
}

function rawClaudeParentToolUseId(raw: unknown): string | null {
  const meta = asRecord(raw)._meta;
  const claudeCode = asRecord(meta).claudeCode;
  return stringValue(asRecord(claudeCode).parentToolUseId) ?? null;
}

function normalizeToolResultContent(
  toolName: string | undefined,
  result: Record<string, unknown>,
): unknown {
  const content = result.content;
  const agentActivity = parseAgentActivityResultContent(toolName, content);
  return agentActivity ?? stringValue(content);
}

function parseAgentActivityResultContent(
  toolName: string | undefined,
  content: unknown,
): { kind: "agent_activity"; content: string; thought?: string } | null {
  if (typeof content !== "string" || content.trim().length === 0) {
    return null;
  }
  const parsed = parseJsonRecord(content);
  if (!parsed) {
    return null;
  }
  const isAgentResult =
    toolName === "Agent" ||
    toolName === "Task" ||
    stringValue(parsed.agentId) !== undefined ||
    stringValue(parsed.agentType) !== undefined;
  if (!isAgentResult) {
    return null;
  }
  // Agent tool results are JSON strings with the final summary in content[].text; convert to
  // agent_activity in the service layer instead of making every UI render path parse raw JSON.
  const output = agentTextFromContentField(parsed.content);
  if (!output) {
    return null;
  }
  const thought = stringValue(parsed.thought);
  return {
    kind: "agent_activity",
    content: output,
    ...(thought ? { thought } : {}),
  };
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function agentTextFromContentField(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const text = value
    .map((item) => stringValue(asRecord(item).text))
    .filter((item): item is string => Boolean(item))
    .join("\n");
  return text || undefined;
}

function permissionRequestToStreamEvent(
  taskId: string,
  request: ZCodePermissionRequestParams,
): ZCodePermissionRequest {
  return {
    type: "permission_request",
    taskId,
    traceId: generateTraceId(taskId),
    requestId: request.requestId,
    description: request.reason || request.toolName,
    kind: request.toolName,
    title: request.toolName,
    options: request.options,
    ...(request.origin ? { origin: request.origin } : {}),
    raw: request,
  };
}

function pendingPermissionToStreamEvent(
  taskId: string,
  permission: ZCodeSessionStateSnapshot["projection"]["pendingPermissions"][number],
): ZCodePermissionRequest {
  return {
    type: "permission_request",
    taskId,
    traceId: generateTraceId(taskId),
    requestId: permission.requestId,
    description: permission.reason || permission.toolName,
    kind: permission.toolName,
    title: permission.toolName,
    options: permission.options,
    ...(permission.origin ? { origin: permission.origin } : {}),
    raw: permission,
  };
}

function userInputRequestToElicitationStreamEvent(
  taskId: string,
  request: ZCodeUserInputRequestParams,
): ZCodeStreamEvent {
  const questions =
    request.questions?.map((question) => ({
      question: question.question,
      header: question.header,
      options: question.options.map((option) => ({
        value: option.value,
        label: option.label,
        description: option.description,
      })),
      ...(question.multiSelect ? { multiSelect: true } : {}),
    })) ?? [];
  const firstQuestion = questions[0];
  const requestSchema = asRecord(request.schema);
  const requestInput = asRecord(request.input);
  const plan =
    requestSchema.interaction === "plan_approval" &&
    typeof requestInput.plan === "string" &&
    requestInput.plan.trim()
      ? requestInput.plan.trim()
      : undefined;
  return {
    type: "elicitation_request",
    taskId,
    traceId: generateTraceId(taskId),
    requestId: request.requestId,
    message: firstQuestion?.question ?? request.prompt ?? "Input required",
    header: firstQuestion?.header,
    options: firstQuestion?.options ?? [],
    ...(firstQuestion?.multiSelect ? { multiSelect: true } : {}),
    ...(questions.length > 0 ? { questions } : {}),
    ...(request.origin ? { origin: request.origin } : {}),
    // The ExitPlanMode request carries both schema and input; schema ?? input alone drops
    // input.plan and the approval loses its body. Merge only plan, preserving the data boundary
    // of plain elicitations and other tool inputs.
    schema: plan ? { ...requestSchema, plan } : (request.schema ?? request.input),
  };
}

function userInputResponseToElicitationStreamEvent(
  taskId: string,
  requestId: string,
  response: ZCodeUserInputResponse,
): Extract<ZCodeStreamEvent, { type: "elicitation_response" }> {
  return {
    type: "elicitation_response",
    taskId,
    traceId: generateTraceId(taskId),
    requestId,
    action: response.action,
    ...(response.content ? { content: response.content } : {}),
  };
}

type PendingElicitationQuestion = {
  question: string;
  header: string;
  options: Array<{ value: string; label: string; description?: string }>;
  multiSelect?: boolean;
};

function pendingUserInputBackedPermissionToElicitationEvent(
  taskId: string,
  permission: ZCodeSessionStateSnapshot["projection"]["pendingPermissions"][number],
): Extract<ZCodeStreamEvent, { type: "elicitation_request" }> | null {
  if (isAskUserQuestionToolName(permission.toolName)) {
    return pendingAskUserQuestionToElicitationEvent(taskId, permission);
  }
  if (isExitPlanModeToolName(permission.toolName)) {
    return pendingExitPlanModeToElicitationEvent(taskId, permission);
  }
  return null;
}

function pendingAskUserQuestionToElicitationEvent(
  taskId: string,
  permission: ZCodeSessionStateSnapshot["projection"]["pendingPermissions"][number],
): Extract<ZCodeStreamEvent, { type: "elicitation_request" }> | null {
  const questions = askUserQuestionInputToElicitationQuestions(permission.input);
  if (questions.length === 0) {
    return null;
  }
  const firstQuestion = questions[0];
  return {
    type: "elicitation_request",
    taskId,
    traceId: generateTraceId(taskId),
    requestId: permission.requestId,
    message: firstQuestion?.question ?? permission.reason,
    header: firstQuestion?.header,
    options: firstQuestion?.options ?? [],
    ...(firstQuestion?.multiSelect ? { multiSelect: true } : {}),
    questions,
    ...(permission.origin ? { origin: permission.origin } : {}),
    schema: permission.input,
  };
}

function pendingExitPlanModeToElicitationEvent(
  taskId: string,
  permission: ZCodeSessionStateSnapshot["projection"]["pendingPermissions"][number],
): Extract<ZCodeStreamEvent, { type: "elicitation_request" }> {
  const questions = createExitPlanModeApprovalQuestions();
  const firstQuestion = questions[0];
  const input = asRecord(permission.input);
  const plan = typeof input.plan === "string" && input.plan.trim() ? input.plan.trim() : undefined;
  return {
    type: "elicitation_request",
    taskId,
    traceId: generateTraceId(taskId),
    requestId: permission.requestId,
    message: firstQuestion.question,
    header: firstQuestion.header,
    options: firstQuestion.options,
    questions,
    ...(permission.origin ? { origin: permission.origin } : {}),
    // The plan-approval projection must show this ExitPlanMode's plan body; project only plan
    // so other permission input never leaks into the generic elicitation schema.
    schema: {
      interaction: "plan_approval",
      toolName: permission.toolName,
      ...(plan ? { plan } : {}),
    },
  };
}

function setTaskBackgroundTaskControlCache(
  cache: Map<string, ZCodeBackgroundTaskControlItem[]> | undefined,
  cacheKey: string,
  jobs: ZCodeBackgroundTaskControlItem[],
) {
  cache?.set(cacheKey, jobs);
}

function updateTaskBackgroundTaskControlCacheFromPayload(
  cache: Map<string, ZCodeBackgroundTaskControlItem[]> | undefined,
  cacheKey: string,
  payload: Record<string, unknown>,
): ZCodeBackgroundTaskControlItem[] | null {
  const parsedJobs = parseZCodeBackgroundTaskControlItems([payload]);
  if (parsedJobs.length === 0) {
    return null;
  }
  if (!cache) {
    return parsedJobs;
  }
  const nextJobs = mergeZCodeBackgroundTaskControlItems(cache.get(cacheKey) ?? [], parsedJobs);
  cache.set(cacheKey, nextJobs);
  return nextJobs;
}

function createExitPlanModeApprovalQuestions(): [PendingElicitationQuestion] {
  return [
    {
      header: "Plan",
      options: [
        {
          description: "Exit plan mode and start implementation.",
          label: "Approve",
          value: EXIT_PLAN_MODE_APPROVAL_APPROVE,
        },
      ],
      question: EXIT_PLAN_MODE_APPROVAL_QUESTION,
    },
  ];
}

function askUserQuestionInputToElicitationQuestions(input: unknown): PendingElicitationQuestion[] {
  type ElicitationOption = PendingElicitationQuestion["options"][number];
  const questions = asRecord(input).questions;
  if (!Array.isArray(questions)) {
    return [];
  }
  return questions
    .map((question) => {
      const record = asRecord(question);
      const questionText = stringValue(record.question);
      const header = stringValue(record.header) ?? questionText;
      const rawOptions = Array.isArray(record.options) ? record.options : [];
      const options: ElicitationOption[] = rawOptions
        .map((option) => {
          const optionRecord = asRecord(option);
          const label = stringValue(optionRecord.label);
          if (!label) {
            return null;
          }
          const description = stringValue(optionRecord.description);
          const parsedOption: ElicitationOption = {
            value: label,
            label,
            ...(description ? { description } : {}),
          };
          return parsedOption;
        })
        .filter((option): option is ElicitationOption => option !== null);
      if (!questionText || !header || options.length === 0) {
        return null;
      }
      const parsedQuestion: PendingElicitationQuestion = {
        question: questionText,
        header,
        options,
        ...(record.multiSelect === true ? { multiSelect: true } : {}),
      };
      return parsedQuestion;
    })
    .filter((question): question is PendingElicitationQuestion => question !== null);
}

function permissionPayloadToStreamEvent(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
): ZCodeStreamEvent {
  return {
    type: "permission_request",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    requestId: stringValue(payload.requestId) ?? stringValue(payload.toolCallId) ?? "unknown",
    description:
      stringValue(payload.reason) ?? stringValue(payload.toolName) ?? "Permission required",
    kind: stringValue(payload.toolName) ?? "tool",
    title: stringValue(payload.toolName),
    options: permissionOptionsFromPayload(payload),
    raw: payload,
  };
}

function permissionOptionsFromPayload(payload: Record<string, unknown>): ZCodePermissionOption[] {
  return Array.isArray(payload.options) ? (payload.options as ZCodePermissionOption[]) : [];
}

function permissionResolvedPayloadToStreamEvents(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
  toolNameById?: Map<string, string>,
): ZCodeStreamEvent[] {
  const toolCallId = stringValue(payload.toolCallId);
  const toolName =
    stringValue(payload.toolName) ?? (toolCallId ? toolNameById?.get(toolCallId) : undefined);
  const decision = stringValue(payload.decision);
  const requestId = stringValue(payload.requestId) ?? toolCallId ?? "unknown";

  if (isUserInputBackedPermissionToolName(toolName)) {
    return [
      {
        type: "elicitation_response",
        taskId,
        traceId,
        ...(inputId ? { inputId } : {}),
        requestId,
        action: decision === "deny" ? "decline" : "accept",
      },
    ];
  }

  const permissionResponse = {
    type: "permission_response",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    requestId,
    optionId: decision ?? "allow",
    response: {
      decision: decision === "deny" ? "deny" : "allow",
    },
  } as Extract<ZCodeStreamEvent, { type: "permission_response" }>;

  if (decision !== "deny" || !toolCallId) {
    return [permissionResponse];
  }

  // Runtime denials (plan mode etc.) emit permission.resolved, possibly without a matching
  // tool.updated error event; clearing only the permission leaves started tool cards spinning.
  return [
    permissionResponse,
    {
      type: "tool_call_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId: toolCallId,
      parentToolUseId: parentToolUseIdFromToolPayload(payload),
      status: "failed",
      toolName,
      kind: toolName,
      title: toolName,
      error: stringValue(payload.reason) ?? "Permission denied",
      raw: payload,
    },
  ];
}

function mapSessionInfoLikePayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  eventId: string | undefined,
  payload: Record<string, unknown>,
  backgroundTaskControlsByTaskKey?: Map<string, ZCodeBackgroundTaskControlItem[]>,
  cacheKey = taskId,
): ZCodeStreamEvent[] {
  const events: ZCodeStreamEvent[] = [];
  // event.taskId is the external session id; the internal cache must keep the workspace-aware
  // taskKey or the replayable snapshot seed and later live updates split background-job state.
  const backgroundTaskControlCacheKey = cacheKey;
  const tokenUsageDelta = taskTokenUsageDeltaFromPayload(
    taskId,
    traceId,
    inputId,
    eventId,
    payload,
  );
  if (tokenUsageDelta) {
    events.push(tokenUsageDelta);
  }
  const networkDebugStatus = zcodeTaskNetworkDebugStatusFromPayload({
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    ...(eventId ? { eventId } : {}),
    payload,
  });
  if (networkDebugStatus) {
    events.push(networkDebugStatus);
  }
  const contextUsage = contextUsageFromPayload(payload);
  if (contextUsage) {
    events.push({
      type: "usage_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      used: contextUsage.used,
      size: contextUsage.size,
      cost: contextUsage.cost ?? null,
      ...(contextUsage.cache ? { cache: contextUsage.cache } : {}),
      ...(contextUsage.breakdown ? { breakdown: contextUsage.breakdown } : {}),
    });
  }
  const title = stringValue(payload.title);
  if (title) {
    events.push({
      type: "session_info_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      title,
    });
  }
  const apiRetry = apiRetryFromSessionInfoPayload(payload);
  if (apiRetry !== undefined) {
    events.push({
      type: "session_info_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      apiRetry,
    });
  }
  if ("target" in payload && ("action" in payload || "source" in payload)) {
    events.push({
      type: "session_info_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      target: {
        action: stringValue(payload.action) === "cleared" ? "cleared" : "set",
        source: stringValue(payload.source) === "tool" ? "tool" : "runtime",
        target: payload.target ? fromZCodeGoal(payload.target as never) : null,
        previousTarget: payload.previousTarget
          ? fromZCodeGoal(payload.previousTarget as never)
          : undefined,
      },
    });
  }
  const projection = asRecord(payload.projection);
  if (Array.isArray(projection.backgroundJobs)) {
    const jobs = parseZCodeBackgroundTaskControlItems(projection.backgroundJobs);
    setTaskBackgroundTaskControlCache(
      backgroundTaskControlsByTaskKey,
      backgroundTaskControlCacheKey,
      jobs,
    );
    events.push({
      type: "background_bash_jobs_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      jobs,
    });
  }
  const backgroundJobUpdate = updateTaskBackgroundTaskControlCacheFromPayload(
    backgroundTaskControlsByTaskKey,
    backgroundTaskControlCacheKey,
    payload,
  );
  if (backgroundJobUpdate) {
    events.push({
      type: "background_bash_jobs_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      jobs: backgroundJobUpdate,
    });
  }
  return events;
}

function taskTokenUsageDeltaFromPayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  eventId: string | undefined,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "task_token_usage_delta" }> | null {
  if (!isModelCompleteUsagePayload(payload)) {
    return null;
  }
  const usage = usageFromPayload(payload.usage);
  if (!usage || usage.totalTokens <= 0) {
    return null;
  }
  const querySource = stringValue(payload.querySource);
  const queryId = stringValue(payload.queryId);
  // Cumulative tokens must update on every model completion, not wait for the task_complete
  // rollup; eventId is the stable per-event stream key, so dedup on it keeps foreground and
  // background monitors from double counting.
  const eventKey =
    eventId ??
    `${traceId}:${inputId ?? "no-input"}:${queryId ?? "no-query"}:${querySource ?? "unknown"}:${usage.inputTokens}:` +
      `${usage.outputTokens}:${usage.totalTokens}`;
  return {
    type: "task_token_usage_delta",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    ...(queryId ? { queryId } : {}),
    eventKey,
    ...(eventId ? { eventId } : {}),
    ...(querySource ? { querySource } : {}),
    usage,
  };
}

function isModelCompleteUsagePayload(payload: Record<string, unknown>): boolean {
  if (!("usage" in payload)) {
    return false;
  }
  return (
    stringValue(payload.stopReason) !== undefined ||
    "contextWindow" in payload ||
    stringValue(payload.querySource) !== undefined
  );
}

function apiRetryFromSessionInfoPayload(
  payload: Record<string, unknown>,
): ZCodeApiRetryStatus | null | undefined {
  if ("apiRetry" in payload) {
    return normalizeZCodeApiRetryStatus(payload.apiRetry);
  }

  const runtimeRetry = normalizeZCodeApiRetryStatus(asRecord(payload.runtime).apiRetry);
  if (runtimeRetry !== undefined) {
    return runtimeRetry;
  }

  const metaRetry = normalizeZCodeApiRetryStatus(asRecord(asRecord(payload._meta).zcode).apiRetry);
  if (metaRetry !== undefined) {
    return metaRetry;
  }

  return (
    zcodeApiRetryFromStreamRecoveryPayload(payload) ??
    zcodeApiRetryFromModelNetworkStatusPayload(payload)
  );
}

function recordAgentModelNetworkTelemetry(event: ZCodeSessionEvent): void {
  const observation = agentModelNetworkObservationFromEvent(event);
  if (!observation) {
    return;
  }
  try {
    emitNetworkTelemetryObservation(observation);
  } catch (error) {
    // Fix: agent model-network telemetry is a side-channel metric; sink errors must not
    // touch the main message stream.
    logger.warn(undefined, "Agent model network telemetry emit failed", error);
  }
}

function agentModelNetworkObservationFromEvent(
  event: ZCodeSessionEvent,
): NetworkObservation | null {
  const payload = asRecord(event.payload);
  const type = stringValue(payload.type);
  if (type !== "model_request_completed" && type !== "model_request_failed") {
    return null;
  }
  // Fix: a retryable failure is an intermediate attempt of one logical request; the final
  // completed/failed carries the total attempt. Counting here would inflate success, failure,
  // and retry rates together.
  if (type === "model_request_failed" && booleanValue(payload.retryable) === true) {
    return null;
  }

  const durationMs = Math.max(0, Math.round(numberValue(payload.durationMs) ?? 0));
  const statusCode = nonNegativeIntegerValue(payload.statusCode);
  const ok = type === "model_request_completed";
  return {
    transport: "http",
    interface: buildAgentModelNetworkInterface(payload),
    durationMs,
    ok,
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(ok ? {} : { errorKind: classifyAgentModelNetworkError(payload, statusCode) }),
    attempt: positiveIntegerValue(payload.attempt) ?? 1,
  };
}

function buildAgentModelNetworkInterface(payload: Record<string, unknown>): string {
  const providerKind = safeNetworkDimension(stringValue(payload.providerKind)) ?? "unknown";
  const transport = safeNetworkDimension(stringValue(payload.transport)) ?? "unknown";
  const base = normalizeAgentModelBaseUrl(stringValue(payload.baseURL));
  return `zcode_agent.model.${providerKind}.${transport}.${base}`;
}

function normalizeAgentModelBaseUrl(value: string | undefined): string {
  if (!value) {
    return "unknown";
  }
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
    const safePath = pathname.length > 80 ? `${pathname.slice(0, 80)}...` : pathname;
    return `${parsed.host}${safePath}`;
  } catch {
    return safeNetworkDimension(value, 120) ?? "unknown";
  }
}

function safeNetworkDimension(value: string | undefined, maxLength = 48): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const safe = trimmed.replace(/[?#[\]{}|\\^`"'<>\s]+/gu, "_");
  return safe.length > maxLength ? `${safe.slice(0, maxLength)}...` : safe;
}

function classifyAgentModelNetworkError(
  payload: Record<string, unknown>,
  statusCode: number | undefined,
): string {
  const reason = stringValue(payload.reason);
  switch (reason) {
    case "timeout":
    case "stream_idle_timeout":
      return "timeout";
    case "network_error":
    case "stale_connection":
      return "connection_reset";
    case "proxy_error":
      return "proxy_error";
    case "tls_error":
      return "tls_error";
    default:
      if (statusCode !== undefined && statusCode >= 500) {
        return "server_error";
      }
      if (statusCode !== undefined && statusCode >= 400) {
        return "client_error";
      }
      return "other";
  }
}

type ContextUsageUpdate = Pick<
  Extract<ZCodeStreamEvent, { type: "usage_update" }>,
  "used" | "size" | "cost" | "cache" | "breakdown"
>;

function contextUsageFromProjection(
  projection: ZCodeSessionStateSnapshot["projection"],
): ContextUsageUpdate | null {
  if (projection.contextWindow <= 0 || projection.contextUsed <= 0) {
    return null;
  }
  return {
    used: projection.contextUsed,
    size: projection.contextWindow,
    cost: null,
  };
}

function contextUsageFromRuntime(
  runtimeUsage: ZCodeSessionStateSnapshot["runtime"]["contextUsage"] | undefined,
): ContextUsageUpdate | null {
  if (!runtimeUsage || runtimeUsage.size <= 0 || runtimeUsage.used <= 0) {
    return null;
  }
  // On session resume the protocol projection may not have replayed main-turn usage yet;
  // runtime.contextUsage comes from persisted assistant token records and wins for restore.
  return {
    used: runtimeUsage.used,
    size: runtimeUsage.size,
    cost: runtimeUsage.cost ?? null,
    ...(runtimeUsage.cache ? { cache: runtimeUsage.cache } : {}),
    ...(runtimeUsage.breakdown ? { breakdown: runtimeUsage.breakdown } : {}),
  };
}

function contextUsageFromPayload(payload: Record<string, unknown>): ContextUsageUpdate | null {
  const projection = asRecord(payload.projection);
  const usage = asRecord(payload.usage);
  const size = numberValue(payload.contextWindow ?? projection.contextWindow);
  const explicitUsed = numberValue(payload.contextUsed ?? projection.contextUsed);
  const useModelUsageForContext = shouldUseModelUsageForContext(payload);
  const modelUsageUsed = useModelUsageForContext ? contextUsageTokensFromPayload(usage) : undefined;
  const used =
    modelUsageUsed ??
    // When the main turn returns usage, the real network tokens win: the context window is
    // shared by input + output, so the meter can no longer render inputTokens alone.
    // projection.contextUsed is the runtime estimate/restore fallback, used only when usage
    // is missing.
    explicitUsed;
  if (size === undefined || size <= 0) {
    return null;
  }
  // In ZCode Protocol session.updated, contextUsed/contextWindow are the projection truth; the
  // legacy task stream only knows usage_update, so without this conversion the corner context
  // meter never receives data. used=0 is init/degenerate fallback, not a renderable meter.
  if (used === undefined || used <= 0) {
    return null;
  }
  return {
    used,
    size,
    cost: null,
    ...(useModelUsageForContext ? optionalContextCacheUsageFromPayload(payload, usage) : {}),
    ...(useModelUsageForContext ? optionalContextUsageBreakdownFromPayload(payload) : {}),
  };
}

function optionalContextUsageBreakdownFromPayload(
  payload: Record<string, unknown>,
): Pick<ContextUsageUpdate, "breakdown"> {
  const parsed = zcodeContextUsageBreakdownSchema.safeParse(payload.contextUsageBreakdown);
  return parsed.success && parsed.data.length > 0 ? { breakdown: parsed.data } : {};
}

function contextUsageTokensFromPayload(usage: Record<string, unknown>): number | undefined {
  const inputTokens = positiveIntegerValue(usage.inputTokens ?? usage.input);
  if (inputTokens !== undefined) {
    // AI SDK v6 folds Anthropic cache read/write into inputTokens; the adapter adds output
    // only. Adding cacheReadTokens too would overstate the input-bar context meter.
    return inputTokens + (nonNegativeIntegerValue(usage.outputTokens ?? usage.output) ?? 0);
  }

  const totalTokens = positiveIntegerValue(usage.totalTokens ?? usage.total);
  if (totalTokens !== undefined) {
    return totalTokens;
  }

  const cacheTokens =
    (nonNegativeIntegerValue(usage.cachedReadTokens ?? usage.cacheReadTokens) ?? 0) +
    (nonNegativeIntegerValue(usage.cachedWriteTokens ?? usage.cacheWriteTokens) ?? 0);
  return cacheTokens > 0
    ? cacheTokens + (nonNegativeIntegerValue(usage.outputTokens ?? usage.output) ?? 0)
    : undefined;
}

function optionalContextCacheUsageFromPayload(
  payload: Record<string, unknown>,
  usage: Record<string, unknown>,
): Pick<ContextUsageUpdate, "cache"> {
  const cache = contextCacheUsageFromPayload(payload, usage);
  return cache ? { cache } : {};
}

function shouldUseModelUsageForContext(payload: Record<string, unknown>): boolean {
  const querySource = stringValue(payload.querySource);
  // Only main-turn model inputTokens reflect the visible context; sidecar requests (title,
  // compaction, prompt enhance) must not override the input-bar meter even with a contextWindow.
  return querySource === undefined || querySource === "main_turn";
}

function contextCacheUsageFromPayload(
  payload: Record<string, unknown>,
  usage: Record<string, unknown>,
): ContextUsageUpdate["cache"] {
  const aggregate = asRecord(payload.cacheHit);
  if (Object.keys(aggregate).length > 0) {
    const inputTokens = nonNegativeIntegerValue(aggregate.inputTokens) ?? 0;
    const cacheReadTokens = nonNegativeIntegerValue(aggregate.cacheReadTokens) ?? 0;
    const cacheWriteTokens = nonNegativeIntegerValue(aggregate.cacheWriteTokens) ?? 0;
    const latestHitRate = numberValue(aggregate.latestHitRate);
    const hitRate = numberValue(aggregate.hitRate);
    const hitRateRequestCount = nonNegativeIntegerValue(aggregate.hitRateRequestCount);
    const totalInputTokens = nonNegativeIntegerValue(aggregate.totalInputTokens);
    const totalCacheReadTokens = nonNegativeIntegerValue(aggregate.totalCacheReadTokens);
    const totalCacheWriteTokens = nonNegativeIntegerValue(aggregate.totalCacheWriteTokens);
    return {
      inputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      ...(latestHitRate !== undefined ? { latestHitRate: Math.max(0, latestHitRate) } : {}),
      ...(hitRateRequestCount !== undefined ? { hitRateRequestCount } : {}),
      ...(totalInputTokens !== undefined ? { totalInputTokens } : {}),
      ...(totalCacheReadTokens !== undefined ? { totalCacheReadTokens } : {}),
      ...(totalCacheWriteTokens !== undefined ? { totalCacheWriteTokens } : {}),
      hitRate: hitRate !== undefined ? Math.max(0, hitRate) : null,
    };
  }

  const hasCacheRead = "cachedReadTokens" in usage || "cacheReadTokens" in usage;
  const hasCacheWrite = "cachedWriteTokens" in usage || "cacheWriteTokens" in usage;
  const hasHitRate = "cacheHitRate" in usage || "hitRate" in usage;
  if (!hasCacheRead && !hasCacheWrite && !hasHitRate) {
    return undefined;
  }
  const inputTokens = nonNegativeIntegerValue(usage.inputTokens ?? usage.input) ?? 0;
  const cacheReadTokens =
    nonNegativeIntegerValue(usage.cachedReadTokens ?? usage.cacheReadTokens) ?? 0;
  const cacheWriteTokens =
    nonNegativeIntegerValue(usage.cachedWriteTokens ?? usage.cacheWriteTokens) ?? 0;
  const explicitHitRate = numberValue(usage.cacheHitRate ?? usage.hitRate);
  return {
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    latestHitRate:
      explicitHitRate !== undefined
        ? Math.max(0, explicitHitRate)
        : inputTokens > 0
          ? cacheReadTokens / inputTokens
          : null,
    // The UI shows the hit rate returned by the agent/app protocol; when the provider omits
    // it, normalize once here from provider usage instead of every UI entry re-parsing tokens.
    hitRate:
      explicitHitRate !== undefined
        ? Math.max(0, explicitHitRate)
        : inputTokens > 0
          ? cacheReadTokens / inputTokens
          : null,
  };
}

function usageFromPayload(value: unknown): ZCodeUsage | undefined {
  const usage = asRecord(value);
  if (Object.keys(usage).length === 0) {
    return undefined;
  }
  const inputTokens = numberValue(usage.inputTokens ?? usage.input) ?? 0;
  const outputTokens = numberValue(usage.outputTokens ?? usage.output) ?? 0;
  const reasoningTokens = numberValue(usage.reasoningTokens ?? usage.reasoning);
  const cachedInputTokens = numberValue(usage.cachedReadTokens ?? usage.cacheReadTokens);
  const cachedWriteInputTokens = numberValue(usage.cachedWriteTokens ?? usage.cacheWriteTokens);
  const inputSideTokens =
    inputTokens > 0 ? inputTokens : (cachedInputTokens ?? 0) + (cachedWriteInputTokens ?? 0);
  const totalTokens =
    numberValue(usage.totalTokens ?? usage.total) ?? inputSideTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    reasoningTokens,
    cachedInputTokens,
    cachedWriteInputTokens,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isAskUserQuestionToolName(value: string | undefined): boolean {
  return value === ASK_USER_QUESTION_TOOL_NAME;
}

function isExitPlanModeToolName(value: string | undefined): boolean {
  return value === EXIT_PLAN_MODE_TOOL_NAME;
}

function isUserInputBackedPermissionToolName(value: string | undefined): boolean {
  return isAskUserQuestionToolName(value) || isExitPlanModeToolName(value);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonNegativeIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function positiveIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function timelineStatusValue(value: unknown): ZCodeTimelineStatus | undefined {
  return value === "started" ||
    value === "retrying" ||
    value === "skipped" ||
    value === "completed" ||
    value === "failed" ||
    value === "interrupted"
    ? value
    : undefined;
}

function timelineTriggerValue(value: unknown): ZCodeTimelineTrigger | undefined {
  return value === "manual" ||
    value === "auto" ||
    value === "reactive" ||
    value === "partial" ||
    value === "session_memory"
    ? value
    : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function turnSteerSourceValue(value: unknown): ZCodeTurnSteerSource | undefined {
  return value === "plan_approval_feedback" || value === "workflow_refine_feedback"
    ? value
    : undefined;
}

function turnSteerCommandKindValue(value: unknown): ZCodeTurnSteerCommandKind | undefined {
  return value === "sendGoalCommand" || value === "sendText" || value === "compact"
    ? value
    : undefined;
}
