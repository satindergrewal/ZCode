// ============================================================
// Execution side of world-read (Boundary B's executeWorldRead)
// ============================================================
// The half split out of workflow-driver.ts. There: actor sessions, turn orchestration, submit bridge; here:
// turning one (op, args) into one real read-only observation. The only touchpoint is
// {@link executeWorldRead}, and this half never touches sessions, models, or the journal.
//
// Three duties, here and nowhere else:
//   1. **Per-op arity and argument validation**. Boundary A's worldRead(siteId, op, args) only promises
//      arguments-pass-through-by-position (lowering never sees the op), so what a pattern / base ref looks like
//      is decided here.
//   2. **Cap enforcement**. Constants live in the pure package (WORLD_READ_CAPS of @zcode/dynamic-workflow);
//      enforcement here, because only this side can not-produce - stopping ripgrep at 2000 beats materializing a
//      million and measuring afterwards.

import {
  isAbsolute as isAbsolutePath,
  relative as relativePath,
  resolve as resolvePath,
  sep,
} from "node:path";
import type { ExecutionPort, FileSystemPort } from "@zcode/contracts";
import { WORLD_READ_CAPS, WorkflowError, type WorldReadOp } from "@zcode/dynamic-workflow";
import {
  GIT_SHOW_PREFIX_ARGV,
  GIT_STATUS_ARGV,
  gitChangedFilesPlan,
  gitDiffArgv,
  gitLogArgv,
  parseGitLog,
  parseGitPathList,
  parseGitShowPrefix,
  parseGitStatusPorcelainV2,
  type GitCommitResult,
  type GitStatusResult,
} from "./workflow-git-world-read.js";

/** Ports and base directory world-read needs (a subset of driver deps). */
export interface WorldReadDeps {
  /** The filesystem port backing files.glob / files.read / files.grep. */
  readonly fileSystemPort: FileSystemPort;
  /** The child-process execution port backing git.* (cwd = workspace root). */
  readonly executionPort: ExecutionPort;
  /** Base directory for path resolution/relativization (the workspace root). */
  readonly cwd: string;
}

/**
 * Per op, take arguments from the **positional array** and run one world-read. Boundary A only promises
 * pass-through-by-position (lowering never sees the op), so each op's arity/type check lives here - this is the
 * side that knows what a pattern / base ref looks like.
 * Shape mismatches always reject the node with a structured DriverError, never a silent coercion: a path
 * quietly turned into "undefined" by String(undefined) reads out an inexplicable failure instead of a fixable
 *
 * async on purpose: validation throws must become **this node's promise rejection**. A synchronous throw would
 * escape engine.worldRead (the engine .then(...) only after admission journals), leaving a forever-running
 * node.
 */
export async function executeWorldRead(
  deps: WorldReadDeps,
  op: WorldReadOp,
  args: unknown[],
): Promise<unknown> {
  switch (op) {
    case "glob":
      return await worldGlob(deps, worldReadStringArgs(op, args, ["pattern"])[0]!);
    case "read":
      return await worldRead(deps, worldReadStringArgs(op, args, ["path"])[0]!);
    case "grep": {
      const [pattern, glob] = worldReadOptionalStringArgs(op, args, ["pattern"], ["glob"]);
      return await worldGrep(deps, pattern!, glob);
    }
    case "git-changed-files": {
      const [base] = worldReadOptionalStringArgs(op, args, [], ["base"]);
      return await gitChangedFiles(deps, base);
    }
    case "git-diff": {
      const [base, path] = worldReadOptionalStringArgs(op, args, [], ["base", "path"]);
      return await gitDiff(deps, base, path);
    }
    case "git-status": {
      // No-arg ops: empty names means exactly 0 arguments; one extra still fails loudly.
      worldReadStringArgs(op, args, []);
      return await gitStatus(deps);
    }
    case "git-log":
      return await gitLog(deps, worldReadOptionalCount(op, args, "count"));
    case "run":
      return await worldRun(deps, args);
    default: {
      // The op vocabulary derives from the world-read registry: a new row without a branch here lands in this
      const unknownOp: never = op;
      throw new WorkflowError("DriverError", `Unsupported world-read op "${String(unknownOp)}".`);
    }
  }
}

