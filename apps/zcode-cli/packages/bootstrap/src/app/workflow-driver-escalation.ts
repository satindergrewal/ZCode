// ============================================================
// AgentRuntime-backed WorkflowDriver: the escalation Q&A bridge (escalate)
// ============================================================
// workflow-driver.ts hit the oxlint max-lines cap (400), so the fourth timeline's (escalation Q&A) four methods -- session escalate port, qid minting, answer settlement,
// per-session teardown -- move here as free functions; the driver keeps thin delegates. The public surface is unchanged, still exported from
// workflow-driver.ts.
//
// Every touch of driver state in the four functions arrives via {@link EscalationHost} (session table, qid reverse table,
// deps, per-run seq, the dual-track record); this file holds no state of its own -- method bodies verbatim,
// `this.` renamed `host.`.

import type {
  EscalateQuestionRequest,
  SessionId,
  WorkflowEscalateOutcome,
  WorkflowEscalatePort,
} from "@zcode/contracts";
import {
  refToString,
  WorkflowError,
  type ActorRef,
  type PersonaSpec,
  type RunEvent,
} from "@zcode/dynamic-workflow";
import {
  ESCALATION_BUDGET_EXHAUSTED,
  MAX_ESCALATIONS_PER_ASK,
  defer,
  effectiveActorName,
  normalizeEscalationContext,
  questionIdFragments,
} from "./workflow-driver-helpers.js";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

/**
  * The host surface handed to the escalation bridge. All **references** into driver-private state (not copies): `sessions` /
  * `qidToSession` are the class's two tables, `nextEscalationSeq` bumps the per-run seq, and `record` is
  * the dual-track landing (journal + emit; the order is fixed -- see the driver's record comment).
 */
export interface EscalationHost {
  readonly deps: AgentRuntimeWorkflowDriverDeps;
  readonly sessions: ReadonlyMap<string, SessionState>;
  readonly qidToSession: Map<string, SessionState>;
    /** The next per-run monotonic escalation seq (the qid's second segment). */
  nextEscalationSeq(): number;
  record(event: RunEvent): void;
}

/**
  * Settles a parked escalation (the run service calls in via the registry). Same family as {@link AgentRuntimeWorkflowDriver.respondToSubmit}:
  * resolve the deferred so the `escalate` tool result becomes this answer and the actor's turn continues in place.
 *
  * false = this driver does not know the qid (wrong run, or just withdrawn by cancelAsk). The registry retires the qid
  * before calling, so no registry write-back here -- double deletes would let "answered" and
  * "withdrawn" overwrite each other as the retirement reason.
 */
export function respondToParkedEscalation(
  host: EscalationHost,
  qid: string,
  answer: string,
): boolean {
  const state = host.qidToSession.get(qid);
  if (state === undefined) return false;
  const deferred = state.pendingEscalations.get(qid);
  host.qidToSession.delete(qid);
  state.pendingEscalations.delete(qid);
  if (deferred === undefined) return false;
  try {
    host.record({ type: "escalation-resolved", qid, answer });
  } catch (error) {
        // The opposite trade-off from the raise path, for the opposite reason: there, an unwritable registry means nobody sees the question and parking
        // blocks the actor forever -- withdraw and rethrow. Here the actor already waits for this answer; keeping it parked over one
        // telemetry event is worse. Log warn, deliver the answer anyway.
    host.deps.logger?.warn?.("Dynamic workflow escalation resolved event not journaled", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "dynamic_workflow.escalation.resolved_journal_failed",
      module: "bootstrap.app",
      qid,
      runId: host.deps.runId ?? "run",
    });
  }
  deferred.resolve(answer);
  return true;
}

/**
  * Withdraw every parked escalation on a session: reject the deferreds (no handler left hanging), retire the registry entries
  * (later answers to those qids get `run_not_in_flight`).
 *
  * Three call sites cover every abnormal ask ending: `cancelAsk` (engine-initiated), `onTurnRejected`
  * (the turn itself threw -- nobody will read tool results), `startAsk` (the next ask replaced this one on the session).
  * The happy path needs none: a parked escalate blocks the turn, so an ask cannot settle while owing an answer.
 */
export function withdrawSessionEscalations(host: EscalationHost, state: SessionState): void {
  if (state.pendingEscalations.size === 0) return;
  const entries = [...state.pendingEscalations];
  state.pendingEscalations.clear();
  for (const [qid, deferred] of entries) {
    host.qidToSession.delete(qid);
    host.deps.escalationRegistry.withdraw(qid);
    deferred.reject(
      new WorkflowError("Cancelled", `Escalation ${qid} was cancelled along with its ask.`),
    );
  }
}

