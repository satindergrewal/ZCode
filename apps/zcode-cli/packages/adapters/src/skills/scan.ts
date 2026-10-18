// ============================================================
// Skill root scanning rules (shared implementation).
// ============================================================

// A manifest skills entry may point at a single skill directory or a one-level collection.
// When the root has SKILL.md, recognize the root skill first, then scan one level of subdirs, matching
// desktop discovery so a single skill is never misread as a collection and silently skipped.
// The plugin discovery path (countSkillFiles / collectSkillComponents) is synchronous while the skill
// adapter uses fs/promises, hence sync/async variants: one rule set, honored by each implementation.
//
// Error contract: swallow only expected absence, ENOENT or not-a-directory, returning [], and rethrow
// everything else (EACCES, EMFILE, ...) so callers choose between a skill_scan_failed diagnostic and
// graceful degradation. A blanket outer catch would degrade permission errors to silent empty lists,
// turning skill_scan_failed into dead code and reintroducing a silent-failure path.
//
// Trust boundary: plugin-scope content is untrusted. Symlinks (including Windows
// junctions, both true per Dirent.isSymbolicLink/lstat) may point anywhere outside the plugin root,
// e.g. dir-level skills/evil-link -> ../../outside or file-level SKILL.md -> ~/.aws/credentials.
// Realpath containment was tried, but the boundary leaked through an optional argument across the data
// flow and every file touchpoint had to remember to validate (file links, cross-drive relative checks,
// manifest failure fallbacks all became holes). One rule instead: plugin scans never follow symlinks,
// rejecting links at root, subdir candidate and SKILL.md alike (rejection cannot escape; no target checks).
// User-level skill roots keep default following: ~/.zcode/skills symlink imports are supported.

import { lstatSync, readdirSync, statSync } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { SKILL_FILE_NAME, shouldWalkSkillDirectoryEntry } from "@zcode/shared";

interface ScanSkillFilesOptions {
  /**
   * Whether to follow symlinks (dir and file level); default true (user-level skill roots support
   * symlink imports). Plugin-scope scans must pass false: links may point outside the plugin root, and
   * rejecting links rejects escape without any realpath target checks.
   */
  followSymbolicLinks?: boolean;
}

/**
 * All real SKILL.md absolute paths under root, root included.
 * Returns [] when root is missing or not a directory; other scan errors (EACCES, ...) propagate.
 */
export async function scanSkillFilesUnderRoot(
  rootPath: string,
  options: ScanSkillFilesOptions = {},
): Promise<string[]> {
  const followSymlinks = options.followSymbolicLinks ?? true;
  // A linked root (junctions included) yields an empty plugin scan.
  if (!followSymlinks && (await isSymbolicLink(rootPath))) return [];

  const rootInfo = await stat(rootPath).catch((error) => {
    throwIfUnexpectedScanError(error);
    return null;
  });
  if (!rootInfo?.isDirectory()) return [];

  const files: string[] = [];
  const own = join(rootPath, SKILL_FILE_NAME);
  // No SKILL.md at the root is normal; keep scanning one level of subdirs.
  if (await isLoadableSkillFile(own, followSymlinks)) files.push(own);

  const entries = await readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const walkable = entry.isDirectory() || (followSymlinks && entry.isSymbolicLink());
    if (!walkable) continue;
    if (!shouldWalkSkillDirectoryEntry(entry.name)) continue;
    // Candidate paths must exist on disk: category dirs (skills/engineering/) are not skill dirs, so the
    // joined path is missing; parseSkill would skip silently, but counts and component enumeration
    // consume this result and would count nonexistent skills.
    const candidate = join(rootPath, entry.name, SKILL_FILE_NAME);
    if (await isLoadableSkillFile(candidate, followSymlinks)) files.push(candidate);
  }
  return files;
}

/** Sync variant of scanSkillFilesUnderRoot with the same error contract. */
export function scanSkillFilesUnderRootSync(
  rootPath: string,
  options: ScanSkillFilesOptions = {},
): string[] {
  const followSymlinks = options.followSymbolicLinks ?? true;
  if (!followSymlinks && isSymbolicLinkSync(rootPath)) return [];

  const rootInfo = statSyncOrNull(rootPath);
  if (!rootInfo?.isDirectory()) return [];

  const files: string[] = [];
  const own = join(rootPath, SKILL_FILE_NAME);
  if (isLoadableSkillFileSync(own, followSymlinks)) files.push(own);

  for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
    const walkable = entry.isDirectory() || (followSymlinks && entry.isSymbolicLink());
    if (!walkable) continue;
    if (!shouldWalkSkillDirectoryEntry(entry.name)) continue;
    const candidate = join(rootPath, entry.name, SKILL_FILE_NAME);
    if (isLoadableSkillFileSync(candidate, followSymlinks)) files.push(candidate);
  }
  return files;
}

/**
 * Loadability check for SKILL.md candidates: only real files count. When not following links, symlinked
 * files (junctions included) are always rejected, guarding the file-level escape path.
 */
async function isLoadableSkillFile(path: string, followSymlinks: boolean): Promise<boolean> {
  if (!followSymlinks && (await isSymbolicLink(path))) return false;
  const info = await stat(path).catch((error) => {
    throwIfUnexpectedScanError(error);
    return null;
  });
  return info?.isFile() ?? false;
}

function isLoadableSkillFileSync(path: string, followSymlinks: boolean): boolean {
  if (!followSymlinks && isSymbolicLinkSync(path)) return false;
  return statSyncOrNull(path)?.isFile() ?? false;
}

async function isSymbolicLink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

function isSymbolicLinkSync(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function statSyncOrNull(path: string): { isFile(): boolean; isDirectory(): boolean } | null {
  try {
    return statSync(path);
  } catch (error) {
    throwIfUnexpectedScanError(error);
    return null;
  }
}

/** ENOENT is normal during scans, swallow it; rethrow everything else (EACCES, ...). */
function throwIfUnexpectedScanError(error: unknown): void {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  ) {
    return;
  }
  throw error;
}
