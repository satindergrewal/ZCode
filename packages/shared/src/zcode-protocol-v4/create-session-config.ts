import { z } from "zod";
import { modelSelectionSchema } from "../model-selection.js";

export const createSessionRequestedConfigSchema = z.object({
  modelSelection: modelSelectionSchema.optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  thought: z.string().optional(),
  followupMode: z.enum(["queue", "guide"]).optional(),
  // Bugfix: createSession.config expresses request-time overrides and must not reuse the snapshot's
  // sessionConfigStateSchema.partial(); the snapshot sets mode default('build') for legacy-snapshot compat,
  // which turns 'no mode given' into 'switch back to build', clobbering the workspace default yolo.
  mode: z.string().optional(),
  planEnabled: z.boolean().optional(),
});
