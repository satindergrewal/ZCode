import type { BotActor, BotOutboundMessage } from "@zcode/shared";

/** Escalate only config/connection errors identified by the service; never scan model output to guess admin to-dos. */
export class BotAdminRequiredError extends Error {
  constructor(
    public readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

/** Keep the structured preparation prompt so continuation never flattens recipients into plain text. */
export class BotReplyError extends Error {
  constructor(public readonly replies: BotOutboundMessage[]) {
    super(replies.map((reply) => reply.text).join("\n"));
  }
}

/** Notification dedupe never gates task intake, grants, or execution; reminders may repeat after a restart. */
export function createGroupAdminAttention() {
  const sent = new Map<string, true>();
  const scope = (actor: BotActor, owner: string) =>
    JSON.stringify([actor.botId, actor.chatId, actor.threadId, owner]);
  return {
    mention(actor: BotActor, owner: string | undefined, reason: string): string[] | undefined {
      if (actor.chatType !== "group" || !actor.chatId || !owner) return undefined;
      const key = `${scope(actor, owner)}:${reason}`;
      if (sent.has(key)) return [];
      sent.set(key, true);
      if (sent.size > 1000) sent.delete(sent.keys().next().value!);
      return [owner];
    },
    clear(actor?: BotActor, owner?: string, reason?: string) {
      if (!actor) {
        sent.clear();
        return;
      }
      if (!owner) return;
      const prefix = `${scope(actor, owner)}:`;
      for (const key of sent.keys()) {
        if (
          reason
            ? key === `${prefix}${reason}`
            : key.startsWith(prefix) &&
              !key.slice(prefix.length).startsWith("permission:") &&
              !key.slice(prefix.length).startsWith("plan:")
        )
          sent.delete(key);
      }
    },
  };
}
