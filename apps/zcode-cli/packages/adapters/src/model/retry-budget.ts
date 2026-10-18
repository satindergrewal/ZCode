import { ModelRetryBudget } from "@zcode/contracts";
import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";

/**
 * Retry budget tiering.
 *
 * Unbounded only relaxes give-up-on-transient gates: the runner attempt loop and the retry-again-after-failure check.
 * The backoff curve (2s to 60s, jitter, Retry-After first), isRetryableFailure classification, no-retry after
 * emittedRetryBoundaryEvent, empty-completion retry and the compact path are all untouched.
 *
 * "Single attempt" only collapses this request's maxAttempts to 1: both runner gates and the empty-completion retry read
 // the same retry.maxAttempts, so a transient failure surfaces on the first try; auth-refresh/signature-repair attempts stay budget-free, semantics unchanged.
 */

/** Sentinel for unbounded `maxAttempts` in status events (Infinity is not serializable; 0 is not a legal count). */
export const UNBOUNDED_RETRY_MAX_ATTEMPTS = 0;
/** Total attempts allowed for this request under the single-attempt budget (first included). */
export const SINGLE_ATTEMPT_MAX_ATTEMPTS = 1;

export function isUnboundedRetryBudget(budget: ModelRetryBudget | undefined): boolean {
  return budget === ModelRetryBudget.Unbounded;
}

export function isSingleAttemptRetryBudget(budget: ModelRetryBudget | undefined): boolean {
  return budget === ModelRetryBudget.SingleAttempt;
}

/**
 * Resolves the effective retry options for this request by budget tier. The runner enters only here, so attempt loops,
 // failure gates, empty completion, and state events never special-case the tier separately.
 */
export function resolveRetryOptionsForBudget(
  retry: ResolvedAiSdkModelRetryOptions,
  budget: ModelRetryBudget | undefined,
): ResolvedAiSdkModelRetryOptions {
  return isSingleAttemptRetryBudget(budget)
    ? { ...retry, maxAttempts: SINGLE_ATTEMPT_MAX_ATTEMPTS }
    : retry;
}

/** May the failure be retried once more (equals legacy `retryBudgetAttempt < maxAttempts`; always true unbounded)? */
export function retryBudgetAllows(
  budget: ModelRetryBudget | undefined,
  retryBudgetAttempt: number,
  maxAttempts: number,
): boolean {
  return isUnboundedRetryBudget(budget) || retryBudgetAttempt < maxAttempts;
}

/** Attempt-loop continuation (equals legacy `attempt <= loopMaxAttempts`; always true unbounded). */
export function retryAttemptLoopContinues(
  budget: ModelRetryBudget | undefined,
  attempt: number,
  loopMaxAttempts: number,
): boolean {
  return isUnboundedRetryBudget(budget) || attempt <= loopMaxAttempts;
}

/** maxAttempts written to status events/logs: the sentinel 0 when unbounded. */
export function retryBudgetMaxAttempts(
  budget: ModelRetryBudget | undefined,
  maxAttempts: number,
): number {
  return isUnboundedRetryBudget(budget) ? UNBOUNDED_RETRY_MAX_ATTEMPTS : maxAttempts;
}
