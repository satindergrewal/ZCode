import { ModelRetryBudget } from "@zcode/contracts";

/**
 * Retry budget tiering.
 *
 * Unbounded only relaxes give-up-on-transient gates: the runner attempt loop and the retry-again-after-failure check.
 * The backoff curve (2s to 60s, jitter, Retry-After first), isRetryableFailure classification, no-retry after
 * emittedRetryBoundaryEvent, empty-completion retry and the compact path are all untouched.
 */

/** Sentinel for unbounded `maxAttempts` in status events (Infinity is not serializable; 0 is not a legal count). */
export const UNBOUNDED_RETRY_MAX_ATTEMPTS = 0;

export function isUnboundedRetryBudget(budget: ModelRetryBudget | undefined): boolean {
  return budget === ModelRetryBudget.Unbounded;
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
