/* oxlint-disable eslint(max-lines) - the ZCode-session-to-chat projection bridge must keep snapshot and event mappings in sync. */
import {
  getZCodeAgentAvailableModes as getSharedAgentAvailableModes,
  normalizeAvailableZCodeMode,
  coalesceConsecutiveZCodeAssistants,
  extractPlanStepsFromToolInput,
  extractPlanStepsFromToolOutput,
  decodeCustomModelValue,
  deriveZCodeTaskStatusFromSessionSnapshot,
  generateTraceId,
  getConversationMessageProjectionPolicy,
  getZCodeGoalActiveIterationCount,
  getZCodeGoalIterationByAssistantMessageId,
  getZCodeUserVisibleMessages,
  isMainAgentToolProjectionSource,
  isZCodeGoalContinuationReminderMessage,
  normalizeZCodeApiRetryStatus,
  attachZCodeBackgroundTaskNotificationToRaw,
  collectZCodeBackgroundTaskNotificationsByToolUseId,
  mergeZCodeBackgroundTaskControlItems,
  parseZCodeBackgroundTaskControlItems,
  parseZCodeBackgroundTaskNotificationText,
  parseModelPickerValue as parseSharedModelSelection,
  formatModelPickerValue as formatSharedModelSelection,
  resolveZCodeVisibleSessionTitle,
  textFromZCodeMessageParts,
  ZCODE_AGENT_PROVIDER,
  zcodeBackgroundTaskNotificationToolUpdateStatus,
  appendZCodeStreamingToolInputDelta,
  buildZCodeStreamingToolInputPreview,
  createZCodeToolProjectionMemory,
  ensureZCodeToolProjectionMemory,
  finalizeZCodeToolProjectionInput,
  forgetZCodeToolProjectionMetadata,
  isZCodeModelRetryRecoveryProgressPayload,
  markZCodeStreamingToolInputPreviewMaterialized,
  resolveZCodeToolProjectionMetadata,
  shouldMaterializeZCodeStreamingToolInputPreview,
  zcodeApiRetryFromModelNetworkStatusPayload,
  zcodeApiRetryFromStreamRecoveryPayload,
  zcodeTaskNetworkDebugStatusFromPayload,
  type ZCodeApiRetryStatus,
  type ZCodeBackgroundTaskNotificationInfo,
  type ZCodeBackgroundTaskControlItem,
  type ZCodeConfigOption,
  type ZCodePersistedMessage,
  type ZCodePersistedMessagePart,
  type ZCodePersistedToolCall,
  type ZCodeTaskGoal,
  type ZCodeTaskGoalStats,
  type ZCodeTaskTargetChangedAction,
  type ZCodeTaskMode,
  type ZCodeTaskModeInfo,
  type ZCodeStreamEvent,
  type ZCodeTaskMeta,
  type ZCodeTaskSnapshot,
  type ZCodeTodoGroup,
  type ZCodeTurnSteerCommandKind,
  type ZCodeTurnSteerSource,
  type ZCodePlanStep,
  type ZCodePromptAttachment,
  type ZCodeUsage,
  type InputId,
  type TraceId,
  type ZCodeMessagePart,
  type ZCodeMessageWithParts,
  type ModelSelection,
  type ZCodePermissionOption,
  type ZCodePermissionRequest,
  type ZCodePermissionRequestParams,
  type ZCodeSessionEvent,
  type ZCodeSessionMode,
  type ZCodeSessionSettingsState,
  type ZCodeSessionStateSnapshot,
  type ZCodeStateUpdatedNotification,
  type ZCodeContextCompactionTimelinePhase,
  type ZCodeContextCompactionTimelineMeta,
  type ZCodeGoalVerification,
  type ZCodeGoalVerificationTimelineMeta,
  type ZCodeTimelineMeta,
  type ZCodeTimelineStatus,
  type ZCodeTimelineTrigger,
  type ZCodeToolProjectionMemory,
  type ZCodeUserInputRequestParams,
  type ZCodeUserInputResponse,
  zcodeContextUsageBreakdownSchema,
} from "@zcode/shared";
import { errorAttributionSchema } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";

const MODEL_CONFIG_ID = "model";
const THOUGHT_LEVEL_CONFIG_ID = "thought_level";
const MODE_CONFIG_ID = "mode";
const ASK_USER_QUESTION_TOOL_NAME = "AskUserQuestion";
const EXIT_PLAN_MODE_TOOL_NAME = "ExitPlanMode";
const EXIT_PLAN_MODE_APPROVAL_QUESTION = "Review this implementation plan.";
const EXIT_PLAN_MODE_APPROVAL_APPROVE = "approve";
const STREAMING_TOOL_INPUT_INFO_LOG_LINE_BUCKET = 50;
const streamingToolInputProjectionLogBuckets = new Map<string, number>();
const COMPACTION_PROJECTION_DIAG_LIMIT = 200;
const compactionProjectionDiagSignatures = new Set<string>();
const ZCODE_AGENT_MODE_OPTIONS = getSharedAgentAvailableModes();

export interface ZCodeSessionEventProjectionState extends ZCodeToolProjectionMemory {
  activePromptInputIdBySession?: Map<string, InputId>;
  rewindControlTurnKeys?: Set<string>;
  activeApiRetrySessionIds?: Set<string>;
  backgroundTaskControlsBySession?: Map<string, ZCodeBackgroundTaskControlItem[]>;
  streamedTurnKeys?: Set<string>;
}

export function createZCodeSessionEventProjectionState(): ZCodeSessionEventProjectionState {
  return {
    ...createZCodeToolProjectionMemory(),
    activePromptInputIdBySession: new Map<string, InputId>(),
    activeApiRetrySessionIds: new Set<string>(),
    streamedTurnKeys: new Set<string>(),
  };
}

export type ZCodeSessionProjectionMode = "active-live" | "background-summary";

export function formatModelPickerValue(ref: ModelSelection | undefined): string {
  return formatSharedModelSelection(ref);
}

function resolveLatestMessageModelSelection(
  messages: readonly ZCodeMessageWithParts[],
): ModelSelection | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const model = messages[index]?.info.model;
    if (model) {
      return model;
    }
  }
  return undefined;
}

function resolveTaskMetaModelSelectionFromSnapshot(
  snapshot: ZCodeSessionStateSnapshot,
): ModelSelection | undefined {
  // When a historical resume was overwritten by a wrong runtimeModel, settings.current becomes the app's current default model,
  // but message info.model still records the model actually used. The task meta becomes the next cold-recovery hint,
  // so preferring the latest message model lets polluted history self-heal.
  return resolveLatestMessageModelSelection(snapshot.messages) ?? snapshot.settings.model.current;
}

export function parseModelPickerValue(value: string): ModelSelection {
  const customModel = decodeCustomModelValue(value);
  if (customModel?.providerId && customModel.modelName) {
    // A UI-custom model value is display-state custom:provider:model;
    // the ZCode Protocol must receive the strict providerId/modelId structure.
    return {
      providerId: customModel.providerId,
      modelId: customModel.modelName,
    };
  }

  return parseSharedModelSelection(value);
}

