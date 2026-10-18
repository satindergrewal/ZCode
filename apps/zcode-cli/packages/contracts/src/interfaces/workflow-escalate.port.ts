// ============================================================
// Workflow Escalate Port - boundary for an actor escalating a blocking question to the main agent
// ============================================================
// Fully isomorphic to {@link WorkflowSubmitPort} and deliberately separate:
// submit settles **the ask's result** (engine adjudication); escalate settles **one question-answer** (the main agent answers);
// peers, lifecycles, and failure shapes all differ; merging would blur the two timelines.

import type { TraceContext } from "../tracing/tracer.js";
import type { ToolCallId } from "./shared.js";

export interface EscalateQuestionRequest {
  /** Tool call id within the actor sub-session that issued `escalate`. */
  toolCallId: ToolCallId | string;
  /** The blocker itself: one focused, one-sentence-answerable question. */
  question: string;
  /** Optional context (what the actor tried, where it is stuck). */
  context?: string;
  trace: TraceContext;
}

/**
 * The outcome of one escalation. **Both arms are ordinary tool results**, not errors: on budget exhaustion return
 * the normal "proceed on your own" result instead of throwing (an error reads as retryable and the model bangs the same wall).
 *
 * A discriminant, not prose: the caller (core's tool handler) must decide how to render the
 * tool_result (house rule: error codes, not text, drive control flow).
 */
export type WorkflowEscalateOutcome =
  | {
      kind: "answered";
      /** Answer text given via `ResolveWorkflowQuestion`; becomes the tool result verbatim. */
      answer: string;
      /** Globally unique id of this Q&A (for logs and human tracing; the model need not read it). */
      qid: string;
    }
  | {
      kind: "refused";
      /**
       * `budget_exhausted`: this ask's escalation budget is used up (per-ask cap, kin to the nudge budget).
       * `no_active_ask`: no ask in flight on this session; nowhere to park the question (should not happen, but never hang).
       */
      reason: "budget_exhausted" | "no_active_ask";
      /** Model-facing copy stating the situation and the next step. */
      message: string;
    };

export interface WorkflowEscalatePort {
  /**
   * Escalate a blocking question and **block** awaiting the main agent's answer.
   *
   * Same discipline as {@link WorkflowSubmitPort.respond}: resolve may take arbitrarily long (no
   * timeout by design - "decide on timeout" would reintroduce the speculative bypass this feature kills). The escape hatch is the existing cancel:
   * the driver's `cancelAsk` rejects the parked escalation deferred too, so run cancel and process death
   * behave exactly as today.
   *
   * Routing identity (run/actor/session/instance) is bound by the port closure; the model cannot override.
   */
  escalate(request: EscalateQuestionRequest): Promise<WorkflowEscalateOutcome>;
}
