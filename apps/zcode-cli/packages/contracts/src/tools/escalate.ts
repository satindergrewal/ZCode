// ============================================================
// escalate Tool - actor escalates a blocking question to the main agent
// ============================================================
// Injected into actor sessions exactly like `submit_result`
// (registered when the port exists, re-added by core even under `tools:"none"`), but the two settle different
// things: submit settles **this ask's result**, escalate settles **one question-answer round**.
//
// The output is deliberately a flat object with a discriminant, not a union: both branches are ordinary tool
// results (not errors); the model only ever reads the text, and `status` serves logging and result projection.

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const ESCALATE_TOOL_NAME = "escalate";

export const EscalateInputSchema = z
  .object({
    question: z
      .string()
      .min(1)
      .describe(
        "The single focused question that unblocks you. One question per call, answerable in a sentence.",
      ),
    context: z
      .string()
      .optional()
      .describe(
        "What you already tried and where exactly you are stuck — the evidence the answerer needs.",
      ),
  })
  .strict();

export type EscalateInput = z.infer<typeof EscalateInputSchema>;

export const EscalateInputJsonSchema = toToolJsonSchema(EscalateInputSchema);

/**
 * Outcome of one escalation.
 *
 * - `answered`: `message` is the main agent's verbatim answer, `qid` the globally unique id of this Q&A.
 * - `refused`: `message` states the situation and next step (budget exhausted / no in-flight ask); `reason` is
 *   the discriminant. **Not an error** -- rendering "budget exhausted" as an error tool_result makes the model
 *   treat it as retryable and repeatedly hit the same wall, exactly the behavior this feature exists to kill.
 */
export const EscalateOutputSchema = z
  .object({
    status: z.enum(["answered", "refused"]),
    message: z.string(),
    /** Present only for `answered`. */
    qid: z.string().optional(),
    /** Present only for `refused`. */
    reason: z.enum(["budget_exhausted", "no_active_ask"]).optional(),
  })
  .strict();

export type EscalateOutput = z.infer<typeof EscalateOutputSchema>;

export const EscalateOutputJsonSchema = toToolJsonSchema(EscalateOutputSchema);
