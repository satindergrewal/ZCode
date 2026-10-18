// Session-flow commands: sendText / stop (the pattern template).
// One file per command group: handlers are pure (host, envelope) -> CommandResult|undefined,
// decision logic drives core directly, environment capabilities via host hooks (transition notes in ../types.ts).
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { isHighspeedProviderId } from "@zcode/shared";
import { createModelExecutionContext } from "../../../zcode-protocol/model-execution.js";
import { mapAttachmentRefsToTurnAttachments } from "../attachment-refs.js";
import {
  applyHeldQueueDisposition,
  hasPromptInput,
  resolveSubmittedExecutionState,
  V4InputAdmissionRejectedError,
} from "../input-admission.js";
import { inputIntentMetadata } from "../input-intent.js";
import {
  resolveTurnAutomationId,
  startPromptTurn,
  turnBackgroundAttributionOf,
  V4PromptRejectedError,
} from "../prompt-turn.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost, V4QueuedTurnExecution, V4SessionRecordView } from "../types.js";
import { V4CommandNoopError } from "../../v4-gateway.js";

/** The wait-idle poll: a 25ms interval, 5s timeout. */
const IDLE_POLL_INTERVAL_MS = 25;
const IDLE_POLL_TIMEOUT_MS = 5_000;
const HIGHSPEED_QUEUE_FALLBACK_REASON = "highspeed.requiresQueue";

/** Wait-idle timeout (the active turn's finally did not release within 5s) -> give up the resend and error. */
export class V4SessionIdleTimeoutError extends Error {
  constructor(sessionId: string) {
    super(`v4 timed out waiting for session idle: ${sessionId}`);
    this.name = "V4SessionIdleTimeoutError";
  }
}

/**
 * sendText: protocol/held/model/attachment validation only; start/queue goes to the same session's Core admission.
 * Under held (choice) the heldQueueDisposition still decides.
 */
