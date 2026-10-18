import { extname } from "node:path";

const SKIPPED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "bower_components",
  "jspm_packages",
  "__pycache__",
  "site-packages",
  "venv",
  "coverage",
  "htmlcov",
  "lcov-report",
  "cmakefiles",
  "pods",
  "deriveddata",
  "storybook-static",
  "playwright-report",
  "test-results",
  "allure-results",
  "allure-report",
  "cdk.out",
  "eggs",
  "pip-wheel-metadata",
  "wheels",
]);
const SKIPPED_DIRECTORY_PREFIXES = ["cmake-build-", "bazel-"];
const SKIPPED_DIRECTORY_SUFFIXES = [".egg-info", ".dist-info"];
const SKIPPED_FILE_NAMES = new Set(["coverage.out", "lcov.info"]);
const SKIPPED_FILE_EXTENSIONS = new Set([
  ".a",
  ".aar",
  ".beam",
  ".class",
  ".dll",
  ".dylib",
  ".ear",
  ".exe",
  ".gcda",
  ".gcno",
  ".gem",
  ".hi",
  ".idb",
  ".ilk",
  ".jar",
  ".lib",
  ".node",
  ".nupkg",
  ".o",
  ".obj",
  ".pdb",
  ".profdata",
  ".profraw",
  ".pyc",
  ".pyo",
  ".rlib",
  ".so",
  ".tsbuildinfo",
  ".war",
]);

export interface WorkspaceFileSearchEntry {
  name: string;
  path: string;
  relativePath: string;
  type: "file" | "directory";
}

export interface WorkspaceFileSearchDecision {
  include: boolean;
  traverse: boolean;
}

export interface WorkspaceFileSearchFilterContext {
  /**
   * True once .zcodeignore rules load: the rule file is the single source of truth for dir excludes,
   * the builtin dir blocklist retires (removing node_modules/ from the file restores search), and
   * only file-level rules (.env/binary suffixes) plus hidden-dir semantics stack on top.
   * false/absent on fail-open (rule file unusable): the blocklist remains the fallback.
   */
  ignoreRulesActive: boolean;
}

/**
 * The workspace file index relies only on this final filter, regardless of the rule source.
 * Future custom rules must inject a full replacement implementation, not union with the blocklist.
 */
export interface WorkspaceFileSearchFilter {
  evaluate(
    entry: WorkspaceFileSearchEntry,
    context?: WorkspaceFileSearchFilterContext,
  ): WorkspaceFileSearchDecision;
}

function shouldSkipDirectory(name: string): boolean {
  const normalizedName = name.toLowerCase();
  return (
    SKIPPED_DIRECTORY_NAMES.has(normalizedName) ||
    SKIPPED_DIRECTORY_PREFIXES.some((prefix) => normalizedName.startsWith(prefix)) ||
    SKIPPED_DIRECTORY_SUFFIXES.some((suffix) => normalizedName.endsWith(suffix))
  );
}

function shouldSkipFile(name: string): boolean {
  const normalizedName = name.toLowerCase();
  return (
    normalizedName === ".env" ||
    normalizedName.startsWith(".env.") ||
    SKIPPED_FILE_NAMES.has(normalizedName) ||
    SKIPPED_FILE_EXTENSIONS.has(extname(normalizedName))
  );
}

function isInsideHiddenDirectory(relativePath: string): boolean {
  const segments = relativePath.split("/");
  const directorySegments = segments.slice(0, -1);
  return directorySegments.some((segment) => segment.startsWith("."));
}

export const defaultWorkspaceFileSearchFilter: WorkspaceFileSearchFilter = {
  evaluate(entry, context) {
    if (entry.type === "directory") {
      // With ignoreRulesActive the dir blocklist retires: .zcodeignore is the only dir-exclude source.
      if (!context?.ignoreRulesActive && shouldSkipDirectory(entry.name)) {
        return { include: false, traverse: false };
      }
      // Pruning at any hidden dir would hide real files under .github from name search:
      // hidden dirs take no candidate slots but stay traversed so normal files inside are indexed.
      const hiddenDirectory =
        entry.name.startsWith(".") || isInsideHiddenDirectory(entry.relativePath);
      return { include: !hiddenDirectory, traverse: true };
    }

    return { include: !shouldSkipFile(entry.name), traverse: false };
  },
};
