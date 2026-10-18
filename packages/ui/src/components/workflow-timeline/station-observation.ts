import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { PhaseBinder } from "@/components/workflow-graph/instance-phases.js";
import { phaseNameMatches } from "@/components/workflow-graph/phase-name.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";

/**
 * What one station observed (docs/dynamic-workflow/presentation.md "The timeline model", "Past six
 * participants"): the instances that landed on the station's site, plus the **off-table** entries spent
 * at this station.
 *
 * Lives outside the timeline model, for the same reason as timeline-bands.ts (the main file's max-lines
 * cap) and under the same discipline: pure functions, no React, no DOM, no time.
 */

export interface ObservedPhase {
  visited: boolean;
  rounds: number;
  settled: number;
  observed: number;
  /** Control flow entered this station (`run.phases` records the entry). */
  entered: boolean;
}

/**
 * The ones reduction cannot list (`run.unlistedByPhase`, presentation.md "Reduction"). `actors` are
 * subagents born at this station and no longer in the table — rejected at birth, culled in the queue,
 * culled after finishing; no pill, no face, no transcript. `settled` is the known-finished subset,
 * `failed ⊆ settled`; `nodesSettled` counts the off-table settled **nodes** recorded here.
 * Absent means this station lost none.
 */
export interface StationUnlisted {
  actors: number;
  settled: number;
  failed: number;
  nodesSettled: number;
}

/**
 * The off-table bucket files by **birth-phase stamp**: the same `phaseBinder` as pill binding and
 * station observation — a partition, not a broadcast. A bucket without `phaseName` therefore lands on
 * the unnamed station (same rule as stamp-less instances) instead of picking one at random. Two
 * same-named re-entries each take their share, matching the node algorithm.
 */
export function stationUnlisted(
  run: WorkflowRunState | undefined,
  binder: PhaseBinder,
  phaseId: string,
): StationUnlisted | undefined {
  const buckets = run?.unlistedByPhase;
  if (buckets === undefined) return undefined;
  const total: StationUnlisted = { actors: 0, failed: 0, nodesSettled: 0, settled: 0 };
  for (const bucket of buckets) {
    if (!binder.has(phaseId, bucket.phaseName)) continue;
    total.actors += bucket.actors;
    // Zeroed subkeys are absent on the wire: absent means none, not unknown — unfinished ones stay pending.
    total.settled += bucket.actorsSettled ?? 0;
    total.failed += bucket.actorsFailed ?? 0;
    total.nodesSettled += bucket.settled;
  }
  return total.actors === 0 && total.settled === 0 && total.nodesSettled === 0 ? undefined : total;
}

type WorkflowRunPhaseEntry = NonNullable<WorkflowRunState["phases"]>[number];

/**
 * A station's entry records: matched by name (`phaseNameMatches`, docs/dynamic-workflow/presentation.md
 * postscript 2026-09-05; rule extracted to phase-name.ts 2026-09-09, shared with instance binding). One
 * 128-char prefix can hold two records; the exact one wins.
 */
export function phaseEntryFor(
  run: WorkflowRunState | undefined,
  name: string | undefined,
): WorkflowRunPhaseEntry | undefined {
  const entries = run?.phases;
  if (entries === undefined || name === undefined) return undefined;
  return (
    entries.find((entry) => entry.name === name) ??
    entries.find((entry) => phaseNameMatches(name, entry.name))
  );
}

/**
 * Site set: member steps' `source ?? id` — may-set copies report the site id, the same key run-status.ts
 * correlates by; dropping `source` would leave copy stations not-arrived forever.
 */
export function siteIdsOf(
  steps: readonly WorkflowCausalityGraphData["steps"][number][],
): Set<string> {
  return new Set(steps.map((step) => step.source ?? step.id));
}

/**
 * Nodes a station observed: the same site is not enough — one site re-entered by k phases shares its id
 * across k cards, so nodes must also land here by the instance's birth stamp (`belongs`, postscript
 * 2026-09-09 "station observation"), or visited / rounds / fraction all inflate k-fold.
 */
export function observePhase(
  run: WorkflowRunState | undefined,
  siteIds: ReadonlySet<string>,
  entry: WorkflowRunPhaseEntry | undefined,
  belongs: (node: WorkflowRunState["nodes"][number]) => boolean,
  unlisted: StationUnlisted | undefined,
): ObservedPhase {
  const result: ObservedPhase = {
    entered: false,
    observed: 0,
    rounds: 0,
    settled: 0,
    visited: false,
  };
  if (run === undefined) return result;
  for (const node of run.nodes) {
    if (!siteIds.has(node.siteId) || !belongs(node)) continue;
    result.visited = true;
    result.observed += 1;
    if (node.ordinal > result.rounds) result.rounds = node.ordinal;
    if (node.phase === "settled") result.settled += 1;
  }
  // Off-table settled **nodes**: raise numerator and denominator together. They really ran; their detail
  // lives in the pane. Under-counting the denominator turns 300/300 into 1/1 — a false statement.
  // visited / rounds stay put; those speak for control flow.
  result.observed += unlisted?.nodesSettled ?? 0;
  result.settled += unlisted?.nodesSettled ?? 0;
  // Entry records: visited = a node landed here or control flow entered; rounds take the larger of the
  // two (a single-phase loop's second round is counted from nodes; a member-less station's second round
  // is known only from entry records).
  if (entry !== undefined) {
    result.entered = true;
    result.visited = true;
    if (entry.rounds > result.rounds) result.rounds = entry.rounds;
  }
  return result;
}
