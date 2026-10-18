// ============================================================
// AgentRuntime-backed WorkflowDriver: session release at dispose and the quiet ledger.
// ============================================================
// Two concerns, one module: they are two faces of the same instant. dispose does NOT wait for in-flight turns -- the quiet ledger
// exists to record exactly that. The release orchestration ({@link releaseActorSessions}) registers whether turns are still
// writing into the ledger; no second observation point between the two.
//
// See apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md, Amend-resume:
// the What is imported and Tool contract and refusals rows.
//
// Why the ledger: to amend an IN-FLIGHT predecessor, amend aborts it, awaits its own settlement promise, then
// counts the predecessor session's messages, taking that as the continuation point (inFlight.messageBoundary). But
// dispose() is synchronous: for a session with an in-flight turn it only hangs state.turn.then(close, close),
// without waiting, and the engine settles immediately after cancelAsk. So "settlement resolved" does not imply
// the aborted turn finished its tail: the count at that instant may miss a message or catch a half-landed part.
// Completed prefixes are unaffected -- their boundary journaled at ask settlement.
//
// So at dispose the driver records each session's still-in-flight turns; amend later asks once
// which sessions have gone quiet, and negotiates continuation only for those.
//
// NOT a race masked by a timeout: a session still landing at the deadline is not treated as quiet; it merely gets no
// inFlight -- the pre-feature behavior (drop the in-flight transcript, restart the ask from the complete prefix). Rather lose
// one optimization than truncate a transcript with a moving count.
//
// ——————————————————————————————————————————————————————————————
// The one thing this gate cannot cover (verified 2026-09-19; accepted by decision)
// ——————————————————————————————————————————————————————————————
// core's turn mainline fully awaits: on abort it awaits abandon(cancelled)
// (core/src/runtime/methods/turn-model-step.ts:365), persistCancelledStreamSnapshot (:372)
// and persistAssistantMessage (:401), so this gate's turn-landed does imply those writes.
//
// What escapes: streaming-tool PARTS, two roads, both count-independent:
//   1. :633's throwIfTurnAborted runs OUTSIDE abandon's try/catch (drain() at :646), so an abort arriving
//      in the stream-end->drain window bypasses abandon and drops the in-flight streaming-tool handle;
//   2. abandon() itself waits only 250ms (streaming-tool-coordinator.ts:38, :121).
// Both let an already-persisted assistant message grow one more part AFTER this gate releases
// (:253 pending part, :294 running part). Unwaitable: those handles are detached from the awaited
// promise; nothing to await -- not a strictness question.
//
// Why acceptable: the COUNT happens at amend; the COPY at the successor's first dispatch
// (workflow-actor-transcript.ts seedActorTranscript reads parts too, by messageCount).
// A part landing in between is copied verbatim; only parts still absent at copy-time are lost. Both shapes rehydrate
// normally (core/src/agent/session-history-hydrator.ts):
//   - part present but pending/running: the hydrator branches only for completed/error; everything else
//     falls to :189's INTERRUPTED_TOOL_RESULT, so pending and running share one road;
//   - part absent entirely: the assistant's tool calls come from PRESENT parts (:173 addAssistant),
//     so no result-less tool_use appears; and an assistant with no body, reasoning, tool part or
//     token baseline is skipped whole (:162), leaving no empty message.
// Neither shape yields provider-illegal history (no tool_use without result, no empty assistant). Also, part states upsert on the SAME part id
// (adapters storage/session-store/repositories/messages.ts savePart, on conflict(id) do update),
// not append, so a late part never changes the message count -- no boundary moves.
// // not append, so a late part never changes the message count -- no boundary moves.
//
// Fix 1 belongs in core (move that throwIfTurnAborted inside abandon's guard), not here.

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
 // * Mints a session-quiet ledger. Pure memory, no IO; clock injectable so tests never sleep.
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
