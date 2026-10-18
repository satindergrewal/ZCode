// ============================================================
// SaveWorkflow Tool - store a dwf script plus metadata as a project-reusable definition
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
 * Violation copy for "exactly one body source". The field is not named `path` because `path`
 * is already this tool's **resolved backfill destination** (read by the confirm dialog and UI);
 * two same-named fields, one input one output, would only have the model pass the save target
 * as the source file.
 */
export const SAVE_WORKFLOW_SOURCE_ERROR =
  "Provide exactly one script source: `script` for the body inline, or `script_path` for the file holding it (a draft, usually). Passing both, or neither, is ambiguous.";

/** Business-failure copy for the model passing a script with its own frontmatter. */
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
     * The second body source: a file already on disk,
     * usually the draft that just ran. When the file carries a metadata block the block is
     ** dropped** - this call's fields govern the metadata; the user approved those, not the
     * file's copy.
     */
    script_path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "A file holding the script body, usually a draft a result named. This OR `script`, never both.",
      ),
    // The scope is stated by the **model**, never guessed - no default, decided every time. A
    // neutral test: does the script reference anything in this repo? yes -> project, no -> global.
    scope: SavedWorkflowScopeSchema.describe(
      '"project" when the script depends on this repository; "global" when it depends on nothing in it. Required, no default.',
    ),
    /**
     * Provenance (docs/dynamic-workflow/launch.md "`SaveWorkflow`"): which run this definition
     * was distilled from. **Not a third body source** - the body still comes only from
     * `script` / `script_path`, and the handler does not read it. Its only job is letting that
     * run's completion card recognize it has been saved
     * (docs/dynamic-workflow/transcript-and-notifications.md
     * "Which workflow a run is saved as") - the **only** durable link between the saved
     * definition and the run: the name is the model's own, the script summary-rewritten; neither
     * joins back.
     */
    run_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Provenance only: the id of the run this workflow was distilled from, when saving a workflow that just ran. Pass it whenever you know it; it does not change what is saved.",
      ),
    // - The next three fields are resolved/backfilled by `resolveInput`, never model-filled -
    // they are **facts the confirm dialog displays**: target file, overwrite or not, shadowing
    // another archive. They ride the input, not display, because the input channel is a
    // schemaless passthrough on every client version - legacy desktop and v3 see the full
    // content too.
    /** Resolve backfill: file destination. */
    path: z.string().min(1).optional(),
    /** Resolve backfill: the target exists; this approval is an **overwrite**. */
    overwrite: z.boolean().optional(),
    /** Resolve backfill: the other archive holds a same-name definition (shadowing fact for the dialog). Absent = none. */
    shadowing: SavedWorkflowShadowingSchema.optional(),
  })
  .strict();

export type SaveWorkflowInput = z.infer<typeof SaveWorkflowInputSchema>;

export const SaveWorkflowInputJsonSchema = toToolJsonSchema(SaveWorkflowInputSchema);

/**
 * Output shares one schema with CreateWorkflow's diagnostics: both tools run the **same**
 * typechecker; different diagnostic shapes per tool would only teach the model two parsers.
 *
 * `overwritten` appears only when a file was really written - a diagnostics-only result has no
 * notion of "overwritten", and a `false` would read to the model as a successful save.
 */
export const SaveWorkflowOutputSchema = z
  .object({
    diagnostics: z.array(CreateWorkflowDiagnosticSchema),
    ok: z.boolean(),
    response: z.string(),
    name: z.string().min(1),
    scope: SavedWorkflowScopeSchema,
    /** File destination (on failure, where it **would** have been written, so the model can state the error precisely). */
    path: z.string().min(1),
    overwritten: z.boolean().optional(),
  })
  .strict();

export type SaveWorkflowOutput = z.infer<typeof SaveWorkflowOutputSchema>;

export const SaveWorkflowOutputJsonSchema = toToolJsonSchema(SaveWorkflowOutputSchema);
