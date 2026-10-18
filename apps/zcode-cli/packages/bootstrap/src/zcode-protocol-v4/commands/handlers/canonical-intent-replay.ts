// edit/retry's canonical-intent replay primitive: after a rewind truncation, re-issue the projection resolver's
// canonical user intent (attachment refs, model Selection, goal-command semantics) as a new turn.
// Extracted from fork-edit-retry.ts: editUserQuery and retryTurn share it; forkAssistant never passes here
// (a fork is a conversation-only copy: no rewind, no re-send).
import type { CommandEnvelope, CommandPayloadMap } from "@zcode/shared/zcode-protocol-v4";
import { isHighspeedProviderId } from "@zcode/shared";
import type { mapAttachmentRefsToTurnAttachments } from "../attachment-refs.js";
import { resolveSessionFallbackModelSelection } from "../input-admission.js";
import { inputIntentMetadataFromCanonical } from "../input-intent.js";
import { startPromptTurn } from "../prompt-turn.js";
import { createModelExecutionContext } from "../../../zcode-protocol/model-execution.js";
import type { V4CommandCoreHost, V4QueuedTurnExecution, V4SessionRecordView } from "../types.js";
import { applyGoalCommand } from "./goal-compact.js";
import type { ConversationEditTarget } from "../../product-projection.js";

const EDIT_QUEUE_FALLBACK_REASON = "edit.admissionRace";

export function stableAttachmentRefs(editTarget: ConversationEditTarget) {
  return editTarget.intent.attachments?.flatMap((attachment) =>
    attachment.ref ? [{ ...attachment, ref: attachment.ref }] : [],
  );
}

export async function startCanonicalIntent(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  envelope: CommandEnvelope,
  editTarget: ConversationEditTarget,
  text: string,
  attachmentRefs: ReturnType<typeof stableAttachmentRefs>,
  attachments: Awaited<ReturnType<typeof mapAttachmentRefsToTurnAttachments>>,
  highspeed?: {
    card: NonNullable<CommandPayloadMap["editUserQuery"]["highspeedMeta"]>;
    modelSelection: NonNullable<CommandPayloadMap["editUserQuery"]["modelSelection"]>;
    execution: V4QueuedTurnExecution;
  },
  options?: { requireQueue?: boolean },
): Promise<void> {
  const intent = inputIntentMetadataFromCanonical(
    envelope,
    {
      kind: editTarget.intent.kind,
      conversationQuotes:
        envelope.type === "editUserQuery"
          ? ((envelope.payload as CommandPayloadMap["editUserQuery"]).conversationQuotes ??
            editTarget.intent.conversationQuotes)
          : editTarget.intent.conversationQuotes,
      text: editTarget.intent.text,
      sourceCommandId: editTarget.intent.sourceCommandId,
      clientId: editTarget.intent.clientId,
      queueItemId: editTarget.intent.queueItemId,
      requestedDelivery: editTarget.intent.requestedDelivery,
      admittedDelivery: editTarget.intent.admittedDelivery,
      fallbackReasonCode: editTarget.intent.fallbackReasonCode,
      modelSelection: editTarget.intent.modelSelection,
      mode: editTarget.intent.mode,
      planEnabled: editTarget.intent.planEnabled,
      attachmentRefs,
      provenance: editTarget.intent.provenance,
    },
    text,
  );
  const requireQueue = options?.requireQueue === true;
  const retainQueuedTurnExecution = host.retainQueuedTurnExecution;
  // Queued-path credentials stay in memory only; without host staging, fall back wholly to the session model — no half-way speed-up.
  const canRetainQueuedHighspeed =
    requireQueue && highspeed !== undefined && retainQueuedTurnExecution !== undefined;
  const appliesHighspeed = highspeed !== undefined && (!requireQueue || canRetainQueuedHighspeed);
  if (appliesHighspeed && highspeed) {
    intent.highspeed = highspeed.card;
    // A re-sent edit is a new send: the canonical intent's model becomes this card's Selection,
    // never the rewound turn's old model, or promotion would hit a plain endpoint with speed-up credentials.
    intent.modelSelection = highspeed.modelSelection;
  } else if (isHighspeedProviderId(intent.modelSelection?.providerId)) {
    // Root cause: retry, an edit whose card expired / was not re-drawn, and a queued edit without host staging all lack this turn's execution material,
    // yet inherited the rewound turn's persisted account:*-highspeed-card Selection. A speed-up Selection is valid only paired with the same
    // turn's requestAuth: keeping it alone makes Core fail with ModelRequestAuthMissing and pins it into the new
    // canonical intent, so later plain sends keep carrying an unusable speed-up provider. Shares the queue-promotion resolver
    // falling back to the resident Selection; only this turn's intent changes, never the session model (spec 3, rule 13).
    intent.modelSelection = resolveSessionFallbackModelSelection(record);
  }
  if (requireQueue) {
    intent.requestedDelivery = "queue";
    intent.admittedDelivery = "queue";
    intent.fallbackReasonCode = EDIT_QUEUE_FALLBACK_REASON;
    if (canRetainQueuedHighspeed && highspeed && retainQueuedTurnExecution) {
      retainQueuedTurnExecution(record.app.sessionId, envelope.commandId, highspeed.execution);
    }
  }
  if (editTarget.intent.kind === "sendGoalCommand") {
    await applyGoalCommand(host, record, {
      inputId: envelope.commandId,
      objective: text,
      intent,
    });
    return;
  }
  try {
    const started = await startPromptTurn(host, record, {
      content: text,
      inputId: envelope.commandId,
      intent,
      ...(requireQueue
        ? { requireQueue: true }
        : highspeed
          ? { modelExecution: createModelExecutionContext(highspeed.execution) }
          : {}),
      ...(attachments ? { attachments } : {}),
    });
    if (requireQueue && started.admission.kind !== "queued") {
      throw new Error("edited input was not admitted to the queue");
    }
  } catch (error) {
    if (canRetainQueuedHighspeed) {
      host.deleteQueuedTurnExecution?.(record.app.sessionId, envelope.commandId);
    }
    throw error;
  }
}
