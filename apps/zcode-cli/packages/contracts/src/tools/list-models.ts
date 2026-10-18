// ============================================================
// ListModels Tool - list the models configured on this host
// ============================================================
//
// A read-only, side-effect-free discovery surface serving one thing: the main agent picking a subagent model for a
// workflow run (`CreateWorkflow` / `AmendWorkflow`'s `subagent_model`). Not a model switch -- this tool cannot
// change the session's own model; the main agent always stays on the user's choice.
//
// Complementary path to the parser: pass the user's name verbatim first; on parse failure the tool returns
// candidates. This tool is the proactive one ("which models do we have?"). Both read the same live registry.
// （{@link import("../interfaces/model-catalog.port.js").ModelCatalogPort}）。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const LIST_MODELS_TOOL_NAME = "ListModels";

export const ListModelsInputSchema = z
  .object({})
  // Same constraint as ListSavedWorkflows: no input at all. No filter/paging/fuzzy search -- the catalogue is a
  // few dozen rows; every extra knob is one more place for the model to assume the list is incomplete.
  .strict();

export type ListModelsInput = z.infer<typeof ListModelsInputSchema>;

export const ListModelsInputJsonSchema = toToolJsonSchema(ListModelsInputSchema);

/** One catalogue row. `id` is the canonical form, paste-ready into `subagent_model`. */
export const ListModelsEntrySchema = z
  .object({
    /** Canonical `providerId/modelId` (no reasoning tier; append `$level` yourself for one). */
    id: z.string(),
    providerId: z.string(),
    modelId: z.string(),
    /** Human-readable provider name; absent when the registry has none. */
    providerLabel: z.string().optional(),
    /** Legal `$level` values. Empty for tier-less models -- readers learn that appending `$` would be wrong. */
    reasoningLevels: z.array(z.string()),
    /** Tier used when no `$level` is given; absent when `reasoningLevels` is empty. */

    defaultReasoningLevel: z.string().optional(),
    /** Why not selectable; selectable means absent (never an empty string). */
    /** Why not selectable; selectable means absent (never an empty string). */
    disabledReason: z.string().optional(),
  })
  .strict();

export type ListModelsEntry = z.infer<typeof ListModelsEntrySchema>;

export const ListModelsOutputSchema = z
  .object({
     * The session's current model (canonical form). **A coordinate, not a recommendation**: subagents without
     * `subagent_model` run on it, so "set the subagent to this" is a no-op. Absent when no row matches.
     * `subagent_model` run on it, so "set the subagent to this" is a no-op. Absent when no row matches.
     */
    current: z.string().optional(),
    models: z.array(ListModelsEntrySchema),
  })
  .strict();

export type ListModelsOutput = z.infer<typeof ListModelsOutputSchema>;

export const ListModelsOutputJsonSchema = toToolJsonSchema(ListModelsOutputSchema);