/**
  * Builds the session-level escalation port: the `escalate` handler calls it mid-turn and blocks for the primary's answer.
 *
  * Line-for-line symmetric with {@link AgentRuntimeWorkflowDriver.makeSubmitPort}; its only two differences come from the counterpart being the primary, not the engine:
  *   1. **No sink report**. The engine core stays untouched -- escalation happens entirely inside the driver's ask boundary (the same layer
  *      as repair / nudge rounds); the zero-I/O state machine never sees it. Events ride the journal + emit tracks.
  *   2. **Multiple parks** (keyed by qid): one round's model may fire several escalates in parallel.
 *
  * Both early returns give a **plain tool result**, never a throw: on budget exhaustion a throw reads as retryable and the model
  * bangs the same wall repeatedly -- exactly the busywork this feature exists to kill.
 */
export function makeSessionEscalatePort(
  host: EscalationHost,
  sessionId: SessionId,
  actor: ActorRef,
  persona: PersonaSpec,
): WorkflowEscalatePort {
  const actorName = effectiveActorName(persona);
  return {
    escalate: (request: EscalateQuestionRequest): Promise<WorkflowEscalateOutcome> => {
      const state = host.sessions.get(sessionId);
      if (state === undefined || state.currentInstance === undefined) {
                // No in-flight ask: nowhere to park. No parking, no hanging (same argument as submit's same-named guard).
        return Promise.resolve({
          kind: "refused",
          reason: "no_active_ask",
          message:
            "No ask is in flight, so there is nowhere to park this question and nobody " +
            "would answer it. Escalate only while working on an ask.",
        });
      }
      if (state.escalationsUsed >= MAX_ESCALATIONS_PER_ASK) {
                // Per-ask cap (nudge-budget family): short-circuit from the 4th on, never park.
        return Promise.resolve({
          kind: "refused",
          reason: "budget_exhausted",
          message: ESCALATION_BUDGET_EXHAUSTED,
        });
      }
      state.escalationsUsed++;

      const qid = mintEscalationQuestionId(host);
      const deferred = defer<string>();
      state.pendingEscalations.set(qid, deferred);
      host.qidToSession.set(qid, state);
      const context = normalizeEscalationContext(request.context);
            // Read the clock **once**, shared by event and park record: two Date.now() calls would give the same question
            // ask-times milliseconds apart across the event track and snapshots, and downstream computes "waited how long" from it.
      const askedAt = Date.now();
      host.deps.escalationRegistry.park(
        {
          qid,
          runId: host.deps.runId ?? "run",
          actor: refToString(actor),
          ...(actorName === undefined ? {} : { actorName }),
          question: request.question,
          ...(context === undefined ? {} : { context }),
          askedAt,
        },
        (answer) => {
          respondToParkedEscalation(host, qid, answer);
        },
      );
      try {
        host.record({
          type: "escalation-raised",
          qid,
          actor,
          ...(actorName === undefined ? {} : { actorName }),
          question: request.question,
          ...(context === undefined ? {} : { context }),
          askedAt,
        });
      } catch (error) {
                // An unwritable journal means no durable Q&A record, while parking blocks the actor indefinitely on a
                // question nobody can see. Withdraw the registration and hand the error to the handler -- honester than a silent park.
        state.pendingEscalations.delete(qid);
        host.qidToSession.delete(qid);
        host.deps.escalationRegistry.withdraw(qid);
        throw error;
      }
      return deferred.promise.then((answer) => ({ kind: "answered", answer, qid }) as const);
    },
  };
}

/**
  * Mints a globally unique question id: `dwfq-<runId fragment>-<seq>`.
 *
  * The fragment aids human debugging (semantically opaque -- the model only parrots it back); the seq is per-run monotonic.
  * Short fragments (8 chars) can collide with another run's in the extreme, so candidates grow by length, taking the first
  * unclaimed in the registry: **the last candidate is the full runId**, and "unique runId x per-run monotonic seq" is
  * collision-free by construction -- the loop must terminate on an unclaimed id. All taken means two drivers sharing
  * one runId (an assembly bug): fail loudly rather than mint an answer-mismatching id.
 */
function mintEscalationQuestionId(host: EscalationHost): string {
  const seq = host.nextEscalationSeq();
  for (const fragment of questionIdFragments(host.deps.runId ?? "run")) {
    const candidate = `dwfq-${fragment}-${seq}`;
    if (!host.deps.escalationRegistry.isTaken(candidate)) return candidate;
  }
  throw new WorkflowError(
    "DriverError",
    `Cannot mint a free escalation question id for run ${host.deps.runId ?? "run"} ` +
      `(seq=${seq}): every candidate is already taken in the registry. Two drivers may be ` +
      `sharing one runId.`,
  );
}