async function sendText(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const rawPayload = envelope.payload as CommandPayloadMap["sendText"];
  const record = requireRecord(host, envelope.sessionId);
  // Root cause: the old check saw body only; attachment-only queries already allowed by the UI were misjudged empty in the CLI.
  if (
    !hasPromptInput(rawPayload.text, rawPayload.attachments) &&
    !rawPayload.conversationQuotes?.length
  ) {
    throw new V4InputAdmissionRejectedError("proto.invalidPayload", "input must not be empty");
  }
  const activeAutomationId = resolveTurnAutomationId({
    automationId: rawPayload.automationId,
    inputId: envelope.commandId,
  });
  // Root cause: Highspeed admission and automation dispatch come from different upstreams; on contract drift one turn could receive
  // automationId, highspeedMeta, and speed-up execution material together. The scheduled execution identity wins:
  // never send with speed-up card credentials, never persist plain-model output as a Highspeed message.
  const dropsHighspeed =
    activeAutomationId !== undefined &&
    (rawPayload.highspeedMeta !== undefined ||
      isHighspeedProviderId(rawPayload.modelSelection?.providerId));
  const payload: CommandPayloadMap["sendText"] = dropsHighspeed
    ? {
        ...rawPayload,
        highspeedMeta: undefined,
        modelSelection: undefined,
        modelExecution: undefined,
      }
    : rawPayload;
  // The canonical intent and admission must see the same payload, or the transcript keeps a credential-less speed-up marker.
  const intentEnvelope = dropsHighspeed ? ({ ...envelope, payload } as CommandEnvelope) : envelope;
  const attachments = await mapAttachmentRefsToTurnAttachments(record.app, payload.attachments);
  const submittedExecutionState = resolveSubmittedExecutionState(record, payload);
  const submissionIntent = (options: Parameters<typeof inputIntentMetadata>[1]) =>
    inputIntentMetadata(intentEnvelope, { ...options, ...submittedExecutionState });
  const routingMode = host.getInputRoutingMode?.(envelope.sessionId ?? "") ?? null;
  const forceStartNow = payload.requestedDelivery === "startNow";
  // A speed-up turn = standard Selection pointing at the speed-up provider + one-shot execution material; detect via the Family
  // predicate, never a single provider-id constant, or a BigModel account's card silently drops as a plain turn.
  const highspeedExecution: V4QueuedTurnExecution | undefined = isHighspeedProviderId(
    payload.modelSelection?.providerId,
  )
    ? payload.modelExecution
    : undefined;
  const highspeedActiveTurn = highspeedExecution
    ? record.app.runtime?.getActiveTurnInfo?.()
    : undefined;
  const highspeedRequiresQueue =
    !forceStartNow &&
    highspeedExecution !== undefined &&
    (record.activeAbortController !== undefined ||
      highspeedActiveTurn !== undefined ||
      routingMode === "enqueue" ||
      routingMode === "guide");

  const queueHighspeedTurn = async (): Promise<CommandResult | undefined> => {
    if (!highspeedExecution) {
      throw new V4InputAdmissionRejectedError(
        "fault.command.inputRejected",
        "Highspeed queue requires turn execution material",
      );
    }
    // Speed-up credentials live in CLI memory only: fetched by (sessionId, sourceCommandId) at promotion, never into queue events.
    host.retainQueuedTurnExecution?.(record.app.sessionId, envelope.commandId, highspeedExecution);
    try {
      const requestedDelivery = routingMode === "guide" ? "guide" : "queue";
      // The speed-up turn's Selection must enter the canonical intent: promotion reads the model from the queue item, never the session.
      const intent = submissionIntent({
        text: payload.text,
        requestedDelivery,
        admittedDelivery: "queue",
        ...(routingMode === "guide" ? { fallbackReasonCode: HIGHSPEED_QUEUE_FALLBACK_REASON } : {}),
        attachmentRefs: payload.attachments,
      });
      const queued = await startPromptTurn(host, record, {
        content: payload.text,
        ...(payload.browserAmbientContext
          ? { browserAmbientContext: payload.browserAmbientContext }
          : {}),
        inputId: envelope.commandId,
        intent,
        requireQueue: true,
        ...(attachments ? { attachments } : {}),
        toolDisallowlist: payload.toolDisallowlist,
      });
      if (queued.admission.kind !== "queued") {
        throw new V4InputAdmissionRejectedError(
          "fault.command.inputRejected",
          "Highspeed input was not admitted to the queue",
        );
      }
      return {
        type: "inputAccepted",
        delivery: "queue",
        inputId: envelope.commandId,
      };
    } catch (error) {
      host.deleteQueuedTurnExecution?.(record.app.sessionId, envelope.commandId);
      throw error;
    }
  };

  if (highspeedRequiresQueue) {
    // Root cause: a transient Highspeed provider cannot guide into the current turn; Core's requireQueue
    // admits atomically, avoiding a plain-model start when the cross-layer busy snapshot goes stale during await.
    return await queueHighspeedTurn();
  }
  const foregroundPromotionLeaseId = forceStartNow ? `send-now:${envelope.commandId}` : undefined;
  let foregroundPromotionLeaseAcquired = false;
  let preempted = false;
  const releaseForegroundPromotionLease = () => {
    if (!foregroundPromotionLeaseAcquired || !foregroundPromotionLeaseId) return;
    record.app.runtime.releaseForegroundPromotionLease(foregroundPromotionLeaseId);
    foregroundPromotionLeaseAcquired = false;
  };
  if (forceStartNow) {
    // Root cause: Highspeed prepare makes "send now" more likely to hit Core busy admission; holding the
    // foreground lease and preempting the current turn is what keeps requestedDelivery=startNow from silently becoming queue.
    const leaseResult = record.app.runtime.acquireForegroundPromotionLease({
      leaseId: foregroundPromotionLeaseId!,
      mode: "after-current",
      promotedInputId: envelope.commandId,
    });
    if (leaseResult.kind !== "acquired") {
      throw new V4InputAdmissionRejectedError(
        "fault.command.inputRejected",
        "send now foreground promotion is busy",
      );
    }
    foregroundPromotionLeaseAcquired = true;
    try {
      // A single message's delivery only decides when new input is consumed; it never bypasses the queue's user ruling.
      await applyHeldQueueDisposition(
        host,
        record,
        payload.heldQueueDisposition,
        payload.expectedHeldQueueItemIds,
      );
      preempted = await preemptActiveTurnAndWait(host, record, {
        abortMessage: "v4 sendText startNow preempts active turn",
        goalPausedMutationReason: "send_now_goal_paused",
        preserveQueueAutoDrainOnCancel: true,
        // startNow inserts new input rather than halting the mission: the goal stays active
        // and the post-turn goal loop continues the work.
        suppressGoalPauseOnCancel: true,
      });
    } catch (error) {
      releaseForegroundPromotionLease();
      throw error;
    }
  }
  if (!forceStartNow) {
    await applyHeldQueueDisposition(
      host,
      record,
      payload.heldQueueDisposition,
      payload.expectedHeldQueueItemIds,
    );
  }
  let started;
  // Attachment command face: AttachmentRef -> TurnAttachment, mapped after the gate (active turn already excluded).
  try {
    const intent = submissionIntent({
      text: payload.text,
      inputOrigin: payload.inputOrigin,
      botGroupSource: payload.botGroupSource,
      conversationQuotes: payload.conversationQuotes,
      requestedDelivery:
        payload.requestedDelivery ??
        (routingMode === "guide" ? "guide" : routingMode === "enqueue" ? "queue" : "startNow"),
      ...(payload.requestedDelivery !== "guide" && routingMode === "guide" && attachments?.length
        ? { fallbackReasonCode: "guide.attachmentsUnsupported" }
        : {}),
      attachmentRefs: payload.attachments,
      sharedContextRefs: payload.context_refs,
      ...(payload.source ? { source: payload.source } : {}),
    });
    started = await startPromptTurn(host, record, {
      content: payload.text,
      ...(payload.browserAmbientContext
        ? { browserAmbientContext: payload.browserAmbientContext }
        : {}),
      inputId: envelope.commandId,
      // Immediate-send switched the runtime turn, so in-flight user input missed the human hint.
      // Mark plain text only on Core's actual preemption receipt; idle and attachment input keep the legacy path.
      ...(preempted && !attachments?.length ? { inputPresentation: "user_steer" as const } : {}),
      intent,
      ...(payload.context_refs ? { sharedContextRefs: payload.context_refs } : {}),
      ...turnBackgroundAttributionOf(payload),
      ...(payload.botDeliveryTarget ? { botDeliveryTarget: payload.botDeliveryTarget } : {}),
      toolDisallowlist: payload.toolDisallowlist,
      ...(payload.modelExecution
        ? { modelExecution: createModelExecutionContext(payload.modelExecution) }
        : {}),
      ...(attachments ? { attachments } : {}),
      // The promotion lease belongs to Core busy authority; without requireIdle,
      // the post-preemption startNow lands in the deferred queue, drained automatically only once the lease releases.
      ...(forceStartNow ? { requireIdle: true } : {}),
    });
  } catch (error) {
    if (
      highspeedExecution &&
      error instanceof V4PromptRejectedError &&
      error.reasonCode === "activePrompt"
    ) {
      // Root cause: between Bootstrap's idle-read and Core admission a reservation may appear.
      // Highspeed must neither downgrade-loss nor inject speed-up credentials into the current turn; Core force-enqueues.
      return await queueHighspeedTurn();
    }
    throw error;
  } finally {
    releaseForegroundPromotionLease();
  }
  if (started.admission.kind === "queued") {
    return {
      type: "inputAccepted",
      delivery: "queue",
      inputId: envelope.commandId,
    };
  }
  return {
    type: "inputAccepted",
    delivery: "startNow",
    inputId: envelope.commandId,
  };
}

