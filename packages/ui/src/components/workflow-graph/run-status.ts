import type {
  WorkflowRunActor,
  WorkflowRunNode,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import { phaseBinder } from "./instance-phases.js";
import {
  isSyntheticLaneId,
  type StepRunStatus,
  type StepStatusTable,
  type WorkflowCausalityGraphData,
} from "./types.js";

/**
 * Pure selectors for the live overlay view (live view v1).
 *
 * This view deliberately does **not** expand into an instance graph: it is the static
 * causality graph as submitted, plus a status decoration layer. The strongest property
 * this buys: **the graph's node and edge sets never change while running** — monotone
 * ranks and no re-layout hold by construction, because the overlay never moves cards.
 * The single cost: one static step maps to N runtime instances (loops / fan-out), so
 * statuses must collapse — "round 3 failed, round 4 is running" is the one sentence a
 * single card cannot say.
 */
export interface WorkflowRunOverlay {
  /**
   * Statuses keyed by the graph's step id. Partial: steps with no observed instance have
   * **no entry**. "Every step has a value" was a promise to the retired React Flow board
   * (every card gets decorated); no consumer needs it now, and it would make "never ran"
   * and "queued" share one `pending`.
   */
  statuses: StepStatusTable;
  /** Whether hand-off edges out of running steps animate. */
  animatedEdges: boolean;
}

/**
 * Engine phase -> four-value `StepRunStatus`.
 *
 * The vocabulary is written from the phases the engine **actually emits**: queued /
 * dispatched / executing / waiting / repairing / nudged / settled. `executing` /
 * `waiting` are the driver's observations: the model request truly went out / is waiting
 * on a process-level slot or backoff.
 *
 * Folding queued / dispatched / waiting into pending is intentional: all three mean "no
 * request is running at the provider yet" — FIFO and per-run-cap waits, session ready
 * but the first request not yet admitted, gate queues or backoff. Actually-moving is
 * `executing`'s job.
 */
export function statusOfRunNode(node: WorkflowRunNode): StepRunStatus {
  switch (node.phase) {
    case "executing":
    case "repairing":
    case "nudged":
      return "running";
    case "settled":
      // Failure and cancellation both draw as failed (their journal semantics differ, but
      // the overlay vocabulary has four values). A missing outcome is unreachable in the
      // engine (settled always carries one); if it ever appears, treat it as "finished":
      // a false pending (never started) is worse than a missing color, and a false
      // failed raises false alarms.
      return node.outcome === "failed" || node.outcome === "cancelled" ? "failed" : "done";
    default:
      return "pending";
  }
}

/**
 * The one collapse: a multiset of instance statuses -> a single status.
 *
 *   - empty set -> `undefined`. Absence is not a status and the collapse invents none;
 *     consumers resolve absence via the control flow.
 *   - any running -> running. **Deliberately preferred over failed**: the reader's first
 *     question is "is it still moving?".
 *   - both settled and queued present -> running: started, not finished. The old rule
 *     read this as pending ("not started") — the same confusion in different clothes.
 *   - all queued -> pending.
 *   - all settled: any failed -> failed, else done.
 *
 * All rules are any-checks, so fold-by-site-then-participant equals fold-by-instance
 * directly — the two-level collapse cannot drift. Inputs may be instance statuses
 * (`statusOfRunNode`) or site statuses (this function's output); the vocabulary is the same.
 */
export function aggregateRunStatuses(
  statuses: readonly StepRunStatus[],
): StepRunStatus | undefined {
  if (statuses.length === 0) return undefined;
  if (statuses.includes("running")) return "running";
  const queued = statuses.includes("pending");
  const settled = statuses.some((status) => status === "done" || status === "failed");
  if (queued) return settled ? "running" : "pending";
  return statuses.includes("failed") ? "failed" : "done";
}

/**
 * The status intake of one card. `lane` exists only on may-set-expanded copies — it is
 * the card's **entire** claim ("this ask may run on that lane"), so instances on other
 * lanes are none of its business. `phase` is the phase-copy's equivalent claim ("this
 * ask was issued inside that phase"): instances born in other phases are none of its
 * business either.
 */
interface OverlayTarget {
  instances: StepRunStatus[];
  lane?: string;
  phase?: string;
}

export function workflowRunOverlay(
  run: WorkflowRunState | undefined,
  graph: WorkflowCausalityGraphData,
): WorkflowRunOverlay {
  // No run means a static render: return an empty table, not an all-pending one, so
  // components keep their "zero runtime data" look.
  if (!run) return { statuses: {}, animatedEdges: false };

  // The correlation key is the **site id**, not the card id: after may-set lane expansion
  // a site maps to one card per candidate lane, and after phase copies one card per
  // claimed phase (`ask#1~phase#3`); `source` records the site expanded from. Both copy
  // kinds collect by it, then narrow by their own claim — lane copies by the actor's
  // lane, phase copies by the instance's birth phase (`phaseName`, the same
  // `phaseBinder` as card binding and station observation). Drop the latter and one
  // shared helper dispatching subagents from five phases lights all five stations on the
  // first movement.
  const byStepId = new Map<string, StepRunStatus[]>();
  const targetsBySiteId = new Map<string, OverlayTarget[]>();
  for (const step of graph.steps) {
    const instances: StepRunStatus[] = [];
    byStepId.set(step.id, instances);
    // Steps without `source` get **no** lane narrowing: a fallback single card (>4
    // candidates, or unknown among them) draws at lanes[0] while instances may land on
    // any candidate — narrowing would permadim such cards.
    const target: OverlayTarget = {
      instances,
      ...(step.source === undefined ? {} : { lane: step.lane }),
      ...(step.phase === undefined ? {} : { phase: step.phase }),
    };
    const siteId = step.source ?? step.id;
    const targets = targetsBySiteId.get(siteId);
    if (targets === undefined) targetsBySiteId.set(siteId, [target]);
    else targets.push(target);
  }

  const binder = phaseBinder(graph, run);
  for (const node of run.nodes) {
    // Site ids absent from the graph are ignored: the overlay never adds or removes nodes.
    const targets = targetsBySiteId.get(node.siteId);
    if (targets === undefined) continue;
    const status = statusOfRunNode(node);
    for (const target of targets) {
      // Instances without actorSiteId enter **every** copy of the site: a degeneration
      // to the old single card's over-lighting, not a dead graph — a liveness hint may
      // light one cell too many, never zero.
      const belongsToOtherLane =
        target.lane !== undefined &&
        node.actorSiteId !== undefined &&
        node.actorSiteId !== target.lane;
      if (belongsToOtherLane) continue;
      // Same for the birth phase: stamp-less instances (old runs, pre-stamp births) are
      // placed by the binder's standing rules — vocabulary-less runs match every phase,
      // degenerating to today's over-lighting rather than a dark card.
      const belongsToOtherPhase =
        target.phase !== undefined && !binder.has(target.phase, node.phaseName);
      if (belongsToOtherPhase) continue;
      target.instances.push(status);
    }
  }

  const statuses: StepStatusTable = {};
  let anyRunning = false;
  for (const [stepId, instanceStatuses] of byStepId) {
    const status = aggregateRunStatuses(instanceStatuses);
    if (status === undefined) continue;
    statuses[stepId] = status;
    if (status === "running") anyRunning = true;
  }

  return { statuses, animatedEdges: anyRunning };
}

/**
 * Lane -> the actor instances on it (phase 5's transcript drill-down: one instance opens
 * directly, several raise a picker).
 *
 * The lane site id is identity; the display name is presentation only (the causality-graph
 * naming contract). `workspace` and `unknown` are synthetic lanes with no sessions, so
 * this is always empty — world-read steps get a selected state but no drill-down.
 */
export function workflowRunActorsForLane(
  run: WorkflowRunState | undefined,
  laneId: string,
): WorkflowRunActor[] {
  if (!run || isSyntheticLaneId(laneId)) return [];
  return run.actors
    .filter((actor) => actor.siteId === laneId)
    .sort((left, right) => left.ordinal - right.ordinal);
}
