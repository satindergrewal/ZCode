// ============================================================
// Workflow draft path — pure answer to "does this write target land in the drafts dir?"
// ============================================================
//
// A separate module for two reasons: PermissionService needs only a boolean and no path-comparison knowledge;
// and this check is the sole no-confirm gate, so it must be testable case-by-case outside the service (Windows semantics included).
// Never touch the filesystem: no realpath, no stat. Permission checks must be pure — the same input yields
// the same answer on any machine, and a failed disk read must not flip no-confirm into confirm-or-allow.

import nodePath from "node:path";

import { WORKFLOW_DRAFTS_DIR } from "@zcode/contracts";

/**
 * The `node:path` subset the check needs, parameterized so tests can inject `path.win32` / `path.posix`:
 * Drive letters, backslashes, and case-insensitivity are Windows semantics proven only by running the win32 impl.
 */
export interface WorkflowDraftPathModule {
  isAbsolute: (path: string) => boolean;
  relative: (from: string, to: string) => string;
  resolve: (...paths: string[]) => string;
}

export interface WorkflowDraftPathInput {
  /** Write target from the tool input; relative paths resolve against workingDirectory, absolute paths stay as-is. */
  filePath: string;
  /** Session working directory; absent (empty string) means no match, see below. */
  workingDirectory: string;
  /** Platform path impl; defaults to the current platform's `node:path`. */
  pathModule?: WorkflowDraftPathModule;
}

/**
 * Built-in file-write tools covered by draft no-confirm. Both share the `edit` permission name and target a single `file_path`,
 * which is what makes "is the target in the drafts dir" decidable. ApplyPatch, also `edit`, is excluded: its input is a
 * `patch_text` body that may touch many files, with no single path to judge.
 */
const WORKFLOW_DRAFT_PREAPPROVED_TOOL_NAMES = new Set(["Edit", "Write"]);

export interface WorkflowDraftWriteInput {
  toolName: string;
  /** Tool input, not yet validated against the specific tool schema; only `file_path` is read from it. */
  input: unknown;
  /** Session working directory; may be absent when the caller has none, which means normal confirmation applies. */
  workingDirectory?: string;
  pathModule?: WorkflowDraftPathModule;
}

/**
 * Whether this tool call writes into the drafts directory, i.e. may skip the confirmation dialog.
 *
 * Why safe: the directory is machine-local — its files are written by the tools themselves, it ships a `*` .gitignore
 * so nothing lands in version control, users keep nothing precious there, and editing a draft touches nothing else in the project. And
 * "running the script" has its own gate: CreateWorkflow declares alwaysAsk, and the confirm dialog judges the submitted script,
 * regardless of prior edits to the file. Allowing these writes therefore allows no execution.
 *
 * Without workingDirectory (caller did not pass one) this never matches: no-confirm requires locating the target,
 * and when it cannot be located, the dialog shows as usual.
 */
export function isPreapprovedWorkflowDraftWrite(input: WorkflowDraftWriteInput): boolean {
  if (!WORKFLOW_DRAFT_PREAPPROVED_TOOL_NAMES.has(input.toolName)) return false;
  if (typeof input.workingDirectory !== "string") return false;
  if (!input.input || typeof input.input !== "object") return false;
  const filePath = (input.input as Record<string, unknown>).file_path;
  if (typeof filePath !== "string") return false;
  return isWorkflowDraftPath({
    filePath,
    pathModule: input.pathModule,
    workingDirectory: input.workingDirectory,
  });
}

/** Whether `filePath` lies inside `<workingDirectory>/.zcode/workflow-drafts/`. */
export function isWorkflowDraftPath(input: WorkflowDraftPathInput): boolean {
  const path = input.pathModule ?? nodePath;
  // No working directory, no project drafts dir to speak of — fail closed: no-confirm requires a locatable target.
  if (input.workingDirectory.length === 0 || input.filePath.length === 0) return false;

  const draftsDir = path.resolve(input.workingDirectory, WORKFLOW_DRAFTS_DIR);
  const resolved = path.resolve(input.workingDirectory, input.filePath);
  const relativePath = path.relative(draftsDir, resolved);

  // All three conditions matter: non-empty excludes the directory itself, absolute excludes cross-drive cases (on Windows
  // `relative("C:\\a", "D:\\b")` returns an absolute path, not `..`), and no leading `..` excludes traversal.
  // Only the path string is examined, never the filesystem: `.zcode/workflow-drafts-other/x.ts` is not confused by the shared
  // prefix, since `relative` yields `../workflow-drafts-other/x.ts`.
  return (
    relativePath.length > 0 && !path.isAbsolute(relativePath) && !relativePath.startsWith("..")
  );
}
