// ============================================================
// Dynamic Workflow Run: lifecycle bookkeeping for runs owned by this session (settlement / close / close gate / foreign terminal rows)
// ============================================================
// Split because dynamic-workflow-run-service.ts hit the oxlint max-lines cap (400): the run's span from settlement
// to close moves here -- settlement bookkeeping (terminal into entry, failure normalization, residency registration, settlement notice, terminal
// entry eviction) plus the service-side close and foreign-terminal-row check closures.
// They borrow only the service's registry and journal via narrow deps; invariants 6 and 7 of the service header remain their spec.

import type { Logger } from "@zcode/contracts";
import type { JournalStorePort, RunSettlement } from "@zcode/dynamic-workflow";
import {
  TERMINAL_RUN_STATUSES,
  type RunRegistryEntry,
} from "./dynamic-workflow-run-observation.js";

/** How many terminal runs the in-memory registry retains (artifacts live only in settlement; the journal does not store script return values). */
const TERMINAL_REGISTRY_LIMIT = 32;

/** The post-settlement notice; `liveRunCount` is the still-in-flight count under this service at notice time. */
export interface DynamicWorkflowRunSettledNotice {
  runId: string;
  liveRunCount: number;
}

interface RunServiceLifecycleDeps {
    /** Read-only `getRun`: foreign-terminal detection needs the row's status. */
  journal: Pick<JournalStorePort, "getRun">;
  logger?: Logger;
  parentSessionId: string;
    /** See the service's `DynamicWorkflowRunServiceDeps.registerResidencyBlockingWork` (invariant 6). */
  registerResidencyBlockingWork?: (work: Promise<unknown>) => void;
    /** The service's registry itself (not a snapshot): settle evicts old terminal entries, close enumerates live ones, foreign-rows sets the mark. */
  runs: Map<string, RunRegistryEntry>;
}

interface RunServiceLifecycle {
    /** Runs not yet settled (entries with `terminal === undefined` in the registry). */
  countLiveRuns(): number;
    /** Subscribes settlement notices (sent after bookkeeping; listener errors only log). Returns the unsubscribe fn. */
  subscribeRunSettled(listener: (notice: DynamicWorkflowRunSettledNotice) => void): () => void;
    /** Settlement bookkeeping (shared by submit / amend / resume): terminal into entry, failure normalized, residency registered. Never rejects. */
  trackSettlement(
    runId: string,
    entry: RunRegistryEntry,
    launched: Promise<RunSettlement>,
  ): Promise<RunSettlement>;
    /** See {@link createRunServiceLifecycle}'s close note. Idempotent. */
  close(): Promise<void>;
    /** A launch after close is a wiring error: throw, rather than adding a member to contracts' rejection enum. */
  assertOpen(): void;
    /** A terminal row under a live entry => foreign write; one warn per entry. */
  noteForeignTerminalRow(runId: string): void;
}

/**
  * Close (service-header invariant 7).
 *
  * The engine is a closure of this App (actor runtimes, event wiring, cancel controllers, settlement
  * promises live here); once the App closes it has no host, while journal rows sit at running -- the next activation could
  * only guess via orphan convergence. So close **stops actively**: abort every in-flight entry with `"interrupted"`; the harness normalizes
  * to `engine.stop("interrupted", Interrupted)` and the engine itself writes the row as a resumable stopped.
 *
  * Wait without timeout: the harness settles synchronously on stop, and "wait for the predecessor's own settlement promise" is the very
  * discipline amend already uses (never a timer in place of state). Settlement promises never reject (see {@link RunServiceLifecycle.trackSettlement}).
 */