/** stop: cancels exactly the runtime foreground execution visible in the projection and closes the active goal as paused. */
async function stop(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  const payload = envelope.payload as CommandPayloadMap["stop"];
  const runtimeStop = record.app.runtime?.stopActiveForegroundExecution?.({
    expectedForegroundExecutionId: payload.expectedForegroundExecutionId,
    reason: "v4 session stopped",
  });
  host.logger?.info?.("v4 stop foreground execution inspected", {
    activeForegroundExecutionId:
      runtimeStop?.kind === "mismatch"
        ? runtimeStop.activeForegroundExecutionId
        : runtimeStop?.kind === "stopped"
          ? runtimeStop.foregroundExecutionId
          : undefined,
    event: "v4.stop.foreground_execution_inspected",
    expectedForegroundExecutionId: payload.expectedForegroundExecutionId,
    module: "bootstrap.zcode_protocol_v4.commands",
    runtimeStopKind: runtimeStop?.kind ?? "unsupported",
    sessionId: record.app.sessionId,
  });
  if (
    payload.expectedForegroundExecutionId !== undefined &&
    (runtimeStop?.kind === "idle" || runtimeStop?.kind === "mismatch")
  ) {
    // Stop has an async window from renderer to host; if the verifier ended and the next round started,
    // aborting the outer controller kills an execution the user never saw. An execution-id mismatch can only noop.
    throw new V4CommandNoopError("guard.stopTargetChanged");
  }
  if (runtimeStop?.kind === "stopped") {
    // Interrupt the runtime-owned verifier/continuation first, then await the goal pause; else the verifier may
    // pass and hook the next continuation before the pause RPC completes.
    record.activeAbortController?.abort(new Error("v4 session stopped"));
    if ((host.getQueueLength?.(record.app.sessionId) ?? 0) > 0) {
      try {
        // The verifier is past the plain turn catch: do not rely on TurnComplete(cancelled)
        // to flip the runtime queue gate; write false explicitly so the future queue stays held.
        await record.app.setQueueAutoDrain(false);
      } catch (error) {
        host.logger?.warn?.("v4 stop failed to hold following queue", {
          error: error instanceof Error ? error.message : String(error),
          sessionId: record.app.sessionId,
        });
      }
    }
    const pausedGoal = await pauseActiveGoal(host, record);
    if (pausedGoal) {
      await host.afterLegacyStateMutation?.(record, "session_stop_goal_paused");
    }
    return undefined;
  }

  // compact and legacy clients carry no runtime foreground-execution token; the
  // bootstrap outer controller still provides their cancellation window.
  const hadActivePrompt = Boolean(record.activeAbortController);
  let pausedGoal = false;
  if (hadActivePrompt) {
    pausedGoal = await pauseActiveGoal(host, record);
  }
  record.activeAbortController?.abort(new Error("v4 session stopped"));
  if (pausedGoal) {
    await host.afterLegacyStateMutation?.(record, "session_stop_goal_paused");
  }
  return undefined;
}

