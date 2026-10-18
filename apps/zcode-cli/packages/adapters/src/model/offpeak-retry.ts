/* Adapter-level special casing for the off-peak task queueing protocol.
   Applies only to requests whose Model Config declares the off-peak-queue protocol: business codes 3105/3102
   may mean other things elsewhere in the bigmodel API, so keep them out of the global failure-provider-business-codes map.

   - 429 (business code 3105) = queued reply: wait min(Retry-After, 5min) per probe, unbounded idempotent probing;
     callers freeze the attempt budget (else the default 11 tries misread as API failure); abort spans the sleep.
   - 400/3102 = ticket unusable (active 3h expiry / ready voided): fail immediately with the stable flag;
     desktop sees the flag and switches to same-task_id re-ticket then resume, not a plain failure.
   - First-dispatch abandonment is not implemented here: if the first dispatch hangs the gateway, ready 5min TTL expiry
     triggers 3102 and requeue; wait bound = TTL + one clamped probe, under 10min, matching the rule with less state. */
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import { isProviderBusinessError } from "./model-execution.js";

/**
 * Keep cross-package value parity with @zcode/shared/src/off-peak-types.ts (wire contract):
 * providerId is injected per-turn via runtimeModel and the flag travels in task terminal error text; change both sides together.
 */
export const OFF_PEAK_TICKET_EXPIRED_MARKER = "off-peak-ticket-expired";

/** Single queued-wait clamp: min(Retry-After, 5min); conservative 60s probe without Retry-After. */
const OFF_PEAK_QUEUE_WAIT_CAP_MS = 5 * 60_000;
const OFF_PEAK_QUEUE_WAIT_DEFAULT_MS = 60_000;

type OffPeakFailureDecision = { kind: "queued"; delayMs: number } | { kind: "ticketExpired" };

/**
 * Detect off-peak-specific failure semantics; return null for non idle-plan providers (zero impact).
 * Pass the error after unwrapRetryError (only ProviderBusinessError exposes business codes).
 */
export function resolveOffPeakFailureDecision(params: {
  offPeak: boolean;
  failure: ClassifiedModelFailure;
  error: unknown;
}): OffPeakFailureDecision | null {
  if (!params.offPeak) return null;
  const businessCode = isProviderBusinessError(params.error)
    ? params.error.providerCode
    : undefined;
  // The current server contract uses 3102; 3001 stays for old gateways during rolling deploys.
  if (businessCode === "3102" || businessCode === "3001") {
    return { kind: "ticketExpired" };
  }
  // The real queue signal is HTTP 429 (3105 with Retry-After); a bare 429 without business codes queues too.
  if (businessCode === "3105" || params.failure.statusCode === 429) {
    return {
      kind: "queued",
      delayMs: Math.min(
        params.failure.retryAfterMs ?? OFF_PEAK_QUEUE_WAIT_DEFAULT_MS,
        OFF_PEAK_QUEUE_WAIT_CAP_MS,
      ),
    };
  }
  return null;
}

export function offPeakTicketExpiredMessage(original: string): string {
  return `${OFF_PEAK_TICKET_EXPIRED_MARKER}: ${original}`;
}
