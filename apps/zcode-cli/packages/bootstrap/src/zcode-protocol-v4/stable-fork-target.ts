import {
  SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  type MessageId,
  type MessageWithParts,
  type SessionStorePort,
  type StableForkGoalBoundaryMetadata,
} from "@zcode/contracts";
import { isConversationRealUserTurnStarter } from "@zcode/shared";
import type { StableForkTarget } from "@zcode/shared/zcode-protocol-v4";
import type { V4StableForkTargetResolution } from "./commands/types.js";
import type { StableForkCandidate } from "./product-projection.js";

function idsAreOrdered(
  messages: readonly MessageWithParts[],
  orderedMessageIds: readonly string[],
  boundaryMessageId: string,
): boolean {
  if (
    orderedMessageIds.length === 0 ||
    orderedMessageIds.at(-1) !== boundaryMessageId ||
    new Set(orderedMessageIds).size !== orderedMessageIds.length
  ) {
    return false;
  }
  const indexById = new Map(messages.map((message, index) => [String(message.info.id), index]));
  let previous = -1;
  for (const messageId of orderedMessageIds) {
    const index = indexById.get(messageId);
    if (index === undefined || index <= previous) return false;
    previous = index;
  }
  return true;
}

function persistedTarget(
  messages: readonly MessageWithParts[],
  candidate: StableForkCandidate,
):
  | { goalBoundary?: StableForkGoalBoundaryMetadata; target: StableForkTarget }
  | null
  | "ambiguous" {
  const boundary = messages.find(
    (message) => String(message.info.id) === candidate.boundaryMessageId,
  );
  const anchor = boundary?.info.anchor;
  if (!anchor || (!anchor.productTurnId && !anchor.orderedMessageIds && !anchor.boundaryMessageId)) {
    return null;
  }
  if (
    (anchor.productTurnId !== undefined && anchor.productTurnId !== candidate.productTurnId) ||
    anchor.boundaryMessageId !== candidate.boundaryMessageId ||
    !anchor.orderedMessageIds ||
    !idsAreOrdered(messages, anchor.orderedMessageIds, candidate.boundaryMessageId)
  ) {
    return "ambiguous";
  }
  return {
    target: {
      productTurnId: anchor.productTurnId ?? candidate.productTurnId,
      transcriptTurnId: String(anchor.turnId ?? candidate.transcriptTurnId),
      orderedMessageIds: anchor.orderedMessageIds.map(String),
      boundaryMessageId: anchor.boundaryMessageId,
    },
    ...(anchor.goalBoundary ? { goalBoundary: anchor.goalBoundary } : {}),
  };
}

/**
 * The projection has proven the product turn succeeded and the row is a turn-final completed assistant; this then
 * fixes the raw user/assistant/tool message boundaries by transcript order. Historical data falls back only when the parent/user
 * boundary is unique, then lazily backfills the anchor so later retries pin the same id set.
 */
export async function resolveStableForkTargetFromTranscript(options: {
  candidate: StableForkCandidate;
  messages: readonly MessageWithParts[];
  store: SessionStorePort;
}): Promise<V4StableForkTargetResolution> {
  const persisted = persistedTarget(options.messages, options.candidate);
  if (persisted === "ambiguous") {
    return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
  }
  if (persisted) {
    const goalBoundary =
      persisted.goalBoundary ??
      (await legacyGoalBoundary(options.store, options.messages, persisted.target.boundaryMessageId));
    if (!goalBoundary) return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
    const boundary = options.messages.find(
      (message) => String(message.info.id) === persisted.target.boundaryMessageId,
    );
    if (!persisted.goalBoundary || boundary?.info.anchor?.productTurnId === undefined) {
      await persistResolvedAnchor(options, persisted.target, goalBoundary);
    }
    return { ok: true, target: persisted.target, goalBoundary };
  }

  const boundaryIndex = options.messages.findIndex(
    (message) => String(message.info.id) === options.candidate.boundaryMessageId,
  );
  const boundary = options.messages[boundaryIndex];
  if (boundaryIndex < 0 || boundary?.info.role !== "assistant" || boundary.info.error) {
    return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
  }
  const boundaryParentId = boundary.info.parentID;

  let startIndex = options.candidate.startMessageId
    ? options.messages.findIndex(
        (message) => String(message.info.id) === options.candidate.startMessageId,
      )
    : -1;
  if (startIndex < 0) {
    startIndex = options.messages.findIndex(
      (message) => String(message.info.id) === String(boundaryParentId),
    );
  }
  if (startIndex < 0 || startIndex > boundaryIndex) {
    return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
  }
  const start = options.messages[startIndex];
  if (!start || start.info.role !== "user") {
    return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
  }
  const nestedRealUser = options.messages
    .slice(startIndex + 1, boundaryIndex + 1)
    .some((message) => isConversationRealUserTurnStarter(message));
  if (nestedRealUser) {
    return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
  }

  const orderedMessageIds = options.messages
    .slice(startIndex, boundaryIndex + 1)
    .map((message) => String(message.info.id));
  const target: StableForkTarget = {
    productTurnId: options.candidate.productTurnId,
    transcriptTurnId: String(boundary.info.anchor?.turnId ?? options.candidate.transcriptTurnId),
    orderedMessageIds,
    boundaryMessageId: options.candidate.boundaryMessageId,
  };
  const goalBoundary = await legacyGoalBoundary(
    options.store,
    options.messages,
    target.boundaryMessageId,
  );
  if (!goalBoundary) return { ok: false, reasonCode: "guard.forkTargetAmbiguous" };
  await persistResolvedAnchor(options, target, goalBoundary);
  return { ok: true, target, goalBoundary };
}

async function legacyGoalBoundary(
  store: SessionStorePort,
  messages: readonly MessageWithParts[],
  boundaryMessageId: string,
): Promise<StableForkGoalBoundaryMetadata | null> {
  const boundary = messages.find((message) => String(message.info.id) === boundaryMessageId);
  if (!boundary) return null;
  // Legacy transcripts have no fork-point goal version; while the parent still has a target, future state must not
  // masquerade as history. Only with no current target and no verifier ledger is downgrading to explicit none unambiguous.
  if (await store.readTarget({ sessionID: boundary.info.sessionID })) return null;
  if (!store.sessionEntries) return { kind: "none" };
  const entries = await store.sessionEntries({
    sessionID: boundary.info.sessionID,
    type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  });
  return entries.length === 0 ? { kind: "none" } : null;
}

async function persistResolvedAnchor(
  options: {
    candidate: StableForkCandidate;
    messages: readonly MessageWithParts[];
    store: SessionStorePort;
  },
  target: StableForkTarget,
  goalBoundary: StableForkGoalBoundaryMetadata,
): Promise<void> {
  const boundary = options.messages.find(
    (message) => String(message.info.id) === target.boundaryMessageId,
  );
  if (!boundary) return;
  await options.store.saveMessage({
    ...boundary.info,
    anchor: {
      ...boundary.info.anchor,
      productTurnId: target.productTurnId,
      orderedMessageIds: target.orderedMessageIds as MessageId[],
      boundaryMessageId: target.boundaryMessageId as MessageId,
      goalBoundary,
    },
  });
}
