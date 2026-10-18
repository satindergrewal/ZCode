import {
  aggregateHighspeedCardMetrics,
  listHighspeedTurnsByCard,
  listHighspeedTurnsBySession,
} from "@/highspeed/highspeedTurnStore.js";
import { isHighspeedShareEligible } from "@/highspeed/highspeedShare.js";

/**
 * Diagnostics: why this card is not yet an auto-share candidate; empty means ready.
 * Gates mirror turnStore.listHighspeedCardAutoShareCandidates; unit tests cross-assert no drift.
 * Debug-log only; no business decisions.
 */
export function collectHighspeedCardShareBlockers(cardId: string): string[] {
  const cardRecords = listHighspeedTurnsByCard(cardId);
  const blockers: string[] = [];
  if (cardRecords.length === 0) {
    return ["no-records"];
  }
  for (const record of cardRecords) {
    if (!record.metrics) {
      blockers.push(`turn-metrics-missing:${record.sourceCommandId}`);
      continue;
    }
    if (record.metrics.regularTps <= 0) {
      blockers.push(`turn-regular-tps-zero:${record.sourceCommandId}`);
    }
    if (record.metricsPersistedAt === undefined) {
      blockers.push(`turn-metrics-not-persisted:${record.sourceCommandId}`);
    }
    if (record.autoShareAttemptedAt !== undefined || record.autoSharedAt !== undefined) {
      blockers.push("auto-share-attempted");
    }
  }
  if (blockers.length === 0) {
    const metrics = aggregateHighspeedCardMetrics(cardId);
    if (metrics.outputTokens <= 0) {
      // Same rule as candidacy: no generated content, no share; token_usage is never coerced to 1.
      blockers.push("zero-output");
    } else if (!isHighspeedShareEligible(metrics)) {
      // Same rule as candidacy: overall <=1.2x publishes no bottom-left card (spec 9); named here for debug.
      blockers.push("below-min-speedup");
    }
  }
  return blockers;
}

/**
 * Diagnostics: cards expired in-session but never yet attempted auto-share.
 * Answers "why no bottom-left card update" in debug logs; no behavior change.
 */
export function listHighspeedCardsAwaitingAutoShare(sessionId: string, now: number): string[] {
  const pendingRecords = listHighspeedTurnsBySession(sessionId).filter(
    (record) => record.autoShareAttemptedAt === undefined && record.autoSharedAt === undefined,
  );
  const cardsById = new Map<string, typeof pendingRecords>();
  for (const record of pendingRecords) {
    const list = cardsById.get(record.card.cardId) ?? [];
    list.push(record);
    cardsById.set(record.card.cardId, list);
  }
  return [...cardsById.entries()]
    .filter(([, records]) => records.every((record) => record.card.expiresAt <= now))
    .map(([cardId]) => cardId);
}
