// ============================================================
// Saved workflows - frontmatter codec
// ============================================================
//
// File shape:
//
//     /* zcode-workflow
//     description: ...
//     args:
//       pr: { type: string, required: true }
//     */
//     <plain dwf script>
//
// Why a **block comment**, not Markdown `---` fences: saved files are `.dwf.ts`,
// opened in editors, maybe hand-edited. A block comment keeps the file valid TypeScript: highlight,
// bracket matching, formatting all work; `---` would make line one a syntax error.
//
// YAML body, not JSON: `yaml` is already a direct @zcode/core dep (nothing new), and hand-editing
// YAML beats hand-editing quoted, comma-laden JSON — humans read this file.

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { SavedWorkflowMetaSchema, type SavedWorkflowMeta } from "@zcode/contracts";

/** The frontmatter open marker; the first non-whitespace content of the file. */
export const SAVED_WORKFLOW_SENTINEL = "/* zcode-workflow";

/** The close marker: a line holding only the block-comment terminator. */
const SAVED_WORKFLOW_TERMINATOR = "*/";

export type SavedWorkflowParseErrorReason =
  | "missing_frontmatter"
  | "unterminated_frontmatter"
  | "invalid_yaml"
  | "invalid_metadata";

export type SavedWorkflowParseResult =
  | {
      ok: true;
      meta: SavedWorkflowMeta;
      script: string;
      /**
       * Lines before the body (lead blank + open marker + YAML + close). Added when diagnostics report by **file line**:
       * `fileLine = bodyLine + bodyLineOffset`. The compiler sees only past the close, so the two line sets differ by
       * exactly this constant; per-call recomputation is where line-mismatch bugs are born.
       */
      bodyLineOffset: number;
    }
  | { ok: false; reason: SavedWorkflowParseErrorReason; detail: string };

/**
 * Metadata + script → file body.
 *
 * The script sits **byte-exact** after the close: save-then-read returns what the author wrote, or the run script hash
 * diverges from the editor view (the resume baseline is the raw script).
 */
export function serializeSavedWorkflow(meta: SavedWorkflowMeta, script: string): string {
  // Fixed key order (description → whenToUse → args), not insertion order: two saves must yield
  // byte-identical files, or every SaveWorkflow mints a pointless git diff.
  const body: Record<string, unknown> = { description: meta.description };
  if (meta.whenToUse !== undefined) body.whenToUse = meta.whenToUse;
  if (meta.args !== undefined) body.args = meta.args;

  // stringify ends with a newline, so the close line follows directly.
  return `${SAVED_WORKFLOW_SENTINEL}\n${stringifyYaml(body)}${SAVED_WORKFLOW_TERMINATOR}\n${script}`;
}

/**
 * File body → metadata + script.
 *
 * Four failures, four names, four fixes: no frontmatter means not-a-saved-
 * workflow; unclosed, a deleted line; bad YAML, indentation; schema fail, a field-name typo.
 * One generic parse-error helps none of them.
 */
export function parseSavedWorkflow(source: string): SavedWorkflowParseResult {
  const lines = source.split("\n");

  let start = 0;
  while (start < lines.length && lines[start]!.trim() === "") start += 1;
  if (start >= lines.length || lines[start]!.trim() !== SAVED_WORKFLOW_SENTINEL) {
    return {
      ok: false,
      reason: "missing_frontmatter",
      detail: `file does not start with the \`${SAVED_WORKFLOW_SENTINEL}\` metadata block`,
    };
  }

  let end = start + 1;
  while (end < lines.length && lines[end]!.trim() !== SAVED_WORKFLOW_TERMINATOR) end += 1;
  if (end >= lines.length) {
    return {
      ok: false,
      reason: "unterminated_frontmatter",
      detail: `metadata block is never closed with \`${SAVED_WORKFLOW_TERMINATOR}\``,
    };
  }

  const bodyText = lines.slice(start + 1, end).join("\n");
  // Everything after the close is script, verbatim (no-final-newline files too: slice yields empty).
  const script = lines.slice(end + 1).join("\n");

  let body: unknown;
  try {
    body = parseYaml(bodyText);
  } catch (error) {
    return {
      ok: false,
      reason: "invalid_yaml",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const parsed = SavedWorkflowMetaSchema.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_metadata",
      detail: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    };
  }

  // The body starts after the close line: exactly `end + 1` lines precede it.
  return { ok: true, meta: parsed.data, script, bodyLineOffset: end + 1 };
}
