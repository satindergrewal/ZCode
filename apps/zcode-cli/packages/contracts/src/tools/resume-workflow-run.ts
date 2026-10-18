// ============================================================
// ResumeWorkflowRun Tool - resume a cancelled / Interrupted workflow run
// ============================================================
// See the contract of
// `DynamicWorkflowRunPort.resume` (interfaces/dynamic-workflow-run.port.ts).
//
// Third entry point for workflow-run resume (after the UI detail-page button and CLI /dwf resume); the execution base is
// untouched: the same `port.resume(runId)`, resuming in place under the same runId (script pinned by scriptHash, args and
// caps reused from the journal, finished nodes replayed, unfinished nodes redispatched).
//
// Output is success-shaped only: failures go through ToolHandlerFailure (core side), never this schema -- hence every field required,
// none optional. `status: backgrounded` lets the executor's auto-tracking claim it by output shape, via the
// same trackBackgroundTask as CreateWorkflow.

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const RESUME_WORKFLOW_RUN_TOOL_NAME = "ResumeWorkflowRun";

export const ResumeWorkflowRunInputSchema = z
  .object({
    // snake_case follows GetWorkflowRun's run_id (which follows TaskOutput's task_id): to the model these
    // three keys are one family of run/task ids. The resumable set (cancelled union failed+Interrupted) is stated in
    // describe; the authority is port.resume server-side -- this is routing guidance only.
    run_id: z
      .string()
      .min(1)
      .describe(
        "The workflow run ID to resume — a cancelled run or one that failed with code `Interrupted`, as seen with GetWorkflowRun or ListWorkflowRuns",
      ),
  })
  .strict();

export type ResumeWorkflowRunInput = z.infer<typeof ResumeWorkflowRunInputSchema>;

export const ResumeWorkflowRunInputJsonSchema = toToolJsonSchema(ResumeWorkflowRunInputSchema);

/**
 * Success output: the run is resumed and flying in the background.
 *
 * - `backgroundTaskId ≡ runId` (same identity as CreateWorkflow's backgrounded output); cancel,
 *   TaskOutput queries, and terminal-notice paths all share this one key.
 * - `status` accepts only the backgrounded literal: the executor's background tracking triggers on this shape; one more value
 *   would mean one more lifecycle branch to explain.
 * - `response` is guidance prose for the model (don't poll, wait for the notice), built by the core handler -- prose, not a
 *   contract field; the schema only guarantees presence.
 */
export const ResumeWorkflowRunOutputSchema = z
  .object({
    ok: z.literal(true),
    runId: z.string().min(1),
    response: z.string(),
    status: z.literal("backgrounded"),
    backgroundTaskId: z.string().min(1),
  })
  .strict();

export type ResumeWorkflowRunOutput = z.infer<typeof ResumeWorkflowRunOutputSchema>;

export const ResumeWorkflowRunOutputJsonSchema = toToolJsonSchema(ResumeWorkflowRunOutputSchema);
