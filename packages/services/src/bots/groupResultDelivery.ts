import { getUnavailableReplyFallback } from "#src/bots/groupReply.js";
import { setTimeout as sleep } from "node:timers/promises";
import type { BotGroupDelivery } from "@zcode/shared";

interface GroupDeliveryDependencies {
  read(id: string): Promise<BotGroupDelivery | undefined>;
  write(result: BotGroupDelivery): Promise<void>;
  authorized(result: BotGroupDelivery): Promise<boolean>;
  send(result: BotGroupDelivery): Promise<void | { providerMessageId: string }>;
  onSettled?(): Promise<void>;
  delay?(milliseconds: number): Promise<void>;
}

/** Only persists and delivers finished results; owns no execution or input queue. */
export function createGroupResultDelivery(deps: GroupDeliveryDependencies) {
  const inFlight = new Map<string, Promise<void>>();
  const deliver = (result: BotGroupDelivery, retry = false): Promise<void> => {
    const existing = inFlight.get(result.id);
    if (existing) return existing;
    const operation = (async () => {
      const saved = await deps.read(result.id);
      const current = saved ?? result;
      if (saved && (saved.status !== "failed" || !retry)) return;
      let attemptResult = current;
      let retries = 0;
      for (;;) {
        if (!(await deps.authorized(attemptResult))) {
          await deps.write({ ...attemptResult, status: "invalidated", updatedAt: Date.now() });
          return;
        }
        // Persist unknown before the request: after a crash an uncertain result must not count as unsent.
        await deps.write({ ...attemptResult, status: "unknown", updatedAt: Date.now() });
        try {
          const sent = await deps.send(attemptResult);
          await deps.write({
            ...attemptResult,
            ...(sent ? { providerMessageId: sent.providerMessageId } : {}),
            status: "sent",
            lastError: undefined,
            updatedAt: Date.now(),
          });
          return;
        } catch (error) {
          const details = error as {
            deliveryRejected?: boolean;
            deliveryReplyUnavailable?: boolean;
            retryAfterMs?: number;
          } | null;
          const rejected = details?.deliveryRejected === true;
          await deps.write({
            ...attemptResult,
            status: rejected ? "failed" : "unknown",
            lastError: error instanceof Error ? error.message : String(error),
            updatedAt: Date.now(),
          });
          // Degrade only on explicit rejection: plain groups drop the quote, topics fall back at most to the root anchor, and the group target stays pinned by the closure.
          if (rejected && details?.deliveryReplyUnavailable) {
            const fallback = getUnavailableReplyFallback(attemptResult);
            if (fallback) {
              attemptResult = { ...attemptResult, ...fallback };
              continue;
            }
          }
          if (
            rejected &&
            typeof details?.retryAfterMs === "number" &&
            Number.isFinite(details.retryAfterMs) &&
            retries < 2
          ) {
            retries += 1;
            await (deps.delay ?? sleep)(
              Math.max(250, Math.min(30_000, details.retryAfterMs * retries)),
            );
            continue;
          }
          return;
        }
      }
    })().finally(async () => {
      inFlight.delete(result.id);
      await deps.onSettled?.();
    });
    inFlight.set(result.id, operation);
    return operation;
  };
  return Object.assign(deliver, {
    isInFlight: (id: string) => inFlight.has(id),
    // Bug: the crash-recovery unknown used to raise a UI alert; active sends only project pending and must not rewrite recovery records.
    project: (result: BotGroupDelivery): BotGroupDelivery =>
      inFlight.has(result.id) ? { ...result, status: "pending" } : result,
  });
}
