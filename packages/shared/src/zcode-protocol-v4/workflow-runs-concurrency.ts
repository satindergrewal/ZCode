// ============================================================
// The adaptive-concurrency part of the workflowRuns reduction
// ============================================================
// Split from workflow-runs-reducer.ts (max-lines gate): the main reduction keeps only the switch dispatch,
// and `concurrency-changed`'s rules live here. Same discipline as the main reduction: pure, clockless--the event's
// `cooldownMs` is relative; the deadline is computed by the UI from when the state arrived.

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunConcurrency,
  type WorkflowRunState,
} from "./workflow-runs.js";

/// The event's `reason`: the idle bucket resets to the ceiling--not a cooldown; clear any old cooldown on receipt.
const CONCURRENCY_IDLE_RESET_REASON = "idle_reset";

/**
 * `concurrency-changed` → `run.concurrency`。
 *
 * The ceiling derives from the max `previous` / `next` this run has seen (events do not carry it; the bucket starts at the ceiling, so the
 * first event's `previous` is the ceiling and, in a only-down sequence, always the max). `cooldownMs` appears only on
 * rate limits with Retry-After; `idle_reset` clears it. An unreadable `next` (absent / non-positive-int) leaves the whole event watermark-only:
 * no cap, nothing to show.
 *
 * `limit` is copied verbatim: the run's **own** bound (from `run-started`), unrelated to the shared bucket's wander--the governor
 * lowering or freeing a provider key never changes the cap the user set for this run.
 */
export function reduceConcurrencyChanged(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  const next = positiveInteger(payload.next);
  if (next === undefined) return run;
  const previous = positiveInteger(payload.previous) ?? next;
  const ceiling = Math.max(run.concurrency?.ceiling ?? 0, previous, next);
  const key = nonEmptyString(payload.key);
  const limit = run.concurrency?.limit;
  const cooldownMs =
    payload.reason === CONCURRENCY_IDLE_RESET_REASON
      ? undefined
      : nonNegativeInteger(payload.cooldownMs);
  const concurrency: WorkflowRunConcurrency = {
    ...(key === undefined || key.length > WORKFLOW_RUNS_LIMITS.maxConcurrencyKeyLength
      ? {}
      : { key }),
    cap: next,
    ceiling,
    ...(limit === undefined ? {} : { limit }),
    ...(cooldownMs === undefined ? {} : { cooldownMs }),
  };
  return { ...run, concurrency };
}

/**
 * `run-started` -> `run.concurrency.limit`: this run's **own** bound. The payload carries the engine's
 * `caps.maxConcurrency` plus the `concurrencyCeiling` the CLI computed at payload-mint time (the ceiling is a process fact,
 * not an engine fact, so the CLI concatenates it--same precedent as `resumedFrom`).
 *
 * Recorded only when `maxConcurrency < ceiling`: a run at the ceiling is byte-identical to before, not one key more.
 * Legacy CLIs omit `concurrencyCeiling`; without a readable ceiling there is no telling whether the run was throttled--change nothing.
 *
 * The shared-bucket side (`cap` / `key` / `cooldownMs`) stays as-is: resume re-emits `run-started` for the same runId, by which time
 * the process has likely learned a throttled cap; overwriting it with the ceiling would raise the reading to a fake value.
 * Likewise `ceiling` only rises--the same watermark rule as `reduceConcurrencyChanged`.
 */
export function reduceRunStartedConcurrency(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  const limit = positiveInteger(plainRecord(payload.caps)?.maxConcurrency);
  const readCeiling = positiveInteger(payload.concurrencyCeiling);
  const ceiling =
    readCeiling !== undefined && readCeiling <= WORKFLOW_RUNS_LIMITS.maxConcurrencyCeiling
      ? readCeiling
      : undefined;
  // The ceiling itself is recorded separately (`run.concurrencyCeiling`): the Configure dialog's stepper must know where to stop, and
  // a run at the ceiling has no `concurrency` to hang it on. Unreadable keeps the known value--the same degradation rule as subagentModel.
  const withCeiling =
    ceiling === undefined || run.concurrencyCeiling === ceiling
      ? run
      : { ...run, concurrencyCeiling: ceiling };
  if (limit === undefined || ceiling === undefined || limit >= ceiling) return withCeiling;
  const existing = withCeiling.concurrency;
  const concurrency: WorkflowRunConcurrency = {
    // Without a shared-bucket reading, cap starts at the ceiling--where the bucket starts (the same basis as
    // reduceConcurrencyChanged's ceiling derivation).
    ...(existing ?? { cap: ceiling }),
    ceiling: Math.max(existing?.ceiling ?? 0, ceiling),
    limit,
  };
  return { ...withCeiling, concurrency };
}

