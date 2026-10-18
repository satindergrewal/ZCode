// ============================================================
// The **derived** actor tri-state (one rule of the workflowRuns reduction)
// ============================================================
// Lives outside the reducer main file with workflow-runs-concurrency.ts / -phases.ts / -started.ts / -caps.ts
// for the same reason (the main file's max-lines gate), same discipline: pure, clockless, no IO.
//
// Why derived: Boundary C emits **no actor lifecycle events** beyond `actor-created`, so is this subagent
// running / waiting / done has no event to ride -- it follows from its nodes' phases and the run's terminal state.
// Re-run after every event that touches nodes or run.status.

import type { WorkflowRunActor, WorkflowRunState } from "./workflow-runs.js";

/**
 * Keys join with `\0`, never a printable char: siteId is engine-given, and a `-` would collide
 * ("a-1", 2) with ("a", "1-2"). (Source writes the escape `\0`, not a raw NUL byte -- same runtime
 * string, but the file stays textual to grep.)
 */
function actorKey(siteId: string, ordinal: number): string {
  return `${siteId}\0${ordinal}`;
}

/**
 * Tri-state derivation (docs/dynamic-workflow/concurrency.md, Protocol state):
 *   running   a node executing / repairing / nudged (model request sent, in flight)
 *   waiting   a live node (queued / dispatched / waiting), or no nodes yet and the run not terminal
 *   completed otherwise: every node settled, or the run terminal (terminal trumps: in a terminal run nobody
 *             is still running or waiting, however late a node's settled event)
 * `dispatched` counts as waiting, not running: the brief session-ready-request-not-admitted phase;
 * really-running is node-executing's word.
 *
 * Unchanged actors keep their **reference**: key-level deltas test by reference first, and fresh objects here
 * would ship the whole actors table on every node event.
 */
export function withDerivedWorkflowActorStatuses(run: WorkflowRunState): WorkflowRunState {
  const executing = new Set<string>();
  const live = new Set<string>();
  const owned = new Set<string>();
  for (const node of run.nodes) {
    if (node.actorSiteId === undefined || node.actorOrdinal === undefined) continue;
    const key = actorKey(node.actorSiteId, node.actorOrdinal);
    owned.add(key);
    switch (node.phase) {
      case "executing":
      case "repairing":
      case "nudged":
        executing.add(key);
        break;
      case "queued":
      case "dispatched":
      case "waiting":
        live.add(key);
        break;
      default:
        break;
    }
  }
  const runLive = run.status === "pending" || run.status === "running";
  return {
    ...run,
    actors: run.actors.map((actor) => {
      const key = actorKey(actor.siteId, actor.ordinal);
      const status: WorkflowRunActor["status"] = !runLive
        ? "completed"
        : executing.has(key)
          ? "running"
          : live.has(key) || !owned.has(key)
            ? "waiting"
            : "completed";
      return actor.status === status ? actor : { ...actor, status };
    }),
  };
}
