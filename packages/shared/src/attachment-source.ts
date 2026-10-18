import { z } from "zod";

/** Text material passes file references only; cross-device upload must not fall back to automatic full-text injection. */
export const attachmentSourceKindSchema = z.enum(["clipboard-text", "topic-history"]);
export type AttachmentSourceKind = z.infer<typeof attachmentSourceKindSchema>;
