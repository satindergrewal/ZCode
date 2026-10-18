// ============================================================
// Workflow concurrency governor (process-wide; bucketed by provider key; **per model request** admission)
// ============================================================
// Every run plus the main agent in one CLI process shares one provider quota, so the governor is
// **process-level**: one bucket per `${providerId}/${modelId}`, each holding a pure AIMD state
// machine (`ConcurrencyController`, @zcode/dynamic-workflow) plus a run-round-robin admission
// queue.
//
// Gate granularity: EVERY model-request attempt. acquire before each attempt, release at its end;
// no slot held during backoff sleeps. The ticket is that attempt's state-event sink: the runner feeds the attempt's
// ModelNetworkStatus events into the ticket too, and the governor reads the outcome from it. This design
// drops adapter-level addStatusSink: one event must not feed twice (ticket + adapter sink).
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
import {
  resolveWorkflowDefaultConcurrency,
  WORKFLOW_CONCURRENCY_AUTO_GROWTH_FACTOR,
} from "./workflow-default-concurrency.js";

/** Provider key: the most specific quota key. */
export function workflowConcurrencyKey(model: ModelRequestTarget): string {
  return `${String(model.providerId)}/${String(model.modelId)}`;
}

/**
 * The narrow port the driver sees (not the whole governor).
 *
 // * - tryAdmit: synchronous fast path -- ticket only when the gate is open AND nobody queues; else undefined, caller falls to
 // *   admit and reports waiting-for-slot. Skipping the fast path while others wait is fairness: a request-heavy
 *   run must not jump other runs queues via the fast path.
 *   admit: queue (round-robin across runs) until inFlight < cap and no Retry-After cooldown; aborted signal
 *   dequeues and rejects (reason signal.reason).
 *   subscribe: cap changes on any key this run touched; fan-out only to runs in-flight/queued on that key
 *   (decision 8).
 *   setRunBound/clearRunBound: this run own bound (launch-registered, retune-overwritten, cleared at settlement).
 *   It raises the growth cap of keys this run USED: max(2D, largest bound among them)
 *   (docs/dynamic-workflow/concurrency.md, The governor) -- a run tuned to 40 is the only way the bucket cap reaches 40,
 *   else most of 40 subagents stall waiting-for-slot.
 */
export interface WorkflowConcurrencyPort {
  tryAdmit(runId: string, key: string): ModelRequestAdmissionTicket | undefined;
  admit(runId: string, key: string, signal: AbortSignal): Promise<ModelRequestAdmissionTicket>;
  subscribe(runId: string, listener: (change: ConcurrencyChange) => void): () => void;
  setRunBound(runId: string, bound: number): void;
  clearRunBound(runId: string): void;
}

interface WorkflowConcurrencyGovernor extends WorkflowConcurrencyPort {
  /**
   * The main agent admission: acquire passes immediately (no queue, no cooldown) but counted inFlight
   * and signal-feeding (its providers equally visible). The main turn is never blocked by workflow traffic.
   */
  observer(): ModelRequestAdmission;
  /** Read-only controller snapshot; undefined when no bucket exists for the key. */
  snapshot(key: string): ConcurrencyControllerSnapshot | undefined;
}

interface WorkflowConcurrencyGovernorOptions {
  /** Default concurrency D: bucket seed and idle-reset target; auto-grows to 2 x D. Once per process. */
  defaultConcurrency: number;
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
  /**
   * Runs that requested admission on this key (observers aside). Growth caps see only their registered bounds: a big run
   * on another model must not raise this key; removed when the run clears its bound.
   */
  readonly runs: Set<string>;
  cancelCooldownWake?: () => void;
}

/** The observer's (main agent's) run identity: never queues or subscribes; appears in fan-out filtering as the no-run sentinel. */
const OBSERVER_RUN_ID = "\0observer";

const defaultSchedule = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  // Never let a cooldown timer pin the process: after run end or at exit it gets no vote.
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearTimeout(timer);
};

