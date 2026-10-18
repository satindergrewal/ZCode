import type { AnalysisCore } from "./core.js";
import { UNPHASED_ID } from "./constants.js";
import type { ControlFlowGraph } from "./flow-graph.js";

/**
 * The compile-time table of site -> birth phase **name**
 * (docs/analysis.md "Phases"; the engine side see execution-engine.md
 * "Identity: sites, ordinals, phases").
 *
 * The birth phase stamp the engine gives an instance used to read only "the last marker the
 * script passed" — fine for a single-threaded narrative, but once two futures, each opening with
 * its own marker, run concurrently, a producer's second ask after its first await got stamped
 * with the last marker executed, i.e. the consumer's segment. The stamp is therefore
 * **lexically first**: the analyzer's temporal walk already records each issue's phase at that
 * point under inlining semantics (helpers inlined at the call site, callbacks at registration,
 * future bodies at the call); when all of a site's issues (all spawns, for actor sites) land in
 * **one named phase**, that phase is its birth — matching the graph the confirmation dialog
 * shows the user. Sites landing in two phases (a helper called twice) or only in unphased stay
 * out of the table; the engine falls back to the dynamic current phase for them.
 *
 * Sourced from the trace, not the projected graph: the projection phase-copies steps that span
 * phases, while what matters here is exactly "is it unique". The name (not the phase id) goes
 * into the table, because both the engine's stamp and the `phase-entered` event use the author's
 * verbatim word.
 */
/**
 * The run's declared phase table (execution-engine.md "run-launched", `phaseNames` / `holes`):
 * the **named** phases of the control flow projection's phase table, in order — holes stand in
 * their position by name — plus the aligned index table `holes` marking which of them are **open
 * holes**, so the sidebar mini-rail draws those stations dashed. Without a phase vocabulary both
 * are empty arrays (submitters drop the fields entirely on that).
 *
 * Same source as `createWorkflowPhaseNames` (contracts) — the control flow projection's phase
 * table, marker-only phases included — so the table recomputed after a fill aligns with the
 * launch-time table under one rule.
 */
export function collectPhaseNames(flow: Pick<ControlFlowGraph, "phases" | "holes"> | undefined): {
  phaseNames: string[];
  holes: number[];
} {
  const phaseNames: string[] = [];
  const holes: number[] = [];
  const open = new Set((flow?.holes ?? []).map((hole) => hole.siteId));
  for (const phase of flow?.phases ?? []) {
    if (phase.name === undefined) continue;
    if (open.has(phase.id)) holes.push(phaseNames.length);
    phaseNames.push(phase.name);
  }
  return { holes, phaseNames };
}

export function collectSitePhases(core: AnalysisCore): ReadonlyMap<string, string> {
  const nameOf = new Map<string, string>();
  for (const phase of core.trace.phases) nameOf.set(phase.id, phase.name);

  const claims = new Map<string, Set<string>>();
  const claim = (site: string, phase: string): void => {
    const set = claims.get(site);
    if (set === undefined) claims.set(site, new Set([phase]));
    else set.add(phase);
  };
  for (const event of core.trace.events) {
    if (event.at === "issue") claim(event.step, event.phase);
    else if (event.at === "actor") claim(event.actor, event.phase);
  }

  const table = new Map<string, string>();
  for (const [site, phases] of claims) {
    if (phases.size !== 1) continue;
    const [phase] = phases;
    if (phase === undefined || phase === UNPHASED_ID) continue;
    const name = nameOf.get(phase);
    if (name !== undefined) table.set(site, name);
  }
  return table;
}
