import { z } from "zod";

// Raw Bash files never enter the protocol; only a bounded head plus true truncation/retention facts.
export const bashOutputDisplaySchema = z
  .object({
    kind: z.literal("bash_output"),
    output: z.string().max(150_000),
    truncated: z.boolean(),
    outputPath: z.string().min(1).max(32_768).optional(),
  })
  .strict();
