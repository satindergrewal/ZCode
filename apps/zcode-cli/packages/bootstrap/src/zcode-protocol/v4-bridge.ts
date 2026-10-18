import { readBackgroundBashOutputFromOwner } from "./background-work-owner.js";
// v4 gateway binder.
// Role: ConversationV4Gateway is a domain-agnostic channel runtime; this file binds it to the protocol server context:
// - frame egress = context.notify (stdio NDJSON notification, coexisting with the legacy session/event pipe);
// - command execution = V4CommandExecutor (zcode-protocol-v4/commands/, native, straight into core);
//   all 20 commands native; a supports() miss (unknown command) -> notImplemented.
// - transition hooks (ensureModelReady / afterLegacyStateMutation / closeSession /
//   createSessionRecord / child record registration / resumePersistedSession) inject the legacy implementations here, to be
//   deleted along with the legacy protocol.
// No reverse bridging: dependency direction allows legacy-dir -> v4-dir only.
// This file lives in the legacy dir, so importing the v4 executor is legal; the v4 dir must not import this dir.
import {
  isConversationRealUserTurnStarter,
  parseRemoteWorkspaceIdentity,
  type ZCodeSessionContextUsage,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import { createExternalTurnFaultError } from "@zcode/core";
import {
  V4_NOTIFICATIONS,
  conversationInputIntentSchema,
  type AttachmentRef,
  type CommandEnvelope,
  type ConversationInputIntent,
  type V4ConversationFileChangesResult,
  type V4ConversationFileRewindPreviewResult,
  type SessionSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { V4CommandExecutor } from "../zcode-protocol-v4/commands/executor.js";
import { V4QueuePromotionLeaseUnavailableError } from "../zcode-protocol-v4/commands/handlers/queue.js";
import { V4CapabilityUnsupportedError } from "../zcode-protocol-v4/commands/handlers/interaction-background.js";
import {
  buildColdFileChangeSummaries,
  readConversationFileChangesFromEvents,
} from "../zcode-protocol-v4/cold-file-change-summaries.js";
import {
  loadPersistedConversationMaterialization,
  mergeColdConversationEvents,
} from "../zcode-protocol-v4/cold-event-merge.js";
import { lookupGlobalCreateSessionCommand } from "../zcode-protocol-v4/create-session-command-fact.js";
import type { V4CommandCoreHost } from "../zcode-protocol-v4/commands/types.js";
import type {
  ConversationRowTargetResolution,
  SessionUsageSeed,
} from "../zcode-protocol-v4/product-projection.js";
import { PersistentCommandIndex } from "../zcode-protocol-v4/persistent-command-index.js";
import { queueItemIdForCommand } from "../zcode-protocol-v4/command-inbox.js";
import { resolveStableForkTargetFromTranscript } from "../zcode-protocol-v4/stable-fork-target.js";
import { shouldAutoDrainV4QueueHead } from "../zcode-protocol-v4/queue-auto-drain.js";
import { persistAssistantFeedback } from "../zcode-protocol-v4/assistant-feedback-persistence.js";
import {
  TASK_LIST_SESSION_TYPES,
  isTaskListSessionType,
} from "../zcode-protocol-v4/task-list-session-membership.js";
import {
  loadPersistentCommandFacts,
  savePersistentCommandFact,
} from "../zcode-protocol-v4/persistent-command-facts.js";
import {
  ConversationV4Gateway,
  V4CommandNotImplementedError,
} from "../zcode-protocol-v4/v4-gateway.js";
import {
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  SessionEventType,
  createEventId,
  createSessionId,
} from "@zcode/contracts";
import type {
  CollaborationMode,
  DynamicWorkflowRunProgressPayload,
  EventId,
  ForkCommitBundle,
  GoalStatus,
  MessageId,
  ModelSelection,
  SessionEvent,
  SessionId,
  StableForkGoalBoundaryMetadata,
  TraceId,
  TurnId,
  WorkspaceId,
} from "@zcode/contracts";
import { HYDRATION_TRACE_ID } from "../zcode-protocol-v4/projection-state.js";
import { resolveWorkspaceRefFromId } from "./mapper.js";
import { buildLiveWorkspaceConfigStateV4 } from "./v4-workspace-config.js";
import {
  hasSessionModelProvider,
  resolveSessionModelContextWindow,
} from "./workspace-model-runtime.js";
import {
  afterStateMutation,
  activateSessionForResume,
  createSessionRecordForV4,
  ensureSessionModelAvailableForNextTurn,
  listSessionSubagents,
  registerForkedSession,
  readSessionContextUsage,
} from "./server-operations.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";
import { createProtocolLogger } from "./server-types.js";

function normalizeStoredTitleSource(
  source: string | undefined,
): NonNullable<SessionSummary["titleSource"]> {
  if (source === "custom") return "custom";
  if (source === "default") return "default";
  return "generated";
}

function sessionUsageSeedFromRuntimeContextUsage(
  contextUsage: ZCodeSessionContextUsage | undefined,
  contextWindowOverride?: number,
): SessionUsageSeed | null {
  if (!contextUsage || contextUsage.used <= 0) {
    return null;
  }
  return {
    contextWindow: {
      usedTokens: contextUsage.used,
      maxTokens: contextWindowOverride ?? null,
      autoCompactThresholdTokens: null,
      ...(contextUsage.cache ? { cache: contextUsage.cache } : {}),
      ...(contextUsage.breakdown ? { breakdown: contextUsage.breakdown } : {}),
    },
  };
}

const STABLE_FORK_MODES = new Set<CollaborationMode>(["plan", "build", "edit", "yolo", "auto"]);

function stableForkMode(value: string, fallback: CollaborationMode): CollaborationMode {
  return STABLE_FORK_MODES.has(value as CollaborationMode)
    ? (value as CollaborationMode)
    : fallback;
}

function modelSelectionWithOptionFallback(
  selection: ModelSelection | undefined,
  fallback: ModelSelection | undefined,
): ModelSelection | undefined {
  if (!selection) return fallback && cloneModelSelection(fallback);
  // Legacy forks may lack reasoning; the output budget is per-request, not part of the Selection.
  const reasoningLevel = selection.options?.reasoningLevel ?? fallback?.options?.reasoningLevel;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(reasoningLevel !== undefined
      ? {
          options: {
            ...(reasoningLevel !== undefined ? { reasoningLevel } : {}),
          },
        }
      : {}),
  };
}

function cloneModelSelection(
  selection: ReturnType<ZCodeProtocolSessionRecord["app"]["runtime"]["getSessionModelSelection"]>,
): ModelSelection | undefined {
  if (!selection) return undefined;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options ? { options: { ...selection.options } } : {}),
  };
}

async function readConversationFileChanges(
  record: ZCodeProtocolSessionRecord,
  sessionId: string,
  messageIds: readonly string[],
  targetTurnId?: TurnId | null,
): Promise<V4ConversationFileChangesResult> {
  const events = await record.eventStore.getEvents(sessionId as SessionId);
  return readConversationFileChangesFromEvents({
    events,
    messageIds,
    readArtifact: async (snapshotRef) =>
      (await record.app.readToolResultArtifact(snapshotRef)).content,
    ...(targetTurnId ? { targetTurnId } : {}),
  });
}

/**
 * Cold materialization: replay this session's workflow runs from the journal into DynamicWorkflowRunProgress
 * session events.
 *   - Backfill only parents whose record is a **direct hit**: children falling back to the parent record via
 *     parentID (actor transcripts) are not seeded - the journal keys by parent session; a child's projection must
 *     not grow the parent's runs;
 *   - runIds already seen in memory events are excluded by the CLI (this process's run events all live in the
 *     memory store; progress events carry no turnId and survive turn-window eviction), so warm materialization
 *     duplicates nothing;
 *   - replay failure logs and returns empty: the observation side never fails a cold open.
 * Event id / traceId follow transcript hydration's synthesized events; sequenceNumber is re-ranked by cold merge.
async function replayDynamicWorkflowRunEvents(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  record: ZCodeProtocolSessionRecord,
  memoryEvents: readonly SessionEvent[],
): Promise<SessionEvent[]> {
  if (context.sessions.get(sessionId) !== record) return [];
  const replay = record.app.replayDynamicWorkflowRuns;
  if (!replay) return [];
  const excludeRunIds = new Set<string>();
  for (const event of memoryEvents) {
    if (event.type !== SessionEventType.DynamicWorkflowRunProgress) continue;
    const runId = (event.payload as { runId?: unknown } | undefined)?.runId;
    if (typeof runId === "string") excludeRunIds.add(runId);
  }
  let payloads: DynamicWorkflowRunProgressPayload[];
  try {
    payloads = await replay({ excludeRunIds });
  } catch (error) {
    context.logger?.warn("v4 hydrate dynamic workflow replay failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "zcode_protocol.v4.hydrate_workflow_replay_failed",
      module: "bootstrap.zcode_protocol",
      sessionId,
    });
    return [];
  }
  return payloads.map((payload, index) => ({
    id: `dwf-replay-${index + 1}` as EventId,
    sessionId: sessionId as SessionId,
    type: SessionEventType.DynamicWorkflowRunProgress,
    timestamp: new Date(0),
    traceId: HYDRATION_TRACE_ID as TraceId,
    sequenceNumber: 0,
    payload,
  }));
}

async function resolveConversationBackingRecord(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<ZCodeProtocolSessionRecord | undefined> {
  const direct = context.sessions.get(sessionId);
  if (direct) return direct;

  // A running subagent has its own child event log but no bootstrap record of its own.
  // File summaries only need the shared event/artifact store, so resolve the parent record via the persisted
  // parentID as artifact reader, while event reads still use childSessionId explicitly; never cold-resume a
  // second child runtime for a read-only query.
  const stored = await context.deps.sessionStore?.getSession(sessionId as SessionId);
  const parentSessionId = stored?.parentID ? String(stored.parentID) : null;
  return parentSessionId ? context.sessions.get(parentSessionId) : undefined;
}

async function previewConversationFileRewind(
  record: ZCodeProtocolSessionRecord,
  messageIds: readonly string[],
  targetTurnId?: TurnId | null,
): Promise<V4ConversationFileRewindPreviewResult> {
  return record.app.runtime.previewWorkspaceFileRewind({
    targetMessageIds: messageIds as MessageId[],
    ...(targetTurnId ? { targetTurnId } : {}),
  });
}

interface InputCommandForAdmission {
  kind: ConversationInputIntent["kind"];
  text: string;
  attachments: readonly AttachmentRef[];
  sharedContextRefs?: ConversationInputIntent["sharedContextRefs"];
  requestedDelivery?: ConversationInputIntent["delivery"]["requested"];
  admittedDelivery?: ConversationInputIntent["delivery"]["admitted"];
  fallbackReasonCode?: string;
  provenance?: ConversationInputIntent["provenance"];
}

type ResolveAdmissionRowTarget = (
  sessionId: string,
  target: { rowId: number; entityId: string },
  action: "editUserQuery" | "retryTurn",
) => ConversationRowTargetResolution | null;

function admissionAttachmentRefs(
  attachments: NonNullable<
    Extract<ConversationRowTargetResolution, { ok: true }>["editTarget"]
  >["intent"]["attachments"],
): AttachmentRef[] {
  return (
    attachments?.flatMap((attachment) =>
      attachment.ref
        ? [
            {
              ref: attachment.ref,
              fileName: attachment.fileName,
              mime: attachment.mime,
              bytes: attachment.bytes,
              ...(attachment.previewRef ? { previewRef: attachment.previewRef } : {}),
            },
          ]
        : [],
    ) ?? []
  );
}

/**
 * Admission persists only commands that will really produce input. edit/retry cannot guess intent from payload;
 * reuse the projection's canonical target and fold legacy origins into provenance.
 */
