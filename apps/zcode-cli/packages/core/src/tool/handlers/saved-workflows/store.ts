// ============================================================
// Saved workflows - storage (scope roots + resolve / list / write)
// ============================================================
//
// All fs here is **synchronous** — not convenience: the dialog `prepareApproval` contract is sync (the core
// ToolEntry note: it inspects the input the executor already holds), and a `saved`-source
// run must have its script read **before** the dialog — no script, no causality graph, and the user approves on
// an empty window. These files are local, single, KB-sized; sync reads beat a second async-approval path.
// Handler-side precedent already exists in core (readFileSync in bash-git-runtime-safety.ts).

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  SAVED_WORKFLOW_FILE_EXTENSION,
  SAVED_WORKFLOW_GLOBAL_DIR,
  SAVED_WORKFLOW_MAX_NAME_CHARS,
  SAVED_WORKFLOW_PROJECT_DIR,
  isValidSavedWorkflowName,
  type SavedWorkflowEntry,
  type SavedWorkflowInvalidEntry,
  type SavedWorkflowMeta,
  type SavedWorkflowScope,
  type SavedWorkflowShadowing,
} from "@zcode/contracts";
import { parseSavedWorkflow, serializeSavedWorkflow } from "./frontmatter.js";

/** A lookup root: scope label + absolute directory. */
export interface SavedWorkflowRoot {
  scope: SavedWorkflowScope;
  dir: string;
}

/**
 * Optional arg of `savedWorkflowRoots` / derived functions. `homeDir` is for test injection; production always
 * takes `os.homedir()` (the agent-process machine home) and never follows `storage.dir`.
 */
export interface SavedWorkflowRootsOptions {
  homeDir?: string;
}

/**
 * This session lookup roots, **priority-ordered**: `[project, global]`.
 *
 * Project scope: session cwd `.zcode/workflows/`; global: home `~/.zcode/workflows/`.
 * Every lookup is first-wins in order: project always beats global (same-name shadowing).
 */
export function savedWorkflowRoots(
  cwd: string,
  options?: SavedWorkflowRootsOptions,
): SavedWorkflowRoot[] {
  return [
    { scope: "project", dir: join(cwd, SAVED_WORKFLOW_PROJECT_DIR) },
    { scope: "global", dir: join(options?.homeDir ?? homedir(), SAVED_WORKFLOW_GLOBAL_DIR) },
  ];
}

/** One scope lookup root. The scope is a known enum, always present in `savedWorkflowRoots`. */
export function savedWorkflowRoot(
  cwd: string,
  scope: SavedWorkflowScope,
  options?: SavedWorkflowRootsOptions,
): SavedWorkflowRoot {
  const root = savedWorkflowRoots(cwd, options).find((candidate) => candidate.scope === scope);
  // scope is a SavedWorkflowScope member, roots covers all, find cannot miss.
  return root!;
}

/** A successfully resolved saved definition. */
export interface ResolvedSavedWorkflow {
  name: string;
  path: string;
  scope: SavedWorkflowScope;
  meta: SavedWorkflowMeta;
  script: string;
  /**
   * Raw file (metadata block + body), **byte-exact**. The draft copies exactly this: it must match the bytes
   * just read; re-serializing would drift arg defaults, comments and hand-written YAML layout, and
   * that copy is what the model `path`es back next.
   */
  source: string;
  /** Lines before the body; added when diagnostics map to file lines (see {@link parseSavedWorkflow}). */
  bodyLineOffset: number;
}

export type SavedWorkflowResolveFailure =
  | { ok: false; reason: "invalid_name"; detail: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "parse_error"; path: string; detail: string }
  | { ok: false; reason: "read_error"; path: string; detail: string };

export type SavedWorkflowResolveResult =
  | ({ ok: true } & ResolvedSavedWorkflow)
  | SavedWorkflowResolveFailure;

export interface SavedWorkflowListResult {
  entries: SavedWorkflowEntry[];
  invalid: SavedWorkflowInvalidEntry[];
}

/** Name → filename. Already validated by {@link isValidSavedWorkflowName}; no fallback here. */
export function savedWorkflowFileName(name: string): string {
  return `${name}${SAVED_WORKFLOW_FILE_EXTENSION}`;
}

/**
 * Where a name lands under a root. Shared by read and write — two path builders are the classic
 * saved-but-unreadable bug.
 */
export function savedWorkflowPath(root: SavedWorkflowRoot, name: string): string {
  return join(root.dir, savedWorkflowFileName(name));
}

/**
 * Resolve a saved workflow by name.
 *
 * Validity check before the path join: that order IS the path-traversal defense, not hygiene —
 * once `../../.ssh/id_rsa` enters join it is a readable absolute path.
 *
 * With `scope`: that root only (hub and `saved.scope` targeted looks); without: both roots, first-wins.
 */
