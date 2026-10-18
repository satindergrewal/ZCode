// ============================================================
// Background-stop branch for workflow runs (the local_dynamic_workflow arm of runtime.stopBackgroundTask)
// ============================================================
//
// The tail of the **only** cancel path. Two entries, one implementation:
//   1. GUI：v4 `cancelBackgroundWork {workId}` → `app.cancelBackgroundTask`
//      → `runtime.cancelBackgroundTask` → `runtime.stopBackgroundTask`（lenient）
//   2. Model: the `TaskStop` tool → `backgroundTaskControlPort.stopBackgroundTask`
//      (runtime-tools.ts binds it to the same `runtime.stopBackgroundTask`, strict: true)
// They differ only in strictness (strict returns not_running for finished tasks, not a loose success);
// past the dispatch and this module, behavior is identical — no second cancel semantics exists.
//
// A separate module, to bound background.ts and stop branch complexity growing.
// background.ts keeps one import and one dispatch line.

import type { AgentRuntimeInternal } from "../internal.js";
import type {
  RuntimeBackgroundStopInitiator,
  RuntimeBackgroundStopResult,
  TypedRuntimeBackgroundStopTarget,
} from "./background-stop-types.js";

/**
 * Stop a workflow run: hand the taskId (≡ runId ≡ workId, no identity map) to
 * `DynamicWorkflowRunPort.cancel`。
 *
 * the AbortController in the port abort registry: abort in-flight asks, kill sandbox children, let the engine settle
 * `stop(initiator)` into `stopped(user | model)` (**not** `errored` — the journal is an
 * app-read record; the states differ in meaning and resume UX, and failure is never encoded as stop).
 *
 * Both degradations return structured results, no fake success:
 *   - no port at all (unwired host) → unsupported;
 *   - port false for an unknown/settled run → not_found.
 */
export async function stopDynamicWorkflowBackgroundTask(
  this: AgentRuntimeInternal,
  target: TypedRuntimeBackgroundStopTarget,
  unsupported: (target: TypedRuntimeBackgroundStopTarget) => RuntimeBackgroundStopResult,
  initiator?: RuntimeBackgroundStopInitiator,
): Promise<RuntimeBackgroundStopResult> {
  const port = this.dynamicWorkflowRunPort;
  if (!port) {
    return unsupported(target);
  }
  // Record who stopped before the abort: the terminal notice is minted later, at waiter settlement; the registry entry is the only
  // shared state in between. Write before abort,
  // or settlement reads blank first.
  if (initiator !== undefined && target.registryTask !== undefined) {
    this.runtimeTaskRegistry.update(target.taskId, (current) => ({
      ...current,
      stopInitiator: initiator,
    }));
  }
  // The reason persists with the cancel: the run settles `stopped(user|model)`,
  // and notice plus GetWorkflowRun read who-stopped from the journal, not the registry fallback.
  // User-stopped-by-hand feeds the AmendWorkflow no-confirm rule too: the user said stop, so the next amend asks again.
  const cancelled = await port.cancel(target.taskId, initiator);
  if (!cancelled) {
    return {
      ok: false,
      reason: "background_task_not_found",
      status: "lost",
      taskId: target.taskId,
      type: "local_dynamic_workflow",
    };
  }
  return {
    ok: true,
    status: "cancelled",
    taskId: target.taskId,
    type: "local_dynamic_workflow",
  };
}
