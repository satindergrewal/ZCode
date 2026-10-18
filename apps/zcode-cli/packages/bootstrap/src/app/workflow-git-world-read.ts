// ============================================================
// git.* world reads: read-only **by construction**
// ============================================================
// The **pure** half of git world-read: argument validation, fixed-argv construction, and parsing of porcelain-v2 /
// log / path-list output. Side effects (actually spawning git) stay in workflow-world-read.ts.
//
// Why a pure module: every line here is a property that can be pinned in isolation - "this op's argv is exactly
// these elements", "branch absent on detached HEAD", "-foo rejected as base", "filenames with newlines pass
// through verbatim". On the execution side they would only be assertable through a fake port; here, directly.
//
// ————————————————————————————————————————————————————————————————
// Read-only is **constructed**, not checked
// ————————————————————————————————————————————————————————————————
// This module can only build argv for the five allowed subcommands. No path can assemble a shell string, and
// nowhere is a script-supplied string used directly as subcommand or option: the base ref passes a strict charset
// (no leading `-`, no `..` ranges), path must be workspace-relative and contained, and is **always** after `--`.
// So cannot-write is a property of what this code can express, not a permission check someone may forget.
//
// ————————————————————————————————————————————————————————————————
// Two output contracts spanning the module (both empirically established, not derived from docs)
// ————————————————————————————————————————————————————————————————
// **1. `-z`: NUL-separated, paths byte-verbatim.** Without `-z`, `core.quotePath` defaults on and git octal-escapes
// quoted non-ASCII paths — a document.md becomes `"\346...\""`. For this repo's users that is
// the norm, not an edge. `-z` fixes both: paths escape no quotes, and **filenames containing newlines** no longer
// break line splitting (line-splitting would bisect them into two nonexistent paths, silently — "rare and silently wrong" is exactly
// the failure shape this code refuses). Our own `git log` already separates fields with %x00, so the family is consistent.
//
// **2. Paths are always handed over workspace-relative, converted once on our side.** Measured: with `-z`,
// `status --porcelain=v2` emits **repo-root-relative** paths, with no flag or config to flip it to cwd-relative
// (`status.relativePaths` does not apply to porcelain -z); `diff --name-only` is repo-root-relative by default; and
// `ls-files --others` defaults to **cwd-relative**. Three commands, three bases.
//
// So one rule here: **always take repo-root-relative on the wire** (`ls-files` gets `--full-name` to align),
// then one `rev-parse --show-prefix` yields the workspace-relative-to-root prefix, stripped at parse time. One
// basis, one place — not three commands each trusting a different git default; that mix is exactly the
// bug where `changedFiles()` emits two bases at once (identical when the workspace is the root,
// so it hides until some workspace is a subdirectory).
//
// The one exception is `git diff`'s **patch text**: not a path list we parse but one blob with `a/... b/...`
// headers, impossible to strip post hoc; that one uses git's own `--relative` to align the base.

import { WorkflowError } from "@zcode/dynamic-workflow";

/**
 * One command a git world-read runs. `argv` excludes the `git` literal itself - the executable name is the
 * execution side's concern, keeping this module process-free.
 */
interface GitCommandPlan {
  readonly argv: readonly string[];
}

/** Return shape of `git.status()`. Authoritative declaration: `declare interface GitStatus` in FACADE_DTS. */
export interface GitStatusResult {
  branch?: string;
  clean: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
}

/** One `git.log()` record. Authoritative declaration: `declare interface GitCommit` in FACADE_DTS. */
export interface GitCommitResult {
  hash: string;
  subject: string;
  author: string;
  date: string;
}

/**
 * Strict charset for a base ref: first char alphanumeric, then `[A-Za-z0-9._/@^~-]`.
 *
 * No leading `-` is the only **safety-relevant** part: git would read `-foo` as an option, not a ref, and which
 * options exist is not ours to decide. No leading `.` either, incidentally rejecting `.` / `..`-style inputs that
 * are neither legal refs nor range-like.
 *
 * Deliberately excluded: whitespace (no legal reason for a space in a ref), braces (`@{u}`-style reflog syntax,
 * unsupported in v1), colon (`ref:path` syntax), and any `..` (ranges - v1 accepts a **single** ref only). None of
 * this is danger, just beyond v1's promised semantics; accepting it would tie scripts to an unwritten contract.
 */
const GIT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/@^~-]*$/;

/** `git log` field format: NUL-delimited hash / subject / author name / author date (ISO-8601). */
export const GIT_LOG_PRETTY = "--pretty=format:%H%x00%s%x00%an%x00%aI";

