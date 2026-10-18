import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { PhaseBinder } from "@/components/workflow-graph/instance-phases.js";
import { phaseNameMatches } from "@/components/workflow-graph/phase-name.js";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";

/**
 * What one station observed: the instances landing on this station, plus the **off-chart** entries spent here.
 *
 * Like timeline-bands.ts, computes display models only — no React, DOM, or clock.
 */

export interface ObservedPhase {
  visited: boolean;
  rounds: number;
  settled: number;
  observed: number;
  /** Control flow entered this station (an entry record exists in `run.phases`). */
  entered: boolean;
}

/**
 * The ones the reduction cannot list (`run.unlistedByPhase`). `actors` are subagents born at this
 * station and currently off the table — rejected at birth, evicted while queued, evicted after finishing; they have no pill,
 * no face, no transcript; `settled` is the known-finished subset, `failed ⊆ settled`; `nodesSettled` is the number of off-chart
 * **nodes** recorded as settled on this slot. Absent = not one was lost at this station.
 */
export interface StationUnlisted {
  actors: number;
  settled: number;
  failed: number;
  nodesSettled: number;
}

/**
 * Off-chart slots are filed by **birth-phase stamp**: bound to pills, the same `phaseBinder` as the station observation — one assignment,
 * not a broadcast. The slot without `phaseName` therefore lands on the unnamed station (same rule as stamp-less instances) instead of
 * picking an arbitrary station. Two stations re-entered under one name each take their share, matching the node algorithm.
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
    // Zeroed subkeys stay absent on the wire: absence means "zero", not "unknown" — the not-yet-finished ones therefore remain pending.
    total.settled += bucket.actorsSettled ?? 0;
    total.failed += bucket.actorsFailed ?? 0;
    total.nodesSettled += bucket.settled;
  }
  return total.actors === 0 && total.settled === 0 && total.nodesSettled === 0 ? undefined : total;
}

type WorkflowRunPhaseEntry = NonNullable<WorkflowRunState["phases"]>[number];

/**
 * A station's entry records: matched by name (`phaseNameMatches`, the rule shared with instance binding from phase-name.ts). Under one 128-char
 * prefix there may be two records; the exact one wins.
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
 * Station set: member steps' `source ?? id` — the may-set copy reports the station id, the same key
 * as run-status.ts's association; dropping `source` would leave copy stations "not reached" forever.
 */
export function siteIdsOf(
  steps: readonly WorkflowCausalityGraphData["steps"][number][],
): Set<string> {
  return new Set(steps.map((step) => step.source ?? step.id));
}

/**
 * Nodes a station observed: the same station is not enough — when k phases re-enter one station, k cards share the station id, so nodes must
 * also fall onto this station by the instance's birth stamp (`belongs`), else visited / rounds /
 * fraction all inflate k-fold.
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
  // Off-chart settled **nodes**: raise numerator and denominator together. They really ran; only their detail lives on the bound — undercounting the
  // denominator turns "300/300" into "1/1", a false sentence; visited / rounds stay put, those two speak for control flow.
  result.observed += unlisted?.nodesSettled ?? 0;
  result.settled += unlisted?.nodesSettled ?? 0;
  // Entry records: reached = a node landed here ∨ control flow entered; rounds take the larger of the two (a single-phase loop's second
  // pass is counted by nodes; a zero-member station's second pass is known only from the entry record).
  if (entry !== undefined) {
    result.entered = true;
    result.visited = true;
    if (entry.rounds > result.rounds) result.rounds = entry.rounds;
  }
  return result;
}
