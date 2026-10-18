import { SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION } from "../deps.js";
import type {
  MessageId,
  MessageProjectionAnchor,
  SessionEntryInfo,
  SessionGoal,
  TraceContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

interface VerificationEntryPayload {
  anchorAssistantMessageId?: string;
  targetId?: string;
}

/**
 * Before TurnComplete reaches subscribers, pin fork-relevant history onto the final assistant.
 * productTurnId is bootstrap domain; here only the core-authoritative raw segment pins;
 * the resolver fills it from the projection candidate; core must not copy the ~qN scheme.
 */
export async function persistStableForkCompletionBoundary(
  runtime: AgentRuntimeInternal,
  input: {
    boundaryMessageId: MessageId;
    startMessageId: MessageId;
    historyRoundCount: number;
    traceContext: TraceContext;
  },
): Promise<void> {
  const store = runtime.sessionStore;
  if (!store) return;

  const messages = await store.messages({ sessionID: runtime.sessionId });
  const boundaryIndex = messages.findLastIndex(
    (message) =>
      message.info.id === input.boundaryMessageId &&
      message.info.role === "assistant" &&
      !message.info.error &&
      message.info.time.completed !== undefined,
  );
  const startIndex = messages.findLastIndex(
    (message, index) =>
      index <= boundaryIndex && message.info.id === input.startMessageId,
  );
  const boundary = messages[boundaryIndex];
  if (
    startIndex < 0 ||
    boundaryIndex < startIndex ||
    boundary?.info.role !== "assistant" ||
    boundary.info.error ||
    boundary.info.time.completed === undefined
  ) {
    // Tolerates partial-SessionStorePort adapters/test doubles and transcripts rewritten
    // by edit/rewind pre-close; no exact segment, no fake anchor — the resolver
    // still decides by the legacy unambiguous rule.
    return;
  }

  const orderedMessageIds = messages
    .slice(startIndex, boundaryIndex + 1)
    .map((message) => message.info.id);
  const prefixMessageIds = new Set(
    messages
      .slice(0, boundaryIndex + 1)
      .map((message) => String(message.info.id)),
  );
  const target =
    typeof store.readTarget === "function"
      ? await store.readTarget({ sessionID: runtime.sessionId })
      : null;
  const goalBoundary = target
    ? {
        kind: "snapshot" as const,
        target: stableGoalSnapshot(target),
        verificationEntryIds: await verificationEntryIdsAtBoundary(
          runtime,
          target,
          prefixMessageIds,
        ),
      }
    : { kind: "none" as const };

  const anchor: MessageProjectionAnchor = {
    ...boundary.info.anchor,
    ...(input.traceContext.turnId ? { turnId: input.traceContext.turnId } : {}),
    historyRoundCount: input.historyRoundCount,
    orderedMessageIds,
    boundaryMessageId: input.boundaryMessageId,
    goalBoundary,
  };
  await store.saveMessage({ ...boundary.info, anchor });
}

function stableGoalSnapshot(target: SessionGoal): SessionGoal {
  // Active-run fields are parent-transient, not child state; the production adapter
  // clears them in cloneTargetForFork; clear the anchor too, or queries read history as running.
  return {
    ...target,
    activeInputId: null,
    activeRunStartedAtMs: null,
    activeRunLastSeenAtMs: null,
    time: { ...target.time },
  };
}

async function verificationEntryIdsAtBoundary(
  runtime: AgentRuntimeInternal,
  target: SessionGoal,
  prefixMessageIds: ReadonlySet<string>,
): Promise<string[]> {
  const store = runtime.sessionStore;
  if (!store?.sessionEntries) {
    // A goal with an unreadable verifier ledger gets no fake empty boundary — the child could silently lose
    // pre-fork verifiers. Fail loudly; TurnComplete/canFork waits for the anchor.
    return [];
  }
  const entries = await store.sessionEntries({
    sessionID: runtime.sessionId,
    type: SESSION_ENTRY_TARGET_COMPLETION_VERIFICATION,
  });
  return entries.flatMap((entry) => {
    const payload = verificationEntryPayload(entry);
    if (payload?.targetId !== target.targetID) return [];
    if (
      payload.anchorAssistantMessageId &&
      !prefixMessageIds.has(payload.anchorAssistantMessageId)
    ) {
      return [];
    }
    return [entry.id];
  });
}

function verificationEntryPayload(
  entry: SessionEntryInfo,
): VerificationEntryPayload | null {
  if (
    !entry.data ||
    typeof entry.data !== "object" ||
    Array.isArray(entry.data)
  )
    return null;
  const payload = (entry.data as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return null;
  const record = payload as Record<string, unknown>;
  return {
    ...(typeof record.targetId === "string"
      ? { targetId: record.targetId }
      : {}),
    ...(typeof record.anchorAssistantMessageId === "string"
      ? { anchorAssistantMessageId: record.anchorAssistantMessageId }
      : {}),
  };
}
