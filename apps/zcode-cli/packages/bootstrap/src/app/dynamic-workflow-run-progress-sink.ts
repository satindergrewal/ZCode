/**
 * Workflow run progress events -> the parent session's append sink (create-app's `onRunEvent`).
 *
 * A separate file, not a closure inside create-app, so the three **degradation paths** below are directly unit-testable:
 * all are "run in flight, observation broken" cases; any exception escaping would kill a running run,
 * and the run's truth lives in the journal -- the progress face is observation only and must never be able to terminate it.
 */

import type { DynamicWorkflowRunProgressPayload, Logger, SessionId } from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";

interface DynamicWorkflowRunProgressSinkDeps {
  /** Lazy runtime getter: the run service is built **before** the runtime (it is one of the runtime's dependencies). */
  getRuntime: () => AgentRuntime;
  /** The session this app belongs to. A run's parentSessionId must equal it; see the identity gate below. */
  sessionId: SessionId;
  logger?: Logger;
}

/**
 * Builds a progress sink. The returned function **never throws and never returns a rejected promise**.
 *
 * ## The identity gate (load-bearing)
 *
 * Events must land in the session that **started the run**. Today that holds 1:1 by construction:
 *
 *   ZCodeApp ──1:1── AgentRuntime ──1:1── sessionId        （create-app：`new AgentRuntime(sessionId, …)`）
 *        └──1:1── run service (built into this app; the port is never lent out)
 *   The CreateWorkflow handler submits with `parentSessionId = context.sessionId`
 *
 * and **only** the app's top-level runtime gets `dynamicWorkflowRunPort`: the subagent child runtime's deps
 * (`core/src/runtime/methods/subagent.ts`'s `new AgentRuntime(...)`) and the workflow actor runtime
 * (`script-workflow-child-runtime.ts`) both lack the port (verified line-by-line), so child sessions never reach
 * submit -- their CreateWorkflow falls to the "port absent -> placeholder diagnostic" path.
 *
 * Thus `getRuntime()` is the right runtime. **But an unwritten invariant gets rewritten by the next person**:
 * once someone adds the port to child-runtime deps, run events from child sessions land in the **parent**
 * transcript -- a bug that never errors, only puts events in the wrong conversation. So identities are compared explicitly,
 * and on mismatch **nothing is appended**: one guided log line instead. Better a missing projection than a polluted transcript.
 * (Truly supporting child-initiated runs needs a by-sessionId runtime registry, which bootstrap lacks --
 * child runtimes live inside core. That is a design-carrying change.)
 */
export function createDynamicWorkflowRunProgressSink(
  deps: DynamicWorkflowRunProgressSinkDeps,
): (progress: DynamicWorkflowRunProgressPayload, routing?: { parentSessionId?: string }) => void {
  const warn = (message: string, runId: string, extra: Record<string, unknown> = {}): void => {
    deps.logger?.warn?.(message, {
      event: "dynamic_workflow.run_progress.append_failed",
      module: "bootstrap.app",
      runId,
      ...extra,
    });
  };

  return (progress, routing) => {
    const parentSessionId = routing?.parentSessionId;
    // Absent is legal (submit without parentSessionId): this app's port is reachable only from this session,
    // so absent equals "this session". Only an explicit mismatch is a wiring error.
    if (parentSessionId !== undefined && parentSessionId !== deps.sessionId) {
      warn(
        "Dynamic workflow run progress dropped: parent session is not this app",
        progress.runId,
        {
          event: "dynamic_workflow.run_progress.session_mismatch",
          expectedSessionId: deps.sessionId,
          parentSessionId,
          reason: "run_parent_session_not_owned_by_this_app",
        },
      );
      return;
    }

    // getRuntime() **throws synchronously** before the runtime exists; a closing runtime can also throw anywhere in the append chain
    // (event store / persistence / sink fan-out). Both must degrade to "log one line, no-op".
    let appended: Promise<void>;
    try {
      appended = deps.getRuntime().recordDynamicWorkflowRunProgress(progress);
    } catch (error) {
      warn("Dynamic workflow run progress append failed", progress.runId, {
        errorMessage: error instanceof Error ? error.message : String(error),
        reason: "runtime_unavailable",
      });
      return;
    }
    void appended.catch((error: unknown) => {
      warn("Dynamic workflow run progress append failed", progress.runId, {
        errorMessage: error instanceof Error ? error.message : String(error),
        reason: "append_rejected",
      });
    });
  };
}
