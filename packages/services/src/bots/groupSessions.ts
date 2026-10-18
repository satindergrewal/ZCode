import type { BotActor, BotContextState } from "@zcode/shared";

/** Group identity must not be replaced by the sender, or multi-person chats cross into private threads or spawn duplicate tasks. */
export function getBotConversationKey(
  actor: Pick<BotActor, "botId" | "chatType" | "chatId" | "threadId" | "conversationThreadId">,
): string {
  if (actor.chatType === "private") return actor.botId;
  const chatId = actor.chatId?.trim();
  if (!chatId) throw new Error("Group chat ID is required");
  // Legacy default group keys stay; topics get their own key and never overwrite the group default task.
  const threadId = (
    actor.conversationThreadId !== undefined ? actor.conversationThreadId : actor.threadId
  )?.trim();
  return JSON.stringify(threadId ? [actor.botId, chatId, threadId] : [actor.botId, chatId]);
}

export function getBotStateKey(context: BotContextState): string {
  return getBotConversationKey({
    botId: context.botId,
    chatType: context.group ? "group" : "private",
    chatId: context.group?.chatId,
    threadId: context.group?.threadId,
  });
}

export function isGroupOwnerCommand(command: string): boolean {
  return !["help", "status", "message", "answer"].includes(command);
}

export function canAnswerGroupQuestion(
  actorId: string,
  ownerId: string,
  initiatorId: string | undefined,
  isPlan: boolean,
): boolean {
  return actorId === ownerId || (!isPlan && actorId === initiatorId);
}
