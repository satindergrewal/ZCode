// ============================================================
// The `path` source: reading a script file on disk into execution facts.
// ============================================================
//
// Four tools share this (CreateWorkflow.path, AmendWorkflow.path, SaveWorkflow.script_path,
// `EvalWorkflowSnippet.path`). Sharing is not about saving lines: both must answer "what is this file" identically,
// answer, else the same draft is "a saved definition with metadata block" in Create but "a script whose first line is
// a comment" in Save — a fork only surfaces the once a draft is saved as a definition.
//
// Read once, only once: the bytes then travel to hook, confirm dialog, and handler (the resolveInput covenant),
// and editing the file after approval cannot change what will run.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SavedWorkflowMeta } from "@zcode/contracts";
import { SAVED_WORKFLOW_SENTINEL, parseSavedWorkflow } from "./saved-workflows/index.js";
import { describeWorkflowScriptPath } from "./workflow-script-path.js";

/** A successfully read script file. */
export interface WorkflowScriptFile {
  /** Absolute path (journal stores it; model face shows {@link described}). */
  path: string;
  /** The model-facing form: relative under the workspace, else absolute. */
  described: string;
  /** The file verbatim. */
  source: string;
  /** What executes/what saves: body when a metadata block exists, else the whole file. */
  script: string;
  /** Declarations parsed from the metadata block; absent without one. */
  meta?: SavedWorkflowMeta;
  /// Lines before the body (0 without a block); added when diagnostics report file lines.
  bodyLineOffset: number;
}

export type WorkflowScriptFileResult =
  | { ok: true; file: WorkflowScriptFile }
  | { ok: false; message: string };

/**
 * Relative paths resolve against the session workdir; absolute paths normalize as-is -- the same rule
 * (core/src/tool/path-policy.ts's `resolveWorkspacePath`).
 *
 * This does not call that helper: it demands a workspaceRoot, while the resolveInput context
 * (`ToolInputResolutionContext`) deliberately narrow: only `workingDirectory`. On `operation: "read"` the two behave
 * identically anyway — that function does not hard-block outside-workspace paths, it just resolves/normalizes.
 */
export function resolveWorkflowScriptFilePath(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.resolve(cwd, inputPath);
}

/**
 * Read a script file. Unreadable or broken metadata block => structured failure **naming the file** --
 * The model will assume it mistyped and retry verbatim.
 *
 * `parseFrontmatter: false` is for EvalWorkflowSnippet: snippets have none of the saved-def semantics;
 * is code; a fragment that merely opens with `/* zcode-workflow` must not be swallowed as a declaration block.
 */
export async function readWorkflowScriptFile(options: {
  cwd: string;
  inputPath: string;
  parseFrontmatter?: boolean;
}): Promise<WorkflowScriptFileResult> {
  const absolute = resolveWorkflowScriptFilePath(options.cwd, options.inputPath);
  const described = describeWorkflowScriptPath(absolute, options.cwd);

  let source: string;
  try {
    source = await readFile(absolute, "utf8");
  } catch (error) {
    return {
      ok: false,
      message: `The workflow script file ${described} could not be read: ${describeError(error)}. Pass \`path\` for a file that exists, or submit the script inline.`,
    };
  }

  const base = { path: absolute, described, source };
  if (options.parseFrontmatter === false || !startsWithSentinel(source)) {
    return { ok: true, file: { ...base, script: source, bodyLineOffset: 0 } };
  }

  const parsed = parseSavedWorkflow(source);
  if (!parsed.ok) {
    return {
      ok: false,
      message: `The workflow script file ${described} starts with a \`${SAVED_WORKFLOW_SENTINEL}\` metadata block that could not be read (${parsed.reason}): ${parsed.detail}. Fix the block in that file, or remove it and pass the script alone.`,
    };
  }
  return {
    ok: true,
    file: {
      ...base,
      script: parsed.script,
      meta: parsed.meta,
      bodyLineOffset: parsed.bodyLineOffset,
    },
  };
}

/**
 * Is the first non-empty line the opener? Verbatim-identical to parseSavedWorkflow's own entry test --
 * give different answers for "is this a saved definition", you get the dead corner "the tool says no block, the parser says broken block".
 */
function startsWithSentinel(source: string): boolean {
  for (const line of source.split("\n")) {
    if (line.trim() === "") continue;
    return line.trim() === SAVED_WORKFLOW_SENTINEL;
  }
  return false;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
