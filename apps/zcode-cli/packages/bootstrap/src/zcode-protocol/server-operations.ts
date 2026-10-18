/* eslint-disable max-lines -- session/workspace methods of the ZCode Protocol share one server context and snapshot helpers; kept centralized for the migration. */
import { observeSessionDebug } from "./session-debug.js";
import {
  TASK_LIST_SESSION_TYPES,
  isTaskListSessionType,
} from "../zcode-protocol-v4/task-list-session-membership.js";
import { resolveEffectiveBashShellSelection } from "@zcode/adapters/exec";
import { inputIntentMetadata } from "../zcode-protocol-v4/commands/input-intent.js";
import { createModelExecutionContext } from "./model-execution.js";
import type { SendInputOptions } from "../app/types.js";
import { repairPersistedRemoteSessionPaths, type TurnAttachment } from "@zcode/core";
import {
  CoreErrorType,
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  createMessageId,
  createPartId,
  createSessionId,
  createCoreError,
  parseRewindTriggeredPayload,
  RewindScope,
  RewindStrategy,
  type EventId,
  type ExecutionShellSelection,
  type MessageWithParts,
  type ModelSelection,
  type MessageId,
  type ModelId,
  type ModelProviderId,
  type QueryId,
  type SessionEvent,
  SessionEventType,
  type SessionId,
  type SessionInfo,
  type SessionTaskType,
  type CollaborationMode,
  type TargetCompletionVerificationPayload,
  type TraceId,
  type TurnBackgroundAttribution,
  type TurnId,
  type UsageStorePort,
  type WorkspaceId,
} from "@zcode/contracts";
import {
  subagentRuntimeConfigSchema,
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
  zcodeProtocolErrorCodes,
  zcodeProtocolMethods,
  zcodeSessionCancelBackgroundTaskParamsSchema,
  zcodeSessionCompactParamsSchema,
  zcodeSessionCloseParamsSchema,
  zcodeSessionCreateParamsSchema,
  zcodeSessionEventsParamsSchema,
  zcodeSessionForkParamsSchema,
  zcodeSessionGoalParamsSchema,
  zcodeSessionListParamsSchema,
  zcodeSessionMessagesParamsSchema,
  zcodeSessionReadParamsSchema,
  elideSessionSnapshotForIndex,
  zcodeSessionRuntimePreferencesResultSchema,
  zcodeSessionResumeParamsSchema,
  zcodeSessionSendParamsSchema,
  zcodeSessionSetModeParamsSchema,
  zcodeSessionSetModelParamsSchema,
  zcodeSessionSetThoughtLevelParamsSchema,
  zcodeSessionStopParamsSchema,
  zcodeSessionSubscribeParamsSchema,
  zcodeSessionSubagentsParamsSchema,
  zcodeTaskTokenUsageParamsSchema,
  zcodeUsageStatsParamsSchema,
  zcodeWorkspaceGenerateTextParamsSchema,
  getConversationMessageProjectionPolicy,
  isRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  type ZCodeAutomationBotDeliveryTarget,
  type ZCodeSessionCreateParams,
  type ZCodeDeliveryKind,
  type IntegratedTerminalShellSelection,
  type ZCodeSessionRuntimePreferencesScope,
  type ZCodeSessionRuntimePreferencesResult,
  type ZCodeModelContextBudgetStrategy,
  type ZCodeProtocolTrace,
  type ZCodeSessionEvent,
  type ZCodeSessionHistoryTarget,
  type ZCodeSessionResumeParams,
  type ZCodeSessionPersistence,
  type ZCodeWorkspaceRef,
  type ZCodeStateUpdatedNotification,
} from "@zcode/shared";
import {
  buildSessionSnapshot,
  buildWorkspaceRef,
  formatProtocolModelSelection,
  mapSessionEventForProtocol,
  mapSessionInfo,
  resolveSessionContextUsage,
  shouldExposeSessionEventToProtocol,
} from "./mapper.js";
import { optionalModelSelectionFromString } from "./model-mapper.js";
import {
  ProtocolRequestError,
  assertExpectedRevision,
  createProtocolLogger,
  createProtocolRootTraceContext,
  protocolTraceFromTraceContext,
  parseParams,
  requireSession,
  type ZCodeProtocolAgentServerContext,
  type ZCodeProtocolSessionRecord,
  type ZCodeProtocolToolInputTransmissionState,
} from "./server-types.js";
import { createWorkspaceZCodeApp, ensureSessionModelAvailable } from "./workspace-model-runtime.js";
import { buildAppUsageSnapshot, resolveTzOffsetMs } from "./usage-stats-builder.js";
import { createProtocolInteractionBroker } from "./interaction-broker.js";
import { createProtocolAutomationPort } from "./automation-port.js";
import { createProtocolOffPeakPort } from "./offpeak-port.js";
import { createProtocolTopicResourcePort } from "./topic-resource-port.js";
import { createProtocolBrowserControlBroker } from "./browser-control-broker.js";
import { mapComputerUseOperationEvent } from "./computer-use-operation-event.js";
import { protocolMcpServersToRuntimeMcpConfig } from "./protocol-mcp-config.js";
import { projectIdFromDirectory } from "../app/paths.js";
import {
  collectSubagentChildSessionIds,
  paginateEndedSubagents,
  projectSessionSubagents,
} from "./subagent-session-query.js";
import { runSessionModelConfigMutation } from "../zcode-protocol-v4/model-config-mutation.js";
import { runWithSessionResidencyFinalization } from "./session-residency.js";
import { resolveDynamicWorkflowRuntimeGate } from "./dynamic-workflow-policy.js";
import { abortMcpUiToolCallsForSession, clearMcpUiAppToolsForSession } from "./mcp-ui/index.js";

const PLAN_MODE_GOAL_CONTINUATION_SKIPPED_MESSAGE =
  "Goal recorded in plan mode; automatic continuation is skipped.";
const SLOW_SNAPSHOT_LOG_THRESHOLD_MS = 1000;
const REMOTE_AUTOMATION_TOOL_NAMES = [
  "CronCreate",
  "CronList",
  "CronUpdate",
  "CronDelete",
] as const;

type ProtocolGoalTarget = NonNullable<
  Awaited<ReturnType<NonNullable<ZCodeProtocolSessionRecord["app"]["readTarget"]>>>
>;

type ZCodeSessionRecordParams = (
  | ZCodeSessionCreateParams
  | (ZCodeSessionResumeParams & {
      mode?: ZCodeSessionCreateParams["mode"];
      model?: ZCodeSessionCreateParams["model"];
      parentSessionId?: ZCodeSessionCreateParams["parentSessionId"];
      thoughtLevel?: ZCodeSessionCreateParams["thoughtLevel"];
      // Automation sessions disable title regeneration at creation, and create/resume share the
      // record initializer; the resume compat branch must declare the same policy field.
      titleGenerationEnabled?: ZCodeSessionCreateParams["titleGenerationEnabled"];
    })
) & { taskType?: SessionTaskType };

interface SessionStartupPreferences {
  subagentRuntimeConfigEnabled?: boolean;
  memoryEnabled: boolean;
  modelContextBudgetStrategy: ZCodeModelContextBudgetStrategy;
  nativeSearchEnhancementsEnabled: boolean;
  resolveInitialBashShellSelection: () => Promise<ExecutionShellSelection | undefined>;
}

type SessionStartupPreferencesSource =
  | { kind: "host" }
  | { kind: "inherit"; parent: ZCodeProtocolSessionRecord };

function resolveSupportedAppThoughtLevel(
  app: Pick<ZCodeProtocolSessionRecord["app"], "listThoughtLevels">,
  thoughtLevel: string | undefined,
): string | undefined {
  const normalizedThoughtLevel = thoughtLevel?.trim();
  if (!normalizedThoughtLevel) {
    return undefined;
  }
  const supportedLevels = app.listThoughtLevels();
  return supportedLevels.includes(normalizedThoughtLevel) ? normalizedThoughtLevel : undefined;
}

const DEFAULT_PROTOCOL_EVENT_SEQUENCE_KEY = "__default__";
const PROTOCOL_TOOL_INPUT_DELTA_BATCH_MAX_CHARS = 4 * 1024;
const PROTOCOL_TOOL_INPUT_DELTA_BATCH_MAX_INTERVAL_MS = 750;
const PROTOCOL_TEXT_STREAMING_DELTA_BATCH_MAX_CHARS = 2 * 1024;
const PROTOCOL_TEXT_STREAMING_DELTA_BATCH_MAX_INTERVAL_MS = 250;

type ProtocolStreamingDeltaKind = "reasoning_delta" | "text_delta" | "tool_input_delta";

interface ProtocolStreamingDeltaBatchInfo {
  batchKey: string;
  delta: string;
  kind: ProtocolStreamingDeltaKind;
  maxChars: number;
  shouldFlushFirstDelta: boolean;
  timestampMs: number;
}

interface ProtocolStreamingDeltaBatch {
  batchKey: string;
  delta: string;
  event: SessionEvent;
  kind: ProtocolStreamingDeltaKind;
  maxChars: number;
  startedAtMs: number;
  updatedAtMs: number;
}

interface LiveProtocolStreamingDeltaBatch {
  batch?: ProtocolStreamingDeltaBatch;
  flushedFirstDeltaBatchKeys: Set<string>;
  lastFlushAtByBatchKey: Map<string, number>;
}

const liveProtocolStreamingDeltaBatches = new WeakMap<
  ZCodeProtocolSessionRecord,
  Map<string, LiveProtocolStreamingDeltaBatch>
>();

function protocolEventSequenceKey(deliveryKind?: ZCodeDeliveryKind): string {
  return deliveryKind ?? DEFAULT_PROTOCOL_EVENT_SEQUENCE_KEY;
}

function getProtocolEventSequenceState(
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
) {
  const key = protocolEventSequenceKey(deliveryKind);
  const existing = record.protocolEventSequences.get(key);
  if (existing) {
    return existing;
  }
  const created = {
    lastSeq: 0,
    seqBySourceEventKey: new Map<string, number>(),
  };
  record.protocolEventSequences.set(key, created);
  return created;
}

function getProtocolToolInputTransmissionState(
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): ZCodeProtocolToolInputTransmissionState {
  const key = protocolEventSequenceKey(deliveryKind);
  const existing = record.protocolToolInputTransmissions.get(key);
  if (existing) {
    return existing;
  }
  const created: ZCodeProtocolToolInputTransmissionState = {
    streamedToolCallIdsWithInput: new Set(),
  };
  record.protocolToolInputTransmissions.set(key, created);
  return created;
}

function protocolSourceEventKey(event: SessionEvent): string {
  return event.sequenceNumber > 0 ? `seq:${event.sequenceNumber}` : `event:${String(event.id)}`;
}

