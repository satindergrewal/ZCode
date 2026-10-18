// ============================================================
// submit_result Tool - actor terminal structured-result submission
// ============================================================
// Used by workflow actors (child AgentRuntime) to submit the structured result of this ask. The declared input is
// generic arbitrary JSON (a single `result` property) -- each ask's concrete schema stays out of the tool declaration
// and rides the ask instruction epilogue, preserving the frozen-per-actor tool-cache invariant.

import { z } from "zod";
import { TOOL_JSON_SCHEMA_VERSION, toToolJsonSchema } from "./json-schema.js";

export const SUBMIT_RESULT_TOOL_NAME = "submit_result";

export const SubmitResultInputSchema = z
  .object({
    // Deliberately generic: no shape constraint on result. The per-ask schema lives in the ask epilogue and is
    // validated engine-side at WorkflowSubmitPort, so this declaration stays frozen across asks and hits prompt caches.
    result: z
      .unknown()
      .describe(
        "The structured result for this ask, matching the JSON schema given in the ask instructions.",
      ),
  })
  .strict();

export type SubmitResultInput = z.infer<typeof SubmitResultInputSchema>;

export const SubmitResultInputJsonSchema = toToolJsonSchema(SubmitResultInputSchema);

/**
 * Typed tool declaration for mono-repo subagents: `result`'s subschema is the actor's single ask-result schema. Runtime
 * zod validation remains the generic `SubmitResultInputSchema` above -- per-ask shape is enforced engine-side at
 * WorkflowSubmitPort; the declaration only lets the provider see (and natively constrain, where supported) it. The outer
 * object matches the generic declaration: one required `result`, no extra keys.
 */
export function typedSubmitResultInputSchema(
  resultSchema: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      result: {
        description: "The structured result for this ask.",
        ...resultSchema,
      },
    },
    required: ["result"],
    additionalProperties: false,
    $schema: TOOL_JSON_SCHEMA_VERSION,
  };
}

export const SubmitResultOutputSchema = z
  .object({
    status: z.literal("accepted"),
  })
  .strict();

export type SubmitResultOutput = z.infer<typeof SubmitResultOutputSchema>;

export const SubmitResultOutputJsonSchema = toToolJsonSchema(SubmitResultOutputSchema);