/**
 * `run-caps-changed` -> `run.concurrency.limit`: the run's **own** bound changed in flight. A max_concurrency-only revision applies in place--
 * neither stopping this run nor starting another; the engine emits this after changing caps, payload shaped like `run-started`
 * (engine `caps.maxConcurrency` plus the CLI's `concurrencyCeiling`). So this reads the same two fields and keeps the same
 * "record only below ceiling" rule as `reduceRunStartedConcurrency`: one number via two paths must not yield two readings.
 *
 * The ceiling is taken as payload -> run's known value. A process fact, constant for the whole run, already recorded on
 * `run.concurrencyCeiling` by `run-started`, this event has one more fallback than `run-started`; only with neither can we not
 * tell whether the number was throttled--change nothing. Same for an unreadable `caps`.
 *
 * Returning to the ceiling **removes** `limit` rather than writing the ceiling: per protocol, a run at the ceiling has no bound of its own.
 * If the shared-bucket side then has nothing to say either (cap at watermark, no cooldown), the whole `concurrency` key goes absent--
 * byte-identical to a never-throttled run. With no `limit` to begin with, not a byte moves (the idempotence pivot).
 */
export function reduceRunCapsChanged(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  const maxConcurrency = positiveInteger(plainRecord(payload.caps)?.maxConcurrency);
  const readCeiling = positiveInteger(payload.concurrencyCeiling);
  const payloadCeiling =
    readCeiling !== undefined && readCeiling <= WORKFLOW_RUNS_LIMITS.maxConcurrencyCeiling
      ? readCeiling
      : undefined;
  const withCeiling =
    payloadCeiling === undefined || run.concurrencyCeiling === payloadCeiling
      ? run
      : { ...run, concurrencyCeiling: payloadCeiling };
  const ceiling = payloadCeiling ?? withCeiling.concurrencyCeiling;
  if (maxConcurrency === undefined || ceiling === undefined) return withCeiling;
  const existing = withCeiling.concurrency;
  if (maxConcurrency < ceiling) {
    const concurrency: WorkflowRunConcurrency = {
      // Without a shared-bucket reading, cap starts at the ceiling--the same basis as reduceRunStartedConcurrency.
      ...(existing ?? { cap: ceiling }),
      ceiling: Math.max(existing?.ceiling ?? 0, ceiling),
      limit: maxConcurrency,
    };
    return { ...withCeiling, concurrency };
  }
  if (existing?.limit === undefined) return withCeiling;
  const { limit: _lifted, ...shared } = existing;
  return shared.cooldownMs === undefined && shared.cap >= shared.ceiling
    ? withoutConcurrency(withCeiling)
    : { ...withCeiling, concurrency: shared };
}

/** Remove the whole `concurrency` key (not an empty object): per protocol, "running at the ceiling" is this key's absence. */
function withoutConcurrency(run: WorkflowRunState): WorkflowRunState {
  const { concurrency: _cleared, ...rest } = run;
  return rest;
}

/**
 * Remove `concurrency.cooldownMs` (terminal run: nothing more will be dispatched, no referent for a cooldown).
 * Nothing to remove -> return as-is--the idempotent-replay pivot, like the main reduction's withoutPendingQuestions. cap / ceiling stay:
 * they are the historical facts of what concurrency this run ran under.
 */
export function withoutCooldown(run: WorkflowRunState): WorkflowRunState {
  if (run.concurrency?.cooldownMs === undefined) return run;
  const { cooldownMs: _expired, ...rest } = run.concurrency;
  return { ...run, concurrency: rest };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
