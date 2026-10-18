// ============================================================
// AgentRuntime-backed WorkflowDriver: the submit bridge for typed results (submit_result)
// ============================================================
// Why: workflow-driver.ts hit the oxlint max-lines cap (400) again, so the session-level submit port moved here
// as free functions, line-for-line symmetric with the neighboring escalation bridge (`makeSessionEscalatePort` in workflow-driver-escalation.ts) --
// both are the same shape on two timelines (mid-turn block -> report -> engine verdict -> release the deferred).
// The public surface is unchanged; the driver class keeps a single call site.
//
// Every touch of driver state arrives explicitly via {@link SubmitBridgeHost} (session table + upward report surface);
// this file holds no state of its own -- original method bodies verbatim, `this.` renamed to `host.`.

import type {
  SessionId,
  SubmitResultRequest,
  SubmitVerdict as ContractsSubmitVerdict,
  WorkflowSubmitPort,
} from "@zcode/contracts";
import { WorkflowError, type WorkflowReportSink } from "@zcode/dynamic-workflow";
import { defer, rejectWith } from "./workflow-driver-helpers.js";
import type { SessionState } from "./workflow-driver-types.js";

/**
  * The host surface handed to the submit bridge. Both members are **references** into driver-private state (not copies): `sessions` is
  * the class's session table, `sink` is Boundary B's upward report surface (`askSubmitAttempted` is answered by the engine
  * synchronously within this call stack, so the pair must be of the same generation).
 */
export interface SubmitBridgeHost {
  readonly sessions: ReadonlyMap<string, SessionState>;
  readonly sink: WorkflowReportSink;
}

/**
  * Builds the session-level submit port: the `submit_result` handler calls it mid-turn and blocks for the verdict.
 *
  * The closure binds this session, so the model cannot override the routing identity (instance from `currentInstance`).
 */
export function makeSessionSubmitPort(
  host: SubmitBridgeHost,
  sessionId: SessionId,
): WorkflowSubmitPort {
  return {
    respond: (request: SubmitResultRequest): Promise<ContractsSubmitVerdict> => {
      const state = host.sessions.get(sessionId);
      const instance = state?.currentInstance;
      if (state === undefined || instance === undefined) {
                // A submit with no in-flight ask: do not route to the engine; reject directly (avoids a hang).
        return Promise.resolve(rejectWith("no active ask is awaiting a submitted result"));
      }
            // Asks without a declared result type may still have registered submit_result; reject the submit at once and hint at a plain reply.
            // Never hand it to the engine and wait: the engine ignores submit on untyped asks and the awaiting deferred would never resolve.
      if (!state.currentTyped) {
        return Promise.resolve(
          rejectWith(
            "this ask does not accept submit_result; provide your answer as your final message",
          ),
        );
      }
            // Current-instance invariant: at most one pending deferred. If one exists (should not happen), reject the older one to avoid a leak.
      state.pendingSubmit?.reject(
        new WorkflowError("DriverError", "This submit was superseded by a newer submit."),
      );
      const deferred = defer<ContractsSubmitVerdict>();
      state.pendingSubmit = deferred;
            // Synchronous report: the engine validates within this call stack and returns the verdict via respondToSubmit (deferred released inline).
      host.sink.askSubmitAttempted(instance, request.result);
      return deferred.promise;
    },
  };
}
