// ============================================================
// Workflow Submit Port - actor terminal-result verdict boundary
// ============================================================

import type { TraceContext } from "../tracing/tracer.js";
import type { ToolCallId } from "./shared.js";

/**
 * One validator violation, shaped to enter a repair tool_result directly: one per line, with
 * JSON path, expected, and got.
 *
 * Shape matches dynamic-workflow's synthesis-side Violation; the driver maps the engine's
 * Violation verbatim onto this port; contracts never reverse-depend on dynamic-workflow.
 */
export interface SubmitViolation {
  /** JSON path of the violation, e.g. `$`, `$.foo`, `$.items[0]`. */
  path: string;
  /** Short description of the expected shape/value. */
  expected: string;
  /** Short description of the actual value. */
  got: string;
}

export interface SubmitResultRequest {
  /** Tool call id within the actor sub-session that issued submit_result. */
  toolCallId: ToolCallId | string;
  /** Raw structured result the model submitted (arbitrary JSON, unvalidated by this port). */
  result: unknown;
  trace: TraceContext;
}

/** Engine accepted the submission: the actor turn should end once the result returns. */
export interface SubmitAccepted {
  accept: true;
}

/** Engine rejected the submission: violations returned for in-session repair and retry. */
export interface SubmitRejected {
  accept: false;
  violations: readonly SubmitViolation[];
}

export type SubmitVerdict = SubmitAccepted | SubmitRejected;

export interface WorkflowSubmitPort {
  /**
   * Submit the actor's structured final result and await the engine's verdict.
   *
   * Unlike CoordinatorResponsePort, this **blocks** until the engine finishes validation: the engine may run
   * out-of-band repair/budget rounds, so resolve can take arbitrarily long. Cancellation is not expressed here - aborting
   * the tool call handles it; the driver turns out-of-band ask cancellation into a turn abort.
   *
   * Routing identity (instance/actor/session) is bound by the port closure; the model cannot override.
   */
  respond(request: SubmitResultRequest): Promise<SubmitVerdict>;
}
