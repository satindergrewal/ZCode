import type { ZCodePersistedMessage, ZCodePersistedMessagePart } from "./zcode-task-types-core.js";

// The ZCode runtime persists **every LLM call** in one user turn as its own assistant message (each with time.created/completed).
// The legacy task projection assumes one assistant per turn, and so does the UI (one assistant -> one "worked Xs" block).
// Merge adjacent projected assistants back into one, restoring the invariant; legacy data is strictly alternating, so it is a no-op there.
// Legacy projected data is strictly alternating already; a no-op there.
//
// Also assign turnIndex by user-count explicitly, fixing toTaskChatMessages' Math.floor(index / 2)
// fallback miscounting once turns have several assistants.
export function coalesceConsecutiveZCodeAssistants(
  messages: readonly ZCodePersistedMessage[],
): ZCodePersistedMessage[] {
  const merged: ZCodePersistedMessage[] = [];
  for (const message of messages) {
    const last = merged[merged.length - 1];
    // Synthetic timelines (compact/fork/goal verifier) have assistant role but are message boundaries, not body of the round;
    // merging them would swallow dividers and bill maintenance time to the previous reply.
    if (
      message.role === "assistant" &&
      last?.role === "assistant" &&
      !last.syntheticTimeline &&
      !message.syntheticTimeline &&
      last.goalIteration === message.goalIteration
    ) {
      merged[merged.length - 1] = mergeAssistantPair(last, message);
      continue;
    }
    merged.push(message);
  }

  let turn = -1;
  return merged.map((message) => {
    if (message.role === "user") {
      turn += 1;
    }
    const effectiveTurn = turn < 0 ? 0 : turn;
    return message.turnIndex === effectiveTurn ? message : { ...message, turnIndex: effectiveTurn };
  });
}

function mergeAssistantPair(
  first: ZCodePersistedMessage,
  next: ZCodePersistedMessage,
): ZCodePersistedMessage {
  const firstTools = first.tools ?? [];
  const nextTools = next.tools ?? [];
  const mergedTools =
    firstTools.length + nextTools.length > 0 ? [...firstTools, ...nextTools] : undefined;

  const toolIndexOffset = firstTools.length;
  const firstParts = first.parts ?? [];
  const shiftedNextParts: ZCodePersistedMessagePart[] = (next.parts ?? []).map((part) =>
    part.type === "tool-call"
      ? { type: "tool-call", toolIndex: part.toolIndex + toolIndexOffset }
      : part,
  );
  const mergedParts =
    firstParts.length + shiftedNextParts.length > 0
      ? [...firstParts, ...shiftedNextParts]
      : undefined;

  const mergedContent = first.content + next.content;
  const mergedThought =
    first.thought === undefined && next.thought === undefined
      ? undefined
      : (first.thought ?? "") + (next.thought ?? "");

  // Any round without a completed time means the turn is unfinished; leave duration empty so the UI shows "working".
  const durationMs =
    first.durationMs === undefined || next.durationMs === undefined
      ? undefined
      : Math.max(next.timestamp + next.durationMs - first.timestamp, 0);

  const characterCount =
    first.characterCount === undefined && next.characterCount === undefined
      ? undefined
      : mergedContent.length;
  const mergedMessageIds = collectMergedMessageIds(first, next);

  return {
    ...first,
    content: mergedContent,
    timestamp: first.timestamp,
    model: next.model ?? first.model,
    durationMs,
    characterCount,
    interrupted: next.interrupted ?? first.interrupted,
    feedback: next.feedback ?? first.feedback,
    mergedMessageIds: mergedMessageIds.length > 0 ? mergedMessageIds : undefined,
    goalIteration: next.goalIteration ?? first.goalIteration,
    attachments: next.attachments ?? first.attachments,
    tools: mergedTools,
    thought: mergedThought,
    parts: mergedParts,
    checkpointState: next.checkpointState ?? first.checkpointState,
    checkpointReason: next.checkpointReason ?? first.checkpointReason,
    checkpointUpdatedAt: next.checkpointUpdatedAt ?? first.checkpointUpdatedAt,
    bodyRefs: next.bodyRefs ?? first.bodyRefs,
    toolSlice: next.toolSlice ?? first.toolSlice,
  };
}

function collectMergedMessageIds(
  first: ZCodePersistedMessage,
  next: ZCodePersistedMessage,
): string[] {
  const ids = [
    first.id,
    ...(first.mergedMessageIds ?? []),
    next.id,
    ...(next.mergedMessageIds ?? []),
  ].filter((id): id is string => Boolean(id));
  return [...new Set(ids)];
}