/**
 * The workspace's prefix below the repo root (`sub/nested/`; empty at the root). The only basis for converting
 * on-the-wire repo-relative paths to workspace-relative; see output contract 2 at the top of this module.
 */
export const GIT_SHOW_PREFIX_ARGV: readonly string[] = ["rev-parse", "--show-prefix"];

/**
 * Fixed argv for `git status`. `--branch` feeds GitStatus.branch; `-- .` confines observation to the workspace
 * (see {@link WORKSPACE_PATHSPEC}).
 */
export const GIT_STATUS_ARGV: readonly string[] = [
  "status",
  "--porcelain=v2",
  "-z",
  "--branch",
  "--",
  ".",
];

/**
 * Fixed argv for untracked files. `--exclude-standard` honors .gitignore; `--full-name` pulls the output from
 * cwd-relative to repo-root-relative, aligning with status / diff (output contract 2).
 */
export const GIT_UNTRACKED_ARGV: readonly string[] = [
  "ls-files",
  "--others",
  "--exclude-standard",
  "-z",
  "--full-name",
  "--",
  ".",
];

/**
 * The workspace pathspec. git.* is **world-read**, and this workflow's world is the workspace everywhere:
 * files.glob/read/grep are workspace-scoped, actor sub-sessions cwd into the workspace, permission tiers too.
 * So git observes the same world - else `changedFiles()` would hand back paths outside it, and the most obvious
 * two-liner `changedFiles() -> files.read(p)` becomes a trap.
 *
 * Cost (accepted in v1): when the workspace is a repo subdirectory, changes outside it are invisible.
 */
const WORKSPACE_PATHSPEC = ".";

/**
 * Validate a base ref, returning the original string. Wrong shape is a structured `DriverError` (node-level,
 * catchable). The message states **why** - the script author must act on it, not guess.
 */
function validateGitRef(op: string, value: string): string {
  if (value.length === 0) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: base must not be empty. Pass a ref such as "main" or omit it.`,
    );
  }
  if (value.startsWith("-")) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: base '${value}' starts with '-', which git would read as an option, ` +
        `not a ref. Pass a plain ref.`,
    );
  }
  if (value.includes("..")) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: base '${value}' is a '..' range; only a single ref is accepted. Pass ` +
        `one ref.`,
    );
  }
  if (!GIT_REF_PATTERN.test(value)) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: base '${value}' is not a valid ref. A ref starts with a letter or ` +
        `digit, followed by letters, digits and . _ / @ ^ ~ - (no whitespace or syntax ` +
        `characters such as {} :).`,
    );
  }
  return value;
}

/**
 * Validate a workspace-relative path, returning the normalized string (separators unified to `/`).
 *
 * Three rules, all **lexical** (no symlink following; see the v1 note): no absolute paths, no leading `-`,
 * no `..` segments. The third is this side's containment check: in `relative`'s normalized result `..` can only
 * lead, so no-`..`-and-not-absolute equals resolves-inside-the-workspace.
 *
 * Leading `-` is safe even after `--`, and still rejected: defense in depth - should `--` ever go missing, a
 * `-foo` path is an option.
 */
function validateGitPath(op: string, value: string): string {
  if (value.length === 0) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: path must not be empty. Pass a workspace-relative path or omit it.`,
    );
  }
  if (value.startsWith("-")) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: path '${value}' starts with '-', which git could read as an option. ` +
        `Pass a path that does not start with '-'.`,
    );
  }
  if (looksAbsolute(value)) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: path '${value}' is absolute; only workspace-relative paths are ` +
        `accepted. Pass the path relative to the workspace root.`,
    );
  }
  // Separators unified to `/`: git pathspec eats `/` on all three platforms, while models emit Windows-style
  // relative paths routinely. Normalization must precede the `..` check, else `..\x` slips through segment
  const normalized = value.replace(/\\/g, "/");
  if (normalized.split("/").includes("..")) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: path '${value}' contains a '..' segment and would leave the ` +
        `workspace. Pass a path inside the workspace.`,
    );
  }
  return normalized;
}

/**
 * Absolute-path test, **platform-independent**: node:path's posix flavor misses `C:\x`, and this check must
 * answer identically on all three platforms (cross-platform principle: never per-dev-machine behavior).
 */
function looksAbsolute(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]?/.test(value);
}