/**
 * files.glob(pattern): via the FileSystemPort searchFiles, normalized into the facade-promised shape.
 *
 * All three normalizations come from the port-semantics vs facade-promise gap - port results cannot pass through.
 * The port serves the UI Glob tool: absolute paths, mtime desc, default 100-entry truncation.
 *
 * - **cap+1 reject** (the worldGrep idiom): the port's default truncation has silently applied; a 5000-file
 *   glob would hand back 2%, and the error view lands in the journal to be replayed on resume. The cap is
 *   WORLD_READ_CAPS'; exactly-cap is indistinguishable from truncated, hence one extra ask.
 * - **Workspace-relative**: absolute paths defeat routes written against workspace-relative prefixes
 *   (startsWith apps/...), silently collapsing a 6-way fan-out to 1; grep/git relativize already - glob
 *   was the straggler.
 * - **Lexicographic re-sort**: mtime drifts with any write; the journaled value must be deterministic - the same
 */
async function worldGlob(deps: WorldReadDeps, pattern: string): Promise<string[]> {
  const cap = WORLD_READ_CAPS.globMaxFiles;
  const result = await deps.fileSystemPort.searchFiles({
    path: deps.cwd,
    pattern,
    maxResults: cap + 1,
  });
  if (result.files.length > cap || result.truncated) {
    throw capExceeded(`files.glob: over ${cap} files match (the cap). Narrow the pattern.`);
  }
  return result.files.map((path) => toWorkspaceRelative(deps.cwd, path)).sort();
}

/**
 * files.read(path): resolve to absolute, **confirm containment in the workspace first**, then hit the port.
 *
 * Why this check only now: before git.* landed, every path here was a literal the script itself wrote - an
 * outside path was an explicit outside. git.* is the first primitive that **produces** paths:
 * changedFiles() -> files.read(p) is the obvious two-liner, and git's native output carries ../ prefixes when
 * the workspace is a repo subdirectory. The git side already confines via pathspec; this check is the same
 * invariant landing on the other end: a primitive's obvious composition must not be a trap.
 */
async function worldRead(deps: WorldReadDeps, arg: string): Promise<string> {
  const path = assertWithinWorkspace("read", deps.cwd, arg);
  const result = await deps.fileSystemPort.readTextFile({ path });
  return result.content;
}

/**
 * files.grep(pattern, glob?): via the FileSystemPort searchText (ripgrep semantics).
 *
 * **headLimit = cap + 1**, the only non-obvious line here. The cap means over-cap rejects, while the port only
 * truncates at headLimit - asking for exactly cap yields an ambiguous result: cap hits could be exactly-cap
 * (pass) or the front of a million more (reject). One extra ask removes the ambiguity: cap+1 proves overflow,
 * and the cost is still one record, no full materialization.
 * truncated is the second wire of the same judgement (a port-side truncation for another reason means this is
 */
async function worldGrep(
  deps: WorldReadDeps,
  pattern: string,
  glob: string | undefined,
): Promise<GrepMatch[]> {
  const cap = WORLD_READ_CAPS.grepMaxMatches;
  const result = await deps.fileSystemPort.searchText({
    path: deps.cwd,
    pattern,
    ...(glob === undefined ? {} : { glob }),
    outputMode: "content",
    showLineNumbers: true,
    headLimit: cap + 1,
  });
  if (result.entries.length > cap || result.truncated) {
    throw capExceeded(
      `files.grep: over ${cap} matches (the cap). Narrow the pattern or add a glob.`,
    );
  }
  const matches: GrepMatch[] = [];
  for (const entry of result.entries) {
    // In content mode every hit carries line number and text; an entry missing either is not a content hit (e.g.
    // a count produced under another outputMode) - skip it rather than fabricate one with 0 / empty.
    if (entry.lineNumber === undefined || entry.text === undefined) continue;
    matches.push({
      path: toWorkspaceRelative(deps.cwd, entry.path),
      line: entry.lineNumber,
      text: entry.text,
    });
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(matches), "utf8");
  if (serializedBytes > WORLD_READ_CAPS.grepMaxSerializedBytes) {
    throw capExceeded(
      `files.grep: result is ${serializedBytes} bytes, over the ` +
        `${WORLD_READ_CAPS.grepMaxSerializedBytes}-byte cap. Narrow the pattern or add a glob.`,
    );
  }
  return matches;
}

// ------------------------------- internal: git.* world-read -------------------------------

/**
 * Run one git command, return stdout. argv is **constructed** in workflow-git-world-read.ts (fixed arrays, never
 * shell strings); this method only hands it to the port and normalizes failures into a node-level DriverError.
 *
 * maxInlineBytes comes from the caller: git.diff needs it for the cap probe (grep's cap+1 trick); the other ops
 * use a large default.
 */