export function createWorkflowConcurrencyGovernor(
  options: WorkflowConcurrencyGovernorOptions,
): WorkflowConcurrencyGovernor {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const buckets = new Map<string, Bucket>();
  /** Run-level subscriptions (not per key): fan-out filters by the bucket's engaged set. */
  const listeners = new Map<string, Set<(change: ConcurrencyChange) => void>>();
  const baseGrowthLimit = WORKFLOW_CONCURRENCY_AUTO_GROWTH_FACTOR * options.defaultConcurrency;
  /** Bounds registered by in-flight runs (setRunBound/clearRunBound). */
  const runBounds = new Map<string, number>();

  const bucketFor = (key: string): Bucket => {
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      // Lazy bucket, seed = default; run churn never resets it (5-min idle only, decisions 19/20).
      bucket = {
        key,
        controller: new ConcurrencyController(key, options.defaultConcurrency, baseGrowthLimit),
        inFlightByRun: new Map(),
        queues: new Map(),
        runs: new Set(),
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

  /**
   * Fan-out: only runs in-flight/queued on this key now (decision 8); alsoTo adds bound-change
   * recipients (runs registered on the key -- see refreshGrowthLimit).
   */
  const fanOut = (
    bucket: Bucket,
    changes: ConcurrencyChange[],
    alsoTo?: ReadonlySet<string>,
  ): void => {
    if (changes.length === 0) return;
    for (const [runId, set] of listeners) {
      const engaged =
        (bucket.inFlightByRun.get(runId) ?? 0) > 0 ||
        (bucket.queues.get(runId)?.length ?? 0) > 0 ||
        alsoTo?.has(runId) === true;
      if (!engaged) continue;
      for (const change of changes) {
        for (const listener of set) listener(change);
      }
    }
  };

  /**
   * Recompute a bucket growth cap: max(2D, largest bound among users), and TRY to jump to that
   * largest bound (docs/dynamic-workflow/concurrency.md, Seeding): a run tuned to 32 makes cap 32 on the spot,
   * not a step per four successes. Below-cap squeezes lower it at once (limit_lowered); a jump refused within
   * five minutes is controller-refused (no seeded); the cap keeps climbing.
   *
   * Both changes originate from a RUN bound, not a request: fan out beyond engaged runs to every
   * run registered on the key -- at retune the raised run may have zero requests in flight.
   */
  const refreshGrowthLimit = (bucket: Bucket): void => {
    let largestBound: number | undefined;
    for (const runId of bucket.runs) {
      const bound = runBounds.get(runId);
      if (bound !== undefined && (largestBound === undefined || bound > largestBound)) {
        largestBound = bound;
      }
    }
    const limit = Math.max(baseGrowthLimit, largestBound ?? 0);
    const changes =
      limit === bucket.controller.snapshot().growthLimit
        ? []
        : bucket.controller.setGrowthLimit(now(), limit);
    if (largestBound !== undefined) changes.push(...bucket.controller.seed(now(), largestBound));
    fanOut(bucket, changes, bucket.runs);
  };

  /** First admission request by a run on this key: recorded; its bounds count into the bucket. */
  const noteRunUsed = (bucket: Bucket, runId: string): void => {
    if (bucket.runs.has(runId)) return;
    bucket.runs.add(runId);
    if (runBounds.has(runId)) refreshGrowthLimit(bucket);
  };

  const bumpInFlight = (bucket: Bucket, runId: string, delta: number): void => {
    const next = (bucket.inFlightByRun.get(runId) ?? 0) + delta;
    if (next <= 0) bucket.inFlightByRun.delete(runId);
    else bucket.inFlightByRun.set(runId, next);
  };

  /**
   * A ticket for an admitted attempt; the event mapping stays consistent. Settles on any terminal mapping (idempotent); release()
   * without a terminal event counts as ended. Post-settlement publish/release stay lazy: on rare paths the runner
   * (post-attempt backstop events) may still deliver.
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
      // Fan out BEFORE decrementing in-flight: the request causing this is this run and still engaged, else a halving from the run only
      // in-flight request would skip that very run as no-longer-in-flight.
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
            // Non-retryable rate limiting:
            // a main-line/tool 429 like 3008, terminal per the classifier, is still literally a concurrency signal;
            // chain-end treatment would leave cap never lowered by it. Quota codes too: one extra halving, run stops, harmless.
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
    noteRunUsed(bucket, runId);
    fanOut(bucket, bucket.controller.observe(now()));
    if (waiterCount(bucket) > 0 || !bucket.controller.canAdmit(now())) return undefined;
    return grant(bucket, runId);
  };

  const admit: WorkflowConcurrencyPort["admit"] = (runId, key, signal) => {
    const bucket = bucketFor(key);
    if (signal.aborted) return Promise.reject(abortedError(signal));
    noteRunUsed(bucket, runId);
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

  const setRunBound: WorkflowConcurrencyPort["setRunBound"] = (runId, bound) => {
    runBounds.set(runId, bound);
    for (const bucket of buckets.values()) {
      if (bucket.runs.has(runId)) refreshGrowthLimit(bucket);
    }
  };

  const clearRunBound: WorkflowConcurrencyPort["clearRunBound"] = (runId) => {
    runBounds.delete(runId);
    for (const bucket of buckets.values()) {
      if (bucket.runs.delete(runId)) refreshGrowthLimit(bucket);
    }
  };

  // No queue, no cooldown (decisions 37/47); observe inside grant. Fast path always hits, so the runner never emits
  // queued/admitted for main-agent requests (decision 44).
  const observerAdmission: ModelRequestAdmission = {
    tryAcquire: ({ model }) => grant(bucketFor(workflowConcurrencyKey(model)), OBSERVER_RUN_ID),
    acquire: ({ model }) =>
      Promise.resolve(grant(bucketFor(workflowConcurrencyKey(model)), OBSERVER_RUN_ID)),
  };

  return {
    tryAdmit,
    admit,
    subscribe,
    setRunBound,
    clearRunBound,
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
 * Process-level singleton (decision 5): default concurrency computed on first use; each app main runtime hooks its
 * main runtime attaches its observer, and the run service hands the same port to the driver.
 */
export function getWorkflowConcurrencyGovernor(): WorkflowConcurrencyGovernor {
  processGovernor ??= createWorkflowConcurrencyGovernor({
    defaultConcurrency: resolveWorkflowDefaultConcurrency(),
  });
  return processGovernor;
}
