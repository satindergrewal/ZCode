import { parseRuntimeInputPresentation } from "@zcode/contracts";
import {
  unpublishedPermissionGrants,
  recoverPendingPermissionGrant,
} from "../permission-grant-recovery.js";
import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import { withConversationQuotes } from "../helpers/conversation-quotes.js";
import {
  CoreErrorType,
  SessionEventType,
  createCoreError,
  createMessageId,
  createQueryId,
  createSessionEvent,
  traceContextToLogContext,
} from "../deps.js";
import type {
  CollaborationMode,
  MessageId,
  ModelSelection,
  ModelSelectionOrigin,
  PendingSteerInputInfo,
  PendingTurnInput,
  QueryId,
  SessionEvent,
  TraceContext,
  TurnSteerInput,
  TurnSteerRejectReason,
  TurnSteerResult,
  TurnSteerSource,
  TurnId,
} from "../deps.js";
import { cloneModelSelection } from "../model-selection.js";
import { createRuntimeModel } from "./runtime-model.js";
import {
  buildUserContentFromTurn,
  measureUtf8Bytes,
  MAX_TURN_STEER_INPUT_BYTES,
  previewInput,
  resolveTurnAttachments,
} from "../helpers/index.js";
import type {
  ActiveTurnKind,
  ActiveTurnSteeringState,
  DrainedPendingInputDiagnostics,
} from "../types.js";
import {
  createRuntimeUserEntry,
  realUserRuntimeMetadata,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";

function hasSteerInput(request: Pick<TurnSteerInput, "attachments" | "input" | "intent">): boolean {
  return (
    request.input.trim().length > 0 ||
    Boolean(request.attachments?.length) ||
    Boolean(request.intent?.conversationQuotes?.length)
  );
}

export async function steerTurn(
  this: AgentRuntimeInternal,
  input: string | TurnSteerInput,
): Promise<TurnSteerResult> {
  const request = typeof input === "string" ? { input } : input;
  const activeTurn = this.activeTurn;
  const inputSize = measureUtf8Bytes(request.input);
  const inputPreview = previewInput(request.input);

  // Attachment input may have no body; the legacy check looked at input only, so accepted attachments could never enter the authoritative queue.
  if (!hasSteerInput(request)) {
    return await this.rejectTurnSteer("empty_input", {
      activeTurn,
      expectedTurnId: request.expectedTurnId,
      inputPreview,
      inputSize,
      traceContext: request.traceContext,
    });
  }

  if (inputSize > MAX_TURN_STEER_INPUT_BYTES) {
    return await this.rejectTurnSteer("input_too_large", {
      activeTurn,
      expectedTurnId: request.expectedTurnId,
      inputPreview,
      inputSize,
      traceContext: request.traceContext,
    });
  }

  if (!activeTurn) {
    return await this.rejectTurnSteer("no_active_turn", {
      expectedTurnId: request.expectedTurnId,
      inputPreview,
      inputSize,
      traceContext: request.traceContext,
    });
  }

  if (request.expectedTurnId !== undefined && request.expectedTurnId !== activeTurn.turnId) {
    return await this.rejectTurnSteer("expected_turn_mismatch", {
      activeTurn,
      expectedTurnId: request.expectedTurnId,
      inputPreview,
      inputSize,
      traceContext: request.traceContext,
    });
  }

  if (!activeTurn.steerable) {
    return await this.rejectTurnSteer("turn_not_steerable", {
      activeTurn,
      expectedTurnId: request.expectedTurnId,
      inputPreview,
      inputSize,
      traceContext: request.traceContext,
    });
  }

  const queryId = request.queryId ?? (request.inputId as QueryId | undefined) ?? createQueryId();
  const commandKind = request.commandKind;
  const source: TurnSteerSource | undefined = request.source;
  const delivery = request.delivery;
  const toolDisallowlist = request.toolDisallowlist;
  const queuePosition = activeTurn.pendingInputs.length;
  const intent = request.intent
    ? {
        ...request.intent,
        admittedDelivery: request.delivery ?? request.intent.admittedDelivery,
        queuePosition,
      }
    : undefined;
  const pendingInput: PendingTurnInput = {
    id:
      request.pendingInputId ??
      request.intent?.queueItemId ??
      this.createPendingInputId(activeTurn.turnId),
    input: request.input,
    queuedAt: new Date(),
    traceId: activeTurn.traceContext.traceId,
    queryId,
    ...(commandKind ? { commandKind } : {}),
    ...(source ? { source } : {}),
    ...(request.inputPresentation ? { inputPresentation: request.inputPresentation } : {}),
    ...(delivery ? { delivery } : {}),
    ...(intent ? { intent } : {}),
    ...(request.attachments ? { attachments: request.attachments } : {}),
    ...(toolDisallowlist ? { toolDisallowlist } : {}),
    turnId: activeTurn.turnId,
  };
  activeTurn.pendingInputs.push(pendingInput);
  const queueLength = activeTurn.pendingInputs.length;
  const event = createSessionEvent(
    SessionEventType.TurnSteerQueued,
    this.sessionId,
    {
      inputId: request.inputId,
      queryId,
      pendingInputId: pendingInput.id,
      input: pendingInput.input,
      inputPreview,
      inputSize,
      ...(commandKind ? { commandKind } : {}),
      ...(source ? { source } : {}),
      ...(request.inputPresentation ? { inputPresentation: request.inputPresentation } : {}),
      ...(delivery ? { delivery } : {}),
      ...(intent ? { intent } : {}),
      ...(toolDisallowlist ? { toolDisallowlist } : {}),
      targetTurnId: activeTurn.turnId,
      queueLength,
    },
    {
      traceId: activeTurn.traceContext.traceId,
      turnId: activeTurn.turnId,
    },
  );
  await this.appendEvent(event, activeTurn.traceContext);
  this.logger?.debug("Turn steer queued", {
    ...traceContextToLogContext(activeTurn.traceContext),
    activeTurnKind: activeTurn.kind,
    activeTurnSteerable: activeTurn.steerable,
    inputId: request.inputId,
    queryId,
    event: "turn.steer.queued",
    expectedTurnId: request.expectedTurnId,
    inputPreview,
    inputSize,
    module: "core.runtime",
    pendingInputId: pendingInput.id,
    queueLength,
    ...(source ? { source } : {}),
    ...(request.inputPresentation ? { inputPresentation: request.inputPresentation } : {}),
    status: "waiting",
    targetTurnId: activeTurn.turnId,
  });

  return {
    kind: "queued",
    pendingInputId: pendingInput.id,
    queueLength,
    turnId: activeTurn.turnId,
  };
}

export async function enqueueDeferredInput(
  this: AgentRuntimeInternal,
  input: string | TurnSteerInput,
): Promise<TurnSteerResult> {
  const request = typeof input === "string" ? { input } : input;
  const inputSize = measureUtf8Bytes(request.input);
  const inputPreview = previewInput(request.input);
  const traceContext = request.traceContext ?? this.rootTraceContext;

  if (!hasSteerInput(request)) {
    return await this.rejectTurnSteer("empty_input", {
      inputPreview,
      inputSize,
      traceContext,
    });
  }

  if (inputSize > MAX_TURN_STEER_INPUT_BYTES) {
    return await this.rejectTurnSteer("input_too_large", {
      inputPreview,
      inputSize,
      traceContext,
    });
  }

  const targetTurnId =
    this.activeTurn?.turnId ??
    this.latestAssistantTurnId ??
    traceContext.turnId ??
    ("deferred" as TurnId);
  const queryId = request.queryId ?? (request.inputId as QueryId | undefined) ?? createQueryId();
  const commandKind = request.commandKind;
  const source: TurnSteerSource | undefined = request.source;
  const delivery = request.delivery ?? "queue";
  const toolDisallowlist = request.toolDisallowlist;
  const pendingInputId =
    request.pendingInputId ??
    request.intent?.queueItemId ??
    this.createPendingInputId(targetTurnId);
  const projection = await this.rebuildProjection();
  const queueLength = projection.pendingSteerInputs.length + 1;
  const intent = request.intent
    ? {
        ...request.intent,
        admittedDelivery: delivery,
        queuePosition: queueLength - 1,
      }
    : undefined;
  const event = createSessionEvent(
    SessionEventType.TurnSteerQueued,
    this.sessionId,
    {
      ...(request.inputId ? { inputId: request.inputId } : {}),
      queryId,
      pendingInputId,
      input: request.input,
      inputPreview,
      inputSize,
      ...(commandKind ? { commandKind } : {}),
      ...(source ? { source } : {}),
      ...(request.inputPresentation ? { inputPresentation: request.inputPresentation } : {}),
      delivery,
      ...(intent ? { intent } : {}),
      ...(toolDisallowlist ? { toolDisallowlist } : {}),
      targetTurnId,
      queueLength,
    },
    {
      traceId: traceContext.traceId,
      turnId: targetTurnId,
    },
  );
  await this.appendEvent(event, traceContext);
  this.logger?.debug("Deferred input queued", {
    ...traceContextToLogContext(traceContext),
    delivery,
    event: "turn.deferred_input.queued",
    inputId: request.inputId,
    inputPreview,
    inputSize,
    module: "core.runtime",
    pendingInputId,
    queueLength,
    status: "waiting",
    targetTurnId,
  });

  return {
    kind: "queued",
    pendingInputId,
    queueLength,
    turnId: targetTurnId,
  };
}

export function beginActiveTurn(
  this: AgentRuntimeInternal,
  turnId: TurnId,
  traceContext: TraceContext,
  kind: ActiveTurnKind,
  steerable: boolean,
  options?: { inputId?: string },
): ActiveTurnSteeringState {
  if (this.activeTurn) {
    throw createTurnInProgressError(kind, this.activeTurn.turnId, turnId);
  }
  const reservation = this.activeTurnStartReservation;
  if (reservation && reservation.turnId !== turnId) {
    throw createTurnInProgressError(kind, reservation.turnId, turnId);
  }

  const activeTurn: ActiveTurnSteeringState = {
    goalStateChangeReminderDeferralOpen: false,
    kind,
    pendingInputs: [],
    steerable,
    traceContext,
    turnId,
    ...(options?.inputId === undefined ? {} : { inputId: options.inputId }),
  };
  this.activeTurnStartReservation = undefined;
  this.activeTurn = activeTurn;
  return activeTurn;
}

export function reserveTurnStart(
  this: AgentRuntimeInternal,
  turnId: TurnId,
  traceContext: TraceContext,
  kind: ActiveTurnKind,
): void {
  if (this.activeTurn) {
    throw createTurnInProgressError(kind, this.activeTurn.turnId, turnId);
  }
  if (this.activeTurnStartReservation) {
    throw createTurnInProgressError(kind, this.activeTurnStartReservation.turnId, turnId);
  }
  this.activeTurnStartReservation = {
    kind,
    traceContext,
    turnId,
  };
}

export function releaseTurnStart(this: AgentRuntimeInternal, turnId: TurnId): void {
  if (this.activeTurnStartReservation?.turnId === turnId) {
    this.activeTurnStartReservation = undefined;
  }
}

export function finishActiveTurn(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState | undefined,
): void {
  if (activeTurn !== undefined && this.activeTurn === activeTurn) {
    this.activeTurn = undefined;
  }
}

export function createPendingInputId(this: AgentRuntimeInternal, turnId: TurnId): string {
  this.pendingInputSequence += 1;
  return `pending_${turnId}_${this.pendingInputSequence}`;
}

function createTurnInProgressError(
  kind: ActiveTurnKind,
  activeTurnId: TurnId,
  nextTurnId: TurnId,
): Error {
  return createCoreError(
    CoreErrorType.TurnInProgress,
    `Cannot start ${kind} turn while another turn is active`,
    {
      context: {
        activeTurnId,
        nextTurnId,
      },
      recoverable: true,
    },
  );
}

export async function rejectTurnSteer(
  this: AgentRuntimeInternal,
  reason: TurnSteerRejectReason,
  options: {
    activeTurn?: ActiveTurnSteeringState;
    expectedTurnId?: TurnId;
    inputPreview?: string;
    inputSize?: number;
    traceContext?: TraceContext;
  },
): Promise<TurnSteerResult> {
  const traceContext =
    options.activeTurn?.traceContext ?? options.traceContext ?? this.rootTraceContext;
  const event = createSessionEvent(
    SessionEventType.TurnSteerRejected,
    this.sessionId,
    {
      activeTurnId: options.activeTurn?.turnId,
      expectedTurnId: options.expectedTurnId,
      inputPreview: options.inputPreview,
      inputSize: options.inputSize,
      reason,
    },
    {
      traceId: traceContext.traceId,
      turnId: options.activeTurn?.turnId,
    },
  );
  await this.appendEvent(event, traceContext);
  this.logger?.debug("Turn steer rejected", {
    ...traceContextToLogContext(traceContext),
    activeQueueLength: options.activeTurn?.pendingInputs.length,
    activeTurnId: options.activeTurn?.turnId,
    activeTurnKind: options.activeTurn?.kind,
    activeTurnSteerable: options.activeTurn?.steerable,
    event: "turn.steer.rejected",
    expectedTurnId: options.expectedTurnId,
    inputPreview: options.inputPreview,
    inputSize: options.inputSize,
    module: "core.runtime",
    reason,
    status: "completed",
  });
  return {
    activeTurnId: options.activeTurn?.turnId,
    kind: "rejected",
    reason,
  };
}

export function hasPendingInput(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState,
): boolean {
  return this.activeTurn === activeTurn && activeTurn.pendingInputs.length > 0;
}

function pendingInputDelivery(pendingInput: PendingTurnInput | undefined): "guide" | "queue" {
  const delivery = pendingInput?.delivery ?? pendingInput?.intent?.admittedDelivery;
  return delivery === "guide" ? "guide" : "queue";
}

function firstInlineGuideIndex(activeTurn: ActiveTurnSteeringState): number {
  // pendingInputs holds both the future queue and the current-turn guide; checking only the
  // array head let earlier queued messages block later explicit guides forever. delivery is the consumption lane;
  // keep admission FIFO inside the guide subsequence only; plain queue stays put for outer promotion.
  return activeTurn.pendingInputs.findIndex(
    (pendingInput) =>
      pendingInput.commandKind !== "sendGoalCommand" &&
      pendingInput.commandKind !== "compact" &&
      pendingInputDelivery(pendingInput) === "guide",
  );
}

export function hasInlineGuidePendingInput(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState,
): boolean {
  const guideIndex = firstInlineGuideIndex(activeTurn);
  const pendingInput = guideIndex >= 0 ? activeTurn.pendingInputs[guideIndex] : undefined;
  return (
    this.activeTurn === activeTurn &&
    !this.permissionFullAccessPending &&
    !this.queueExternalDrainActive &&
    !this.pendingInputReservations.has(pendingInput?.id ?? "") &&
    pendingInput?.commandKind !== "sendGoalCommand" &&
    pendingInput?.commandKind !== "compact" &&
    pendingInputDelivery(pendingInput) === "guide"
  );
}

/**
 // * When the current product turn is stopped/interrupted, or a FIFO barrier blocks safe inlining, re-route unconsumed
 // * guides into the plain queue in place. Consumable text-only guides keep running in the current active turn.
 */
export async function fallbackPendingGuidesToQueue(
  this: AgentRuntimeInternal,
  options: {
    activeTurn: ActiveTurnSteeringState;
    events?: SessionEvent[];
    reasonCode: "guide.noToolBoundary" | "guide.turnInterrupted";
    traceContext: TraceContext;
  },
): Promise<number> {
  if (this.activeTurn !== options.activeTurn) return 0;
  let changed = 0;
  for (const pendingInput of options.activeTurn.pendingInputs) {
    if (pendingInputDelivery(pendingInput) !== "guide") continue;
    const intent = pendingInput.intent
      ? {
          ...pendingInput.intent,
          admittedDelivery: "queue" as const,
          fallbackReasonCode: options.reasonCode,
        }
      : undefined;
    const event = this.createEvent(
      SessionEventType.TurnSteerDeliveryChanged,
      {
        admittedDelivery: "queue",
        fallbackReasonCode: options.reasonCode,
        ...(intent ? { intent } : {}),
        pendingInputId: pendingInput.id,
        requestedDelivery: "guide",
        targetTurnId: options.activeTurn.turnId,
      },
      options.traceContext,
    );
    await this.appendEvent(event, options.traceContext);
    options.events?.push(event);
    pendingInput.delivery = "queue";
    if (intent) pendingInput.intent = intent;
    changed += 1;
    this.logger?.debug("Guide input fell back to ordinary queue", {
      ...traceContextToLogContext(options.traceContext),
      event: "turn.guide.fell_back",
      fallbackReasonCode: options.reasonCode,
      module: "core.runtime",
      pendingInputId: pendingInput.id,
      status: "completed",
      targetTurnId: options.activeTurn.turnId,
    });
  }
  return changed;
}

async function pendingInputTargetTurnId(
  runtime: AgentRuntimeInternal,
  pendingInputId: string,
): Promise<TurnId | undefined> {
  const active = runtime.activeTurn?.pendingInputs.find((item) => item.id === pendingInputId);
  if (active) return active.turnId;
  const projection = await runtime.rebuildProjection();
  return projection.pendingSteerInputs.find((item) => item.pendingInputId === pendingInputId)
    ?.targetTurnId;
}

async function appendPendingInputDispatch(
  runtime: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId?: string;
    state: "queued" | "reserved" | "promoting";
    targetTurnId: TurnId;
    traceContext: TraceContext;
  },
): Promise<void> {
  const event = createSessionEvent(
    SessionEventType.TurnSteerDispatchChanged,
    runtime.sessionId,
    {
      pendingInputId: options.pendingInputId,
      ...(options.reservationId ? { reservationId: options.reservationId } : {}),
      state: options.state,
      targetTurnId: options.targetTurnId,
    },
    { traceId: options.traceContext.traceId, turnId: options.targetTurnId },
  );
  await runtime.appendEvent(event, options.traceContext);
}

