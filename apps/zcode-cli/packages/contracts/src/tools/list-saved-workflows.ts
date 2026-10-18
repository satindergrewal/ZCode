// ============================================================
// ListSavedWorkflows Tool - enumerate this project's saved dwf definitions
// ============================================================
//
// A different thing than ListWorkflowRuns: that one lists executed runs (history), this one lists
// runnable definitions (the catalogue). The Runs/SavedWorkflows naming split is deliberate -- the model's
// most common confusion is asking "which workflows exist" as "which workflows ran".

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import { SavedWorkflowEntrySchema, SavedWorkflowInvalidEntrySchema } from "./saved-workflow.js";

export const LIST_SAVED_WORKFLOWS_TOOL_NAME = "ListSavedWorkflows";

export const ListSavedWorkflowsInputSchema = z
  .object({})
  // Same constraint as ListWorkflowRuns: deliberately no cwd input; the tool always scans the current session's working dir.
  // The model may not scan across projects -- also the precondition for `sideEffectScope: "none"`.
  .strict();

export type ListSavedWorkflowsInput = z.infer<typeof ListSavedWorkflowsInputSchema>;

export const ListSavedWorkflowsInputJsonSchema = toToolJsonSchema(ListSavedWorkflowsInputSchema);

export const ListSavedWorkflowsOutputSchema = z
  .object({
    workflows: z.array(SavedWorkflowEntrySchema),
    /** Unreadable files. Absent when empty -- an empty array would hang a noise field on every call. */
    invalid: z.array(SavedWorkflowInvalidEntrySchema).optional(),
  })
  .strict();

export type ListSavedWorkflowsOutput = z.infer<typeof ListSavedWorkflowsOutputSchema>;

export const ListSavedWorkflowsOutputJsonSchema = toToolJsonSchema(ListSavedWorkflowsOutputSchema);
