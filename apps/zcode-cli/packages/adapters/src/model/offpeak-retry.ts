/* Adapter-level special casing for the off-peak task queueing protocol.
   Applies only to requests whose Model Config declares the off-peak-queue protocol: business codes 3105/3102
   may mean other things elsewhere in the bigmodel API, so keep them out of the global failure-provider-business-codes map.

   - 429 (business code 3105) = queued reply: wait min(Retry-After, 5min) per probe, unbounded idempotent probing;
     //     the caller freezes the attempt budget (else the default 11 reads as an API failure, D24 rule 2); abort runs through the sleep.
   - 400/3102 = ticket unusable (active 3h expiry / ready voided): fail immediately with the stable flag;
     //     desktop recognition switches to "re-draw by same task_id -> resume" (4.6), not a plain failure.
   //   - D24 rule 1 (drop first dispatch) is not implemented in the adapter: with the gateway hung, the 5min ready-TTL expiry handles it
     3102 -> requeue and resume; wait bound = TTL + one clamped probe <= 10min, honoring the rule's intent with one less state
     machine (the simplification is written back into tech-design 4.3). */
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import { isProviderBusinessError } from "./model-execution.js";

/**
 * Keep cross-package value parity with @zcode/shared/src/off-peak-types.ts (wire contract):
 * providerId is injected per-turn via runtimeModel and the flag travels in task terminal error text; change both sides together.
 */
export const OFF_PEAK_TICKET_EXPIRED_MARKER = "off-peak-ticket-expired";

/** Per-queue-wait clamp (D24 rule 2): min(Retry-After, 5min); without the header, a conservative 60s probe. */
export const OFF_PEAK_QUEUE_WAIT_CAP_MS = 5 * 60_000;
export const OFF_PEAK_QUEUE_WAIT_DEFAULT_MS = 60_000;

export type OffPeakFailureDecision =
  | { kind: "queued"; delayMs: number }
  | { kind: "ticketExpired" };

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
