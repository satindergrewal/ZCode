// ============================================================
// The adaptive-concurrency part of the workflowRuns reduction
// ============================================================
// Split from workflow-runs-reducer.ts (max-lines gate): the main reduction keeps only the switch dispatch;
// the `concurrency-changed` rules live here. Same discipline as the main reduction: pure functions, no clock -- the event's
// `cooldownMs` is relative; the UI derives deadlines from when the state arrived.

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunConcurrency,
  type WorkflowRunState,
} from "./workflow-runs.js";

/** The event's `reason` value: an idle bucket resets to default concurrency -- not a cooldown; receipt clears any old one. */
const CONCURRENCY_IDLE_RESET_REASON = "idle_reset";

/**
 * `concurrency-changed` → `run.concurrency`。
 *
 * `ceiling` is default concurrency D (docs/dynamic-workflow/concurrency.md, Protocol state): when `run-started` recorded it
 * on `run.concurrencyCeiling`, that value wins. Shared-bucket auto-growth reaches 2D and a raised run goes higher,
 * so max-seen previous/next stopped being D long ago -- it is only the **legacy-CLI** fallback (no `concurrencyCeiling`):
 * there the bucket starts at the ceiling and only shrinks, so the max equals the ceiling. `cooldownMs` appears only on
 * Retry-After rate limits; `idle_reset` clears it. Unreadable `next` (absent / non-positive-int) raises the watermark only:
 * without a cap there is nothing to display.
 *
 * `limit` passes through: it is this run's own bound (from `run-started`), independent of shared-bucket movement --
 * the governor squeezing or releasing a provider key never changes the bound the user set for this run.
 */
export function reduceConcurrencyChanged(
  run: WorkflowRunState,
  payload: Record<string, unknown>,
): WorkflowRunState {
  const next = positiveInteger(payload.next);
  if (next === undefined) return run;
  const previous = positiveInteger(payload.previous) ?? next;
  const ceiling = run.concurrencyCeiling ?? Math.max(run.concurrency?.ceiling ?? 0, previous, next);
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
 * `run-started` -> `run.concurrency.limit`: this run's **own** bound
 * (docs/dynamic-workflow/concurrency.md, Two bounds on a run). The payload carries the engine's
 * `caps.maxConcurrency` plus the `concurrencyCeiling` the CLI computed at mint time -- default concurrency D (the wire key
 * predates the default-concurrency concept, kept for legacy compat). D is a process fact, not an engine fact, so the CLI folds it
 * into the payload -- same precedent as `resumedFrom`.
 *
 * Recorded only when `maxConcurrency != D` -- **above or below** both count: D is the starting point, not a cap; a run can be
 * more parallel than default. Runs on default stay byte-identical to before, not one key more. Legacy CLIs send no `concurrencyCeiling`;
 * without D there is no telling whether this run has its own bound -- change nothing.
 *
 * The shared-bucket side (`cap` / `key` / `cooldownMs`) stays untouched: resume re-sends `run-started` for the same runId,
 * and by then the process likely learned a throttle-lowered cap; overwriting it with D would raise the reading to a fake value.
 * back up to a fake value.
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
  // D itself is recorded separately (`run.concurrencyCeiling`): the Configure dialog needs the default-N line and the
  // equals-default (no own bound) verdict, while a run on default has no `concurrency` to hang it on. Unreadable keeps the known value --
  // same degradation rule as subagentModel.
  const withCeiling =
    ceiling === undefined || run.concurrencyCeiling === ceiling
      ? run
      : { ...run, concurrencyCeiling: ceiling };
  if (limit === undefined || ceiling === undefined || limit === ceiling) return withCeiling;
  const existing = withCeiling.concurrency;
  const concurrency: WorkflowRunConcurrency = {
    // Without a shared-bucket reading, cap starts at D -- where the bucket started anyway.
    ...(existing ?? { cap: ceiling }),
    ceiling,
    limit,
  };
  return { ...withCeiling, concurrency };
}

/**
 * `run-caps-changed` -> `run.concurrency.limit`: the run's own bound changed **in flight**
 * (docs/dynamic-workflow/concurrency.md). A max_concurrency-only amend applies in place -- no stop, no restart; the engine emits this
 * after applying caps, payload shaped like `run-started` (engine `caps.maxConcurrency` plus the CLI's `concurrencyCeiling`, i.e. D).
 * So this reads the same two fields and keeps the record-only-if-!=D rule of `reduceRunStartedConcurrency`: one number, two paths, one reading.
 * same two fields and the record-only-if-!=D rule: one number via two paths must not yield two readings.
 *
 * D comes from the payload, else the run's known value. It is a process fact, constant per run, and `run-started` recorded it on
 * `run.concurrencyCeiling`, so this event has one fallback more than `run-started`; with neither, default is undecidable --
 * change nothing. Unreadable `caps` likewise.
 *
 * Returning to D **removes** `limit` rather than writing D: on default, a run has no own bound by protocol. If the shared-bucket
 * side also has nothing to say (cap not below D, not cooling -- a cap grown above D says nothing to a default run either,
 * the reading is min(cap, D)), the whole `concurrency` key goes absent -- byte-identical to a never-tuned run.
 * Already without `limit`: not one byte moves (the idempotency pivot).
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
  if (maxConcurrency !== ceiling) {
    const concurrency: WorkflowRunConcurrency = {
      // Without a shared-bucket reading, cap starts at D -- same basis as reduceRunStartedConcurrency.
      ...(existing ?? { cap: ceiling }),
      ceiling,
      limit: maxConcurrency,
    };
    return { ...withCeiling, concurrency };
  }
  if (existing?.limit === undefined) return withCeiling;
  const { limit: _lifted, ...rest } = existing;
  const shared: WorkflowRunConcurrency = { ...rest, ceiling };
  return shared.cooldownMs === undefined && shared.cap >= shared.ceiling
    ? withoutConcurrency(withCeiling)
    : { ...withCeiling, concurrency: shared };
}

/** Remove the whole `concurrency` key (not an empty object): protocol-wise, on-default-with-nothing-to-say is key-absent. */
function withoutConcurrency(run: WorkflowRunState): WorkflowRunState {
  const { concurrency: _cleared, ...rest } = run;
  return rest;
}

/**
 * Drop `concurrency.cooldownMs` (terminal run: nothing left to dispatch, cooling has no target). Nothing to drop returns
 * as-is -- the idempotent-replay pivot, like the main reduction's withoutPendingQuestions. cap / ceiling stay:
 * they are the historical record of the concurrency this run ran at.
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
