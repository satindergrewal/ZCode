import { open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import ignoreFactory from "ignore";
import type { Ignore } from "ignore";
import type { ServiceLogger } from "../logger/serviceLogger.js";

/**
 * Single source of truth for workspace file-search ignore rules.
 *
 * `.zcodeignore` (workspace root, gitignore syntax) is the only rule file for the search index:
 * auto-create is paused for now: with no file, the in-memory rules are the root `.gitignore` plus defaults;
 * later .gitignore changes never affect search; users edit via settings or Sync from .gitignore.
 *
 * Rule parsing delegates to the `ignore` npm package (gitignore spec 2.22 reference, as in ESLint):
 * later-wins, `!` negation (including git's native limit on re-including under excluded dirs), anchored/basename,
 * `**` depth, trailing `/`, classes, and escapes. Never hand-roll gitignore parsing in this repo.
 */

export const WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME = ".zcodeignore";
const GITIGNORE_FILE_NAME = ".gitignore";

type WorkspaceFileIgnoreLogger = Pick<ServiceLogger, "info" | "warn">;

export type WorkspaceFileSearchIgnoreRulesSource =
  | "file"
  | "template"
  | "created-from-gitignore"
  | "created-from-template"
  | "fallback-gitignore"
  | "fallback-builtin";

export interface WorkspaceFileSearchIgnoreRules {
  matcher: Ignore;
  source: WorkspaceFileSearchIgnoreRulesSource;
}

export interface WorkspaceFileSearchIgnoreContent {
  content: string;
  /** file: .zcodeignore exists; template: not yet created, content previews what saving would write. */
  source: "file" | "template";
}

/**
 * Built-in excludes for the default template: carry over the retired parts of the legacy directory blocklist
 * so from-scratch workspaces behave like the old defaults (node_modules/.git still pruned).
 * Prefix globs use gitignore syntax (cmake-build-* etc.), matching the old SKIPPED_DIRECTORY_PREFIXES.
 */
const BUILTIN_IGNORE_LINES = [
  ".git/",
  ".hg/",
  ".svn/",
  "node_modules/",
  "bower_components/",
  "jspm_packages/",
  "__pycache__/",
  "site-packages/",
  "venv/",
  "coverage/",
  "htmlcov/",
  "lcov-report/",
  "cmakefiles/",
  "cmake-build-*/",
  "bazel-*/",
  "pods/",
  "deriveddata/",
  "storybook-static/",
  "playwright-report/",
  "test-results/",
  "allure-results/",
  "allure-report/",
  "cdk.out/",
  "*.egg-info/",
  "*.dist-info/",
  "eggs/",
  "pip-wheel-metadata/",
  "wheels/",
];

const TEMPLATE_HEADER = [
  "# ZCode workspace file-search ignore rules (.zcodeignore)",
  "# Syntax matches .gitignore. Affects only ZCode @ file candidates / Command Center / file-tree search,",
  "# not file-tree browsing, uploads, or agent file access.",
  "# .gitignore edits do not auto-sync here; use Settings > Sync from .gitignore.",
  "",
];

/**
 * Section markers (exact-line matches; deleting one degrades its button to a full rebuild):
 * Sync from .gitignore rewrites only above the SYNC marker;
 * Restore defaults rewrites only the defaults segment between the markers;
 * the custom section below the DEFAULTS marker is never touched by any button.
 */
export const WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER =
  "# ===== Everything above syncs from .gitignore (Sync from .gitignore rewrites only the above) =====";
export const WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER =
  "# ----- ZCode default excludes above (custom rules go below this line; sync/restore never touch them) -----";

const CUSTOM_SECTION_HINT = "# Custom rules below (you may delete this hint line)";

function buildBuiltinDefaultsSection(gitignoreContent: string | null): string {
  // On create/restore, rules already present in the gitignore section are not duplicated into defaults,
  // keeping one copy per rule: removing it fully re-includes the path, avoiding the
  // deleted-from-defaults-but-a-copy-hides-in-gitignore trap.
  // Dedupe is conservative: trim-equal, or ignoring one trailing slash (node_modules covers node_modules/);
  // anchored forms (/node_modules/) are distinct. Prefer a duplicate over a lost rule.
  if (gitignoreContent === null) {
    return BUILTIN_IGNORE_LINES.join("\n");
  }
  const declared = new Set<string>();
  for (const rawLine of gitignoreContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) {
      continue;
    }
    declared.add(line);
    declared.add(line.replace(/\/$/, ""));
  }
  const deduped = BUILTIN_IGNORE_LINES.filter((line) => {
    const bare = line.replace(/\/$/, "");
    return !declared.has(line) && !declared.has(bare);
  });
  return deduped.join("\n");
}

/**
 * Builds the initial .zcodeignore: .gitignore copy plus the two-marker layout (defaults segment / custom area).
 * Appending defaults is a compatibility requirement: repos whose .gitignore omits node_modules etc. would, as a pure copy,
 * scan whole dependency trees (the old full-repo-scan perf bug); the defaults segment ships in the file,
 * user-editable, removal re-includes: one source of truth, no code-level union.
 * Defaults are deduped against the gitignore section before writing (see buildBuiltinDefaultsSection).
 */
