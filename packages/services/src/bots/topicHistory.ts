import type { BotTopicHistoryBatch, BotTopicHistoryRequest, BotTopicMessage } from "@zcode/shared";

/** Distinguish permission denials from transient network errors so users are not misdirected into granting. */
export class TopicHistoryPermissionError extends Error {}

interface TopicHistoryReader {
  /** Native thread containers page newest-first by creation time; the API has no time filter. */
  list(page?: string): Promise<{ messages: BotTopicMessage[]; next?: string }>;
  get(messageId: string): Promise<BotTopicMessage>;
  hydrate?(message: BotTopicMessage): Promise<BotTopicMessage>;
}

/** Prepare immutable context only and never advance checkpoints; advancement waits for CLI admission. */
export async function readTopicHistory(
  request: BotTopicHistoryRequest,
  reader: TopicHistoryReader,
): Promise<BotTopicHistoryBatch> {
  // Even a first mention on the root message hits the native history API; a missing earlier message never skips the grant check.
  if (request.messageId === request.rootMessageId && !request.checkpoint) {
    await reader.list();
    return { messages: [], checkpoint: request.messageId, hasGap: false };
  }
  const seen = new Set<string>();
  const messages: BotTopicMessage[] = [];
  let boundaryFound = false;
  let checkpointFound = !request.checkpoint;
  let hasGap = false;
  let page: string | undefined;
  let examined = 0;
  let finished = false;
  const validate = (message: BotTopicMessage) => {
    if (message.chatId !== request.chatId || message.threadId !== request.threadId)
      throw new Error("Topic history scope mismatch");
  };
  // The page cap also bounds scanning of the flood after this mention, so busy topics can catch up.
  for (let pages = 0; pages < 8 && !finished; pages += 1) {
    const batch = await reader.list(page);
    for (const message of batch.messages) {
      validate(message);
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      if (!boundaryFound) {
        if (message.id === request.messageId) boundaryFound = true;
        continue;
      }
      if (message.id === request.checkpoint) {
        checkpointFound = true;
        finished = true;
        break;
      }
      if (examined >= 200) {
        hasGap = true;
        finished = true;
        break;
      }
      examined += 1;
      if (message.deleted) hasGap = true;
      if (!message.deleted && message.id !== request.rootMessageId) messages.push(message);
    }
    if (!batch.next) finished = true;
    else if (!finished) page = batch.next;
  }
  if (!boundaryFound) throw new Error("Topic history invocation boundary unavailable");
  if (!finished || !checkpointFound) hasGap = true;
  messages.reverse();
  if (!request.checkpoint) {
    const root = await reader.get(request.rootMessageId);
    validate(root);
    if (root.deleted) hasGap = true;
    else if (root.id !== request.messageId) messages.unshift(root);
  }
  // Out-of-window or deleted cards must not block this turn on body fetch failures; filter first, then read only what is needed.
  if (reader.hydrate) {
    const hydrated = await Promise.all(messages.map((message) => reader.hydrate!(message)));
    messages.splice(0, messages.length, ...hydrated);
  }
  // Card bodies and bot acks are not discussion material; scanning keeps native boundaries so checkpoints stay intact.
  const isBot = (message: BotTopicMessage) => message.senderType === "app";
  const cards = new Set(
    messages
      .filter((message) => isBot(message) && message.controlCard === true)
      .map((message) => message.id),
  );
  return {
    messages: messages.filter(
      (message) =>
        !cards.has(message.id) &&
        !(isBot(message) && message.parentId && cards.has(message.parentId)),
    ),
    checkpoint: request.messageId,
    hasGap,
  };
}
