// ============================================================
// Saved workflows - shared vocabulary for persisted dwf definitions
// ============================================================
//
// This module **only** declares what a saved workflow is: legal name shape, file location, argument declarations, and
// metadata. Three tools (SaveWorkflow writes, ListSavedWorkflows reads, CreateWorkflow runs with the saved
// source) all contract against it, and the core store takes its schema from here -- if the metadata shape drifts between the write and read
// sides, the symptom is a just-saved workflow missing from the list, the hardest fork for one-sided tests to catch.

import { z } from "zod";

/**
 * Saved-file extension. .dwf.ts, not .ts: editors highlight it as TypeScript (the frontmatter is a block comment,
 * syntactically valid), while the .dwf part lets scanners tell it from project sources without opening the file.
 */
export const SAVED_WORKFLOW_FILE_EXTENSION = ".dwf.ts";

/** Project-scoped storage dir (relative to the session working directory). */
export const SAVED_WORKFLOW_PROJECT_DIR = ".zcode/workflows";

/**
 * Draft dir (relative to the session working directory). Where the model edits scripts in place between commits; a sibling of
 * .zcode/workflows/ (user-saved definitions), machine-owned, shipping its own .gitignore covering everything.
 */
export const WORKFLOW_DRAFTS_DIR = ".zcode/workflow-drafts";

/**
 * Global-scoped storage dir (relative to the agent process home). Location ~/.zcode/workflows/<name>.dwf.ts --
 * the same place as the legacy Workflow tool's user root, visible across projects.
 */
export const SAVED_WORKFLOW_GLOBAL_DIR = ".zcode/workflows";

/**
 * Legal name shape. Same pattern as the legacy Workflow tool parser (script-workflow-tool-port.ts) --
 * the name doubles as a filename, so slashes, dot-dot, and whitespace are all disallowed: this regex **is** the path-traversal guard,
 * not a style preference.
 */
export const SAVED_WORKFLOW_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/u;

/** Name length cap. The filename must hold on every platform; 64 is far below any PATH_MAX and descriptive enough. */
export const SAVED_WORKFLOW_MAX_NAME_CHARS = 64;

/**
 * Scope. Two tiers: project lives in the project's .zcode/workflows/, visible only there; global lives in
 * ~/.zcode/workflows/ (agent-process home), visible to all projects. A file's scope is inferred from its directory, never stored in frontmatter.
 */
export const SAVED_WORKFLOW_SCOPES = ["project", "global"] as const;

export const SavedWorkflowScopeSchema = z.enum(SAVED_WORKFLOW_SCOPES);

export type SavedWorkflowScope = z.infer<typeof SavedWorkflowScopeSchema>;

/**
 * Shadowing fact: the other tier already has a same-named definition. Computed at save time for the confirmation dialog.
 * hides_global: this save is the project tier and shadows the same-named global tier in this project;
 * hidden_by_project: this save is the global tier and a same-named project tier in this project shadows it.
 */
export const SAVED_WORKFLOW_SHADOWING = ["hides_global", "hidden_by_project"] as const;

export const SavedWorkflowShadowingSchema = z.enum(SAVED_WORKFLOW_SHADOWING);

export type SavedWorkflowShadowing = z.infer<typeof SavedWorkflowShadowingSchema>;

/**
 * Type vocabulary for arguments. Three primitives plus a json catch-all: primitives can fail validation as a wrong type, while json means
 * anything goes -- so unvalidated and validate-anything are different declarations, not the same hole.
 */
export const SAVED_WORKFLOW_ARG_TYPES = ["string", "number", "boolean", "json"] as const;

export const SavedWorkflowArgTypeSchema = z.enum(SAVED_WORKFLOW_ARG_TYPES);

export type SavedWorkflowArgType = z.infer<typeof SavedWorkflowArgTypeSchema>;

export const SavedWorkflowArgDeclarationSchema = z
  .object({
    type: SavedWorkflowArgTypeSchema.describe(
      'Value type. "json" accepts any JSON value without further checking.',
    ),
    description: z
      .string()
      .optional()
      .describe("What this argument means, for whoever calls the workflow later."),
    required: z
      .boolean()
      .optional()
      .describe("When true the workflow cannot run without this argument."),
    // `default` is deliberately unknown, not a union discriminated by `type`: default-value correctness is enforced by
    // validateWorkflowArgs **after defaults are applied**, the same path as passed values -- one rule, not two.
    default: z.unknown().optional().describe("Value used when the caller omits this argument."),
  })
  .strict();

export type SavedWorkflowArgDeclaration = z.infer<typeof SavedWorkflowArgDeclarationSchema>;

export const SavedWorkflowArgsDeclarationSchema = z.record(SavedWorkflowArgDeclarationSchema);

export type SavedWorkflowArgsDeclaration = z.infer<typeof SavedWorkflowArgsDeclarationSchema>;

/**
 * Metadata body inside the frontmatter. .strict() turns a single mistyped key into a visible invalid line instead of
 * a silently dropped field -- saved files are hand-edited, so typos must be pointable.
 */
export const SavedWorkflowMetaSchema = z
  .object({
    description: z.string().min(1),
    whenToUse: z.string().min(1).optional(),
    args: SavedWorkflowArgsDeclarationSchema.optional(),
  })
  .strict();

export type SavedWorkflowMeta = z.infer<typeof SavedWorkflowMetaSchema>;

/** One row of the listing: metadata + location, **no script body** (enumeration, not reading). */
export const SavedWorkflowEntrySchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    whenToUse: z.string().optional(),
    args: SavedWorkflowArgsDeclarationSchema.optional(),
    scope: SavedWorkflowScopeSchema,
    path: z.string().min(1),
  })
  .strict();

export type SavedWorkflowEntry = z.infer<typeof SavedWorkflowEntrySchema>;

/**
 * A file that exists but cannot be read. Listing **never fails because of one bad file**: when a user corrupts a frontmatter,
 * the rest must stay usable, and the bad file must be called out -- otherwise it just vanishes.
 */
export const SavedWorkflowInvalidEntrySchema = z
  .object({
    path: z.string().min(1),
    reason: z.string().min(1),
  })
  .strict();

export type SavedWorkflowInvalidEntry = z.infer<typeof SavedWorkflowInvalidEntrySchema>;

/** Whether the name can serve as a filename (i.e. may point at a saved workflow). */
export function isValidSavedWorkflowName(name: string): boolean {
  if (name.length === 0 || name.length > SAVED_WORKFLOW_MAX_NAME_CHARS) return false;
  if (!SAVED_WORKFLOW_NAME_PATTERN.test(name)) return false;
  // Dot and dot-dot pass the charset check above yet are directory entries, not names.
  return name.replaceAll(".", "").length > 0;
}
