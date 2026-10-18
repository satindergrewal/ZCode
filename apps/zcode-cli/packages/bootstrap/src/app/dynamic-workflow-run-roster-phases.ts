// ============================================================
// The situation snapshot's **phase table**: declared sites + visited sites
// ============================================================
// Names and phases read the same reducer state as the run panel
// (`run.phaseNames` / `run.phases` / `run.currentPhase` / `run.nodes`); instants read the
// event index -- the same division of labor documented in the -roster-events.ts header.
//
// Why node counts come from the **reducer state**, not the journal's node rows: phase coordinates (`phaseName`) live only in reducer state
// (the engine stamps them on birth events; rows carry no such column), so joining on rows would drop every node the reducer
// state holds but rows do not; the reducer state also holds **not-yet-rowed** queued nodes -- exactly what "how many are running in the current phase" counts.

import type { DynamicWorkflowRunPhaseView } from "@zcode/contracts";
import type { WorkflowRunNode, WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import type { RosterEventIndex } from "./dynamic-workflow-run-roster-events.js";

/** Nodes other than world-read / world-run count as asks: `kind` rides only on the birth event; absent means unknown. */
const WORLD_NODE_KIND = "world-read";

/**
  * Phase table: declared phases in declaration order, then visited-but-undeclared ones (by first entry).
 *
  * **Returns undefined when nothing was declared and none entered**: such a run has no phase concept,
  * and an empty array would read as "the phase table is empty" -- a different statement.
 */
export function buildPhaseViews(input: {
  run: WorkflowRunState | undefined;
  index: RosterEventIndex;
  terminal: boolean;
}): DynamicWorkflowRunPhaseView[] | undefined {
  const { run, index, terminal } = input;
  const declared = run?.phaseNames ?? [];
  const entered = run?.phases ?? [];
  if (declared.length === 0 && entered.length === 0) return undefined;

  const names = [...declared];
  const seen = new Set(declared);
  for (const phase of entered) {
    if (seen.has(phase.name)) continue;
    seen.add(phase.name);
    names.push(phase.name);
  }

  const nodes = run?.nodes ?? [];
  return names.map((name) => {
    const rounds = entered.find((phase) => phase.name === name)?.rounds ?? 0;
    const owned = nodes.filter((node) => node.phaseName === name);
    const settled = owned.filter((node) => node.phase === "settled").length;
    const running = owned.length - settled;
    const trace = index.phases.get(name);
    return {
      name,
      state: phaseStateOf({ rounds, terminal, owned, isCurrent: run?.currentPhase === name }),
      rounds,
      nodesSettled: settled,
      nodesRunning: running,
      ...(trace?.enteredAt === undefined ? {} : { enteredAt: trace.enteredAt }),
      ...(trace?.exitedAt === undefined ? {} : { exitedAt: trace.exitedAt }),
    };
  });
}

/**
  * A phase's situation (the four words on `DynamicWorkflowRunPhaseState`).
 *
  * `unfinished` **holds only for terminal runs**: while the run lives, an in-flight ask in a non-current phase is normal
  * parallel branching, not a dangling tail -- `nodesRunning` already reports how many are in flight.
 */
function phaseStateOf(input: {
  rounds: number;
  terminal: boolean;
  owned: readonly WorkflowRunNode[];
  isCurrent: boolean;
}): DynamicWorkflowRunPhaseView["state"] {
  const { rounds, terminal, owned, isCurrent } = input;
  if (rounds === 0) return "ahead";
  if (terminal) {
    const leftover = owned.some(
      (node) => node.phase !== "settled" && node.kind !== WORLD_NODE_KIND,
    );
    return leftover ? "unfinished" : "done";
  }
  return isCurrent ? "current" : "done";
}
