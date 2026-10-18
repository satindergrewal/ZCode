import type { BotOutboundMessage } from "@zcode/shared";

type ReplyTarget = Pick<BotOutboundMessage, "replyToMessageId" | "threadId" | "rootMessageId">;

/** Bounded fallback after explicit rejection: never misroute a topic to the group owner chat nor retry a dead anchor. */
export function getUnavailableReplyFallback(target: ReplyTarget): ReplyTarget | null {
  const current = target.replyToMessageId || (target.threadId ? target.rootMessageId : undefined);
  if (!current) return null;
  if (!target.threadId) return { ...target, replyToMessageId: undefined };
  if (!target.rootMessageId || current === target.rootMessageId) return null;
  return { ...target, replyToMessageId: target.rootMessageId };
}
