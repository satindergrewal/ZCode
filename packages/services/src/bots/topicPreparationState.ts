import type { BotInboundMessage } from "@zcode/shared";

export type TopicPreparationStatus = "preparing" | "waitingStop" | "failed";

/** Holds uncommitted material only; projections exclude file bytes and retries stay behind the inbound grant chain. */
export function createTopicPreparationState() {
  const waitingStop = new Set<string>();
  const topics = new Map<
    string,
    Map<
      string,
      {
        message: BotInboundMessage;
        status: TopicPreparationStatus;
        error?: string;
      }
    >
  >();
  return {
    add(key: string, message: BotInboundMessage) {
      const id = message.actor.providerMessageId;
      if (!id) throw new Error("Topic message identity is missing");
      let entries = topics.get(key);
      if (!entries) {
        entries = new Map();
        topics.set(key, entries);
      }
      entries.set(id, { message, status: waitingStop.has(key) ? "waitingStop" : "preparing" });
    },
    setWaitingStop(key: string, waiting: boolean) {
      // Stop confirmations can land before material grants; keep the topic phase so later messages inherit the waiting state.
      if (waiting) waitingStop.add(key);
      else waitingStop.delete(key);
      for (const entry of topics.get(key)?.values() ?? []) {
        if (entry.status !== "failed") entry.status = waiting ? "waitingStop" : "preparing";
      }
    },
    update(key: string, ids: string[], status: TopicPreparationStatus, error?: string) {
      for (const id of ids) {
        const entry = topics.get(key)?.get(id);
        if (entry) {
          entry.status = status;
          entry.error = error;
        }
      }
    },
    snapshot(key: string) {
      return [...(topics.get(key)?.entries() ?? [])].map(([messageId, entry]) => ({
        messageId,
        senderName: entry.message.actor.displayName ?? entry.message.actor.providerUserId,
        text: entry.message.text,
        contentParts: entry.message.contentParts,
        status: entry.status,
        ...(entry.error ? { error: entry.error } : {}),
      }));
    },
    retry(key: string, id: string) {
      const entry = topics.get(key)?.get(id);
      return entry?.status === "failed" ? entry.message : undefined;
    },
    remove(key: string, ids: string[]) {
      const entries = topics.get(key);
      for (const id of ids) entries?.delete(id);
      if (!entries?.size) topics.delete(key);
    },
    clear(key?: string) {
      if (key) {
        topics.delete(key);
        waitingStop.delete(key);
      } else {
        topics.clear();
        waitingStop.clear();
      }
    },
  };
}
