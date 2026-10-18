// -- Legacy protocol compat surface (transition) ------------------------------
// Remaining 11 exports: goal iteration / visible-message projection helpers.
// Consumers: zcodeTaskServiceAdapter / zcodeSessionProjection / zcodeTaskIndexSyncer,
// the CLI bootstrap session-mapper. textFromZCodeMessageParts moved to
// zcode-protocol-legacy-types.ts (the surviving surface). This file lives and dies with the legacy projection stack.
import type { ZCodeSessionGoal } from "./zcode-protocol/index.js";
import { getConversationMessageProjectionPolicy } from "./conversation-message-projection-policy.js";
import {
  type ZCodeMessageWithParts,
  textFromZCodeMessageParts,
} from "./zcode-protocol-legacy-types.js";

const GOAL_CONTINUATION_REMINDER_PREFIX = '<system-reminder source="goal-continuation">';
const GOAL_CONTINUATION_TEXT_MARKER = "Continue working toward the active session goal.";
const GOAL_STATE_TEXT_MARKER = "Current session goal state";
const SUBAGENT_MESSAGE_SOURCE = "subagent_message";

export function isZCodeGoalContinuationReminderText(text: string): boolean {
  const normalized = text.trimStart();
  if (normalized.startsWith(GOAL_CONTINUATION_REMINDER_PREFIX)) {
    return true;
  }
  return (
    normalized.startsWith("<system-reminder>") && normalized.includes(GOAL_CONTINUATION_TEXT_MARKER)
  );
}

export function isZCodeGoalContinuationReminderMessage(message: ZCodeMessageWithParts): boolean {
  return (
    message.info.role === "user" &&
    (message.info.source === "goal-continuation" ||
      String(message.info.metadata?.["source"] ?? "") === "goal-continuation" ||
      isZCodeGoalContinuationReminderText(textFromZCodeMessageParts(message.parts)))
  );
}

export function isZCodeGoalStateReminderText(text: string): boolean {
  const normalized = text.trimStart();
  return normalized.startsWith("<system-reminder>") && normalized.includes(GOAL_STATE_TEXT_MARKER);
}

export function isZCodeGoalModelOnlyReminderMessage(message: ZCodeMessageWithParts): boolean {
  return (
    message.info.role === "user" &&
    (isZCodeGoalContinuationReminderMessage(message) ||
      isZCodeGoalStateReminderText(textFromZCodeMessageParts(message.parts)))
  );
}

export function isZCodeModelOnlySyntheticUserMessage(message: ZCodeMessageWithParts): boolean {
  if (
    message.info.role === "user" &&
    (String(message.info.source ?? "") === SUBAGENT_MESSAGE_SOURCE ||
      String(message.info.metadata?.["source"] ?? "") === SUBAGENT_MESSAGE_SOURCE ||
      message.parts.some(
        (part) =>
          part.type === "text" &&
          String(part.metadata?.["source"] ?? "") === SUBAGENT_MESSAGE_SOURCE,
      ))
  ) {
    return true;
  }
  const policy = getConversationMessageProjectionPolicy(message);
  return policy === "providerContextOnly" || policy === "hiddenSynthetic";
}

export function isZCodeCompactSummaryMessage(message: ZCodeMessageWithParts): boolean {
  return (
    message.info.role === "user" &&
    message.parts.some((part) => {
      if (part.type !== "compaction") {
        return false;
      }
      const timelineStatus = part.metadata?.["timelineStatus"];
      // The compact-summary user message is the compressed model context, not a user-visible input.
      // Lifecycle parts actually rendered into the timeline carry timelineStatus and ride an assistant message.
      return typeof timelineStatus !== "string";
    })
  );
}

export function getZCodeUserVisibleMessages(
  messages: readonly ZCodeMessageWithParts[],
  _options: { target?: ZCodeSessionGoal | null } = {},
): ZCodeMessageWithParts[] {
  const visibleMessages: ZCodeMessageWithParts[] = [];
  for (const message of messages) {
    if (isZCodeModelOnlySyntheticUserMessage(message) || isZCodeCompactSummaryMessage(message)) {
      // /goal continuations, background tasks, subagents, rewind notices, and compact summaries
      // are runtime-injected context for the model's next step, not real user queries; the visible projection must filter them
      // so snapshot/remote recoveries never render them as right-side user bubbles or crowd the timeline.
      continue;
    }
    visibleMessages.push(message);
  }
  return visibleMessages;
}