export function resolveSavedWorkflow(options: {
  cwd: string;
  name: string;
  scope?: SavedWorkflowScope;
  homeDir?: string;
}): SavedWorkflowResolveResult {
  const { cwd, name, scope, homeDir } = options;
  if (!isValidSavedWorkflowName(name)) {
    return {
      ok: false,
      reason: "invalid_name",
      detail: `workflow names may only contain letters, digits, '.', '-' and '_', and must be 1-${SAVED_WORKFLOW_MAX_NAME_CHARS} characters`,
    };
  }

  const roots =
    scope === undefined
      ? savedWorkflowRoots(cwd, { homeDir })
      : [savedWorkflowRoot(cwd, scope, { homeDir })];

  for (const root of roots) {
    const path = savedWorkflowPath(root, name);
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch (error) {
      // Not in this root, try the next. Other read errors (permissions, a directory) are this-file problems — report,
      // never fake not-found: it sends the user hunting a name that exists.
      if (isNotFound(error)) continue;
      return { ok: false, reason: "read_error", path, detail: describeError(error) };
    }

    const parsed = parseSavedWorkflow(source);
    if (!parsed.ok) {
      return { ok: false, reason: "parse_error", path, detail: parsed.detail };
    }
    return {
      ok: true,
      name,
      path,
      scope: root.scope,
      meta: parsed.meta,
      script: parsed.script,
      source,
      bodyLineOffset: parsed.bodyLineOffset,
    };
  }

  return { ok: false, reason: "not_found" };
}

/**
 * List saved definitions (depth-1 flat scan, no recursion).
 *
 * Broken files go to `invalid`, never throw: user-hand-edited; one typo must not erase the list.
 *
 * Without `scope`: both roots in order, first-wins, shadowed entries **not** listed — the list states
 * what-running-this-name-does, not what-is-on-disk. With `scope`: that root only, **no** shadowing
 * (the hub global group must see entries shadowed by the project store).
 */
export function listSavedWorkflows(options: {
  cwd: string;
  scope?: SavedWorkflowScope;
  homeDir?: string;
}): SavedWorkflowListResult {
  const entries: SavedWorkflowEntry[] = [];
  const invalid: SavedWorkflowInvalidEntry[] = [];
  const claimed = new Set<string>();

  const roots =
    options.scope === undefined
      ? savedWorkflowRoots(options.cwd, { homeDir: options.homeDir })
      : [savedWorkflowRoot(options.cwd, options.scope, { homeDir: options.homeDir })];

  for (const root of roots) {
    let fileNames: string[];
    try {
      fileNames = readdirSync(root.dir);
    } catch (error) {
      // A missing directory is normal (most projects never saved one), not an error.
      if (isNotFound(error)) continue;
      invalid.push({ path: root.dir, reason: describeError(error) });
      continue;
    }

    // readdir order is filesystem-defined; sorting makes lists identical across machines.
    for (const fileName of [...fileNames].sort()) {
      if (!fileName.endsWith(SAVED_WORKFLOW_FILE_EXTENSION)) continue;
      const name = fileName.slice(0, -SAVED_WORKFLOW_FILE_EXTENSION.length);
      const path = join(root.dir, fileName);

      if (!isValidSavedWorkflowName(name)) {
        invalid.push({ path, reason: "file name is not a usable workflow name" });
        continue;
      }
      // Claimed by a higher-priority scope: never runs here, so not listed.
      if (claimed.has(name)) continue;

      let source: string;
      try {
        source = readFileSync(path, "utf8");
      } catch (error) {
        // Entry exists but unreadable (subdir, permissions) — not absent, broken.
        invalid.push({ path, reason: describeError(error) });
        continue;
      }

      const parsed = parseSavedWorkflow(source);
      if (!parsed.ok) {
        invalid.push({ path, reason: `${parsed.reason}: ${parsed.detail}` });
        continue;
      }

      claimed.add(name);
      entries.push({
        name,
        description: parsed.meta.description,
        ...(parsed.meta.whenToUse === undefined ? {} : { whenToUse: parsed.meta.whenToUse }),
        ...(parsed.meta.args === undefined ? {} : { args: parsed.meta.args }),
        scope: root.scope,
        path,
      });
    }
  }

  return { entries, invalid };
}

/**
 * Write a saved definition; return destination and overwrite-or-not.
 *
 * `scope` picks the root (default `project`, legacy semantics). Scope is now a **write-side choice** — the model
 * must provide it in SaveWorkflow.
 */
export function saveSavedWorkflow(options: {
  cwd: string;
  name: string;
  meta: SavedWorkflowMeta;
  script: string;
  scope?: SavedWorkflowScope;
  homeDir?: string;
}): { path: string; scope: SavedWorkflowScope; overwritten: boolean } {
  const root = savedWorkflowRoot(options.cwd, options.scope ?? "project", {
    homeDir: options.homeDir,
  });
  const path = savedWorkflowPath(root, options.name);
  mkdirSync(root.dir, { recursive: true });
  const overwritten = fileExists(path);
  writeFileSync(path, serializeSavedWorkflow(options.meta, options.script), "utf8");
  return { path, scope: root.scope, overwritten };
}

