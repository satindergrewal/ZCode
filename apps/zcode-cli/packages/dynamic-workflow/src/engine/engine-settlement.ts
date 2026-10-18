/**
 * engine.ts sat at oxlint's max-lines cap (400); the run's three terminal paths
 * (completed / stopped / errored) and their shared finishRun
 * live here; the public surface still exports from engine.ts.
 *
 * Free functions read and write engine state via the {@link EngineState} seam; WorkflowEngine's complete / stop /
 * failRun are thin delegates. First-wins is guarded by isRunSettled() on the first line of every path.
 */

import type { EngineState } from "./engine-state.js";
import type { RunSettlementRecord, RunStatus, RunStopReason } from "./types.js";
import { WorkflowError } from "./types.js";

/**
 * The sandbox script returned a top-level artifact: settle completed.
 *
 * Asks may still be in flight when the script returns (Promise.race losers, unawaited asks). They are aborted exactly as in the cancel
 * path: driver-side cancelAsk, the deferred rejects with Cancelled, node-settled cancelled emitted.
 * Not aborting costs threefold: the scheduler's liveNodes holds the node forever, the driver-side turn keeps burning tokens,
 * and one node-dispatched in the event log never sees its node-settled.
 */
export function settleCompleted(state: EngineState, artifact: unknown): void {
  if (state.isRunSettled()) return;
  state.markSettled();
  state.abortInFlight(
    new WorkflowError("Cancelled", "Run completed; in-flight subagent tasks were abandoned."),
    true,
  );
  // The artifact persists in the same stroke as the terminal state. Two writes would open a completed-but-artifact-lost crash window, and the journal
  // row is the artifact's only durable home (the run-settled event deliberately stays narrow).
  finishRun(state, "completed", { result: artifact });
  state.resolveSettled({ status: "completed", artifact });
}

/**
 * External stop: abort in-flight asks (the deferred rejects Cancelled, node-settled cancelled emitted); the run
 * settles stopped with reason; finished journal rows are kept (resumable). All four reasons take one path:
 * user / model (the initiator the cancel entry passes in), interrupted (a harness sandbox failure),
 * provider (a deterministic model-side error the driver reports via stopRun). error is present only for the last two.
 */
export function settleStopped(
  state: EngineState,
  reason: RunStopReason,
  error?: WorkflowError,
  supersededBy?: string,
): void {
  if (state.isRunSettled()) return;
  state.markSettled();
  state.abortInFlight(new WorkflowError("Cancelled", "Run stopped."), true);
  // The successor id and reason of superseded persist **in the same stroke**:
  // the stopped envelope is rewritten whole; two writes would open a superseded-but-by-unknown window.
  finishRun(state, "stopped", {
    stopReason: reason,
    ...(supersededBy === undefined ? {} : { supersededBy }),
    ...(error === undefined ? {} : { failure: error.toJSON() }),
  });
  state.resolveSettled({
    status: "stopped",
    reason,
    ...(supersededBy === undefined ? {} : { supersededBy }),
    ...(error === undefined ? {} : { error }),
  });
}

/** Run-level failure (the script's fault): abort in-flight asks (rejected with the run error); the run settles errored. */
export function settleFailed(state: EngineState, error: WorkflowError): void {
  if (state.isRunSettled()) return;
  state.markSettled(error);
  state.abortInFlight(error, false);
  finishRun(state, "errored", { failure: error.toJSON() });
  state.resolveSettled({ status: "errored", error });
}

/**
 * The run-settled event carries only status, optional stopReason and error: artifacts bypass the high-frequency progress pipeline and live only in the journal.
 *
 * All three terminal paths pass here, so the driver's dispose happens exactly once and first-wins is natural. It runs
 * after run-settled: dispose is post-settlement resource release (the actor runtime's shutdown chain), not part of
 * settlement; the event log gains no row for it.
 */
function finishRun(state: EngineState, status: RunStatus, settlement?: RunSettlementRecord): void {
  state.journal.updateRunStatus(state.runId, status, settlement);
  state.record({
    type: "run-settled",
    status,
    ...(settlement?.stopReason === undefined ? {} : { stopReason: settlement.stopReason }),
    ...(settlement?.supersededBy === undefined ? {} : { supersededBy: settlement.supersededBy }),
    ...(settlement?.failure === undefined ? {} : { error: settlement.failure }),
  });
  state.driver.dispose?.();
}
