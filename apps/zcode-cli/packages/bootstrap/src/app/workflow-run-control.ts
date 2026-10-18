// ============================================================
// The run's live control plane: one command lands on both the engine and the seat gate
// ============================================================
// A running run has two execution points, and they live in
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

import type { RunControlBinding } from "@zcode/dynamic-workflow-runtime";
import type { WorkflowRunSeatGate } from "./workflow-seat-gate.js";

export interface WorkflowRunControl extends RunControlBinding {
  /**
      * Retunes this run's own concurrency bound in place. Returns **whether anything really changed**: `false` means nothing happened -- engine not
      * attached yet (the microtasks before launch), run already settled, or the new value equals the current one. Callers fall back accordingly.
   */
  setMaxConcurrency(maxConcurrency: number): boolean;
    /** Attached once launch has built the seat gate; missing means the scheduler is this run's only execution point. */
  bindSeatGate(gate: Pick<WorkflowRunSeatGate, "setLimit">): void;
}

export function createWorkflowRunControl(): WorkflowRunControl {
  let engine: { setMaxConcurrency(maxConcurrency: number): boolean } | undefined;
  let seatGate: Pick<WorkflowRunSeatGate, "setLimit"> | undefined;
  return {
    bind: (bound) => {
      engine = bound;
    },
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