function assignProtocolEventSeq(
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
  deliveryKind?: ZCodeDeliveryKind,
): number {
  const state = getProtocolEventSequenceState(record, deliveryKind);
  const sourceEventKey = protocolSourceEventKey(event);
  const existing = state.seqBySourceEventKey.get(sourceEventKey);
  if (existing !== undefined) {
    return existing;
  }
  const nextSeq = state.lastSeq + 1;
  state.lastSeq = nextSeq;
  state.seqBySourceEventKey.set(sourceEventKey, nextSeq);
  return nextSeq;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getLiveProtocolStreamingDeltaBatchState(
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): LiveProtocolStreamingDeltaBatch {
  let byDeliveryKind = liveProtocolStreamingDeltaBatches.get(record);
  if (!byDeliveryKind) {
    byDeliveryKind = new Map();
    liveProtocolStreamingDeltaBatches.set(record, byDeliveryKind);
  }
  const key = protocolEventSequenceKey(deliveryKind);
  const existing = byDeliveryKind.get(key);
  if (existing) {
    return existing;
  }
  const created: LiveProtocolStreamingDeltaBatch = {
    flushedFirstDeltaBatchKeys: new Set(),
    lastFlushAtByBatchKey: new Map(),
  };
  byDeliveryKind.set(key, created);
  return created;
}

function buildProtocolStreamingDeltaBatchKey(params: {
  assistantMessageId?: string;
  inputId?: string;
  kind: ProtocolStreamingDeltaKind;
  partId?: string;
  parentToolUseId?: string;
  toolCallId?: string;
}): string {
  return [
    params.kind,
    params.assistantMessageId ?? "",
    params.inputId ?? "",
    params.partId ?? "",
    params.parentToolUseId ?? "",
    params.toolCallId ?? "",
  ].join(":");
}

function readProtocolStreamingParentToolUseId(
  payload: Record<string, unknown>,
): string | undefined {
  const direct = stringValue(payload.parentToolUseId) ?? stringValue(payload.parentToolCallId);
  if (direct) {
    return direct;
  }
  const meta = asRecord(payload._meta);
  const zcode = asRecord(meta.zcode);
  const claudeCode = asRecord(meta.claudeCode);
  return (
    stringValue(meta.parentToolUseId) ??
    stringValue(meta.parentToolCallId) ??
    stringValue(zcode.parentToolUseId) ??
    stringValue(zcode.parentToolCallId) ??
    stringValue(claudeCode.parentToolUseId) ??
    stringValue(claudeCode.parentToolCallId)
  );
}

function timestampMsForProtocolEvent(event: SessionEvent): number {
  const timestampMs = event.timestamp.getTime();
  return Number.isFinite(timestampMs) ? timestampMs : 0;
}

function readStreamingDeltaBatchableEvent(
  event: SessionEvent,
): ProtocolStreamingDeltaBatchInfo | null {
  if (event.type !== SessionEventType.ModelStreaming) {
    return null;
  }
  const payload = asRecord(event.payload);
  const kind = stringValue(payload.kind) as ProtocolStreamingDeltaKind | undefined;
  if (kind !== "tool_input_delta" && kind !== "text_delta" && kind !== "reasoning_delta") {
    return null;
  }
  const delta = stringValue(payload.delta);
  if (!delta) {
    return null;
  }
  const assistantMessageId = stringValue(payload.assistantMessageId);
  const inputId = stringValue(payload.inputId);
  const partId = stringValue(payload.partId);
  const parentToolUseId = readProtocolStreamingParentToolUseId(payload);
  const toolCallId = stringValue(payload.toolCallId);
  if (kind === "tool_input_delta" && !toolCallId) {
    return null;
  }
  return {
    batchKey: buildProtocolStreamingDeltaBatchKey({
      assistantMessageId,
      inputId,
      kind,
      partId,
      parentToolUseId,
      toolCallId,
    }),
    delta,
    kind,
    maxChars:
      kind === "tool_input_delta"
        ? PROTOCOL_TOOL_INPUT_DELTA_BATCH_MAX_CHARS
        : PROTOCOL_TEXT_STREAMING_DELTA_BATCH_MAX_CHARS,
    shouldFlushFirstDelta:
      kind === "text_delta" || kind === "reasoning_delta" || kind === "tool_input_delta",
    timestampMs: timestampMsForProtocolEvent(event),
  };
}

function mergeProtocolStreamingDeltaBatch(
  batch: ProtocolStreamingDeltaBatch | undefined,
  event: SessionEvent,
  deltaInfo: ProtocolStreamingDeltaBatchInfo,
): ProtocolStreamingDeltaBatch {
  if (!batch || batch.batchKey !== deltaInfo.batchKey) {
    return {
      batchKey: deltaInfo.batchKey,
      delta: deltaInfo.delta,
      event,
      kind: deltaInfo.kind,
      maxChars: deltaInfo.maxChars,
      startedAtMs: deltaInfo.timestampMs,
      updatedAtMs: deltaInfo.timestampMs,
    };
  }
  return {
    batchKey: deltaInfo.batchKey,
    delta: `${batch.delta}${deltaInfo.delta}`,
    event,
    kind: deltaInfo.kind,
    maxChars: deltaInfo.maxChars,
    startedAtMs: batch.startedAtMs,
    updatedAtMs: deltaInfo.timestampMs,
  };
}

function materializeProtocolStreamingDeltaBatch(batch: ProtocolStreamingDeltaBatch): SessionEvent {
  const payload = asRecord(batch.event.payload);
  return {
    ...batch.event,
    payload: {
      ...payload,
      delta: batch.delta,
    },
  };
}

function rememberProtocolStreamingDeltaBatchFlush(
  lastFlushAtByBatchKey: Map<string, number>,
  batch: ProtocolStreamingDeltaBatch,
): void {
  lastFlushAtByBatchKey.set(batch.batchKey, batch.updatedAtMs);
}

function shouldFlushProtocolStreamingDeltaBatchForInterval(
  batch: ProtocolStreamingDeltaBatch,
  lastFlushAtByBatchKey: Map<string, number>,
): boolean {
  const lastFlushAt = lastFlushAtByBatchKey.get(batch.batchKey);
  if (lastFlushAt === undefined) {
    return false;
  }
  // A running task's streaming function call cannot be packed by a 4KB byte budget alone:
  // single-line JSON args linger at the protocol boundary and the tool card's args stop streaming.
  const maxIntervalMs =
    batch.kind === "tool_input_delta"
      ? PROTOCOL_TOOL_INPUT_DELTA_BATCH_MAX_INTERVAL_MS
      : PROTOCOL_TEXT_STREAMING_DELTA_BATCH_MAX_INTERVAL_MS;
  return batch.updatedAtMs - lastFlushAt >= maxIntervalMs;
}

function markStreamedToolInputIfPresent(
  mappedEvent: ZCodeSessionEvent,
  toolInputTransmissions: ZCodeProtocolToolInputTransmissionState,
): void {
  if (mappedEvent.type !== "model.streaming") {
    return;
  }
  const payload = asRecord(mappedEvent.payload);
  if (payload.kind !== "tool_call" || !("input" in payload)) {
    return;
  }
  const toolCallId = stringValue(payload.toolCallId);
  if (!toolCallId) {
    return;
  }
  toolInputTransmissions.streamedToolCallIdsWithInput.add(toolCallId);
}

function omitDuplicateScheduledToolInput(
  event: SessionEvent,
  mappedEvent: ZCodeSessionEvent,
  toolInputTransmissions: ZCodeProtocolToolInputTransmissionState,
): ZCodeSessionEvent {
  markStreamedToolInputIfPresent(mappedEvent, toolInputTransmissions);
  if (event.type !== SessionEventType.ToolCallScheduled || mappedEvent.type !== "tool.updated") {
    return mappedEvent;
  }
  const payload = asRecord(mappedEvent.payload);
  if (payload.kind !== "scheduled" || !("input" in payload)) {
    return mappedEvent;
  }
  const toolCallId = stringValue(payload.toolCallId);
  if (!toolCallId || !toolInputTransmissions.streamedToolCallIdsWithInput.has(toolCallId)) {
    return mappedEvent;
  }

  const nextPayload: Record<string, unknown> = { ...payload };
  const input = nextPayload.input;
  delete nextPayload.input;
  nextPayload.inputByteLength = measureJsonBytes(input);
  nextPayload.inputOmitted = true;
  nextPayload.inputRef = "model_stream";
  // Perf fix: the AI SDK's tool_call already carries the full input in model.streaming;
  // scheduled is only a lifecycle boundary, and re-carrying Write/Edit's large args amplifies them over both stdio and to the renderer.
  return {
    ...mappedEvent,
    payload: nextPayload,
  };
}

function mapProtocolPromptAttachments(
  attachments: unknown[] | undefined,
): TurnAttachment[] | undefined {
  const mapped = (attachments ?? [])
    .map(mapProtocolPromptAttachment)
    .filter((attachment): attachment is TurnAttachment => attachment !== undefined);
  return mapped.length > 0 ? mapped : undefined;
}

function mapProtocolPromptAttachment(attachment: unknown): TurnAttachment | undefined {
  const record = asRecord(attachment);
  const kind = stringValue(record.kind);
  const filename = stringValue(record.filename) ?? "attachment";
  const localPath = stringValue(record.localPath);
  const mimeType = stringValue(record.mimeType);
  const isPdf =
    kind === "pdf" || mimeType?.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
  // The GUI protocol attachment uses kind/localPath/dataBase64, while the core runtime only knows type/path/content.
  // Do the semantic conversion at the protocol boundary so the renderer's transport shape never leaks into the agent.
  // Display metadata (filename/mimeType/sizeBytes) passes through faithfully at the boundary,
  // so TurnStarted events and v4 userInput rows no longer rely on basename/extension guesses for attachment display.
  const displayMeta = {
    filename,
    ...(mimeType ? { mimeType } : {}),
    ...(typeof record.sizeBytes === "number" ? { sizeBytes: record.sizeBytes } : {}),
  };
  if (isPdf) {
    if (localPath) {
      return { path: localPath, type: "pdf", ...displayMeta };
    }
    const dataBase64 = stringValue(record.dataBase64);
    return dataBase64
      ? {
          content: `data:application/pdf;base64,${dataBase64}`,
          path: filename,
          type: "pdf",
          ...displayMeta,
        }
      : undefined;
  }
  if (kind === "image") {
    if (localPath) {
      return { path: localPath, type: "image", ...displayMeta };
    }
    const dataBase64 = stringValue(record.dataBase64);
    const mimeType = stringValue(record.mimeType) ?? "image/*";
    return dataBase64
      ? {
          content: `data:${mimeType};base64,${dataBase64}`,
          path: filename,
          type: "image",
          ...displayMeta,
        }
      : undefined;
  }

  // video: zero-copy localPath (the agent side reads the file for the size check); web builds an inline data URL from dataBase64.
  if (kind === "video") {
    if (localPath) {
      return { path: localPath, type: "video", ...displayMeta };
    }
    const dataBase64 = stringValue(record.dataBase64);
    const mimeType = stringValue(record.mimeType) ?? "video/mp4";
    return dataBase64
      ? {
          content: `data:${mimeType};base64,${dataBase64}`,
          path: filename,
          type: "video",
          ...displayMeta,
        }
      : undefined;
  }

  if (kind === "file" || kind === "audio") {
    if (localPath) {
      return {
        path: localPath,
        ...(kind === "file" &&
        (stringValue(record.sourceKind) === "clipboard-text" ||
          stringValue(record.sourceKind) === "topic-history")
          ? { sourceKind: stringValue(record.sourceKind) as "clipboard-text" | "topic-history" }
          : {}),
        type: "file",
        ...displayMeta,
      };
    }
    const textContent = stringValue(record.textContent);
    if (textContent !== undefined) {
      return {
        content: textContent,
        path: filename,
        type: "file",
        ...displayMeta,
      };
    }
    const decoded = decodeTextProtocolAttachment(record);
    return decoded !== undefined
      ? { content: decoded, path: filename, type: "file", ...displayMeta }
      : undefined;
  }

  return undefined;
}

function decodeTextProtocolAttachment(record: Record<string, unknown>): string | undefined {
  const dataBase64 = stringValue(record.dataBase64);
  if (!dataBase64) return undefined;
  const sizeBytes = numberValue(record.sizeBytes);
  if (sizeBytes !== undefined && sizeBytes > 64 * 1024) return undefined;
  try {
    return Buffer.from(dataBase64, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

function shouldHideProtocolSessionEvent(
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
): boolean {
  const payload = asRecord(event.payload);
  const querySource = stringValue(payload.querySource);
  if (event.type === "model_request" && querySource === "session_title") {
    return true;
  }
  if (event.type === "model_network_status" && querySource === "session_title") {
    // Never hide model_network_status behind the title-generation global suppress flag: a title
    // retry would also swallow the concurrent main request's retry event and the app's retry
    // counter would vanish. status events carry querySource; hide only the title's own.
    return true;
  }
  if (event.type === "model_complete" && querySource === "session_title") {
    return true;
  }
  return false;
}

function mapProtocolSessionEvent(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
  deliveryKind?: ZCodeDeliveryKind,
  options: {
    toolInputTransmissions?: ZCodeProtocolToolInputTransmissionState;
  } = {},
): ZCodeSessionEvent | null {
  if (shouldHideProtocolSessionEvent(record, event)) {
    return null;
  }
  if (!shouldExposeSessionEventToProtocol(event)) {
    const payload = asRecord(event.payload);
    context.logger?.debug("ZCode Protocol session event filtered", {
      event: "zcode_protocol.session_event.filtered",
      eventId: String(event.id),
      module: "bootstrap.zcode_protocol",
      payloadKind: stringValue(payload.kind),
      sessionEventSequenceNumber: event.sequenceNumber,
      sessionEventType: event.type,
      sessionId: String(event.sessionId),
      turnId: event.turnId ? String(event.turnId) : undefined,
    });
    return null;
  }
  // The eventStore sequenceNumber is the internal full ledger, including high-frequency model intermediates such as
  // tool_input_delta that the protocol filters out. The ZCode Protocol seq is the UI/replay recovery key and
  // must be renumbered consecutively over the protocol-visible event stream, never exposing the internal sequenceNumber.
  // subagent mirror/live-only events with sequenceNumber=0 never entered the parent eventStore; they too must
  // get their own seq by eventId, not share one zero mapping.
  const protocolSeq = assignProtocolEventSeq(record, event, deliveryKind);
  const mappedEvent = mapSessionEventForProtocol(event, deliveryKind, {
    seq: protocolSeq,
  });
  if (!mappedEvent) {
    return null;
  }
  return omitDuplicateScheduledToolInput(
    event,
    mappedEvent,
    options.toolInputTransmissions ?? getProtocolToolInputTransmissionState(record, deliveryKind),
  );
}

async function readProtocolSessionEvents(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
  options: { afterSeq?: number; limit?: number } = {},
): Promise<ZCodeSessionEvent[]> {
  const events = await record.eventStore.getEvents(record.app.sessionId as SessionId);
  const visibleEvents: ZCodeSessionEvent[] = [];
  const toolInputTransmissions: ZCodeProtocolToolInputTransmissionState = {
    streamedToolCallIdsWithInput: new Set(),
  };
  let pendingStreamingDeltaBatch: ProtocolStreamingDeltaBatch | undefined;
  const flushedFirstDeltaBatchKeys = new Set<string>();
  const lastFlushAtByBatchKey = new Map<string, number>();
  const pushMappedEvent = (event: SessionEvent): void => {
    const mappedEvent = mapProtocolSessionEvent(context, record, event, deliveryKind, {
      toolInputTransmissions,
    });
    if (!mappedEvent) return;
    if (options.afterSeq !== undefined && mappedEvent.seq <= options.afterSeq) return;
    visibleEvents.push(mappedEvent);
  };
  const flushPendingStreamingDeltaBatch = (): void => {
    if (!pendingStreamingDeltaBatch) {
      return;
    }
    rememberProtocolStreamingDeltaBatchFlush(lastFlushAtByBatchKey, pendingStreamingDeltaBatch);
    pushMappedEvent(materializeProtocolStreamingDeltaBatch(pendingStreamingDeltaBatch));
    pendingStreamingDeltaBatch = undefined;
  };
  const resetPendingStreamingDeltaBatch = (): void => {
    flushPendingStreamingDeltaBatch();
    flushedFirstDeltaBatchKeys.clear();
    lastFlushAtByBatchKey.clear();
  };
  for (const event of events) {
    if (
      shouldHideProtocolSessionEvent(record, event) ||
      !shouldExposeSessionEventToProtocol(event)
    ) {
      resetPendingStreamingDeltaBatch();
      pushMappedEvent(event);
      continue;
    }
    const deltaInfo = readStreamingDeltaBatchableEvent(event);
    if (deltaInfo) {
      if (
        pendingStreamingDeltaBatch &&
        pendingStreamingDeltaBatch.batchKey !== deltaInfo.batchKey
      ) {
        flushPendingStreamingDeltaBatch();
      }
      pendingStreamingDeltaBatch = mergeProtocolStreamingDeltaBatch(
        pendingStreamingDeltaBatch,
        event,
        deltaInfo,
      );
      if (deltaInfo.shouldFlushFirstDelta && !flushedFirstDeltaBatchKeys.has(deltaInfo.batchKey)) {
        flushPendingStreamingDeltaBatch();
        flushedFirstDeltaBatchKeys.add(deltaInfo.batchKey);
        continue;
      }
      if (
        pendingStreamingDeltaBatch.delta.length >= pendingStreamingDeltaBatch.maxChars ||
        shouldFlushProtocolStreamingDeltaBatchForInterval(
          pendingStreamingDeltaBatch,
          lastFlushAtByBatchKey,
        )
      ) {
        flushPendingStreamingDeltaBatch();
      }
      continue;
    }
    resetPendingStreamingDeltaBatch();
    pushMappedEvent(event);
  }
  flushPendingStreamingDeltaBatch();
  return options.limit ? visibleEvents.slice(-options.limit) : visibleEvents;
}

async function getProtocolEventSeq(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): Promise<number> {
  await readProtocolSessionEvents(context, record, deliveryKind);
  return getProtocolEventSequenceState(record, deliveryKind).lastSeq;
}

function logProtocolSessionEventSent(
  context: ZCodeProtocolAgentServerContext,
  sourceEvent: SessionEvent,
  mappedEvent: ZCodeSessionEvent,
): void {
  const payload =
    typeof mappedEvent.payload === "object" && mappedEvent.payload !== null
      ? (mappedEvent.payload as Record<string, unknown>)
      : {};
  const protocolMessage = {
    method: "session/event",
    params: mappedEvent,
  };
  context.logger?.debug("ZCode Protocol session event sent", {
    deliveryKind: mappedEvent.deliveryKind,
    event: "zcode_protocol.session_event.sent",
    eventId: mappedEvent.eventId,
    method: "session/event",
    module: "bootstrap.zcode_protocol",
    payloadKeys: Object.keys(payload).sort(),
    payloadKind: typeof payload.kind === "string" ? payload.kind : undefined,
    payloadSummary: summarizeProtocolPayload(payload),
    protocolMessageBytes: measureJsonBytes(protocolMessage),
    protocolPayloadBytes: measureJsonBytes(mappedEvent.payload),
    protocolEventType: mappedEvent.type,
    protocolSeq: mappedEvent.seq,
    sessionEventSequenceNumber: sourceEvent.sequenceNumber,
    sessionEventType: sourceEvent.type,
    sessionId: mappedEvent.sessionId,
    turnId: mappedEvent.turnId,
  });
}

function summarizeProtocolPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  copyStringFields(summary, payload, [
    "action",
    "anchorId",
    "assistantMessageId",
    "inputId",
    "kind",
    "queryId",
    "reason",
    "requestId",
    "resultPartId",
    "source",
    "status",
    "taskId",
    "terminalId",
    "toolCallId",
    "toolName",
  ]);
  copyBooleanFields(summary, payload, ["concurrentSafe", "destructive", "done", "readOnly"]);
  copyNumberFields(summary, payload, [
    "durationMs",
    "elapsedMs",
    "outputBytes",
    "stderrBytes",
    "stdoutBytes",
    "tokenCount",
    "toolCallCount",
  ]);
  copyByteLength(summary, payload, "content", "contentBytes");
  copyByteLength(summary, payload, "delta", "deltaBytes");
  copyByteLength(summary, payload, "input", "inputBytes");
  copyByteLength(summary, payload, "outputTail", "outputTailBytes");
  copyByteLength(summary, payload, "previousTarget", "previousTargetBytes");
  copyByteLength(summary, payload, "response", "responseBytes");
  copyByteLength(summary, payload, "result", "resultBytes");
  copyByteLength(summary, payload, "stderrTail", "stderrTailBytes");
  copyByteLength(summary, payload, "stdoutTail", "stdoutTailBytes");
  copyByteLength(summary, payload, "target", "targetBytes");
  copyObjectKeySummary(summary, payload, "input", "input");
  copyObjectKeySummary(summary, payload, "requestHeaders", "requestHeader");
  copyObjectKeySummary(summary, payload, "responseHeaders", "responseHeader");
  copyObjectKeySummary(summary, payload, "result", "result");
  copySmallObject(summary, payload, "usage");
  copyContextUsageBreakdownSummary(summary, payload);
  return summary;
}

function copyStringFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) {
      target[key] = value;
    }
  }
}

function copyBooleanFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "boolean") {
      target[key] = value;
    }
  }
}

function copyNumberFields(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  keys: string[],
): void {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      target[key] = value;
    }
  }
}

function copyByteLength(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  sourceKey: string,
  targetKey: string,
): void {
  if (source[sourceKey] !== undefined) {
    target[targetKey] = measureJsonBytes(source[sourceKey]);
  }
}

function copyObjectKeySummary(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  sourceKey: string,
  targetPrefix: string,
): void {
  const value = source[sourceKey];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const keys = Object.keys(value).sort();
  target[`${targetPrefix}KeyCount`] = keys.length;
  target[`${targetPrefix}Keys`] = keys.slice(0, 20);
}

function copySmallObject(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  sourceKey: string,
): void {
  const value = source[sourceKey];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  if (measureJsonBytes(value) <= 1024) {
    target[sourceKey] = value;
  }
}

function copyContextUsageBreakdownSummary(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  const value = source.contextUsageBreakdown;
  if (!Array.isArray(value)) {
    return;
  }
  target.contextUsageBreakdownCount = value.length;
  target.contextUsageBreakdownSources = value
    .map((item) => asRecord(item).source)
    .filter((source): source is string => typeof source === "string")
    .slice(0, 20);
}

function measureJsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
  } catch {
    return 0;
  }
}

function slugifyImportedSession(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return slug.length > 0 ? slug : "imported-session";
}

function isImportedHistoryMessage(
  message: MessageWithParts,
  source: NonNullable<ZCodeSessionCreateParams["importedHistory"]>["source"],
): boolean {
  const messageId = String(message.info.id);
  if (/^msg_import_\d+$/u.test(messageId) || messageId.startsWith("msg_claude-import-")) {
    return true;
  }
  const messageMetadata = asRecord((message.info as unknown as { metadata?: unknown }).metadata);
  if (messageMetadata.migrationSource === source) {
    return true;
  }
  return message.parts.some((part) => {
    const partMetadata = asRecord((part as unknown as { metadata?: unknown }).metadata);
    return partMetadata.migrationSource === source;
  });
}

async function removePreviousImportedSessionHistory(params: {
  sessionStore: NonNullable<ZCodeProtocolAgentServerContext["deps"]["sessionStore"]>;
  sessionId: SessionId;
  source: NonNullable<ZCodeSessionCreateParams["importedHistory"]>["source"];
}): Promise<number> {
  const existingMessages = await params.sessionStore.messages({
    sessionID: params.sessionId,
  });
  let removedCount = 0;
  for (const message of existingMessages) {
    if (!isImportedHistoryMessage(message, params.source)) {
      continue;
    }
    // Legacy import versions reused global fixed ids such as msg_import_0/msg_import_1.
    // A second imported session's saveMessage upsert would rebind the previous session's messages,
    // keeping the old time_created, ending with crossed messages, inverted order, or empty restores. Before re-importing, clean only
    // the current session's migrated messages, preserving real messages the user went on to write in the imported session.
    await params.sessionStore.removeMessage({
      sessionID: params.sessionId,
      messageID: message.info.id,
    });
    removedCount += 1;
  }
  return removedCount;
}