function resolveInputCommandForAdmission(
  envelope: CommandEnvelope,
  admissionSessionId: string,
  resolveRowTarget: ResolveAdmissionRowTarget,
): InputCommandForAdmission | null {
  if (envelope.type === "createSession") {
    const firstInput = (
      envelope.payload as {
        firstInput?: { text: string; attachments?: AttachmentRef[] };
      }
    ).firstInput;
    return firstInput
      ? {
          kind: "sendText",
          text: firstInput.text,
          attachments: firstInput.attachments ?? [],
        }
      : null;
  }
  if (envelope.type === "createSelectionSideSession") {
    const firstInput = (
      envelope.payload as {
        firstInput?: { text: string };
      }
    ).firstInput;
    return firstInput
      ? {
          kind: "sendText",
          text: firstInput.text,
          attachments: [],
        }
      : null;
  }
  if (envelope.type === "sendText" || envelope.type === "sendGoalCommand") {
    const payload = envelope.payload as {
      text: string;
      attachments?: AttachmentRef[];
      context_refs?: ConversationInputIntent["sharedContextRefs"];
    };
    return {
      kind: envelope.type,
      text: payload.text,
      attachments: payload.attachments ?? [],
      ...(payload.context_refs ? { sharedContextRefs: payload.context_refs } : {}),
    };
  }
  if (envelope.type === "compact") {
    return { kind: "compact", text: "/compact", attachments: [] };
  }
  if (envelope.type !== "editUserQuery" && envelope.type !== "retryTurn") return null;
  if (!envelope.sessionId) return null;
  const payload = envelope.payload as {
    target: { rowId: number; entityId: string };
    newText?: string;
    attachments?: AttachmentRef[];
  };
  const resolution = resolveRowTarget(envelope.sessionId, payload.target, envelope.type);
  if (!resolution?.ok || !resolution.editTarget) return null;
  const canonical = resolution.editTarget;

  // Will commit an append-only branch cut first; edit no longer creates a hidden child.
  const originalSourceCommandId =
    canonical.intent.provenance?.sourceCommandId ?? canonical.intent.sourceCommandId;
  return {
    kind: canonical.intent.kind,
    text:
      envelope.type === "editUserQuery"
        ? (payload.newText ?? canonical.intent.text)
        : canonical.intent.text,
    attachments:
      envelope.type === "editUserQuery" && payload.attachments
        ? payload.attachments
        : admissionAttachmentRefs(canonical.intent.attachments),
    ...(canonical.intent.requestedDelivery
      ? { requestedDelivery: canonical.intent.requestedDelivery }
      : {}),
    ...(canonical.intent.admittedDelivery
      ? { admittedDelivery: canonical.intent.admittedDelivery }
      : {}),
    ...(canonical.intent.fallbackReasonCode
      ? { fallbackReasonCode: canonical.intent.fallbackReasonCode }
      : {}),
    ...(originalSourceCommandId
      ? {
          provenance: canonical.intent.provenance ?? {
            sourceCommandId: originalSourceCommandId,
            ...(canonical.intent.queueItemId ? { queueItemId: canonical.intent.queueItemId } : {}),
            ...(canonical.intent.clientId ? { clientId: canonical.intent.clientId } : {}),
          },
        }
      : {}),
  };
}

function isConversationInputAdmissionCommand(type: CommandEnvelope["type"]): boolean {
  return (
    type === "sendText" ||
    type === "sendGoalCommand" ||
    type === "compact" ||
    type === "editUserQuery" ||
    type === "retryTurn"
  );
}

function buildForkInitialInput(
  envelope: CommandEnvelope,
  childSessionId: string,
  admission: { admissionSeq: number; admittedAt: number; queueItemId: string },
  input: InputCommandForAdmission,
): ForkCommitBundle["initialInput"] {
  const requested = input.requestedDelivery ?? "startNow";
  const fallbackReasonCode = input.fallbackReasonCode;
  const admitted =
    input.admittedDelivery ??
    (fallbackReasonCode ? "queue" : requested === "auto" ? "startNow" : requested);
  const intent = conversationInputIntentSchema.parse({
    sourceCommandId: envelope.commandId,
    queueItemId: admission.queueItemId,
    clientId: envelope.clientId || "cli",
    kind: input.kind,
    text: input.text,
    attachments: input.attachments,
    delivery: {
      requested,
      admitted,
      ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
    },
    order: { admissionSeq: admission.admissionSeq },
    steer: fallbackReasonCode
      ? { state: "fellBack", reasonCode: fallbackReasonCode }
      : { state: "notRequested" },
    dispatch: { state: "admitted" },
    admittedAt: admission.admittedAt,
    ...(input.provenance ? { provenance: input.provenance } : {}),
  });
  return {
    id: admission.queueItemId,
    sessionID: childSessionId as SessionId,
    kind: intent.kind,
    delivery: intent.delivery.admitted,
    payload: {
      text: intent.text,
      conversationInputIntent: intent,
      attachments: intent.attachments,
      sourceCommandType: envelope.type,
    },
  };
}

async function recordForkStartFailureBestEffort(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  command: Pick<CommandEnvelope, "commandId">,
  error: unknown,
  details: { parentSessionId?: string; registrationRequired?: boolean } = {},
): Promise<void> {
  const store = context.deps.sessionStore;
  const record = context.sessions.get(sessionId);
  const now = Date.now();
  const message = error instanceof Error ? error.message : String(error);
  const warn = (stage: string, failure: unknown) => {
    try {
      context.logger?.warn("fork child post-commit failure recording degraded", {
        commandId: command.commandId,
        error: failure instanceof Error ? failure.message : String(failure),
        forkedSessionId: sessionId,
        parentSessionId: details.parentSessionId,
        stage,
      });
    } catch {
      // Logger-sink failures are post-commit too; durable child/fact must not be reversed because of one.
    }
  };

  try {
    await store?.settleSessionInput?.({
      id: queueItemIdForCommand(command.commandId),
      sessionID: sessionId as SessionId,
      status: "failed",
      reason: "fault.command.childStartFailed",
    });
  } catch (failure) {
    warn("ledger", failure);
  }
  try {
    await store?.saveSessionEntry?.({
      id: `v4_fork_start_failure:${command.commandId}`,
      sessionID: sessionId as SessionId,
      type: "v4/fork_start_failure",
      time: { created: now, updated: now },
      data: {
        commandId: command.commandId,
        forkedSessionId: sessionId,
        parentSessionId: details.parentSessionId,
        ...(details.registrationRequired ? { registrationRequired: true } : {}),
        retryable: true,
        status: "failed",
        reasonCode: "fault.command.childStartFailed",
        message,
      },
    });
  } catch (failure) {
    warn("entry", failure);
  }
  if (!record) return;
  try {
    const event: SessionEvent = {
      id: createEventId(),
      sessionId: sessionId as SessionId,
      type: SessionEventType.TurnError,
      timestamp: new Date(now),
      traceId: record.traceContext.traceId,
      sequenceNumber: (await record.eventStore.getLatestSequenceNumber(sessionId as SessionId)) + 1,
      payload: {
        inputId: command.commandId,
        turnPhase: "fork_child_start",
        error: {
          type: "fault.command.childStartFailed",
          message,
          retryable: true,
        },
      },
    };
    const persisted = await record.eventStore.append(event);
    context.v4Gateway?.ingest(sessionId, persisted);
  } catch (failure) {
    warn("event", failure);
  }
}

