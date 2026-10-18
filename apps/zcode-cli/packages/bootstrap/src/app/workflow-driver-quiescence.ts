// AgentRuntime-backed WorkflowDriver: session release and quiescence on dispose.
// `dispose()` does not wait for still-running turns; on release it records those promises so amend can tell which sessions stopped writing.
//
// Engine settlement does not mean an aborted turn finished its final message persistence. Amend must wait for session quiet
// before reading the message count as `inFlight.messageBoundary`. Settled asks' boundaries are already in the journal, unaffected.
// Sessions whose wait times out do not import the unfinished part; successors re-run from the complete prefix -- a timeout is not quiet.
//
// Only the turn mainline is awaited; not all streaming tool parts are guaranteed persisted: some tool handles may have detached
// from the turn's promise. Transcript copy takes the parts visible at that moment; history restore treats pending/running tools as interrupted,
// missing parts generate no result-less tool_use, and empty assistant messages are skipped.
// Parts update by the same id without adding messages, so late parts never move the message boundary.

import type { WorkflowClock } from "./workflow-driver-concurrency.js";
import { defaultSchedule } from "./workflow-driver-helpers.js";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

/**
  * The upper bound for waiting out an aborted turn's tail writes.
 *
  * Rationale: it waits for an **already-aborted** turn to finish core's few awaited persistence
  * steps (abandon -> cancel snapshot -> assistant message) -- milliseconds of wind-down, not a model request. 5s amply covers
  * slow disks plus one retry, without visibly slowing "amend a live run"; overshooting only
  * costs one continuation, never a failure.
 */
export const AMEND_TRANSCRIPT_QUIESCE_MS = 5_000;

/** The quiescence-probe face for a run's actor sessions. A driver-private capability, never on Boundary B's `WorkflowDriver`. */
export interface ActorSessionQuiescence {
  /**
      * Session ids already quiet (no turn writing). Bounded wait, see {@link AMEND_TRANSCRIPT_QUIESCE_MS}.
   *
      * "Not in the set" has two causes, handled identically (no continuation): still writing at the deadline, or this
      * driver does not know the session at all -- the latter only occurs when the predecessor's generation never created one for that actor.
      * Read conservatively as not-quiet (cost: one lost continuation; the reverse is truncating a transcript with an unowned count).
   */
  quietSessions(): Promise<ReadonlySet<string>>;
}

/** The driver-side write face: {@link ActorSessionQuiescence} plus a dispose-time registration hook. */
export interface ActorSessionQuiescenceLedger extends ActorSessionQuiescence {
  /**
      * Registers a session with the turn wind-down chain (`SessionState.turn`) still in flight **right now**. No `pendingTurn`
      * means no in-flight turn: quiet at once.
   *
      * Called once per session by `dispose()`: the only moment that still sees every session and knows no new
      * turn will start (after dispose, `sessions` is cleared).
   */
  noteDisposed(sessionId: string, pendingTurn: Promise<unknown> | undefined): void;
}

/**
  * Builds the session-quiescence ledger. Purely in-memory, no I/O; the clock is injected.
 *
  * Ownership: exactly one per driver instance, living and dying with it. Deliberately **no** process-wide registry -- which run
  * a session belongs to is already stated by the driver's ownership; a second table only raises "who wins on disagreement".
 */
export function createActorSessionQuiescence(options?: {
  clock?: WorkflowClock;
    /** The default {@link AMEND_TRANSCRIPT_QUIESCE_MS}. */
  quiesceMs?: number;
}): ActorSessionQuiescenceLedger {
    /** sessionId -> the turn still in flight at dispose (`undefined` = none at the time). */
  const disposed = new Map<string, Promise<unknown> | undefined>();
  const schedule = options?.clock?.schedule ?? defaultSchedule;
  const quiesceMs = options?.quiesceMs ?? AMEND_TRANSCRIPT_QUIESCE_MS;

  return {
    noteDisposed(sessionId, pendingTurn) {
      disposed.set(sessionId, pendingTurn);
    },

    async quietSessions() {
      const quiet = new Set<string>();
      const waits: Promise<unknown>[] = [];
      for (const [sessionId, pending] of disposed) {
        if (pending === undefined) {
          quiet.add(sessionId);
          continue;
        }
                // The turn wind-down's outcome is irrelevant to quiet: resolve or reject, it writes this session no more.
        waits.push(
          pending.then(
            () => quiet.add(sessionId),
            () => quiet.add(sessionId),
          ),
        );
      }
      if (waits.length > 0) await settleWithin(Promise.all(waits), quiesceMs, schedule);
            // Snapshot before handing over: sessions landing after the deadline still write into `quiet`, and the caller must see
            // the facts "as of the question" -- a set that grows behind the caller's back is far more dangerous than a conservative one.
      return new Set(quiet);
    },
  };
}

/**
  * Per-session dispose release: unsubscribe activity observation, cancel backoff re-drives, **register quiescence**, then close once in-flight turns land.
 * actor runtime。
 *
  * Runs the same app-close chain per runtime as everywhere -- inside `closeBrowserSession`: beginShutdown,
  * node_repl session release, browser session close, in that order; never a second subagent-close chain, that would drift. Close failures only warn,
  * and settlement never throws because of them.
 *
  * Registration must precede `state.turn.then(...)`: right now `state.turn` IS the chain to wait for, and then
  * replaces it with another promise. The function returns synchronously (close hangs off then), so dispose stays non-blocking as always.
 */
export function releaseActorSessions(
  deps: AgentRuntimeWorkflowDriverDeps,
  sessions: Iterable<SessionState>,
  ledger: ActorSessionQuiescenceLedger,
): void {
  for (const state of sessions) {
    state.modelActivity.unsubscribe();
    state.cancelRedrive?.();
    state.cancelRedrive = undefined;
    ledger.noteDisposed(state.sessionId, state.turn);
    const close = (): void => closeActorRuntime(deps, state);
    if (state.turn === undefined) close();
    else state.turn.then(close, close);
  }
}

function closeActorRuntime(deps: AgentRuntimeWorkflowDriverDeps, state: SessionState): void {
    // Promise.resolve().then(...): route synchronous throws into the same warn path (the minimal stub runtime lacks the method).
  void Promise.resolve()
    .then(() => state.runtime.closeBrowserSession())
    .catch((error: unknown) => {
      deps.logger?.warn?.("Dynamic workflow actor runtime close failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "dynamic_workflow.actor_runtime.close_failed",
        module: "bootstrap.app",
        sessionId: state.sessionId,
      });
    });
}

/** Waits for `work` to settle, at most `delayMs`. Returns at the deadline (no throw); the timer is cleared on every branch. */
async function settleWithin(
  work: Promise<unknown>,
  delayMs: number,
  schedule: (callback: () => void, delayMs: number) => () => void,
): Promise<void> {
  let cancel: (() => void) | undefined;
  const deadline = new Promise<void>((resolve) => {
    cancel = schedule(resolve, delayMs);
  });
  try {
    await Promise.race([work, deadline]);
  } finally {
        // When work settles first, clear the timer: an un-rung setTimeout would hold CLI exit to the bound.
    cancel?.();
  }
}
