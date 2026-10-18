// ============================================================
// SaveWorkflow Tool - persist a dwf script plus metadata as a reusable definition
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import { CreateWorkflowDiagnosticSchema } from "./create-workflow.js";
import {
  SAVED_WORKFLOW_MAX_NAME_CHARS,
  SavedWorkflowArgsDeclarationSchema,
  SavedWorkflowScopeSchema,
  SavedWorkflowShadowingSchema,
} from "./saved-workflow.js";

export const SAVE_WORKFLOW_TOOL_NAME = "SaveWorkflow";

/**
 * Violation note for exactly-one-body-source. The field is not named path because path is already the **resolved
 * destination** this tool fills in (read by the confirmation dialog and UI); two same-named fields, one input and one output,
 * would only invite the model to pass the destination in as the source.
 */
export const SAVE_WORKFLOW_SOURCE_ERROR =
  "Provide exactly one script source: `script` for the body inline, or `script_path` for the file holding it (a draft, usually). Passing both, or neither, is ambiguous.";

/** Business-failure note for a script the model passes in carrying its own frontmatter. */
export const SAVE_WORKFLOW_SENTINEL_IN_SCRIPT_ERROR =
  "The `script` must be the workflow body only — it already starts with a `/* zcode-workflow` metadata block. Pass the metadata through the `description` / `whenToUse` / `args` fields instead; the block is written for you.";

export const SaveWorkflowInputSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(SAVED_WORKFLOW_MAX_NAME_CHARS)
      .describe("File-safe identifier: letters, digits, dot, dash and underscore."),
    description: z.string().min(1).describe("One line saying what the workflow does."),
    whenToUse: z.string().min(1).optional().describe("When this workflow is the right answer."),
    args: SavedWorkflowArgsDeclarationSchema.optional().describe(
      "Argument declarations the script reads off `args`.",
    ),
    script: z
      .string()
      .optional()
      .describe(
        "The script body, inline, without a metadata block. This OR `script_path`, never both.",
      ),
    /**
     * Second body source: a file already on disk,
     * usually the latest draft. If it carries a metadata block the **block is dropped** -- metadata is governed by
     * this call's fields; what the user approved is those fields, not the copy in the file.
     */
    script_path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "A file holding the script body, usually a draft a result named. This OR `script`, never both.",
      ),
    // Scope is stated by the **model**, never guessed -- no default; decided every time. Neutral test: does the
    // script reference anything from this repo? yes -> project, no -> global.
    scope: SavedWorkflowScopeSchema.describe(
      '"project" when the script depends on this repository; "global" when it depends on nothing in it. Required, no default.',
    ),
    // -- the three fields below are resolved and filled in by `resolveInput`, never by the model --
    // they are **facts for the confirmation dialog**: which file this save lands on, whether it is an overwrite, whether it shadows the other tier.
    // Carried as inputs rather than display because the input channel is schema-less passthrough on every client version, so old desktop and
    // legacy v3 see the full content too.
    /** Resolved back: destination file. */
    path: z.string().min(1).optional(),
    /** Resolved back: the target exists; this approval is an **overwrite**. */
    overwrite: z.boolean().optional(),
    /** Resolved back: the other tier has a same-named definition (shadowing fact, for the confirmation dialog). Absent = none. */
    shadowing: SavedWorkflowShadowingSchema.optional(),
  })
  .strict();

export type SaveWorkflowInput = z.infer<typeof SaveWorkflowInputSchema>;

export const SaveWorkflowInputJsonSchema = toToolJsonSchema(SaveWorkflowInputSchema);

/**
 * The output shares one schema with CreateWorkflow's diagnostics: both tools run the **same** type checker,
 * and showing the model two different shapes would just teach it to write two parsers.
 *
 * `overwritten` appears only when the file was really written -- a diagnostics-only result has no overwritten-or-not truth, and
 * emitting false would tell the model the write succeeded.
 */
export const SaveWorkflowOutputSchema = z
  .object({
    diagnostics: z.array(CreateWorkflowDiagnosticSchema),
    ok: z.boolean(),
    response: z.string(),
    name: z.string().min(1),
    scope: SavedWorkflowScopeSchema,
    /** Destination file (the **would-be** location when nothing was written, so the model can state the error precisely). */
    path: z.string().min(1),
    overwritten: z.boolean().optional(),
  })
  .strict();

export type SaveWorkflowOutput = z.infer<typeof SaveWorkflowOutputSchema>;

export const SaveWorkflowOutputJsonSchema = toToolJsonSchema(SaveWorkflowOutputSchema);