async function persistImportedSessionHistory(params: {
  context: ZCodeProtocolAgentServerContext;
  record: ZCodeProtocolSessionRecord;
  sessionId: SessionId;
  createParams: ZCodeSessionCreateParams;
}): Promise<void> {
  const importedHistory = params.createParams.importedHistory;
  const sessionStore = params.context.deps.sessionStore;
  if (!importedHistory) return;
  if (!sessionStore) {
    throw new ProtocolRequestError(-32003, "Cannot import session history without session store");
  }

  const workspace = params.record.workspace;
  const workspaceIdentity = workspace.workspaceIdentity?.trim();
  const now = Date.now();
  const createdAt =
    importedHistory.createdAt ??
    (importedHistory.source === "claudeCode"
      ? importedHistory.messages[0]?.timestamp
      : undefined) ??
    now;
  const updatedAt =
    importedHistory.source === "claudeCode"
      ? (importedHistory.updatedAt ?? importedHistory.messages.at(-1)?.timestamp ?? createdAt)
      : createdAt;
  // History imports do not execute models; when unbound, keep message content and never demand a current selection or fabricate a source.
  const currentModel = optionalModelSelectionFromString(params.record.app.getModel());
  const providerId = currentModel?.providerId as ModelProviderId | undefined;
  const modelId = currentModel?.modelId as ModelId | undefined;

  if (importedHistory.source === "sharedContext") {
    if (!sessionStore.commitSharedContextImportBundle) {
      throw new ProtocolRequestError(
        -32003,
        "Shared context import requires atomic session storage",
      );
    }
    const messageId = createMessageId(`${params.sessionId}_shared_context`);
    const importedAt = importedHistory.createdAt ?? now;
    const contextId =
      importedHistory.provenance.contextId ?? `legacy-shared-context-${params.sessionId}`;
    const contextStatus = importedHistory.provenance.status ?? "pending";
    await sessionStore.commitSharedContextImportBundle({
      session: {
        id: params.sessionId,
        projectID: projectIdFromDirectory(workspace.workspacePath),
        workspaceID: workspaceIdentity as WorkspaceId | undefined,
        traceID: params.record.traceContext.traceId,
        slug: slugifyImportedSession(params.sessionId),
        directory: workspace.workspacePath,
        path: workspace.workspacePath,
        title: importedHistory.title,
        titleSource: "custom",
        version: params.context.deps.version ?? "0.0.0",
        permission: { mode: params.record.app.getMode() },
        time: { created: importedAt, updated: importedAt },
      },
      contextMessage: {
        info: {
          id: messageId,
          sessionID: params.sessionId,
          role: "user",
          time: { created: importedAt },
          agent: "zcode-agent",
          // The new-share import path reused the legacy model field, referencing a dead variable and losing the unbounded semantics;
          // it now shares the structured-selection contract with plain imports; importing does not require an executable model.
          ...(currentModel ? { modelSelection: currentModel } : {}),
          synthetic: true,
          source: "shared_context",
          visibility: "model-only",
          semantics: {
            origin: "import",
            kind: "shared_context",
            source: "conversation_share",
            uiVisibility: "hidden",
            providerVisibility: "visible",
            transcriptVisibility: "visible",
          },
          metadata: {
            shareId: importedHistory.provenance.shareId,
            contextId,
            sharedContextStatus: contextStatus,
          },
        },
        parts: [
          {
            id: createPartId(`${params.sessionId}_shared_context_text`),
            sessionID: params.sessionId,
            messageID: messageId,
            type: "text",
            text: importedHistory.markdown,
            time: { start: importedAt, end: importedAt },
            metadata: { sharedContext: true },
          },
        ],
      },
      provenance: {
        // session_entry.id is the whole-store primary key (sibling fix in sqlite-session-store.ts's
        // fork command fact); the legacy template carried only shareId. Importing one share into a
        // second workspace misses the (shareCode, workspaceKey) dedupe and markers don't collide
        // within a workspace, so saveSessionEntry's on conflict(id) re-binds the first session's
        // provenance to the new session and the old session's shared-context record silently
        // disappears. Verified: every read goes through (session_id, type) + data.contextId, nothing
        // looks up by id, so old/new ids coexisting is safe — no data migration needed.
        id: `v4_shared_context_import:${params.sessionId}:${importedHistory.provenance.shareId}`,
        sessionID: params.sessionId,
        type: "v4/shared_context_import",
        time: { created: importedAt, updated: importedAt },
        data: {
          ...importedHistory.provenance,
          contextId,
          status: contextStatus,
        },
      },
    });
    return;
  }

  await sessionStore.createSession({
    id: params.sessionId,
    projectID: projectIdFromDirectory(workspace.workspacePath),
    // An imported session is resumed immediately after creation; persist the current identity first so resume cannot degrade to path-only identity.
    workspaceID: workspaceIdentity as WorkspaceId | undefined,
    traceID: params.record.traceContext.traceId,
    slug: slugifyImportedSession(params.sessionId),
    directory: workspace.workspacePath,
    path: workspace.workspacePath,
    title: importedHistory.title?.trim() || "Imported session",
    titleSource: "custom",
    version: params.context.deps.version ?? "0.0.0",
    permission: {
      mode: params.record.app.getMode(),
    },
    time: {
      created: createdAt,
      updated: Math.max(createdAt, updatedAt),
    },
  });

  const removedMessageCount = await removePreviousImportedSessionHistory({
    sessionStore,
    sessionId: params.sessionId,
    source: importedHistory.source,
  });
  let lastUserMessageId: MessageId | undefined;
  let lastImportedMessageTimestamp = createdAt - 1;
  for (const [index, message] of importedHistory.messages.entries()) {
    const rawTimestamp = message.timestamp ?? createdAt + index;

    // sessionStore reads messages ordered by time_created; if assistant predates user the UI shows
    // imported sessions assistant-first. The import boundary takes array order as truth and only
    // monotonicizes timestamps before the write, preserving content and roles.
    const timestamp =
      rawTimestamp > lastImportedMessageTimestamp ? rawTimestamp : lastImportedMessageTimestamp + 1;
    lastImportedMessageTimestamp = timestamp;
    const messageId = createMessageId(`${params.sessionId}_import_${index}`);
    if (message.role === "user") {
      lastUserMessageId = messageId;
      await sessionStore.saveMessage({
        id: messageId,
        sessionID: params.sessionId,
        role: "user",
        time: { created: timestamp },
        agent: "zcode-agent",
        ...(currentModel ? { modelSelection: currentModel } : {}),
        metadata: { migrationSource: importedHistory.source },
      });
    } else {
      await sessionStore.saveMessage({
        id: messageId,
        sessionID: params.sessionId,
        role: "assistant",
        time: { created: timestamp, completed: timestamp },
        parentID:
          lastUserMessageId ?? createMessageId(`${params.sessionId}_import_parent_${index}`),
        ...(currentModel ? { modelId, providerId } : {}),
        mode: params.record.app.getMode(),
        agent: "zcode-agent",
        path: {
          cwd: workspace.workspacePath,
          root: workspace.workspacePath,
        },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
        finish: "stop",
      });
    }
    await sessionStore.savePart({
      id: createPartId(`${params.sessionId}_import_${index}_text`),
      sessionID: params.sessionId,
      messageID: messageId,
      type: "text",
      text: message.content,
      time: { start: timestamp, end: timestamp },
      metadata: { migrationSource: importedHistory.source },
    });
  }

  params.context.logger?.info("ZCode Protocol imported history persisted", {
    event: "zcode_protocol.session_import.persisted",
    messageCount: importedHistory.messages.length,
    module: "bootstrap.zcode_protocol",
    removedMessageCount,
    sessionId: params.sessionId,
    source: importedHistory.source,
    workspaceKey: workspace.workspaceKey,
    workspacePath: workspace.workspacePath,
  });
}

export async function createSession(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  trace?: ZCodeProtocolTrace,
) {
  return createSessionWithProjection(context, rawParams, trace, async (record) => {
    const result = await snapshotWithDiagnostics(context, record);
    return {
      value: result.snapshot,
      phaseDurationsMs: result.phaseDurationsMs,
      messageCount: result.snapshot.messages.length,
    };
  });
}

/** V4 creation needs only the record; never force-parse an empty model for a discarded legacy snapshot. */
export async function createSessionRecordForV4(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  return createSessionWithProjection(context, rawParams, undefined, async (record) => ({
    value: { sessionId: record.app.sessionId },
  }));
}

async function createSessionWithProjection<T>(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  trace: ZCodeProtocolTrace | undefined,
  project: (
    record: ZCodeProtocolSessionRecord,
  ) => Promise<{ value: T; phaseDurationsMs?: SnapshotPhaseDurationsMs; messageCount?: number }>,
): Promise<T> {
  const params = parseParams(zcodeSessionCreateParamsSchema, rawParams);
  const startedAt = Date.now();
  if (params.sessionId && !params.importedHistory) {
    // If a plain session/create allowed a caller-supplied id it would overwrite the active record in context.sessions,
    // taking over a running session, leaking runtimes, or misrouting later setModel/sendPrompt.
    throw new ProtocolRequestError(
      -32602,
      "sessionId is only supported for imported history creates",
    );
  }
  const sessionId = (params.sessionId ?? createSessionId()) as SessionId;
  const workspace = params.workspace;
  context.logger?.info("ZCode Protocol session/create started", {
    event: "zcode_protocol.session_create.started",
    hasInitialModel: params.model !== undefined,
    hasInitialThoughtLevel: params.thoughtLevel !== undefined,
    inboundTraceId: trace?.traceId,
    module: "bootstrap.zcode_protocol",
    persistence: params.persistence,
    sessionId,
    status: "started",
    workspaceKey: workspace.workspaceKey,
    workspacePath: workspace.workspacePath,
  });
  const recordStartedAt = Date.now();
  const record = await materializeSessionRecord(
    context,
    { ...params, workspace },
    sessionId,
    false,
    { kind: "host" },
    trace,
  );
  const recordCreateDurationMs = Date.now() - recordStartedAt;
  context.assertServing?.();
  context.sessions.set(sessionId, record);
  let setInitialModelDurationMs: number | undefined;
  let setInitialThoughtLevelDurationMs: number | undefined;
  let snapshotDurationMs = 0;
  let snapshotPhaseDurationsMs: SnapshotPhaseDurationsMs | undefined;
  const initialModel = params.model;
  const initialThoughtLevel = params.thoughtLevel;
  try {
    await runSessionModelConfigMutation(record.app, async () => {
      if (initialModel) {
        const setInitialModelStartedAt = Date.now();
        await record.app.setModel(formatProtocolModelSelection(initialModel));
        setInitialModelDurationMs = Date.now() - setInitialModelStartedAt;
        record.stateRevision++;
      }
      const supportedInitialThoughtLevel = resolveSupportedAppThoughtLevel(
        record.app,
        initialThoughtLevel,
      );
      if (supportedInitialThoughtLevel) {
        // The app owns default model/reasoning persistence; session/create receives thoughtLevel explicitly.
        // Workspace Preferences must be read from persistence: agent-memory-only reads lose the user's last choice across restarts.
        const setInitialThoughtLevelStartedAt = Date.now();
        await record.app.setThoughtLevel(supportedInitialThoughtLevel);
        setInitialThoughtLevelDurationMs = Date.now() - setInitialThoughtLevelStartedAt;
        record.stateRevision++;
      } else if (initialThoughtLevel) {
        // A workspace default thoughtLevel may come from a previous model. When a new session inherits a different model,
        // never force an unsupported tier onto the runtime, or creation throws Unsupported reasoning effort.
        context.logger?.warn("ZCode Protocol session/create skipped unsupported thought level", {
          event: "zcode_protocol.session_create.thought_level_skipped",
          module: "bootstrap.zcode_protocol",
          requestedThoughtLevel: initialThoughtLevel,
          sessionId,
          supportedThoughtLevels: record.app.listThoughtLevels(),
          workspaceKey: workspace.workspaceKey,
          workspacePath: workspace.workspacePath,
        });
      }
    });
    if (params.importedHistory) {
      // History imports used to write only the legacy snapshot, so the taskId was not a real protocol sessionId and
      // setModel/sendPrompt hit a nonexistent runtime. This writes history into the sessionStore at creation and resumes,
      // making the import a resumable, model-switchable ZCode session from the first moment.
      await persistImportedSessionHistory({
        context,
        record,
        sessionId,
        createParams: params,
      });
      await record.app.resume();
      record.stateRevision++;
    }
    const snapshotStartedAt = Date.now();
    const createdSnapshotResult = await project(record);
    const createdSnapshot = createdSnapshotResult.value;
    snapshotPhaseDurationsMs = createdSnapshotResult.phaseDurationsMs;
    snapshotDurationMs = Date.now() - snapshotStartedAt;
    context.logger?.info("ZCode Protocol session/create completed", {
      durationMs: Date.now() - startedAt,
      event: "zcode_protocol.session_create.completed",
      hasInitialModel: initialModel !== undefined,
      hasInitialThoughtLevel: initialThoughtLevel !== undefined,
      messageCount: createdSnapshotResult.messageCount,
      module: "bootstrap.zcode_protocol",
      persistence: params.persistence,
      recordCreateDurationMs,
      rootTraceId: record.traceContext.traceId,
      sessionId,
      setInitialModelDurationMs,
      setInitialThoughtLevelDurationMs,
      snapshotPhaseDurationsMs,
      snapshotDurationMs,
      status: "completed",
      workspaceKey: workspace.workspaceKey,
      workspacePath: workspace.workspacePath,
    });
    return createdSnapshot;
  } catch (error) {
    context.logger?.warn("ZCode Protocol session/create failed", {
      durationMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.session_create.failed",
      module: "bootstrap.zcode_protocol",
      persistence: params.persistence,
      recordCreateDurationMs,
      rootTraceId: record.traceContext.traceId,
      sessionId,
      setInitialModelDurationMs,
      setInitialThoughtLevelDurationMs,
      snapshotPhaseDurationsMs,
      snapshotDurationMs,
      status: "failed",
      workspaceKey: workspace.workspaceKey,
      workspacePath: workspace.workspacePath,
    });
    // Draft creation seeds the user's last model choice.
    // If that model was deleted, the failed record must not stay in context.sessions: later
    // workspace state keeps reading a half-initialized app and model/thinking tiers cross-contaminate.
    record.unsubscribe?.();
    // v4 channel: events ingested during creation lazily build a publisher; failure cleanup
    // reclaims it too. Dispose before registry removal so session.removed can carry workspaceId.
    context.v4Gateway?.disposeSession(sessionId);
    context.sessions.delete(sessionId);
    try {
      await record.app.close?.();
    } catch {
      // Keep the original create-failure cause; close is only a best-effort cleanup of the half-initialized runtime.
    }
    // The in-memory event store dies with the record.
    await record.eventStore.deleteSession(sessionId as SessionId).catch(() => undefined);
    throw error;
  }
}

export interface ActivatedSessionForResume {
  record: ZCodeProtocolSessionRecord;
  knownSession?: SessionInfo;
  /** Only for seeding this V4 hydration; never written to the record or cached across requests. */
  persistedMessages?: MessageWithParts[];
}

/**
 * Restores only the session runtime lifecycle; materializes no protocol representation.
 *
 // * V4 cold subscription used to reuse resumeSession; even with the return value discarded it still built a full legacy
 // * snapshot for large histories. Runtime activation and legacy representation are two jobs; this keeps
 // * the pre-snapshot ordering and side effects, and lets V4 hydrate from its own durable projection.
 */
export async function activateSessionForResume(
  context: ZCodeProtocolAgentServerContext,
  params: ZCodeSessionResumeParams,
  options: { reusePersistedMessages?: boolean } = {},
): Promise<ActivatedSessionForResume> {
  const resumeStartedAt = Date.now();
  const activeBeforeWait = context.sessions.has(params.sessionId);
  context.logger?.debug("ZCode Protocol session resume started", {
    activeBeforeWait,
    event: "zcode_protocol.session.resume_started",
    hasSessionStore: Boolean(context.deps.sessionStore),
    module: "bootstrap.zcode_protocol",
    sessionId: params.sessionId,
  });
  // Re-activation gate: while the session is under capacity deactivation (app.close finishing),
  // wait first so old/new apps never touch the same session resources concurrently. No in-flight -> return.
  await context.sessionResidentPool?.waitForDeactivation(params.sessionId);
  const existing = context.sessions.get(params.sessionId);
  if (existing) {
    return { record: existing };
  }
  let session = await getPersistedSession(context, params.sessionId);
  if (!session) {
    // Diagnostics: cold recovery reaches here only when the persisted record is missing too; the error text alone cannot be
    // told apart from readSession's "runtime not live", so log both layers' state and the wait duration.
    context.logger?.warn("ZCode Protocol session resume found no persisted record", {
      activeBeforeWait,
      activeSessionCount: context.sessions.size,
      durationMs: Math.max(0, Date.now() - resumeStartedAt),
      event: "zcode_protocol.session.resume_persisted_missing",
      hasSessionStore: Boolean(context.deps.sessionStore),
      module: "bootstrap.zcode_protocol",
      sessionId: params.sessionId,
    });
    throw new ProtocolRequestError(
      zcodeProtocolErrorCodes.sessionUnavailable,
      `Session not found: ${params.sessionId}`,
    );
  }
  session = await repairLegacyRemoteSessionWorkspaceForResume(context, session);
  const workspace =
    params.workspace ??
    buildWorkspaceRef({
      // A V4 history-session cold subscription passes only sessionId; rebuilding the workspace from the directory
      // alone would degrade identity to a path key, missing the workspaceID-isolated
      // provider registry, misjudging available models as unavailable and permanently triggering restoreWarning.
      workspaceIdentity: session.workspaceID,
      workspacePath: session.path ?? session.directory,
    });
  let persistedMessages = await readPersistedSessionMessages(context, params.sessionId);
  const mode = derivePersistedSessionMode(persistedMessages);
  // Shell-setting changes apply only to new sessions; cold restore must use the Bash shell
  // snapshot persisted at creation. runtime.resumeFromStore reads it; here, just don't re-inject
  // the current settings carried on the resume request into the old session.
  const record = await materializeSessionRecord(
    context,
    {
      ...params,
      mode,
      // The model is restored only via the app's one-way migration/current entry; never construct a selection from messages or caller hints first.
      model: undefined,
      ...(session.parentID ? { parentSessionId: String(session.parentID) } : {}),
      // resume used to drop the persisted taskType and createRecord fell back to "interactive", so
      // resumed workflow_child/subagent_child sessions passed the isTaskListSessionType filter,
      // leaked into sessions-index via getSessionWorkspaceId, the desktop task list grew fake
      // "workflow actor actor#N@k" tasks, and the task-index syncer kept session/resume-ing them.
      // The fork path always carried taskType; resume must too.
      taskType: session.taskType,
      workspace,
    },
    params.sessionId as SessionId,
    true,
    { kind: "host" },
    session.traceID ? { traceId: session.traceID } : undefined,
  );
  // createRecord hardcodes createdAt/updatedAt to Date.now(); resuming an old session
  // makes sessions-index treat it as just-created (with the empty pre-hydration title, the sidebar
  // shows the old session vanished and a "new task just now" appearing). The resume path backfills the store's real times.
  if (session.time?.created) record.createdAt = session.time.created;
  if (session.time?.updated) record.updatedAt = session.time.updated;
  context.assertServing?.();
  context.sessions.set(params.sessionId, record);
  const resumeResult = await runSessionModelConfigMutation(record.app, async () => {
    const result = options.reusePersistedMessages
      ? await record.app.resume({ persistedMessages })
      : await record.app.resume();
    // For the first projection seed only: a valid model with empty tier; not a second executable runtime selection.
    record.restoredModelSelection = result.modelSelection;
    return result;
  });
  if (options.reusePersistedMessages && resumeResult.persistedMessagesReloadRequired) {
    persistedMessages = await readPersistedSessionMessages(context, params.sessionId);
  }
  context.logger?.info("ZCode Protocol session resume completed", {
    activeSessionCount: context.sessions.size,
    durationMs: Math.max(0, Date.now() - resumeStartedAt),
    event: "zcode_protocol.session.resume_completed",
    module: "bootstrap.zcode_protocol",
    persistedMessageCount: persistedMessages.length,
    sessionId: params.sessionId,
    traceId: record.traceContext.traceId,
  });
  return {
    knownSession: session,
    record,
    ...(options.reusePersistedMessages ? { persistedMessages } : {}),
  };
}

export async function resumeSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionResumeParamsSchema, rawParams);
  const activated = await activateSessionForResume(context, params);
  return await snapshot(context, activated.record, activated.knownSession);
}