export function toZCodeTaskMode(mode: ZCodeTaskMode | undefined): ZCodeSessionMode | undefined {
  switch (mode) {
    case "plan":
      return "plan";
    case "edit":
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

export function zcodeSessionSettingsToConfigOptions(
  settings: ZCodeSessionSettingsState,
): ZCodeConfigOption[] {
  const configOptions: ZCodeConfigOption[] = [
    {
      id: MODEL_CONFIG_ID,
      name: "Model",
      category: "model",
      type: "select",
      currentValue: formatModelPickerValue(settings.model.current),
      options: settings.model.available.map((model) => {
        const modelThoughtLevels = model.reasoning?.levels.map((level) => level.value);
        const modelDefaultThoughtLevel =
          model.reasoning?.defaultLevel &&
          modelThoughtLevels?.includes(model.reasoning.defaultLevel)
            ? model.reasoning.defaultLevel
            : undefined;
        return {
          value: formatModelPickerValue(model.ref),
          name: model.label,
          description: model.description,
          modelProviderId: model.ref.providerId,
          modelProviderName: model.providerLabel ?? model.ref.providerId,
          ...(modelThoughtLevels ? { modelThoughtLevels } : {}),
          ...(modelDefaultThoughtLevel ? { modelDefaultThoughtLevel } : {}),
        };
      }),
    },
    {
      id: MODE_CONFIG_ID,
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: normalizeAvailableZCodeMode(settings.mode.current),
      options: getZCodeAgentModeSelectOptions(),
    },
  ];
  if (settings.thoughtLevel.enabled) {
    configOptions.push({
      id: THOUGHT_LEVEL_CONFIG_ID,
      name: "Thought Level",
      category: "thought_level",
      type: "select",
      currentValue: resolveSettingsThoughtLevelCurrentValue(settings.thoughtLevel) ?? "",
      options: settings.thoughtLevel.available.map((level) => ({
        value: level.value,
        name: level.label,
        description: level.description,
      })),
    });
  }
  return configOptions;
}

export function zcodeWorkspacePresentationToConfigOptions(
  mode: ZCodeSessionMode,
): ZCodeConfigOption[] {
  return [
    {
      id: MODE_CONFIG_ID,
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: normalizeAvailableZCodeMode(mode),
      options: getZCodeAgentModeSelectOptions(),
    },
  ];
}

function resolveSettingsThoughtLevelCurrentValue(
  thoughtLevel: ZCodeSessionSettingsState["thoughtLevel"],
): string | undefined {
  const thoughtLevelValues = new Set(thoughtLevel.available.map((level) => level.value));
  const currentThoughtLevel =
    thoughtLevel.current && thoughtLevelValues.has(thoughtLevel.current)
      ? thoughtLevel.current
      : undefined;
  const defaultThoughtLevel =
    thoughtLevel.defaultLevel && thoughtLevelValues.has(thoughtLevel.defaultLevel)
      ? thoughtLevel.defaultLevel
      : undefined;
  // The ZCode Protocol defaultLevel is model fact; empty current means the user never explicitly changed it.
  // Live model-status events must project the default too, or the toolbar gets an empty currentValue - a UI with no level selected.
  return currentThoughtLevel ?? defaultThoughtLevel ?? thoughtLevel.available[0]?.value;
}

export function zcodeSessionSnapshotToZCodeTaskSnapshot(
  snapshot: ZCodeSessionStateSnapshot,
): ZCodeTaskSnapshot {
  const meta = zcodeSessionSnapshotToTaskMeta(snapshot);
  const activeGoalIterationCount = getSnapshotGoalActiveIterationCount(snapshot);
  const goalIterationByAssistantMessageId = getZCodeGoalIterationByAssistantMessageId(
    snapshot.messages,
    {
      ...(activeGoalIterationCount > 0 ? { maxGoalIteration: activeGoalIterationCount } : {}),
      target: snapshot.projection.target,
    },
  );
  const visibleMessages = getZCodeUserVisibleMessages(snapshot.messages, {
    target: snapshot.projection.target,
  });
  const backgroundTaskNotifications = collectZCodeBackgroundTaskNotificationsByToolUseId(
    snapshot.messages,
  );
  if (snapshot.projection.target) {
    const assistantGoalIterations = [...goalIterationByAssistantMessageId.values()];
    const goalIterationCounts = assistantGoalIterations.reduce<Record<string, number>>(
      (counts, iteration) => ({
        ...counts,
        [String(iteration)]: (counts[String(iteration)] ?? 0) + 1,
      }),
      {},
    );
    logger.debug("[goalIterationDiag] snapshot projection", {
      assistantGoalIterations: goalIterationCounts,
      goalContinuationReminderUsers: snapshot.messages.filter(
        (message) =>
          message.info.role === "user" && isZCodeGoalContinuationReminderMessage(message),
      ).length,
      goalStatsIteration: snapshot.goalStats?.iterationCount ?? null,
      rawMessages: snapshot.messages.length,
      sessionId: snapshot.session.sessionId,
      snapshotEventSeq: snapshot.runtime.eventSeq,
      targetId: snapshot.projection.target.targetId,
      visibleMessages: visibleMessages.length,
    });
  }
  const messages = normalizeGoalVerificationTimelineMessageOrder(
    addSessionForkSnapshotFallback(
      addGoalVerificationTimelineSnapshotFallback(
        addGoalObjectiveSnapshotFallback(
          restoreGoalCommandUserMessages(
            coalesceConsecutiveZCodeAssistants(
              visibleMessages.map((message) =>
                zcodeMessageToZCodePersistedMessage(
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
        snapshot,
      ),
      snapshot,
    ),
  );
  logCompactionProjectionDiagnostic(snapshot, visibleMessages, messages);
  const pendingPermissions: ZCodePermissionRequest[] = snapshot.projection.pendingPermissions
    .filter((permission) => !isUserInputBackedPermissionToolName(permission.toolName))
    .map((permission) => pendingPermissionToStreamEvent(snapshot.session.sessionId, permission));
  return {
    meta,
    messages,
    fileChanges: [],
    configOptions: zcodeSessionSettingsToConfigOptions(snapshot.settings),
    // Bugfix: session/read already returns `/compact` and other slashCommands via the protocol.
    // Historical task restore consumes the task snapshot projected here; without pass-through the store backfill gets an empty list.
    slashCommands: snapshot.slashCommands ?? [],
    runtime: {
      activeTurnKind: snapshot.runtime.activeTurnKind,
      apiRetry: snapshot.runtime.apiRetry ?? null,
      contextUsage:
        contextUsageFromRuntime(snapshot.runtime.contextUsage) ??
        contextUsageFromProjection(snapshot.projection) ??
        undefined,
      pendingPermissions,
      backgroundBashJobs: parseZCodeBackgroundTaskControlItems(snapshot.projection.backgroundJobs),
      pendingElicitations: snapshot.projection.pendingPermissions
        .filter((permission) => isUserInputBackedPermissionToolName(permission.toolName))
        .map((permission) =>
          pendingUserInputBackedPermissionToElicitationEvent(
            snapshot.session.sessionId,
            permission,
          ),
        )
        .filter(
          (event): event is Extract<ZCodeStreamEvent, { type: "elicitation_request" }> =>
            event !== null,
        ),
      // Bugfix: agent session restore reads todos from the DB; the UI todo panel can no longer rely only on
      // in-memory renderer plan events, or persisted todos vanish for history-opened sessions.
      plan: sessionTodosToPlanSteps(snapshot.todos),
      goalStats: sessionGoalStatsToRuntime(snapshot.goalStats),
      goalVerifications: snapshot.runtime.goalVerifications ?? null,
      goalVerificationTimeline: snapshot.runtime.goalVerificationTimeline ?? null,
      todoGroups: sessionTodoGroupsToRuntime(snapshot.todoGroups),
    },
  };
}

function hasProtocolCompactionPart(message: ZCodeMessageWithParts): boolean {
  return message.parts.some((part) => part.type === "compaction");
}

function protocolMessageTimelineStatus(message: ZCodeMessageWithParts) {
  for (const part of message.parts) {
    if (part.type !== "compaction") {
      continue;
    }
    const metadata = asRecord(part.metadata);
    return {
      auto: part.auto,
      operationId: stringValue(metadata.operationId) ?? part.partId,
      phase: stringValue(metadata.phase),
      status: stringValue(metadata.timelineStatus),
      summaryMessageId: part.summaryMessageId ?? stringValue(metadata.summaryMessageId),
    };
  }
  return null;
}

function summarizeProtocolMessageForTimelineDiag(message: ZCodeMessageWithParts, index: number) {
  return {
    index,
    id: message.info.messageId,
    role: message.info.role,
    created: message.info.time.created,
    completed: message.info.time.completed,
    partTypes: message.parts.map((part) => part.type),
    textLength: textFromZCodeMessageParts(message.parts).length,
    compaction: protocolMessageTimelineStatus(message),
  };
}

function summarizePersistedMessageForTimelineDiag(message: ZCodePersistedMessage, index: number) {
  const timeline = message.syntheticTimeline;
  return {
    index,
    id: message.id ?? null,
    role: message.role,
    timestamp: message.timestamp,
    contentLength: message.content.length,
    thoughtLength: message.role === "assistant" ? (message.thought?.length ?? 0) : 0,
    partTypes: message.role === "assistant" ? (message.parts?.map((part) => part.type) ?? []) : [],
    timeline:
      timeline?.type === "context_compaction"
        ? {
            type: timeline.type,
            operationId: timeline.operationId,
            status: timeline.status,
            trigger: timeline.trigger,
            phase: timeline.phase,
            inputId: timeline.inputId,
            summaryMessageId: timeline.summaryMessageId,
          }
        : timeline
          ? { type: timeline.type }
          : null,
  };
}

function lastTimelineDiagItems<T>(
  items: readonly T[],
  mapItem: (item: T, index: number) => unknown,
) {
  const start = Math.max(0, items.length - 12);
  return items.slice(start).map((item, offset) => mapItem(item, start + offset));
}

function rememberCompactionProjectionDiagSignature(signature: string): boolean {
  if (compactionProjectionDiagSignatures.has(signature)) {
    return false;
  }
  compactionProjectionDiagSignatures.add(signature);
  if (compactionProjectionDiagSignatures.size > COMPACTION_PROJECTION_DIAG_LIMIT) {
    compactionProjectionDiagSignatures.clear();
    compactionProjectionDiagSignatures.add(signature);
  }
  return true;
}

function logCompactionProjectionDiagnostic(
  snapshot: ZCodeSessionStateSnapshot,
  visibleMessages: readonly ZCodeMessageWithParts[],
  projectedMessages: readonly ZCodePersistedMessage[],
) {
  const hasCompaction =
    snapshot.messages.some(hasProtocolCompactionPart) ||
    projectedMessages.some((message) => message.syntheticTimeline?.type === "context_compaction");
  if (!hasCompaction) {
    return;
  }

  const projectedTailSignature = projectedMessages
    .slice(-8)
    .map((message) => {
      const timeline = message.syntheticTimeline;
      return [
        message.id ?? "",
        message.role,
        message.content.length,
        timeline?.type ?? "",
        timeline?.type === "context_compaction" ? timeline.status : "",
      ].join(":");
    })
    .join("|");
  const signature = [
    snapshot.session.sessionId,
    snapshot.runtime.eventSeq ?? "no-seq",
    snapshot.session.updatedAt,
    projectedTailSignature,
  ].join("#");
  if (!rememberCompactionProjectionDiagSignature(signature)) {
    return;
  }

  // Debugging note: after auto compact the DB had assistant messages the GUI did not show.
  // Log only message identity/length/timeline metadata -- never user body text -- in the UI log.
  logger.info("[conversationSessionTimelineDiag] projection compact snapshot", {
    sessionId: snapshot.session.sessionId,
    status: snapshot.session.status,
    eventSeq: snapshot.runtime.eventSeq ?? null,
    rawCount: snapshot.messages.length,
    visibleCount: visibleMessages.length,
    projectedCount: projectedMessages.length,
    rawTail: lastTimelineDiagItems(snapshot.messages, summarizeProtocolMessageForTimelineDiag),
    visibleTail: lastTimelineDiagItems(visibleMessages, summarizeProtocolMessageForTimelineDiag),
    projectedTail: lastTimelineDiagItems(
      projectedMessages,
      summarizePersistedMessageForTimelineDiag,
    ),
  });
}

function restoreGoalCommandUserMessages(
  messages: ZCodePersistedMessage[],
  snapshot: ZCodeSessionStateSnapshot,
): ZCodePersistedMessage[] {
  const target = snapshot.projection.target;
  const objective = target?.objective.trim();
  if (!target || !objective) {
    return messages;
  }

  let changed = false;
  const restored = messages.map((message) => {
    if (
      message.role !== "user" ||
      message.timestamp !== target.createdAt ||
      message.content.trim() !== objective
    ) {
      return message;
    }

    changed = true;
    return {
      ...message,
      // Bugfix: a /goal set agent snapshot already persists a visible user message,
      // but the body keeps only the objective. Restore the command prefix by target creation time so the first query keeps its /goal.
      content: `/goal ${objective}`,
    };
  });

  return changed ? restored : messages;
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

function addGoalObjectiveSnapshotFallback(
  messages: ZCodePersistedMessage[],
  snapshot: ZCodeSessionStateSnapshot,
): ZCodePersistedMessage[] {
  const objective = snapshot.projection.target?.objective.trim();
  if (
    !objective ||
    messages.some((message) => message.role === "user") ||
    !snapshot.messages.some(isZCodeGoalContinuationReminderMessage)
  ) {
    return messages;
  }

  const continuationMessage = snapshot.messages.find(isZCodeGoalContinuationReminderMessage);
  // Bugfix: /goal continuations wrap the goal in a model-only system-reminder; shared-visible filtering hides the inner XML correctly.
  // But history restore without the original user turn leaves only the assistant reply; re-add the command form the user actually typed
  // so the slimmed first query keeps its /goal context.
  return [
    {
      role: "user",
      content: `/goal ${objective}`,
      timestamp:
        continuationMessage?.info.time.created ??
        snapshot.projection.target?.createdAt ??
        snapshot.session.createdAt,
      model: formatModelPickerValue(snapshot.settings.model.current),
    },
    ...messages,
  ];
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
      // Bugfix: legacy plain-conversation forks never persisted a synthetic notice; recover a non-navigable divider from
      // session.parentSessionId so historical forks are not blind to their origin boundary.
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
      // Fix: the goal-verifier lifecycle is persisted agent event-store fact, not message history;
      // on snapshot restore rebuild boundary dividers from target+iteration and anchor, or one turn's checks duplicate or drift into the next.
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
  // Fix: a persisted goal-verifier divider can land after the next
  // user query; snapshot projection must re-anchor it, not just patch the fallback divider.
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

export function zcodeSessionSnapshotToTaskMeta(snapshot: ZCodeSessionStateSnapshot): ZCodeTaskMeta {
  return {
    taskId: snapshot.session.sessionId,
    traceId: generateTraceId(snapshot.session.sessionId),
    title: deriveTitleFromSnapshot(snapshot),
    workspacePath: snapshot.session.workspace.workspacePath,
    workspaceIdentity: snapshot.session.workspace.workspaceIdentity,
    createdAt: snapshot.session.createdAt,
    updatedAt: snapshot.session.updatedAt,
    mode: fromZCodeMode(snapshot.session.mode),
    model: formatModelPickerValue(resolveTaskMetaModelSelectionFromSnapshot(snapshot)),
    thoughtLevel: snapshot.settings.thoughtLevel.current,
    provider: ZCODE_AGENT_PROVIDER,
    status: deriveZCodeTaskStatusFromSessionSnapshot(snapshot),
    lastError: snapshot.projection.lastError
      ? {
          code: snapshot.projection.lastError.code ?? snapshot.projection.lastError.type,
          ...(snapshot.projection.lastError.detail
            ? { detail: snapshot.projection.lastError.detail }
            : {}),
          ...(snapshot.projection.lastError.attribution
            ? { attribution: snapshot.projection.lastError.attribution }
            : {}),
          message: snapshot.projection.lastError.message,
        }
      : undefined,
    target: snapshot.projection.target
      ? fromZCodeGoal(snapshot.projection.target)
      : snapshot.projection.target,
  };
}

export function zcodeSessionEventToZCodeStreamEvents(params: {
  event: ZCodeSessionEvent;
  projectionMode?: ZCodeSessionProjectionMode;
  state?: ZCodeSessionEventProjectionState;
  taskId: string;
}): ZCodeStreamEvent[] {
  const { event, state, taskId, projectionMode = "active-live" } = params;
  const protocolTraceId = event.traceId ?? generateTraceId(taskId);
  const payload = asRecord(event.payload);
  const inputId = stringValue(payload.inputId);
  const queryId = stringValue(payload.queryId);
  const activePromptInputId = getActivePromptInputId(state, event.sessionId);
  const toolProjectionMemory = ensureProjectionToolMemory(state);
  const toolNameById = toolProjectionMemory?.toolNameById;
  // Fix: the UI-facing traceId identifies one input-to-reply turn.
  // The runtime trace is fallback-only when no inputId exists, keeping a turn's chunks/tools/complete in one group.
  const eventInputId = inputId ?? activePromptInputId;
  const traceId = eventInputId ?? protocolTraceId;
  const turnKey = `${event.sessionId}:${event.turnId ?? eventInputId ?? traceId}`;

  if (event.type === "turn.started") {
    state?.streamedTurnKeys?.delete(turnKey);
    rememberRewindControlTurn(state, turnKey, stringValue(payload.input));
    if (inputId) {
      setActivePromptInputId(state, event.sessionId, inputId);
    }
    const runStartedEvent: ZCodeStreamEvent = {
      type: "task_run_started",
      taskId,
      traceId,
      ...(eventInputId ? { inputId: eventInputId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
      startedAt: event.timestamp,
    };
    const taskNotificationToolUpdate = backgroundTaskNotificationToolUpdateFromInput({
      input: stringValue(payload.input),
      taskId,
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
          taskId,
          traceId,
          ...(eventInputId ? { inputId: eventInputId } : {}),
          ...(event.turnId ? { turnId: event.turnId } : {}),
          ...(stringValue(payload.targetId) ? { targetId: stringValue(payload.targetId) } : {}),
          startedAt: event.timestamp,
        },
      ];
    }
    return [runStartedEvent];
  }

  const compactTimeline = mapCompactTimelinePayload(taskId, traceId, eventInputId, payload);
  if (compactTimeline) {
    state?.streamedTurnKeys?.add(turnKey);
    return [compactTimeline];
  }

  const partTimeline = mapSyntheticTimelinePartPayload(taskId, traceId, eventInputId, payload);
  if (partTimeline) {
    state?.streamedTurnKeys?.add(turnKey);
    return [partTimeline];
  }

  const goalVerificationTimeline = mapGoalVerificationTimelinePayload(
    taskId,
    traceId,
    eventInputId,
    event.timestamp,
    payload,
  );
  if (goalVerificationTimeline) {
    state?.streamedTurnKeys?.add(turnKey);
    return [goalVerificationTimeline];
  }

  const modelStreaming = mapModelStreaming(
    taskId,
    traceId,
    eventInputId,
    payload,
    toolProjectionMemory,
    projectionMode,
  );
  const apiRetryClearEvent = takeProjectionApiRetryClearOnModelProgress(
    state,
    event.sessionId,
    taskId,
    traceId,
    eventInputId,
    payload,
  );
  if (modelStreaming) {
    if (modelStreaming.type === "agent_message_chunk") {
      state?.streamedTurnKeys?.add(turnKey);
    }
    return apiRetryClearEvent ? [apiRetryClearEvent, modelStreaming] : [modelStreaming];
  }
  if (apiRetryClearEvent) {
    return [apiRetryClearEvent];
  }

  switch (event.type) {
    case "tool.updated":
      return mapToolUpdated(taskId, traceId, eventInputId, payload, toolProjectionMemory);
    case "permission.requested":
      if (stringValue(payload.toolCallId) && stringValue(payload.toolName)) {
        toolNameById?.set(
          stringValue(payload.toolCallId) ?? "",
          stringValue(payload.toolName) ?? "",
        );
      }
      if (isUserInputBackedPermissionToolName(stringValue(payload.toolName))) {
        // Fix: AskUserQuestion/ExitPlanMode permission.requested is only a runtime wait state;
        // the real question arrives as elicitation_request via interaction/requestUserInput.
        return [];
      }
      return [permissionPayloadToStreamEvent(taskId, traceId, eventInputId, payload)];
    case "permission.resolved":
      return permissionResolvedPayloadToStreamEvents(
        taskId,
        traceId,
        eventInputId,
        payload,
        toolNameById,
      );
    case "turn.steerQueued": {
      // Fix: desktop-continuous raw session events bypass the service adapter;
      // dropping source here projects an ExitPlanMode approval as a plain manual steer.
      const source = turnSteerSourceValue(payload.source);
      return [
        {
          type: "turn_steer_queued",
          taskId,
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
    case "turn.steerDrained": {
      return [
        {
          type: "turn_steer_status",
          taskId,
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
    case "turn.completed": {
      const events: ZCodeStreamEvent[] = [];
      const response = stringValue(payload.response);
      const isRewindControlTurn = state?.rewindControlTurnKeys?.has(turnKey) ?? false;
      if (response && !isRewindControlTurn && !state?.streamedTurnKeys?.has(turnKey)) {
        events.push({
          type: "agent_message_chunk",
          taskId,
          traceId,
          ...(eventInputId ? { inputId: eventInputId } : {}),
          content: response,
        });
      }
      events.push({
        type: "task_complete",
        taskId,
        traceId,
        ...(eventInputId ? { inputId: eventInputId } : {}),
        stopReason: stringValue(payload.resultType) ?? "complete",
        usage: usageFromPayload(payload.usage),
      });
      state?.streamingToolInputById?.clear();
      state?.rewindControlTurnKeys?.delete(turnKey);
      state?.streamedTurnKeys?.delete(turnKey);
      clearProjectionApiRetryState(state, event.sessionId);
      if (eventInputId) {
        clearActivePromptInputId(state, event.sessionId, eventInputId);
      }
      return events;
    }
    case "turn.failed": {
      state?.streamingToolInputById?.clear();
      state?.rewindControlTurnKeys?.delete(turnKey);
      state?.streamedTurnKeys?.delete(turnKey);
      clearProjectionApiRetryState(state, event.sessionId);
      if (eventInputId) {
        clearActivePromptInputId(state, event.sessionId, eventInputId);
      }
      const errorPayload = asRecord(payload.error);
      if (stringValue(payload.turnPhase) === "compact") {
        return [
          compactFailureToTimelineEvent(
            taskId,
            traceId,
            eventInputId,
            stringValue(errorPayload.message) ?? "ZCode compact failed",
          ),
        ];
      }
      // Fix: the old turn.failed -> task_error projection kept copy/code/detail only, hiding adapter-confirmed
      // provider/network facts from live telemetry; pass through the safe attribution fields after validation.
      const attribution = errorAttributionSchema.safeParse(errorPayload.attribution);
      return [
        {
          type: "task_error",
          taskId,
          traceId,
          ...(eventInputId ? { inputId: eventInputId } : {}),
          error: stringValue(errorPayload.message) ?? "ZCode session failed",
          code: stringValue(errorPayload.code) ?? stringValue(errorPayload.type),
          detail: stringValue(errorPayload.detail),
          ...(attribution.success ? { attribution: attribution.data } : {}),
        },
      ];
    }
    case "session.titleUpdated": {
      const title = stringValue(payload.title);
      return title
        ? [
            {
              type: "session_info_update",
              taskId,
              traceId,
              ...(eventInputId ? { inputId: eventInputId } : {}),
              title,
            },
          ]
        : [];
    }
    case "session.updated":
      return trackProjectionApiRetryEvents(
        state,
        event.sessionId,
        mapSessionInfoLikePayload(taskId, traceId, eventInputId, event.eventId, payload, state),
      );
    case "streamRecovery.updated":
      // Fix: authoritative SSE-recovery progress arrives via streamRecovery.updated first.
      // Waiting for a later model_request_started leaves some sessions without the input retry count.
      return trackProjectionApiRetryEvents(
        state,
        event.sessionId,
        mapSessionInfoLikePayload(taskId, traceId, eventInputId, event.eventId, payload, state),
      );
    default:
      return [];
  }
}

function ensureProjectionToolMemory(
  state: ZCodeSessionEventProjectionState | undefined,
): ZCodeToolProjectionMemory | undefined {
  if (!state) {
    return undefined;
  }
  // Fix: foreground useTaskStreamEvents skipped initializing this Map, so Write input deltas
  // re-parsed from empty each time -- the UI showed only the first chunk and final tool_call, no live line growth.
  return ensureZCodeToolProjectionMemory(state);
}

function ensureProjectionApiRetrySessionIds(
  state: ZCodeSessionEventProjectionState | undefined,
): Set<string> | undefined {
  if (!state) {
    return undefined;
  }
  state.activeApiRetrySessionIds ??= new Set<string>();
  return state.activeApiRetrySessionIds;
}

function trackProjectionApiRetryEvents(
  state: ZCodeSessionEventProjectionState | undefined,
  sessionId: string,
  events: ZCodeStreamEvent[],
): ZCodeStreamEvent[] {
  const apiRetrySessionIds = ensureProjectionApiRetrySessionIds(state);
  if (!apiRetrySessionIds) {
    return events;
  }
  for (const event of events) {
    if (event.type === "session_info_update" && event.apiRetry !== undefined) {
      if (event.apiRetry) {
        apiRetrySessionIds.add(sessionId);
      } else {
        apiRetrySessionIds.delete(sessionId);
      }
    }
  }
  return events;
}

function clearProjectionApiRetryState(
  state: ZCodeSessionEventProjectionState | undefined,
  sessionId: string,
): void {
  state?.activeApiRetrySessionIds?.delete(sessionId);
}

function takeProjectionApiRetryClearOnModelProgress(
  state: ZCodeSessionEventProjectionState | undefined,
  sessionId: string,
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "session_info_update" }> | null {
  if (
    !state?.activeApiRetrySessionIds?.has(sessionId) ||
    !isZCodeModelRetryRecoveryProgressPayload(payload)
  ) {
    return null;
  }
  // Fix: a plain adapter retry's request_started only begins the retry; clearing then flickers the input bar --
  // clear only when the retry attempt produces model content, which is when the connection is user-visibly back.
  state.activeApiRetrySessionIds.delete(sessionId);
  return {
    type: "session_info_update",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    apiRetry: null,
  };
}

export function zcodeStateUpdatedToZCodeStreamEvents(params: {
  notification: ZCodeStateUpdatedNotification;
  settings: ZCodeSessionSettingsState;
  taskId: string;
}): ZCodeStreamEvent[] {
  const traceId = generateTraceId(params.taskId);
  return [
    {
      type: "mode_update",
      taskId: params.taskId,
      traceId,
      currentModeId: normalizeAvailableZCodeMode(params.settings.mode.current),
      availableModes: getZCodeAgentAvailableModes(),
    },
    {
      type: "glm_agent_model_state_update",
      taskId: params.taskId,
      traceId,
      version: 1,
      sessionId: params.taskId,
      reason:
        params.notification.reason === "thought_level_changed"
          ? "thought_level_changed"
          : params.notification.reason === "model_changed"
            ? "model_changed"
            : "session_initialized",
      model: {
        currentValue: formatModelPickerValue(params.settings.model.current),
      },
      thoughtLevel: {
        enabled: params.settings.thoughtLevel.enabled,
        currentValue: resolveSettingsThoughtLevelCurrentValue(params.settings.thoughtLevel),
        options: params.settings.thoughtLevel.available.map((option) => ({
          value: option.value,
          name: option.label,
        })),
      },
      contextWindow: {
        tokens:
          params.settings.model.available.find(
            (option) =>
              formatModelPickerValue(option.ref) ===
              formatModelPickerValue(params.settings.model.current),
          )?.contextWindow ?? 0,
      },
    },
  ];
}

export function zcodePermissionRequestToZCodeStreamEvent(
  taskId: string,
  request: ZCodePermissionRequestParams,
): ZCodeStreamEvent {
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

export function zcodeUserInputRequestToZCodeStreamEvent(
  taskId: string,
  request: ZCodeUserInputRequestParams,
): Extract<ZCodeStreamEvent, { type: "elicitation_request" }> {
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
    schema: request.schema ?? request.input,
  };
}

export function zcodeUserInputResponseToZCodeStreamEvent(
  taskId: string,
  response: {
    requestId: string;
    action: ZCodeUserInputResponse["action"];
    content?: Record<string, unknown>;
  },
): Extract<ZCodeStreamEvent, { type: "elicitation_response" }> {
  return {
    type: "elicitation_response",
    taskId,
    traceId: generateTraceId(taskId),
    requestId: response.requestId,
    action: response.action,
    ...(response.content ? { content: response.content } : {}),
  };
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
    // Fix: ToolLayout's failure hover reads toolCall.error only, while the notification
    // used to touch status/raw -- leaving nothing to show for the failure.
    ...(status === "failed" && parsed.notification.error
      ? { error: parsed.notification.error }
      : {}),
    raw: attachZCodeBackgroundTaskNotificationToRaw(
      { toolCallId: parsed.toolUseId },
      parsed.notification,
    ),
  };
}

function zcodeMessageToZCodePersistedMessage(
  message: ZCodeMessageWithParts,
  goalIteration?: number,
  backgroundTaskNotifications?: ReadonlyMap<string, ZCodeBackgroundTaskNotificationInfo>,
): ZCodePersistedMessage {
  const tools: ZCodePersistedToolCall[] = [];
  const parts: ZCodePersistedMessagePart[] = [];
  const attachments = mapPromptAttachmentsFromParts(message.parts);
  const projectionPolicy =
    message.info.role === "user"
      ? getConversationMessageProjectionPolicy(message)
      : "realUserInput";
  let syntheticTimeline: ZCodeTimelineMeta | undefined;
  for (const part of message.parts) {
    if (part.type === "text") {
      if (!syntheticTimeline) {
        const fromText = extractSyntheticTimelineFromTextPart(part);
        if (fromText) {
          syntheticTimeline = fromText;
        }
      }
    } else if (part.type === "compaction" && !syntheticTimeline) {
      syntheticTimeline = synthesizeCompactionTimeline(part);
    } else if (part.type === "timeline" && !syntheticTimeline) {
      syntheticTimeline = synthesizeTimelineFromTimelinePart(part);
    }
  }
  for (const part of message.parts) {
    if (part.type === "text") {
      if (projectionPolicy !== "timelineOnly") {
        parts.push({ type: "content", content: part.text });
      }
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
    content: projectionPolicy === "timelineOnly" ? "" : textFromParts(message.parts),
    timestamp: message.info.time.created,
    // Unbound restored history may lack a model origin; display never depends on a selectable model.
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

  // Bugfix: desktop-continuous history restore goes through the session projection, not the legacy task adapter.
  // Without projecting file parts back to attachments, sent images/files vanish in the restored UI.
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

  if (mimeType.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf") {
    return {
      kind: "pdf",
      filename,
      mimeType: "application/pdf",
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
  const commaIndex = value.indexOf(",");
  if (value.slice(0, "data:".length).toLowerCase() !== "data:" || commaIndex < 0) {
    return undefined;
  }
  const headerParts = value.slice("data:".length, commaIndex).split(";");
  if (headerParts.at(-1)?.trim().toLowerCase() !== "base64") return undefined;
  return value.slice(commaIndex + 1) || undefined;
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

function synthesizeTimelineFromTimelinePart(
  part: Extract<ZCodeMessagePart, { type: "timeline" }>,
): ZCodeTimelineMeta | undefined {
  if (part.timelineType !== "session_fork") {
    return undefined;
  }
  const parentSessionId = part.parentSessionId;
  const targetMessageId = part.targetMessageId;
  if (!parentSessionId || !targetMessageId) {
    return undefined;
  }
  return {
    version: 1,
    kind: "synthetic",
    type: "session_fork",
    display: "separator",
    parentSessionId,
    targetMessageId,
    ...(part.targetCheckpointId ? { targetCheckpointId: part.targetCheckpointId } : {}),
    ...(typeof part.restoredFileCount === "number"
      ? { restoredFileCount: part.restoredFileCount }
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
    // Fix: after a successful compact the summary user message carries compaction metadata too,
    // but that is a model-context boundary, not UI timeline; only lifecycle parts draw the divider.
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
  const phase = compactionPhaseValue(metadata.phase);
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
    ...(phase ? { phase } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
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
    // Bugfix: the compact lifecycle is a structured state event, not assistant body text.
    // Even if upstream erroneously includes text, internal summary/prompt must not reach the chat.
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
    content: "",
    // Bugfix: the fork notice is structured synthetic text in part.upserted, not a model body delta.
    // Project it to a timeline divider early, or the UI renders it as a plain message and loses the divider.
    zcodeTimeline: timeline,
  };
}

function mapGoalVerificationTimelinePayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  timestamp: number,
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }> | null {
  const targetId = stringValue(payload.targetId);
  const verificationId = stringValue(payload.verificationId);
  const status = goalVerificationTimelineStatusValue(payload.status);
  if (!targetId || !verificationId || !status) {
    return null;
  }
  const verification = goalVerificationFromRecord(asRecord(payload.verification));
  const goalIteration = positiveIntegerValue(payload.goalIteration);
  const anchorAssistantMessageId = stringValue(payload.anchorAssistantMessageId);
  const anchorTurnId = stringValue(payload.anchorTurnId);
  const startedAt =
    numberValue(payload.startedAt) ?? (status === "started" ? timestamp : undefined);
  const timeline: ZCodeGoalVerificationTimelineMeta = {
    version: 1,
    kind: "synthetic",
    type: "goal_verification",
    display: "separator",
    targetId,
    verificationId,
    status,
    ...(verification ? { verification } : {}),
    ...(goalIteration ? { goalIteration } : {}),
    ...(anchorAssistantMessageId ? { anchorAssistantMessageId } : {}),
    ...(anchorTurnId ? { anchorTurnId } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    updatedAt: timestamp,
  };
  return {
    type: "agent_message_chunk",
    taskId,
    traceId,
    ...(inputId ? { inputId } : {}),
    messageId: goalVerificationTimelineMessageId(timeline),
    content: "",
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
  const phase = compactionPhaseValue(payload.phase);
  const startedAt = numberValue(payload.startedAt);
  const endedAt = numberValue(payload.endedAt);
  const timeline: ZCodeContextCompactionTimelineMeta = {
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
    ...(phase ? { phase } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
  return timeline;
}

function compactFailureToTimelineEvent(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  reason: string,
): Extract<ZCodeStreamEvent, { type: "agent_message_chunk" }> {
  const operationId = `compact-failed-${inputId ?? traceId}`;
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
      operationId,
      status: /abort|cancel|interrupt|stop/i.test(reason) ? "interrupted" : "failed",
      trigger: "manual",
      display: "separator",
      ...(inputId ? { inputId } : {}),
      reason,
      endedAt: Date.now(),
    },
  };
}

function mapToolPart(
  part: Extract<ZCodeMessagePart, { type: "tool" }>,
  backgroundTaskNotifications?: ReadonlyMap<string, ZCodeBackgroundTaskNotificationInfo>,
): ZCodePersistedToolCall {
  const state = part.state;
  const taskNotification = backgroundTaskNotifications?.get(part.callId);
  // Fix: the ZCode Protocol part.callId is the shared tool identity across live stream and final snapshot.
  /// Saving metadata alone dropped the toolCallId, so result-only temp tools in mobile replayable were never overwritten by the final snapshot.
  const raw = attachZCodeBackgroundTaskNotificationToRaw(
    attachToolCallIdToRaw("metadata" in state ? (state.metadata ?? state) : state, part.callId),
    taskNotification,
  );
  if (state.status === "completed") {
    // Fix: a background agent completed means launch-ACK only; the matching failed
    // notification overwrites it in this fix, without touching existing recovery semantics such as stopped.
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

function mapModelStreaming(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
  toolProjectionMemory?: ZCodeToolProjectionMemory,
  projectionMode: ZCodeSessionProjectionMode = "active-live",
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
  return mapToolInputStreaming(
    taskId,
    traceId,
    inputId,
    payload,
    toolProjectionMemory,
    projectionMode,
  );
}

function mapToolInputStreaming(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  payload: Record<string, unknown>,
  toolProjectionMemory?: ZCodeToolProjectionMemory,
  projectionMode: ZCodeSessionProjectionMode = "active-live",
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
  const buildRaw = (input: unknown, rawInput: string | undefined) =>
    buildStreamingToolInputRaw(payload, input, rawInput);

  if (kind === "tool_input_start") {
    streamingToolInputById?.set(toolId, { rawInput: "" });
    logStreamingToolInputProjection({
      inputKeys: [],
      kind,
      projectedType: "tool_call",
      rawInputLength: 0,
      taskId,
      toolId,
      toolName,
      traceId,
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
    if (
      !shouldMaterializeZCodeStreamingToolInputPreview(state, {
        mode: projectionMode,
        toolName,
      })
    ) {
      // Perf: background tasks and high-frequency active deltas touch only the tombstone buffer.
      /// Full args land in the message tree at budget points, tool_input_end, the final tool_call, or on return to active.
      return null;
    }
    const preview = buildZCodeStreamingToolInputPreview(state.rawInput);
    markZCodeStreamingToolInputPreviewMaterialized(state);
    const previewToolName = toolName ?? inferStreamingToolInputToolName(preview.input);
    const previewTitle = previewToolName ?? title;
    if (previewToolName && !toolName) {
      toolNameById?.set(toolId, previewToolName);
    }
    const previewSummary = readStreamingToolInputPreviewLogSummary(
      preview.input,
      state.rawInput.length,
      state.deltaCount,
    );
    logStreamingToolInputProjection({
      ...previewSummary,
      inputKeys: inputPreviewKeys(preview.input),
      kind,
      projectedType: "tool_call_update",
      rawInputLength: state.rawInput.length,
      taskId,
      toolId,
      toolName: previewToolName,
      traceId,
    });
    logStreamingToolInputProjectionSample({
      ...previewSummary,
      kind,
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
    logStreamingToolInputProjection({
      inputKeys: [],
      kind,
      projectedType: "tool_call_update",
      rawInputLength: state.rawInput.length,
      taskId,
      toolId,
      toolName: previewToolName,
      traceId,
    });
    logStreamingToolInputProjectionSample({
      force: true,
      kind,
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
      // Perf fix: tool_input_end and the following tool_call used to parse the same large JSON twice in a row.
      // end only closes the streamed args; the final tool_call materializes the full input once.
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
    if ((hasCompleteInput || preview.complete) && toolProjectionMemory) {
      finalizeZCodeToolProjectionInput(toolId, preview.input, toolProjectionMemory);
    }
    streamingToolInputById?.set(toolId, {
      // Perf fix: after the final tool_call the message tree holds the full input; the projection tombstone no longer
      // keeps the large raw JSON, so long concurrent tasks stop pinning renderer memory.
      rawInput: "",
      deltaCount: state?.deltaCount,
      lastPreviewAt: Date.now(),
      lastPreviewRawInputLength: rawInput.length,
    });
    const previewSummary = readStreamingToolInputPreviewLogSummary(
      preview.input,
      rawInput.length,
      state?.deltaCount,
    );
    logStreamingToolInputProjection({
      ...previewSummary,
      inputKeys: inputPreviewKeys(preview.input),
      kind,
      projectedType: "tool_call_update",
      rawInputLength: rawInput.length,
      taskId,
      toolId,
      toolName: previewToolName,
      traceId,
    });
    logStreamingToolInputProjectionSample({
      ...previewSummary,
      force: true,
      kind,
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

function buildStreamingToolInputRaw(
  payload: Record<string, unknown>,
  input: unknown,
  rawInput: string | undefined,
): Record<string, unknown> {
  return {
    ...payload,
    ...(input !== undefined ? { input } : {}),
    ...(rawInput ? { streamingRawInputLength: rawInput.length } : {}),
  };
}

function logStreamingToolInputProjection(details: {
  contentLength?: number;
  contentLineCount?: number;
  deltaCount?: number;
  filePath?: string;
  inputKeys: string[];
  kind: string;
  projectedType: "tool_call" | "tool_call_update";
  rawInputLength: number;
  taskId: string;
  toolId: string;
  toolName?: string;
  traceId: TraceId;
}): void {
  logger.debug("[streamingToolInput] projected", {
    ...details,
    event: "ui.zcode_session.streaming_tool_input.projected",
  });
}

function logStreamingToolInputProjectionSample(details: {
  contentLength?: number;
  contentLineCount?: number;
  deltaCount?: number;
  filePath?: string;
  force?: boolean;
  kind: string;
  taskId: string;
  toolId: string;
  toolName?: string;
}): void {
  const lineCount = details.contentLineCount;
  const bucket =
    lineCount === undefined
      ? -1
      : Math.floor(lineCount / STREAMING_TOOL_INPUT_INFO_LOG_LINE_BUCKET);
  const key = `${details.taskId}:${details.toolId}:projection`;
  if (!details.force && streamingToolInputProjectionLogBuckets.get(key) === bucket) {
    return;
  }
  streamingToolInputProjectionLogBuckets.set(key, bucket);
  if (details.kind === "tool_input_end") {
    streamingToolInputProjectionLogBuckets.delete(key);
  }

  // Perf: tool-input projection scales with tool-call count; info-level logging would multiply renderer cost in deep dives.
  // Debug sampling stays, so details remain available when investigating.
  logger.debug("[streamingToolInput] projection sampled", {
    ...details,
    event: "ui.zcode_session.streaming_tool_input.projection_sampled",
  });
}

function readStreamingToolInputPreviewLogSummary(
  input: unknown,
  rawInputLength: number,
  deltaCount: number | undefined,
) {
  const record = asRecord(input);
  const content = readStringField(record, [
    "content",
    "new_string",
    "newString",
    "new_text",
    "newText",
  ]);
  const filePath = readStringField(record, [
    "file_path",
    "filePath",
    "path",
    "target_path",
    "targetPath",
    "filename",
    "file",
  ]);
  return {
    ...(content !== undefined
      ? {
          contentLength: content.length,
          contentLineCount: countTextLines(content),
        }
      : {}),
    ...(deltaCount !== undefined ? { deltaCount } : {}),
    ...(filePath ? { filePath } : {}),
    rawInputLength,
  };
}

function inferStreamingToolInputToolName(input: unknown): string | undefined {
  const record = asRecord(input);
  const filePath = readStringField(record, [
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
  if (readStringField(record, ["old_string", "oldString", "old_text", "oldText"])) {
    return "Edit";
  }
  if (
    readStringField(record, ["content", "new_string", "newString", "new_text", "newText"]) !==
    undefined
  ) {
    return "Write";
  }
  return undefined;
}

function readStringField(
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

function countTextLines(value: string): number {
  return value.length === 0 ? 0 : value.split(/\r\n|\r|\n/u).length;
}

function inputPreviewKeys(input: unknown): string[] {
  return Object.keys(asRecord(input));
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
    const duplicateMaterializedInput = memory.completeToolInputById?.has(toolId) ?? false;
    if (duplicateMaterializedInput) {
      return [
        {
          type: "tool_call_update",
          taskId,
          traceId,
          ...(inputId ? { inputId } : {}),
          toolId,
          parentToolUseId,
          toolName,
          kind: toolName,
          status: toolStatusFromPayload(payload),
          raw: omitRepeatedToolInputFromRaw(payload),
        },
      ];
    }
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
    return planSteps
      ? [
          toolEvent,
          {
            type: "plan",
            taskId,
            traceId,
            ...(inputId ? { inputId } : {}),
            steps: planSteps,
          },
        ]
      : [toolEvent];
  }
  if ("result" in payload) {
    const result = asRecord(payload.result);
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
    return planSteps
      ? [
          toolEvent,
          {
            type: "plan",
            taskId,
            traceId,
            ...(inputId ? { inputId } : {}),
            steps: planSteps,
          },
        ]
      : [toolEvent];
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
    /// Fix: an agent background-start ACK only proves the subagent began running;
    // replay/snapshot projection must not treat it as final completion, or a running agent shows completed.
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
  // Fix: the session projection may consume replay/snapshot results directly -- message-layer fallback alone is not enough;
  // the new async_launched ACK matches the provider-visible output_file copy, while old sessions keep outputFile/backgroundTaskId copy.
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

function toolStatusFromPayload(
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "tool_call_update" }>["status"] {
  switch (stringValue(payload.status)) {
    case "tool_started":
      return "in_progress";
    case "tool_denied":
      return "denied";
    case "tool_result_committed":
    case "tool_call_closed":
    case "tool_queued":
    default:
      return "pending";
  }
}

function omitRepeatedToolInputFromRaw(payload: Record<string, unknown>): Record<string, unknown> {
  const { input: _input, ...rest } = payload;
  return {
    ...rest,
    inputOmitted: true,
    inputRef: "tool_call",
  };
}

function parentToolUseIdFromToolPayload(payload: Record<string, unknown>): string | null {
  // Fix: the frontend replay/snapshot projection can bypass the services adapter;
  /// keep the same parentToolCallId -> parentToolUseId normalization as the service layer.
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
    ...(payload.origin ? { origin: payload.origin as ZCodePermissionRequest["origin"] } : {}),
    raw: payload,
  };
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

  // Fix: runtime rejections such as Plan mode emit permission.resolved first
  /// with no matching tool.updated(error) live event; clearing only the request leaves started tool cards spinning.
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

function permissionOptionsFromPayload(payload: Record<string, unknown>): ZCodePermissionOption[] {
  return Array.isArray(payload.options) ? (payload.options as ZCodePermissionOption[]) : [];
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
    schema: { interaction: "plan_approval", toolName: permission.toolName },
  };
}

function ensureProjectionBackgroundTaskControlsCache(
  state: ZCodeSessionEventProjectionState | undefined,
): Map<string, ZCodeBackgroundTaskControlItem[]> | null {
  if (!state) {
    return null;
  }
  state.backgroundTaskControlsBySession ??= new Map();
  return state.backgroundTaskControlsBySession;
}

function setProjectionBackgroundTaskControls(
  state: ZCodeSessionEventProjectionState | undefined,
  taskId: string,
  jobs: ZCodeBackgroundTaskControlItem[],
) {
  ensureProjectionBackgroundTaskControlsCache(state)?.set(taskId, jobs);
}

export function syncZCodeSessionBackgroundTaskProjection(
  state: ZCodeSessionEventProjectionState | undefined,
  taskId: string,
  jobs: ZCodeBackgroundTaskControlItem[],
) {
  setProjectionBackgroundTaskControls(state, taskId, jobs);
}

export function syncZCodeSessionBackgroundTaskProjectionFromSnapshot(
  state: ZCodeSessionEventProjectionState | undefined,
  snapshot: ZCodeSessionStateSnapshot,
) {
  /// Bugfix: a single-task completion is a delta payload; merge it onto the full snapshot from the same subscription,
  /// or the post-switch projection state drops peer running tasks.
  syncZCodeSessionBackgroundTaskProjection(
    state,
    snapshot.session.sessionId,
    parseZCodeBackgroundTaskControlItems(snapshot.projection.backgroundJobs),
  );
}

function updateProjectionBackgroundTaskControlsFromPayload(
  state: ZCodeSessionEventProjectionState | undefined,
  taskId: string,
  payload: Record<string, unknown>,
): ZCodeBackgroundTaskControlItem[] | null {
  const parsedJobs = parseZCodeBackgroundTaskControlItems([payload]);
  if (parsedJobs.length === 0) {
    return null;
  }
  const cache = ensureProjectionBackgroundTaskControlsCache(state);
  if (!cache) {
    return parsedJobs;
  }
  const nextJobs = mergeZCodeBackgroundTaskControlItems(cache.get(taskId) ?? [], parsedJobs);
  cache.set(taskId, nextJobs);
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

function mapSessionInfoLikePayload(
  taskId: string,
  traceId: TraceId,
  inputId: InputId | undefined,
  eventId: string | undefined,
  payload: Record<string, unknown>,
  state: ZCodeSessionEventProjectionState | undefined,
): ZCodeStreamEvent[] {
  const events: ZCodeStreamEvent[] = [];
  const goalVerification = goalVerificationFromPayload(payload);
  if (goalVerification) {
    events.push({
      type: "goal_verification_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      verification: goalVerification,
    });
  }
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
  const mode = stringValue(payload.mode);
  if (mode) {
    events.push({
      type: "mode_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      /// Bugfix: EnterPlanMode's SessionModeChanged surfaces via bootstrap as session.updated;
      /// translate the mode payload into the existing UI event or the menu keeps the pre-plan mode.
      currentModeId: normalizeAvailableZCodeMode(mode as ZCodeSessionMode),
      availableModes: getZCodeAgentAvailableModes(),
    });
  }
  if ("target" in payload && ("action" in payload || "source" in payload)) {
    const targetAction = normalizeTargetChangedAction(stringValue(payload.action));
    events.push({
      type: "session_info_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      target: {
        action: targetAction,
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
    setProjectionBackgroundTaskControls(state, taskId, jobs);
    events.push({
      type: "background_bash_jobs_update",
      taskId,
      traceId,
      ...(inputId ? { inputId } : {}),
      jobs,
    });
  }
  const backgroundJobUpdate = updateProjectionBackgroundTaskControlsFromPayload(
    state,
    taskId,
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

function normalizeTargetChangedAction(action: string | undefined): ZCodeTaskTargetChangedAction {
  switch (action) {
    case "status_updated":
    case "cleared":
    case "usage_accounted":
    case "run_started":
    case "run_finished":
    case "summary_updated":
      return action;
    case "set":
    default:
      return "set";
  }
}

function goalVerificationFromPayload(
  payload: Record<string, unknown>,
): Extract<ZCodeStreamEvent, { type: "goal_verification_update" }>["verification"] | null {
  if (stringValue(payload.querySource) !== "target_completion_verification") {
    return null;
  }
  const content = stringValue(payload.content);
  if (!content) {
    return null;
  }
  const parsed = parseJsonObjectFromText(content);
  if (!parsed) {
    /// Fix: history/live projection may hold only the verifier's raw model text; malformed output is a judge-chain failure --
    /// stay fail-open like contracts, or a restored completed goal reads as incomplete.
    return {
      passed: true,
      reason: "The completion verifier did not return valid JSON.",
    };
  }
  const reason =
    stringValue(parsed.reason)?.trim() ||
    "The completion verifier could not confirm that every goal requirement is complete.";
  const nextAction = stringValue(parsed.nextAction)?.trim();
  return {
    ...(nextAction ? { nextAction } : {}),
    passed: parsed.passed === true,
    reason,
  };
}

function parseJsonObjectFromText(text: string): Record<string, unknown> | null {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end < start) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(unfenced.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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
  /// Fix: cumulative tokens must update on every model completion, not wait for the task_complete rollup;
  /// the eventId is the protocol stream's stable per-event id -- dedup on it so foreground/background monitors never double-count.
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
  /// Bugfix: on session resume the protocol projection may not have replayed main-turn usage yet.
  /// runtime.contextUsage comes from persisted assistant token records and wins when restoring old task UIs.
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
    /// Fix: when the main-turn model reports usage, the real network token counts win;
    /// the context window is shared input+output, so the meter can no longer render inputTokens alone.
    /// projection.contextUsed is the runtime estimate/restoration truth, fallback only when usage is missing.
    explicitUsed;
  if (size === undefined || size <= 0) {
    return null;
  }
  /// Bugfix: the ZCode Protocol session.updated carries projection truth;
  /// the legacy task UI knows only usage_update, so the migration bridge must translate contextUsed/contextWindow explicitly.
  /// used=0 means init or fallback, not a usable context meter.
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
    /// Fix: AI SDK v6 folds Anthropic cache read/write into inputTokens.
    /// The projection shim adds output only, so replayable restore never double-counts cache reads in the meter.
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
  /// Fix: only the main conversation model request's inputTokens reflects the visible context.
  /// Sidecar requests (title, compact, prompt enhance) must not override the input context meter even with a contextWindow.
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
    /// Fix: the context-usage cache-hit ratio is an agent/app protocol field;
    /// normalize once in the projection shim instead of re-deriving per UI component.
    hitRate:
      explicitHitRate !== undefined
        ? Math.max(0, explicitHitRate)
        : inputTokens > 0
          ? cacheReadTokens / inputTokens
          : null,
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

function deriveTitleFromSnapshot(snapshot: ZCodeSessionStateSnapshot): string {
  return resolveZCodeVisibleSessionTitle({
    title: snapshot.session.title,
    messages: snapshot.messages,
    target: snapshot.projection.target,
  });
}

function fromZCodeMode(mode: ZCodeSessionMode): ZCodeTaskMode {
  return mode === "build" ? "build" : mode;
}

function getZCodeAgentModeSelectOptions(): NonNullable<ZCodeConfigOption["options"]> {
  return ZCODE_AGENT_MODE_OPTIONS.map((mode) => ({
    value: mode.id,
    name: mode.name,
    description: mode.description,
  }));
}

function getZCodeAgentAvailableModes(): ZCodeTaskModeInfo[] {
  return ZCODE_AGENT_MODE_OPTIONS.map((mode) => ({ ...mode }));
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
    activeInputId: stringValue(record.activeInputId) ?? null,
    activeRunStartedAtMs: numberValue(record.activeRunStartedAtMs) ?? null,
    activeRunLastSeenAtMs: numberValue(record.activeRunLastSeenAtMs) ?? null,
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

function getActivePromptInputId(
  state: ZCodeSessionEventProjectionState | undefined,
  sessionId: string,
): InputId | undefined {
  return state?.activePromptInputIdBySession?.get(sessionId);
}

function setActivePromptInputId(
  state: ZCodeSessionEventProjectionState | undefined,
  sessionId: string,
  inputId: InputId,
): void {
  if (!state) {
    return;
  }
  const map = state.activePromptInputIdBySession ?? new Map<string, InputId>();
  map.set(sessionId, inputId);
  state.activePromptInputIdBySession = map;
}

function clearActivePromptInputId(
  state: ZCodeSessionEventProjectionState | undefined,
  sessionId: string,
  inputId: InputId,
): void {
  if (state?.activePromptInputIdBySession?.get(sessionId) === inputId) {
    state.activePromptInputIdBySession.delete(sessionId);
  }
}

function rememberRewindControlTurn(
  state: ZCodeSessionEventProjectionState | undefined,
  turnKey: string,
  input: string | undefined,
): void {
  if (!state) {
    return;
  }
  const rewindControlTurnKeys = state.rewindControlTurnKeys ?? new Set<string>();
  /// Fix: edit/retry rolls context back via the internal `/rewind conversation <messageId>` control command.
  /// That command's TurnComplete.response is a protocol ACK, not an assistant reply -- never synthesize a bubble from it.
  if (isConversationRewindControlInput(input)) {
    rewindControlTurnKeys.add(turnKey);
  } else {
    rewindControlTurnKeys.delete(turnKey);
  }
  state.rewindControlTurnKeys = rewindControlTurnKeys;
}

function isConversationRewindControlInput(input: string | undefined): boolean {
  const normalized = input?.trim();
  if (!normalized?.startsWith("/rewind ")) {
    return false;
  }
  const [scope, target, ...rest] = normalized.slice("/rewind ".length).trim().split(/\s+/);
  return (
    rest.length === 0 &&
    Boolean(target) &&
    (scope === "conversation" || scope === "message" || scope === "both")
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function goalVerificationTimelineStatusValue(
  value: unknown,
): ZCodeGoalVerificationTimelineMeta["status"] | undefined {
  return value === "started" ||
    value === "completed" ||
    value === "failed_closed" ||
    value === "cancelled"
    ? value
    : undefined;
}

function goalVerificationFromRecord(record: Record<string, unknown>): ZCodeGoalVerification | null {
  const reason = stringValue(record.reason)?.trim();
  if (!reason) {
    return null;
  }
  const nextAction = stringValue(record.nextAction)?.trim();
  return {
    ...(nextAction ? { nextAction } : {}),
    passed: record.passed === true,
    reason,
  };
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

function compactionPhaseValue(value: unknown): ZCodeContextCompactionTimelinePhase | undefined {
  return value === "standalone_turn" ||
    value === "pre_request" ||
    value === "mid_turn" ||
    value === "reactive"
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