export function createRunServiceLifecycle(deps: RunServiceLifecycleDeps): RunServiceLifecycle {
  const { runs } = deps;
  const terminalOrder: string[] = [];
  const settledListeners = new Set<(notice: DynamicWorkflowRunSettledNotice) => void>();
  const countLiveRuns = (): number => {
    let live = 0;
    for (const entry of runs.values()) if (entry.terminal === undefined) live += 1;
    return live;
  };
    // The settlement notice fires **after** bookkeeping: listeners (the host's registry safety boundary) must read a count that already excludes this run.
  const notifySettled = (runId: string): void => {
    if (settledListeners.size === 0) return;
    const notice: DynamicWorkflowRunSettledNotice = { runId, liveRunCount: countLiveRuns() };
    for (const listener of settledListeners) {
      try {
        listener(notice);
      } catch (error: unknown) {
        deps.logger?.warn?.("Dynamic workflow run settled listener threw", {
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "dynamic_workflow.run.settled_listener_failed",
          module: "bootstrap.app",
          runId,
        });
      }
    }
  };
  const subscribeRunSettled = (
    listener: (notice: DynamicWorkflowRunSettledNotice) => void,
  ): (() => void) => {
    settledListeners.add(listener);
    return () => {
      settledListeners.delete(listener);
    };
  };

  const rememberTerminal = (runId: string): void => {
    terminalOrder.push(runId);
    while (terminalOrder.length > TERMINAL_REGISTRY_LIMIT) {
      const evicted = terminalOrder.shift();
      if (evicted !== undefined && runs.get(evicted)?.terminal !== undefined) runs.delete(evicted);
    }
  };

  /**
      * Settlement bookkeeping (shared by submit and resume): terminal into entry, failure normalized.
      * Failures from outside the harness (engine construction throwing, ...) normalize to errored, never stopped -- in the journal
      * the two differ in semantics and resume UX (stopped is resumable, errored only amendable).
   */
  const trackSettlement = (
    runId: string,
    entry: RunRegistryEntry,
    launched: Promise<RunSettlement>,
  ): Promise<RunSettlement> => {
    const settlement = launched.then(
      (result) => {
        entry.terminal = result;
        entry.completedAt = new Date();
        rememberTerminal(runId);
        notifySettled(runId);
        return result;
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        deps.logger?.warn?.("Dynamic workflow run failed before settling", {
          errorMessage: message,
          event: "dynamic_workflow.run.start_failed",
          module: "bootstrap.app",
          runId,
        });
        entry.completedAt = new Date();
        const result: RunSettlement = {
          status: "errored",
          error: error instanceof Error ? (error as never) : (new Error(message) as never),
        };
        entry.terminal = result;
        rememberTerminal(runId);
        notifySettled(runId);
        return result;
      },
    );
        // Service-header invariant 6: the three entrances (submit / amend / resume) share this one registration point, and it must be in launch's
        // same synchronous slice -- one microtask late and a residency rebalance lands between start and registration. What registers is the
        // post-settlement promise (`settlement` never rejects; bookkeeping done); the count releases in its finally.
    deps.registerResidencyBlockingWork?.(settlement);
    return settlement;
  };

  let closed = false;
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
        // Idempotent and **synchronously** set: `closed` must be true within this slice, or a launch arriving during close
        // slips in and mints an unowned engine.
    closePromise ??= (async () => {
      closed = true;
      const live = [...deps.runs.values()].filter((entry) => entry.terminal === undefined);
      deps.logger?.info?.("Dynamic workflow run service closing", {
        event: "dynamic_workflow.service.closing",
        liveRunCount: live.length,
        module: "bootstrap.app",
        parentSessionId: deps.parentSessionId,
      });
      for (const entry of live) entry.controller.abort("interrupted");
      await Promise.all(live.map((entry) => entry.settlement));
      deps.logger?.info?.("Dynamic workflow run service closed", {
        event: "dynamic_workflow.service.closed",
        module: "bootstrap.app",
        parentSessionId: deps.parentSessionId,
        stoppedRunCount: live.length,
      });
    })();
    return closePromise;
  };

  /**
      * A launch after close is a **wiring error**, not a business rejection: the residency pool's close gate already blocks the command face,
      * so reaching here means someone bypassed it. Hence throw, not a new contracts rejection member -- that would make every caller
      * handle a branch that never occurs in normal operation.
   */
  const assertOpen = (): void => {
    if (closed) {
      throw new Error(
        "dynamic workflow run service is closed; a launch after App close is a wiring fault",
      );
    }
  };

  /**
      * A terminal row under a live entry => foreign write; one warn per entry.
   *
      * A second desktop instance cold-restored the same session; its orphan convergence wrote this
      * process's still-running run as a terminal row. The read faces already ignore it via the live
      * {@link RunRegistryEntry} (observation's synthesizeRunStatus), but the event itself must be recorded -- else "two instances fighting"
      * stays guesswork after the fact.
   *
      * Once per entry: the tracker polls `getTask` every second; without the mark that is one identical warn per second. While unset,
      * one extra `getRun` (a single-row indexed query); once set, even that is saved.
   */
  const noteForeignTerminalRow = (runId: string): void => {
    const entry = deps.runs.get(runId);
    if (entry === undefined || entry.terminal !== undefined || entry.foreignTerminalLogged) return;
    const record = deps.journal.getRun(runId);
    if (record === undefined || !TERMINAL_RUN_STATUSES.has(record.status)) return;
    entry.foreignTerminalLogged = true;
    deps.logger?.warn?.("Dynamic workflow run has a foreign terminal row under a live engine", {
      event: "dynamic_workflow.run.foreign_terminal_row",
      journalStatus: record.status,
      module: "bootstrap.app",
      runId,
      ...(record.stopReason === undefined ? {} : { stopReason: record.stopReason }),
    });
  };

  return {
    countLiveRuns,
    subscribeRunSettled,
    trackSettlement,
    close,
    assertOpen,
    noteForeignTerminalRow,
  };
}