/** Whether the target exists (the dialog must separate overwrite from create). Project store by default. */
export function savedWorkflowExists(options: {
  cwd: string;
  name: string;
  scope?: SavedWorkflowScope;
  homeDir?: string;
}): boolean {
  if (!isValidSavedWorkflowName(options.name)) return false;
  const root = savedWorkflowRoot(options.cwd, options.scope ?? "project", {
    homeDir: options.homeDir,
  });
  return fileExists(savedWorkflowPath(root, options.name));
}

/**
 * When saving to `scope`, whether the other store holds the same name (shadowing fact, for the dialog).
 *
 * Save project while global holds the name → `hides_global` (project wins here); save global while project does
 * → `hidden_by_project` (never runs here). Neither → `undefined`.
 */
export function findSavedWorkflowShadowing(options: {
  cwd: string;
  name: string;
  scope: SavedWorkflowScope;
  homeDir?: string;
}): SavedWorkflowShadowing | undefined {
  if (!isValidSavedWorkflowName(options.name)) return undefined;
  const otherScope: SavedWorkflowScope = options.scope === "project" ? "global" : "project";
  const otherRoot = savedWorkflowRoot(options.cwd, otherScope, { homeDir: options.homeDir });
  if (!fileExists(savedWorkflowPath(otherRoot, options.name))) return undefined;
  return options.scope === "project" ? "hides_global" : "hidden_by_project";
}

/** Result of moving a global entry back to the project store. */
export type SavedWorkflowMoveResult =
  | { ok: true; from: string; to: string }
  | { ok: false; reason: "invalid_name"; detail: string }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "target_exists"; path: string }
  | { ok: false; reason: "read_error" | "write_error"; path: string; detail: string };

/**
 * Move global-root `name` into the cwd project root (**this direction only**).
 *
 * The reverse (project→global) is no file move: project entries reference this repo paths/commands/conventions; copied verbatim they become
 * a global def guaranteed to misfire elsewhere. That way is the model summarizing (promote-to-global: the GUI opens
 * a session with a summarize prompt; the model re-saves via SaveWorkflow). Global→project is specialization — a global def runs as-is in a project, so the file moves.
 *
 * **Byte-exact move** (no parse, no reserialize): frontmatter stores no scope, so moving is moving the file.
 * `renameSync` first; cross-device (EXDEV) falls back to read→write→unlink. Existing target rejects (no overwrite: that is
 * a SaveWorkflow post-dialog act). Name validity first — the path-traversal defense itself.
 */
export function moveSavedWorkflow(options: {
  cwd: string;
  name: string;
  homeDir?: string;
}): SavedWorkflowMoveResult {
  const { cwd, name, homeDir } = options;
  if (!isValidSavedWorkflowName(name)) {
    return {
      ok: false,
      reason: "invalid_name",
      detail: `workflow names may only contain letters, digits, '.', '-' and '_', and must be 1-${SAVED_WORKFLOW_MAX_NAME_CHARS} characters`,
    };
  }

  const fromRoot = savedWorkflowRoot(cwd, "global", { homeDir });
  const toRoot = savedWorkflowRoot(cwd, "project", { homeDir });
  const fromPath = savedWorkflowPath(fromRoot, name);
  const toPath = savedWorkflowPath(toRoot, name);

  if (!fileExists(fromPath)) return { ok: false, reason: "not_found" };
  if (fileExists(toPath)) return { ok: false, reason: "target_exists", path: toPath };

  try {
    mkdirSync(toRoot.dir, { recursive: true });
  } catch (error) {
    return { ok: false, reason: "write_error", path: toPath, detail: describeError(error) };
  }

  try {
    renameSync(fromPath, toPath);
    return { ok: true, from: fromPath, to: toPath };
  } catch (error) {
    // Cross-device (home and project on different mounts) rename throws EXDEV: the read→write→unlink fallback,
    // each leg failing on its own, so upstream separates unreadable-source from unwritable-target.
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "EXDEV") {
      return { ok: false, reason: "write_error", path: toPath, detail: describeError(error) };
    }
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(fromPath);
  } catch (error) {
    return { ok: false, reason: "read_error", path: fromPath, detail: describeError(error) };
  }
  try {
    writeFileSync(toPath, bytes);
    unlinkSync(fromPath);
  } catch (error) {
    return { ok: false, reason: "write_error", path: toPath, detail: describeError(error) };
  }
  return { ok: true, from: fromPath, to: toPath };
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  // ENOTDIR: a path segment is a file (`.zcode/workflows` created as a file). For lookup it equals
  // directory-absent.
  return code === "ENOENT" || code === "ENOTDIR";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
