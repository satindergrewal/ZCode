// Dynamic Workflow Run Port: adjust the concurrency cap of a live run.
// Defines the request, result, and capability bounds; re-exported via dynamic-workflow-run.port.ts;
// callers consume it through `@zcode/contracts`.

/**
 * {@link import("./dynamic-workflow-run.port.js").DynamicWorkflowRunPort.retuneConcurrency}
 * request.
 */
export interface DynamicWorkflowRunRetuneRequest {
  runId: string;
  /**
   * New concurrency cap. `null` = ceiling = lift this run's own limit (same as `AmendWorkflow`'s
   * `max_concurrency: null`). A number is clamped into `[1, ceiling]` - clamping uses the port's own
   * implementation; the tool layer need not, and must not, clamp again for a second answer.
   */
  maxConcurrency: number | null;
}

/**
 * Structured refusal reasons for retune. The two are **different next steps** for the caller, hence distinguishable:
 *
 *   - `not_live`: this service holds no such in-flight run (never this process's, already settled), or it settled
 *     between the liveness check and this call. Fall back to a real amend (the existing `AmendWorkflow` path).
 *   - `unchanged`: equals the currently effective cap. Nothing written, nothing stopped - `current` is that value,
 *     from which the caller says "already n".
 */
export type DynamicWorkflowRunRetuneRefusalReason = "not_live" | "unchanged";

/**
 * Structured retune result. Failure carries a reason, not a throw - same argument as
 * {@link import("./dynamic-workflow-run.port.js").DynamicWorkflowRunAmendResult}:
 * both reasons are business branches the caller can expect.
 *
 * `ceiling` and `previous` are not garnish: the model-facing reply says "at most n subagents run at once", and when n equals
 * the ceiling it must say "limit lifted" (same test as `CreateWorkflow`'s reply); the event log says "8 -> 2",
 * not derivable from the new value alone. Only the port knows both; caller-side recompute is a second ceiling implementation.
 */
export type DynamicWorkflowRunRetuneResult =
  | { ok: true; maxConcurrency: number; previous: number; ceiling: number }
  | {
      ok: false;
      reason: DynamicWorkflowRunRetuneRefusalReason;
      /** Cap in effect right now; always on `unchanged`, on `not_live` only while still readable. */
      current?: number;
    };