async function repairLegacyRemoteSessionWorkspaceForResume(
  context: ZCodeProtocolAgentServerContext,
  session: SessionInfo,
): Promise<SessionInfo> {
  if (session.workspaceID || !context.deps.sessionStore?.repairLegacyRemoteSessionWorkspace) {
    return session;
  }
  const legacyWorkspaceDirectory = session.path ?? session.directory;
  if (session.directory !== legacyWorkspaceDirectory) return session;
  const legacyRemote = resolveLegacyRemoteWorkspace(context, legacyWorkspaceDirectory);
  if (!legacyRemote) return session;

  const repaired = await context.deps.sessionStore.repairLegacyRemoteSessionWorkspace({
    sessionID: session.id,
    projectID: projectIdFromDirectory(legacyRemote.workspacePath),
    legacyWorkspaceDirectory,
    workspaceID: legacyRemote.workspaceIdentity,
    workspacePath: legacyRemote.workspacePath,
  });
  // After the atomic repair returns false the runtime would still materialize with the old directory/path and run tools
  // in the wrong cwd. Read the original persisted facts; an in-memory path repair on an existing identity must not pose as persisted.
  const refreshed = await context.deps.sessionStore.getSession(session.id);
  const repairPersisted =
    refreshed?.workspaceID === legacyRemote.workspaceIdentity &&
    refreshed.directory === legacyRemote.workspacePath &&
    refreshed.path === legacyRemote.workspacePath;
  if (!repairPersisted) {
    context.logger?.warn("legacy remote session workspace repair was not persisted", {
      event: "zcode_protocol.session_resume.legacy_remote_workspace_repair_rejected",
      legacyWorkspaceDirectory,
      legacyWorkspaceIdentity: legacyRemote.workspaceIdentity,
      module: "bootstrap.zcode_protocol",
      repaired,
      sessionId: session.id,
      workspacePath: legacyRemote.workspacePath,
    });
    throw createCoreError(
      CoreErrorType.SessionCorrupted,
      "Legacy remote session workspace repair was not persisted",
      {
        context: {
          directory: refreshed?.directory ?? session.directory,
          path: refreshed?.path ?? session.path,
          reason: "legacy_remote_session_workspace_repair_rejected",
          sessionId: session.id,
          workspaceIdentity: legacyRemote.workspaceIdentity,
        },
        recoverable: true,
      },
    );
  }
  if (repaired) {
    context.logger?.info("legacy remote session workspace repaired", {
      event: "zcode_protocol.session_resume.legacy_remote_workspace_repaired",
      legacyWorkspaceDirectory,
      legacyWorkspaceIdentity: legacyRemote.workspaceIdentity,
      module: "bootstrap.zcode_protocol",
      sessionId: session.id,
      workspacePath: legacyRemote.workspacePath,
    });
  }
  // core resumeFromStore re-reads the database; a NULL identity repair must persist first, not only change the bootstrap memory value.
  return refreshed;
}

function resolveLegacyRemoteWorkspace(
  context: ZCodeProtocolAgentServerContext,
  legacyWorkspaceDirectory: string,
): { workspaceIdentity: WorkspaceId; workspacePath: string } | null {
  const currentWorkspacePath = context.deps.cwd ?? process.cwd();
  const direct = parseRemoteWorkspaceIdentity(legacyWorkspaceDirectory);
  if (direct?.kind === "wsl" && direct.workspacePath === currentWorkspacePath) {
    return {
      workspaceIdentity: legacyWorkspaceDirectory as WorkspaceId,
      workspacePath: direct.workspacePath,
    };
  }

  const identityPrefix = currentWorkspacePath === "/" ? "/" : `${currentWorkspacePath}/`;
  if (!legacyWorkspaceDirectory.startsWith(identityPrefix)) return null;
  const embeddedIdentity = legacyWorkspaceDirectory.slice(identityPrefix.length);
  const embedded = parseRemoteWorkspaceIdentity(embeddedIdentity);
  if (
    embedded?.kind !== "wsl" ||
    `${identityPrefix}${embeddedIdentity}` !== legacyWorkspaceDirectory ||
    embedded.workspacePath !== currentWorkspacePath
  ) {
    return null;
  }

  // Accept only the exact shape built from the current app-server cwd; never fuzzy-search remote: prefixes in arbitrary paths.
  return {
    workspaceIdentity: embeddedIdentity as WorkspaceId,
    workspacePath: embedded.workspacePath,
  };
}

export async function listSessions(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionListParamsSchema, rawParams ?? {});
  const store = context.deps.sessionStore;
  // Explicit-id lookup reads persisted identity only, for the Host to repair stale indexes; never activate a runtime to identify a child.
  const stored = (
    params.sessionIds
      ? await Promise.all(params.sessionIds.map((id) => store?.getSession(id as SessionId) ?? null))
      : store
        ? await store.listSessions({
            directory: params.workspace?.workspacePath,
            includeArchived: params.includeArchived,
            limit: params.limit ?? 50,
            taskTypes: [...TASK_LIST_SESSION_TYPES],
          })
        : []
  ).filter((session): session is SessionInfo => {
    if (!session) return false;
    return (
      (params.includeArchived || session.time.archived === undefined) &&
      (!params.workspace ||
        (session.workspaceID?.trim() || session.path || session.directory) ===
          (params.workspace.workspaceIdentity?.trim() || params.workspace.workspacePath))
    );
  });
  const storedIds = new Set(stored.map((session) => String(session.id)));
  const sessions = stored.map((session) =>
    mapSessionInfo({
      session,
      workspace:
        params.workspace ?? buildWorkspaceRef({ workspacePath: session.path ?? session.directory }),
    }),
  );
  if (params.sessionIds) return { sessions };
  for (const record of context.sessions.values()) {
    if (record.persistence === "deferred") continue;
    if (!isTaskListSessionType(record.taskType)) continue;
    if (storedIds.has(record.app.sessionId)) continue;
    if (params.workspace && params.workspace.workspaceKey !== record.workspace.workspaceKey)
      continue;
    sessions.push(
      mapSessionInfo({
        app: record.app,
        workspace: record.workspace,
        taskType: record.taskType,
        parentSessionId: record.parentSessionId,
      }),
    );
  }
  return { sessions };
}

export async function listSessionSubagents(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  persistedMessages?: MessageWithParts[],
) {
  const params = parseParams(zcodeSessionSubagentsParamsSchema, rawParams ?? {});
  const store = context.deps.sessionStore;
  const liveParent = context.sessions.get(params.sessionId);
  if (!store) {
    return {
      revision: liveParent?.stateRevision ?? 0,
      childSessionIds: [],
      running: [],
      ended: { total: 0, items: [] },
    };
  }

  const parentSession = await store.getSession(params.sessionId as SessionId);
  if (!parentSession) {
    // Diagnostics: hydrate reuses the child-task seed read; when a task index/legacy ACP task leaves a stale id,
    // "persisted record missing" gets wrapped as v4.hydrate; log the call phase, not just the error text.
    context.logger?.warn("ZCode Protocol session subagents has no persisted parent", {
      activeSessionCount: context.sessions.size,
      activeSession: Boolean(liveParent),
      event: "zcode_protocol.session.persisted_missing",
      module: "bootstrap.zcode_protocol",
      operation: "session_subagents",
      sessionId: params.sessionId,
    });
    throw new ProtocolRequestError(
      zcodeProtocolErrorCodes.sessionUnavailable,
      `Session not found: ${params.sessionId}`,
    );
  }
  const messages = persistedMessages ?? (await store.messages({ sessionID: parentSession.id }));
  const parentEvents = liveParent
    ? await liveParent.eventStore.getEvents(parentSession.id).catch(() => [])
    : [];
  const childSessionIds = collectSubagentChildSessionIds(parentSession, messages, parentEvents);
  const childEntries = await Promise.all(
    childSessionIds.map(async (childSessionId) => {
      const childSession = await store.getSession(childSessionId as SessionId);
      if (!childSession || childSession.taskType !== "subagent_child") return null;
      const childMessages = await store.messages({
        sessionID: childSession.id,
      });
      const liveChild = context.sessions.get(childSessionId);
      const childProjection = liveChild
        ? await liveChild.app.runtime.getProjection().catch(() => undefined)
        : undefined;
      return { childMessages, childProjection, childSession, childSessionId };
    }),
  );
  const persistedChildren = childEntries.filter(
    (entry): entry is NonNullable<typeof entry> => entry !== null,
  );
  const parentProjection = liveParent
    ? await liveParent.app.runtime.getProjection().catch(() => undefined)
    : undefined;
  const projection = projectSessionSubagents({
    revision: liveParent?.stateRevision ?? parentSession.time.updated,
    parentSession,
    messages,
    childSessionsById: new Map(
      persistedChildren.map((entry) => [entry.childSessionId, entry.childSession]),
    ),
    childMessagesById: new Map(
      persistedChildren.map((entry) => [entry.childSessionId, entry.childMessages]),
    ),
    childProjectionsById: new Map(
      persistedChildren.flatMap((entry) =>
        entry.childProjection ? [[entry.childSessionId, entry.childProjection]] : [],
      ),
    ),
    ...(parentProjection ? { parentProjection } : {}),
    ...(parentEvents.length > 0 ? { parentEvents } : {}),
  });
  const ended = paginateEndedSubagents(projection.ended, {
    cursor: params.endedCursor,
    limit: params.endedLimit,
  });
  return {
    revision: projection.revision,
    childSessionIds: persistedChildren.map((entry) => entry.childSessionId),
    running: projection.running,
    ended: {
      total: projection.ended.length,
      items: ended.items,
      ...(ended.nextCursor ? { nextCursor: ended.nextCursor } : {}),
    },
  };
}

const APP_USAGE_RANGE_DAYS: Record<string, number> = { "7d": 7, "30d": 30 };

export async function getUsageStats(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeUsageStatsParamsSchema, rawParams ?? {});
  const timeZone = params.timeZone ?? "UTC";
  const until = Date.now();
  const tzOffsetMs = resolveTzOffsetMs(timeZone, until);
  const rangeDays = APP_USAGE_RANGE_DAYS[params.range] ?? 30;
  const since = params.range === "all" ? 0 : until - rangeDays * 86_400_000;
  const buildOptions = {
    range: params.range,
    timeZone,
    tzOffsetMs,
    generatedAt: until,
    since,
    until,
  };

  // SessionStorePort and UsageStorePort are separate interfaces, but the real store implements
  // both; narrow at runtime like core/usage-observability does for the read-only aggregates.
  const usageStore = context.deps.sessionStore as Partial<UsageStorePort> | undefined;
  if (!usageStore?.queryAppUsage) {
    // No usage store (should not happen): return an empty snapshot instead of throwing, so the UI can render an empty state.
    return buildAppUsageSnapshot(
      {
        totals: {
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          modelRequestCount: 0,
          modelErrorCount: 0,
          avgTimeToFirstTokenMs: null,
        },
        turnTotals: {
          totalSessions: 0,
          totalTurns: 0,
          avgTurnDurationMs: null,
          longestSessionMs: 0,
        },
        toolTotals: { toolCallCount: 0, toolErrorCount: 0 },
        models: [],
        tools: [],
        days: [],
        dayModels: [],
      },
      buildOptions,
    );
  }

  const result = await usageStore.queryAppUsage({ since, until, tzOffsetMs });
  return buildAppUsageSnapshot(result, buildOptions);
}

export async function readSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionReadParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId, {
    deliveryKind: params.deliveryKind,
    operation: "session_read",
  });
  record.deliveryKind = params.deliveryKind ?? record.deliveryKind;
  const result = await snapshot(context, record, undefined, {
    messageLimit: params.messageLimit,
    modelAvailability: "current",
  });
  // Task-index resync needs only title/search text/visibility/status; a full single-row history can reach ~15MB and saturate host stdio.
  // Build as full first, then trim large payloads, so index-derived fields stay consistent with full at the source.
  return params.contentProfile === "index" ? elideSessionSnapshotForIndex(result) : result;
}

/**
 // * Narrow read of V4 cold-recovery usage: reuses the legacy snapshot's metering without mapping the full protocol snapshot.
 */
export async function readSessionContextUsage(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  persistedMessages?: MessageWithParts[],
) {
  const record = context.sessions.get(sessionId);
  if (!record) return undefined;
  const [resolvedPersistedMessages, session, events] = await Promise.all([
    persistedMessages ?? readSessionMessages(context, record),
    getPersistedSession(context, sessionId),
    record.eventStore.getEvents(sessionId as SessionId),
  ]);
  // Keep legacy buildSessionSnapshot's read order: persisted facts first, then the runtime
  // projection. A first subscription during ModelComplete/rewind must not promote the projection
  // into the parallel phase via the narrow read — that would fabricate new cross-level combinations.
  const projection = await record.app.runtime.getProjection();
  const messages = projectActiveSessionMessages(
    resolvedPersistedMessages,
    session,
    events.filter((event) => event.type === SessionEventType.RewindTriggered),
  );
  return resolveSessionContextUsage({
    messages,
    persistedContextUsageBreakdownEvents: events,
    projection,
  });
}

export async function readMessages(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionMessagesParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  const allMessages = await readActiveSessionMessages(context, record);
  const afterMessageIndex = params.afterMessageId
    ? allMessages.findIndex((message) => String(message.info.id) === params.afterMessageId)
    : -1;
  const messages = afterMessageIndex >= 0 ? allMessages.slice(afterMessageIndex + 1) : allMessages;
  return {
    messages: params.limit ? messages.slice(-params.limit) : messages,
  };
}

export async function readEvents(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionEventsParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  return {
    events: await readProtocolSessionEvents(context, record, record.deliveryKind, {
      afterSeq: params.afterSeq,
      limit: params.limit,
    }),
  };
}

export async function subscribeSession(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeSessionSubscribeParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  record.deliveryKind = params.deliveryKind;
  // Compatibility guard: legacy replayable streams have no unsubscribe RPC. Record only real subscribes,
  // not the deliveryKind that session/read writes, or ordinary reads block resident reclamation forever.
  record.legacyStreamSubscribed = true;
  const events =
    params.afterSeq === undefined
      ? []
      : await readProtocolSessionEvents(context, record, record.deliveryKind, {
          afterSeq: params.afterSeq,
        });
  return {
    eventSeq: await getProtocolEventSeq(context, record, record.deliveryKind),
    events,
    sessionId: params.sessionId,
    snapshot: params.includeSnapshot
      ? await snapshot(context, record, undefined, {
          modelAvailability: "current",
        })
      : undefined,
  };
}

export async function sendPrompt(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionSendParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  // The legacy input path must keep subagents read-only too; never bypass V4 user-input admission.
  if (record.taskType === "subagent_child") {
    throw new ProtocolRequestError(-32010, "Subagent sessions are read-only", {
      reasonCode: "guard.subagentReadOnly",
    });
  }
  assertExpectedRevision(record, params.expectedRevision);
  assertExpectedProviderRevision(context, record, params.expectedProviderRevision);
  if (record.activeAbortController) {
    context.logger?.warn("ZCode Protocol session/send rejected: active prompt exists", {
      inputId: params.inputId,
      queryId: params.queryId,
      sessionId: params.sessionId,
      textLength: params.content.length,
      workspacePath: record.workspace.workspacePath,
    });
    throw new ProtocolRequestError(-32010, "A prompt is already running for this session");
  }
  if (record.restoreWarning) {
    throw new ProtocolRequestError(-32031, record.restoreWarning.message, {
      code: record.restoreWarning.type,
      sessionId: record.app.sessionId,
      workspace: record.workspace,
    });
  }
  await ensureSessionModelAvailableForNextTurn(context, record);
  if (record.persistence === "deferred") {
    // A draft session pre-send lives in neither sqlite; only when the user actually sends the first
    // message is it promoted to a normal session, so list/syncer/task index treat it as a real task.
    record.persistence = "immediate";
  }
  const abortController = new AbortController();
  record.activeAbortController = abortController;
  context.logger?.info("ZCode Protocol session/send accepted", {
    attachmentCount: params.attachments?.length ?? 0,
    inputId: params.inputId,
    queryId: params.queryId,
    sessionId: params.sessionId,
    textLength: params.content.length,
    workspacePath: record.workspace.workspacePath,
  });
  const inputId = params.inputId ?? (params.modelSelection ? crypto.randomUUID() : undefined);
  // Legacy attachment payloads also pin this selection via the same canonical intent, without touching the Session first. This only borrows the
  // shared metadata builder (not a V4 ACK/replay entry); without V4 admission the seq keeps its existing 0.
  const intent =
    params.modelSelection && inputId
      ? inputIntentMetadata(
          {
            commandId: inputId,
            clientId: "legacy-session-send",
            sessionId: params.sessionId,
            type: "sendText",
            payload: {},
            issuedAt: Date.now(),
          },
          {
            text: params.content,
            requestedDelivery: "startNow",
            modelSelection: params.modelSelection,
          },
        )
      : undefined;
  void runWithSessionResidencyFinalization(record, () =>
    runPromptTurnInBackground(context, record, {
      abortController,
      attachments: params.attachments,
      browserAmbientContext: params.browserAmbientContext,
      inputId,
      intent,
      modelExecution: params.modelExecution
        ? createModelExecutionContext(params.modelExecution)
        : undefined,
      queryId: (params.queryId ?? inputId) as QueryId | undefined,
      content: params.content,
      ...(params.automationId
        ? { automationId: params.automationId }
        : params.offPeakTaskId
          ? {
              offPeakTaskId: params.offPeakTaskId,
              ...(params.offPeakRunType ? { offPeakRunType: params.offPeakRunType } : {}),
            }
          : {}),
      toolDenylist: params.toolDenylist,
      botDeliveryTarget: params.botDeliveryTarget,
    }),
  ).catch(() => {
    // Background-turn failures surface through state/event streams; this backstop prevents unhandled rejections in the protocol process.
  });
  // session/send is only the "submit user input" protocol request; it must not synchronously await the whole model generation.
  // Waiting for the first token or the whole turn would trip the host timeout beyond 30s and block later session/resume, list, etc.
  // ACK immediately on input; the background turn reports progress via session event/state.updated.
  return afterPromptAccepted(context, record, "prompt_started");
}