export function buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent: string | null): string {
  const gitignoreSection =
    gitignoreContent !== null && gitignoreContent.trim().length > 0
      ? gitignoreContent.endsWith("\n")
        ? gitignoreContent
        : `${gitignoreContent}\n`
      : `${TEMPLATE_HEADER.join("\n")}\n`;
  return [
    gitignoreSection,
    WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
    buildBuiltinDefaultsSection(gitignoreContent),
    WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
    CUSTOM_SECTION_HINT,
    "",
  ].join("\n");
}

interface SplitWorkspaceFileSearchIgnoreSections {
  gitignoreSection: string;
  defaultsSection: string;
  customSection: string;
}

/** Splits by the two markers; either missing (legacy file/user edit) returns null and callers rebuild wholesale. */
function splitWorkspaceFileSearchIgnoreSections(
  content: string,
): SplitWorkspaceFileSearchIgnoreSections | null {
  const lines = content.split(/\r?\n/);
  const syncIndex = lines.findIndex(
    (line) => line.trim() === WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
  );
  const defaultsIndex = lines.findIndex(
    (line) => line.trim() === WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
  );
  if (syncIndex === -1 || defaultsIndex === -1 || defaultsIndex <= syncIndex) {
    return null;
  }
  return {
    gitignoreSection: lines.slice(0, syncIndex).join("\n"),
    defaultsSection: lines
      .slice(syncIndex + 1, defaultsIndex)
      .join("\n")
      .trim(),
    customSection: lines
      .slice(defaultsIndex + 1)
      .join("\n")
      .replace(/^\n+/, ""),
  };
}

/**
 * Sync from .gitignore: rewrites only above the SYNC marker with the current .gitignore,
 * keeping defaults and custom sections intact (user edits to defaults survive).
 * Missing markers degrade to a full initial-content rebuild (sections cannot be located).
 */
export function syncWorkspaceFileSearchIgnoreFromGitignore(
  currentContent: string,
  gitignoreContent: string | null,
): string {
  const sections = splitWorkspaceFileSearchIgnoreSections(currentContent);
  if (!sections) {
    return buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  }
  const gitignoreSection =
    gitignoreContent !== null && gitignoreContent.trim().length > 0
      ? gitignoreContent.endsWith("\n")
        ? gitignoreContent
        : `${gitignoreContent}\n`
      : `${TEMPLATE_HEADER.join("\n")}\n`;
  return [
    gitignoreSection,
    WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
    sections.defaultsSection,
    WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
    sections.customSection,
  ]
    .join("\n")
    .replace(/\n+$/, "\n");
}

/**
 * Restore defaults: resets only the defaults segment to the built-in list; gitignore and custom sections stay.
 * Missing markers degrade to a full initial-content rebuild.
 */
export function resetWorkspaceFileSearchIgnoreDefaults(
  currentContent: string,
  gitignoreContent: string | null,
): string {
  const sections = splitWorkspaceFileSearchIgnoreSections(currentContent);
  if (!sections) {
    return buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  }
  // Restore re-dedupes against the current gitignore section: rules already declared there skip the defaults block;
  // if node_modules left the .gitignore, restore adds it back to defaults (safety net).
  return [
    sections.gitignoreSection,
    WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
    buildBuiltinDefaultsSection(sections.gitignoreSection),
    WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
    sections.customSection,
  ]
    .join("\n")
    .replace(/\n+$/, "\n");
}

// Under nodenext the ignore package's index.d.ts types the default import as a module namespace (uncallable),
// while runtime default is the factory itself (verified via Node ESM interop); narrow the type back to the factory.
const createIgnoreMatcher: () => Ignore = ignoreFactory as unknown as () => Ignore;

function buildIgnoreMatcher(content: string): Ignore {
  return createIgnoreMatcher().add(content);
}

function isNotFoundError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "ENOENT";
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Atomic write: temp file in the target dir (flush + close) then rename over, mirroring
 * workspace-hook-mutation.ts, so the runtime/settings page never observe a half-written rules file.
 */
