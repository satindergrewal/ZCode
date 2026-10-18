// ============================================================
// Dynamic Workflow Run Port: in-place concurrency cap change of a live run
// ============================================================
// docs/dynamic-workflow/concurrency.md "Retuning a live run". Same split rationale as the
// situation cross-section (dynamic-workflow-run-roster.port.ts): dynamic-workflow-run.port.ts
// hits the oxlint max-lines ceiling (400); these three types form a group of their own. Public
// surface unchanged - re-exported verbatim there, `@zcode/contracts` import paths untouched.

/**
 * {@link import("./dynamic-workflow-run.port.js").DynamicWorkflowRunPort.retuneConcurrency}:
 * the request.
 */
export interface DynamicWorkflowRunRetuneRequest {
  runId: string;
  /**
   * The new concurrency cap. `null` = ceiling = lift this run's own limit (same as
   * `AmendWorkflow`'s `max_concurrency: null`). A number is clamped to `[1, ceiling]` - the
   * clamp uses the port's own implementation; the tool layer need not and must not clamp again
   * into a second answer.
   */
  maxConcurrency: number | null;
}

/**
 * Structured refusal reasons of retune. The two are **different next steps** for the caller, hence distinguishable:
 *
 *   - `not_live`: this service holds no such in-flight run (never this process's, or already
 *     settled), or it settled between the liveness check and this call. Fall back to a real
 *     amendment (the existing `AmendWorkflow` path).
 *   - `unchanged`: equals the currently effective cap. Nothing written, nothing stopped -
 *     `current` is that value; the caller phrases "already n" from it.
 */
export type DynamicWorkflowRunRetuneRefusalReason = "not_live" | "unchanged";

/**
 * Structured result of retune. Failure returns a reason instead of throwing, same argument as
 * {@link import("./dynamic-workflow-run.port.js").DynamicWorkflowRunAmendResult}:
 * both reasons are business branches the caller can expect.
 *
 * `defaultConcurrency` and `previous` are not garnish: the model surface must say "at most n
 * subagents at once", annotating "(default)" when n equals the default (same test as
 * `CreateWorkflow`'s reply); the event log must say "8 -> 2", underivable from the new value
 * alone. Only the port side knows both; re-deriving them in callers is a second default-concurrency impl.
 */
export type DynamicWorkflowRunRetuneResult =
  | { ok: true; maxConcurrency: number; previous: number; defaultConcurrency: number }
  | {
      ok: false;
      reason: DynamicWorkflowRunRetuneRefusalReason;
      /** Currently effective cap; always on `unchanged`, on `not_live` only while still readable. */
      current?: number;
    };
