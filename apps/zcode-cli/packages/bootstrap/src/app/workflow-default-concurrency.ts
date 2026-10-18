// ============================================================
// Workflow default concurrency: the single implementation of the CPU-derived value
// ============================================================
// docs/dynamic-workflow/concurrency.md「Two bounds on a run」：`max(4, min(16, availableParallelism() − 2))`
// is the **default concurrency** D — the bound for runs without `max_concurrency`, the governor's per-provider bucket seed and
// idle reset point, and the legacy `Workflow` tool / snippet concurrency. A floor, **not** a cap: a user's
// `max_concurrency` is honored above or below; bucket auto-growth stops at 2D (beyond that only a run's own bound raises it).
//
// This number used to be called the "ceiling", clamping a run's own bound under it; user feedback: small machines / remotes got two subagents,
// while subagents wait on remote providers, not local cores — hence dropping the ceiling semantics and raising the floor from 1 to 4.
// A formula copied in N places drifts N ways; it converges into this one function.

import { availableParallelism as osAvailableParallelism } from "node:os";

/** Hard cap of the default concurrency (inherited from the legacy formula). Governs the default only, never user-set bounds. */
export const WORKFLOW_DEFAULT_CONCURRENCY_MAX = 16;
/** Floor: on small-core machines and small remotes, cores - 2 leaves one or two, and the subagent bottleneck is not local cores. */
const WORKFLOW_DEFAULT_CONCURRENCY_FLOOR = 4;
/** Cores reserved for the main agent and the host process. */
const RESERVED_PARALLELISM = 2;
/**
 * Governor bucket auto-growth multiple: with no in-flight run demanding more, the cap probes up to `2 x D`
 * （docs/dynamic-workflow/concurrency.md「The governor」）。
 */
export const WORKFLOW_CONCURRENCY_AUTO_GROWTH_FACTOR = 2;

/**
 * CPU-derived default concurrency. `availableParallelism` is injectable for tests (floor/cap cases).
 */
export function resolveWorkflowDefaultConcurrency(
  availableParallelism: () => number = osAvailableParallelism,
): number {
  return Math.max(
    WORKFLOW_DEFAULT_CONCURRENCY_FLOOR,
    Math.min(WORKFLOW_DEFAULT_CONCURRENCY_MAX, availableParallelism() - RESERVED_PARALLELISM),
  );
}

/**
 * Requested concurrency bound -> the bound effective for this run (docs/dynamic-workflow/concurrency.md "Two bounds on a run").
 *
 * **No ceiling**: above or below default, the number is honored — 40 requested means 40; provider capacity is the governor's
 // business. Absent / non-finite reads as "no bound of its own" = default concurrency; non-integers floor (fractional
 // in-flight asks are meaningless, and ceiling would quietly exceed the given number); floor 1.
 *
 * The submit-time bound and mid-flight retune **must** share one rule (else one `max_concurrency` yields two numbers via two paths),
 // and those paths live in run service and retune — so the rule lives here.
 */
export function normalizeRunConcurrency(
  requested: number | undefined,
  defaultConcurrency: number,
): number {
  if (requested === undefined || !Number.isFinite(requested)) return defaultConcurrency;
  return Math.max(1, Math.floor(requested));
}