async function runGit(
  deps: WorldReadDeps,
  op: WorldReadOp,
  argv: readonly string[],
  maxInlineBytes: number,
): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const result = await deps.executionPort.run({
    command: { mode: "argv", file: "git", args: [...argv] },
    cwd: deps.cwd,
    outputLimit: { maxInlineBytes },
  });
  if (result.status !== "completed" || (result.exitCode ?? 0) !== 0) {
    // Missing git, not a repo, bad ref - all land here. Normalized to a **catchable** DriverError, not a run-level
    // failure, so the script can try/catch into files.glob.
    const detail = firstLine(result.stderr.text) || firstLine(result.stdout.text) || result.status;
    throw new WorkflowError(
      "DriverError",
      `git ${argv.join(" ")} failed (${result.status}, exit=${result.exitCode ?? "n/a"}): ${detail}`,
    );
  }
  return {
    text: result.stdout.text,
    bytes: result.stdout.bytes,
    truncated: result.stdout.truncated,
  };
}

/**
 * The workspace-relative-to-root prefix (empty at the root). Wire paths are repo-root-relative; strip this prefix
 // to get the workspace-relative paths the facade promises (workflow-git-world-read.ts header, output contract 2).
 *
 * Asked on every read, no cache: one rev-parse is milliseconds, world-read happens once per site x ordinal and
 * journals - never hot. The payoff: this side stays stateless.
 */
async function gitWorkspacePrefix(deps: WorldReadDeps, op: WorldReadOp): Promise<string> {
  const out = await runGit(deps, op, GIT_SHOW_PREFIX_ARGV, GIT_TEXT_OUTPUT_BYTES);
  return parseGitShowPrefix(out.text);
}

