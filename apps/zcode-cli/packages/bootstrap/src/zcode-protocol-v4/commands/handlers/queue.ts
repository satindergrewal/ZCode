// queue command group: deleteQueueItem / editQueueItem / reorderQueueItem / setAutoDrain /
// setFollowupMode / sendQueuedNow (native rework; group-file boilerplate: see session-flow.ts).
// Decision logic drives core directly (the app-level queue API, batch 1); queueItemId = core's
// pendingInputId (one id space, no translation). Queue-change events are emitted by the core runtime
// and reach the v4 projection via gateway ingest -- this group needs no legacy broadcast hooks.
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { isHighspeedProviderId } from "@zcode/shared";
import { createModelExecutionContext } from "../../../zcode-protocol/model-execution.js";
import { mapAttachmentRefsToTurnAttachments } from "../attachment-refs.js";
import { inputIntentMetadataFromQueueItem } from "../input-intent.js";
import { startPromptTurn } from "../prompt-turn.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";
import {
  applyGoalCommand,
  parseGoalObjectiveFromCommandText,
  startManualCompact,
  V4GoalCompactRejectedError,
} from "./goal-compact.js";
import { resolveSessionFallbackModelSelection } from "../input-admission.js";
import { preemptActiveTurnAndWait } from "./session-flow.js";
import { V4CommandNoopError } from "../../v4-gateway.js";
import { commandExecutionContextOf } from "../executor.js";
export { V4SessionIdleTimeoutError } from "./session-flow.js";

/** sendQueuedNow cannot find the item's original text in the projection (already drained/deleted, or bad id) -> reject. */
export class V4QueueItemTextUnavailableError extends Error {
  constructor(queueItemId: string) {
    super(`v4 sendQueuedNow queue item text unavailable: ${queueItemId}`);
    this.name = "V4QueueItemTextUnavailableError";
  }
}

export class V4QueueItemReservedError extends Error {
  readonly reasonCode = "guard.queueItemReserved";
  constructor(queueItemId: string) {
    super(`v4 sendQueuedNow queue item already reserved: ${queueItemId}`);
    this.name = "V4QueueItemReservedError";
  }
}

export class V4QueuePromotionCommitError extends Error {
  readonly reasonCode = "fault.command.queuePromotionCommitFailed";
  constructor(queueItemId: string) {
    super(`v4 sendQueuedNow started but failed to remove queue item: ${queueItemId}`);
    this.name = "V4QueuePromotionCommitError";
  }
}

export class V4QueueItemNotEditableError extends Error {
  readonly reasonCode = "guard.queueItemNotEditable";
  constructor(queueItemId: string) {
    super(`v4 queue item is not editable: ${queueItemId}`);
    this.name = "V4QueueItemNotEditableError";
  }
}

export class V4QueuePromotionLeaseUnavailableError extends Error {
  readonly reasonCode = "guard.queuePromotionBusy";
  constructor(activeLeaseId?: string) {
    super(
      activeLeaseId
        ? `v4 queue promotion is owned by another lease: ${activeLeaseId}`
        : "v4 queue promotion requires an idle Core runtime",
    );
    this.name = "V4QueuePromotionLeaseUnavailableError";
  }
}

async function deleteQueueItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["deleteQueueItem"];
  const record = requireRecord(host, envelope.sessionId);
  const queueItem = host.getQueueItem?.(record.app.sessionId, payload.queueItemId) ?? null;
  // A miss (concurrent drain/duplicate-delete race) = noop, not a failure; keep the warn for observability.
  const removed = await record.app.removeQueueItem(payload.queueItemId);
  if (!removed) {
    host.logger?.warn?.("v4 deleteQueueItem missed", {
      queueItemId: payload.queueItemId,
      sessionId: record.app.sessionId,
    });
    // A miss used to return undefined, making the gateway report concurrent drains/duplicate deletes as accepted;
    // a queue recall-edit could then restore an already-consumed old projection into the composer.
    throw new V4CommandNoopError("queue.itemMissing");
  }
  if (queueItem) {
    host.deleteQueuedTurnExecution?.(record.app.sessionId, queueItem.sourceCommandId);
  }
  return undefined;
}