/**
 * The commands `git.changedFiles(base?)` runs.
 *
 * Without base, the union of **two**: `diff --name-only HEAD` plus `ls-files --others
 * --exclude-standard`. Untracked files are changes to a reader; missing them makes the primitive useless on a
 * fresh feature branch (when nearly every new file is untracked).
 *
 * With base, one: `diff --name-only <base>`. What-changed-relative-to-a-ref is a question about
 * **tracked history**; a never-committed file compares against no ref.
 */
export function gitChangedFilesPlan(base: string | undefined): GitCommandPlan[] {
  const ref = base === undefined ? "HEAD" : validateGitRef("git-changed-files", base);
  const tracked: GitCommandPlan = {
    argv: ["diff", "--name-only", "-z", ref, "--", WORKSPACE_PATHSPEC],
  };
  if (base !== undefined) return [tracked];
  return [tracked, { argv: [...GIT_UNTRACKED_ARGV] }];
}

/**
 * argv for `git.diff(base?, path?)`. base defaults `HEAD`; path defaults the workspace pathspec `.`,
 * always after `--`, so a path that happens to equal the branch name is not read as a ref (and vice versa).
 *
 * `--relative` is required here for a different reason: the patch's `a/... b/...` headers are git-authored;
 * we do not parse them and cannot strip prefixes afterwards, so git must emit relative to cwd (= the workspace).
 * Without it, `changedFiles()` says only a.md changed while `diff()` returns a repo-level patch carrying `../x` -
 * two primitives answering what-counts-as-changed differently.
 *
 * `--relative` already excludes changes outside cwd, so `-- .` is redundant without a path. **Redundant on purpose**:
 // scope narrowing must not silently depend on another flag's side effect; written out, the argv tests can pin it.
 */
export function gitDiffArgv(base: string | undefined, path: string | undefined): string[] {
  const ref = base === undefined ? "HEAD" : validateGitRef("git-diff", base);
  const pathspec = path === undefined ? WORKSPACE_PATHSPEC : validateGitPath("git-diff", path);
  return ["diff", "--relative", ref, "--", pathspec];
}

/**
 * argv for `git.log(count)`; the caller validates and clamps count into [1, cap].
 *
 * **Deliberately no pathspec, asymmetric with the rest of the family.** A commit is a repo-level object; a
 * pathspec would bend log into commits-that-touched-the-workspace, a different question nobody asked. Log reads
 * history metadata (hash / subject / author / date), not workspace paths - nothing for workspace confinement to
 * apply to.
 */
export function gitLogArgv(count: number): string[] {
  return ["log", `-n${count}`, GIT_LOG_PRETTY];
}

/** `rev-parse --show-prefix` output -> prefix string (empty at the repo root). */
export function parseGitShowPrefix(stdout: string): string {
  return stdout.replace(/\r?\n$/, "");
}

/**
 * Split `-z` output into segments: cut on NUL, drop empties (the trailing terminator leaves one).
 *
 * Dropping empties is safe and cannot hurt two-segment rename entries: a path is never empty, so empties come
 * only from the terminator.
 */
function nulSegments(stdout: string): string[] {
  return stdout.split("\u0000").filter((segment) => segment.length > 0);
}

/**
 * Strip the workspace prefix, converting repo-relative paths to **workspace-relative** (output contract 2).
 *
 * Outside-the-prefix paths **fail loudly** instead of passing through. `-- .` already guarantees every path is
 * inside the workspace, so reaching here means an assumption collapsed; handing the script a `../`-laden path is
 * exactly what this confinement prevents - and the script would `files.read` it. Prefer a failed node.
 */
function stripWorkspacePrefix(prefix: string, path: string): string {
  if (prefix.length === 0) return path;
  if (path.startsWith(prefix)) return path.slice(prefix.length);
  throw new WorkflowError(
    "DriverError",
    `git reported path '${path}' outside the workspace prefix '${prefix}'. The pathspec should ` +
      `have scoped the read to the workspace, so the scoping is broken; report this as a bug.`,
  );
}

/**
 * Parses `git status --porcelain=v2 -z --branch -- .`.
 *
 * The leading char is the record type: `#` header, `1` ordinary change, `2` rename/copy, `u` unmerged, `?` untracked,
 * `!` ignored (only under --ignored, not here). In `1`/`2`, the two `XY` chars are the **index** and
 * **worktree** states, `.` unchanged — so one file can be both staged and unstaged (edited, staged,
 // then edited again).
 *
 * Two `-z`-specific shapes (both measured):
 *   - header lines are NUL-terminated too, not newlines.
 *   - **rename/copy entries take two fields**: `2 ... R100 <new>\0<old>` (TAB-separated without `-z`).
 *     So parsing must consume one extra field, else the old path masquerades as the next record — and lacking a type char,
 // it is silently dropped. The old path is not reported: the facade answers "which paths changed now".
 *
 * The path is the record's **tail field**, not fixed-width: paths contain spaces (even newlines, preserved under `-z`), so split by
 * "skip the first N space-separated fields, keep the rest" — never a whole-record split.
 */