export async function compactSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionCompactParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  const activeTurn = record.app.runtime.getActiveTurnInfo();
  if (activeTurn?.kind === "compact") {
    // A repeated /compact is context maintenance for the same session: while one is running, drop
    // further ones instead of queueing them as prompts/steers or rendering a failed-compact bar.
    return {
      response: "",
      snapshot: await snapshot(context, record, undefined, {
        modelAvailability: "current",
      }),
      compact: {
        state: "already_running" as const,
        ...(params.inputId ? { inputId: params.inputId } : {}),
      },
    };
  }
  ensureNoActiveTurn(record, "Cannot compact while a prompt is running");
  if (record.restoreWarning) {
    throw new ProtocolRequestError(-32031, record.restoreWarning.message, {
      code: record.restoreWarning.type,
      sessionId: record.app.sessionId,
      workspace: record.workspace,
    });
  }
  await ensureSessionModelAvailableForNextTurn(context, record);
  const instructions = params.instructions?.trim();
  const command = instructions ? `/compact ${instructions}` : "/compact";
  const abortController = new AbortController();
  // The real compact model request runs in the background, but Stop still interrupts via record.activeAbortController.
  // Without registering the controller, the in-flight compact model request runs to natural completion.
  record.activeAbortController = abortController;
  void runWithSessionResidencyFinalization(record, () =>
    runCompactTurnInBackground(context, record, {
      abortController,
      command,
      inputId: params.inputId,
    }),
  ).catch(() => {
    // Background-compact failures surface through the compact timeline/state.updated; this backstop prevents unhandled rejections.
  });
  record.stateRevision++;
  record.updatedAt = Date.now();
  const acceptedSnapshot = await snapshot(context, record, undefined, {
    modelAvailability: "current",
  });
  emitStateUpdated(context, record, "compact_started", { status: "running" });
  return {
    response: "",
    snapshot: acceptedSnapshot,
    compact: {
      state: "accepted" as const,
      ...(params.inputId ? { inputId: params.inputId } : {}),
    },
  };
}

async function runCompactTurnInBackground(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: {
    abortController: AbortController;
    command: string;
    inputId?: string;
  },
): Promise<void> {
  const startedAt = Date.now();
  let mutationReason = "session_compacted";
  context.logger?.info("ZCode Protocol background compact started", {
    inputId: params.inputId,
    sessionId: record.app.sessionId,
    workspacePath: record.workspace.workspacePath,
  });
  try {
    await record.app.submitPrompt(params.command, {
      abortSignal: params.abortController.signal,
      inputId: params.inputId,
    });
    context.logger?.info("ZCode Protocol background compact completed", {
      durationMs: Date.now() - startedAt,
      inputId: params.inputId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } catch (error) {
    mutationReason = params.abortController.signal.aborted
      ? "session_compact_cancelled"
      : "session_compact_failed";
    context.logger?.warn("ZCode Protocol background compact failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      inputId: params.inputId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } finally {
    if (record.activeAbortController === params.abortController) {
      // After compact finishes, release the active lock before broadcasting state, or a queued
      // prompt or later /compact briefly hits the old controller at the ready boundary.
      record.activeAbortController = undefined;
    }
  }
  await afterStateMutation(context, record, mutationReason);
}

export async function goalSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionGoalParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  // /goal writes goal state, not a plain prompt; aside from pause, running it mid-turn would bypass the frontend queue and pollute the current turn.
  // pause is the control-plane command for the user stopping the active goal; it must be able to interrupt the current assistant turn or verifier.
  const goalPauseMayInterruptActiveTurn = params.action === "pause";
  if (!goalPauseMayInterruptActiveTurn) {
    ensureNoActiveTurn(record, "Cannot manage goals while a prompt is running");
  }

  if (
    !record.app.readTarget ||
    !record.app.setTarget ||
    !record.app.updateTargetStatus ||
    !record.app.clearTarget
  ) {
    return {
      response: "Goal management is not available in this client.",
      snapshot: await snapshot(context, record),
      startedTurn: false,
    };
  }

  if (params.action === "show") {
    return {
      response: formatGoalSummary(await record.app.readTarget()),
      snapshot: await snapshot(context, record),
      startedTurn: false,
    };
  }

  if (params.action === "pause") {
    const activeAbortController = record.activeAbortController;
    const target = await record.app.updateTargetStatus("paused");
    if (target && activeAbortController) {
      context.logger?.info("ZCode Protocol goal pause aborting active turn", {
        inputId: params.inputId,
        sessionId: params.sessionId,
        targetId: target.targetID,
        workspacePath: record.workspace.workspacePath,
      });
      activeAbortController.abort(new Error("ZCode Protocol goal paused"));
    }
    const snapshotAfterGoal = await afterStateMutation(context, record, "goal_paused");
    return {
      // pause is a state-control action; the UI already reflects the result via the goal panel and runtime settlement.
      // Returning "Goal paused Objective..." renders a meaningless assistant bubble that repeats the goal body.
      response: target ? "" : "No goal to pause.",
      snapshot: snapshotAfterGoal,
      startedTurn: false,
    };
  }

  if (params.action === "resume") {
    const target = await record.app.updateTargetStatus("active");
    if (!target) {
      return {
        response: "No goal to resume.",
        snapshot: await snapshot(context, record),
        startedTurn: false,
      };
    }
    return await continueGoalAfterChange(context, record, {
      inputId: params.inputId,
      reason: "goal_resumed",
      target,
      title: "Goal resumed",
    });
  }

  if (params.action === "clear") {
    const cleared = await record.app.clearTarget();
    const snapshotAfterGoal = await afterStateMutation(context, record, "goal_cleared");
    return {
      response: cleared ? "Goal cleared." : "No goal to clear.",
      snapshot: snapshotAfterGoal,
      startedTurn: false,
    };
  }

  const objective = params.objective?.trim() ?? "";
  if (objective.length === 0) {
    return {
      response:
        params.action === "replace"
          ? "Usage: /goal replace <objective>"
          : "Usage: /goal <objective>",
      snapshot: await snapshot(context, record),
      startedTurn: false,
    };
  }

  // /goal <new goal> in the app input is an explicit new goal; with one present, demanding replace
  // makes users think it changed while the DB keeps the old one. Converge repeated set onto replace.
  const replacesExistingGoal =
    params.action === "replace" || Boolean(await record.app.readTarget());

  const target = await record.app.setTarget({ objective, status: "active" });
  return await continueGoalAfterChange(context, record, {
    inputId: params.inputId,
    reason: replacesExistingGoal ? "goal_replaced" : "goal_set",
    target,
    title: "Goal active",
  });
}

export async function forkSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionForkParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  ensureNoActiveTurn(record, "Cannot fork while a prompt is running");
  const forkTarget = await resolveForkTarget(context, record, params.target);
  const parentMode = record.app.getMode();
  const parentModel = record.app.getModel();
  const parentThoughtLevel = record.app.getThoughtLevel();
  const fork = await record.app.forkFromCheckpoint({
    targetCheckpointId: forkTarget.targetCheckpointId,
    targetMessageId: forkTarget.targetMessageId,
  });
  return await registerForkedSession(context, record, fork, {
    runtimeConfig: {
      mode: parentMode,
      model: parentModel,
      thoughtLevel: parentThoughtLevel,
    },
    inheritLatestTarget: true,
  });
}

/**
 // * Only the child record is registered after the core copy. The V4 running fork reuses this host lifecycle
 // * but never enters forkSession's active-turn guard/workspace fork; runtimeConfig can be pinned at the fork point.
 */
export async function registerForkedSession(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  fork: Awaited<ReturnType<ZCodeProtocolSessionRecord["app"]["forkFromCheckpoint"]>>,
  options: {
    runtimeConfig: {
      mode: CollaborationMode;
      model: string;
      thoughtLevel?: string;
      followupMode?: "queue" | "guide";
    };
    inheritLatestTarget: boolean;
  },
) {
  const parentMode = options.runtimeConfig.mode;
  const parentModel = options.runtimeConfig.model;
  const parentThoughtLevel = options.runtimeConfig.thoughtLevel;
  const parentFollowupMode = options.runtimeConfig.followupMode;
  const forkedSession = await getPersistedSession(context, fork.forkedSessionId);
  if (!forkedSession) {
    throw new Error(`Persisted child session not found: ${fork.forkedSessionId}`);
  }
  const forkRecord = await materializeSessionRecord(
    context,
    {
      sessionId: fork.forkedSessionId,
      mode: parentMode,
      // Copying history is allowed with an unbound parent too; never pick a default model or resolve an empty string just because of the fork.
      model: optionalModelSelectionFromString(parentModel),
      ...(fork.parentSessionId ? { parentSessionId: fork.parentSessionId } : {}),
      taskType: forkedSession.taskType,
      workspace: record.workspace,
    },
    fork.forkedSessionId as SessionId,
    true,
    { kind: "inherit", parent: record },
  );
  context.assertServing?.();
  context.sessions.set(fork.forkedSessionId, forkRecord);
  await runSessionModelConfigMutation(forkRecord.app, async () => {
    // A fork branches the parent's live state; copying messages alone would restore the new record from workspace defaults,
    // so the post-fork model/mode would be overwritten by the newest defaults. Inherit the parent's settings explicitly before resume.
    if (forkRecord.app.getMode() !== parentMode) {
      await forkRecord.app.setMode(parentMode);
      forkRecord.stateRevision++;
    }
    if (parentModel && forkRecord.app.getModel() !== parentModel) {
      await forkRecord.app.setModel(parentModel);
      forkRecord.stateRevision++;
    }
    if (parentThoughtLevel && forkRecord.app.getThoughtLevel() !== parentThoughtLevel) {
      await forkRecord.app.setThoughtLevel(parentThoughtLevel);
      forkRecord.stateRevision++;
    }
    if (parentFollowupMode && parentFollowupMode !== "queue") {
      await forkRecord.app.setFollowupMode(parentFollowupMode);
      forkRecord.stateRevision++;
    }
  });
  if (options.inheritLatestTarget) {
    await inheritForkedSessionTarget(context, record, forkRecord, fork.forkedSessionId);
  }
  await forkRecord.app.resume();
  return {
    forkedSessionId: fork.forkedSessionId,
    parentSessionId: fork.parentSessionId,
    targetMessageId: fork.targetMessageId,
    targetCheckpointId: fork.targetCheckpointId,
    response: fork.response,
    snapshot: await snapshot(context, forkRecord, forkedSession),
  };
}

async function inheritForkedSessionTarget(
  context: ZCodeProtocolAgentServerContext,
  parentRecord: ZCodeProtocolSessionRecord,
  forkRecord: ZCodeProtocolSessionRecord,
  forkedSessionId: string,
) {
  const parentTarget = await parentRecord.app.readTarget();
  if (!parentTarget || !context.deps.sessionStore) {
    return;
  }
  const existingChildTarget = await context.deps.sessionStore.readTarget({
    sessionID: forkedSessionId as SessionId,
  });
  if (existingChildTarget) {
    return;
  }
  if (!context.deps.sessionStore.cloneTargetForFork) {
    return;
  }

  // core fork now copies goal state; bootstrap keeps only the legacy/fake-app fallback. Never
  // setTarget a new targetId or the verifier timeline disconnects from the copied transcript.
  await context.deps.sessionStore.cloneTargetForFork({
    sessionID: forkedSessionId as SessionId,
    source: parentTarget,
    status: parentTarget.status,
  });
  forkRecord.stateRevision++;
  forkRecord.updatedAt = Date.now();
}

async function runPromptTurnInBackground(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: {
    abortController: AbortController;
    intent?: SendInputOptions["intent"];
    modelExecution?: SendInputOptions["modelExecution"];
    attachments?: unknown[];
    browserAmbientContext?: {
      tabCount: number;
      currentUrl?: string;
    };
    inputId?: string;
    queryId?: QueryId;
    content: string;
    toolDenylist?: readonly string[];
    botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
  } & TurnBackgroundAttribution,
): Promise<void> {
  const startedAt = Date.now();
  context.logger?.info("ZCode Protocol background turn started", {
    inputId: params.inputId,
    queryId: params.queryId,
    sessionId: record.app.sessionId,
    textLength: params.content.length,
    workspacePath: record.workspace.workspacePath,
  });
  let mutationReason = "prompt_completed";
  const previousAutomationId = record.activeAutomationId;
  const previousOffPeakTaskId = record.activeOffPeakTaskId;
  const previousBotDeliveryTarget = record.activeBotDeliveryTarget;
  const activeAutomationId = resolvePromptTurnAutomationId(params);
  const activeOffPeakTaskId = resolvePromptTurnOffPeakTaskId(params);
  const turnToolDisallowlist = buildPromptTurnToolDisallowlist(
    params,
    activeAutomationId,
    activeOffPeakTaskId,
  );
  if (activeAutomationId) {
    // Attachment input still uses legacy session/send; automation dispatch may omit automationId,
    // but inputId keeps the automation-* runId. Mark it here so CronCreate can't recursively create
    // scheduled tasks inside a bound active session.
    record.activeAutomationId = activeAutomationId;
  }
  if (activeOffPeakTaskId) {
    // Idle-dispatch turn same-shape backstop marker, for offpeak-port to reject recursive OffPeakCreate.
    record.activeOffPeakTaskId = activeOffPeakTaskId;
  }
  record.activeBotDeliveryTarget = params.botDeliveryTarget;
  try {
    const admission = await record.app.sendInput(
      {
        attachments: mapProtocolPromptAttachments(params.attachments),
        text: params.content,
      },
      {
        abortSignal: params.abortController.signal,
        intent: params.intent,
        modelExecution: params.modelExecution,
        browserAmbientContext: params.browserAmbientContext,
        inputId: params.inputId,
        queryId: params.queryId,
        ...(params.automationId
          ? { automationId: params.automationId }
          : params.offPeakTaskId
            ? {
                offPeakTaskId: params.offPeakTaskId,
                ...(params.offPeakRunType ? { offPeakRunType: params.offPeakRunType } : {}),
              }
            : {}),
        // legacy session/send can also reuse the active runtime; port-only rejection still lets the
        // model see CronCreate and possibly switch to CronDelete after failure. Later inputs in
        // automation turns and cron-task sessions are removed from this turn's provider tool surface.
        ...(turnToolDisallowlist ? { toolDisallowlist: turnToolDisallowlist } : {}),
      },
    );
    // admission is not the end of the turn. Early cleanup loses automation attribution and the Stop controller;
    // the ACK was already returned by session/send; background releases this turn's resources on real completion only.
    if (admission.kind === "rejected") {
      throw new ProtocolRequestError(-32010, `Prompt admission rejected: ${admission.reason}`);
    }
    if (admission.kind === "started_turn") await admission.completion;
    context.logger?.info("ZCode Protocol background turn completed", {
      durationMs: Date.now() - startedAt,
      inputId: params.inputId,
      queryId: params.queryId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } catch (error) {
    mutationReason = "prompt_failed";
    context.logger?.warn("ZCode Protocol background turn failed", {
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      inputId: params.inputId,
      sessionId: record.app.sessionId,
      workspacePath: record.workspace.workspacePath,
    });
  } finally {
    if (record.activeAbortController === params.abortController) {
      // prompt_completed/prompt_failed are the downstream host queue's ready boundary. Release the
      // active lock before broadcasting state, or a phone-side drain right after ready is rejected
      // by session/send with "A prompt is already running for this session".
      record.activeAbortController = undefined;
      context.logger?.info("ZCode Protocol background turn cleared active controller", {
        durationMs: Date.now() - startedAt,
        inputId: params.inputId,
        sessionId: record.app.sessionId,
        workspacePath: record.workspace.workspacePath,
      });
    }
    record.activeAutomationId = previousAutomationId;
    record.activeOffPeakTaskId = previousOffPeakTaskId;
    // Root cause: legacy records are reused across turns; restore the Bot address or scheduled
    // tasks created by later plain UI turns wrongly inherit the previous turn's Bot session.
    record.activeBotDeliveryTarget = previousBotDeliveryTarget;
  }
  await afterStateMutation(context, record, mutationReason);
}

function buildPromptTurnToolDisallowlist(
  params: {
    automationId?: string;
    offPeakTaskId?: string;
    inputId?: string;
    toolDenylist?: readonly string[];
  },
  activeAutomationId = params.automationId,
  activeOffPeakTaskId = params.offPeakTaskId,
): readonly string[] | undefined {
  const tools = new Set(params.toolDenylist ?? []);
  if (activeAutomationId) tools.add("CronCreate");
  // Off-peak dispatch rounds hide OffPeakCreate (no recursive self-derivation); OffPeakList stays read-only.
  // read-only. Automation rounds keep OffPeakCreate — cron rounds may derive idle tasks on schedule.
  // SendMessage/Workflow hide it too, matching v4 prompt-turn and core turn-loop-state.
  if (activeOffPeakTaskId) {
    for (const toolName of ["OffPeakCreate", "SendMessage", "Workflow"]) tools.add(toolName);
  }
  return tools.size > 0 ? [...tools] : undefined;
}

function resolvePromptTurnAutomationId(params: {
  automationId?: string;
  inputId?: string;
}): string | undefined {
  const explicit = params.automationId?.trim();
  if (explicit) return explicit;
  const inputId = params.inputId?.trim();
  if (!inputId?.startsWith("automation-")) return undefined;
  const separatorIndex = inputId.indexOf(":");
  const automationId = separatorIndex >= 0 ? inputId.slice(0, separatorIndex) : inputId;
  return automationId.length > "automation-".length ? automationId : undefined;
}

function resolvePromptTurnOffPeakTaskId(params: {
  offPeakTaskId?: string;
  inputId?: string;
}): string | undefined {
  const explicit = params.offPeakTaskId?.trim();
  if (explicit) return explicit;
  // Fallback: resumed-dispatch inputIds look like `offpeak-<uuid>:resume:<uuid>` (the leading
  // traceId has no fixed prefix); the primary signal must be the explicit offPeakTaskID.
  const inputId = params.inputId?.trim();
  if (!inputId?.startsWith("offpeak-")) return undefined;
  const separatorIndex = inputId.indexOf(":");
  const offPeakTaskId = separatorIndex >= 0 ? inputId.slice(0, separatorIndex) : inputId;
  return offPeakTaskId.length > "offpeak-".length ? offPeakTaskId : undefined;
}

async function continueGoalAfterChange(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: {
    inputId?: string;
    reason: string;
    target: ProtocolGoalTarget;
    title: string;
  },
) {
  const response = formatGoalChanged(params.title, params.target);
  const isPlanMode = record.app.runtime.getPlanEnabled?.() ?? record.app.getMode?.() === "plan";
  // continueActiveTarget is a required App capability; continuation depends only on the mode and any active turn.
  const canContinue = !isPlanMode && !record.activeAbortController;

  if (canContinue) {
    await ensureSessionModelAvailableForNextTurn(context, record);
    const abortController = new AbortController();
    record.activeAbortController = abortController;
    void runWithSessionResidencyFinalization(record, () =>
      runGoalContinuationInBackground(context, record, {
        abortController,
        inputId: params.inputId,
      }),
    ).catch(() => {
      // Background goal-continuation failures surface via state/event streams; this backstop prevents unhandled rejections.
    });
  }

  const snapshotAfterGoal = await afterStateMutation(context, record, params.reason);
  return {
    response: isPlanMode ? appendPlanModeGoalContinuationNote(response) : response,
    snapshot: snapshotAfterGoal,
    startedTurn: canContinue,
  };
}

async function runGoalContinuationInBackground(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: {
    abortController: AbortController;
    inputId?: string;
  },
): Promise<void> {
  let mutationReason = "goal_continuation_completed";
  try {
    await record.app.continueActiveTarget?.({
      abortSignal: params.abortController.signal,
      inputId: params.inputId,
    });
  } catch {
    mutationReason = "goal_continuation_failed";
  } finally {
    if (record.activeAbortController === params.abortController) {
      // Release the active lock as soon as the continuation itself ends; snapshot/command discovery is broadcast afterwards,
      // and holding the lock longer would misjudge consecutive /goal commands as an existing active turn.
      record.activeAbortController = undefined;
    }
  }
  await afterStateMutation(context, record, mutationReason);
}

export async function stopSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionStopParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  const hadActivePrompt = Boolean(record.activeAbortController);
  let pausedTarget: ProtocolGoalTarget | null = null;
  context.logger?.info("ZCode Protocol session/stop received", {
    hadActivePrompt,
    sessionId: params.sessionId,
    workspacePath: record.workspace.workspacePath,
  });
  if (hadActivePrompt) {
    pausedTarget = await pauseActiveGoalForSessionStop(context, record, {
      sessionId: params.sessionId,
    });
  }
  record.activeAbortController?.abort(new Error("ZCode Protocol session stopped"));
  if (pausedTarget) {
    await afterStateMutation(context, record, "session_stop_goal_paused");
  }
  return {};
}

async function pauseActiveGoalForSessionStop(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  params: { sessionId: string },
): Promise<ProtocolGoalTarget | null> {
  if (!record.app.readTarget || !record.app.updateTargetStatus) {
    return null;
  }
  const target = await record.app.readTarget();
  if (!target || target.status !== "active") {
    return null;
  }

  try {
    // If Stop only aborts the controller and the goal verifier misses the abort, the active goal
    // survives with stopRequested still held and the queue can never drain.
    const pausedTarget = await record.app.updateTargetStatus("paused");
    if (pausedTarget) {
      context.logger?.info("ZCode Protocol session/stop paused active goal", {
        sessionId: params.sessionId,
        targetId: pausedTarget.targetID,
        workspacePath: record.workspace.workspacePath,
      });
    }
    return pausedTarget;
  } catch (error) {
    context.logger?.warn("ZCode Protocol session/stop failed to pause active goal", {
      error: error instanceof Error ? error.message : String(error),
      sessionId: params.sessionId,
      targetId: target.targetID,
      workspacePath: record.workspace.workspacePath,
    });
    return null;
  }
}

export async function cancelBackgroundTask(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeSessionCancelBackgroundTaskParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  context.logger?.info("ZCode Protocol session/cancelBackgroundTask received", {
    sessionId: params.sessionId,
    taskId: params.taskId,
    workspacePath: record.workspace.workspacePath,
  });

  if (!record.app.cancelBackgroundTask) {
    throw new ProtocolRequestError(
      -32031,
      "Background task cancellation is not supported by this session runtime",
      {
        sessionId: params.sessionId,
        taskId: params.taskId,
      },
    );
  }

  const result = await record.app.cancelBackgroundTask(params.taskId);
  // A background bash cancel is a runtime-state change, not a normal prompt terminal.
  // Emit state.updated immediately so desktop continuous and phone replayable each refresh their projection at their own snapshot boundary.
  await afterStateMutation(context, record, "background_task_cancelled");
  return result;
}

export async function setModel(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionSetModelParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  await runSessionModelConfigMutation(record.app, async () => {
    // Full session-config commands must not lose reasoning through identity strings; the shared setter validates/saves atomically.
    await record.app.setModel(params.model);
  });
  return await afterStateMutation(context, record, "model_changed");
}

export async function setThoughtLevel(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeSessionSetThoughtLevelParamsSchema, rawParams);
  if (!params.thoughtLevel) {
    throw new ProtocolRequestError(-32602, "thoughtLevel is required");
  }
  const thoughtLevel = params.thoughtLevel;
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  await runSessionModelConfigMutation(record.app, async () => {
    await record.app.setThoughtLevel(thoughtLevel);
  });
  return await afterStateMutation(context, record, "thought_level_changed");
}

export async function setMode(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionSetModeParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  assertExpectedRevision(record, params.expectedRevision);
  await record.app.setMode(params.mode);
  return await afterStateMutation(context, record, "mode_changed");
}

export async function closeSession(context: ZCodeProtocolAgentServerContext, rawParams: unknown) {
  const params = parseParams(zcodeSessionCloseParamsSchema, rawParams);
  const record = requireSession(context, params.sessionId);
  if (!shouldCloseSessionForExpectedPersistence(record.persistence, params.expectedPersistence)) {
    // Connection switches and first sends across devices can race. session/promotion... placeholder
    // the conditional close must decide atomically on the agent record, never on the renderer's stale snapshot.
    return { closed: false };
  }
  record.unsubscribe?.();
  // On session close, abort still-running plugin UI tool calls; the registry keeps no orphans.
  abortMcpUiToolCallsForSession(params.sessionId);
  // App-provided tools: end every pending page call of this session and drop the registrations.
  clearMcpUiAppToolsForSession(context, params.sessionId);
  // Drop all of this session's resource subscriptions (a uri unsubscribes from the server only at refcount zero).
  await record.app.unsubscribeMcpResourcesForUi?.(`${params.sessionId}|`).catch(() => 0);
  await record.app.close?.();
  // v4 channel: session close also clears publisher/subscription scheduling; reopen cold-starts
  // from snapshot. Dispose must precede registry removal — the gateway needs getSessionWorkspaceId
  // (reads context.sessions) to locate the workspace and push session.removed to index subscribers.
  context.v4Gateway?.disposeSession(params.sessionId);
  context.sessions.delete(params.sessionId);
  // The in-memory event store dies with the record.
  await record.eventStore.deleteSession(params.sessionId as SessionId);
  return { closed: true };
}

export function shouldCloseSessionForExpectedPersistence(
  currentPersistence: ZCodeSessionPersistence,
  expectedPersistence?: ZCodeSessionPersistence,
): boolean {
  return expectedPersistence === undefined || currentPersistence === expectedPersistence;
}

export async function generateWorkspaceText(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
) {
  const params = parseParams(zcodeWorkspaceGenerateTextParamsSchema, rawParams);
  const active = Array.from(context.sessions.values()).find(
    (record) => record.workspace.workspaceKey === params.workspace.workspaceKey,
  );
  const input = {
    selection: params.selection,
    ...(params.prompt ? { prompt: params.prompt } : {}),
    ...(params.messages ? { messages: params.messages } : {}),
    ...(params.tools
      ? {
          tools: params.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        }
      : {}),
    querySource: params.querySource,
    ...(params.maxOutputTokens ? { maxOutputTokens: params.maxOutputTokens } : {}),
  };
  const app =
    active?.app ??
    (await createWorkspaceZCodeApp(context, params.workspace, {
      env: context.deps.env,
      eventStore: context.deps.createSessionEventStore("workspace-generate-text"),
      runtimeConfig: {
        workingDirectory: params.workspace.workspacePath,
      },
      sessionStore: context.deps.sessionStore,
      version: context.deps.version,
    }));

  try {
    const result = await app.generateWorkspaceText(input, { abortSignal });
    return {
      text: result.text,
      selection: result.selection,
      finishReason: result.finishReason,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
    };
  } finally {
    if (!active) {
      await app.close?.();
    }
  }
}

function ensureNoActiveTurn(record: ZCodeProtocolSessionRecord, message: string): void {
  if (!record.activeAbortController) {
    return;
  }
  throw new ProtocolRequestError(-32010, message);
}

function appendPlanModeGoalContinuationNote(response: string): string {
  return `${response}\n\n${PLAN_MODE_GOAL_CONTINUATION_SKIPPED_MESSAGE}`;
}

function formatGoalSummary(target: ProtocolGoalTarget | null): string {
  if (!target) {
    return "No goal is set. Use /goal <objective> to set one.";
  }

  return formatGoalChanged(`Goal ${target.status}`, target);
}

function formatGoalChanged(title: string, target: ProtocolGoalTarget): string {
  const lines = [title, `Objective: ${target.objective}`];
  if (target.tokensUsed !== undefined || target.tokenBudget !== undefined) {
    const budget =
      target.tokenBudget === null || target.tokenBudget === undefined
        ? "none"
        : target.tokenBudget.toString();
    lines.push(`Usage: ${target.tokensUsed ?? 0} tokens / ${budget}`);
  }
  if (target.timeUsedSeconds !== undefined) {
    lines.push(`Time: ${target.timeUsedSeconds} seconds`);
  }
  return lines.join("\n");
}

function assertExpectedProviderRevision(
  _context: ZCodeProtocolAgentServerContext,
  _record: ZCodeProtocolSessionRecord,
  expectedProviderRevision: string | undefined,
): void {
  // Legacy-client field compat. Provider revision is managed by the in-process registry; no Host CAS.
  void expectedProviderRevision;
}

export async function ensureSessionModelAvailableForNextTurn(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): Promise<void> {
  if (await ensureSessionModelAvailable(context, record)) {
    record.stateRevision++;
  }
}

async function resolveForkTarget(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  target: ZCodeSessionHistoryTarget,
): Promise<{ targetCheckpointId?: string; targetMessageId?: string }> {
  if (target.kind === "latestCheckpoint") {
    return {};
  }
  if (target.kind === "checkpoint") {
    return { targetCheckpointId: target.checkpointId };
  }
  if (target.kind === "message") {
    return { targetMessageId: target.messageId };
  }
  return {
    targetMessageId: await resolveTurnMessageId(context, record, target.turnIndex, "assistant"),
  };
}

async function resolveTurnMessageId(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  turnIndex: number,
  role: "assistant" | "user",
): Promise<MessageId> {
  const messages = (await readActiveSessionMessages(context, record)).filter(
    isUserVisibleSessionMessage,
  );
  let currentTurn = -1;
  let lastAssistantForTargetTurn: MessageId | undefined;
  for (const message of messages) {
    if (message.info.role === "user") {
      if (role === "assistant" && currentTurn === turnIndex && lastAssistantForTargetTurn) {
        // The legacy fork/rewind turn target is "the assistant of the target turn", not "whatever is
        // still in the target turn when scanning to the end". The next user clears the found
        // assistant, so only the last turn was forkable; synthetic users like compact summaries and
        // fork notices even un-last the last turn. Return the stable target before leaving the turn.
        return lastAssistantForTargetTurn;
      }
      currentTurn += 1;
      if (role === "user" && currentTurn === turnIndex) {
        return message.info.id as MessageId;
      }
      continue;
    }
    if (message.info.role === "assistant" && currentTurn === turnIndex) {
      lastAssistantForTargetTurn = message.info.id as MessageId;
    }
  }
  if (role === "assistant" && lastAssistantForTargetTurn) {
    return lastAssistantForTargetTurn;
  }
  throw new ProtocolRequestError(
    zcodeProtocolErrorCodes.sessionUnavailable,
    `Cannot resolve ${role} message for turnIndex=${turnIndex}`,
  );
}

export async function getTaskTokenUsage(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeTaskTokenUsageParamsSchema, rawParams ?? {});
  const usageStore = context.deps.sessionStore as Partial<UsageStorePort> | undefined;
  if (!usageStore?.queryTaskUsage) {
    return {
      sessionId: params.sessionId,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      modelRequestCount: 0,
      modelErrorCount: 0,
      inputBaselineBySource: {},
    };
  }

  const usage = await usageStore.queryTaskUsage({
    sessionID: params.sessionId as SessionId,
  });
  return {
    sessionId: params.sessionId,
    totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cacheReadTokens: usage.cacheReadTokens,
    modelRequestCount: usage.modelRequestCount,
    modelErrorCount: usage.modelErrorCount,
    inputBaselineBySource: usage.inputBaselineBySource,
  };
}

