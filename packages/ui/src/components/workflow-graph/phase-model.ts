import { collapseStatuses, hasPhaseVocabulary } from "./participant-model.js";
import type {
  StepRunStatus,
  StepStatusTable,
  WorkflowCausalityGraphData,
  WorkflowPhaseData,
  WorkflowStepData,
} from "./types.js";

/**
 * Pure selectors for the phase layer. A phase is a **quotient layer above** the graph:
 * nothing here mutates the graph; steps are only bucketed by `Step.phase`. The second
 * layer's (participants and hand-offs) selectors live in participant-model.ts; the old
 * drill-down filter (`filterGraphToPhase`) and roster (`phaseActors`) retired with
 * step-level rendering.
 *
 * No React, no DOM.
 */

export { hasPhaseVocabulary };

/**
 * Phase id -> member steps, bucketed in `phases` order (the phase table's order is the
 * on-screen before/after semantics). Cross-phase copies compute their own phase's members.
 */
export function phaseMembers(graph: WorkflowCausalityGraphData): Map<string, WorkflowStepData[]> {
  const members = new Map<string, WorkflowStepData[]>(
    (graph.phases ?? []).map((phase) => [phase.id, []]),
  );
  for (const step of graph.steps) {
    if (step.phase === undefined) continue;
    members.get(step.phase)?.push(step);
  }
  return members;
}

/**
 * Re-collapse member step statuses (lattice in `aggregateRunStatuses`): members without
 * an entry do not participate; no entries at all = static render or an entirely
 * unobserved station, returning undefined.
 */
export function collapsePhaseStatus(
  members: readonly WorkflowStepData[],
  statuses: StepStatusTable | undefined,
): StepRunStatus | undefined {
  return collapseStatuses(
    members.map((step) => step.id),
    statuses,
  );
}

/** Look up a phase by id; the inspector and host use it for display-name material. */
export function findPhase(
  graph: WorkflowCausalityGraphData,
  phaseId: string,
): WorkflowPhaseData | undefined {
  return (graph.phases ?? []).find((phase) => phase.id === phaseId);
}