export function parseGitStatusPorcelainV2(stdout: string, prefix = ""): GitStatusResult {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  let branch: string | undefined;

  const segments = nulSegments(stdout);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    if (segment.startsWith("# branch.head ")) {
      const head = segment.slice("# branch.head ".length);
      // On detached HEAD git writes the literal (detached). branch is then **absent**, not present-with-this-
      // placeholder - handing it back as a branch name invites a diff on it.
      if (head !== "(detached)") branch = head;
      continue;
    }
    if (segment.startsWith("#")) continue;

    const kind = segment[0];
    if (kind === "1" || kind === "2") {
      const xy = segment.split(" ")[1] ?? "..";
      // For `1` the path starts at field 8; `2` has an extra `<X><score>` field, so from 9, and its **original
      // path** occupies the whole next segment (NUL-separated under -z) and must be skipped explicitly.
      const path = fieldTail(segment, kind === "1" ? 8 : 9);
      if (kind === "2") index += 1;
      if (path.length === 0) continue;
      const relative = stripWorkspacePrefix(prefix, path);
      if (xy[0] !== undefined && xy[0] !== ".") staged.push(relative);
      if (xy[1] !== undefined && xy[1] !== ".") unstaged.push(relative);
      continue;
    }
    if (kind === "u") {
      // Unmerged (conflict): counts as worktree-pending, lands in unstaged. It does have pending work; staged
      // would mislead - a conflicted file is not ready-to-commit.
      const path = fieldTail(segment, 10);
      if (path.length > 0) unstaged.push(stripWorkspacePrefix(prefix, path));
      continue;
    }
    if (kind === "?") {
      const path = fieldTail(segment, 1);
      if (path.length > 0) untracked.push(stripWorkspacePrefix(prefix, path));
    }
    // `!` and unrecognized segments: skip.
  }

  const clean = staged.length === 0 && unstaged.length === 0 && untracked.length === 0;
  return {
    ...(branch === undefined ? {} : { branch }),
    clean,
    staged: sortedUnique(staged),
    unstaged: sortedUnique(unstaged),
    untracked: sortedUnique(untracked),
  };
}

/**
 * Parse {@link GIT_LOG_PRETTY} output: one record per line, fields NUL-delimited.
 *
 * Splitting records on **newlines** is reliable here, unlike the path lists: `%s` is the commit subject's first
 * line, newline-free by definition, and the other three fields (hash / author name / ISO date) are too. No -z
 * needed.
 *
 * A field count != 4 throws: format string and parser live in this module, so a mismatch is a local bug, and a
 * half-filled commit would flow into the journal and the model's context.
 */
export function parseGitLog(stdout: string): GitCommitResult[] {
  const commits: GitCommitResult[] = [];
  for (const raw of stdout.split("\n")) {
    const record = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (record.length === 0) continue;
    const fields = record.split("\u0000");
    if (fields.length !== 4) {
      throw new WorkflowError(
        "DriverError",
        `world-read git-log: cannot parse the output; a record should have 4 NUL-separated ` +
          `fields, got ${fields.length}. Retry, and report this as a bug if it persists.`,
      );
    }
    commits.push({
      hash: fields[0]!,
      subject: fields[1]!,
      author: fields[2]!,
      date: fields[3]!,
    });
  }
  return commits;
}

/**
 * Split `--name-only -z` / `ls-files -z` output into **workspace-relative** path lists.
 * Both argv already force repo-relative (`--full-name`), so the prefix is stripped once, here.
 */
export function parseGitPathList(stdout: string, prefix = ""): string[] {
  return nulSegments(stdout).map((path) => stripWorkspacePrefix(prefix, path));
}

/**
 * The **whole remainder** from space-separated field `index`. porcelain v2 fields are single-space and fixed;
 * only the path is last and may contain spaces, so skip-N-then-keep-rest is the only correct split.
 */
function fieldTail(line: string, index: number): string {
  let at = 0;
  for (let i = 0; i < index; i += 1) {
    const next = line.indexOf(" ", at);
    if (next === -1) return "";
    at = next + 1;
  }
  return line.slice(at);
}

/** Dedupe and sort. The journal stores this value, so it must depend on content, not git's output order. */
function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