/**
 * Fork bundle commit is the command's point of no return; later catalog/model/resume/snapshot only restore
 * runtime reachability. Failures here must leave retryable facts and a warning, never reverse a durable
 * accepted child into failed.
 */
async function registerCommittedForkBestEffort(
  context: ZCodeProtocolAgentServerContext,
  record: ZCodeProtocolSessionRecord,
  fork: Parameters<typeof registerForkedSession>[2],
  options: Parameters<typeof registerForkedSession>[3] & { commandId: string },
  register: typeof registerForkedSession = registerForkedSession,
): Promise<void> {
  const { commandId, ...registrationOptions } = options;
  try {
    await register(context, record, fork, registrationOptions);
  } catch (error) {
    const forkedSessionId = String(fork.forkedSessionId);
    const parentSessionId = String(fork.parentSessionId ?? record.app.sessionId);
    await recordForkStartFailureBestEffort(context, forkedSessionId, { commandId }, error, {
      parentSessionId,
      registrationRequired: true,
    });
    try {
      context.logger?.warn("fork child registration failed after durable commit", {
        commandId,
        error: error instanceof Error ? error.message : String(error),
        forkedSessionId,
        parentSessionId,
        retryable: true,
      });
    } catch {
      // logger exceptions used to escape past the PONR, settling the gateway error as failed.
    }
  }
}