async function editQueueItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["editQueueItem"];
  const record = requireRecord(host, envelope.sessionId);
  const queueItem = host.getQueueItem?.(record.app.sessionId, payload.queueItemId) ?? null;
  if (queueItem?.kind === "compact") {
    // compact is a typed maintenance intent; letting its text change would disguise it as plain input
    // while commandKind stays compact, producing compression side effects inconsistent with the UI copy at consume time.
    throw new V4QueueItemNotEditableError(payload.queueItemId);
  }
  // The core reducer updates in place by id (position kept); a miss = noop + warn (same race semantics as delete).
  const edited = await record.app.editQueueItem(payload.queueItemId, payload.newText);
  if (!edited) {
    host.logger?.warn?.("v4 editQueueItem missed", {
      queueItemId: payload.queueItemId,
      sessionId: record.app.sessionId,
    });
  }
  return undefined;
}

async function reorderQueueItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["reorderQueueItem"];
  const record = requireRecord(host, envelope.sessionId);
  // beforeQueueItemId = null -> move to the end (protocol and app API share the shape; pass through).
  const moved = await record.app.reorderQueueItem(payload.queueItemId, payload.beforeQueueItemId);
  if (!moved) {
    host.logger?.warn?.("v4 reorderQueueItem missed", {
      queueItemId: payload.queueItemId,
      sessionId: record.app.sessionId,
    });
  }
  return undefined;
}

async function setAutoDrain(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setAutoDrain"];
  const record = requireRecord(host, envelope.sessionId);
  await record.app.setQueueAutoDrain(payload.autoDrain);
  if (payload.autoDrain) {
    // Flipping the authorization bit is not enough: an idle-paused queue has no active turn to start its head. Reuse the CLI
    // authoritative ready hook: arm when busy; when idle, promote at once via the sendQueuedNow atomic path.
    await host.afterLegacyStateMutation?.(record, "queue_auto_drain_resumed");
  }
  return undefined;
}

async function setFollowupMode(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setFollowupMode"];
  const record = requireRecord(host, envelope.sessionId);
  await record.app.setFollowupMode(payload.mode);
  return undefined;
}

/**
 * sendQueuedNow：reserve → Core promotion lease → stop barrier → start/promote → remove。
 * - The full QueueItem must be read; a text-only fallback drops sourceCommandId/attachments/client/order -- forbidden.
 * - stop reuses session-flow semantics: goal-pause barrier (else the queue cannot drain before the verifier acks the abort)
 *   -> abort; abort without await.
 * - wait-for-idle semantics: the lock releases in the background turn's finally (prompt-turn header, note 3);
 *   resending right after abort hits "A prompt is already running" -- poll until the lock releases.
 * - Any failure before start releases the reservation and keeps the original item in place; remove only after start succeeds.
 */