/** The goal-pause barrier helper: shared by stop and sendQueuedNow (the preempting resend), never copied. */
export async function pauseActiveGoal(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
): Promise<boolean> {
  // Note: call via app (do not destructure; the implementation may rely on this binding).
  const target = await record.app.readTarget();
  if (!target || target.status !== "active") {
    return false;
  }
  try {
    const paused = await record.app.updateTargetStatus("paused");
    return Boolean(paused);
  } catch (error) {
    host.logger?.warn?.("v4 stop failed to pause active goal", {
      error: error instanceof Error ? error.message : String(error),
      sessionId: record.app.sessionId,
    });
    return false;
  }
}

/** Poll until both the Bootstrap turn's and Core turn's finally have released authority. */
export async function waitForSessionIdle(record: V4SessionRecordView): Promise<void> {
  const deadline = Date.now() + IDLE_POLL_TIMEOUT_MS;
  while (true) {
    // Root cause: Bootstrap's abort/foreground flags clear before Core's activeTurn cleanup; an edit in that
    // window re-admissions after rewind with turn_not_steerable. Core's activeTurn
    // is the authoritative close boundary for prompt admission; wait for it too.
    const coreTurnActive = record.app.runtime?.getActiveTurnInfo?.() !== undefined;
    if (
      record.activeAbortController === undefined &&
      record.app.runtime?.getActiveForegroundExecutionId?.() === undefined &&
      !coreTurnActive
    ) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new V4SessionIdleTimeoutError(record.app.sessionId);
    }
    await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_INTERVAL_MS));
  }
}

/** Waits for the legacy execution to release; returns whether Core actually cancelled the foreground execution. */
export async function preemptActiveTurnAndWait(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  options: {
    abortMessage: string;
    goalPausedMutationReason: string;
    preserveQueueAutoDrainOnCancel?: boolean;
    /** When false (queue promotion inserts input), skip the goal pause: the goal stays active and the promoted prompt's post-turn goal loop continues the mission. */
    suppressGoalPauseOnCancel?: boolean;
  },
): Promise<boolean> {
  const bootstrapAbortController = record.activeAbortController;
  // A background notification's model-only turn holds foreground authority via the Core runtime command
  // independently, creating no Bootstrap activeAbortController.
  // Missing that misreads idle and then steers the promoted queue item back into the stale notification turn.
  const runtimeStop = record.app.runtime?.stopActiveForegroundExecution?.({
    preserveQueueAutoDrainOnCancel: options.preserveQueueAutoDrainOnCancel === true,
    reason: options.abortMessage,
    suppressGoalPauseOnCancel: options.suppressGoalPauseOnCancel === true,
  });
  if (bootstrapAbortController || runtimeStop?.kind === "stopped") {
    const pausedGoal =
      options.suppressGoalPauseOnCancel === true ? false : await pauseActiveGoal(host, record);
    if (runtimeStop?.kind !== "stopped") {
      bootstrapAbortController?.abort(new Error(options.abortMessage));
    }
    if (pausedGoal) {
      await host.afterLegacyStateMutation?.(record, options.goalPausedMutationReason);
    }
  }
  await waitForSessionIdle(record);
  return runtimeStop?.kind === "stopped";
}

export const sessionFlowHandlers = { sendText, stop };
