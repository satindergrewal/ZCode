import { z } from "zod";
import type {
  MessageWithParts,
  ReadSessionContextInput,
  ReadSessionContextOutput,
} from "@zcode/contracts";
import { estimateTokens } from "../context/utils.js";

const recordSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  threadId: z.string(),
  text: z.string(),
  senderId: z.string(),
  senderType: z.enum(["user", "app"]),
  createdAt: z.number(),
});
const sourceSchema = z.object({
  botId: z.string(),
  chatId: z.string(),
  threadId: z.string(),
  topicContext: z.object({ messages: z.array(recordSchema), hasGap: z.boolean() }),
});

/** Originals read only the runtime's trusted input facts; message bodies and summaries never widen the retrieval scope. */
export function readTopicArchive(
  messages: MessageWithParts[],
  query: ReadSessionContextInput,
): ReadSessionContextOutput {
  const sources = messages.flatMap(({ info }) => {
    if (info.role !== "user" || info.synthetic) return [];
    // The new protocol guarantees canonical input facts only; when present, never fall back to the same message's older fields, or old background hides the new record.
    const metadata = info.metadata;
    const intent =
      metadata && Object.hasOwn(metadata, "conversationInputIntent")
        ? metadata.conversationInputIntent
        : metadata?.inputIntent;
    const parsed = sourceSchema.safeParse(
      intent && typeof intent === "object" ? Reflect.get(intent, "botGroupSource") : undefined,
    );
    return parsed.success ? [parsed.data] : [];
  });
  const scope = sources.at(-1);
  const records = new Map<string, z.infer<typeof recordSchema>>();
  let hasGap = false;
  for (const source of sources) {
    if (
      source.botId !== scope?.botId ||
      source.chatId !== scope.chatId ||
      source.threadId !== scope.threadId
    )
      continue;
    hasGap ||= source.topicContext.hasGap;
    for (const record of source.topicContext.messages) {
      if (
        record.chatId === scope.chatId &&
        record.threadId === scope.threadId &&
        record.senderType === "user"
      )
        records.set(record.id, record);
    }
  }
  const needle = query.query.toLocaleLowerCase();
  const matches = [...records.values()].filter(
    (record) => record.id === query.query || record.text.toLocaleLowerCase().includes(needle),
  );
  const offset = query.cursor ?? 0;
  const budget = Math.min(query.maxTokens ?? 6000, 12000);
  if (budget < 256) throw new Error("Topic retrieval budget must be at least 256 tokens");
  const selected: typeof matches = [];
  let consumed = 0;
  let clipped = false;
  for (const record of matches.slice(offset, offset + 20)) {
    const cost = estimateTokens(JSON.stringify(record));
    if (consumed + cost > budget - 100) {
      if (selected.length) break;
      // Over-long singles keep a recognizable preview declared as truncated, never disguised as the full original.
      let text = record.text;
      while (estimateTokens(JSON.stringify({ ...record, text })) > budget - 100 && text.length)
        text = text.slice(0, Math.floor(text.length * 0.8));
      selected.push({ ...record, text });
      clipped = true;
      break;
    }
    selected.push(record);
    consumed += cost;
  }
  const next = offset + selected.length;
  return {
    status: scope ? "success" : "not_found",
    sessionId: query.sessionId,
    strategy: "topic",
    query: query.query,
    source: "local",
    content: JSON.stringify({
      coverage: "Previously archived messages only; unread history is not available.",
      records: selected,
    }),
    messageCount: records.size,
    selectedMessageCount: selected.length,
    truncated: hasGap || clipped || next < matches.length,
    ...(next < matches.length ? { nextCursor: next } : {}),
    references: selected.map((record) => ({ messageId: record.id })),
  };
}
