import { z } from "zod";
import { attachmentSourceKindSchema } from "../attachment-source.js";

/** Carries committed-content references and display metadata only; content itself never enters command/topic frames. */
export const attachmentRefSchema = z
  .object({
    ref: z.string(),
    fileName: z.string(),
    mime: z.string(),
    bytes: z.number(),
    sourceKind: attachmentSourceKindSchema.optional(),
    messageCount: z.number().int().nonnegative().optional(),
    previewRef: z.string().optional(),
  })
  .strict();

export type AttachmentRef = z.infer<typeof attachmentRefSchema>;
