// turn_complete handling: usage/cache stats plus result fallback.
//
// Together because they originate from the same event; also keeps app-events.ts's switch within max-lines.
import type React from "react";
import type { ModelUsageSummary } from "@zcode/contracts";
import type { CacheStats, Message } from "./app-model.js";
import { cacheStatsFromPayload, usageFromPayload } from "./app-event-data.js";
import { projectedTranscriptHasResponse } from "./app-transcript-stream.js";
import { stringField } from "./state.js";

/**
 * turn_complete carries the authoritative `response`; append it only when the transcript does not have the text yet.
 *
 * Why: notification-driven turns never run submitPrompt, hence no applyResult to append the result. Usually the
 * streaming events already painted the text, but turns with only tool calls -- or streams that died mid-error --
 * would leave nothing behind; this fallback is then the only source of the answer.
 *
 * Why no double write: the criterion is **content**, not ordering. `projectedTranscriptHasResponse` already guards
 * appendAgentResult, so whichever side appends first, the other sees the content present and skips -- same idea as
 * event-id dedup (idempotent by content/identity, no ordering bets).
 *
 * One premise of that symmetry: the guard only scans `streamProjected` messages, so the message appended here must
 * carry **`streamProjected: true` itself** -- otherwise, for a user turn whose stream died but whose turn_complete
 * carries a response, this fallback appends a plain message that applyResult's guard cannot see and appends again,
 * duplicating the answer. `transcriptText` falls back to `content` for partless messages, so no parts need synthesizing.
 */
export function applyTurnCompleteFallbackResponse(
  payload: Record<string, unknown>,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
): void {
  const response = stringField(payload, "response");
  if (!response || response.trim().length === 0) return;
  setMessages((current) =>
    projectedTranscriptHasResponse(current, response)
      ? current
      : [...current, { content: response, role: "agent", streamProjected: true }],
  );
}

export function applyTurnCompleteEvent(
  payload: Record<string, unknown>,
  setUsage: React.Dispatch<React.SetStateAction<ModelUsageSummary | undefined>>,
  setCacheStats: React.Dispatch<React.SetStateAction<CacheStats | undefined>>,
): void {
  const turnUsage = usageFromPayload(payload);
  if (turnUsage) setUsage(turnUsage);

  const cacheStats = cacheStatsFromPayload(payload);
  if (cacheStats) setCacheStats(cacheStats);
}
