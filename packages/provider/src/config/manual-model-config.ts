import { z } from "zod";
import { completeModelConfigDataSchema, modelConfigDataSchema } from "@zcode/shared/model-config";

const complete = completeModelConfigDataSchema.shape;
// Manual mode freezes only product-blessed leaves; new system fields default to
// non-personal-manual.
export const manualModelConfigSchema = completeModelConfigDataSchema
  .pick({ enabled: true })
  .extend({
    enabled: modelConfigDataSchema.shape.enabled,
    properties: complete.properties
      .pick({
        contextWindow: true,
        supportsJsonSchemaOutput: true,
        supportsNativeWebSearch: true,
        supportsMidConversationSystem: true,
      })
      .extend({
        inputFormat: complete.properties.shape.inputFormat.pick({
          supportsImage: true,
          supportsVideo: true,
          supportsPdf: true,
        }),
      }),
    optionSpecs: complete.optionSpecs.pick({ reasoningLevel: true }).extend({
      maxOutputTokens: complete.optionSpecs.shape.maxOutputTokens.pick({ max: true }),
    }),
  });

export type ManualModelConfig = z.infer<typeof manualModelConfigSchema>;

/** Draft/legacy full-rule extraction reuses the schema shapes; no second editable-field list to maintain. */
export function extractManualModelConfig(input: unknown): ManualModelConfig {
  return manualModelConfigSchema.parse(pickSchemaFields(manualModelConfigSchema, input));
}

/** Keeps standalone enabled and system leaves; smart-config restore and rule merging share this ownership. */
export function clearManualModelConfig(input: z.infer<typeof modelConfigDataSchema>) {
  return modelConfigDataSchema.parse(
    omitSchemaFields(manualModelConfigSchema.omit({ enabled: true }), input),
  );
}

function omitSchemaFields(schema: z.ZodObject, input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  return Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) => {
      const child = schema.shape[key];
      if (!child) return [[key, value]];
      if (!(child instanceof z.ZodObject) || value == null) return [];
      const remaining = omitSchemaFields(child, value);
      return remaining && typeof remaining === "object" && Object.keys(remaining).length
        ? [[key, remaining]]
        : [];
    }),
  );
}

function pickSchemaFields(schema: z.ZodObject, input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const source = input as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(schema.shape).flatMap(([key, child]) => {
      if (!(key in source)) return [];
      return [
        [key, child instanceof z.ZodObject ? pickSchemaFields(child, source[key]) : source[key]],
      ];
    }),
  );
}
