// ============================================================
// The `path` source: reading a script file on disk into execution facts.
// ============================================================
//
// Four tools share this (CreateWorkflow.path, AmendWorkflow.path, SaveWorkflow.script_path,
 EvalWorkflowSnippet.path) -- not to save lines: they must answer "what is this file" identically, or the
 same draft is "a saved def with metadata block" in Create but "a script whose first line is a comment" in
 Save -- a fork discovered only when the user saves the draft as a def.
//
// Read once, only once: the bytes then travel to hook, confirm dialog, and handler (the resolveInput
 contract); post-approval edits cannot change what will run.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SavedWorkflowMeta } from "@zcode/contracts";
import { SAVED_WORKFLOW_SENTINEL, parseSavedWorkflow } from "./saved-workflows/index.js";
import { describeWorkflowScriptPath } from "./workflow-script-path.js";

/** A successfully read script file. */
interface WorkflowScriptFile {
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

type WorkflowScriptFileResult =
  | { ok: true; file: WorkflowScriptFile }
  | { ok: false; message: string };

/**
 * Relative paths resolve against the session workdir; absolute paths normalize as-is -- the same rule
 Read applies to a path (resolveWorkspacePath in core/src/tool/path-policy.ts).
 *
 * This does not call that helper: it demands a workspaceRoot, while the resolveInput context
 (ToolInputResolutionContext) is deliberately narrow -- workingDirectory only. Their operation:"read"
 behavior is identical anyway: no hard workspace wall, the same resolve/normalize.
 */
function resolveWorkflowScriptFilePath(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? path.normalize(inputPath) : path.resolve(cwd, inputPath);
}

/**
 * Read a script file. Unreadable or broken metadata block => structured failure **naming the file** --
 unnamed, the model assumes its own typo and retries verbatim.
 *
 * `parseFrontmatter: false` is for EvalWorkflowSnippet: snippets have none of the saved-def semantics;
 the whole file is code -- a snippet that happens to open with /* zcode-workflow must not lose it to a declaration block.
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
 two different answers to "is this a saved def" create the "tool says no block, parser says broken block" corner.
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
