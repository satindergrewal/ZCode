// ============================================================
// Workflow draft-directory writes
// ============================================================
// Every script the tool accepts needs a home on disk; that file is the model **handle** between submissions: diagnostics carry
// file line numbers, the next submission needs only `path`, and a one-line fix does not re-stream a 20k-token script. Inline text is thus
// just a doorway — `CreateWorkflow` / `AmendWorkflow` / hub-direct-launch write one here as soon as a script arrives not from a file,
// and only then.
//
// Location `<cwd>/.zcode/workflow-drafts/`, sibling to `.zcode/workflows/` (user-saved definitions) and
// `.zcode/workflow-runs/` (per-run compile entries). The directory ships its own `.gitignore: *`, written exactly like
// dynamic-workflow-runtime/src/child-entry-file.ts (its comment holds the ruling): created only when absent,
// never touched after user edits; the project own `.gitignore` is left alone.
//
// **Best effort**: a failed write (read-only checkout, `.zcode` a plain file, full disk) never fails the call; it returns
// `undefined`, and the model sees the legacy fix-then-resubmit-inline line. Deliberately **no** tmp-dir fallback — a
// draft the user cannot find in the project is not worth a code path.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SAVED_WORKFLOW_FILE_EXTENSION,
  WORKFLOW_DRAFTS_DIR,
  createWorkflowPhaseNames,
  type CreateWorkflowCausalityGraph,
} from "@zcode/contracts";

/**
 * Characters **not** preserved in draft filenames: anything outside Unicode letters/digits and `_ . -`.
 *
 * Deliberately unlike saved-definition names (pure ASCII): those serve as CLI args and URL fragments; a draft name only has to
 * exist on all three platforms and let human and model tell which workflow it is — and in practice run names and phase names
 * are mostly Chinese (measured: the ASCII-only variant crushed every draft into `workflow-N`; two entirely different
 * workflows became indistinguishable). Outside the alphabet, dropped chars are exactly path separators and Windows reserved
 * (`/ \ : * ? " < > |`), whitespace and control chars — path traversal stays impossible.
 */
const WORKFLOW_DRAFT_SLUG_DROP_PATTERN = /[^\p{L}\p{N}_.-]/gu;

/** Whitespace collapses to one `-`: `PR review #12` → `PR-review-12`, far more readable than `PRreview12`. */
const WORKFLOW_DRAFT_WHITESPACE_PATTERN = /\s+/gu;

/** Filename length cap, the same number as `SAVED_WORKFLOW_MAX_NAME_CHARS` for the same reason (per-platform PATH_MAX). */
const WORKFLOW_DRAFT_MAX_SLUG_CHARS = 64;

/**
 * Fallback when no usable character remains (Chinese names are the common case).
 */
export const WORKFLOW_DRAFT_FALLBACK_SLUG = "workflow";

/**
 * Suffix bound on name collisions. Exhausting it means someone is spamming one name; give up on the draft (return
 * `undefined`) rather than loop forever — drafts are a convenience, not correctness.
 */
const WORKFLOW_DRAFT_MAX_ATTEMPTS = 1_000;

export interface WriteWorkflowDraftInput {
  /**
   * Session working directory; drafts land under its `.zcode/workflow-drafts/`. Absent means the host has no cwd notion
   * (port stub / no session context); nowhere to write, same as a failed write.
   */
  cwd: string | undefined;
  /** The run display name, minted into the filename. */
  name: string;
  /** The bytes to write, verbatim (the saved source includes the metadata block). */
  source: string;
}

/**
 * Write a draft, return its absolute path; return `undefined` on failure (never throws).
 *
 * **Every inline submission mints a new file**, even one that should have used `path`: a draft is never overwritten behind the model back,
 * or one accidental duplicate submit wipes the copy being edited. Collisions suffix `-2`, `-3`…, and the write uses
 * `wx` (exclusive create) — two concurrent submissions cannot land in one file, unlike stat-then-write.
 */
export async function writeWorkflowDraft(
  input: WriteWorkflowDraftInput,
): Promise<{ path: string } | undefined> {
  if (input.cwd === undefined || input.cwd === "") return undefined;
  try {
    const dir = path.join(input.cwd, WORKFLOW_DRAFTS_DIR);
    await mkdir(dir, { recursive: true });
    await writeDraftGitignore(dir);
    const slug = workflowDraftSlug(input.name);
    for (let attempt = 1; attempt <= WORKFLOW_DRAFT_MAX_ATTEMPTS; attempt += 1) {
      const fileName = `${attempt === 1 ? slug : `${slug}-${attempt}`}${SAVED_WORKFLOW_FILE_EXTENSION}`;
      const filePath = path.join(dir, fileName);
      try {
        // `wx`: EEXIST if taken, so naming and claiming are one atomic act.
        await writeFile(filePath, input.source, { encoding: "utf8", flag: "wx" });
        return { path: filePath };
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    }
    return undefined;
  } catch {
    // Best effort: unwritable directory, `.zcode` a file, full disk…… all mean no draft this time. The caller
    // falls back to the legacy wording; the tool call completes as usual.
    return undefined;
  }
}

/**
 * What the draft is called: the model `name` wins; else the first `phase("…")` literal — phases are the one thing every
 * script must declare, written for the user in the user language (the Phases rule in `CreateWorkflow`), making it
 * the most name-like thing when no name exists; the fallback word comes last.
 *
 * Deliberately not the run-label fallback (first script line): in practice it is a comment banner like `// ==== Results ====`.
 */
export function resolveWorkflowDraftName(
  name: string | undefined,
  graph: Pick<CreateWorkflowCausalityGraph, "phases"> | undefined,
): string {
  if (name !== undefined && name.trim() !== "") return name;
  return createWorkflowPhaseNames(graph)?.[0] ?? WORKFLOW_DRAFT_FALLBACK_SLUG;
}

/**
 * Name → filename stem. Whitespace collapses to `-`; anything outside the alphabet (Unicode letters/digits/`_ . -`) is dropped,
 * truncated to the cap (by code point, not UTF-16 unit, so a char never becomes half a surrogate); with nothing left, or only dots
 * (`.` / `..` are directory entries, not filenames) the fallback word applies.
 */
export function workflowDraftSlug(name: string): string {
  const reduced = Array.from(
    name
      .trim()
      .replace(WORKFLOW_DRAFT_WHITESPACE_PATTERN, "-")
      .replace(WORKFLOW_DRAFT_SLUG_DROP_PATTERN, ""),
  )
    .slice(0, WORKFLOW_DRAFT_MAX_SLUG_CHARS)
    .join("")
    .replace(/^[.-]+|[.-]+$/gu, "");
  if (reduced === "" || /^\.+$/u.test(reduced)) return WORKFLOW_DRAFT_FALLBACK_SLUG;
  return reduced;
}

/** The draft directory `.gitignore`, written once when absent (left alone after user edits). */
async function writeDraftGitignore(dir: string): Promise<void> {
  try {
    await writeFile(path.join(dir, ".gitignore"), "*\n", { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}
