import type {
  ModelRequestAdmission,
  ModelRequestAdmissionTicket,
  ModelRequestTarget,
} from "@zcode/contracts";

/**
 * Admission for one attempt.
 *
 * The runner calls `admitAttempt` before issuing each attempt and sends only with a token; when the attempt ends (success, failure, throw, or consumer
 * abandons the stream) it calls `release`. No token is held during backoff sleep, so the process-level cap bounds the in-flight
 * requests the provider actually sees. The token is also the status-event sink of the attempt: `publishModelStatus` delivers the
 * attempt's events to it (see `statusPublishOptions`) and the governor reads the outcome there; `release` is only an idempotent fallback.
 *
 * Without `modelRequestAdmission` a no-op implementation is returned: call sites stay branch-free, runner behavior byte-identical.
 */
export interface AttemptAdmission {
  /** Admission token; absent when the request has no admission port (publish is not forwarded then). */
  readonly ticket?: ModelRequestAdmissionTicket;
  /** Returns the slot; idempotent (invoked from finally and before the backoff sleep). */
  release(): void;
}

const NO_ADMISSION: AttemptAdmission = { release() {} };

/**
 * Wait for admission. Try the sync fast path `tryAcquire` first; on miss queue via `acquire`, firing `onQueued`/`onAdmitted` at both ends
 * (the runner emits `model_request_queued`/`model_request_admitted` from these). Ports without a fast path cannot tell
 * queued from immediate admission, so they fire no callbacks. Rejects with `signal.reason` when `signal` aborts, same shape as
 * `sleep`'s abort error; callers classify it as cancelled.
 */
export async function admitAttempt(input: {
  admission?: ModelRequestAdmission;
  model: ModelRequestTarget;
  signal?: AbortSignal;
  onQueued?: () => Promise<void>;
  onAdmitted?: (queuedMs: number) => Promise<void>;
}): Promise<AttemptAdmission> {
  if (input.admission === undefined) return NO_ADMISSION;
  const hasFastPath = typeof input.admission.tryAcquire === "function";
  let ticket = hasFastPath ? input.admission.tryAcquire!({ model: input.model }) : undefined;
  if (ticket === undefined) {
    const queuedAt = Date.now();
    if (hasFastPath) await input.onQueued?.();
    ticket = await input.admission.acquire({
      model: input.model,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (hasFastPath) await input.onAdmitted?.(Date.now() - queuedAt);
  }
  let released = false;
  return {
    ticket,
    release() {
      if (released) return;
      released = true;
      ticket.release();
    },
  };
}
