// ============================================================
// ResolveWorkflowQuestion Tool - main agent answers a blocking question escalated by an actor
// ============================================================
// See port `DynamicWorkflowRunPort.resolveQuestion`
// （interfaces/dynamic-workflow-run.port.ts）。
//
// Takes only qid, not a (run_id, question_id) pair: qid is globally unique across runs; making the model do the
// pairing itself under concurrent runs is a mismatch factory. Failures go through ToolHandlerFailure (core side), so this output is success-shaped only.

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const RESOLVE_WORKFLOW_QUESTION_TOOL_NAME = "ResolveWorkflowQuestion";

export const ResolveWorkflowQuestionInputSchema = z
  .object({
    // snake_case matching GetWorkflowRun's run_id / ResumeWorkflowRun's run_id: to the model these are
    // the same family of opaque identifier keys.
    question_id: z
      .string()
      .min(1)
      .describe(
        "The question ID from the escalation notification, or from GetWorkflowRun's pending questions (looks like `dwfq-...`)",
      ),
    answer: z
      .string()
      .min(1)
      .describe("The answer text, delivered verbatim to the subagent that asked"),
  })
  .strict();

export type ResolveWorkflowQuestionInput = z.infer<typeof ResolveWorkflowQuestionInputSchema>;

export const ResolveWorkflowQuestionInputJsonSchema = toToolJsonSchema(
  ResolveWorkflowQuestionInputSchema,
);

export const ResolveWorkflowQuestionOutputSchema = z
  .object({
    ok: z.literal(true),
    qid: z.string().min(1),
    /** Confirmation prose for the model (prose is not contract; the schema only guarantees presence). */
    response: z.string(),
  })
  .strict();

export type ResolveWorkflowQuestionOutput = z.infer<typeof ResolveWorkflowQuestionOutputSchema>;

export const ResolveWorkflowQuestionOutputJsonSchema = toToolJsonSchema(
  ResolveWorkflowQuestionOutputSchema,
);
