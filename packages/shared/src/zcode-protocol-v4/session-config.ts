import { z } from "zod";
import { modelSelectionSchema } from "../model-selection.js";

// ── config──
export const sessionConfigStateSchema = z.object({
  /// The sparse selection intent the session accepted and persisted; provider/model/thought are UI-effective projections only.
  modelSelection: modelSelectionSchema.optional(),
  provider: z.string(),
  model: z.string(),
  thought: z.string(),
  // The thinking level is the current model's capability, not a workspace/UI preference.
  // default is legacy-snapshot compat; new agents must project the actual set from the runtime.
  thoughtLevels: z.array(z.string()).default([]),
  followupMode: z.enum(["queue", "guide"]),
  // additive (frozen-surface evolution, same ruling as meta): the agent collaboration mode (core CollaborationMode).
  // Needs a default to keep legacy snapshot/sender parsing; the projection updates via SessionModeChanged.
  mode: z.string().default("build"),
  planEnabled: z.boolean().optional(),
  /// Explicit approval verdict; drafts consume it once by interactionId, plain mode updates never reset it.
  permissionGrant: z.object({ interactionId: z.string().min(1) }).optional(),
  /// Correlation of the latest tool transition, for directed draft sync; no new visible history event.
  planTransition: z
    .object({
      toolCallId: z.string(),
      planEnabled: z.boolean(),
    })
    .optional(),
});
export type SessionConfigState = z.infer<typeof sessionConfigStateSchema>;

export const sessionModelTransitionSchema = z.object({
  eventId: z.string().min(1),
  origin: z.literal("registryFallback"),
  from: z.object({
    provider: z.string(),
    model: z.string(),
  }),
  to: z.object({
    provider: z.string(),
    model: z.string(),
  }),
});
export type SessionModelTransition = z.infer<typeof sessionModelTransitionSchema>;