async function settleRemovedSessionInput(
  runtime: AgentRuntimeInternal,
  pendingInputId: string,
  reason: "user_removed" | "promoted",
): Promise<void> {
  if (reason !== "user_removed") return;
  // Deleting only the in-memory queue/events leaves admitted durable session_input rows.
  // After LRU eviction commands/queries degrade to unknown, and a CLI restart would misreport a user's own deletion as
  // inputDiscardedOnRestart. Write the cancelled terminal first; never let the UI queue vanish before it.
  await runtime.sessionStore?.settleSessionInput?.({
    id: pendingInputId,
    sessionID: runtime.sessionId,
    status: "cancelled",
    reason: "user_removed",
  });
}

async function persistSessionInputUpdates(
  runtime: AgentRuntimeInternal,
  updates: Array<{ id: string; text?: string; queuePosition?: number }>,
): Promise<void> {
  await runtime.sessionStore?.updateSessionInputs?.({
    sessionID: runtime.sessionId,
    updates,
  });
}

export async function reservePendingInputById(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  if (this.permissionFullAccessPending || this.pendingInputReservations.has(options.pendingInputId))
    return false;
  if (unpublishedPermissionGrants.has(this)) await recoverPendingPermissionGrant(this);
  const targetTurnId = await pendingInputTargetTurnId(this, options.pendingInputId);
  // rebuildProjection has an await above; recheck before taking the lock so both ends cannot read unclaimed at once.
  if (
    !targetTurnId ||
    this.permissionFullAccessPending ||
    this.pendingInputReservations.has(options.pendingInputId)
  )
    return false;
  this.pendingInputReservations.set(options.pendingInputId, options.reservationId);
  try {
    await appendPendingInputDispatch(this, {
      ...options,
      state: "reserved",
      targetTurnId,
    });
    return true;
  } catch (error) {
    this.pendingInputReservations.delete(options.pendingInputId);
    throw error;
  }
}