async function sendQueuedNow(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["sendQueuedNow"];
  const record = requireRecord(host, envelope.sessionId);
  const reservationId = envelope.commandId;
  const autoDrainPromotion = commandExecutionContextOf(envelope)?.autoDrainPromotion === true;
  const foregroundPromotionLeaseId = `queue-promotion:${reservationId}`;
  const traceOptions = { traceContext: record.traceContext };
  let queueItemReserved = false;
  let startAdmitted = false;
  let leaseReleaseOwnedByBackground = false;
  let foregroundPromotionLeaseAcquired = false;
  try {
    const queueItem = host.getQueueItem?.(record.app.sessionId, payload.queueItemId) ?? null;
    if (queueItem === null) {
      throw new V4QueueItemTextUnavailableError(payload.queueItemId);
    }
    const acquirePromotionLease = (mode: "after-current" | "idle-only"): void => {
      const leaseResult = record.app.runtime.acquireForegroundPromotionLease({
        leaseId: foregroundPromotionLeaseId,
        mode,
        promotedInputId: queueItem.sourceCommandId,
      });
      if (leaseResult.kind !== "acquired") {
        throw new V4QueuePromotionLeaseUnavailableError(
          leaseResult.kind === "conflict" ? leaseResult.leaseId : undefined,
        );
      }
      foregroundPromotionLeaseAcquired = true;
    };
    if (autoDrainPromotion) acquirePromotionLease("idle-only");
    if (!(await record.app.reserveQueueItem(payload.queueItemId, reservationId, traceOptions))) {
      throw new V4QueueItemReservedError(payload.queueItemId);
    }
    queueItemReserved = true;
    const objective =
      queueItem.kind === "sendGoalCommand"
        ? parseGoalObjectiveFromCommandText(queueItem.text)
        : undefined;
    if (queueItem.kind === "sendGoalCommand" && !objective) {
      throw new V4GoalCompactRejectedError("emptyObjective", "Usage: /goal <objective>");
    }
    const attachments =
      queueItem.kind === "compact"
        ? undefined
        : await mapAttachmentRefsToTurnAttachments(record.app, queueItem.attachments);
    if (!autoDrainPromotion) acquirePromotionLease("after-current");
    let preempted = false;
    if (!autoDrainPromotion) {
      preempted = await preemptActiveTurnAndWait(host, record, {
        abortMessage: "v4 sendQueuedNow preempts active turn",
        goalPausedMutationReason: "send_queued_now_goal_paused",
        preserveQueueAutoDrainOnCancel: true,
        // Send-queued-now inserts new input rather than halting the mission: the goal stays
        // active and the post-turn goal loop resumes after the promoted prompt completes.
        suppressGoalPauseOnCancel: true,
      });
    }
    if (
      !(await record.app.markQueueItemPromoting(payload.queueItemId, reservationId, traceOptions))
    ) {
      throw new V4QueueItemReservedError(payload.queueItemId);
    }
    if (queueItem.kind === "compact") {
      await startManualCompact(host, record, queueItem.sourceCommandId, foregroundPromotionLeaseId);
      leaseReleaseOwnedByBackground = true;
    } else if (queueItem.kind === "sendGoalCommand") {
      const intent = inputIntentMetadataFromQueueItem(queueItem, objective ?? queueItem.text);
      const goalContinuationWillStart = !(
        intent.planEnabled ??
        record.app.runtime?.getPlanEnabled?.() ??
        record.app.getMode?.() === "plan"
      );
      await applyGoalCommand(host, record, {
        displayText: queueItem.text,
        foregroundPromotionLeaseId,
        inputId: queueItem.sourceCommandId,
        intent,
        objective: objective!,
      });
      leaseReleaseOwnedByBackground = goalContinuationWillStart;
    } else {
      const intent = inputIntentMetadataFromQueueItem(queueItem, queueItem.text);
      // Manual promotion may add fresh execution material for the same card; different cards are ignored, avoiding cross-card credential swaps.
      const refreshedHighspeedMatchesQueue =
        payload.highspeedMeta !== undefined &&
        queueItem.highspeed !== undefined &&
        payload.highspeedMeta.cardId === queueItem.highspeed.cardId &&
        payload.highspeedMeta.taskId === queueItem.highspeed.taskId;
      if (refreshedHighspeedMatchesQueue && payload.highspeedMeta) {
        intent.highspeed = payload.highspeedMeta;
        // Selection and execution material must swap as one batch (the protocol's superRefine guarantees pair arrival).
        if (payload.modelSelection) intent.modelSelection = payload.modelSelection;
      }
      // Credentials never enter the queue's persisted face: prefer this submission's material, else the CLI's in-memory stash by sourceCommandId.
      const stagedExecution =
        (refreshedHighspeedMatchesQueue ? payload.modelExecution : undefined) ??
        host.readQueuedTurnExecution?.(record.app.sessionId, queueItem.sourceCommandId);
      const highspeedSelected = isHighspeedProviderId(intent.modelSelection?.providerId);
      // Rule 9: cards may expire while queued. Re-validate before promotion; expired or credential-less falls back to the session model.
      const highspeedStillValid =
        highspeedSelected &&
        intent.highspeed !== undefined &&
        intent.highspeed.expiresAt > Date.now() &&
        stagedExecution !== undefined;
      if (highspeedSelected && !highspeedStillValid) {
        if (intent.highspeed && intent.highspeed.expiresAt > Date.now()) {
          // Root cause: a queue item with a valid card silently fell back to the plain model on manual promotion; old logs covered
          // only provider-install failures, unable to tell "missing credential stash" from "expired card".
          host.logger?.warn?.("v4 queued Highspeed execution unavailable; using session model", {
            cardId: intent.highspeed.cardId,
            queueItemId: queueItem.queueItemId,
            reason: "execution_missing",
            sessionId: record.app.sessionId,
          });
        }
        // The fallback must rewrite the Selection too: dropping only the card flag leaves the turn on the speed-up provider with no credentials.
        // Shares the retry/edit fallback resolver (spec 3, rule 13).
        delete intent.highspeed;
        intent.modelSelection = resolveSessionFallbackModelSelection(record);
        host.deleteQueuedTurnExecution?.(record.app.sessionId, queueItem.sourceCommandId);
      }
      const started = await startPromptTurn(host, record, {
        content: queueItem.text,
        inputId: queueItem.sourceCommandId,
        // A manual promotion that actually preempts the old execution is a human steer too; automatic drain never sets this mark.
        ...(preempted && !attachments?.length ? { inputPresentation: "user_steer" as const } : {}),
        intent,
        requireIdle: true,
        toolDisallowlist: queueItem.toolDisallowlist,
        ...(highspeedStillValid && stagedExecution
          ? { modelExecution: createModelExecutionContext(stagedExecution) }
          : {}),
        ...(attachments ? { attachments } : {}),
      });
      // Legacy fake apps/compat commands may not return an admission receipt; real apps validate started
      // at Core admission. Only an explicit queued/rejected proves the promotion did not start.
      if (started.admission.kind === "queued" || started.admission.kind === "rejected") {
        throw new V4QueuePromotionLeaseUnavailableError();
      }
      // Credentials froze into Core with this turn; destroy the stash on success, keep it on failure so a retry can still speed up.
      host.deleteQueuedTurnExecution?.(record.app.sessionId, queueItem.sourceCommandId);
    }
    startAdmitted = true;
    const removed = await record.app.removeQueueItem(payload.queueItemId, {
      reason: "promoted",
      reservationId,
      ...traceOptions,
    });
    if (!removed) throw new V4QueuePromotionCommitError(payload.queueItemId);
    if (queueItem.kind === "compact") {
      // A no-op compact can finish before the promoting item is deleted; its ready hook still sees
      // dispatch=promoting and cannot consume the next typed intent. Passing the mutation
      // boundary once more after the delete closes the race; normal slow compacts have a live controller and never double-drain.
      await host.afterLegacyStateMutation?.(record, "queue_compact_promoted");
    }
    return undefined;
  } finally {
    if (foregroundPromotionLeaseAcquired && !leaseReleaseOwnedByBackground) {
      record.app.runtime.releaseForegroundPromotionLease(foregroundPromotionLeaseId);
    }
    // Once start is admitted, never release: on a remove error the other side would re-execute; keep
    // promoting for explicit resync/failure handling. A failure before start rolls back to queued safely.
    if (queueItemReserved && !startAdmitted) {
      await record.app.releaseQueueItemReservation(
        payload.queueItemId,
        reservationId,
        traceOptions,
      );
    }
  }
}

export const queueHandlers = {
  deleteQueueItem,
  editQueueItem,
  reorderQueueItem,
  setAutoDrain,
  setFollowupMode,
  sendQueuedNow,
};
