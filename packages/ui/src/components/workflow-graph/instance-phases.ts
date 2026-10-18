import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { phaseNameMatches } from "./phase-name.js";
import type { WorkflowCausalityGraphData } from "./types.js";

/**
 * Home phase of a runtime instance.
 *
 * Static may-set copies are keyed by phase (`ask#1~phase#3`); runtime instances carry the
 * same coordinates — the phase name (`phaseName`) recorded when the engine minted the
 * ordinal. Which display phases a stamp lands on is decided by exactly one rule, defined
 * here and shared by card binding (participant-model.ts) and station observation
 * (timeline-model.ts): a **partition**, not a broadcast.
 */

/** Did this run ever speak in phases: any actor/node carrying a stamp. Old CLIs, old runs, and unstamped scripts do not. */
export function runHasPhaseVocabulary(run: WorkflowRunState | undefined): boolean {
  if (run === undefined) return false;
  return (
    run.actors.some((actor) => actor.phaseName !== undefined) ||
    run.nodes.some((node) => node.phaseName !== undefined)
  );
}

/**
 * Home phase set of a stamp:
 *   - stamped -> the display phases matching the name (`phaseNameMatches`; the truncation
 *     fallback lives there);
 *   - unstamped and the run has a vocabulary -> the **unphased** display phase
 *     (`unphased` / implicit `workflow`): steps before the first stamp are analyzed there,
 *     and "no stamp <=> unphased" is one fact seen from two sides;
 *   - unstamped and no vocabulary -> every phase (current behavior).
 * An empty branch result falls back to every phase: prefer a duplicate pin over hiding a
 * live subagent.
 */
export function phasesOf(
  phaseName: string | undefined,
  graph: WorkflowCausalityGraphData,
  runHasVocabulary: boolean,
): Set<string> {
  const phases = graph.phases ?? [];
  const all = () => new Set(phases.map((phase) => phase.id));
  if (phaseName === undefined && !runHasVocabulary) return all();
  const matched = phases.filter((phase) =>
    phaseName === undefined ? phase.name === undefined : phaseNameMatches(phase.name, phaseName),
  );
  return matched.length === 0 ? all() : new Set(matched.map((phase) => phase.id));
}

/** Per-view resolver: the vocabulary check and each stamp's result are computed once (every node asks). */
export interface PhaseBinder {
  phasesOf(phaseName: string | undefined): ReadonlySet<string>;
  /** Does this stamp belong to this station / card? */
  has(phaseId: string, phaseName: string | undefined): boolean;
}

export function phaseBinder(
  graph: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
): PhaseBinder {
  const vocabulary = runHasPhaseVocabulary(run);
  // The graph has no phase vocabulary yet (a raw unstamped script, before the UI
  // synthesizes implicit phases): no coordinates to partition by, so everything counts as
  // belonging — an always-empty home set would wipe every card's instances.
  const ungrouped = (graph.phases ?? []).length === 0;
  const cache = new Map<string | undefined, ReadonlySet<string>>();
  const resolve = (phaseName: string | undefined): ReadonlySet<string> => {
    const hit = cache.get(phaseName);
    if (hit !== undefined) return hit;
    const phases = phasesOf(phaseName, graph, vocabulary);
    cache.set(phaseName, phases);
    return phases;
  };
  return {
    has: (phaseId, phaseName) => ungrouped || resolve(phaseName).has(phaseId),
    phasesOf: resolve,
  };
}