/**
 // * Pure-configuration event set: they change only the session selection (model/collaboration mode), not user-message activity.
 // * These events do not bump record.updatedAt (= sessions-index lastActivityAt),
 // * so config ops never drive the sidebar to reorder by activity time.
 // * - ModelSelected / SessionModeChanged: pure config changes (model/mode switches).
 // * - SessionTitleUpdated: the title is session metadata; cold recovery re-emits title events for the v4 projection,
 // *   which must not present history tasks as just-active and float them to the top.
 // * - SessionResumed: opening/resuming is a read, not activity. The cold-recovery path just backfilled
 // *   record.updatedAt from the store's real time (see the resumeSession op note);
 // *   if a resume event then stamped Date.now() over it, opening/refreshing a task would float it to the top and reorder the whole list.
 // * - WorkspaceHookAdmissionUpdated: cold recovery re-evaluates workspace hook admission, not user activity;
 // *   missing it from the set, a post-SessionResumed admission event would show history tasks as "just now".
 // * - HookRun*: hook lifecycle is an internal turn/session execution detail; a normal turn already has message/tool
 // *   activity events maintaining time; a cold-recovery SessionStart hook must not manufacture user activity by itself.
 */
function isNonActivitySessionEvent(event: SessionEvent): boolean {
  return (
    event.type === SessionEventType.ModelSelected ||
    event.type === SessionEventType.SessionModeChanged ||
    event.type === SessionEventType.SessionTitleUpdated ||
    event.type === SessionEventType.SessionResumed ||
    event.type === SessionEventType.WorkspaceHookAdmissionUpdated ||
    event.type === SessionEventType.HookRunStarted ||
    event.type === SessionEventType.HookRunProgress ||
    event.type === SessionEventType.HookRunCompleted ||
    event.type === SessionEventType.HookRunFailed ||
    event.type === SessionEventType.HookRunBlocked
  );
}

/**
 // * record.persistence is the protocol-side mirror of the runtime's session-persisted fact: deferred = draft (not in session/list,
 // * not in sessions-index, reclaimable by a conditional close with expectedPersistence="deferred"). The first-send path promotes eagerly at
 // * accepted time (the close race needs an atomic check, see startPromptTurn / admission), but ANY path that persists via the runtime for the first time
 // * must move the session out of draft. A hub-started session is rowed by the runtime via a controlOnly
 // * kickoff turn: no first send, record stays deferred, sessions-index treats it as draft and skips it, and it never appears in the sidebar.
 // * So align once with runtime truth at the single ingress of the event stream: after persisting, the runtime emits at least one event
 // * (SessionTitleUpdated first_input), and the ingest right after pushes the session into sessions-index.
 // * A test-stub runtime may lack the method (as never); absence means no alignment.
 */
function reconcileRecordPersistence(record: ZCodeProtocolSessionRecord): void {
  if (record.persistence !== "deferred") return;
  if (record.app.runtime?.isSessionPersisted?.() === true) record.persistence = "immediate";
}

export function onSessionEvent(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
): void {
  const computerUseOperationEvent = mapComputerUseOperationEvent(event);
  if (computerUseOperationEvent) {
    try {
      // The desktop v4 main line has no legacy session/event deliveryKind subscription; the top notice must not
      // keep depending on that legacy gate. Send only content-less lifecycle metadata, parallel to the v4 projection, never blocking it.
      context.notify({
        method: zcodeProtocolMethods.computerUseOperationEvent,
        params: computerUseOperationEvent,
      });
      // This notify used to log only on throw; success was silent, so "the agent never sent" and
      // "sent but silently dropped host-side" were indistinguishable. The CLI's own jsonl logs debug level, enough to close the loop at the source.
      context.logger?.debug("Computer Use operation lifecycle notification sent", {
        event: "zcode_protocol.computer-use.operation-event.sent",
        eventId: computerUseOperationEvent.eventId,
        sessionId: computerUseOperationEvent.sessionId,
        kind: computerUseOperationEvent.kind,
        turnId:
          "turnId" in computerUseOperationEvent ? computerUseOperationEvent.turnId : undefined,
      });
    } catch (error) {
      context.logger?.warn("Computer Use operation lifecycle notification failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.computer-use.operation-event.failed",
        eventId: computerUseOperationEvent.eventId,
        sessionId: computerUseOperationEvent.sessionId,
        turnId:
          "turnId" in computerUseOperationEvent ? computerUseOperationEvent.turnId : undefined,
      });
    }
  }
  if (String(event.sessionId) !== record.app.sessionId) {
    // A subagent runtime reuses the parent runtime's external event sink, but raw child events
    // still belong to the child session. Ingesting unconditionally under the parent record id would leave the child topic
    // frozen once opened and could wrongly bump the parent task's activity time. Route by the event's own sessionId
    // and return; parent mirror events carry the parent sessionId and continue through the existing path below.
    context.v4Gateway?.ingestDetachedLiveSession(
      String(event.sessionId),
      event,
      record.app.sessionId,
    );
    return;
  }
  // record.updatedAt is the sessions-index lastActivityAt source (v4-bridge getSessionIndexMeta);
  // the sidebar sorts by it. Pure config/restore/title-metadata events are not user activity —
  // undifferentiated bumping let "switch model once/open a task" jump it to the top and resort all.
  const nonActivityEvent = isNonActivitySessionEvent(event);
  if (event.type === SessionEventType.ModelSelected) {
    // Recovery candidates serve the initial UI only; once a user's new choice lands, a later clear must not revive them.
    delete record.restoredModelSelection;
  }
  if (!nonActivityEvent) {
    record.updatedAt = Date.now();
  }
  reconcileRecordPersistence(record);
  // The debug bypass does not depend on chat subscription; place it before the deliveryKind check so diagnostics survive legacy unsubscribes.
  observeSessionDebug(record, event);
  // v4 channel: authoritative events feed the v4 projection/publishers unconditionally. v4 subscription does not depend on the legacy
  // deliveryKind subscription state; the gateway paces frames per subscriber profile.
  context.v4Gateway?.ingest(record.app.sessionId, event);
  if (!record.deliveryKind) return;
  const deltaInfo = readStreamingDeltaBatchableEvent(event);
  if (deltaInfo && !shouldHideProtocolSessionEvent(record, event)) {
    const batchState = getLiveProtocolStreamingDeltaBatchState(record, record.deliveryKind);
    if (batchState.batch && batchState.batch.batchKey !== deltaInfo.batchKey) {
      flushLiveProtocolStreamingDeltaBatch(context, record, record.deliveryKind);
    }
    batchState.batch = mergeProtocolStreamingDeltaBatch(batchState.batch, event, deltaInfo);
    if (
      deltaInfo.shouldFlushFirstDelta &&
      !batchState.flushedFirstDeltaBatchKeys.has(deltaInfo.batchKey)
    ) {
      flushLiveProtocolStreamingDeltaBatch(context, record, record.deliveryKind);
      batchState.flushedFirstDeltaBatchKeys.add(deltaInfo.batchKey);
      return;
    }
    if (
      batchState.batch.delta.length >= batchState.batch.maxChars ||
      shouldFlushProtocolStreamingDeltaBatchForInterval(
        batchState.batch,
        batchState.lastFlushAtByBatchKey,
      )
    ) {
      flushLiveProtocolStreamingDeltaBatch(context, record, record.deliveryKind);
    }
    return;
  }

  resetLiveProtocolStreamingDeltaBatch(context, record, record.deliveryKind);
  sendProtocolSessionEvent(context, record, event, record.deliveryKind);
}