export function getZCodeGoalIterationByAssistantMessageId(
  messages: readonly ZCodeMessageWithParts[],
  options: { maxGoalIteration?: number; target?: ZCodeSessionGoal | null } = {},
): Map<string, number> {
  const target = options.target ?? null;
  if (!target) {
    return new Map();
  }

  const iterationByAssistantId = new Map<string, number>();
  const sortedMessages = [...messages].sort(compareZCodeMessagesByCreatedTime);
  const inactiveAt = target.status === "active" ? null : target.updatedAt;
  let currentIteration = 0;
  let pendingVisibleGoalUserIteration = false;

  for (const message of sortedMessages) {
    if (message.info.role === "user") {
      if (isZCodeGoalContinuationReminderMessage(message)) {
        // Goal-continuation boundaries come only from Continue/source=goal-continuation;
        // Current session goal state is a same-round repeated state hint and must not advance the iteration.
        currentIteration += 1;
        pendingVisibleGoalUserIteration = false;
        continue;
      }
      if (isVisibleRealGoalUserMessage(message, target)) {
        // The new protocol persists both the visible /goal input and the model-only continuation.
        // The visible input only seeds the first boundary when a legacy snapshot lacks the continuation; never double-count with it.
        pendingVisibleGoalUserIteration = true;
      }
      continue;
    }

    if (message.info.role !== "assistant") {
      continue;
    }
    if (inactiveAt !== null && message.info.time.created > inactiveAt) {
      // Plain follow-ups after goal stop/completion stay in the same session without inheriting old goal rounds,
      // or restored snapshots would treat follow-up replies as "iteration N" folded under the old completion line.
      continue;
    }
    if (pendingVisibleGoalUserIteration) {
      currentIteration += 1;
      pendingVisibleGoalUserIteration = false;
    }
    if (currentIteration === 0 && message.info.time.created >= target.createdAt) {
      // Legacy sessions' goal creation input may lack a visible /goal bubble or predate target.createdAt.
      // Assistants after the first goal still belong to iteration 1, or history degrades to a plain "worked".
      currentIteration = 1;
    }
    if (currentIteration > 0) {
      // The assistant bucket is for history status display only; never advance the goal round past what the
      // verifier timeline confirmed; new sessions cap it via maxGoalIteration.
      const boundedIteration =
        options.maxGoalIteration && options.maxGoalIteration > 0
          ? Math.min(currentIteration, options.maxGoalIteration)
          : currentIteration;
      iterationByAssistantId.set(message.info.messageId, boundedIteration);
    }
  }

  return iterationByAssistantId;
}

export interface ZCodeGoalIterationCountTimelineItem {
  goalIteration?: number;
  status: "started" | "completed" | "failed_closed" | "cancelled";
  verification?: { passed?: boolean | null } | null;
}

export function getZCodeGoalActiveIterationCount(input: {
  targetStatus?: string | null;
  timeline?: readonly ZCodeGoalIterationCountTimelineItem[] | null;
}): number {
  if (!input.targetStatus) {
    return 0;
  }
  const timeline = input.timeline ?? [];
  if (timeline.length === 0) {
    return 1;
  }
  const latest = timeline[timeline.length - 1];
  if (!latest) {
    return 1;
  }
  const latestIteration = latest.goalIteration ?? timeline.length;
  if (latest.status === "started") {
    return latestIteration;
  }
  if (
    (latest.status === "completed" && latest.verification?.passed === true) ||
    input.targetStatus === "complete"
  ) {
    return latestIteration;
  }
  if (input.targetStatus !== "active") {
    // stop first flips the target to paused, then closes the running verifier as cancelled.
    // Non-active goals never auto-continue; never pre-project cancelled/failed verifiers into the next round.
    return latestIteration;
  }
  return latestIteration + 1;
}

function compareZCodeMessagesByCreatedTime(
  left: ZCodeMessageWithParts,
  right: ZCodeMessageWithParts,
) {
  const diff = left.info.time.created - right.info.time.created;
  if (diff !== 0) {
    return diff;
  }
  return left.info.messageId.localeCompare(right.info.messageId);
}

function isVisibleRealGoalUserMessage(message: ZCodeMessageWithParts, target: ZCodeSessionGoal) {
  if (
    message.info.role !== "user" ||
    getConversationMessageProjectionPolicy(message) !== "realUserInput"
  ) {
    return false;
  }

  const createdAt = message.info.time.created;
  const nearGoalStart = createdAt >= target.createdAt - 30_000;
  if (!nearGoalStart) {
    return false;
  }

  return true;
}

export function resolveZCodeVisibleSessionTitle(input: {
  title?: string;
  messages: readonly ZCodeMessageWithParts[];
  target?: ZCodeSessionGoal | null;
  fallback?: string;
}): string {
  const normalizedTitle = input.title?.trim() ?? "";
  if (
    normalizedTitle &&
    !isZCodeGoalContinuationReminderText(normalizedTitle) &&
    !isZCodeGoalStateReminderText(normalizedTitle)
  ) {
    return normalizedTitle;
  }

  const firstUser = input.messages.find(
    (message) =>
      message.info.role === "user" &&
      getConversationMessageProjectionPolicy(message) === "realUserInput" &&
      !isZCodeGoalModelOnlyReminderMessage(message),
  );
  const firstUserText = textFromZCodeMessageParts(firstUser?.parts ?? []).trim();
  if (firstUserText) {
    return firstUserText.slice(0, 80);
  }

  const objective = input.target?.objective.trim() ?? "";
  if (objective) {
    return objective.slice(0, 80);
  }

  return input.fallback ?? "New session";
}
