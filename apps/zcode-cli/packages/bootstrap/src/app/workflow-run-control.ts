// ============================================================
// The run's live control plane: one command lands on both the engine and the seat gate
// ============================================================
// docs/dynamic-workflow/concurrency.md "The control path". A live run's two execution points live in different
// different layers -- the scheduler in the engine (`@zcode/dynamic-workflow`), the seat gate below the driver (this package) -- while the
// command-issuing side (run service's `retuneConcurrency`) reaches neither: the engine exists only after the harness
// assembles the subprocess, and the gate is created by launch.
//
// So the run service first puts an **empty** handle into the registry entry, and each side wires itself up at birth:
// the harness gets `bind(engine)` (handed in through the same seam as `signal`), launch gets `bindSeatGate(gate)`.
// The handle itself decides nothing: liveness, no-op semantics, and persistence live in the engine's `setMaxConcurrency`; the gate only
// follows once the engine says "really changed this time" -- the two execution points cannot end up with different bounds.
//
// Ordering is load-bearing: **engine first**. The engine's boolean is the verdict for this command (settled / value unchanged => false, nothing
// happens); if the gate swapped the bound first, a settled run would keep an in-memory bound inconsistent with the journal row.

import type { FillHoleResult, HoleFill, OpenHole } from "@zcode/dynamic-workflow";
import type { RunControlBinding } from "@zcode/dynamic-workflow-runtime";
import type { WorkflowConcurrencyPort } from "./workflow-concurrency-governor.js";
import type { WorkflowRunSeatGate } from "./workflow-seat-gate.js";

export interface WorkflowRunControl extends RunControlBinding {
  /**
   * Retunes this run's own concurrency bound in place. Returns **whether anything really changed**: `false` means nothing happened -- engine not
   * attached yet (the microtasks before launch), run already settled, or the new value equals the current one. Callers fall back accordingly.
   */
  setMaxConcurrency(maxConcurrency: number): boolean;
  /**
   * Attached after launch builds the seat gate; absent, the run's only execution point is the scheduler. Launch passes not the gate itself
   // but "raise the gate bound + re-register this run's bound on the governor" (docs/dynamic-workflow/
   // concurrency.md "The control path"), so one retune moves gate and growth limit together.
   */
  bindSeatGate(gate: Pick<WorkflowRunSeatGate, "setLimit">): void;
  /**
   * Delivers the valid script's body to a waiting hole (docs/execution-engine.md "The engine's part").
   // Returns `undefined` while no engine is attached — same meaning as setMaxConcurrency's false: no engine to command this instant;
   // the caller (fill service) reports hole_not_waiting. The engine is the hole's only execution point; the gate plays no part.
   */
  fillHole(fill: HoleFill): FillHoleResult | undefined;
  /**
   * The hole the engine is parked at (the only source of the snapshot's `waiting`, docs/execution-engine.md "The run
   // snapshot"). `undefined` while no engine is attached — to the read face, same as "no engine waiting".
   */
  openHoles(): readonly OpenHole[] | undefined;
}

/** The engine slice the control face holds: two commands (bound, fill) and one query (parked hole). */
type BoundEngine = Parameters<RunControlBinding["bind"]>[0];

export function createWorkflowRunControl(): WorkflowRunControl {
  let engine: BoundEngine | undefined;
  let seatGate: Pick<WorkflowRunSeatGate, "setLimit"> | undefined;
  return {
    bind: (bound) => {
      engine = bound;
    },
    fillHole: (fill) => engine?.fillHole(fill),
    openHoles: () => engine?.openHoles(),
    bindSeatGate: (gate) => {
      seatGate = gate;
    },
    setMaxConcurrency: (maxConcurrency) => {
      if (engine === undefined) return false;
      if (!engine.setMaxConcurrency(maxConcurrency)) return false;
      seatGate?.setLimit(maxConcurrency);
      return true;
    },
  };
}

/**
 * The handle handed to {@link WorkflowRunControl.bindSeatGate}: one retune raises the seat gate's bound and
 // re-registers the run's bound on the process governor (raising the growth cap of the key this run uses,
 // docs/dynamic-workflow/concurrency.md "The governor"). No governor means gate only.
 */
export function runBoundTarget(
  seatGate: Pick<WorkflowRunSeatGate, "setLimit">,
  concurrency: Pick<WorkflowConcurrencyPort, "setRunBound"> | undefined,
  runId: string,
): Pick<WorkflowRunSeatGate, "setLimit"> {
  return {
    setLimit: (limit) => {
      seatGate.setLimit(limit);
      concurrency?.setRunBound(runId, limit);
    },
  };
}
