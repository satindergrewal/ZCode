/**
  * engine.ts sat at oxlint max-lines cap (400); the world-node (world-read / world-run)
  * admission-settlement paths and the amend-resume import-cache close/restore seams live here; the public surface still exports from engine.ts.
 *
  * Free functions read/write engine state via the EngineState seam; WorkflowEngine.worldRead is a thin delegate,
  // closing is triggered by the scheduler via SchedulerHost, restoration called in the engine constructor resume branch.
 */

import { canonicalJson, inputHash } from "./hash.js";
import { heldResolution } from "./replay-order.js";
import { boundWorldReadInput } from "./world-read-input.js";
import { hashMismatch } from "./scheduler.js";
import type { EngineState } from "./engine-state.js";
import type {
  InstanceRef,
  JournalStorePort,
  NodeKind,
  WorkflowErrorJson,
  WorldReadInput,
  WorldReadOp,
} from "./types.js";
import { refToString, WorkflowError } from "./types.js";

export function readWorld(
  state: EngineState,
  siteId: string,
  op: WorldReadOp,
  args: unknown[],
): Promise<unknown> {
  if (state.isRunSettled()) return Promise.reject(state.runError());
  const ordinal = state.nextOrdinal(siteId);
  const instance: InstanceRef = { siteId, ordinal };
    // inputHash covers op+args (not the single-arg form) -- a deliberate payload reshaping:
    // in journals written before multi-arg world-read, every world-read hit would mismatch and fail the run
    // loudly with InputHashMismatch. Acceptable: v1 resume already requires a byte-identical script
    // (script_hash); a facade predating multi-arg world-read is not a script anyone resumes.
    // Noted here because the failure appears in resume, far from this line.
  const hash = inputHash({ op, args });
    // The bounded op+args: written at admission together with the hash,
    // and carried through the settlement upsert verbatim -- putNode replaces whole rows; missing it once resets the column to NULL.
  const input = boundWorldReadInput(op, args);

  const recorded = state.journal.getNode(state.runId, siteId, ordinal);
  if (recorded !== undefined) {
    if (recorded.inputHash !== hash) {
      const err = hashMismatch(instance, recorded.inputHash, hash);
      state.failRun(err);
      return Promise.reject(err);
    }
        // Finished-hit short circuit (journalized world reads make resume immune to disk changes between run and resume).
        // The release passes the replay order gate: a world read inside one fan-out branch is likewise what another continuation awaits;
        // releasing in admission order would skew post-join ordinals.
    if (recorded.status === "completed") {
      return heldResolution(state.holdForReplay, instance, () => {
        state.record({ type: "node-settled", instance, outcome: "ok", cached: true });
        return recorded.result;
      });
    }
    if (recorded.status === "failed") {
      return heldResolution(state.holdForReplay, instance, () => {
        state.record({
          type: "node-settled",
          instance,
          outcome: "failed",
          cached: true,
          error: recorded.error,
        });
        throw WorkflowError.fromJSON(recorded.error!);
      });
    }
        // status running: crashed mid-execution; falls through to re-live below.
  }

    // The run op is an effect, not a read -- journaled as its own kind (world-run): same mechanism, honest audit face. Other ops stay world-read.
  const kind: NodeKind = op === "run" ? "world-run" : "world-read";

    // amend-resume: only when this run journal lacks the row does the import cache get a turn (journal replay always wins --
    // when the amended run itself resumes after a crash, consumed hits are already real rows; replaying them must not move the cursor).
    // A hit writes one completed row shaped like the settle path plus node-settled cached,
    // **without calling the driver**: a world-run effect is never silently replayed.
    // After the cache closes, stop asking the table (nor advancing the cursor): the command text is unchanged, but the world it reads
    // may have been rewritten by some live subagent.
  const imported = state.importClosed() ? undefined : state.importedWorld.take(hash);
  if (imported !== undefined) {
    state.journal.putNode({
      runId: state.runId,
      siteId,
      ordinal,
      kind,
      inputHash: hash,
      input,
      status: "completed",
      result: imported.result,
    });
    state.record({ type: "node-settled", instance, outcome: "ok", cached: true });
    return Promise.resolve(imported.result);
  }

    // Live world-read: not bound by actor FIFO / the concurrency cap (harness IO).
  if (state.isRunSettled()) return Promise.reject(state.runError());
    // A live world.run is one write (an effect, not a read): once it runs, the workspace differs from what the predecessor left, so close the import cache
    // **before** dispatch -- the same rule and instant as a subagent mutating tool (before touching). world-read does not close:
    // reads change nothing.
  if (kind === "world-run") closeImportCache(state, instance, "world-run");
    // Admission persists running: a world read crashed mid-execution resumes by re-running.
  state.journal.putNode({
    runId: state.runId,
    siteId,
    ordinal,
    kind,
    inputHash: hash,
    input,
    status: "running",
  });
  state.record({ type: "node-queued", instance, kind });
  state.record({ type: "node-dispatched", instance });
  return state.driver.executeWorldRead(op, args).then(
    (value) =>
      settleWorldRead(state, instance, kind, hash, input, { status: "completed", result: value }),
    (cause: unknown) => {
      const err =
        cause instanceof WorkflowError
          ? cause
          : new WorkflowError("DriverError", `World read failed: ${op} ${canonicalJson(args)}.`, {
              cause,
            });
      return settleWorldRead(state, instance, kind, hash, input, {
        status: "failed",
        error: err.toJSON(),
      });
    },
  );
}