async function atomicWriteIgnoreFile(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  const tempPath = resolve(
    directory,
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "wx", 0o644);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tempPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Loads .zcodeignore before scanning; auto-create is commented out for now:
 * missing file -> in-memory .gitignore plus defaults, nothing written;
 * read failure (permissions etc.) -> in-memory .gitignore -> then built-in defaults.
 * Each degrade warns once; the @ panel must never fail a scan over rules-file trouble.
 */
export async function loadWorkspaceFileSearchIgnoreRules(
  rootPath: string,
  logger?: WorkspaceFileIgnoreLogger,
): Promise<WorkspaceFileSearchIgnoreRules> {
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);

  const degradeToInMemory = async (
    reason: string,
    error: unknown,
  ): Promise<WorkspaceFileSearchIgnoreRules> => {
    const gitignoreContent = await readOptionalFile(resolve(rootPath, GITIGNORE_FILE_NAME)).catch(
      () => null,
    );
    if (gitignoreContent !== null) {
      logger?.warn(
        undefined,
        `[workspace-file-ignore] ${reason}; falling back to .gitignore rules in memory`,
        error,
      );
      return {
        matcher: buildIgnoreMatcher(gitignoreContent),
        source: "fallback-gitignore",
      };
    }
    logger?.warn(
      undefined,
      `[workspace-file-ignore] ${reason}; falling back to built-in default ignore rules`,
      error,
    );
    const template = buildWorkspaceFileSearchIgnoreTemplate(null);
    return {
      matcher: buildIgnoreMatcher(template),
      source: "fallback-builtin",
    };
  };

  let existing: string | null;
  try {
    existing = await readOptionalFile(ignorePath);
  } catch (error) {
    return degradeToInMemory(`Failed to read ${WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME}`, error);
  }
  if (existing !== null) {
    return { matcher: buildIgnoreMatcher(existing), source: "file" };
  }

  const gitignoreContent = await readOptionalFile(resolve(rootPath, GITIGNORE_FILE_NAME)).catch(
    () => null,
  );
  const initialContent = buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  // The settings entry is hidden, but auto-create would still write into user projects; disabled for now.
  // Creation/logging kept for re-enablement; rules stay in memory for now.
  /*
  try {
    await atomicWriteIgnoreFile(ignorePath, initialContent);
  } catch (error) {
    // Create failures never block scanning: the initial content is deterministic, so run it in memory and
    // keep the source marker of that content (gitignore copy / built-in) to express the fail-open degrade.
    logger?.warn(
      undefined,
      `[workspace-file-ignore] Auto-creating ${WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME} failed; falling back to ${
        gitignoreContent !== null ? "in-memory .gitignore" : "built-in defaults"
      }`,
      error,
    );
    return {
      matcher: buildIgnoreMatcher(initialContent),
      source: gitignoreContent !== null ? "fallback-gitignore" : "fallback-builtin",
    };
  }
  logger?.info(
    undefined,
    `[workspace-file-ignore] Auto-created ${WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME} (source: ${
      gitignoreContent !== null ? "gitignore copy" : "default template"
    }）`,
  );
  */
  return {
    matcher: buildIgnoreMatcher(initialContent),
    // source: gitignoreContent !== null ? "created-from-gitignore" : "created-from-template",
    source: "template",
  };
}

/**
 * Ignores test for relative paths. Directories must pass a trailing-slash path (gitignore dirOnly matches dirs only);
 * callers guarantee posix separators (fileService normalizeRelativePath already converts).
 */
export function isWorkspaceFileSearchPathIgnored(
  rules: WorkspaceFileSearchIgnoreRules,
  relativePath: string,
  type: "file" | "directory",
): boolean {
  return type === "directory"
    ? rules.matcher.ignores(`${relativePath}/`)
    : rules.matcher.ignores(relativePath);
}

/** Settings read: returns the initial-content preview (source: template) when no file exists; never writes. */
export async function readWorkspaceFileSearchIgnore(
  rootPath: string,
): Promise<WorkspaceFileSearchIgnoreContent> {
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);
  const existing = await readOptionalFile(ignorePath);
  if (existing !== null) {
    return { content: existing, source: "file" };
  }
  const gitignoreContent = await readOptionalFile(resolve(rootPath, GITIGNORE_FILE_NAME)).catch(
    () => null,
  );
  return {
    content: buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent),
    source: "template",
  };
}

export type WorkspaceFileSearchIgnoreTransform = "sync-gitignore" | "reset-defaults";

/**
 * Settings section ops (return new editor content; only saving persists):
 * sync-gitignore rewrites the sync section; reset-defaults resets only the defaults segment;
 * both preserve user content outside the markers (see each pure function's contract).
 */
export async function transformWorkspaceFileSearchIgnore(
  rootPath: string,
  transform: WorkspaceFileSearchIgnoreTransform,
): Promise<{ content: string }> {
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);
  const existing = await readOptionalFile(ignorePath).catch(() => null);
  const gitignoreContent = await readOptionalFile(resolve(rootPath, GITIGNORE_FILE_NAME)).catch(
    () => null,
  );
  const currentContent = existing ?? buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  const content =
    transform === "sync-gitignore"
      ? syncWorkspaceFileSearchIgnoreFromGitignore(currentContent, gitignoreContent)
      : resetWorkspaceFileSearchIgnoreDefaults(currentContent, gitignoreContent);
  return { content };
}

/** Settings save: atomic whole-file write; the next scan reads the new content. */
export async function writeWorkspaceFileSearchIgnore(
  rootPath: string,
  content: string,
): Promise<void> {
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);
  await atomicWriteIgnoreFile(ignorePath, content);
}
