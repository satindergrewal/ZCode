import { z } from "zod";
import { modelSelectionSchema } from "./model-selection.js";

/**
 * Why an execution Selection falls back to the Session Selection. Declared by the initiator in the selectionFallback rules;
 * the CLI forwards the matched reason only and never interprets provider error codes itself.
 */
export const modelExecutionSelectionFallbackReasonSchema = z.enum([
  "highspeed_card_expired",
  "highspeed_request_failed",
]);

/** Text and attachment sends share execution constraints; credentials belong to the single execution, never session config. */
export const modelExecutionSchema = z
  .object({
    memoryExtraction: z.literal("skip").optional(),
    selectionScope: z.literal("execution"),
    requestAuth: z
      .object({
        apiKey: z.string().min(1).optional(),
        apiKeyId: z.string().trim().min(1).optional(),
        accountScope: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        headers: z.record(z.string().min(1), z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
    subagents: z
      .object({
        foregroundModel: z.literal("submission"),
        background: z.literal("deny"),
      })
      .strict()
      .optional(),
    /**
     * When this execution's Selection fails, fall back to the original model within the same Turn instead of failing the whole round.
     * Trigger conditions are declared by the initiator: `providerId` restricts matches to the provider this execution Selection points at;
     * `rules` match in declaration order and the first hit decides the fallback reason; a missing `providerErrorCode` means any failure of that provider
     * (except user cancels and context-overflow). The CLI hardcodes nothing by provider id prefix, model name, or error copy.
     * Fallback target: `target` first (the initiator's draw-time submission choice, i.e. the session's original model), then the runtime session's resident Selection:
     * the execution scope never rewrites the session selection, but the resident selection lives only in runtime memory and can be unbound in cold-recovery races,
     * so the initiator must declare `target` (docs/highspeed/highspeed-card-spec.md 2.2).
     */
    selectionFallback: z
      .object({
        providerId: z.string().min(1),
        rules: z
          .array(
            z
              .object({
                reason: modelExecutionSelectionFallbackReasonSchema,
                providerErrorCode: z.string().min(1).optional(),
              })
              .strict(),
          )
          .min(1),
        target: modelSelectionSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ModelExecution = z.infer<typeof modelExecutionSchema>;
export type ModelExecutionSelectionFallback = NonNullable<ModelExecution["selectionFallback"]>;
export type ModelExecutionSelectionFallbackRule = ModelExecutionSelectionFallback["rules"][number];
export type ModelExecutionSelectionFallbackReason = z.infer<
  typeof modelExecutionSelectionFallbackReasonSchema
>;
