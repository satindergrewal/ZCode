import { CREATE_WORKFLOW_TOOL_NAME, type TraceContext } from "@zcode/contracts";
import type { ExecutableToolCall } from "../../tool/types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { activateDynamicWorkflowTools } from "./dynamic-workflow-activation.js";

/**
 * Puts a **resumed** dwf run back under background tracking.
 *
 // Tracking on the submit path happens automatically when the tool executor sees CreateWorkflow return backgrounded; resume
 * is a v4 command with no in-flight tool call, so four things would go undone: runtime-task registry entry (the **session
 * reclamation guard** — without it a run-holding session looks idle and gets reclaimed, and the completion notice has nowhere to land),
 * BackgroundTaskStarted (backgroundWorks panel + cancellable flag), polling/terminal waiter, settlement notify. This method synthesizes a
 * tool descriptor through the executor's regular trackBackgroundTask, buying all four at once.
 *
 * Descriptor field choices:
 *   - `id` is the **original toolCallId** (restored from dwf_run.tool_call_id) — the tool-card -> detail-page
 *     join key and the registry's parentToolCallId; when an old run lacks it, synthesize a resume-prefixed id (observable,
 *     masquerading as no real tool row).
 *   - `name` is always CreateWorkflow: per-tool lifecycle dispatch (snapshot/wait/cancel/notice formats) is table-driven on it.
 *   - `input.name` feeds the display-name fallback (workflowTaskSubject) — resume commands may carry it; when absent the
 *     tracker falls back to taskId and the UI handles fallbackName (same semantics as the submit path).
 *
 * turnId deliberately absent: resume is issued by a UI command and belongs to no model turn (same argument as the run-progress
 * event's rootTraceContext, see dynamic-workflow-run-progress.ts).
 */
export async function trackResumedDynamicWorkflowRun(
  this: AgentRuntimeInternal,
  input: { runId: string; toolCallId?: string; name?: string; traceContext?: TraceContext },
): Promise<void> {
  const traceContext = input.traceContext ?? this.rootTraceContext;
  const toolCall: ExecutableToolCall = {
    id: input.toolCallId ?? `resume-${input.runId}`,
    name: CREATE_WORKFLOW_TOOL_NAME,
    input: input.name === undefined ? {} : { name: input.name },
  };
  await this.executor.trackExternalBackgroundTask(
    toolCall,
    { backgroundTaskId: input.runId, status: "backgrounded" },
    traceContext,
    undefined,
  );
  // A successful GUI Resume activates the tool surface (launch.md "On demand: activation"): the run's terminal notice makes the model
  // call GetWorkflowRun, and without that tool it stalls.
  await activateDynamicWorkflowTools.call(this, { source: "run_control", traceContext });
}
