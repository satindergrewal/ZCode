import type { SessionStorePort, SessionId } from "@zcode/contracts";
import type { TurnInputIntentMetadata } from "../deps.js";

/**
 * Assemble protocol-agnostic params into the input fact shared by transcript and ledger.
 *
 * Storing text and metadata apart would force recovery to re-infer delivery,
 * steer and dispatch, drifting live from cold. Fixed once at the
 * admission/drain boundary; downstream reads, never re-guesses.
 */
export function buildPersistedConversationInputIntent(
  text: string,
  intent: TurnInputIntentMetadata | undefined,
  dispatchState: "queued" | "drained",
): Record<string, unknown> | undefined {
  if (!intent) return undefined;

  const steer = intent.fallbackReasonCode
    ? { state: "fellBack", reasonCode: intent.fallbackReasonCode }
    : intent.admittedDelivery === "guide"
      ? { state: dispatchState === "drained" ? "guided" : "steering" }
      : { state: "notRequested" };

  return {
    ...(intent.inputOrigin ? { inputOrigin: intent.inputOrigin } : {}),
    ...(intent.conversationQuotes ? { conversationQuotes: intent.conversationQuotes } : {}),
    ...(intent.botGroupSource ? { botGroupSource: intent.botGroupSource } : {}),
    sourceCommandId: intent.sourceCommandId,
    queueItemId: intent.queueItemId,
    clientId: intent.clientId,
    kind: intent.kind,
    // The goal message text may be the `/goal ...` display form; admission holds the runtime
    // canonical objective — persistence prefers it for live/cold parity.
    text: intent.text ?? text,
    attachments: intent.attachmentRefs ?? [],
    ...(intent.modelSelection ? { modelSelection: intent.modelSelection } : {}),
    ...(intent.mode ? { mode: intent.mode } : {}),
    ...(intent.planEnabled !== undefined ? { planEnabled: intent.planEnabled } : {}),
    ...(intent.sharedContextRefs ? { sharedContextRefs: intent.sharedContextRefs } : {}),
    delivery: {
      requested: intent.requestedDelivery,
      admitted: intent.admittedDelivery,
      ...(intent.fallbackReasonCode ? { fallbackReasonCode: intent.fallbackReasonCode } : {}),
    },
    order: {
      admissionSeq: intent.admissionSeq,
      ...(intent.queuePosition !== undefined ? { queuePosition: intent.queuePosition } : {}),
    },
    steer,
    dispatch: { state: dispatchState },
    admittedAt: intent.admittedAt,
    ...(intent.highspeed ? { highspeed: intent.highspeed } : {}),
    ...(intent.provenance ? { provenance: intent.provenance } : {}),
    ...(intent.source ? { source: intent.source } : {}),
  };
}

/** 在工具执行前收紧群任务授权；普通正文不能改变这个可信 metadata 标记。 */
export async function ensureGroupTaskPermissionScope(
  store: SessionStorePort | undefined,
  sessionId: SessionId,
  intent: TurnInputIntentMetadata | undefined,
): Promise<void> {
  if (!intent?.botGroupSource) return;
  if (!store) throw new Error("Group task permission scope requires persistence");
  const session = await store.getSession(sessionId);
  if (!session) throw new Error("Group task permission scope requires a persisted session");
  if (session.permission?.scope === "session") return;
  await store.updateSession({
    id: sessionId,
    permission: { version: 1, scope: "session", mode: "build" },
  });
}