async function gitChangedFiles(deps: WorldReadDeps, base: string | undefined): Promise<string[]> {
  // argv first: an invalid base must be rejected **before any git runs**.
  const plans = gitChangedFilesPlan(base);
  const prefix = await gitWorkspacePrefix(deps, "git-changed-files");
  const paths: string[] = [];
  for (const plan of plans) {
    const out = await runGit(deps, "git-changed-files", plan.argv, GIT_TEXT_OUTPUT_BYTES);
    paths.push(...parseGitPathList(out.text, prefix));
  }
  // Union, dedupe, sort: the two commands can report the same path, and the journal stores this value, so it must
  // depend on content, not on which command answered first.
  return [...new Set(paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

async function gitDiff(
  deps: WorldReadDeps,
  base: string | undefined,
  path: string | undefined,
): Promise<string> {
  const cap = WORLD_READ_CAPS.gitDiffMaxBytes;
  // cap + 1: grep's reason - exactly-cap and truncated must be distinguishable.
  const out = await runGit(deps, "git-diff", gitDiffArgv(base, path), cap + 1);
  if (out.bytes > cap || out.truncated) {
    throw capExceeded(
      `git.diff: output is ${out.bytes} bytes, over the ${cap}-byte cap. Pass a path to narrow.`,
    );
  }
  return out.text;
}

async function gitStatus(deps: WorldReadDeps): Promise<GitStatusResult> {
  const prefix = await gitWorkspacePrefix(deps, "git-status");
  const out = await runGit(deps, "git-status", GIT_STATUS_ARGV, GIT_TEXT_OUTPUT_BYTES);
  return parseGitStatusPorcelainV2(out.text, prefix);
}

async function gitLog(deps: WorldReadDeps, count: number): Promise<GitCommitResult[]> {
  const out = await runGit(deps, "git-log", gitLogArgv(count), GIT_TEXT_OUTPUT_BYTES);
  return parseGitLog(out.text);
}

// ------------------------------- internal: world.run -------------------------------

/** Return of world.run. Authoritative declaration: declare interface WorldRunResult in FACADE_DTS. */
interface WorldRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * world.run(cmd, args?, opts?): journaled command execution.
 *
 * Three deliberate differences from git.*, each a contract:
 *   1. **Non-zero exit is a value.** The execution adapter maps non-zero to status failed with no error
 *      (statusFromExit/statusFailure in node-execution-adapter-results.ts), reliably distinct from spawn
 *      failure/timeout. A gating loop's normal path must not be exception control flow.
 *   2. **No runtime command allowlist.** Authorization is compile-time only: cmd must be a literal (9003), so the commands a script can run
 // are fully readable before submission, shown item by item in the dialog. This used to re-verify against a launch-time
 // `declaredRunCommands` set collected from the seed script ("guards wiring errors") — but a fill (FillWorkflowHole) compiles the
 // valid script while the driver still held the seed set, so the first command in a body was rejected as a "wiring error".
 // Lowering runs the script's own text and the fill's code is the valid script's own lowering; that re-check prevents nothing real
 // and adds a hand-synced second source of truth — hence removed.
 *   3. **No timeout ceiling.** Default 300s, raise freely (built for genuinely long tests); cancel remains the
 *      last control.
 *
 * stdout/stderr 256KB each, cap+1 probe (maxInlineBytes = max of the two caps + 1, judged per stream);
 * over-cap rejects, never truncates - the message states the actionable next step, house policy as grep/diff.
 */
async function worldRun(deps: WorldReadDeps, args: unknown[]): Promise<WorldRunResult> {
  const { argv, cmd, timeoutMs } = worldRunArgs(args);

  const stdoutCap = WORLD_READ_CAPS.runStdoutMaxBytes;
  const stderrCap = WORLD_READ_CAPS.runStderrMaxBytes;
  const result = await deps.executionPort.run({
    command: { mode: "argv", file: cmd, args: argv },
    cwd: deps.cwd,
    timeoutMs,
    outputLimit: { maxInlineBytes: Math.max(stdoutCap, stderrCap) + 1 },
  });

  if (result.status === "timed_out") {
    throw new WorkflowError(
      "DriverError",
      `world.run '${cmd}' timed out after ${timeoutMs}ms. Raise opts.timeoutMs or narrow the work.`,
    );
  }
  // completed (exit 0) and failed-without-error (non-zero exit) are **completed observations** - values;
  // the rest (spawn_error / cancelled / failed-with-error, e.g. output_limit) means the observation itself did
  const ranToExit =
    result.status === "completed" ||
    (result.status === "failed" &&
      result.error === undefined &&
      typeof result.exitCode === "number");
  if (!ranToExit) {
    const detail = result.error?.message ?? (firstLine(result.stderr.text) || result.status);
    throw new WorkflowError(
      "DriverError",
      `world.run '${cmd}' did not run to completion (${result.status}): ${detail}`,
    );
  }

  if (result.stdout.bytes > stdoutCap || result.stdout.truncated) {
    throw capExceeded(
      `world.run '${cmd}': stdout is ${result.stdout.bytes} bytes, over the ${stdoutCap}-byte cap. ` +
        `Quiet the output (e.g. --quiet), or write a file and files.read a summary.`,
    );
  }
  if (result.stderr.bytes > stderrCap || result.stderr.truncated) {
    throw capExceeded(
      `world.run '${cmd}': stderr is ${result.stderr.bytes} bytes, over the ${stderrCap}-byte cap. ` +
        `Reduce the diagnostics, or write a file and files.read a summary.`,
    );
  }

  return {
    exitCode: result.exitCode ?? 0,
    stdout: result.stdout.text,
    stderr: result.stderr.text,
  };
}

/**
 * world.run argument shape: [cmd: string, args?: string[], opts?: { timeoutMs?: number }].
 * Same discipline as {@link worldReadStringArgs} (fail loudly, never coerce), but the shape (array + options bag)
 * exceeds the string-sequence helpers, hence a dedicated one.
 */
function worldRunArgs(args: unknown[]): { cmd: string; argv: string[]; timeoutMs: number } {
  if (args.length < 1 || args.length > 3) {
    throw new WorkflowError(
      "DriverError",
      `world.run takes 1 to 3 arguments (cmd, args?, opts?), got ${args.length}.`,
    );
  }
  const cmd = requireStringArg("run", args[0], "cmd", 0);

  const rawArgv = args[1];
  let argv: string[] = [];
  if (rawArgv !== undefined) {
    if (!Array.isArray(rawArgv)) {
      throw new WorkflowError(
        "DriverError",
        `world.run: argument 2 (args) must be an array of strings, got ${describeArg(rawArgv)}.`,
      );
    }
    argv = rawArgv.map((item, index) => {
      if (typeof item !== "string") {
        throw new WorkflowError(
          "DriverError",
          `world.run: args[${index}] must be a string, got ${describeArg(item)}. Stringify values.`,
        );
      }
      return item;
    });
  }

  const rawOpts = args[2];
  let timeoutMs: number = WORLD_READ_CAPS.runDefaultTimeoutMs;
  if (rawOpts !== undefined) {
    if (typeof rawOpts !== "object" || rawOpts === null || Array.isArray(rawOpts)) {
      throw new WorkflowError(
        "DriverError",
        `world.run: arg 3 (opts) must be an options object or omitted, got ${describeArg(rawOpts)}.`,
      );
    }
    const rawTimeout = (rawOpts as { timeoutMs?: unknown }).timeoutMs;
    if (rawTimeout !== undefined) {
      if (typeof rawTimeout !== "number" || !Number.isInteger(rawTimeout) || rawTimeout < 1) {
        throw new WorkflowError(
          "DriverError",
          `world.run: opts.timeoutMs must be an integer >= 1, got ${describeArg(rawTimeout)}.`,
        );
      }
      // Deliberately no ceiling clamp: built for genuinely long tests; cancel is the last control.
      timeoutMs = rawTimeout;
    }
  }

  return { argv, cmd, timeoutMs };
}

// ------------------------------- pure helpers -------------------------------

/**
 * Extract the **required string arguments** named by names from a world-read positional array; wrong shape
 * throws a structured DriverError (node-level, catchable). Arity is exact per names.length: extras can only
 * come from a wiring error - the facade's type signature catches extras at compile time, so one at runtime means
 * lowering/wire went wrong, and silently ignoring hides a locatable bug as a vague read.
 *
 * Why validate, not coerce: Boundary A's args: unknown[] is the verbatim script payload; this side is the
 * first and only place that knows each op's arity.
 * String(args[0]) turns undefined into the path "undefined", and the ENOENT points nowhere.
 *
 * Multi-arg ops with optionals (files.grep(pattern, glob?), git.diff(base?, path?)) use the tail-optional
 * variant {@link worldReadOptionalStringArgs}; the seam is these two functions, not call sites.
 */
function worldReadStringArgs(op: WorldReadOp, args: unknown[], names: readonly string[]): string[] {
  if (args.length !== names.length) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op} takes ${names.length} arguments (${names.join(", ")}), got ${args.length}.`,
    );
  }
  return names.map((name, index) => requireStringArg(op, args[index], name, index));
}

/**
 * The **tail-optional** variant of {@link worldReadStringArgs}: required prefix, optional tail.
 * Returns a fixed-length required.length + optional.length array; absent optionals are undefined.
 *
 * Three rules, all faces of fail-loudly:
 *   1. Fewer than required, or more than total -> structured DriverError. Extras still reject, same reason as
 *      the exact variant: the facade signature catches extras at compile time; at runtime it is a lowering/wire
 *      wiring error, and silent ignoring hides a locatable bug as a vague read.
 *   2. Required slots must be strings.
 *   3. **Optional slots allow explicit undefined**, because the script can write it: git.diff(undefined,
 *      "a.ts") is legal under base?: string, and lowering packs by position, so the driver really receives an
 *      undefined prefix. Reading it as absent is the only sensible reading.
 *
 * Note lowering packs **tail** absences as a **shorter array** (not undefined holes), while
 * inputHash({op, args}) is the journal key - so ["TODO"] and ["TODO", "*.ts"] are two keys by construction.
 * This function only normalizes both arrival shapes to one call shape; it never rewrites args.
 */
function worldReadOptionalStringArgs(
  op: WorldReadOp,
  args: unknown[],
  required: readonly string[],
  optional: readonly string[],
): (string | undefined)[] {
  const max = required.length + optional.length;
  if (args.length < required.length || args.length > max) {
    const range = required.length === max ? `${max}` : `${required.length}~${max}`;
    throw new WorkflowError(
      "DriverError",
      `world-read ${op} takes ${range} arguments ` +
        `(${[...required, ...optional.map((n) => `${n}?`)].join(", ")}), got ${args.length}.`,
    );
  }
  const out: (string | undefined)[] = [];
  required.forEach((name, index) => out.push(requireStringArg(op, args[index], name, index)));
  optional.forEach((name, offset) => {
    const index = required.length + offset;
    if (index >= args.length) {
      out.push(undefined);
      return;
    }
    const value = args[index];
    if (value === undefined) {
      out.push(undefined);
      return;
    }
    out.push(requireStringArg(op, value, name, index));
  });
  return out;
}

/**
 * git.log(count?) args: 0 or 1, a positive integer within the cap. Absent takes the default.
 * {@link WORLD_READ_CAPS.gitLogDefaultCount}。
 *
 * Over-cap **rejects** instead of silently clamping: a script asking for 500 and getting 100 turns into an
 * inexplicable why-is-history-so-short inside its own logic. A named-cap error lets it fix the call directly.
 */
function worldReadOptionalCount(op: WorldReadOp, args: unknown[], name: string): number {
  const max = WORLD_READ_CAPS.gitLogMaxCount;
  if (args.length > 1) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op} takes at most 1 argument (${name}?), got ${args.length}.`,
    );
  }
  const raw = args[0];
  if (raw === undefined) return WORLD_READ_CAPS.gitLogDefaultCount;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: argument '${name}' must be an integer >= 1, got ${describeArg(raw)}.`,
    );
  }
  if (raw > max) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: argument '${name}'=${raw} is over the cap of ${max}; pass at most ${max}.`,
    );
  }
  return raw;
}

