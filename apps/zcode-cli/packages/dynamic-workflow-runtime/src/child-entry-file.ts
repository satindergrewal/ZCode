/**
 * Persisting the sandbox entry file.
 *
 * Why this file exists: Windows caps a command line at 32,767 chars, so the payload cannot ride argv. The harness
 * writes the ESM produced by {@link import("./child-source.js").renderChildEntry} to
 * `<cwd>/.zcode/workflow-runs/<runId>.mjs`, leaving only that path on the spawn command line.
 *
 * Rulings:
 *   - Location `.zcode/workflow-runs/`, a sibling of -- never mixed with -- the project saved-workflow `.zcode/workflows/`;
 *   - Entry files are **kept**, not deleted (same runId overwrites in place); the directory doubles as an archive
 *     of each run's actually-executed body;
 *   - This module writes a `.gitignore` (`*`) there, only when absent, and never touches the project's own;
 *   - Unwritable project dir (read-only checkout, missing cwd, `.zcode` a plain file...) falls back to
 *     `os.tmpdir()/zcode-workflow-runs/` with a one-time `onWarning`; the run still starts. A failed fallback
 *     throws and the harness settles the run as failed.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Non-fatal conditions the harness reports to the caller; bootstrap logs them at warn. */
export interface HarnessWarning {
  kind: "entry_file_fallback";
  /** The project dir we meant to write (`<cwd>/.zcode/workflow-runs`). */
  projectDir: string;
  /** The fallback directory actually used. */
  fallbackDir: string;
  /** Error text from the failed project-dir write. */
  error: string;
}

export interface WriteChildEntryFileInput {
  cwd: string;
  runId: string;
  /** Rendered entry-file source. */
  source: string;
  onWarning?: (warning: HarnessWarning) => void;
}

export interface ChildEntryFile {
  path: string;
  location: "project" | "tmpdir";
}

/** Entry-file directory inside the project. */
export function workflowRunsDir(cwd: string): string {
  return join(cwd, ".zcode", "workflow-runs");
}

/** Fallback directory (under the OS temp dir, shared across projects). */
export function fallbackWorkflowRunsDir(): string {
  return join(tmpdir(), "zcode-workflow-runs");
}

/** Anything outside the runId-safe charset becomes `_`; no path separators or dots in file names. */
export function childEntryFileName(runId: string): string {
  return `${runId.replace(/[^A-Za-z0-9._-]/g, "_")}.mjs`;
}

export function writeChildEntryFile(input: WriteChildEntryFileInput): ChildEntryFile {
  const projectDir = workflowRunsDir(input.cwd);
  const fileName = childEntryFileName(input.runId);
  try {
    return { path: writeInto(projectDir, fileName, input.source), location: "project" };
  } catch (error) {
    const fallbackDir = fallbackWorkflowRunsDir();
    input.onWarning?.({
      kind: "entry_file_fallback",
      projectDir,
      fallbackDir,
      error: error instanceof Error ? error.message : String(error),
    });
    return { path: writeInto(fallbackDir, fileName, input.source), location: "tmpdir" };
  }
}

function writeInto(dir: string, fileName: string, source: string): string {
  mkdirSync(dir, { recursive: true });
  try {
    // `wx`: create only when absent; if the user edited this .gitignore, leave it untouched.
    writeFileSync(join(dir, ".gitignore"), "*\n", { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as { code?: string }).code !== "EEXIST") throw error;
  }
  const path = join(dir, fileName);
  writeFileSync(path, source, "utf8");
  return path;
}
