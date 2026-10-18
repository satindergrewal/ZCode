// ============================================================
// Dynamic Workflow Run Service: construction-time convergence of orphan runs
// ============================================================
// dynamic-workflow-run-service.ts hit the oxlint max-lines cap (400), so orphan convergence
// (interruptedRunFailure / reconcileOrphanRuns) moved here; the public surface is still exported from
// dynamic-workflow-run-service.ts. Semantics: invariant 4 in that file's header.

import type { Logger } from "@zcode/contracts";
import type { JournalStorePort, RunRecord, WorkflowErrorJson } from "@zcode/dynamic-workflow";
import { supportsNonTerminalRunQuery } from "./dynamic-workflow-run-journal.js";
import {
  INTERRUPTED_FAILURE_CODE,
  TERMINAL_RUN_STATUSES,
} from "./dynamic-workflow-run-observation.js";

/**
  * The deps subset convergence needs (a structural subset of DynamicWorkflowRunServiceDeps, passed in verbatim by the service).
  * Only these three, not the whole deps type: convergence only reads the journal and only owns this session -- extra members
  * would make "what it touched" invisible.
 */
interface DynamicWorkflowOrphanReconcileDeps {
  journal: JournalStorePort;
  parentSessionId: string;
  logger?: Logger;
}

/**
  * The failure encoding for interrupted runs. It keeps the engine's {@link WorkflowErrorJson} shape (into dwf_run.failure_json,
  * the same read surface as the engine's own failures) but the code is **dedicated**:
 *
  *   - not `DriverError` -- the script's own throws encode as that too (dynamic-workflow-runtime/src/harness.ts);
  *     a shared code would leave message text as the only way to tell "process killed" from "script failed";
  *   - status not `cancelled` -- that means "user cancelled". Both are recoverable (the resume gate accepts
  *     {@link INTERRUPTED_FAILURE_CODE}), but the semantics must stay distinguishable.
 */
function interruptedRunFailure(runId: string): WorkflowErrorJson {
  return {
    code: INTERRUPTED_FAILURE_CODE,
    message: `dynamic workflow run ${runId} was interrupted: the owning process exited before the run settled`,
  };
}

/**
  * Converges this parent session's orphan runs at construction (the old problem:
  * after run-started the process dies and the dwf_run row stays **running forever**, while getTask/waitForTask
  * return the journal snapshot for any run not in this process's registry -- after restore, every journal read face reports "still running",
  * never self-healing).
 *
  * Why at **construction**: at this instant this service instance owns zero in-flight runs, so any non-terminal
  * row of this session in the journal is a dead process's leftover. A second construction is thus idempotent (nothing non-terminal left).
 *
  * Three boundaries:
  *   - **This session only** (`deps.parentSessionId`). A global sweep would mark sibling sessions' in-flight runs dead;
  *     same-session dual processes are excluded by single-session ownership.
  *   - **No synthetic dwf_event**. The event log's contract is "what the engine emitted"; the state authority is the run row;
  *     `run-settled` belongs to the engine, not the sweeper.
  *   - **Convergence failure must not break construction**. Convergence is self-healing, not a run precondition: on query/write failure, log warn and
  *     continue (the worst case is one stale lying row); never turn app construction into a startup failure.
 */
export function reconcileOrphanRuns(deps: DynamicWorkflowOrphanReconcileDeps): void {
  const { journal, logger, parentSessionId } = deps;
  if (!supportsNonTerminalRunQuery(journal)) {
    logger?.warn?.("Dynamic workflow orphan run reconciliation skipped", {
      event: "dynamic_workflow.run.reconcile_skipped",
      module: "bootstrap.app",
      reason: "journal_missing_list_non_terminal_runs",
    });
    return;
  }

  let orphans: RunRecord[];
  try {
    orphans = journal.listNonTerminalRuns(parentSessionId);
  } catch (error) {
    logger?.warn?.("Dynamic workflow orphan run query failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "dynamic_workflow.run.reconcile_failed",
      module: "bootstrap.app",
    });
    return;
  }

  for (const record of orphans) {
        // Terminality is decided in this file (TERMINAL_RUN_STATUSES); the journal's status filter is a pre-screen only.
    if (TERMINAL_RUN_STATUSES.has(record.status)) continue;
    try {
            // stopped(interrupted): recoverable, and distinguishable from user
            // cancels / model-side stops -- the reason says "the process died", the code is the second witness of the same fact.
      journal.updateRunStatus(record.runId, "stopped", {
        stopReason: "interrupted",
        failure: interruptedRunFailure(record.runId),
      });
      logger?.warn?.("Dynamic workflow run reconciled as interrupted", {
        event: "dynamic_workflow.run.reconciled_interrupted",
        module: "bootstrap.app",
        previousStatus: record.status,
        runId: record.runId,
      });
    } catch (error) {
      logger?.warn?.("Dynamic workflow orphan run reconciliation failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "dynamic_workflow.run.reconcile_failed",
        module: "bootstrap.app",
        runId: record.runId,
      });
    }
  }
}