/** Take one positional arg that must be string, else structured rejection (never String(...) coercion). */
function requireStringArg(op: WorldReadOp, value: unknown, name: string, index: number): string {
  if (typeof value !== "string") {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: arg ${index + 1} (${name}) must be a string, got ${describeArg(value)}.`,
    );
  }
  return value;
}

/**
 * Structured rejection for cap overflow. The message always carries the **actionable next step**
 * (narrow-the-pattern-or-add-a-glob): the cap is a contract the script can rewrite itself against; an error
 */
function capExceeded(message: string): WorkflowError {
  return new WorkflowError("WorldReadCapExceeded", message);
}

/**
 * Resolve a script-supplied relative path to absolute and judge **lexically** whether it stays inside the
 * workspace; outside returns undefined (wording and structured codes belong to the caller - world-read raises
 * `ArtifactPathOutsideWorkspace`）。
 *
 * The test uses `relative(cwd, resolved)`: its output is normalized, `..` only ever leads, so
 // "no leading .. segment and not absolute" equals "still inside the workspace". The second condition is required on Windows
 // — across drives `relative` returns an absolute path, not a `..` chain.
 *
 * **Lexical only, no symlink following**: a workspace symlink pointing outward still passes this layer. World reads
 // accept that known edge (the bytes are what the script itself sees); artifact publishing does not — it copies bytes
 // into a durable store handed to the user — so that side re-checks realpath above this function
 // (see workflow-artifact-publish.ts).
 *
 * **Exported on purpose**: the outside definition must have exactly one implementation; two copies eventually
 * disagree on one path, and one of them is a security boundary.
 */
export function resolveWithinWorkspace(cwd: string, arg: string): string | undefined {
  const resolved = resolvePath(cwd, arg);
  const rel = relativePath(cwd, resolved);
  const escapes = rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../");
  return escapes || isAbsolutePath(rel) ? undefined : resolved;
}

/** World-read wrapper of {@link resolveWithinWorkspace}: outside is a structured DriverError (catchable). */
function assertWithinWorkspace(op: string, cwd: string, arg: string): string {
  const resolved = resolveWithinWorkspace(cwd, arg);
  if (resolved === undefined) {
    throw new WorkflowError(
      "DriverError",
      `world-read ${op}: path '${arg}' is outside the workspace; pass a path inside it.`,
    );
  }
  return resolved;
}

/**
 * Normalize port-returned paths to **workspace-relative** (the facade-promised shape). The port may return
 * absolute or already-relative; both accepted. Separators unified to /: the value enters the journal and gets
 * interpolated into model prompts, so it must not shape-shift with the host platform (the same script should
 *
 * **Exported on purpose** (as {@link resolveWithinWorkspace}): the artifact record's sourcePath is the same kind
 * of value - workspace-relative, forward slashes - and one-kind-of-value needs one definition, else the two
 */
export function toWorkspaceRelative(cwd: string, path: string): string {
  const rel = resolvePath(cwd, path) === path ? relativePath(cwd, path) : path;
  return rel.replace(/\\/g, "/");
}

/** First line of stderr / stdout (error messages; never the whole output). */
function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? "";
}

/**
 * Inline cap for git text output (path lists / status / log). These ops have no spec-level cap, but an unbounded
 * buffer is not an option - 100 commits and a worktree path list are orders of magnitude from 4MB.
 * git.diff does **not** use this: it has its own 512KB cap and needs cap+1 for the overflow probe.
 */
const GIT_TEXT_OUTPUT_BYTES = 4 * 1024 * 1024;

/** One files.grep hit. Authoritative declaration: declare interface GrepMatch in FACADE_DTS. */
interface GrepMatch {
  path: string;
  line: number;
  text: string;
}

/** Short description of the argument shape (error messages only; never echoes full content). */
function describeArg(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return Array.isArray(value) ? "array" : typeof value;
}
