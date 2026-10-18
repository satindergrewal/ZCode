// ============================================================
// Skill scan policy (pure, no I/O)
// ============================================================
//
// Shared policy for skill-directory scanning, consumed by @zcode/services (desktop recursive scan) and
// apps/zcode-cli's @zcode/adapters (agent single-level scan),
// so the two ends never disagree on which directories count.
//
// Must stay pure logic with no node:* imports, or the web bundle breaks.

/** The skill definition file name. */
export const SKILL_FILE_NAME = "SKILL.md";

/**
 * Subdirectory names skipped outright during recursive skill scans.
 *
 * Skipping only dot-dirs is not enough:
 * content dirs like node_modules get recursed wholesale, stretching one skills.list to 69-256s on Windows.
 * Users never keep skills there; excluded uniformly.
 */
export const SKILL_SCAN_EXCLUDED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
  ".cache",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
]);

/**
 * Max recursion depth (relative to the scan root, the root itself 0).
 *
 * Real skill layouts are shallow: root/<name>/SKILL.md, at most
 * root/<group>/<name>/SKILL.md when grouped. 8 levels gives slack and brakes runaway
 * symlink/junction dir chains.
 */
export const MAX_SKILL_SCAN_DEPTH = 8;

/**
 * Under skill roots (incl. ~/.zcode/skills), dot-prefixed subdirs are not entered by default,
 * so .agents/.cursor vendored copies and symlink mirrors never list twice;
 * content dirs like node_modules are skipped too.
 */
const SKILL_DISCOVERY_DOT_DIR_ALLOWLIST = new Set([".system"]);

/** Whether recursive scanning should enter a directory entry. */
export function shouldWalkSkillDirectoryEntry(entryName: string): boolean {
  if (SKILL_SCAN_EXCLUDED_DIRECTORY_NAMES.has(entryName)) {
    return false;
  }
  if (!entryName.startsWith(".")) {
    return true;
  }
  return SKILL_DISCOVERY_DOT_DIR_ALLOWLIST.has(entryName);
}
