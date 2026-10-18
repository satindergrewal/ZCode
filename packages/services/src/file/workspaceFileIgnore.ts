import { open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import ignoreFactory from "ignore";
import type { Ignore } from "ignore";
import type { ServiceLogger } from "../logger/serviceLogger.js";

/**
 * Single source of truth for workspace file-search ignore rules.
 *
 * `.zcodeignore` (workspace root, gitignore syntax) is the only rule file for the search index:
 * auto-created on first use as a copy of the root `.gitignore` (or the default template);
 * later .gitignore changes do not affect search until the user edits or re-syncs in settings.
 *
 * Parsing is delegated to the `ignore` npm package (gitignore spec 2.22 reference implementation):
 * later rules win, `!` negation (with git's native limits on un-negating excluded parents),
 * anchored/basename forms, `**` depth, dir suffix `/`, classes, escapes. No hand-rolled parsing here.
 */

export const WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME = ".zcodeignore";
const GITIGNORE_FILE_NAME = ".gitignore";

type WorkspaceFileIgnoreLogger = Pick<ServiceLogger, "info" | "warn">;

type WorkspaceFileSearchIgnoreRulesSource =
  | "file"
  | "created-from-gitignore"
  | "created-from-template"
  | "fallback-gitignore"
  | "fallback-builtin";

interface WorkspaceFileSearchIgnoreRules {
  matcher: Ignore;
  source: WorkspaceFileSearchIgnoreRulesSource;
}

interface WorkspaceFileSearchIgnoreContent {
  content: string;
  /** file: .zcodeignore exists; template: absent, content is the preview persisted on save. */
  source: "file" | "template";
}

/**
 * Builtin excludes for the default template, carrying over the retired blocklist from the old
 * defaultWorkspaceFileSearchFilter so fresh workspaces behave as before (node_modules/.git pruned).
 * Prefix globs use gitignore syntax (cmake-build-* etc.), equal to SKIPPED_DIRECTORY_PREFIXES.
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
  "# Same syntax as .gitignore; affects only ZCode @ file candidates / Command Center / file search,",
  "# not file tree browsing, uploads, or agent file access.",
  '# .gitignore changes do not auto-sync here; use "Sync from .gitignore\` in settings.',
  "",
];

/**
 * Section markers (exact-line match; deleting a marker degrades the buttons to a full rebuild):
 * "Sync from .gitignore" rewrites only the section above the SYNC marker;
 * "Restore defaults" rewrites only the defaults section between the markers;
 * the custom section below the DEFAULTS marker is never touched.
 */
const WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER =
  "# ===== The rules above are synced from .gitignore (sync rewrites only the section above) =====";
const WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER =
  "# ----- The rules above are ZCode defaults (custom rules go below; sync/restore leave them alone) -----";

const CUSTOM_SECTION_HINT = "# Custom rules go below (this hint line can be deleted)";

// Legacy zh-CN markers written by earlier versions; still recognized when splitting existing files.
const LEGACY_WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER =
  "# ===== ^ Synced from .gitignore (sync-from-gitignore rewrites only the part above) =====";
const LEGACY_WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER =
  "# ----- ^ ZCode default ignores; custom rules go below this line and survive sync/restore -----";

function buildBuiltinDefaultsSection(gitignoreContent: string | null): string {
  // Dedup on create/restore: rules already declared in the gitignore section are not repeated in the
  // defaults section, so each rule exists once - deleting that line fully unhides it, with no
  // confusing duplicate left hiding in the gitignore copy.
  // Matching is conservative: trim-equal, or equal ignoring one trailing '/' (node_modules vs node_modules/);
  // anchored variants (/node_modules/) count as distinct - prefer a duplicate over a lost rule.
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
 * Builds the initial `.zcodeignore` content: the .gitignore copy plus two-marker sectioning
 * (defaults / custom). Appending defaults is a compatibility requirement: repos whose .gitignore
 * omits node_modules would otherwise get dependency dirs scanned wholesale (the old full-repo-scan
 * problem). The defaults live in the file, editable and removable, keeping a single source of truth
 * with no code-level union. Deduped against the gitignore section (see buildBuiltinDefaultsSection).
 */
function buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent: string | null): string {
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

/** Splits by the two markers; null when either is missing (old format/user deletion) and callers rebuild. */
function splitWorkspaceFileSearchIgnoreSections(
  content: string,
): SplitWorkspaceFileSearchIgnoreSections | null {
  const lines = content.split(/\r?\n/);
  const isSectionMarker = (line: string, markers: readonly string[]): boolean => {
    const trimmed = line.trim();
    return markers.some((marker) => trimmed === marker);
  };
  const syncIndex = lines.findIndex((line) =>
    isSectionMarker(line, [
      WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
      LEGACY_WORKSPACE_FILE_SEARCH_IGNORE_SYNC_MARKER,
    ]),
  );
  const defaultsIndex = lines.findIndex((line) =>
    isSectionMarker(line, [
      WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
      LEGACY_WORKSPACE_FILE_SEARCH_IGNORE_DEFAULTS_MARKER,
    ]),
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
 * "Sync from .gitignore": rewrites only the section above the SYNC marker from the current .gitignore;
 * defaults and custom sections are preserved (user edits to defaults survive). Missing markers
 * degrade to a full initial-content rebuild (the sections cannot be located structurally).
 */
function syncWorkspaceFileSearchIgnoreFromGitignore(
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
 * "Restore defaults": resets only the defaults section to the builtin list; gitignore and custom
 * sections are kept. Missing markers degrade to a full rebuild.
 */
function resetWorkspaceFileSearchIgnoreDefaults(
  currentContent: string,
  gitignoreContent: string | null,
): string {
  const sections = splitWorkspaceFileSearchIgnoreSections(currentContent);
  if (!sections) {
    return buildWorkspaceFileSearchIgnoreTemplate(gitignoreContent);
  }
  // Restore re-derives defaults with gitignore dedup: rules present in the gitignore section are not
  // re-added; if node_modules was removed from .gitignore, restore puts it back (regression guard).
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

// The ignore package's index.d.ts resolves the default import to the module namespace under nodenext
// (no call signature) while the runtime default is the factory itself. Narrow the type explicitly here.
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
 * Atomic write: temp file in the target dir (flush + close) then rename over the target, mirroring
 * workspace-hook-mutation.ts, so the runtime/settings never observe a half-written rule file.
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
 * Loads `.zcodeignore` before scanning, with auto-create and a fail-open chain:
 * missing file -> atomic create (gitignore copy / default template);
 * create/read failure (read-only fs, permissions) -> in-memory gitignore rules -> builtin defaults.
 * Each downgrade warns once; an unusable rule file never fails the mention-panel scan.
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
        `[workspace-file-ignore] ${reason}; falling back to .gitignore rules at runtime`,
        error,
      );
      return {
        matcher: buildIgnoreMatcher(gitignoreContent),
        source: "fallback-gitignore",
      };
    }
    logger?.warn(
      undefined,
      `[workspace-file-ignore] ${reason}; falling back to builtin default ignore rules`,
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
  try {
    await atomicWriteIgnoreFile(ignorePath, initialContent);
  } catch (error) {
    // A failed creation must not break scanning: the initial content is deterministic, so run
    // in-memory against it and keep its source tag (gitignore copy / builtin template).
    logger?.warn(
      undefined,
      `[workspace-file-ignore] failed to auto-create ${WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME}; falling back to ${
        gitignoreContent !== null ? ".gitignore" : "builtin defaults"
      } rules`,
      error,
    );
    return {
      matcher: buildIgnoreMatcher(initialContent),
      source: gitignoreContent !== null ? "fallback-gitignore" : "fallback-builtin",
    };
  }
  logger?.info(
    undefined,
    `[workspace-file-ignore] auto-created ${WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME} (source: ${
      gitignoreContent !== null ? ".gitignore copy" : "default template"
    }）`,
  );
  return {
    matcher: buildIgnoreMatcher(initialContent),
    source: gitignoreContent !== null ? "created-from-gitignore" : "created-from-template",
  };
}

/**
 * Returns whether a relative path is ignored. Directories must pass a trailing-slash path (gitignore
 * dirOnly rules match dirs only); callers guarantee posix separators (normalized in fileService).
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

/** Settings read: when the file is absent, return the initial-content preview (source: template); no write. */
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

type WorkspaceFileSearchIgnoreTransform = "sync-gitignore" | "reset-defaults";

/**
 * Settings section operations (return new editor content; persisted on save):
 * sync-gitignore rewrites only the gitignore section, reset-defaults only the defaults section;
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

/** Settings save: atomic rewrite of the whole file; the next scan reads the new content. */
export async function writeWorkspaceFileSearchIgnore(
  rootPath: string,
  content: string,
): Promise<void> {
  const ignorePath = resolve(rootPath, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);
  await atomicWriteIgnoreFile(ignorePath, content);
}
