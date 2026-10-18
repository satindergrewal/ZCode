// ============================================================
// The **derived** actor tri-state (one rule of the workflowRuns reduction)
// ============================================================
// Pure: derived only from node and run state; no clock reads, no I/O.
//
// Why derived: engine Boundary C emits **no actor lifecycle events** beyond `actor-created`,
// so "is this subagent moving / waiting / done" has no event to carry it and can only be inferred from its nodes' phases and the run's
// terminal state. Re-run after every event that touches nodes or run.status.

import type { WorkflowRunActor, WorkflowRunState } from "./workflow-runs.js";

/**
 * The key joins with `\0`, not any printable char: siteId is an engine string, and `-` etc. would collide
 * ("a-1", 2) with ("a", "1-2"). (Written in source as the escape `\0`, not a raw NUL byte--the same runtime
 * string, but the file stays grep-visible as text.)
 */
function actorKey(siteId: string, ordinal: number): string {
  return `${siteId}\0${ordinal}`;
}

/**
 * Tri-state derivation:
 *   running   a node in executing / repairing / nudged (model request sent, in flight)
 *   waiting   a live node (queued / dispatched / waiting), or no nodes yet and the run not terminal
 *   completed otherwise: all nodes settled, or the run terminal (terminality overrides all: nobody in a terminal run
 *             is still running or waiting, even if a node's settled event has not landed)
 * `dispatched` counts as waiting, not running: it is the brief "session ready, first request not yet admitted" phase;
 * really-running is node-executing's word.
 *
 * Unchanged actors keep their **reference**--key-level deltas test by reference first, and fresh objects here
 * would put the whole actors table on the wire per node event.
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