function flushLiveProtocolStreamingDeltaBatch(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): void {
  const batchState = getLiveProtocolStreamingDeltaBatchState(record, deliveryKind);
  if (!batchState.batch) {
    return;
  }
  rememberProtocolStreamingDeltaBatchFlush(batchState.lastFlushAtByBatchKey, batchState.batch);
  const event = materializeProtocolStreamingDeltaBatch(batchState.batch);
  batchState.batch = undefined;
  // Perf fix: providers split Write/Edit inputs and reasoning/text outputs into many tiny deltas.
  // Merge adjacent diffs at the protocol boundary under a deterministic byte budget; the renderer still appends per delta without waking per packet.
  // Text feel uses SessionEvent.timestamp for low-frequency flush; never a live setTimeout, or replay cannot reproduce the boundaries.
  sendProtocolSessionEvent(context, record, event, deliveryKind);
}

function resetLiveProtocolStreamingDeltaBatch(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  deliveryKind?: ZCodeDeliveryKind,
): void {
  const batchState = getLiveProtocolStreamingDeltaBatchState(record, deliveryKind);
  flushLiveProtocolStreamingDeltaBatch(context, record, deliveryKind);
  batchState.flushedFirstDeltaBatchKeys.clear();
  batchState.lastFlushAtByBatchKey.clear();
}

function sendProtocolSessionEvent(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  event: SessionEvent,
  deliveryKind?: ZCodeDeliveryKind,
): void {
  const mappedEvent = mapProtocolSessionEvent(context, record, event, deliveryKind);
  if (!mappedEvent) return;
  context.notify({
    method: "session/event",
    params: mappedEvent,
  });
  logProtocolSessionEventSent(context, event, mappedEvent);
}

function integratedTerminalShellToExecutionSelection(
  selection: IntegratedTerminalShellSelection | undefined,
): ExecutionShellSelection | undefined {
  if (!selection || selection.mode === "auto") {
    return undefined;
  }
  return {
    display: {
      name: selection.dialect === "git-bash" ? "Git Bash" : "CMD",
    },
    dialect: selection.dialect,
    id: selection.id,
    label: selection.label,
    path: selection.path,
    source: "user-config",
  };
}

function resolveProtocolBashShellSelection(
  context: ZCodeProtocolAgentServerContext,
  selection: IntegratedTerminalShellSelection | undefined,
): ExecutionShellSelection {
  const configuredSelection = integratedTerminalShellToExecutionSelection(selection);
  return resolveEffectiveBashShellSelection({
    env: context.deps.env ?? process.env,
    override: configuredSelection,
    platform: context.deps.platform ?? process.platform,
  }).selection;
}

async function requestSessionRuntimePreferences(
  context: ZCodeProtocolAgentServerContext,
  sessionId: SessionId,
  scope: ZCodeSessionRuntimePreferencesScope,
  trace?: ZCodeProtocolTrace,
): Promise<ZCodeSessionRuntimePreferencesResult> {
  const startedAt = Date.now();
  // ZCodeProtocolTrace.traceId is a protocol-level string; LogContext wants a branded TraceId.
  // Assert once per the file's existing convention instead of converting at every log site.
  const traceId = trace?.traceId as TraceId | undefined;
  context.logger?.debug("ZCode Protocol runtime preferences request started", {
    event: "zcode_protocol.runtime_preferences.request_started",
    module: "bootstrap.zcode_protocol",
    scope,
    sessionId,
    traceId,
  });
  try {
    const result = await context.requestClient(
      zcodeProtocolMethods.sessionRequestRuntimePreferences,
      { sessionId, scope },
      zcodeSessionRuntimePreferencesResultSchema,
      {
        timeoutMs: ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
        ...(trace ? { trace } : {}),
      },
    );
    context.logger?.debug("ZCode Protocol runtime preferences response received", {
      durationMs: Math.max(0, Date.now() - startedAt),
      event: "zcode_protocol.runtime_preferences.response_received",
      module: "bootstrap.zcode_protocol",
      scope,
      sessionId,
      traceId,
    });
    return result;
  } catch (error) {
    const errorCode = error instanceof ProtocolRequestError ? error.code : undefined;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const diagnostic = {
      durationMs: Math.max(0, Date.now() - startedAt),
      errorCode,
      errorMessage,
      event: "zcode_protocol.runtime_preferences.request_failed",
      module: "bootstrap.zcode_protocol",
      scope,
      sessionId,
      traceId,
    };
    if (errorCode === -32022) {
      // Diagnostics: preference-request timeout before runtime registration; log session/scope to
      // tell "host never received/answered" from other restore-phase failures.
      context.logger?.warn("ZCode Protocol runtime preferences request timed out", diagnostic);
    } else if (errorCode !== -32601 && errorCode !== -32020) {
      context.logger?.warn("ZCode Protocol runtime preferences request failed", diagnostic);
    } else {
      context.logger?.debug(
        "ZCode Protocol runtime preferences compatibility fallback",
        diagnostic,
      );
    }
    if (error instanceof ProtocolRequestError && (error.code === -32601 || error.code === -32020)) {
      // Compat with legacy Host-less pure-CLI creation. Memory follows the product default off,
      // enhanced search keeps its default on; other protocol/transport errors still block creation.
      return {
        askUserQuestionAutoResolutionEnabled: true,
        memoryEnabled: false,
        modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
        nativeSearchEnhancementsEnabled: true,
      };
    }
    throw error;
  }
}

async function resolveSessionStartupPreferences(
  context: ZCodeProtocolAgentServerContext,
  sessionId: SessionId,
  source: SessionStartupPreferencesSource,
  trace?: ZCodeProtocolTrace,
): Promise<SessionStartupPreferences> {
  if (source.kind === "inherit") {
    const inheritedShellSelection = source.parent.app.runtime.getSessionShellSelection();
    return {
      memoryEnabled: source.parent.memoryEnabled,
      subagentRuntimeConfigEnabled: source.parent.subagentRuntimeConfigEnabled,
      modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
      nativeSearchEnhancementsEnabled: source.parent.nativeSearchEnhancementsEnabled,
      resolveInitialBashShellSelection: async () => inheritedShellSelection,
    };
  }

  const runtimePreferences = await requestSessionRuntimePreferences(
    context,
    sessionId,
    "runtime-materialization",
    trace,
  );
  // Must apply before the session runtime can raise its first ask; close waits for an in-flight snooze persistence.
  await context.v4Interactions.initializeAskUserQuestionAutoResolutionEnabled(
    runtimePreferences.askUserQuestionAutoResolutionEnabled,
  );
  return {
    subagentRuntimeConfigEnabled: runtimePreferences.subagentRuntimeConfigEnabled,
    memoryEnabled: runtimePreferences.memoryEnabled,
    modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    nativeSearchEnhancementsEnabled: runtimePreferences.nativeSearchEnhancementsEnabled,
    resolveInitialBashShellSelection: async () => {
      const executionPreferences = await requestSessionRuntimePreferences(
        context,
        sessionId,
        "user-execution",
        trace,
      );
      return resolveProtocolBashShellSelection(
        context,
        executionPreferences.integratedTerminalShell,
      );
    },
  };
}

async function materializeSessionRecord(
  context: ZCodeProtocolAgentServerContext,
  params: ZCodeSessionRecordParams,
  sessionId: SessionId,
  resume: boolean,
  source: SessionStartupPreferencesSource,
  trace?: ZCodeProtocolTrace,
): Promise<ZCodeProtocolSessionRecord> {
  const startupPreferences = await resolveSessionStartupPreferences(
    context,
    sessionId,
    source,
    trace,
  );
  return createRecord(context, params, sessionId, resume, startupPreferences, trace);
}

async function createRecord(
  context: ZCodeProtocolAgentServerContext,
  params: ZCodeSessionRecordParams,
  sessionId: SessionId,
  resume: boolean,
  startupPreferences: SessionStartupPreferences,
  trace?: ZCodeProtocolTrace,
): Promise<ZCodeProtocolSessionRecord> {
  const workspace =
    "workspace" in params && params.workspace
      ? params.workspace
      : buildWorkspaceRef({ workspacePath: context.deps.cwd ?? process.cwd() });
  const eventStore = context.deps.createSessionEventStore(sessionId);
  const traceContext = createProtocolRootTraceContext(sessionId, trace);
  const initialModel = "model" in params ? params.model : undefined;
  const parentSessionId =
    "parentSessionId" in params && params.parentSessionId
      ? (params.parentSessionId as SessionId)
      : undefined;
  const taskType = params.taskType ?? "interactive";
  const runtimeMcp = protocolMcpServersToRuntimeMcpConfig(params.mcpServers);
  context.logger?.info("ZCode Protocol createRecord MCP config", {
    event: "zcode_protocol.create_record.mcp_config",
    rootTraceId: traceContext.traceId,
    inboundTraceId: trace?.traceId,
    paramMcpServerCount: params.mcpServers?.length ?? 0,
    runtimeHasMcpConfig: Boolean(runtimeMcp),
    runtimeMcpServerCount: Object.keys(runtimeMcp?.servers ?? {}).length,
    sessionId,
    workspaceKey: workspace.workspaceKey,
    workspacePath: workspace.workspacePath,
  });
  // automation-port needs this session's live model/mode/thought; the record is built after the app.
  // Lazy-bind through a mutable holder: by the time CronCreate calls create() mid-turn, the record exists.
  let ownSessionRecord: ZCodeProtocolSessionRecord | undefined;
  const app = await createWorkspaceZCodeApp(context, workspace, {
    env: context.deps.env,
    eventStore,
    resume,
    runtimeConfig: {
      mode: "mode" in params ? params.mode : undefined,
      modelSelection: "model" in params ? toRuntimeModelSelection(initialModel) : undefined,
      parentSessionId,
      taskType,
      // Dynamic-workflow gradual-rollout gate (docs/dynamic-workflow/launch.md, "Gray release" / "On demand: activation"):
      // same reading as offPeakPort: this create/resume's args win; on absence, the workspace-level verdict the Host synced into the process.
      // The value and the "must be explicit boolean" rationale live in resolveDynamicWorkflowRuntimeGate.
      ...resolveDynamicWorkflowRuntimeGate(
        {
          dynamicWorkflowEnabled:
            "dynamicWorkflowEnabled" in params ? params.dynamicWorkflowEnabled : undefined,
          dynamicWorkflowMode:
            "dynamicWorkflowMode" in params ? params.dynamicWorkflowMode : undefined,
        },
        context.appRuntimePreferences,
      ),
      // Fix rationale: the protocol-side tool allow/deny lists are a session-level security boundary and belong in runtimeConfig,
      // never only prompt-text constraints, or builtin and dynamic MCP tools could still escape the call surface.
      toolAllowlist: "toolAllowlist" in params ? params.toolAllowlist : undefined,
      toolDisallowlist: resolveSessionToolDenylist(params, workspace),
      nativeSearchEnhancementsEnabled: startupPreferences.nativeSearchEnhancementsEnabled,
      modelContextBudgetStrategy: startupPreferences.modelContextBudgetStrategy,
      // Memory Settings is the master switch beyond the existing CLI features.memory/use. Write the
      // override only when disabling, so enabling never reverses the user's CLI-side opt-out.
      ...(startupPreferences.memoryEnabled ? {} : { memory: { enabled: false } }),
      // The desktop-continuous session/create has the UI resolve enabled MCP from ~/.zcode/.agents first,
      // but the protocol app-server itself never reads the UI/main-side MCP store; createRecord did not inject
      // params.mcpServers into runtimeConfig, so logs showed runtimeHasMcpConfig=false and tools never started.
      // MCP is startup-time configuration: write runtimeConfig.mcp once at the session create/resume boundary.
      ...(runtimeMcp ? { mcp: runtimeMcp } : {}),
      // Previously only the TUI path (tui-prompt-handler) injected titleGeneration;
      // sessions created by the ZCode Protocol app-server (desktop/web/mobile) got none, so
      // shouldAttemptSessionTitleGeneration's `if (!config.titleGeneration) return false`
      // always hit, title generation never fired, and sidebar titles stuck at the first_input user query.
      // Enable a default here; whether to generate is still gated by runtime on parent/taskType/turnNumber.
      // Automation execution sessions explicitly disable renaming, so answers cannot overwrite the original user-query title.
      titleGeneration: params.titleGenerationEnabled === false ? { enabled: false } : {},
      workingDirectory: workspace.workspacePath,
      // Identity isolation is separate from path execution: core writes only identity into session.workspace_id,
      // while workingDirectory stays the real path on the remote machine; local workspace stays undefined.
      workspaceIdentity: workspace.workspaceIdentity as WorkspaceId | undefined,
    },
    // The ZCode Protocol app-server used to inject no awaitable interaction broker,
    // so core's permission / AskUserQuestion fell back to deny-by-default and the UI never saw a blocking request.
    // Blocking interactions become server-to-client JSON-RPC requests; the app releases the runtime via the response.
    permissionBroker: createProtocolInteractionBroker(context),
    automationPort: createProtocolAutomationPort(context, () => ownSessionRecord),
    topicResourcePort: createProtocolTopicResourcePort(context),
    // Wire only tools the Host exposes; inject nothing by default. Reuse the current async
    // factory; no legacy deferred ModelAdapter/Registry overlay, no Session Selection change.
    ...(("offPeakToolEnabled" in params && params.offPeakToolEnabled === true) ||
    context.appRuntimePreferences.offPeakToolEnabled === true
      ? { offPeakPort: createProtocolOffPeakPort(context, () => ownSessionRecord) }
      : {}),
    resolveInitialBashShellSelection: startupPreferences.resolveInitialBashShellSelection,
    ...(startupPreferences.subagentRuntimeConfigEnabled &&
    !(workspace.workspaceIdentity && isRemoteWorkspaceIdentity(workspace.workspaceIdentity))
      ? {
          readSubagentRuntimeConfig: async ({ signal, traceContext }) => {
            signal.throwIfAborted();
            const result = await context.requestClient(
              zcodeProtocolMethods.subagentsReadRuntimeConfig,
              { sessionId },
              subagentRuntimeConfigSchema,
              {
                signal,
                timeoutMs: ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS,
                trace: { traceId: traceContext.traceId },
              },
            );
            signal.throwIfAborted();
            return result;
          },
        }
      : {}),
    // browser-use: agent.browsers.* bridges commands into interaction/browserExecute reverse requests.
    browserControlPort: createProtocolBrowserControlBroker(context),
    // The protocol server is a trusted desktop/web/mobile host; the rollout toggle is injected explicitly here,
    // never read from workspace/project config or env; removing the field rolls back to the hard block.
    workspaceHookTrustEnabled: true,
    // Session-less Settings Trust used to bypass managed policy; the session Runtime and workspace
    // RPC must share the Host's provider, never each creating a default policy.
    workspaceHookPolicyProvider: context.deps.workspaceHookPolicyProvider,
    workspaceHookReviewHost: {
      taskId: sessionId,
      runId: `workspace-hook-run:${sessionId}:${crypto.randomUUID()}`,
      workspaceLabel:
        workspace.workspacePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? workspace.workspacePath,
      ...(workspace.remoteSessionId ? { remoteSessionId: workspace.remoteSessionId } : {}),
    },
    sessionId,
    sessionStore: context.deps.sessionStore,
    traceContext,
    version: context.deps.version,
    modelIoFullRetentionEnabled: context.appRuntimePreferences.modelIoFullRetentionEnabled,
  });
  const now = Date.now();
  const record: ZCodeProtocolSessionRecord = {
    app,
    createdAt: now,
    eventStore,
    memoryEnabled: startupPreferences.memoryEnabled,
    subagentRuntimeConfigEnabled: startupPreferences.subagentRuntimeConfigEnabled,
    modelContextBudgetStrategy: startupPreferences.modelContextBudgetStrategy,
    nativeSearchEnhancementsEnabled: startupPreferences.nativeSearchEnhancementsEnabled,
    ...(parentSessionId ? { parentSessionId } : {}),
    persistence: "persistence" in params ? (params.persistence ?? "immediate") : "immediate",
    protocolEventSequences: new Map(),
    protocolToolInputTransmissions: new Map(),
    stateRevision: 0,
    taskType,
    traceContext,
    updatedAt: now,
    workspace,
  };
  const unsubscribeSessionEvents = app.runtime.subscribeEvents({
    onSessionEvent: (event) => onSessionEvent(context, record, event),
  });
  record.unsubscribe = () => {
    unsubscribeSessionEvents();
  };
  // Bound to the owning session for automation-port reads of live model/mode/thought.
  ownSessionRecord = record;
  return record;
}

function resolveSessionToolDenylist(
  params: Pick<ZCodeSessionCreateParams, "toolDenylist">,
  workspace: ZCodeWorkspaceRef,
): readonly string[] | undefined {
  const tools = new Set(params.toolDenylist ?? []);
  if (workspace.workspaceIdentity && isRemoteWorkspaceIdentity(workspace.workspaceIdentity)) {
    // Root cause: remote sessions (SSH/WSL/Docker) still got automationPort, registering the Cron tool remotely;
    // a remote workspace has no reliable local scheduler trigger boundary, so disable it uniformly at session init,
    // never relying only on UI or prompt-text constraints.
    for (const toolName of REMOTE_AUTOMATION_TOOL_NAMES) {
      tools.add(toolName);
    }
  }
  return tools.size > 0 ? [...tools] : undefined;
}

async function readPersistedSessionMessages(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<MessageWithParts[]> {
  return await (context.deps.sessionStore?.messages({
    sessionID: sessionId as SessionId,
  }) ?? []);
}

function derivePersistedSessionMode(
  messages: readonly MessageWithParts[],
): ZCodeSessionCreateParams["mode"] | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const info = messages[index]?.info;
    if (info?.role === "assistant" && isZCodeSessionMode(info.mode)) return info.mode;
  }
  return undefined;
}

function isZCodeSessionMode(
  value: unknown,
): value is NonNullable<ZCodeSessionCreateParams["mode"]> {
  return (
    value === "plan" ||
    value === "build" ||
    value === "edit" ||
    value === "yolo" ||
    value === "guarded" ||
    value === "auto"
  );
}

function toRuntimeModelSelection(
  model: ZCodeSessionCreateParams["model"],
): ModelSelection | undefined {
  if (!model) return undefined;
  return {
    modelId: model.modelId,
    providerId: model.providerId,
    ...(model.options ? { options: model.options } : {}),
  };
}

