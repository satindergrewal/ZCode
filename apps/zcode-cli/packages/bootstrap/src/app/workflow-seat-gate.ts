// ============================================================
// The run-level seat gate: presses this run's own concurrency bound onto the **next model request**
// ============================================================
// The scheduler is the first execution point, but it only
// checks the bound at dispatch, and one ask is a whole subagent round -- minutes. Telling a run with eight in-flight asks
// "at most two" would, by scheduler alone, wait for six asks to finish. This gate is the second execution point: subagents beyond the bound
// finish the request at hand, then **stop before the next turn step** -- session, transcript, and roster place all intact.
//
// Three disciplines:
//   1. **Pure**: no clock, no I/O, no subscriptions. The two facts (who has an in-flight ask, who has tools running) are fed by
//      the driver's existing observation faces (workflow-driver.ts's startAsk / emit,
//      workflow-driver-tool-activity.ts's in-flight count); the gate keeps no second ledger.
//   2. **Zero shared state with the scheduler**, and they never call each other. Arithmetic keeps them consistent: `activeAsks = working +
//      parked` -- a parked subagent's ask is still alive and still counts against the scheduler's bound. So whenever someone is parked,
//      `activeAsks >= limit` and the scheduler cannot dispatch a new ask -- it can never cut ahead of a parked one.
//   3. **bound >= 1 => no deadlock**: parking requires "working count already over the bound", so someone is always working;
//      with a non-empty FIFO the last seat cannot be empty.
//
// Tool-side requests **never** park: that subagent is already
// working and holding its seat; making its WebSearch queue behind itself is queueing for its own amusement. Admission calls carry only `{model}`,
// unable to tell which request it is, so the gate reads the fact the driver already keeps per subagent -- whether it has tools running.

import type { ModelRequestAdmission } from "@zcode/contracts";
import { refToString, type InstanceRef } from "@zcode/dynamic-workflow";

/** The one subagent fact the gate asks of the driver (implemented in workflow-driver-tool-activity.ts). */
export interface SeatGateSubagent {
    /** How many tool calls are running; > 0 means tool-side request, admit directly. */
  toolsInFlight(): number;
}

  /** The gate's two counters (observation face: the `activeAsks = working + parked` assertion reads these). */
export interface SeatGateStats {
  limit: number;
  working: number;
  parked: number;
}

export interface WorkflowRunSeatGate {
  /**
      * Sets the bound. Raking up admits from the FIFO to the new bound at once; lowering recalls nobody -- those over the bound finish
      * their current request and park themselves at the next turn step.
   */
  setLimit(limit: number): void;
    /** An ask was dispatched to this subagent (the same instant as driver.startAsk). */
  askStarted(key: string, instance: InstanceRef): void;
    /** The engine recorded node-settled for this instance (the ask's **only** end; see workflow-driver.ts's emit). */
  askSettled(instance: InstanceRef): void;
  /**
      * Wraps a subagent's admission port into "seat first, then governor". A missing `inner` means this runtime
      * was never gate-bound (an assembly without the governor port) and the gate invents none -- both gates present
      * or neither.
   */
  wrap(
    key: string,
    subagent: SeatGateSubagent,
    inner: ModelRequestAdmission | undefined,
  ): ModelRequestAdmission | undefined;
  stats(): SeatGateStats;
}

/** One seat in the FIFO: its key, the two handles that open it, and the abort-listen teardown. */
interface ParkedSeat {
  key: string;
  grant: () => void;
  refuse: (reason: unknown) => void;
}