export async function markPendingInputPromoting(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  if (this.pendingInputReservations.get(options.pendingInputId) !== options.reservationId) {
    return false;
  }
  const targetTurnId = await pendingInputTargetTurnId(this, options.pendingInputId);
  if (!targetTurnId) return false;
  await appendPendingInputDispatch(this, {
    ...options,
    state: "promoting",
    targetTurnId,
  });
  return true;
}

export async function releasePendingInputReservation(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reservationId: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  if (this.pendingInputReservations.get(options.pendingInputId) !== options.reservationId) {
    return false;
  }
  const targetTurnId = await pendingInputTargetTurnId(this, options.pendingInputId);
  this.pendingInputReservations.delete(options.pendingInputId);
  if (!targetTurnId) return true;
  try {
    await appendPendingInputDispatch(this, {
      pendingInputId: options.pendingInputId,
      state: "queued",
      targetTurnId,
      traceContext: options.traceContext,
    });
  } catch (error) {
    // On event-write failure the reservation must hold; never let the second end execute twice.
    this.pendingInputReservations.set(options.pendingInputId, options.reservationId);
    throw error;
  }
  return true;
}

/**
 // * (v4 per-item queue op): remove one entry by id from the active turn's pendingInputs,
 // * emitting TurnSteerDiscarded([id]). The v4 ProductProjection consumes it and drops the queue row.
 // * Legacy queues were renderer-local with no per-item op; v4 queue lives in the CLI projection, hence this native ability.
 // * Returns whether removed (id miss / no active turn -> false).
 */
