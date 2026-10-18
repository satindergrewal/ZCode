// ============================================================
// The park registry for workflow escalation Q&A (the only wire between driver and run service)
// ============================================================
// The actor's `escalate` parks in the driver (which owns the ask-turn
// context), while the answering entrance `resolveQuestion` sits on the run service (the port holder) -- the two need
// a by-qid lookup table. This file is that table, and only that: no I/O, no persistence, no engine knowledge.
//
// Why not hand the driver instance to the service: the driver is constructed inside `makeDriver(sink)` in
// `runWorkflowScript`, invisible to the service. Passing a table beats adding a capture
// hook in launch just to expose the instance -- one less timing dependency (the table exists before launch; register/query share its lifetime).
//
// **Purely in-memory, dies with the parked deferred**. Deliberately unpersisted: after a process death the deferred is gone,
// and a persisted pending table would only lie (sending the primary to answer a question nobody waits on anymore).
// Self-healing is resume -- the ask re-runs live, the actor re-asks under a new qid, and stale ids get a structured rejection.
//
// Scope: **one per run service instance** (per app session), never a module singleton: one table across
// sessions is a cross-session answer hole, the same discipline as the repo's "enumeration faces see own session only". One table spans
// **every in-flight run of this service** -- exactly why qids must be globally unique.

import type {
  DynamicWorkflowResolveQuestionResult,
  DynamicWorkflowRunPendingQuestion,
} from "@zcode/contracts";

/**
  * Memory kept for retired qids. **Bounded**: a long-lived session can Q&A arbitrarily often; an unbounded history table is
  * one more silently growing allocation. Once evicted, `resolveQuestion` answers `unknown_question` -- an honest
  * degradation ("unknown id"), not a wrong answer.
 */
const RETIRED_HISTORY_LIMIT = 256;

/** The facts of one park registration (driver-provided; the qid is minted by the driver). */
export interface ParkedQuestionInput {
  qid: string;
  runId: string;
    /** The asking actor, `refToString` form (e.g. `actor#1@1`). */
  actor: string;
    /** The actor's effective name (the `"poet"` of `agent("poet")`); absent for anonymous actors, no fallback label synthesized. */
  actorName?: string;
  question: string;
  context?: string;
  askedAt: number;
}

/** Why a qid retired: decides which structured rejection later resolves receive. */
type RetiredReason = "resolved" | "withdrawn";

export interface WorkflowEscalationRegistry {
  /**
      * Registers a parked question. `settle` is driver-provided and resolves the deferred when the answer arrives.
   *
      * Callers must first ensure the qid is free via {@link isTaken} (the driver's minting loop does) --
      * a duplicate registration would silently overwrite the earlier park, the very cause of mismatched answers.
   */
  park(entry: ParkedQuestionInput, settle: (answer: string) => void): void;
    /** Whether the qid is taken (parked or retired); the driver's minting loop uses it for global uniqueness. */
  isTaken(qid: string): boolean;
  /**
      * Withdraw a park **without answering**: the driver calls it when the ask is cancelled / the turn fails (the driver
      * rejects its own deferred side). Later resolves of the qid get `run_not_in_flight`.
   */
  withdraw(qid: string): void;
    /** Settles a parked entry. The three structured rejections each state the situation and the next step. */
  resolve(qid: string, answer: string): DynamicWorkflowResolveQuestionResult;
    /** Questions currently parked on a run, in ask order. Feeds the snapshot's `pendingQuestions`. */
  pendingFor(runId: string): DynamicWorkflowRunPendingQuestion[];
}

interface ParkedQuestion extends ParkedQuestionInput {
  settle: (answer: string) => void;
}

export function createWorkflowEscalationRegistry(): WorkflowEscalationRegistry {
    // The Map's insertion order is ask order (pendingFor relies on it; no separate sequence stored).
  const parked = new Map<string, ParkedQuestion>();
  const retired = new Map<string, RetiredReason>();

  const retire = (qid: string, reason: RetiredReason): void => {
    parked.delete(qid);
    retired.set(qid, reason);
    while (retired.size > RETIRED_HISTORY_LIMIT) {
            // Map iteration is insertion order, so the first key is the oldest.
      const oldest = retired.keys().next();
      if (oldest.done === true) break;
      retired.delete(oldest.value);
    }
  };

  return {
    park(entry, settle) {
      parked.set(entry.qid, { ...entry, settle });
    },

    isTaken(qid) {
      return parked.has(qid) || retired.has(qid);
    },

    withdraw(qid) {
            // Meaningful for parked entries only: an already-resolved qid must not degrade to `run_not_in_flight`
            // (that rewrites "answer delivered" into "nobody waiting" -- two different facts for the primary).
      if (!parked.has(qid)) return;
      retire(qid, "withdrawn");
    },

    resolve(qid, answer) {
      const entry = parked.get(qid);
      if (entry === undefined) {
        const reason = retired.get(qid);
        if (reason === "resolved") {
          return {
            ok: false,
            reason: "already_resolved",
            message:
              `Question ${qid} was already answered and the subagent has moved on with that ` +
              `answer. No need to answer again; if you have more to add, wait for its next ` +
              `escalation.`,
          };
        }
        if (reason === "withdrawn") {
          return {
            ok: false,
            reason: "run_not_in_flight",
            message:
              `The ask that raised question ${qid} is no longer in flight (the run was ` +
              `cancelled, or that ask already failed), so nobody is waiting for this answer. ` +
              `Use GetWorkflowRun to see the run's current state before deciding what to do next.`,
          };
        }
        return {
          ok: false,
          reason: "unknown_question",
          message:
            `Unknown question id ${qid}. It may be misspelled, or it may come from a process ` +
            `that is gone: parked questions are not persisted, so they vanish on restart (a ` +
            `resume makes the subagent ask again under a new id). Use GetWorkflowRun to read ` +
            `the run's pendingQuestions for the ids that are actually awaiting an answer.`,
        };
      }
      retire(qid, "resolved");
            // settle after retirement: it resolves the actor-side deferred synchronously, and any re-entry on that chain
            // (e.g. another escalate in the same turn) must see a table already without this qid.
      entry.settle(answer);
      return { ok: true, qid };
    },

    pendingFor(runId) {
      const out: DynamicWorkflowRunPendingQuestion[] = [];
      for (const entry of parked.values()) {
        if (entry.runId !== runId) continue;
        out.push({
          qid: entry.qid,
          actor: entry.actor,
          ...(entry.actorName === undefined ? {} : { actorName: entry.actorName }),
          question: entry.question,
          ...(entry.context === undefined ? {} : { context: entry.context }),
          askedAt: entry.askedAt,
        });
      }
      return out;
    },
  };
}
