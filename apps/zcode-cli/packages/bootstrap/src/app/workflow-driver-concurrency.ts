// ============================================================
// Driver-side adaptive concurrency half: per-actor admission + model-status observation + failure attribution
// ============================================================
// Split from workflow-driver.ts
// which owns session-and-turn orchestration; none of these three touch turn orchestration - they only wrap the governor port into
// one actor's `ModelRequestAdmission`, read the actor runtime's session event stream, and watch run-level success/retry cadence
// (the stall clock). Model failure attribution (the old modelFailureReasonOf)
// moved to the adapters policy table (`inspectWorkflowModelFailure`): runner and driver read the same one.

import {
  SessionEventType,
  type ModelNetworkStatusEvent,
  type ModelRequestAdmission,
  type SessionEvent,
  type SessionId,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import type {
  AskLastTool,
  AskProgress,
  AskWaitInfo,
  InstanceRef,
  RunStallInfo,
} from "@zcode/dynamic-workflow";
import { createActorToolActivity, type ActorToolCounts } from "./workflow-driver-tool-activity.js";
import {
  workflowConcurrencyKey,
  type WorkflowConcurrencyPort,
} from "./workflow-concurrency-governor.js";
import type { WorkflowRunSeatGate } from "./workflow-seat-gate.js";

/** Same discipline as the governor: these two retries are not provider failures, no badge deserved. */
const NON_FAILURE_RETRY_REASONS: ReadonlySet<string> = new Set([
  "reasoning_signature_repair",
  "auth_refresh",
]);

interface ActorModelActivityHandlers {
  /** The ask's next model request is waiting: for a slot (`cause: "slot"`) or in backoff (`cause: "backoff"`). */
  onWaiting(info: AskWaitInfo): void;
  /** The ask's model request actually went out (first attempt, or the one after a wait). */
  onExecuting(): void;
  /** Any model request of this actor (turn or tool side) completed - the run-level stall clock's reset signal. */
  onRequestCompleted?(): void;
  /** The runner scheduled a retry (signature repair / auth refresh excepted) - the run-level stall clock's arm signal. */
  onRetryScheduled?(reason: string): void;
  /**
   * A subagent of an in-flight ask is about to run a workspace-mutating tool (at most once per ask; instance resolved
   * by this module from `live`; not in flight, not reported). The engine closes the amend-resume import cache on it.
   */
  onMutating?(instance: InstanceRef): void;
}

/**
 * One actor's **observation surface**: its runtime `ModelRequestAdmission` (admission), the model status in its session
 * event stream (source of the executing / waiting badges), and the tool calls on the same stream (first workspace write ->
 * close the import cache, plus this ask's tool counts, see workflow-driver-tool-activity.ts). All three share the per-ask
 * lifecycle, so the driver holds one object and observes / resets / unsubscribes once; the
 * `model_request_started` after a slot wait is thus recognized as the resume.
 */
export interface ActorModelActivity {
  /** Admission port handed to runtime deps; undefined when the governor port is absent (ungated). */
  readonly admission: ModelRequestAdmission | undefined;
  /** Zeroed on ask change: the previous ask's waiting / executing phases and tool counts never leak into the next. */
  reset(): void;
  /** Tool-call counts observed for this ask so far (fed to AskStats). */
  toolCounts(): ActorToolCounts;
  /** Most recent tool call started for this ask (the `node-progress` lastTool). */
  lastTool(): AskLastTool | undefined;
  /**
   * Records yet another resolved turn and returns the ask progress at this moment (`turn` starts at 1).
   * The counter lives here, not on SessionState, because it shares the per-ask lifecycle with tool counts:
   * same reset to zero, accumulated within one ask, a nudge-started round counts as the second turn.
   */
  noteTurnResolved(): AskProgress;
  /** Subscribes to the runtime session events (model status + tool calls); no-op on minimal stub runtimes without subscribeEvents. */
  observe(runtime: AgentRuntime, sessionId: SessionId): void;
  unsubscribe(): void;
}

/**
 * One request chain's phase. Chain = "one logical request plus all its retries", keyed by (querySource, queryId, toolCallId) —
 // the turn step has queryId without toolCallId, parallel WebSearches each carry their own toolCallId, compact/title sidecars
 // their own querySource — retries change requestId but not the key, so a backing off chain and its next attempt are one chain.
 */
type ChainPhase = "queued" | "executing" | "backoff";

interface Chain {
  phase: ChainPhase;
  /** Most recent waiting detail (queued / backoff); if only waiters remain at chain end, report waiting with the latest. */
  wait?: AskWaitInfo;
  waitSeq: number;
}

/**
 * Aggregation (replacing the single phase): the driver keeps the set of in-flight request chains per actor -
 *   - `model_request_queued` (a missed `tryAcquire`) -> chain queued;
 *   - `model_request_admitted` / `model_request_started` -> chain executing;
 *   - `model_retry_scheduled` (except reasoning_signature_repair / auth_refresh) -> chain backoff;
 *   - `model_request_completed` / non-retryable `model_request_failed` -> chain ends (leaves the set).
 * Subagent phase: any chain executing -> executing; else any chain waiting -> waiting (with the latest waiting detail);
 * empty set -> keep the previous phase, no event (while tools run inside an ask without queueing, the subagent still
 * shows executing). One subagent can hold several tickets (parallel tool calls), so a single phase no longer works.
 *
 * This is a driver-**internal** observation subscription, not a transcript live channel: the v4 gateway only drains
 * consecutive seqs, so transcript live must go through the child runtime's construction-time eventSink (pinned by run
 * service tests); here only model network status is read, and a missed seq 1 does not matter.
 */
export function createActorModelActivity(input: {
  port: WorkflowConcurrencyPort | undefined;
  runId: string;
  /** Instance of the in-flight ask (undefined once settled/cancelled); only tool-activity reporting needs it. */
  live?: () => InstanceRef | undefined;
  handlers: ActorModelActivityHandlers;
  /**
   * This run's seat gate and this subagent's key in it (docs/dynamic-workflow/concurrency.md
   // "Retuning a live run"). When present, the admission port wraps one more layer: seat first, then governor. Absent, the run's
   // bound never changes mid-flight (snippet execution, gate-less assembly) and the admission port stays byte-identical.
   */
  seat?: { gate: WorkflowRunSeatGate; key: string };
}): ActorModelActivity {
  const chains = new Map<string, Chain>();
  let executing = false;
  /** Last reported waiting detail; cleared as soon as executing is reported. Identical waits within one stint report once. */
  let reportedWait: AskWaitInfo | undefined;
  /** Turns resolved within this ask (the `node-progress` turn); reset on ask change. */
  let turnsResolved = 0;
  let waitSeq = 0;
  let unsubscribeEvents: (() => void) | undefined;
  const { handlers, live, port, runId, seat } = input;
  // Second reader of the same session event stream: tool calls. Implemented in its own file (detection and counting
  // live there); here it is only wired into the same lifecycle, so the driver side keeps a single observation object.
  const toolActivity = createActorToolActivity({
    onMutating: () => {
      const instance = live?.();
      if (instance !== undefined) handlers.onMutating?.(instance);
    },
  });

  const anyExecuting = (): boolean => {
    for (const chain of chains.values()) if (chain.phase === "executing") return true;
    return false;
  };
  /**
   * Still waiting after aggregation: report waiting once (one per waiting segment).
   // One subagent firing 4 parallel WebSearches queues 4 chains in the same millisecond -> four queued events each reporting
   // `waiting(slot)` — measured: 26 of 80 wait records were such same-second duplicates. The subagent phase did not change,
   // so the event must not repeat: drop when field-identical to the last reported wait; re-report only after returning to executing and waiting again.
   */
  const reportWaiting = (info: AskWaitInfo): void => {
    if (anyExecuting()) return;
    executing = false;
    if (reportedWait !== undefined && sameWait(reportedWait, info)) return;
    reportedWait = info;
    handlers.onWaiting(info);
  };
  const reportExecuting = (): void => {
    reportedWait = undefined;
    if (executing) return;
    executing = true;
    handlers.onExecuting();
  };
  const setWaiting = (key: string, phase: "queued" | "backoff", wait: AskWaitInfo): void => {
    waitSeq += 1;
    chains.set(key, { phase, wait, waitSeq });
    reportWaiting(wait);
  };
  /** A chain ended: with no chain executing but some waiting, only now is the subagent truly waiting - report the latest detail. */
  const endChain = (key: string): void => {
    if (!chains.delete(key) || anyExecuting()) return;
    let latest: Chain | undefined;
    for (const chain of chains.values()) {
      if (chain.wait !== undefined && (latest === undefined || chain.waitSeq > latest.waitSeq))
        latest = chain;
    }
    if (latest?.wait !== undefined) reportWaiting(latest.wait);
  };

  // The admission port is a narrow wrapper over the governor port: fast path = tryAdmit, queue = admit (waiting(slot)
  // is reported by the runner's queued event; no duplicate here). acquire still tries the fast path first, for callers
  const governed: ModelRequestAdmission | undefined =
    port === undefined
      ? undefined
      : {
          tryAcquire: ({ model }) => port.tryAdmit(runId, workflowConcurrencyKey(model)),
          acquire: async ({ model, signal }) => {
            const key = workflowConcurrencyKey(model);
            return (
              port.tryAdmit(runId, key) ??
              (await port.admit(runId, key, signal ?? new AbortController().signal))
            );
          },
        };
  // The run's own bound wraps one more layer **above the shared cap** (division of the two bounds:
  // docs/dynamic-workflow/concurrency.md "Two bounds on a run"). The seat gate's needed subagent fact —
  // whether a tool is running right now - comes from the tool-observation surface of the same object, so both readers
  const admission =
    seat === undefined
      ? governed
      : seat.gate.wrap(seat.key, { toolsInFlight: () => toolActivity.inFlight() }, governed);

  return {
    admission,
    reset: () => {
      chains.clear();
      executing = false;
      reportedWait = undefined;
      turnsResolved = 0;
      toolActivity.reset();
    },
    toolCounts: () => toolActivity.counts(),
    lastTool: () => toolActivity.lastTool(),
    noteTurnResolved: () => {
      turnsResolved++;
      const lastTool = toolActivity.lastTool();
      return {
        turn: turnsResolved,
        toolCalls: toolActivity.counts().toolCalls,
        ...(lastTool === undefined ? {} : { lastTool }),
      };
    },
    observe: (runtime, sessionId) => {
      toolActivity.observe(runtime, sessionId);
      if (typeof (runtime as Partial<AgentRuntime>).subscribeEvents !== "function") return;
      unsubscribeEvents = runtime.subscribeEvents({
        onSessionEvent: (event: SessionEvent) => {
          if (event.type !== SessionEventType.ModelNetworkStatus || event.sessionId !== sessionId)
            return;
          const status = event.payload as ModelNetworkStatusEvent;
          const key = chainKey(status);
          switch (status.type) {
            case "model_request_queued":
              setWaiting(key, "queued", { cause: "slot" });
              return;
            case "model_request_admitted":
            case "model_request_started":
              chains.set(key, { phase: "executing", waitSeq: chains.get(key)?.waitSeq ?? 0 });
              reportExecuting();
              return;
            case "model_retry_scheduled": {
              if (NON_FAILURE_RETRY_REASONS.has(status.reason)) return;
              handlers.onRetryScheduled?.(status.reason);
              setWaiting(key, "backoff", {
                cause: "backoff",
                reason: status.reason,
                attempt: status.nextAttempt,
                delayMs: status.delayMs,
                ...(status.retryAfterMs === undefined ? {} : { retryAfterMs: status.retryAfterMs }),
              });
              return;
            }
            case "model_request_completed":
              handlers.onRequestCompleted?.();
              endChain(key);
              return;
            case "model_request_failed":
              // A retryable:true failed is followed by a retry_scheduled - that one flips the phase.
              if (!status.retryable) endChain(key);
              return;
            default:
              return;
          }
        },
      });
    },
    unsubscribe: () => {
      toolActivity.unsubscribe();
      unsubscribeEvents?.();
      unsubscribeEvents = undefined;
    },
  };
}

function sameWait(a: AskWaitInfo, b: AskWaitInfo): boolean {
  return (
    a.cause === b.cause &&
    a.reason === b.reason &&
    a.attempt === b.attempt &&
    a.delayMs === b.delayMs &&
    a.retryAfterMs === b.retryAfterMs
  );
}

function chainKey(status: ModelNetworkStatusEvent): string {
  const parts = [status.querySource, status.queryId, status.toolCallId].map((part) =>
    part === undefined ? "" : String(part),
  );
  return parts.some((part) => part.length > 0) ? parts.join("|") : status.requestId;
}

// --------------------------------------- run-level stall clock ---------------------------------------

/** How long without one successful model request before notifying the main agent (dynamic-workflow docs/execution-engine.md "Terminal states"). */
export const WORKFLOW_STALL_NOTIFY_AFTER_MS = 20 * 60_000;

/** Clock and timers (injectable; fake time for tests). */
export interface WorkflowClock {
  now?: () => number;
  /** Returns a cancel function. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

interface RunStallClockOptions extends WorkflowClock {
  /** Defaults to {@link WORKFLOW_STALL_NOTIFY_AFTER_MS}. */
  afterMs?: number;
  onStalled: (info: RunStallInfo) => void;
}

/**
 * One run's stall observation: all actors (turn and tool-side requests as one) share a single table.
 *   - `noteSuccess`: any `model_request_completed` -> reset, clear the timer, clear reason counts; segment ends;
 *   - `noteRetryScheduled`: one `model_retry_scheduled` -> count the reason; if unarmed, set the timer at
 // "last success + afterMs";
 *   - timer fires: >= afterMs since last success and >= one retry scheduled this segment -> `onStalled` exactly once (one per
 // stall segment), re-armed only by the next success;
 *   - `noteCap`: governor-fanned cap changes — the notice reports the current cap (last fanned value; absent if never seen).
 // Pure observation, no decisions; run settlement `dispose` clears the timer.
 */
export interface RunStallClock {
  noteSuccess(): void;
  noteRetryScheduled(reason: string): void;
  noteCap(cap: number): void;
  dispose(): void;
}

export function createRunStallClock(options: RunStallClockOptions): RunStallClock {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const afterMs = options.afterMs ?? WORKFLOW_STALL_NOTIFY_AFTER_MS;
  let lastSuccessAt = now();
  let notified = false;
  let cancelTimer: (() => void) | undefined;
  let cap: number | undefined;
  const reasons = new Map<string, number>();
  let disposed = false;

  const dominantReason = (): string | undefined => {
    let best: string | undefined;
    let bestCount = 0;
    for (const [reason, count] of reasons) {
      if (count > bestCount) {
        best = reason;
        bestCount = count;
      }
    }
    return best;
  };
  const fire = (): void => {
    cancelTimer = undefined;
    if (disposed || notified) return;
    const sinceMs = now() - lastSuccessAt;
    if (sinceMs < afterMs) {
      // Clock drift / non-monotonic injected clock: wait again by the remainder instead of missing the stint.
      cancelTimer = schedule(fire, afterMs - sinceMs);
      return;
    }
    if (reasons.size === 0) return;
    notified = true;
    const reason = dominantReason();
    options.onStalled({
      sinceMs,
      ...(reason === undefined ? {} : { reason }),
      ...(cap === undefined ? {} : { cap }),
    });
  };

  return {
    noteSuccess: () => {
      if (disposed) return;
      lastSuccessAt = now();
      notified = false;
      reasons.clear();
      cancelTimer?.();
      cancelTimer = undefined;
    },
    noteRetryScheduled: (reason) => {
      if (disposed || notified) return;
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      if (cancelTimer !== undefined) return;
      cancelTimer = schedule(fire, Math.max(0, afterMs - (now() - lastSuccessAt)));
    },
    noteCap: (next) => {
      cap = next;
    },
    dispose: () => {
      disposed = true;
      cancelTimer?.();
      cancelTimer = undefined;
    },
  };
}

const defaultSchedule = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  // Do not let a stall timer pin the process: once runs are done and the process wants to exit, it should get no vote.
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearTimeout(timer);
};
