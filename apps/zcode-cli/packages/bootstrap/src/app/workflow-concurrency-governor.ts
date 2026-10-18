// ============================================================
// Workflow concurrency governor (process-wide; bucketed by provider key; **per model request** admission)
// ============================================================
// Every run plus the main agent in one CLI process shares one provider quota, so the governor is
// **process-level**: one bucket per `${providerId}/${modelId}`, each holding a pure AIMD state
// machine (`ConcurrencyController`, @zcode/dynamic-workflow) plus a run-round-robin admission
// queue.
//
// Gate granularity is **every model-request attempt**: the runner `acquire`s before each attempt
// and `release`s at the end, holding no slot during backoff sleeps. The ticket is the sink for
// that attempt's status events: the runner feeds the attempt's `ModelNetworkStatus` events to the
// ticket as well, and the governor reads the outcome from it. Adapter-level `addStatusSink` is
// **no longer** used - an event must not be fed once via the ticket and once via the adapter sink.
//
// This is the **only** place in the governor that touches clocks and timers: the controller only
// takes `now`; cooldown expiry must wake waiters, hence a setTimeout (injectable, unref'd).

import type {
  ModelNetworkStatusEvent,
  ModelRequestAdmission,
  ModelRequestAdmissionTicket,
  ModelRequestTarget,
} from "@zcode/contracts";
import {
  ConcurrencyController,
  type ConcurrencyChange,
  type ConcurrencyControllerSnapshot,
  type ConcurrencyThrottleReason,
} from "@zcode/dynamic-workflow";
import { resolveWorkflowConcurrencyCeiling } from "./workflow-concurrency-ceiling.js";

/** Provider key: the most specific quota key. */
export function workflowConcurrencyKey(model: ModelRequestTarget): string {
  return `${String(model.providerId)}/${String(model.modelId)}`;
}

/**
 * The narrow port the driver sees (not the whole governor).
 *
 * - `tryAdmit`: synchronous fast path - a ticket only while the gate is open **and nobody is
 *   queued**; else undefined, and the caller falls back to `admit` reporting "waiting for a slot".
 *   Skipping the fast path while waiters exist is fairness: otherwise a request-heavy run would
 *   jump other runs' queues via the fast path.
 * - `admit`: queue (round-robin across runs) until `inFlight < cap` and no Retry-After cooldown;
 *   aborting `signal` dequeues and rejects (with `signal.reason`).
 * - `subscribe`: cap changes on any key this run touches. Fan-out reaches only runs **currently
 *   having in-flight or queued requests on that key**.
 */
export interface WorkflowConcurrencyPort {
  tryAdmit(runId: string, key: string): ModelRequestAdmissionTicket | undefined;
  admit(runId: string, key: string, signal: AbortSignal): Promise<ModelRequestAdmissionTicket>;
  subscribe(runId: string, listener: (change: ConcurrencyChange) => void): () => void;
}

interface WorkflowConcurrencyGovernor extends WorkflowConcurrencyPort {
  /**
   * Admission for the main agent: acquire grants immediately - no queueing, no cooldown check -
   * but still **counts toward inFlight** and feeds signals (the provider sees its requests too).
   * The main agent's turn is never blocked by workflow traffic.
   */
  observer(): ModelRequestAdmission;
  /** Read-only controller snapshot; undefined when no bucket exists for the key. */
  snapshot(key: string): ConcurrencyControllerSnapshot | undefined;
}