function settleWorldRead(
  state: EngineState,
  instance: InstanceRef,
    // putNode is an upsert (whole-row replace); a settlement hardcoding world-read would quietly
    // revert the admission-time world-run -- kind must share one source with admission.
  kind: NodeKind,
  hash: string,
    // Same reason: the bounded input written at admission must be replaced back wholesale at settlement.
  input: WorldReadInput,
  outcome:
    | { status: "completed"; result: unknown }
    | { status: "failed"; error: WorkflowErrorJson },
): unknown {
  if (state.isRunSettled()) throw state.runError();
  state.journal.putNode({
    runId: state.runId,
    siteId: instance.siteId,
    ordinal: instance.ordinal,
    kind,
    inputHash: hash,
    input,
    status: outcome.status,
    ...(outcome.status === "completed" ? { result: outcome.result } : { error: outcome.error }),
  });
  if (outcome.status === "completed") {
    state.record({ type: "node-settled", instance, outcome: "ok" });
    return outcome.result;
  }
  state.record({ type: "node-settled", instance, outcome: "failed", error: outcome.error });
  throw WorkflowError.fromJSON(outcome.error);
}

/**
  * Close the import cache (idempotent). Two triggers, both **before the first write**: the driver reporting that a live
  * subagent is about to run a mutating tool, or a world.run about to execute live.
  * The cache-closed event fires only for a true amended run -- on resume it is the sole source of truth that
  * the gate closed; a non-amended run has no table to close (the flag is harmless, no event).
 */
export function closeImportCache(
  state: EngineState,
  instance: InstanceRef,
  cause: "mutating-tool" | "world-run",
  actorName?: string,
): void {
  if (state.importClosed()) return;
  state.closeImport();
  if (state.importedCache === undefined) return;
  state.record({
    type: "import-cache-closed",
    instance,
    cause,
    ...(actorName === undefined || actorName === "" ? {} : { actorName }),
  });
}

/**
  * On resume, restore the closed verdict, the ever-live ask instance set, and the admitted-before-close set.
 *
  * The source is this run own events: live nodes emit node-queued at admission (asks with an actor ref), cache
  * hits only node-settled cached -- so which asks were ever live is an exact set. Whether the gate closed comes from the
  * cache-closed event -- an ask turning live no longer implies closing (it may have touched no file); only
  * writes close, and only this event records that. Zero schema change.
 *
  * The queued-before-close set is also zero-schema, by event order: the resume-in-flight-ask verdict and that ask
  * node-queued land in the same synchronous slice as admission (see the scheduler admitAsk -> tryImportedSettle ->
  * admitLive), so gate-open-at-admission iff this node-queued precedes the first cache-closed event.
  * With no close event, everything counts.
 */
export function recoverImportClosure(
  journal: JournalStorePort,
  runId: string,
): { live: ReadonlySet<string>; queuedBeforeClose: ReadonlySet<string>; closed: boolean } {
  const live = new Set<string>();
  const queuedBeforeClose = new Set<string>();
  let closed = false;
  for (const { event } of journal.listEvents(runId)) {
    if (event.type === "import-cache-closed") closed = true;
    if (event.type !== "node-queued" || event.kind !== "ask") continue;
    const key = refToString(event.instance);
    live.add(key);
    if (!closed) queuedBeforeClose.add(key);
  }
  return { live, queuedBeforeClose, closed };
}