export function createConversationV4Gateway(
  context: ZCodeProtocolAgentServerContext,
): ConversationV4Gateway {
  const log = createProtocolLogger(context.deps)?.child({
    module: "bootstrap.zcode_protocol_v4_gateway",
  });
  const persistentCommands = new PersistentCommandIndex({
    loadSession: async (sessionId) => {
      const live = context.sessions.get(sessionId);
      const stored = await context.deps.sessionStore?.getSession(sessionId as SessionId);
      if (!live && !stored) return null;
      const workspacePath = live?.workspace.workspacePath ?? stored?.directory;
      if (!workspacePath) return null;
      const workspaceIdentity = live?.workspace.workspaceIdentity ?? stored?.workspaceID;
      const facts = context.deps.sessionStore
        ? await loadPersistentCommandFacts(context.deps.sessionStore, sessionId as SessionId, {
            discardAdmittedOnLoad: !live,
          })
        : undefined;
      return {
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity: String(workspaceIdentity) } : {}),
        ...(facts ? { facts } : {}),
      };
    },
  });
  let nativeExecutor: V4CommandExecutor;
  const autoDrainRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const autoDrainV4QueueIfReady = async (record: ZCodeProtocolSessionRecord): Promise<void> => {
    const head = context.v4Gateway?.getQueueHead(record.app.sessionId);
    if (!head) {
      // The outer FIFO already consumed to empty; guide is still consumed inline at core tool-batch boundaries only.
      record.app.completeExternalQueueDrain();
      return;
    }
    const coreForegroundBusy = record.app.runtime.getActiveForegroundExecutionId() !== undefined;
    if (
      head.autoDrain &&
      head.dispatchState === "queued" &&
      (record.activeAbortController !== undefined || coreForegroundBusy)
    ) {
      // The bootstrap controller must not override model-only notifications; legacy auto-drain
      // looked only at the outer lock and mis-executed consume-when-idle as preemption. Hands off reservations
      // while busy.
      return;
    }
    let targetStatus: GoalStatus | null = null;
    if (head.autoDrain && head.dispatchState === "queued" && !record.activeAbortController) {
      try {
        targetStatus = (await record.app.readTarget())?.status ?? null;
      } catch (error) {
        // On target read failure treat as unknown-and-unfinished; promoting directly would let plain queue jump
        // ahead while the goal verification's durable terminal is not yet provable.
        context.logger?.warn("v4 auto-drain held because target state could not be read", {
          error: error instanceof Error ? error.message : String(error),
          queueItemId: head.queueItemId,
          sessionId: record.app.sessionId,
        });
        return;
      }
    }
    if (
      !shouldAutoDrainV4QueueHead({
        autoDrain: head.autoDrain,
        dispatchState: head.dispatchState,
        sessionBusy: Boolean(record.activeAbortController) || coreForegroundBusy,
        targetStatus,
      })
    ) {
      return;
    }
    // After paused-queue restore, old items exist only in the projection, not the new activeTurn memory; plain
    // text must also route through the full projection's queue head, like typed /goal and /compact, so new input
    // cannot jump stale paused items.
    try {
      await nativeExecutor.execute(
        {
          baseRevision: 0,
          clientId: "v4-auto-drain",
          commandId: `auto-${head.kind}-${Date.now()}-${head.queueItemId}`,
          issuedAt: Date.now(),
          payload: { queueItemId: head.queueItemId },
          sessionId: record.app.sessionId,
          type: "sendQueuedNow",
        },
        undefined,
        { autoDrainPromotion: true },
      );
    } catch (error) {
      if (error instanceof V4QueuePromotionLeaseUnavailableError) {
        // A notification may enqueue between precheck and handler; idle-only is the final atomic test.
        scheduleAutoDrainRetry(record);
        return;
      }
      // A failed auto-promote must not pass the FIFO barrier; re-park with the original item for user retry.
      await record.app.setQueueAutoDrain(false);
      context.logger?.warn("v4 auto-drain failed and queue was paused", {
        error: error instanceof Error ? error.message : String(error),
        queueItemId: head.queueItemId,
        sessionId: record.app.sessionId,
      });
    }
  };
  const scheduleAutoDrainRetry = (record: ZCodeProtocolSessionRecord): void => {
    const sessionId = record.app.sessionId;
    if (autoDrainRetryTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      autoDrainRetryTimers.delete(sessionId);
      if (context.sessions.get(sessionId) !== record) return;
      void autoDrainV4QueueIfReady(record).catch((error: unknown) => {
        context.logger?.warn("v4 auto-drain idle reevaluation failed", {
          error: error instanceof Error ? error.message : String(error),
          sessionId,
        });
      });
    }, 100);
    timer.unref?.();
    autoDrainRetryTimers.set(sessionId, timer);
  };
  const coreHost: V4CommandCoreHost = {
    // Same registry object reference: view is a structured narrow view of the legacy record; field changes are
    // visible both ways.
    // Same registry instance: the broker (legacy dir) registers reverse-request deferreds, and the v4
    // resolveInteraction handler delivers answers through it (native v4 infrastructure, not a transition hook).
    interactions: context.v4Interactions,
    logger: {
      info: (message, fields) => context.logger?.info(message, fields),
      warn: (message, fields) => context.logger?.warn(message, fields),
    },
    // Native v4 capability (not a transition hook): sendQueuedNow must read the full intent from the v4
    // projection. By command time context.v4Gateway is injected by the server (the createConversationV4Gateway
    // return value is backfilled); lazy access here avoids construction-time self-reference.
    getQueueItem: (sessionId, queueItemId) =>
      context.v4Gateway?.getQueueItem(sessionId, queueItemId) ?? null,
    hasQueueItemKind: (sessionId, kind) =>
      context.v4Gateway?.hasQueueItemKind(sessionId, kind) ?? false,
    hasQueuedDelivery: (sessionId, delivery) =>
      context.v4Gateway?.hasQueuedDelivery(sessionId, delivery) ?? false,
    getQueueLength: (sessionId) => context.v4Gateway?.getQueueLength(sessionId) ?? 0,
    waitForProjectionEventCommit: (sessionId, eventId, options) => {
      const gateway = context.v4Gateway;
      if (!gateway) {
        return Promise.reject(new Error("v4 gateway unavailable for projection commit wait"));
      }
      return gateway.waitForProjectionEventCommit(sessionId, eventId, options);
    },
    admitInputCommand: async (envelope, sessionId, admission) => {
      if (!context.deps.sessionStore?.saveSessionInput) return null;
      const input = resolveInputCommandForAdmission(
        envelope,
        sessionId,
        (sourceSessionId, target, action) =>
          context.v4Gateway?.resolveRowActionTarget(sourceSessionId, target, action) ?? null,
      );
      if (!input) return null;
      const kind = input.kind;
      const record = context.sessions.get(sessionId);
      if (record?.persistence === "deferred") {
        // session_input has an FK to session; the draft persists only in startPromptTurn's background phase, so
        // writing the ledger first would FK-fail and leave no authoritative record before accepted. Admission
        // therefore goes through the runtime's unified first-input persistence boundary, then the ledger; the
        // handler only executes.
        await record.app.runtime.ensureSessionPersistedForExternalActivity(input.text ?? "", {
          traceContext: record.traceContext,
        });
        record.persistence = "immediate";
      }
      const routingMode = context.v4Gateway?.getInputRoutingMode(sessionId) ?? null;
      // This is the ledger's pre-execution intended-delivery boundary; TurnSteerQueued idempotently updates the
      // same record with the actual delivery/fallback reason. startNow must not masquerade as queue, else
      // restarted-discarded diagnostics lie.
      const requestedDelivery =
        input.requestedDelivery ??
        (kind === "compact" && routingMode !== null && routingMode !== "startNow"
          ? "queue"
          : routingMode === "enqueue"
            ? "queue"
            : routingMode === "guide" && kind === "sendText"
              ? "guide"
              : "startNow");
      const attachmentRefs = input.attachments;
      const fallbackReasonCode =
        input.fallbackReasonCode ??
        (requestedDelivery === "guide" && attachmentRefs.length > 0
          ? "guide.attachmentsUnsupported"
          : undefined);
      const admittedDelivery =
        input.admittedDelivery ??
        (fallbackReasonCode
          ? "queue"
          : requestedDelivery === "auto"
            ? "startNow"
            : requestedDelivery);
      const conversationInputIntent = conversationInputIntentSchema.parse({
        sourceCommandId: envelope.commandId,
        queueItemId: admission.queueItemId,
        clientId: envelope.clientId || "cli",
        kind,
        text: input.text ?? "",
        attachments: attachmentRefs,
        ...(input.sharedContextRefs ? { sharedContextRefs: input.sharedContextRefs } : {}),
        delivery: {
          requested: requestedDelivery,
          admitted: admittedDelivery,
          ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
        },
        order: { admissionSeq: admission.admissionSeq },
        steer: fallbackReasonCode
          ? { state: "fellBack", reasonCode: fallbackReasonCode }
          : requestedDelivery === "guide"
            ? { state: "submitting" }
            : { state: "notRequested" },
        dispatch: { state: "admitted" },
        admittedAt: admission.admittedAt,
        ...(input.provenance ? { provenance: input.provenance } : {}),
      });
      await context.deps.sessionStore.saveSessionInput({
        id: admission.queueItemId,
        sessionID: sessionId as SessionId,
        kind,
        delivery: conversationInputIntent.delivery.admitted,
        payload: {
          text: conversationInputIntent.text,
          intent: {
            sourceCommandId: conversationInputIntent.sourceCommandId,
            queueItemId: conversationInputIntent.queueItemId,
            clientId: conversationInputIntent.clientId,
            kind: conversationInputIntent.kind,
            admissionSeq: admission.admissionSeq,
            admittedAt: admission.admittedAt,
            requestedDelivery: conversationInputIntent.delivery.requested,
            admittedDelivery: conversationInputIntent.delivery.admitted,
            ...(fallbackReasonCode ? { fallbackReasonCode } : {}),
            attachmentRefs,
            ...(conversationInputIntent.sharedContextRefs
              ? { sharedContextRefs: conversationInputIntent.sharedContextRefs }
              : {}),
          },
          conversationInputIntent,
          attachments: attachmentRefs,
          ...(conversationInputIntent.sharedContextRefs
            ? { sharedContextRefs: conversationInputIntent.sharedContextRefs }
            : {}),
          sourceCommandType: envelope.type,
        },
      });
      if (
        conversationInputIntent.sharedContextRefs?.length &&
        conversationInputIntent.delivery.admitted !== "startNow"
      ) {
        const reference = conversationInputIntent.sharedContextRefs[0]!;
        const reserved = await context.deps.sessionStore.transitionSharedContextImport?.({
          sessionID: sessionId as SessionId,
          contextId: reference.context_id,
          expectedStatus: "pending",
          status: "reserved",
          sourceId: admission.queueItemId,
        });
        if (!reserved) {
          await context.deps.sessionStore.settleSessionInput?.({
            id: admission.queueItemId,
            sessionID: sessionId as SessionId,
            status: "failed",
            reason: "shared_context_not_attachable",
          });
          throw new Error("fault.command.sharedContextNotAttachable");
        }
        const entry = (
          await context.deps.sessionStore.sessionEntries?.({
            sessionID: sessionId as SessionId,
            type: "v4/shared_context_import",
          })
        )?.find((candidate) => {
          const data = candidate.data;
          return Boolean(
            data &&
            typeof data === "object" &&
            !Array.isArray(data) &&
            (data as Record<string, unknown>).contextId === reference.context_id,
          );
        });
        const data = entry?.data;
        const session = await context.deps.sessionStore.getSession(sessionId as SessionId);
        if (
          data &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          typeof (data as Record<string, unknown>).shareUrl === "string" &&
          session?.title
        ) {
          context.v4Gateway?.updateSharedContextImport(sessionId, {
            contextId: reference.context_id,
            title: session.title,
            shareUrl: String((data as Record<string, unknown>).shareUrl),
            status: "reserved",
          });
        }
      }
      return conversationInputIntent;
    },
    cancelInputCommand: async (sessionId, queueItemId, reason) => {
      await context.deps.sessionStore?.settleSessionInput?.({
        id: queueItemId,
        sessionID: sessionId as SessionId,
        status: "cancelled",
        reason,
      });
      const store = context.deps.sessionStore;
      const entries = await store?.sessionEntries?.({
        sessionID: sessionId as SessionId,
        type: "v4/shared_context_import",
      });
      const reserved = entries?.find((entry) => {
        const data = entry.data;
        return Boolean(
          data &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          (data as Record<string, unknown>).status === "reserved" &&
          (data as Record<string, unknown>).sourceId === queueItemId,
        );
      });
      const contextId =
        reserved?.data && typeof reserved.data === "object"
          ? (reserved.data as Record<string, unknown>).contextId
          : undefined;
      if (typeof contextId === "string") {
        await store?.transitionSharedContextImport?.({
          sessionID: sessionId as SessionId,
          contextId,
          expectedStatus: "reserved",
          status: "pending",
          sourceId: queueItemId,
        });
      }
    },
    discardSharedContext: async (sessionId, contextId) => {
      const store = context.deps.sessionStore;
      if (!store?.transitionSharedContextImport) return false;
      const updated = await store.transitionSharedContextImport({
        sessionID: sessionId as SessionId,
        contextId,
        expectedStatus: "pending",
        status: "discarded",
      });
      if (updated) {
        const entry = (
          await store.sessionEntries?.({
            sessionID: sessionId as SessionId,
            type: "v4/shared_context_import",
          })
        )?.find((candidate) => {
          const data = candidate.data;
          return Boolean(
            data &&
            typeof data === "object" &&
            !Array.isArray(data) &&
            (data as Record<string, unknown>).contextId === contextId,
          );
        });
        const data = entry?.data;
        const session = await store.getSession(sessionId as SessionId);
        if (
          data &&
          typeof data === "object" &&
          !Array.isArray(data) &&
          typeof (data as Record<string, unknown>).shareUrl === "string" &&
          typeof (data as Record<string, unknown>).contextId === "string" &&
          session?.title
        ) {
          context.v4Gateway?.updateSharedContextImport(sessionId, {
            contextId: String((data as Record<string, unknown>).contextId),
            title: session.title,
            shareUrl: String((data as Record<string, unknown>).shareUrl),
            status: "discarded",
          });
        }
      }
      return updated;
    },
    recordPersistentCommandFact: async (sessionId, source, ack, metadata) => {
      const store = context.deps.sessionStore;
      const live = context.sessions.get(sessionId);
      const stored = await store?.getSession(sessionId as SessionId);
      if (!store || (!live && !stored)) {
        throw new Error("fault.command.persistentFactSessionNotFound");
      }
      await savePersistentCommandFact(store, sessionId as SessionId, source, ack, metadata);
      const workspacePath = live?.workspace.workspacePath ?? stored?.directory;
      if (!workspacePath) throw new Error("fault.command.persistentFactWorkspaceMissing");
      const workspaceIdentity = live?.workspace.workspaceIdentity ?? stored?.workspaceID;
      await persistentCommands.record(
        {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity: String(workspaceIdentity) } : {}),
        },
        sessionId,
        source,
        ack,
      );
    },
    // Held choice verdict (heldQueueInputRequiresChoice): read projection inputRouting.mode.
    getInputRoutingMode: (sessionId) => context.v4Gateway?.getInputRoutingMode(sessionId) ?? null,
    // rowId->messageId translation (fork/edit/retry targeting; source = the v4 projection):
    // lazily consult the gateway's projection table.
    getMessageIdForRow: (sessionId, rowId) =>
      context.v4Gateway?.getMessageIdForRow(sessionId, rowId) ?? null,
    resolveRowActionTarget: (sessionId, target, action) =>
      context.v4Gateway?.resolveRowActionTarget(sessionId, target, action) ?? null,
    getMessageIdsForTurnRow: (sessionId, rowId) =>
      context.v4Gateway?.getMessageIdsForTurnRow(sessionId, rowId) ?? [],
    isLatestAssistantSegmentRow: (sessionId, rowId) =>
      context.v4Gateway?.isLatestAssistantSegmentRow(sessionId, rowId) ?? null,
    resolveStableForkTarget: async (sessionId, rowId) => {
      const candidate = context.v4Gateway?.resolveStableForkCandidate(sessionId, rowId) ?? null;
      if (!candidate) return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
      if (!candidate.ok) return candidate;
      const store = context.deps.sessionStore;
      if (!store) return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
      const messages = await store.messages({ sessionID: sessionId as SessionId });
      return await resolveStableForkTargetFromTranscript({
        candidate: candidate.candidate,
        messages,
        store,
      });
    },
    isLatestRetryAssistantRow: (sessionId, rowId) =>
      context.v4Gateway?.isLatestRetryAssistantRow(sessionId, rowId) ?? null,
    isLatestEditableUserRow: (sessionId, rowId) =>
      context.v4Gateway?.isLatestEditableUserRow(sessionId, rowId) ?? null,
    getTurnIdForRow: (sessionId, rowId) =>
      context.v4Gateway?.getTurnIdForRow(sessionId, rowId) ?? null,
    // restoreWarning self-heal probe: the App's model view comes straight from the process Registry.
    hasUsableRuntimeModelTarget: (record) => record.app.listModels().length > 0,
    getTurnRewindAnchor: (sessionId, rowId) =>
      context.v4Gateway?.getTurnRewindAnchor(sessionId, rowId) ?? null,
    resolveUserMessageIdForRow: async (sessionId, rowId) => {
      const turnId = context.v4Gateway?.getTurnIdForRow(sessionId, rowId) ?? null;
      const sessionStore = context.deps.sessionStore;
      if (!turnId || !sessionStore) return null;
      const messages = await sessionStore.messages({
        sessionID: sessionId as SessionId,
      });
      const user = messages
        .filter(
          (message) =>
            message.info.role === "user" &&
            String(message.info.anchor?.turnId ?? "") === turnId &&
            isConversationRealUserTurnStarter(message),
        )
        .at(-1);
      return user ? String(user.info.id) : null;
    },
    // retryTurn original-prompt resolution: assistant messageId -> parentID (user message) -> text.
    // Source = core sessionStore (transcript authority); it lives in the binder only because the deps injection
    // point is host-native. Not found returns null -> handler truncates without resending.
    resolveTurnUserPrompt: async (sessionId, assistantMessageId) => {
      const sessionStore = context.deps.sessionStore;
      if (!sessionStore) return null;
      const messages = await sessionStore.messages({
        sessionID: sessionId as SessionId,
      });
      const assistantInfo = messages.find(
        (message) => message.info.id === assistantMessageId,
      )?.info;
      if (assistantInfo?.role !== "assistant") return null;
      const user = messages.find((message) => message.info.id === assistantInfo.parentID);
      if (!user || user.info.role !== "user") return null;
      const text = user.parts
        .filter(
          (part): part is Extract<(typeof user.parts)[number], { type: "text" }> =>
            part.type === "text" && part.ignored !== true,
        )
        .map((part) => part.text)
        .join("");
      return text.length > 0 ? text : null;
    },
    setAssistantFeedback: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      const sessionStore = context.deps.sessionStore;
      if (!record || !sessionStore) throw new Error("proto.sessionNotFound");
      // Reason: the notice must land in the transcript first, so a CLI restart can restore it via cold hydration;
      // eventStore/projection advance afterwards and a failed retry can still idempotently backfill from the
      // same persisted fact.
      await persistAssistantFeedback({
        sessionStore,
        eventStore: record.eventStore,
        sessionId,
        messageId: input.messageId,
        entityId: input.entityId,
        feedback: input.feedback,
        traceId: String(record.traceContext.traceId),
        onPersistedEvent: (persisted) => context.v4Gateway?.ingest(sessionId, persisted),
        onLiveProjectionError: (error) =>
          context.logger?.warn("v4 assistant feedback live projection failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          }),
      });
    },
    // ---------------------------- transition hooks ----------------------------
    ensureModelReady: (record) =>
      ensureSessionModelAvailableForNextTurn(context, record as ZCodeProtocolSessionRecord),
    // Before switching models, confirm the target Provider exists in the current Environment Registry. Plain
    // model commands commit only the Selection; Provider facts are always interpreted by the Worker's own Registry.
    ensureProviderAvailable: async (sessionId, providerId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return { available: false, reason: "session_not_found" };
      if (!hasSessionModelProvider(context, record, providerId)) {
        return { available: false, reason: "provider_not_in_registry" };
      }
      return { available: true };
    },
    afterLegacyStateMutation: async (record, reason) => {
      await afterStateMutation(context, record as ZCodeProtocolSessionRecord, reason);
      await autoDrainV4QueueIfReady(record as ZCodeProtocolSessionRecord);
    },
    // deleteSession execution: inlines the 4 steps of the legacy closeSession op (no import of the legacy op -
    // semantics aligned with server-operations.ts closeSession; to be absorbed once the session registry moves to v4).
    closeSession: async (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        // The handler checked existence; this only absorbs concurrency races (duplicate delete is idempotent success).
        return;
      }
      record.unsubscribe?.();
      await record.app.close?.();
      // v4 channel: closing a session also clears the publisher/subscription scheduling; reopening cold-starts a
      // snapshot. disposeSession must run before the registry delete -
      // the gateway locates the workspace via getSessionWorkspaceId (reading context.sessions) to push
      // session.removed to sessions-index subscribers; delete-then-dispose leaves workspaceId
      // null and the sidebar entry never disappears (caught by e2e conversation-session-v4-sidebar).
      context.v4Gateway?.disposeSession(sessionId);
      context.sessions.delete(sessionId);
    },
    // createSession execution: record creation/event wiring/catalog sync/failure cleanup all live in the legacy
    // createSession op (the half-initialized-record reclaim order fixed real bugs; do not reimplement).
    // Semantic decisions (draft persistence / firstInput via native prompt turn) stay in the native handler.
    createSessionRecord: async ({
      workspaceId,
      mcpServers,
      offPeakToolEnabled,
      dynamicWorkflowEnabled,
    }) => {
      // workspaceId dual form (Workspace Identity constraints):
      // - local workspace = workspacePath (the fallback when identity is absent);
      // - remote pane (cross-workspace split) = the remote identity
      //   (remote:ssh/wsl/docker:...:<path>, built by the UI's buildRemoteWorkspaceIdentity).
      //   Resolve the real workspacePath via the shared parser as workingDirectory - the CLI already runs on
      //   the remote machine, so the path is a local path; the identity passes verbatim into the workspace ref
      //   (workspaceKey = identity; sessions-index topic and isolation semantics unchanged).
      //   The shared parser compat-covers WSL legacy and explicit user identities; non-remote formats keep
      //   the local-workspacePath handling.
      const created = await createSessionRecordForV4(context, {
        workspace: resolveWorkspaceRefFromId(workspaceId),
        // Always deferred (draft stays out of sqlite); promotion timing belongs to the native prompt-turn.
        persistence: "deferred",
        // MCP is runtime-creation configuration; v4 createSession must pass it through equivalently to legacy
        // session/create, else sessions created without those tools never start them.
        mcpServers,
        // The Off-Peak tooling flag is likewise runtime-creation configuration and must enter the record with create.
        ...(offPeakToolEnabled === true ? { offPeakToolEnabled: true } : {}),
        // The dynamic-workflow gate is likewise runtime-creation configuration:
        // v4 createSession must pass it through like legacy session/create, else UI-less creation would bypass the
        // Host's gate decision, leaving only the process default.
        ...(dynamicWorkflowEnabled === true ? { dynamicWorkflowEnabled: true } : {}),
      });
      return { sessionId: created.sessionId };
    },
    createSelectionSideSession: async (sessionId, options) => {
      const record = context.sessions.get(sessionId);
      if (!record) throw new Error("proto.sessionNotFound");
      const modelSelection = cloneModelSelection(
        options.modelSelection ?? record.app.runtime.getSessionModelSelection(),
      );
      const fork = await record.app.runtime.createSelectionSideConversation({
        modelSelection,
        sourceCommandId: options.sourceCommandId,
        revisionAtDecision: options.revisionAtDecision,
        traceContext: record.traceContext,
      });
      await registerCommittedForkBestEffort(context, record, fork, {
        commandId: options.sourceCommandId,
        runtimeConfig: {
          mode: record.app.getMode(),
          model: modelSelection ? `${modelSelection.providerId}/${modelSelection.modelId}` : "",
          ...(modelSelection?.options?.reasoningLevel
            ? { thoughtLevel: modelSelection.options.reasoningLevel }
            : {}),
          followupMode: context.v4Gateway?.getSessionFollowupMode(sessionId) ?? "queue",
        },
        inheritLatestTarget: false,
      });
      return { sessionId: String(fork.forkedSessionId) };
    },
    // Running stable fork: core transcript copy only, then register the child record. Parent runtime, queue,
    // background/continuation inbox, and shared workspace are none read, stopped, or copied.
    forkStableConversation: async (sessionId, options) => {
      const { goalBoundary, revisionAtDecision, sourceCommandId, target } = options;
      const record = context.sessions.get(sessionId);
      if (!record) throw new Error("proto.sessionNotFound");
      const store = context.deps.sessionStore;
      if (!store) throw new Error("fault.command.stableForkStoreUnavailable");
      const messages = await store.messages({ sessionID: sessionId as SessionId });
      const boundary = messages.find(
        (message) => String(message.info.id) === target.boundaryMessageId,
      );
      if (boundary?.info.role !== "assistant") {
        throw new Error("guard.forkTargetAmbiguous");
      }
      const modelSelection = modelSelectionWithOptionFallback(
        boundary.info.providerId && boundary.info.modelId
          ? {
              providerId: boundary.info.providerId,
              modelId: boundary.info.modelId,
              ...(boundary.info.reasoningLevel
                ? { options: { reasoningLevel: boundary.info.reasoningLevel } }
                : {}),
            }
          : undefined,
        cloneModelSelection(record.app.runtime.getSessionModelSelection()),
      );
      const fork = await record.app.runtime.forkStableConversationAtMessage({
        modelSelection,
        target,
        goalBoundary,
        sourceCommandId,
        revisionAtDecision,
        traceContext: record.traceContext,
      });
      await registerCommittedForkBestEffort(context, record, fork, {
        commandId: sourceCommandId,
        runtimeConfig: {
          mode: stableForkMode(boundary.info.mode, record.app.getMode()),
          model: modelSelection ? `${modelSelection.providerId}/${modelSelection.modelId}` : "",
          ...(modelSelection?.options?.reasoningLevel
            ? { thoughtLevel: modelSelection.options.reasoningLevel }
            : {}),
        },
        // Core already copied goals at copied-message/verifier boundaries; never overwrite with the parent's
        // current target.
      });
      return { forkedSessionId: String(fork.forkedSessionId) };
    },
    forkConversationBeforeInput: async (sessionId, { editTarget, envelope, admission }) => {
      const record = context.sessions.get(sessionId);
      if (!record) throw new Error("proto.sessionNotFound");
      const store = context.deps.sessionStore;
      if (!store) throw new Error("fault.command.stableForkStoreUnavailable");
      const messages = await store.messages({
        sessionID: sessionId as SessionId,
      });
      const targetMessage = messages.find(
        (message) => String(message.info.id) === editTarget.transcriptMessageId,
      );
      if (targetMessage?.info.role !== "user") {
        throw new Error("guard.latestQueryEditOnly");
      }
      const modelSelection = modelSelectionWithOptionFallback(
        cloneModelSelection(targetMessage.info.modelSelection),
        cloneModelSelection(record.app.runtime.getSessionModelSelection()),
      );
      const events = await record.eventStore.getEvents(sessionId as SessionId);
      const targetStarted = events.find(
        (event) =>
          event.type === SessionEventType.TurnStarted &&
          String((event.payload as { messageId?: unknown }).messageId ?? "") ===
            editTarget.transcriptMessageId,
      );
      const priorTargetChange = targetStarted
        ? events
            .filter(
              (event) =>
                event.sequenceNumber < targetStarted.sequenceNumber &&
                event.type === SessionEventType.TargetChanged,
            )
            .at(-1)
        : undefined;
      const forkedSessionId = String(createSessionId());
      const input = resolveInputCommandForAdmission(
        envelope,
        forkedSessionId,
        (sourceSessionId, target, action) =>
          context.v4Gateway?.resolveRowActionTarget(sourceSessionId, target, action) ?? null,
      );
      if (!input) throw new Error("fault.command.forkInputAdmissionMissing");
      const initialInput = buildForkInitialInput(envelope, forkedSessionId, admission, input);
      let goalBoundary: StableForkGoalBoundaryMetadata | null = priorTargetChange
        ? (() => {
            const target = (priorTargetChange.payload as { target?: unknown }).target;
            return target
              ? {
                  kind: "snapshot" as const,
                  target: target as Extract<
                    StableForkGoalBoundaryMetadata,
                    { kind: "snapshot" }
                  >["target"],
                  verificationEntryIds: [],
                }
              : { kind: "none" as const };
          })()
        : null;
      if (goalBoundary?.kind === "snapshot" && store.sessionEntries && targetStarted) {
        const targetId = goalBoundary.target.targetID;
        const boundaryTime = targetStarted.timestamp.getTime();
        const entries = await store.sessionEntries({
          sessionID: sessionId as SessionId,
          type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
        });
        goalBoundary = {
          ...goalBoundary,
          verificationEntryIds: entries.flatMap((entry) => {
            const data = entry.data as { payload?: { targetId?: unknown } };
            return entry.time.updated <= boundaryTime && data.payload?.targetId === targetId
              ? [entry.id]
              : [];
          }),
        };
      }
      if (!goalBoundary) {
        const targetIndex = messages.indexOf(targetMessage);
        const previousAssistant = messages
          .slice(0, targetIndex)
          .reverse()
          .find((message) => message.info.role === "assistant");
        goalBoundary = previousAssistant?.info.anchor?.goalBoundary ?? null;
        if (!previousAssistant) goalBoundary = { kind: "none" };
      }
      if (!goalBoundary) {
        throw new Error("guard.forkTargetAmbiguous");
      }
      const fork = await record.app.runtime.forkConversationBeforeMessage({
        modelSelection,
        forkedSessionId: forkedSessionId as SessionId,
        targetMessageId: targetMessage.info.id,
        targetProductTurnId: editTarget.productTurnId,
        targetTranscriptTurnId: String(
          targetMessage.info.anchor?.turnId ?? editTarget.productTurnId,
        ),
        sourceCommandId: envelope.commandId,
        initialInput,
        commandFact: {
          parentSessionId: sessionId,
          sourceCommandId: envelope.commandId,
          ack: {
            commandId: envelope.commandId,
            status: "accepted",
            revisionAtDecision: envelope.baseRevision ?? 0,
            result: {
              type: "editUserQuery",
              disposition: "fork",
              sessionId: forkedSessionId,
            },
          },
          metadata: {
            parentSessionId: sessionId,
            sourceCommandId: envelope.commandId,
            editTarget,
          },
        },
        // Strictly the TargetChanged before TurnStarted or the last stable assistant anchor; never present the
        // parent's current target (possibly being written by the edited goal) as the pre-input state.
        goalBoundary,
        traceContext: record.traceContext,
      });
      await registerCommittedForkBestEffort(context, record, fork, {
        commandId: envelope.commandId,
        runtimeConfig: {
          mode: record.app.getMode(),
          model: modelSelection ? `${modelSelection.providerId}/${modelSelection.modelId}` : "",
          ...(modelSelection?.options?.reasoningLevel
            ? { thoughtLevel: modelSelection.options.reasoningLevel }
            : {}),
        },
        inheritLatestTarget: false,
      });
      return { forkedSessionId: String(fork.forkedSessionId) };
    },
    recordForkStartFailure: async (sessionId, envelope, error) => {
      await recordForkStartFailureBestEffort(context, sessionId, envelope, error, {
        parentSessionId: String(envelope.sessionId ?? ""),
      });
    },
  };
  nativeExecutor = new V4CommandExecutor(coreHost);
  const loadStoredSessionSummaries = async (
    workspaceId: string,
    legacyTaskIds?: readonly string[],
  ) => {
    // Lightweight summary of an unloaded session: store meta -> SessionSummary (phase defaults to idle-done;
    // sessionEnded=true matches ended-on-successful-turn; after load the gateway overrides
    // phase/preview/backgroundWork from the live projection).
    // workspaceKey's local fallback is workspacePath, hence the listSessions directory filter.
    if (!context.deps.sessionStore) return [];
    try {
      // The remote sessions-index workspaceId is the isolation identity, while the session store's directory is
      // the real file path. Queries must carry both; else other authorities' sessions at the same path get
      // mislabeled as this workspace. A legacy-empty identity must not claim by path alone - only the host
      // task-index's exact taskId attribution counts.
      const parsedRemote = parseRemoteWorkspaceIdentity(workspaceId);
      const persistedWorkspacePath = parsedRemote?.workspacePath ?? workspaceId;
      if (
        parsedRemote &&
        legacyTaskIds &&
        legacyTaskIds.length > 0 &&
        context.deps.sessionStore.claimLegacySessionWorkspace
      ) {
        try {
          const claimedCount = await context.deps.sessionStore.claimLegacySessionWorkspace({
            sessionIDs: legacyTaskIds as SessionId[],
            directory: persistedWorkspacePath,
            workspaceID: workspaceId as WorkspaceId,
          });
          if (claimedCount > 0) {
            context.logger?.info("legacy remote sessions claimed by task-index allowlist", {
              claimedCount,
              event: "zcode_protocol.v4.sessions_index_legacy_remote_claimed",
              module: "bootstrap.zcode_protocol",
              workspaceId,
            });
          }
        } catch (error) {
          // The claim is a legacy-data step; on failure still read sessions with complete identities.
          // Later subscriptions carrying the allowlist re-enter here; never seal migration with a failure.
          context.logger?.warn("legacy remote sessions claim failed; continuing strict load", {
            error: error instanceof Error ? error.message : String(error),
            event: "zcode_protocol.v4.sessions_index_legacy_remote_claim_failed",
            module: "bootstrap.zcode_protocol",
            workspaceId,
          });
        }
      }
      const stored = await context.deps.sessionStore.listSessions({
        directory: persistedWorkspacePath,
        includeArchived: false,
        limit: 200,
        // parentID expresses session hierarchy only, never left-panel task membership.
        // Explicit forks always carry parentID, yet after restart the taskType projection must place them in
        // sessions-index.
        workspaceID: parsedRemote ? (workspaceId as WorkspaceId) : null,
      });
      return stored.map((session) => ({
        sessionId: String(session.id),
        workspaceId,
        ...(session.parentID ? { parentSessionId: String(session.parentID) } : {}),
        title: session.title ?? "",
        titleSource: normalizeStoredTitleSource(session.titleSource),
        phase: "completedSuccess" as const,
        sessionEnded: true,
        hasBackgroundWork: false,
        lastActivityAt: session.time?.updated ?? 0,
        createdAt: session.time?.created ?? 0,
      }));
    } catch (error) {
      context.logger?.warn("sessions-index stored summaries failed", {
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.v4.sessions_index_stored_failed",
        module: "bootstrap.zcode_protocol",
      });
      return [];
    }
  };
  return new ConversationV4Gateway({
    cliVersion: context.deps.version,
    sessionExists: (sessionId) => context.sessions.has(sessionId),
    onDebug: (message) => log?.debug(message),
    onTargetCompleted: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return;
      // The background task-notification goal verifier bypasses v4 prompt's
      // finally/afterLegacyStateMutation; TargetChanged(complete) committed, so the future queue has no next
      // mutation to re-evaluate with. Fire the existing gate detached; never block the projection.
      void Promise.resolve()
        .then(() => autoDrainV4QueueIfReady(record))
        .catch((error: unknown) => {
          context.logger?.warn("v4 auto-drain reevaluation after target completion failed", {
            error: error instanceof Error ? error.message : String(error),
            sessionId,
          });
        });
    },
    // The gateway's single READY promise owns concurrency and watermark; the binder only revives the runtime.
    resumePersistedSession: async (
      sessionId,
      resumeThoughtLevel,
      workspace?: ZCodeWorkspaceRef,
    ) => {
      const persisted = await context.deps.sessionStore?.getSession(sessionId as SessionId);
      if (!persisted) {
        context.logger?.warn("ZCode Protocol v4 cold resume has no persisted session", {
          activeSessionCount: context.sessions.size,
          event: "zcode_protocol.v4.resume_persisted_missing",
          module: "bootstrap.zcode_protocol",
          sessionId,
        });
        return { status: "notFound" };
      }
      const activated = await activateSessionForResume(
        context,
        {
          sessionId,
          // session.path may be a normalized exec cwd; it must not override the workspace identity already known
          // from attachment. Legacy sessions without attachment context keep the old persistence fallback.
          ...(workspace ? { workspace } : {}),
          ...(resumeThoughtLevel ? { thoughtLevel: resumeThoughtLevel } : {}),
        },
        { reusePersistedMessages: true },
      );
      return {
        status: "resumed",
        persistedMessages: activated.persistedMessages,
      };
    },
    emitWireFrame: (wire) =>
      context.notify({
        method: V4_NOTIFICATIONS.conversationFrame,
        params: wire,
      }),
    emitLocalTtftFacts: (facts) =>
      context.notify({ method: V4_NOTIFICATIONS.localTtftFacts, params: facts }),
    emitConversationTelemetryFact: (fact) =>
      context.notify({
        method: V4_NOTIFICATIONS.conversationTelemetryFact,
        params: fact,
      }),
    emitCuaPermissionObservation: (observation) =>
      context.notify({
        method: V4_NOTIFICATIONS.cuaPermissionObservation,
        params: observation,
      }),
    // ---------------- config seeds: projection initial values = runtime truth ----------------
    // Three seed sources: startup defaults (workspace model preference + persisted project mode),
    // createSession.config (the handler applies to runtime, then seeds), historical resume (the App restore
    // result may carry model identity only; never bind a half-built execution model just for the projection).
    getSessionMemoryEnabled: (sessionId) => context.sessions.get(sessionId)?.memoryEnabled,
    getSessionConfigSeed: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      const selection =
        record.app.runtime.getSessionModelSelection() ?? record.restoredModelSelection;
      return {
        modelSelection: cloneModelSelection(selection),
        provider: selection?.providerId ?? "",
        model: selection?.modelId ?? "",
        thought: selection?.options?.reasoningLevel ?? "",
        thoughtLevels: selection
          ? (record.app
              .listModels()
              .find(
                (model) =>
                  model.ref.providerId === selection.providerId &&
                  model.ref.modelId === selection.modelId,
              )
              ?.reasoning?.levels.map((level) => level.value) ?? [])
          : [],
        mode: record.app.getMode(),
        planEnabled: record.app.runtime.getPlanEnabled(),
        ...(record.app.runtime.lastPermissionGrantId
          ? { permissionGrant: { interactionId: record.app.runtime.lastPermissionGrantId } }
          : {}),
      };
    },
    getSessionUsageSeed: async (sessionId, persistedMessages) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      const contextUsage = await readSessionContextUsage(context, sessionId, persistedMessages);
      // The usage seed overwrites the first frame's denominator after hydration; it must use the same current
      // model-registry truth as the synthesized event, never write the stale runtime projection's window back.
      return sessionUsageSeedFromRuntimeContextUsage(
        contextUsage,
        resolveSessionModelContextWindow(context, record),
      );
    },
    // ---------------- sessions-index hooks (workspace bucketing + cold-start store seeds) ----------------
    getSessionWorkspaceId: (sessionId) => {
      const record = context.sessions.get(sessionId);
      return !record || !isTaskListSessionType(record.taskType)
        ? null
        : record.workspace.workspaceKey;
    },
    getSessionIndexMeta: (sessionId) => {
      const record = context.sessions.get(sessionId);
      if (!record) return null;
      return {
        createdAt: record.createdAt,
        lastActivityAt: record.updatedAt,
        ...(record.parentSessionId ? { parentSessionId: String(record.parentSessionId) } : {}),
      };
    },
    listWorkspaceSessionIds: (workspaceId) =>
      [...context.sessions.values()]
        .filter(
          (record) =>
            isTaskListSessionType(record.taskType) && record.workspace.workspaceKey === workspaceId,
        )
        .map((record) => record.app.sessionId),
    // Draft test: deferred = no first input sent yet (prompt-turn first input promotes to immediate).
    // Deferred sessions pre-created by legacy workspace prepare must not leak into the sidebar as new tasks.
    isDraftSession: (sessionId) => context.sessions.get(sessionId)?.persistence === "deferred",
    // ---------------- workspace-config hook (config dir subscription seed; live-session fast path, no temp app) ----------------
    getWorkspaceConfig: (workspaceId) => buildLiveWorkspaceConfigStateV4(context, workspaceId),
    getStoredSessionSummaries: loadStoredSessionSummaries,
    refreshLegacySessionSummaries: (workspaceId, legacyTaskIds) =>
      parseRemoteWorkspaceIdentity(workspaceId)
        ? loadStoredSessionSummaries(workspaceId, legacyTaskIds)
        : null,
    // Fallback surface is zero (all 20 commands native): a supports() miss (unknown command type) ->
    // notImplemented → ACK failed fault.command.notImplemented。
    executeCommand: (envelope, admission) =>
      nativeExecutor.supports(envelope.type)
        ? nativeExecutor.execute(envelope, admission)
        : Promise.reject(new V4CommandNotImplementedError(envelope.type)),
    admitCommandInput: async (envelope, admission) => {
      // Hiding the composer cannot stop legacy child tabs from continuing. Type admission must precede
      // ledger/input-history writes; a detached child without a record consult metadata only, never activate a
      // second runtime.
      if (
        envelope.sessionId &&
        (isConversationInputAdmissionCommand(envelope.type) ||
          envelope.type === "resumeGoal" ||
          envelope.type === "sendQueuedNow" ||
          envelope.type === "forkAssistant" ||
          envelope.type === "createSelectionSideSession")
      ) {
        const taskType =
          context.sessions.get(envelope.sessionId)?.taskType ??
          (await context.deps.sessionStore?.getSession(envelope.sessionId as SessionId))?.taskType;
        if (taskType === "subagent_child") {
          throw Object.assign(new Error("Subagent sessions are read-only"), {
            reasonCode: "guard.subagentReadOnly",
          });
        }
      }
      if (!isConversationInputAdmissionCommand(envelope.type)) return null;
      if (!envelope.sessionId) return null;
      return (await coreHost.admitInputCommand?.(envelope, envelope.sessionId, admission)) ?? null;
    },
    cancelCommandInput: async (envelope, queueItemId, reason) => {
      if (!envelope.sessionId) return;
      await coreHost.cancelInputCommand?.(envelope.sessionId, queueItemId, reason);
    },
    terminateTurnForProjectionFault: (sessionId, reasonCode) => {
      const record = context.sessions.get(sessionId);
      const controller = record?.activeAbortController;
      if (!controller || controller.signal.aborted) return;
      // Past 16MiB, further projection growth only makes every later snapshot unencodable.
      // The gateway atomically rejects the oversize event and records a protocol fault, then calls here once to
      // abort the model turn; abort's normal terminal releases the active lock - never fake a TurnError across
      // layers in the gateway.
    },
    // commands/query persistence fallback: lazily build the index on a session's first query; the four sources
    // share it; anchor/marker/child/discarded writes go through record increments.
    lookupTranscriptCommand: (key) =>
      key.sessionId === null
        ? lookupGlobalCreateSessionCommand(context.deps.sessionStore, key.commandId)
        : persistentCommands.lookup("transcript", key),
    lookupTimelineCommand: (key) => persistentCommands.lookup("timeline", key),
    lookupChildCommand: (key) => persistentCommands.lookup("child", key),
    lookupDiscardedCommand: (key) => persistentCommands.lookup("discarded", key),
    invalidatePersistentCommandFacts: (sessionId) => persistentCommands.invalidate(sessionId),
    // The gateway already verified per-chunk totals/checksums; write complete bytes to the artifact atomically.
    putSessionAttachment: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.attachment.sessionNotFound: ${sessionId}`);
      }
      return record.app.writePromptAttachment(input);
    },
    readBackgroundBashOutput: (sessionId, workId) =>
      readBackgroundBashOutputFromOwner(context, sessionId, workId),
    readSessionAttachment: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.attachment.sessionNotFound: ${sessionId}`);
      }
      return record.app.readPromptAttachment(input);
    },
    statSessionAttachment: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.attachment.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.statPromptAttachment) {
        throw new Error("fault.attachment.statUnsupported");
      }
      return record.app.statPromptAttachment(input);
    },
    resolveSessionAttachmentPreviewSource: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.attachment.sessionNotFound: ${sessionId}`);
      }
      return record.app.resolvePromptAttachmentPreviewSource(input);
    },
    getConversationFileChanges: async (sessionId, _targetRowId, messageIds, targetTurnId) => {
      const record = await resolveConversationBackingRecord(context, sessionId);
      if (!record) {
        throw new Error(`fault.fileChanges.sessionNotFound: ${sessionId}`);
      }
      return readConversationFileChanges(record, sessionId, messageIds, targetTurnId);
    },
    // dwf event log: the capability lives on the app (present only if the run service built); when absent do not
    // fake an empty page here - the gateway answers structured unsupported-capability, letting the renderer
    // distinguish no-events from no-capability.
    listDynamicWorkflowRunEvents: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunEvents.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRunEvents) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunEvents", sessionId);
      }
      // Call via app (do not destructure: the implementation may rely on this binding).
      return record.app.listDynamicWorkflowRunEvents(input);
    },
    // Workflow run enumeration: same capability condition as above (present only if the run service built).
    listDynamicWorkflowRuns: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRuns.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRuns) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRuns", sessionId);
      }
      // Call via app (do not destructure: the implementation may rely on this binding).
      return record.app.listDynamicWorkflowRuns(input);
    },
    // The three user-facing artifact read sides: same capability condition as above.
    // Terminology: artifact = what the script published via artifact.*, not the run's top-level return value.
    listDynamicWorkflowRunArtifacts: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunArtifacts.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRunArtifacts) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunArtifacts", sessionId);
      }
      return record.app.listDynamicWorkflowRunArtifacts(input);
    },
    listDynamicWorkflowRunArtifactItems: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunArtifactData.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRunArtifactItems) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunArtifactItems", sessionId);
      }
      return record.app.listDynamicWorkflowRunArtifactItems(input);
    },
    readDynamicWorkflowRunArtifact: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunArtifactRead.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.readDynamicWorkflowRunArtifact) {
        throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunArtifact", sessionId);
      }
      return record.app.readDynamicWorkflowRunArtifact(input);
    },
    // The two workspace-transcript read sides: same capability condition as above.
    listDynamicWorkflowRunWorkspaceNodes: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunWorkspace.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.listDynamicWorkflowRunWorkspaceNodes) {
        throw new V4CapabilityUnsupportedError("listDynamicWorkflowRunWorkspaceNodes", sessionId);
      }
      return record.app.listDynamicWorkflowRunWorkspaceNodes(input);
    },
    readDynamicWorkflowRunNodeResult: async (sessionId, input) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.workflowRunNodeResult.sessionNotFound: ${sessionId}`);
      }
      if (!record.app.readDynamicWorkflowRunNodeResult) {
        throw new V4CapabilityUnsupportedError("readDynamicWorkflowRunNodeResult", sessionId);
      }
      return record.app.readDynamicWorkflowRunNodeResult(input);
    },
    previewConversationFileRewind: async (sessionId, _targetRowId, messageIds, targetTurnId) => {
      const record = context.sessions.get(sessionId);
      if (!record) {
        throw new Error(`fault.fileRewindPreview.sessionNotFound: ${sessionId}`);
      }
      return previewConversationFileRewind(record, messageIds, targetTurnId);
    },
    // Cold subscription no longer XORs eventStore vs transcript. message/part is the
    // completed-body authority; session_entry only backfills legacy goals; memory events only backfill
    // unpersisted in-flight plus queue/permission/control ephemerals.
    loadPersistedEvents: async (sessionId, persistedMessages) => {
      // Detached live children (dwf workflow actors / subagents) have no bootstrap record of their own (events
      // route through the parent record's sink via ingestDetachedLiveSession).
      // When context.sessions.get misses, never return synthesized:false -
      // else first-subscription performHydration takes the keep-healthy-live-publisher early return and the
      // three-way durable merge never runs, so a projection fed only by live events loses every persisted body
      // that does not arrive as a live event. amend-resume copies the predecessor transcript prefix into the
      // session store to seed the actor - exactly this class - leaving the sidebar actor transcript with only the
      // live delta; after a plain crash the warm window likewise misses pre-crash actor messages.
      // Use resolveConversationBackingRecord: with no child record, fall to the parent via persisted parentID,
      // borrowing only its shared event/artifact store while event reads keep the child's own sessionId (the
      // script workflow child runtime shares the parent event store; events archive under the child sessionId),
      // so sourceEventSeq stays the child's true watermark.
      // Cost: the contextWindow denominator resolves per the parent's current model, not the actor's - display-only.
      const record = await resolveConversationBackingRecord(context, sessionId);
      if (!record) {
        // Diagnostics: hydrate expects the runtime already cold-resume-activated; when even the parent fallback
        // misses, empty events would disguise a real lifecycle race as empty-history - leave an explicit trace.
        context.logger?.warn("ZCode Protocol v4 hydrate has no active runtime", {
          activeSessionCount: context.sessions.size,
          event: "zcode_protocol.v4.hydrate_runtime_missing",
          module: "bootstrap.zcode_protocol",
          phase: "loadPersistedEvents",
          sessionId,
        });
        return { events: [], synthesized: false, sourceEventSeq: 0 };
      }
      // During the async message/part and session_entry reads the live sink may still receive events.
      // The gateway must know the raw cursor of the memory eventStore snapshot to backfill only the await-window
      // tail and stably map transcript-synthesized 1..N onto subsequent runtime raw seqs.
      // The memory store evicts completed turns' transient events, so max(events.seq) can undershoot the true
      // cursor and replay evicted deltas as the await tail. No await between the two calls: one consistent
      // snapshot.
      const [liveEvents, sourceEventSeq] = await Promise.all([
        record.eventStore.getEvents(sessionId as SessionId),
        record.eventStore.getLatestSequenceNumber(sessionId as SessionId),
      ]);
      // Workflow-run cold replay: journal-replayed progress events prepend memory events - cold merge already
      // classifies the type as memory-only authority (order kept in supplements), the projection reduces through
      // the same reducer, so workflowRuns matches across restarts.
      const replayed = await replayDynamicWorkflowRunEvents(context, sessionId, record, liveEvents);
      const events = replayed.length === 0 ? liveEvents : [...replayed, ...liveEvents];
      const store = context.deps.sessionStore;
      const source = await loadPersistedConversationMaterialization({
        memoryEvents: events,
        persistedMessages,
        sessionId,
        ...(store
          ? {
              store: {
                getSession: (id) => store.getSession(id),
                messages: (input) => store.messages(input),
                readTarget: (input) => store.readTarget(input),
                ...(store.sessionEntries
                  ? {
                      sessionEntries: (input) =>
                        store.sessionEntries!(input).catch((error) => {
                          context.logger?.warn("v4 hydrate session entries read failed", {
                            error: error instanceof Error ? error.message : String(error),
                            event: "zcode_protocol.v4.hydrate_session_entries_failed",
                            module: "bootstrap.zcode_protocol",
                          });
                          return [];
                        }),
                    }
                  : {}),
              },
            }
          : {}),
      });
      // live ModelComplete.fileChanges exists only in memory events; with the persisted transcript as body
      // authority, cold merge suppresses it, and the transcript has no file-summary field.
      // workspace checkpoint + artifact are the cross-process durable facts: rebuild the summary by user
      // messageId here, then let transcript hydration synthesize the isomorphic ModelComplete.
      const fileChangeSummariesByMessageId = await buildColdFileChangeSummaries({
        events: source.memoryEvents,
        messageIds: source.messages.map((message) => String(message.info.id)),
        readArtifact: async (snapshotRef) =>
          (await record.app.readToolResultArtifact(snapshotRef)).content,
        onArtifactError: (messageId, error) =>
          context.logger?.warn("v4 cold file change artifact read failed", {
            error: error instanceof Error ? error.message : String(error),
            event: "zcode_protocol.v4.hydrate_file_changes_failed",
            messageId,
            module: "bootstrap.zcode_protocol",
            sessionId,
          }),
      });
      // Cold-resume transcripts store no model capability; legacy hydration filled 200k.
      // The provider registry settled before resume; read the precise value for the restored/backoff current model.
      const contextWindow = resolveSessionModelContextWindow(context, record);
      const usageSeed = sessionUsageSeedFromRuntimeContextUsage(
        await readSessionContextUsage(context, sessionId, source.messages),
        contextWindow,
      );
      const merged = mergeColdConversationEvents({
        contextWindow,
        fileChangeSummariesByMessageId,
        memoryEvents: source.memoryEvents,
        messages: source.messages,
        sessionId,
        goalVerificationEntries: source.goalVerificationEntries,
        ...(Object.prototype.hasOwnProperty.call(source, "target")
          ? { target: source.target }
          : {}),
      });
      for (const diagnostic of merged.diagnostics) {
        const fields = {
          ...diagnostic,
          event: "zcode_protocol.v4.hydrate_three_source_merge",
          module: "bootstrap.zcode_protocol",
          sessionId,
        };
        if (
          diagnostic.code === "cold_merge.ambiguous_legacy_turn_preserved" ||
          diagnostic.code === "cold_merge.memory_boundary_preserved" ||
          diagnostic.code === "cold_merge.unclassified_event_preserved"
        ) {
          context.logger?.warn("v4 hydrate preserved ambiguous cold fact", fields);
        } else {
          log?.debug("v4 hydrate merged duplicate cold facts", fields);
        }
      }
      // The transcript may restore the Agent row without proving the child session persisted.
      // Generate the validation seed before the gateway's raw-event buffer backfill: excludes stale ghost refs
      // and keeps async queries from overriding the seed after later live spawn/stop.
      const subagents = await listSessionSubagents(
        context,
        { sessionId, endedLimit: 1 },
        persistedMessages,
      );
      return {
        events: merged.events,
        // Shares this query's result with the synthesized events; never re-read another capacity in the later
        // backfill phase.
        // The gateway's legacy field is still named synthesized; here it means the projection was re-materialized
        // from the durable transcript and the ingest-created cold publisher must be replaced.
        synthesized: merged.usedDurableTranscript,
        subagentsSeed: {
          revision: subagents.revision,
          childSessionIds: subagents.childSessionIds,
          running: subagents.running,
        },
        ...(source.sharedContextImport ? { sharedContextImport: source.sharedContextImport } : {}),
        sourceEventSeq,
      };
    },
    onError: (scope, error, errorContext) =>
      context.logger?.warn("ZCode Protocol v4 gateway error", {
        ...errorContext,
        error: error instanceof Error ? error.message : String(error),
        event: "zcode_protocol.v4.gateway_error",
        module: "bootstrap.zcode_protocol",
        scope,
      }),
  });
}