export function createWorkflowRunSeatGate(input: { limit: number }): WorkflowRunSeatGate {
  let limit = Math.max(1, Math.floor(input.limit));
    /** Subagents with an in-flight ask and **not** parked; moved out at park time, back on admission. */
  const working = new Set<string>();
    /** Subagents waiting for a seat, first come first served. */
  const parked: ParkedSeat[] = [];
    /** `refToString(instance)` -> subagent key: the ask's end carries only the instance; without the map no seat can be freed. */
  const instances = new Map<string, string>();

  const parkedIndexOf = (key: string): number => parked.findIndex((seat) => seat.key === key);

    /** Admits from the FIFO while seats remain. Admitting = entering working, not issuing a ticket -- the seat IS the working slot. */
  const unpark = (): void => {
    while (working.size < limit && parked.length > 0) {
      const seat = parked.shift()!;
      working.add(seat.key);
      seat.grant();
    }
  };

    /** Does this request need a seat? Only a subagent with an in-flight ask and no tools running is a turn step. */
  const needsSeat = (key: string, subagent: SeatGateSubagent): boolean =>
    working.has(key) && subagent.toolsInFlight() === 0;

  const acquireSeat = async (key: string, signal: AbortSignal | undefined): Promise<void> => {
        // Within the bound: pass in place, no state change. Runs never lowered by a retune always take this branch -- the fast path, verbatim.
    if (working.size <= limit) return;
    if (signal?.aborted === true) throw signal.reason;
    working.delete(key);
    return await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = parkedIndexOf(key);
        if (index >= 0) {
          parked.splice(index, 1);
                    // **Dequeue = back to working**: in this gate "not in parked" has one meaning, working. The abort
                    // hits the **request**, not necessarily the ask -- driver-side transient re-drives, stream recovery, any per-request signal
                    // arrives while the ask lives. Left outside both sets, every later turn request passes ungated
                    // (`needsSeat` false) and is never counted working again: the bound silently drifts up.
          //
                    // Re-adding may push working over the bound -- a legal transient (same shape as the lower-the-bound instant): the next
                    // turn requester parks as usual and the count converges. At the post-abort settlement, askSettled
                    // does working.delete and calls unpark, whose working.size < limit guard prevents
                    // "freeing a seat it never held" -- at park time working >= limit, so re-adding makes >= limit+1,
                    // and after the delete still >= limit: nobody admitted.
          working.add(key);
        }
        reject(signal?.reason);
      };
      const seat: ParkedSeat = {
        key,
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
        refuse: (reason) => {
          signal?.removeEventListener("abort", onAbort);
          reject(reason);
        },
      };
      parked.push(seat);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  return {
    setLimit: (next) => {
      limit = Math.max(1, Math.floor(next));
      unpark();
    },

    askStarted: (key, instance) => {
      instances.set(refToString(instance), key);
            // A parked subagent cannot receive a new ask (its turn is stuck in acquire; actor.current still holds engine-side),
            // but both sets taking one key would count it twice -- block once here.
      if (parkedIndexOf(key) >= 0) return;
      working.add(key);
    },

    askSettled: (instance) => {
      const ref = refToString(instance);
      const key = instances.get(ref);
      if (key === undefined) return;
      instances.delete(ref);
      const parkedIndex = parkedIndexOf(key);
      if (parkedIndex >= 0) {
                // A parked ask ended: **no seat freed** (it never held one), or this slot counts twice.
                // Only an engine cancel fits (the parked turn is stuck in acquire, reporting no turn end), and that path
                // calls driver.cancelAsk first (the abort rejects the wait above) before node-settled, so in the normal order
                // it is gone here already. On the reversed order, reject the wait too, so an unowned ask is not admitted later.
        const [seat] = parked.splice(parkedIndex, 1);
        seat?.refuse(new Error("workflow ask settled while waiting for a concurrency seat"));
        return;
      }
      if (!working.delete(key)) return;
      unpark();
    },

    wrap: (key, subagent, inner) => {
      if (inner === undefined) return undefined;
      return {
                // Fast path: this request needs a seat and none is free => miss. The runner then emits `model_request_queued`,
                // the driver reports `askWaiting(slot)` -- verbatim the shared-cap wait message, no new vocabulary.
        tryAcquire: (request) => {
          if (needsSeat(key, subagent) && working.size > limit) return undefined;
          return inner.tryAcquire?.(request);
        },
                // The order is load-bearing: **wait for the seat first, then the governor**. Reversed, a subagent that should park would take
                // a governor ticket, then sleep here -- a ticket useful to no one.
        acquire: async (request) => {
          if (needsSeat(key, subagent)) await acquireSeat(key, request.signal);
          return await inner.acquire(request);
        },
      };
    },

    stats: () => ({ limit, working: working.size, parked: parked.length }),
  };
}
