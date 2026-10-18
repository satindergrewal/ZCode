import { z } from "zod";

/** In-memory credential issued by the agent; Main's initId is for the port handshake only. */
export const mcpAppInstanceSchema = z
  .object({
    runtimeId: z.string().min(1),
    generation: z.number().int().positive(),
    appIdentity: z.string().regex(/^[a-f0-9]{64}$/),
    token: z.string().min(1),
  })
  .strict();
export type McpAppInstance = z.infer<typeof mcpAppInstanceSchema>;