export async function removePendingInputById(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    reason: "user_removed" | "promoted";
    reservationId?: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  const reservationId = this.pendingInputReservations.get(options.pendingInputId);
  if (reservationId && reservationId !== options.reservationId) return false;
  const activeTurn = this.activeTurn;
  const index =
    activeTurn?.pendingInputs.findIndex(
      (pendingInput) => pendingInput.id === options.pendingInputId,
    ) ?? -1;
  if (!activeTurn || index < 0) {
    // held fallback (stop/completion keeps the queue as held): held items exist only in the
    // event log/projection (the active turn ended); locate via projection then emit TurnSteerDiscarded.
    return this.discardHeldPendingInputById(
      options.pendingInputId,
      options.traceContext,
      options.reservationId,
      options.reason,
    );
  }
  await settleRemovedSessionInput(this, options.pendingInputId, options.reason);
  activeTurn.pendingInputs.splice(index, 1);
  const event = createSessionEvent(
    SessionEventType.TurnSteerDiscarded,
    this.sessionId,
    {
      pendingInputIds: [options.pendingInputId],
      reason: options.reason,
      targetTurnId: activeTurn.turnId,
    },
    {
      traceId: activeTurn.traceContext.traceId,
      turnId: activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  this.pendingInputReservations.delete(options.pendingInputId);
  this.logger?.debug("Turn steer item removed", {
    ...traceContextToLogContext(options.traceContext),
    event: "turn.steer.removed",
    module: "core.runtime",
    pendingInputId: options.pendingInputId,
    status: "completed",
    targetTurnId: activeTurn.turnId,
  });
  return true;
}

/**
 // * Drop a held item by id (the executor of heldQueueDisposition=clearQueueAndSend):
 // * the active turn's in-memory pendingInputs dies with the turn; held queues' authority is the event log --
 once the projection confirms not drained/discarded, emit TurnSteerDiscarded(user_removed).
 */
export async function discardHeldPendingInputById(
  this: AgentRuntimeInternal,
  pendingInputId: string,
  traceContext: TraceContext,
  reservationId?: string,
  reason: "user_removed" | "promoted" = "user_removed",
): Promise<boolean> {
  const currentReservation = this.pendingInputReservations.get(pendingInputId);
  if (currentReservation && currentReservation !== reservationId) return false;
  const projection = await this.rebuildProjection();
  const held = projection.pendingSteerInputs.find((item) => item.pendingInputId === pendingInputId);
  if (!held) return false;
  await settleRemovedSessionInput(this, pendingInputId, reason);
  const event = createSessionEvent(
    SessionEventType.TurnSteerDiscarded,
    this.sessionId,
    {
      pendingInputIds: [pendingInputId],
      reason,
      targetTurnId: held.targetTurnId,
    },
    {
      traceId: traceContext.traceId,
      turnId: held.targetTurnId,
    },
  );
  await this.appendEvent(event, traceContext);
  this.pendingInputReservations.delete(pendingInputId);
  this.logger?.debug("Turn steer item removed", {
    ...traceContextToLogContext(traceContext),
    event: "turn.steer.removed",
    module: "core.runtime",
    pendingInputId,
    status: "completed",
    targetTurnId: held.targetTurnId,
  });
  return true;
}

/**
 // * Clear all queued input (executor of clearQueueAndSend):
 // * first lift the active turn's in-memory items (no later roundtrip drain), then sweep held leftovers via the projection.
 // * Returns the discarded count.
 */
export async function clearAllPendingInputs(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<number> {
  let cleared = 0;
  const activeTurn = this.activeTurn;
  if (activeTurn && activeTurn.pendingInputs.length > 0) {
    for (const item of activeTurn.pendingInputs) {
      await settleRemovedSessionInput(this, item.id, "user_removed");
    }
    const removed = activeTurn.pendingInputs.splice(0);
    cleared += removed.length;
    const event = createSessionEvent(
      SessionEventType.TurnSteerDiscarded,
      this.sessionId,
      {
        pendingInputIds: removed.map((item) => item.id),
        reason: "user_removed",
        targetTurnId: activeTurn.turnId,
      },
      {
        traceId: activeTurn.traceContext.traceId,
        turnId: activeTurn.turnId,
      },
    );
    await this.appendEvent(event, traceContext);
  }
  const projection = await this.rebuildProjection();
  const heldByTurn = new Map<TurnId, PendingSteerInputInfo[]>();
  for (const item of projection.pendingSteerInputs) {
    const group = heldByTurn.get(item.targetTurnId) ?? [];
    group.push(item);
    heldByTurn.set(item.targetTurnId, group);
  }
  for (const [targetTurnId, group] of heldByTurn) {
    for (const item of group) {
      await settleRemovedSessionInput(this, item.pendingInputId, "user_removed");
    }
    cleared += group.length;
    const event = createSessionEvent(
      SessionEventType.TurnSteerDiscarded,
      this.sessionId,
      {
        pendingInputIds: group.map((item) => item.pendingInputId),
        reason: "user_removed",
        targetTurnId,
      },
      {
        traceId: traceContext.traceId,
        turnId: targetTurnId,
      },
    );
    await this.appendEvent(event, traceContext);
  }
  return cleared;
}

/**
 // * (v4 per-item edit): replace a queued input's text by id, re-emitting TurnSteerQueued (same id).
 // * The v4 reducer's onTurnSteerQueued updates in place (position kept). Miss / no active turn -> false.
 */
export async function editPendingInputById(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    newText: string;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  const activeTurn = this.activeTurn;
  const pendingInput = activeTurn?.pendingInputs.find((item) => item.id === options.pendingInputId);
  if (!activeTurn || !pendingInput) {
    // held fallback: held items live only in the event log/projection; locate via projection and
    // re-emit the same-id TurnSteerQueued (the v4 reducer updates in place, keeping position).
    const projection = await this.rebuildProjection();
    const held = projection.pendingSteerInputs.find(
      (item) => item.pendingInputId === options.pendingInputId,
    );
    if (!held) return false;
    await persistSessionInputUpdates(this, [{ id: held.pendingInputId, text: options.newText }]);
    const event = createSessionEvent(
      SessionEventType.TurnSteerQueued,
      this.sessionId,
      {
        pendingInputId: held.pendingInputId,
        input: options.newText,
        inputPreview: previewInput(options.newText),
        inputSize: measureUtf8Bytes(options.newText),
        ...(held.commandKind ? { commandKind: held.commandKind } : {}),
        ...(held.intent ? { intent: { ...held.intent, text: options.newText } } : {}),
        ...(held.toolDisallowlist ? { toolDisallowlist: held.toolDisallowlist } : {}),
        queueLength: projection.pendingSteerInputs.length,
        targetTurnId: held.targetTurnId,
      },
      {
        traceId: options.traceContext.traceId,
        turnId: held.targetTurnId,
      },
    );
    await this.appendEvent(event, options.traceContext);
    return true;
  }
  await persistSessionInputUpdates(this, [{ id: pendingInput.id, text: options.newText }]);
  pendingInput.input = options.newText;
  // After a body edit the canonical text must update too, or structured-quote restore shows the old body.
  if (pendingInput.intent) pendingInput.intent = { ...pendingInput.intent, text: options.newText };
  const event = createSessionEvent(
    SessionEventType.TurnSteerQueued,
    this.sessionId,
    {
      pendingInputId: pendingInput.id,
      queryId: pendingInput.queryId,
      input: options.newText,
      inputPreview: previewInput(options.newText),
      inputSize: measureUtf8Bytes(options.newText),
      ...(pendingInput.commandKind ? { commandKind: pendingInput.commandKind } : {}),
      ...(pendingInput.delivery ? { delivery: pendingInput.delivery } : {}),
      ...(pendingInput.inputPresentation
        ? { inputPresentation: pendingInput.inputPresentation }
        : {}),
      ...(pendingInput.intent ? { intent: pendingInput.intent } : {}),
      ...(pendingInput.toolDisallowlist ? { toolDisallowlist: pendingInput.toolDisallowlist } : {}),
      queueLength: activeTurn.pendingInputs.length,
      targetTurnId: activeTurn.turnId,
    },
    {
      traceId: activeTurn.traceContext.traceId,
      turnId: activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  return true;
}

/**
 // * (v4 reorder): move pendingInputId before beforePendingInputId (null = to the tail),
 // * emitting TurnSteerReordered(new order). The v4 reducer reorders queue rows. Miss -> false.
 */
export async function reorderPendingInput(
  this: AgentRuntimeInternal,
  options: {
    pendingInputId: string;
    beforePendingInputId: string | null;
    traceContext: TraceContext;
  },
): Promise<boolean> {
  const activeTurn = this.activeTurn;
  const fromIndexActive =
    activeTurn?.pendingInputs.findIndex((item) => item.id === options.pendingInputId) ?? -1;
  if (!activeTurn || fromIndexActive < 0) {
    // held fallback: reorder on the projection then emit TurnSteerReordered (the v4 reducer reorders).
    const projection = await this.rebuildProjection();
    const heldIds = projection.pendingSteerInputs.map((item) => item.pendingInputId);
    const fromIndex = heldIds.indexOf(options.pendingInputId);
    if (fromIndex < 0) return false;
    heldIds.splice(fromIndex, 1);
    if (options.beforePendingInputId === null) {
      heldIds.push(options.pendingInputId);
    } else {
      const beforeIndex = heldIds.indexOf(options.beforePendingInputId);
      if (beforeIndex < 0) {
        heldIds.push(options.pendingInputId);
      } else {
        heldIds.splice(beforeIndex, 0, options.pendingInputId);
      }
    }
    await persistSessionInputUpdates(
      this,
      heldIds.map((id, queuePosition) => ({ id, queuePosition })),
    );
    const targetTurnId =
      projection.pendingSteerInputs.find((item) => item.pendingInputId === options.pendingInputId)
        ?.targetTurnId ?? projection.pendingSteerInputs[0]!.targetTurnId;
    const event = createSessionEvent(
      SessionEventType.TurnSteerReordered,
      this.sessionId,
      {
        orderedPendingInputIds: heldIds,
        targetTurnId,
      },
      {
        traceId: options.traceContext.traceId,
        turnId: targetTurnId,
      },
    );
    await this.appendEvent(event, options.traceContext);
    return true;
  }
  const items = [...activeTurn.pendingInputs];
  const fromIndex = items.findIndex((item) => item.id === options.pendingInputId);
  if (fromIndex < 0) return false;
  const [moved] = items.splice(fromIndex, 1);
  if (!moved) return false;
  if (options.beforePendingInputId === null) {
    items.push(moved);
  } else {
    const beforeIndex = items.findIndex((item) => item.id === options.beforePendingInputId);
    if (beforeIndex < 0) {
      // Target anchor gone -> fall back to the tail; never drop the item.
      items.push(moved);
    } else {
      items.splice(beforeIndex, 0, moved);
    }
  }
  // Reordering the array without intent.queuePosition keeps the live queue right but
  // writes the admission-time position back post-drain, forking cold/hot projection facts.
  const reorderedItems = items.map((item, index) =>
    item.intent ? { ...item, intent: { ...item.intent, queuePosition: index } } : item,
  );
  await persistSessionInputUpdates(
    this,
    reorderedItems.map((item, queuePosition) => ({ id: item.id, queuePosition })),
  );
  activeTurn.pendingInputs.splice(0, activeTurn.pendingInputs.length, ...reorderedItems);
  const event = createSessionEvent(
    SessionEventType.TurnSteerReordered,
    this.sessionId,
    {
      orderedPendingInputIds: reorderedItems.map((item) => item.id),
      targetTurnId: activeTurn.turnId,
    },
    {
      traceId: activeTurn.traceContext.traceId,
      turnId: activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  return true;
}

/**
 // * (v4 setAutoDrain): flip the queue autoDrain grant bit (session-level, independent of the active turn).
 // * Appends QueueAutoDrainChanged for the v4 projection; the held derivation (completed+queue>0+autoDrain=false
 // * -> choice routing) and later heldQueueDisposition commands close the send semantics.
 */
export async function setQueueAutoDrain(
  this: AgentRuntimeInternal,
  options: {
    autoDrain: boolean;
    traceContext: TraceContext;
  },
): Promise<void> {
  // false->true means the user resumes a paused queue. Legacy paused items exist only in the event projection, not in the new
  // activeTurn.pendingInputs; during resume the CLI outer layer promotes item by item under full-projection FIFO.
  if (options.autoDrain && !this.queueAutoDrain) {
    this.queueExternalDrainActive = true;
  } else if (!options.autoDrain) {
    this.queueExternalDrainActive = false;
  }
  // The grant bit enters both the runtime (drain gate) and the event log (the projection's paused-queue derivation).
  this.queueAutoDrain = options.autoDrain;
  const event = createSessionEvent(
    SessionEventType.QueueAutoDrainChanged,
    this.sessionId,
    { autoDrain: options.autoDrain },
    { traceId: options.traceContext.traceId },
  );
  await this.appendEvent(event, options.traceContext);
}

/** Once the CLI projection confirms the queue is empty, allow core to consume guides at later tool-batch boundaries again. */
export function completeExternalQueueDrain(this: AgentRuntimeInternal): void {
  this.queueExternalDrainActive = false;
}

/**
 // * (v4 setFollowupMode): flip the followup routing mode (session-level).
 // * Appends FollowupModeChanged for the v4 projection; while running, computeInputRouting chooses between
 // * enqueue (queue) and guide by it.
 */
export async function setFollowupMode(
  this: AgentRuntimeInternal,
  options: {
    mode: "queue" | "guide";
    traceContext: TraceContext;
  },
): Promise<void> {
  const event = createSessionEvent(
    SessionEventType.FollowupModeChanged,
    this.sessionId,
    { mode: options.mode },
    { traceId: options.traceContext.traceId },
  );
  await this.appendEvent(event, options.traceContext);
}

/**
 // * (v4 switchModelConfig): append a ModelSelected event for the projection after a selection change.
 // * The v4 reducer's onModelSelected updates config provider/model/thought and the effective context window,
 // * and (mid-run) emits the modelChange marker. The actual provider-client switch is app.setModel's job;
 // * this writes the post-switch full model-capability tuple into the same event.
 */
export async function emitModelSelected(
  this: AgentRuntimeInternal,
  options: {
    modelSelection: ModelSelection;
    model?: import("../deps.js").Model;
    effectiveReasoningLevel?: string;
    previousModelSelection?: ModelSelection | null;
    origin?: ModelSelectionOrigin;
    supportedThoughtLevels?: readonly string[];
    traceContext: TraceContext;
  },
): Promise<void> {
  const model = options.model ?? createRuntimeModel(this, { selection: options.modelSelection });
  const event = createSessionEvent(
    SessionEventType.ModelSelected,
    this.sessionId,
    {
      // A model-switch event must read the window from the Active Model created here, never copy the Runtime Config.
      contextWindow: model.properties.contextWindow,
      modelSelection: cloneModelSelection(options.modelSelection),
      ...(options.effectiveReasoningLevel
        ? { effectiveReasoningLevel: options.effectiveReasoningLevel }
        : {}),
      // previousModelSelection=null is the explicit empty-to-X model boundary; truthiness checks would lose it.
      ...(options.previousModelSelection !== undefined
        ? {
            previousModelSelection: options.previousModelSelection
              ? cloneModelSelection(options.previousModelSelection)
              : null,
          }
        : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.supportedThoughtLevels
        ? { supportedThoughtLevels: [...options.supportedThoughtLevels] }
        : {}),
    },
    { traceId: options.traceContext.traceId },
  );
  await this.appendEvent(event, options.traceContext);
}

/**
 // * (v4 switchCollaborationMode): append SessionModeChanged after a command-surface mode switch.
 // * app.setMode only updates runtime config + persisted preference, no event (session-mode-port's
 // * enterPlanMode/exitPlanMode cover the plan tool path only); the v4 projection's config.mode update relies on this backfill.
 */
export async function emitModeChanged(
  this: AgentRuntimeInternal,
  options: {
    mode: CollaborationMode;
    previousMode: CollaborationMode;
    traceContext: TraceContext;
  },
): Promise<void> {
  const event = createSessionEvent(
    SessionEventType.SessionModeChanged,
    this.sessionId,
    {
      mode: this.getMode(),
      planEnabled: this.getPlanEnabled(),
      previousMode: options.previousMode,
      source: "command",
    },
    { traceId: options.traceContext.traceId },
  );
  await this.appendEvent(event, options.traceContext);
}

export async function drainPendingInput(
  this: AgentRuntimeInternal,
  options: {
    activeTurn: ActiveTurnSteeringState;
    events: SessionEvent[];
    traceContext: TraceContext;
  },
): Promise<DrainedPendingInputDiagnostics | undefined> {
  if (this.permissionFullAccessPending || this.activeTurn !== options.activeTurn) return undefined;
  if (unpublishedPermissionGrants.has(this)) await recoverPendingPermissionGrant(this);
  if (this.permissionFullAccessPending || this.activeTurn !== options.activeTurn) return undefined;
  // Guide dequeue removes in-memory first, event second; during full consumption never capture the authorized target from a stale projection.
  this.pendingInputDrains = (this.pendingInputDrains ?? 0) + 1;
  try {
    return await drainPendingInputUnlocked.call(this, options);
  } finally {
    this.pendingInputDrains -= 1;
  }
}

async function drainPendingInputUnlocked(
  this: AgentRuntimeInternal,
  options: Parameters<typeof drainPendingInput>[0],
): Promise<DrainedPendingInputDiagnostics | undefined> {
  const guideIndex = firstInlineGuideIndex(options.activeTurn);
  const pendingInput = guideIndex >= 0 ? options.activeTurn.pendingInputs[guideIndex] : undefined;
  if (!pendingInput) return undefined;
  // A queue head already reserved by sendQueuedNow only its reservation owner may promote; plain roundtrip drain
  // must pause, or during a stop barrier the same input gets consumed by the current turn twice.
  if (this.pendingInputReservations.has(pendingInput.id)) return undefined;
  // Plain queue promotion belongs to bootstrap after session-ready + goal gate; the runtime's inline drain
  // takes the earliest guide-subsequence item -- the future queue must neither jump it nor block the current turn's guide.
  options.activeTurn.pendingInputs.splice(guideIndex, 1);
  const pendingInputs = [pendingInput];
  const queryIds = pendingInput.queryId ? [pendingInput.queryId] : undefined;
  // A steer is the new real user query. The post-drain model request must switch to that queryId;
  // keeping the original turn query would attribute later tool requests to the previous user message.
  const drainTraceContext = pendingInput.queryId
    ? { ...options.traceContext, queryId: pendingInput.queryId }
    : options.traceContext;

  const drainedAt = Date.now();
  const inputPreviews = pendingInputs.map((pendingInput) => previewInput(pendingInput.input));
  const inputSizes = pendingInputs.map((pendingInput) => measureUtf8Bytes(pendingInput.input));
  const queuedDurationsMs = pendingInputs.map(
    (pendingInput) => drainedAt - pendingInput.queuedAt.getTime(),
  );
  const messageIds: MessageId[] = [];
  const runtimeEntries: RuntimeMessageEntry[] = [];
  const drainedInputs: Array<{
    pendingInputId: string;
    messageId: MessageId;
    text: string;
    delivery?: "guide" | "queue";
    intent?: NonNullable<PendingTurnInput["intent"]>;
    toolDisallowlist?: readonly string[];
  }> = [];
  for (const pendingInput of pendingInputs) {
    const messageId = createMessageId();
    // Delivery semantics default to queue (queued consumption = own turn); guide is explicitly tagged by the v4 command surface
    // via inputRouting. Persist to metadata so cold recovery restores the same split.
    const delivery = pendingInput.delivery ?? "queue";
    const resolvedAttachments = await resolveTurnAttachments(pendingInput.attachments, {
      artifactStore: this.artifactStore,
      fileSystemPort: this.fileSystemPort,
      imageProcessorPort: this.imageProcessorPort,
      sessionId: this.sessionId,
      traceContext: drainTraceContext,
      turnId: options.activeTurn.turnId,
      workingDirectory: this.workingDirectory,
    });
    // Pin the new marker only on real guide consumption without attachments; approval feedback keeps the legacy contract.
    const inputPresentation =
      delivery === "guide" && !pendingInput.source && !pendingInput.attachments?.length
        ? parseRuntimeInputPresentation(pendingInput.inputPresentation)
        : undefined;
    const runtimeEntry = createRuntimeUserEntry(
      buildUserContentFromTurn(
        withConversationQuotes(
          pendingInput.input,
          pendingInput.intent?.conversationQuotes,
          pendingInput.intent?.botGroupSource,
        ),
        resolvedAttachments,
      ),
      runtimeInputMetadata(inputPresentation) ?? realUserRuntimeMetadata(),
    );
    this.messageHistory.addEntries([runtimeEntry]);
    runtimeEntries.push(runtimeEntry);
    await this.persistUserPrompt(
      messageId,
      pendingInput.input,
      resolvedAttachments,
      drainTraceContext,
      {
        steerDelivery: delivery,
        inputPresentation,
        sessionInputId: pendingInput.id,
        sourceCommandId:
          pendingInput.intent?.sourceCommandId ?? String(pendingInput.queryId ?? pendingInput.id),
        clientId: pendingInput.intent?.clientId,
        intent: pendingInput.intent,
      },
    );
    messageIds.push(messageId);
    drainedInputs.push({
      pendingInputId: pendingInput.id,
      messageId,
      text: pendingInput.input,
      delivery,
      ...(pendingInput.intent ? { intent: pendingInput.intent } : {}),
      ...(pendingInput.toolDisallowlist ? { toolDisallowlist: pendingInput.toolDisallowlist } : {}),
    });
  }

  const pendingInputIds = pendingInputs.map((pendingInput) => pendingInput.id);
  const toolDisallowlist = [
    ...new Set(pendingInputs.flatMap((pendingInput) => pendingInput.toolDisallowlist ?? [])),
  ];
  const event = this.createEvent(
    SessionEventType.TurnSteerDrained,
    {
      injectedMessageIds: messageIds,
      pendingInputIds,
      drainedInputs,
      ...(queryIds ? { queryIds } : {}),
      targetTurnId: options.activeTurn.turnId,
    },
    drainTraceContext,
  );
  await this.appendEvent(event, drainTraceContext);
  options.events.push(event);
  this.logger?.debug("Turn steer drained", {
    ...traceContextToLogContext(drainTraceContext),
    drainedCount: pendingInputs.length,
    event: "turn.steer.drained",
    injectedMessageIds: messageIds,
    inputPreviews,
    inputSizes,
    module: "core.runtime",
    pendingInputIds,
    queryIds,
    queuedDurationsMs,
    status: "completed",
    targetTurnId: options.activeTurn.turnId,
  });
  return {
    injectedMessageIds: messageIds,
    ...(pendingInput.intent ? { intent: pendingInput.intent } : {}),
    latestMessageId: messageIds.at(-1),
    pendingInputIds,
    queryIds,
    runtimeEntries,
    ...(toolDisallowlist.length > 0 ? { toolDisallowlist } : {}),
  };
}

export async function discardPendingInput(
  this: AgentRuntimeInternal,
  options: {
    activeTurn: ActiveTurnSteeringState;
    events?: SessionEvent[];
    reason: "turn_cancelled" | "turn_failed" | "session_resumed";
    traceContext: TraceContext;
  },
): Promise<void> {
  if (this.activeTurn !== options.activeTurn) return;
  const pendingInputs = options.activeTurn.pendingInputs.splice(0);
  if (pendingInputs.length === 0) return;
  const pendingInputIds = pendingInputs.map((pendingInput) => pendingInput.id);

  const event = createSessionEvent(
    SessionEventType.TurnSteerDiscarded,
    this.sessionId,
    {
      pendingInputIds,
      reason: options.reason,
      targetTurnId: options.activeTurn.turnId,
    },
    {
      traceId: options.activeTurn.traceContext.traceId,
      turnId: options.activeTurn.turnId,
    },
  );
  await this.appendEvent(event, options.traceContext);
  options.events?.push(event);
  this.logger?.debug("Turn steer discarded", {
    ...traceContextToLogContext(options.traceContext),
    discardedCount: pendingInputs.length,
    event: "turn.steer.discarded",
    module: "core.runtime",
    pendingInputIds,
    reason: options.reason,
    status: "completed",
    targetTurnId: options.activeTurn.turnId,
  });
}

export async function discardPersistedPendingSteerInputs(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<number> {
  // (queues do not survive restart): first sweep the ledger's leftover admitted -- the event log is
  // in-memory; after a crash the projection has nothing and the ledger is the only trace (background wake included: background
  // children die with the CLI restart, their unconsumed notices unrecoverable). Keep the trace (discarded/session_resumed)
  // non-silent, so user/diagnostics can ask where this input went.
  try {
    const admitted =
      (await this.sessionStore?.listSessionInputs?.({
        sessionID: this.sessionId,
        status: "admitted",
      })) ?? [];
    for (const record of admitted) {
      await this.sessionStore?.settleSessionInput?.({
        id: record.id,
        sessionID: this.sessionId,
        status: "discarded",
        reason: "session_resumed",
      });
    }
  } catch (error) {
    this.logger?.warn("Failed to sweep admitted session inputs on resume", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session_input.resume_sweep_failed",
      module: "core.runtime",
      status: "failed",
    });
  }

  const projection = await this.rebuildProjection();
  const pendingInputs = projection.pendingSteerInputs;
  if (pendingInputs.length === 0) return 0;

  const pendingByTurn = new Map<TurnId, PendingSteerInputInfo[]>();
  for (const pendingInput of pendingInputs) {
    const group = pendingByTurn.get(pendingInput.targetTurnId) ?? [];
    group.push(pendingInput);
    pendingByTurn.set(pendingInput.targetTurnId, group);
  }

  for (const [targetTurnId, group] of pendingByTurn) {
    const pendingInputIds = group.map((item) => item.pendingInputId);
    const event = createSessionEvent(
      SessionEventType.TurnSteerDiscarded,
      this.sessionId,
      {
        pendingInputIds,
        reason: "session_resumed",
        targetTurnId,
      },
      {
        traceId: traceContext.traceId,
        turnId: targetTurnId,
      },
    );
    await this.appendEvent(event, traceContext);
    this.logger?.debug("Turn steer discarded", {
      ...traceContextToLogContext(traceContext),
      discardedCount: group.length,
      event: "turn.steer.discarded",
      module: "core.runtime",
      pendingInputIds,
      reason: "session_resumed",
      status: "completed",
      targetTurnId,
    });
  }

  return pendingInputs.length;
}
