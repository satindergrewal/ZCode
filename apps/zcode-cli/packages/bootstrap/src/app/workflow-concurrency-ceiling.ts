// ============================================================
// The workflow concurrency ceiling: the single implementation of the CPU-derived value.
// ============================================================
// `max(1, min(16, availableParallelism() − 2))`
// It is both each run's own concurrency bound (fixed at submit, persisted in dwf_run, reused on resume) and the starting point and
// ceiling of every provider bucket in the process-level governor. The formula must stay a single function: copies in run service / snippet
// service / the legacy `Workflow` tool would drift, desyncing the "run bound" from the "bucket ceiling".

import { availableParallelism as osAvailableParallelism } from "node:os";

/** Hard cap of the concurrency bound (legacy concurrency formula). */
const WORKFLOW_CONCURRENCY_CEILING_MAX = 16;
/** Cores reserved for the main agent and the host process. */
const RESERVED_PARALLELISM = 2;
/** Floor: on dual-core machines parallelism - 2 == 0, so at least one probe must keep running. */
const WORKFLOW_CONCURRENCY_FLOOR = 1;

/**
 * CPU-derived concurrency ceiling. `availableParallelism` is injectable so tests can pin core counts (the floor/cap cases).
 */
export function resolveWorkflowConcurrencyCeiling(
  availableParallelism: () => number = osAvailableParallelism,
): number {
  return Math.max(
    WORKFLOW_CONCURRENCY_FLOOR,
    Math.min(WORKFLOW_CONCURRENCY_CEILING_MAX, availableParallelism() - RESERVED_PARALLELISM),
  );
}

/**
 * Requested concurrency bound -> the bound actually effective for this run.
 *
 * **Clamp, never reject**: this knob only lowers concurrency; an oversized value means "do not limit me", and turning that into
 * a tool failure would make the model guess the core count. Missing/non-finite also reads as "no limit" = ceiling; fractions
 * round down ("3.7 in-flight asks" is meaningless, and rounding up would silently exceed the user's number).
 *
 * Lives in the same file as the ceiling: the submit-time bound and the mid-run retune must go through the same clamp (otherwise one
 * `max_concurrency` becomes two numbers via two paths), and those paths live in the run service and retune modules.
 */
export function clampRunConcurrency(requested: number | undefined, ceiling: number): number {
  if (requested === undefined || !Number.isFinite(requested)) return ceiling;
  return Math.max(1, Math.min(ceiling, Math.floor(requested)));
}
