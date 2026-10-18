import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { commandAdmissionOf } from "../executor.js";
import { inputIntentMetadata } from "../input-intent.js";
import { startPromptTurn } from "../prompt-turn.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";

async function createSelectionSideSession(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult> {
  const payload = envelope.payload as CommandPayloadMap["createSelectionSideSession"];
  const record = requireRecord(host, envelope.sessionId);
  if (!host.createSelectionSideSession) {
    throw new Error("v4 createSelectionSideSession requires host capability");
  }
  const result = await host.createSelectionSideSession(record.app.sessionId, {
    sourceCommandId: envelope.commandId,
    revisionAtDecision: envelope.baseRevision ?? 0,
    ...(payload.firstInput?.modelSelection
      ? { modelSelection: payload.firstInput.modelSelection }
      : {}),
  });
  const childSessionId = result.sessionId;
  const firstInput = payload.firstInput;
  if (!firstInput) {
    return { type: "createSelectionSideSession", sessionId: childSessionId };
  }

  // The child is registered in the host before its first input starts; input lands only in the child, and the parent session's
  // CommandInbox/queue takes no part in this admission, so the parent turn's running state is untouched.
  const childRecord = requireRecord(host, childSessionId);
  const admission = commandAdmissionOf(envelope);
  // The gateway never treats createSelectionSideSession as a parent-session input command; the handler points
  // the same envelope at the child, reusing the session_input ledger without polluting the parent queue.
  const durableAdmission =
    (await host.admitInputCommand?.(envelope, childSessionId, admission)) ?? null;
  try {
    const started = await startPromptTurn(host, childRecord, {
      content: firstInput.text,
      inputId: envelope.commandId,
      intent: inputIntentMetadata(envelope, {
        text: firstInput.text,
        requestedDelivery: "startNow",
      }),
    });
    const input = {
      delivery: started.admission.kind === "queued" ? ("queue" as const) : ("startNow" as const),
      inputId: envelope.commandId,
      ...(started.messageId ? { messageId: started.messageId } : {}),
    };
    return {
      type: "createSelectionSideSession",
      sessionId: childSessionId,
      ...(input ? { input } : {}),
    };
  } catch (error) {
    if (durableAdmission) {
      try {
        await host.cancelInputCommand?.(
          childSessionId,
          admission.queueItemId,
          "fault.command.inputRejected",
        );
      } catch (cancelError) {
        host.logger?.warn?.("v4 selection side first input cancellation failed", {
          cancelError: cancelError instanceof Error ? cancelError.message : String(cancelError),
          inputError: error instanceof Error ? error.message : String(error),
          queueItemId: admission.queueItemId,
          sessionId: childSessionId,
        });
      }
    }
    throw error;
  }
}

export const selectionSideSessionHandlers = {
  createSelectionSideSession,
};