interface SnapshotPhaseDurationsMs {
  contextUsageBreakdownEvents: number;
  eventSeq: number;
  goalVerificationEvents: number;
  persistedMessages: number;
  persistedSession: number;
  rewindEvents: number;
  target: number;
  todos: number;
  buildSnapshot: number;
}

interface SnapshotWithDiagnostics {
  snapshot: Awaited<ReturnType<typeof buildSessionSnapshot>>;
  phaseDurationsMs: SnapshotPhaseDurationsMs;
}

async function snapshot(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  knownSession?: SessionInfo | null,
  options: {
    messageLimit?: number;
    modelAvailability?: "all" | "current";
  } = {},
) {
  return (await snapshotWithDiagnostics(context, record, knownSession, options)).snapshot;
}

async function snapshotWithDiagnostics(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  knownSession?: SessionInfo | null,
  options: {
    messageLimit?: number;
    modelAvailability?: "all" | "current";
  } = {},
): Promise<SnapshotWithDiagnostics> {
  const snapshotStartedAt = Date.now();
  const phaseDurationsMs: SnapshotPhaseDurationsMs = {
    contextUsageBreakdownEvents: 0,
    eventSeq: 0,
    goalVerificationEvents: 0,
    persistedMessages: 0,
    persistedSession: 0,
    rewindEvents: 0,
    target: 0,
    todos: 0,
    buildSnapshot: 0,
  };
  const measureSnapshotPhase = async <T>(
    phase: keyof Omit<SnapshotPhaseDurationsMs, "buildSnapshot">,
    read: () => Promise<T>,
  ): Promise<T> => {
    const phaseStartedAt = Date.now();
    try {
      return await read();
    } finally {
      phaseDurationsMs[phase] = Date.now() - phaseStartedAt;
    }
  };
  const [
    eventSeq,
    persistedMessages,
    session,
    rewindEvents,
    persistedTarget,
    persistedTodos,
    persistedGoalVerificationEvents,
    persistedContextUsageBreakdownEvents,
  ] = await Promise.all([
    measureSnapshotPhase("eventSeq", () =>
      getProtocolEventSeq(context, record, record.deliveryKind),
    ),
    measureSnapshotPhase("persistedMessages", () => readSessionMessages(context, record)),
    knownSession === undefined
      ? measureSnapshotPhase("persistedSession", () =>
          getPersistedSession(context, record.app.sessionId),
        )
      : knownSession,
    measureSnapshotPhase("rewindEvents", () => readSessionRewindEvents(record)),
    measureSnapshotPhase("target", () => readSnapshotTarget(context, record)),
    measureSnapshotPhase("todos", () => readSnapshotTodos(context, record)),
    measureSnapshotPhase("goalVerificationEvents", () =>
      readSessionTargetCompletionVerificationEvents(context, record),
    ),
    measureSnapshotPhase("contextUsageBreakdownEvents", () =>
      readSessionContextUsageBreakdownEvents(record),
    ),
  ]);
  const messages = projectActiveSessionMessages(persistedMessages, session, rewindEvents);
  const buildStartedAt = Date.now();
  const builtSnapshot = await buildSessionSnapshot({
    app: record.app,
    deliveryKind: record.deliveryKind,
    eventSeq,
    fallbackCreatedAt: record.createdAt,
    fallbackUpdatedAt: record.updatedAt,
    lastError: record.restoreWarning,
    messages: limitMessages(messages, options.messageLimit),
    modelAvailability: options.modelAvailability,
    persistedContextUsageBreakdownEvents,
    persistedGoalVerificationEvents,
    session,
    slashCommandOptions: {
      // The session snapshot's `/` entry and workspace presentation must agree on the rollout
      // verdict, or the sidebar panel still shows `workflow` while disabled.
      dynamicWorkflowEnabled: context.appRuntimePreferences.dynamicWorkflowEnabled,
      env: context.deps.env,
      logger: context.logger,
    },
    stateRevision: record.stateRevision,
    target: persistedTarget,
    todos: persistedTodos,
    workspace: record.workspace,
  });
  phaseDurationsMs.buildSnapshot = Date.now() - buildStartedAt;
  const totalDurationMs = Date.now() - snapshotStartedAt;
  if (totalDurationMs >= SLOW_SNAPSHOT_LOG_THRESHOLD_MS) {
    // Under SSH the latency concentrates in the session snapshot, but legacy logs hold only the total.
    // Past the threshold, log each sub-stage to separate sqlite waits, message reads, and projection builds.
    context.logger?.warn("ZCode Protocol session snapshot slow", {
      durationMs: totalDurationMs,
      event: "zcode_protocol.session_snapshot.slow",
      messageCount: messages.length,
      module: "bootstrap.zcode_protocol",
      phaseDurationsMs,
      sessionId: record.app.sessionId,
      status: "completed",
      workspaceKey: record.workspace.workspaceKey,
      workspacePath: record.workspace.workspacePath,
    });
  }
  return { snapshot: builtSnapshot, phaseDurationsMs };
}

async function readSnapshotTarget(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
) {
  try {
    return await record.app.readTarget();
  } catch (error) {
    // goal is durable business state of session_target; never swallow a snapshot-restore failure,
    // or the UI believes a history session has no goal. Keep the runtime projection and log at the protocol layer.
    context.logger?.warn("Failed to read persisted session goal for protocol snapshot", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.snapshot.target_read_failed",
      sessionId: record.app.sessionId,
    });
    return undefined;
  }
}

async function readSnapshotTodos(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
) {
  try {
    return await record.app.readTodos();
  } catch (error) {
    // The todo is the authoritative short-term plan in the DB; log restore-read failures clearly,
    // while the protocol snapshot still restores the first screen from message history.
    context.logger?.warn("Failed to read persisted session todos for protocol snapshot", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.snapshot.todos_read_failed",
      sessionId: record.app.sessionId,
    });
    return [];
  }
}

async function readSessionTargetCompletionVerificationEvents(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): Promise<SessionEvent[]> {
  const sessionStore = context.deps.sessionStore;
  if (!sessionStore?.sessionEntries) {
    return [];
  }
  try {
    const entries = await sessionStore.sessionEntries({
      sessionID: record.app.sessionId as SessionId,
      type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
    });
    return entries
      .map((entry, index) =>
        sessionEntryToTargetCompletionVerificationEvent(entry, record.app.sessionId, index),
      )
      .filter((event): event is SessionEvent => event !== null);
  } catch (error) {
    // The goal verifier timeline is durable turn fact for the UI; read failures must not break
    // session restore but must log, or post-cold-start grouping loss is undebuggable.
    context.logger?.warn("Failed to read persisted goal verification entries", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.snapshot.goal_verification_entries_read_failed",
      sessionId: record.app.sessionId,
    });
    return [];
  }
}

function sessionEntryToTargetCompletionVerificationEvent(
  entry: {
    id: string;
    sessionID: SessionId;
    time: { created: number; updated: number };
    data: unknown;
  },
  fallbackSessionId: string,
  index: number,
): SessionEvent | null {
  const data = asRecord(entry.data);
  const payload = readTargetCompletionVerificationPayload(data.payload);
  if (!payload) {
    return null;
  }
  const eventId = stringValue(data.eventId) ?? entry.id;
  const traceId = stringValue(data.traceId) ?? "trace_restored_goal_verification";
  const turnId = stringValue(data.turnId);
  return {
    id: eventId as EventId,
    payload,
    sequenceNumber: numberValue(data.sequenceNumber) ?? index + 1,
    sessionId: (entry.sessionID ?? fallbackSessionId) as SessionId,
    timestamp: new Date(entry.time.updated || entry.time.created),
    traceId: traceId as TraceId,
    ...(turnId ? { turnId: turnId as TurnId } : {}),
    type: SessionEventType.TargetCompletionVerification,
  };
}

function readTargetCompletionVerificationPayload(
  value: unknown,
): TargetCompletionVerificationPayload | null {
  const record = asRecord(value);
  const targetId = stringValue(record.targetId);
  const verificationId = stringValue(record.verificationId);
  const status = stringValue(record.status);
  if (!targetId || !verificationId || !isTargetCompletionVerificationStatus(status)) {
    return null;
  }
  const verification = asGoalCompletionVerification(record.verification);
  const goalIteration = numberValue(record.goalIteration);
  const anchorAssistantMessageId = stringValue(record.anchorAssistantMessageId);
  const anchorTurnId = stringValue(record.anchorTurnId);
  return {
    targetId,
    verificationId,
    status,
    ...(verification ? { verification } : {}),
    ...(goalIteration ? { goalIteration } : {}),
    ...(anchorAssistantMessageId
      ? { anchorAssistantMessageId: anchorAssistantMessageId as MessageId }
      : {}),
    ...(anchorTurnId ? { anchorTurnId: anchorTurnId as TurnId } : {}),
  };
}

function isTargetCompletionVerificationStatus(
  status: string | undefined,
): status is TargetCompletionVerificationPayload["status"] {
  return (
    status === "started" ||
    status === "completed" ||
    status === "failed_closed" ||
    status === "cancelled"
  );
}

function asGoalCompletionVerification(
  value: unknown,
): TargetCompletionVerificationPayload["verification"] | undefined {
  const record = asRecord(value);
  if (typeof record.passed !== "boolean") {
    return undefined;
  }
  const reason = stringValue(record.reason);
  if (!reason) {
    return undefined;
  }
  return {
    nextAction: stringValue(record.nextAction),
    passed: record.passed,
    reason,
  };
}

function limitMessages<T>(messages: T[], limit?: number): T[] {
  return limit && limit > 0 ? messages.slice(-limit) : messages;
}

async function readSessionMessages(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
) {
  if (!context.deps.sessionStore) return [];
  return await context.deps.sessionStore.messages({
    sessionID: record.app.sessionId as SessionId,
  });
}

async function readSessionContextUsageBreakdownEvents(
  record: ZCodeProtocolSessionRecord,
): Promise<SessionEvent[]> {
  const events = await record.eventStore.getEvents(record.app.sessionId as SessionId);
  return events.filter((event) => event.type === SessionEventType.ModelComplete);
}

async function readActiveSessionMessages(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
): Promise<MessageWithParts[]> {
  const [messages, session, rewindEvents] = await Promise.all([
    readSessionMessages(context, record),
    getPersistedSession(context, record.app.sessionId),
    readSessionRewindEvents(record),
  ]);
  return projectActiveSessionMessages(messages, session, rewindEvents);
}

async function readSessionRewindEvents(
  record: ZCodeProtocolSessionRecord,
): Promise<SessionEvent[]> {
  const events = await record.eventStore.getEvents(record.app.sessionId as SessionId);
  return events.filter((event) => event.type === SessionEventType.RewindTriggered);
}

function projectActiveSessionMessages(
  messages: MessageWithParts[],
  session: SessionInfo | null | undefined,
  rewindEvents: readonly SessionEvent[],
): MessageWithParts[] {
  const activeConversationRewinds: ActiveConversationRewindPayload[] = [];
  const sessionRewindPayload = activeConversationRewindPayloadFromSession(session);
  if (sessionRewindPayload) {
    activeConversationRewinds.push(sessionRewindPayload);
  }
  let activeMessages = applyRewindBranch(messages, messages, {
    createdMessageId: sessionRewindPayload?.createdMessageId,
    keptMessageIds: session?.revert?.keptMessageIDs,
    targetMessageId: sessionRewindPayload?.targetMessageId,
  });

  for (const event of rewindEvents) {
    const payload = parseActiveConversationRewindPayload(event);
    if (!payload?.targetMessageId) {
      continue;
    }
    activeConversationRewinds.push(payload);
    activeMessages = applyRewindBranch(activeMessages, messages, payload);
  }

  return filterRewindCommandAckMessages(activeMessages, activeConversationRewinds);
}

type ActiveConversationRewindPayload = {
  createdMessageId: MessageId;
  targetMessageId: MessageId;
};

function activeConversationRewindPayloadFromSession(
  session: SessionInfo | null | undefined,
): ActiveConversationRewindPayload | null {
  const createdMessageId = session?.revert?.createdMessageID;
  const targetMessageId = session?.revert?.targetMessageID;
  if (!createdMessageId || !targetMessageId) {
    return null;
  }
  return { createdMessageId, targetMessageId };
}

function parseActiveConversationRewindPayload(
  event: SessionEvent,
): ActiveConversationRewindPayload | null {
  try {
    const payload = parseRewindTriggeredPayload(event.payload);
    if (
      payload.strategy !== RewindStrategy.ActiveChain ||
      (payload.scope !== RewindScope.Conversation && payload.scope !== RewindScope.Both) ||
      !payload.createdMessageId ||
      !payload.targetMessageId
    ) {
      // core records an unavailable event for unworkable rewinds, and such events carry no createdMessageId.
      // They are not a new active-branch start; the protocol projection must not trim messages with them, or consecutive edits empty the visible messages.
      return null;
    }
    return {
      createdMessageId: payload.createdMessageId,
      targetMessageId: payload.targetMessageId,
    };
  } catch {
    return null;
  }
}

function filterRewindCommandAckMessages(
  messages: MessageWithParts[],
  activeConversationRewinds: readonly ActiveConversationRewindPayload[],
): MessageWithParts[] {
  if (activeConversationRewinds.length === 0) {
    return messages;
  }
  const targetByNoticeMessageId = new Map<MessageId, MessageId>();
  for (const rewind of activeConversationRewinds) {
    targetByNoticeMessageId.set(rewind.createdMessageId, rewind.targetMessageId);
  }
  return messages.filter((message) => !isRewindCommandAckMessage(message, targetByNoticeMessageId));
}

function isRewindCommandAckMessage(
  message: MessageWithParts,
  targetByNoticeMessageId: ReadonlyMap<MessageId, MessageId>,
): boolean {
  if (message.info.role !== "assistant") {
    return false;
  }
  const targetMessageId = targetByNoticeMessageId.get(message.info.parentID);
  if (!targetMessageId) {
    return false;
  }
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  const ackText = `Rewound conversation to before message ${targetMessageId}.`;
  // The success receipt of the internal /rewind conversation <messageId> can be projected as
  // assistant text by legacy events. It is only a control-command ACK for edit/retry; never render it to the user on refresh or recovery.
  return text === ackText || text.endsWith(`\n${ackText}`);
}

function isUserVisibleSessionMessage(message: MessageWithParts): boolean {
  if (message.info.role !== "user") {
    return true;
  }
  const policy = getConversationMessageProjectionPolicy(message);
  return policy === "realUserInput" || policy === "timelineOnly";
}

function applyRewindBranch(
  activeMessages: MessageWithParts[],
  allMessages: MessageWithParts[],
  options: {
    createdMessageId?: MessageId;
    keptMessageIds?: readonly MessageId[];
    targetMessageId?: MessageId;
  },
): MessageWithParts[] {
  if (!options.targetMessageId) {
    return activeMessages;
  }

  if (options.keptMessageIds) {
    // After consecutive rewinds, the ledger's target prefix no longer equals the active branch prefix.
    // Prefer the keptMessageIDs the runtime saved at rewind time, or the old branch revives in snapshot/readMessages.
    const messagesById = new Map(allMessages.map((message) => [message.info.id, message]));
    const keptMessages = options.keptMessageIds
      .map((messageId) => messagesById.get(messageId))
      .filter((message): message is MessageWithParts => message !== undefined);
    if (!options.createdMessageId) {
      return keptMessages;
    }

    const createdIndex = allMessages.findIndex(
      (message) => message.info.id === options.createdMessageId,
    );
    return createdIndex >= 0 ? [...keptMessages, ...allMessages.slice(createdIndex)] : keptMessages;
  }

  const targetIndex = activeMessages.findIndex(
    (message) => message.info.id === options.targetMessageId,
  );
  if (targetIndex < 0) {
    return activeMessages;
  }
  const keptMessages = activeMessages.slice(0, targetIndex);
  if (!options.createdMessageId) {
    return keptMessages;
  }

  const createdIndex = allMessages.findIndex(
    (message) => message.info.id === options.createdMessageId,
  );
  if (createdIndex < 0) {
    return keptMessages;
  }

  // The persisted ledger of a conversation rewind keeps rolled-back branches.
  // UI snapshot/readMessages must project the active branch, or after an edit-resend both the misedited original and the new message appear.
  return [...keptMessages, ...allMessages.slice(createdIndex)];
}

async function getPersistedSession(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<SessionInfo | null> {
  const sessionStore = context.deps.sessionStore;
  if (!sessionStore) return null;
  const session = await sessionStore.getSession(sessionId as SessionId);
  if (!session) return null;
  // Protocol cold recovery creates the runtime from session.path; clean legacy identity/cwd cross-contamination before materializing.
  return await repairPersistedRemoteSessionPaths(sessionStore, session, {
    onPersistenceFailure: (error) => {
      context.logger?.warn("Session path repair persistence failed; using in-memory repair", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.session.path_repair.persist_failed",
        sessionId,
      });
    },
  });
}

/**
 * Pure-config mutation reason: changes session selection only, never user activity. Same verdict
 * as isConfigOnlySessionEvent — record.updatedAt feeds sessions-index lastActivityAt /
 * snapshot.session.updatedAt (the task index's sort time); model/thinking/mode switches must not
 * jump tasks to the top.
 */
const CONFIG_ONLY_MUTATION_REASONS = new Set([
  "model_changed",
  "thought_level_changed",
  "mode_changed",
]);

export async function afterStateMutation(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  reason: string,
) {
  if (!record.activeAbortController) {
    // The provider registry may drop the current model mid-turn. Never rewrite in-flight requests; once turn/compact/
    // goal continuation releases the active lock, they pass through this safety boundary and complete the same agent fallback immediately,
    // without waiting for the user's next send and without handing the fallback duty back to the renderer.
    await ensureSessionModelAvailable(context, record);
  }
  record.stateRevision++;
  const configOnlyMutation = CONFIG_ONLY_MUTATION_REASONS.has(reason);
  if (!configOnlyMutation) {
    record.updatedAt = Date.now();
  }
  const stateSnapshot = await snapshot(context, record, undefined, {
    modelAvailability: "current",
  });
  emitStateUpdated(context, record, reason, stateSnapshot.settings);
  return stateSnapshot;
}

function afterPromptAccepted(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  reason: string,
) {
  record.stateRevision++;
  record.updatedAt = Date.now();
  emitStateUpdated(context, record, reason, { status: "running" });
  return {
    accepted: true as const,
    sessionId: record.app.sessionId,
    stateRevision: record.stateRevision,
  };
}

function emitStateUpdated(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  reason: string,
  patch: unknown,
): void {
  const notification: ZCodeStateUpdatedNotification = {
    patch,
    reason,
    revision: record.stateRevision,
    scope: "session",
    sessionId: record.app.sessionId,
    type: "state.updated",
    workspace: record.workspace,
  };
  context.notify({ method: "state.updated", params: notification });
}