interface WorkflowConcurrencyGovernorOptions {
  /** Ceiling: initial value and upper bound at bucket creation; computed once at process start. */
  ceiling: number;
  /** Clock (injectable). */
  now?: () => number;
  /** Timer (injectable): wakes waiters at cooldown expiry. Returns a cancel function. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

/** Throttle-class retry reasons -> the controller's throttled signal. */
const THROTTLE_REASONS: ReadonlySet<string> = new Set<ConcurrencyThrottleReason>([
  "rate_limited",
  "provider_overloaded",
  "offpeak_queued",
]);
/** Retry reasons that are not provider failures: neither lower the cap nor clear the streak - just end the attempt. */
const NON_FAILURE_RETRY_REASONS: ReadonlySet<string> = new Set([
  "reasoning_signature_repair",
  "auth_refresh",
]);

interface Waiter {
  runId: string;
  resolve: (ticket: ModelRequestAdmissionTicket) => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

interface Bucket {
  readonly key: string;
  readonly controller: ConcurrencyController;
  /** In-flight (admitted, unsettled) request count per run (fan-out basis: only runs with in-flight or queued requests hear cap changes). */
  readonly inFlightByRun: Map<string, number>;
  /** Waiters queued per run (round-robin across runs; a large fan-out must not starve later small runs). */
  readonly queues: Map<string, Waiter[]>;
  /** Rotation cursor: the last granted run; the next search starts after it. */
  lastGrantedRun?: string;
  cancelCooldownWake?: () => void;
}

/** The observer's (main agent's) run identity: never queues or subscribes; appears in fan-out filtering as the no-run sentinel. */
const OBSERVER_RUN_ID = "\0observer";

const defaultSchedule = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  // Do not let a cooldown timer pin the process: once runs are done and the process wants to
  // exit, it should get no vote.
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearTimeout(timer);
};

function createWorkflowConcurrencyGovernor(
  options: WorkflowConcurrencyGovernorOptions,
): WorkflowConcurrencyGovernor {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const buckets = new Map<string, Bucket>();
  /** Run-level subscriptions (not per key): fan-out filters by the bucket's engaged set. */
  const listeners = new Map<string, Set<(change: ConcurrencyChange) => void>>();

  const bucketFor = (key: string): Bucket => {
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      // Lazy bucket creation, initial value = ceiling; never reset afterwards by runs coming and
      // going (only the 5-minute idle reset does).
      bucket = {
        key,
        controller: new ConcurrencyController(key, options.ceiling),
        inFlightByRun: new Map(),
        queues: new Map(),
      };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  const waiterCount = (bucket: Bucket): number => {
    let total = 0;
    for (const queue of bucket.queues.values()) total += queue.length;
    return total;
  };

  /** Fan-out: only to runs currently holding in-flight or queued requests on this key. */
  const fanOut = (bucket: Bucket, changes: ConcurrencyChange[]): void => {
    if (changes.length === 0) return;
    for (const [runId, set] of listeners) {
      const engaged =
        (bucket.inFlightByRun.get(runId) ?? 0) > 0 || (bucket.queues.get(runId)?.length ?? 0) > 0;
      if (!engaged) continue;
      for (const change of changes) {
        for (const listener of set) listener(change);
      }
    }
  };

  const bumpInFlight = (bucket: Bucket, runId: string, delta: number): void => {
    const next = (bucket.inFlightByRun.get(runId) ?? 0) + delta;
    if (next <= 0) bucket.inFlightByRun.delete(runId);
    else bucket.inFlightByRun.set(runId, next);
  };

  /**
   * Ticket for one admitted attempt; the event mapping stays consistent. Settles (idempotently)
   * on any terminal mapping; `release()` without a terminal event counts as `ended`. Post-settle
   * publish / release are lazy no-ops - the runner may still deliver on rare paths (fallback
   * events after the attempt already ended).
   */
  const mintTicket = (
    bucket: Bucket,
    runId: string,
    epoch: number,
  ): ModelRequestAdmissionTicket => {
    let settled = false;
    const settle = (signal: (at: number) => ConcurrencyChange[]): void => {
      if (settled) return;
      settled = true;
      const changes = signal(now());
      // Fan out before decrementing in-flight: the request that produced this change belongs to
      // this very run and still counts as engaged - otherwise a halving triggered by a run's only
      // in-flight request would be withheld from that run as "no longer in flight".
      fanOut(bucket, changes);
      bumpInFlight(bucket, runId, -1);
      // The settle freed a slot (or changed the cap); queued waiters may be grantable now.
      drain(bucket);
    };
    return {
      publish(event: ModelNetworkStatusEvent) {
        if (settled) return;
        switch (event.type) {
          case "model_request_started":
            // Already counted toward inFlight at admission; no new information here.
            return;
          case "model_request_completed":
            settle((at) => bucket.controller.succeeded(at, epoch));
            return;
          case "model_retry_scheduled": {
            const reason: string = event.reason;
            if (NON_FAILURE_RETRY_REASONS.has(reason)) {
              settle((at) => bucket.controller.ended(at));
              return;
            }
            if (THROTTLE_REASONS.has(reason)) {
              settle((at) =>
                bucket.controller.throttled(
                  at,
                  epoch,
                  reason as ConcurrencyThrottleReason,
                  event.retryAfterMs,
                ),
              );
              return;
            }
            settle((at) => bucket.controller.failedTransient(at));
            return;
          }
          case "model_request_failed":
            // A retryable:true failed is followed by a retry_scheduled - that one is the signal.
            if (event.retryable) return;
            // Non-retryable throttling:
            // The main conversation / tool side hitting a 3008-style 429 the classifier calls
            // terminal is still a concurrency signal in the literal sense - counting it as mere
            // "chain ended" would leave the cap never lowered by it. Quota codes take this branch
            // too: one extra half-step reduction, the run stops right away, harmless.
            if (event.reason === "rate_limited") {
              settle((at) =>
                bucket.controller.throttled(at, epoch, "rate_limited", event.retryAfterMs),
              );
              return;
            }
            settle((at) => bucket.controller.ended(at));
            return;
          default:
            return;
        }
      },
      release() {
        settle((at) => bucket.controller.ended(at));
      },
    };
  };

  /** Grant one request: `observe` first (admission is a signal too), then `admitted` for the epoch. */
  const grant = (bucket: Bucket, runId: string): ModelRequestAdmissionTicket => {
    fanOut(bucket, bucket.controller.observe(now()));
    const epoch = bucket.controller.admitted(now());
    bumpInFlight(bucket, runId, 1);
    bucket.lastGrantedRun = runId;
    return mintTicket(bucket, runId, epoch);
  };

  /** Pick the next run with waiters, round-robin. */
  const nextRunWithWaiters = (bucket: Bucket): string | undefined => {
    const runs = [...bucket.queues.keys()].filter(
      (runId) => (bucket.queues.get(runId)?.length ?? 0) > 0,
    );
    if (runs.length === 0) return undefined;
    const last = bucket.lastGrantedRun;
    const lastIndex = last === undefined ? -1 : runs.indexOf(last);
    return runs[(lastIndex + 1) % runs.length];
  };

  const armCooldownWake = (bucket: Bucket): void => {
    bucket.cancelCooldownWake?.();
    bucket.cancelCooldownWake = undefined;
    if (waiterCount(bucket) === 0) return;
    const until = bucket.controller.snapshot().cooldownUntil;
    if (until === undefined) return;
    const delay = Math.max(0, until - now());
    bucket.cancelCooldownWake = schedule(() => {
      bucket.cancelCooldownWake = undefined;
      drain(bucket);
    }, delay);
  };

  /** Grant as many waiters as possible (gate: inFlight < cap and no cooldown), feed waiters, arm the cooldown alarm when needed. */
  const drain = (bucket: Bucket): void => {
    fanOut(bucket, bucket.controller.observe(now()));
    for (;;) {
      fanOut(bucket, bucket.controller.waiters(now(), waiterCount(bucket)));
      if (!bucket.controller.canAdmit(now())) break;
      const runId = nextRunWithWaiters(bucket);
      if (runId === undefined) break;
      const queue = bucket.queues.get(runId)!;
      const waiter = queue.shift()!;
      if (queue.length === 0) bucket.queues.delete(runId);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(grant(bucket, runId));
    }
    fanOut(bucket, bucket.controller.waiters(now(), waiterCount(bucket)));
    armCooldownWake(bucket);
  };

  const tryAdmit: WorkflowConcurrencyPort["tryAdmit"] = (runId, key) => {
    const bucket = bucketFor(key);
    fanOut(bucket, bucket.controller.observe(now()));
    if (waiterCount(bucket) > 0 || !bucket.controller.canAdmit(now())) return undefined;
    return grant(bucket, runId);
  };

  const admit: WorkflowConcurrencyPort["admit"] = (runId, key, signal) => {
    const bucket = bucketFor(key);
    if (signal.aborted) return Promise.reject(abortedError(signal));
    return new Promise<ModelRequestAdmissionTicket>((resolve, reject) => {
      const waiter: Waiter = { runId, resolve, reject, signal, onAbort: () => {} };
      waiter.onAbort = () => {
        const queue = bucket.queues.get(runId);
        if (queue !== undefined) {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          if (queue.length === 0) bucket.queues.delete(runId);
        }
        reject(abortedError(signal));
        fanOut(bucket, bucket.controller.waiters(now(), waiterCount(bucket)));
        armCooldownWake(bucket);
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      const queue = bucket.queues.get(runId) ?? [];
      queue.push(waiter);
      bucket.queues.set(runId, queue);
      drain(bucket);
    });
  };

  const subscribe: WorkflowConcurrencyPort["subscribe"] = (runId, listener) => {
    const set = listeners.get(runId) ?? new Set();
    set.add(listener);
    listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) listeners.delete(runId);
    };
  };

  // No queueing, no cooldown check; observe happens inside grant. The fast path always hits, so
  // the runner never emits queued / admitted for main-agent requests.
  const observerAdmission: ModelRequestAdmission = {
    tryAcquire: ({ model }) => grant(bucketFor(workflowConcurrencyKey(model)), OBSERVER_RUN_ID),
    acquire: ({ model }) =>
      Promise.resolve(grant(bucketFor(workflowConcurrencyKey(model)), OBSERVER_RUN_ID)),
  };

  return {
    tryAdmit,
    admit,
    subscribe,
    observer: () => observerAdmission,
    snapshot(key) {
      return buckets.get(key)?.controller.snapshot();
    },
  };
}

function abortedError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new Error("workflow request admission aborted");
}

let processGovernor: WorkflowConcurrencyGovernor | undefined;

/**
 * Process-wide singleton: the ceiling is computed on first use; afterwards each app's (session's)
 * main runtime attaches its observer, and the run service hands the same port to the driver.
 */
export function getWorkflowConcurrencyGovernor(): WorkflowConcurrencyGovernor {
  processGovernor ??= createWorkflowConcurrencyGovernor({
    ceiling: resolveWorkflowConcurrencyCeiling(),
  });
  return processGovernor;
}
