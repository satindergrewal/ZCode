import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_SKILL_SCAN_DEPTH,
  SKILL_FILE_NAME,
  shouldWalkSkillDirectoryEntry,
} from "@zcode/shared";

// The scan policy lives in @zcode/shared, shared by desktop (this package) and agent (@zcode/adapters) so both
// agree on which directories to enter. Re-exported here to keep existing import paths.
export {
  MAX_SKILL_SCAN_DEPTH,
  SKILL_FILE_NAME,
  SKILL_SCAN_EXCLUDED_DIRECTORY_NAMES,
  shouldWalkSkillDirectoryEntry,
} from "@zcode/shared";

export interface WalkSkillMarkdownOptions {
  /** Invoked on readdir/stat failure; when omitted the directory is skipped silently for callers to collect diagnostics. */
  onError?: (path: string, error: unknown) => void;
}

/**
 * Depth-first walk from the root, yielding the absolute path of every SKILL.md.
 *
 * Constrained by the @zcode/shared scan policy:
 * - skip content dirs like node_modules and dot dirs (except .system);
 * - cap depth (MAX_SKILL_SCAN_DEPTH) as a brake for pathologically deep chains;
 * - dedupe symlinked dirs by realpath so Windows junctions/cycles cannot duplicate or loop the scan,
 *   while plain trees never cycle and stay realpath-free on the hot path.
 *
 */
export async function* walkSkillMarkdownPaths(
  rootPath: string,
  options: WalkSkillMarkdownOptions = {},
): AsyncGenerator<string> {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: rootPath, depth: 0 }];
  const visitedSymlinkTargets = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const { dir, depth } = current;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      options.onError?.(dir, error);
      continue;
    }

    let hasSkillFile = false;
    const childDirectories: string[] = [];
    const childSymlinks: string[] = [];
    for (const entry of entries) {
      // A plain file or a file-pointing symlink named SKILL.md both count as a skill definition.
      if (entry.name === SKILL_FILE_NAME && !entry.isDirectory()) {
        hasSkillFile = true;
        continue;
      }
      if (!shouldWalkSkillDirectoryEntry(entry.name)) {
        continue;
      }
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        childDirectories.push(entryPath);
      } else if (entry.isSymbolicLink()) {
        childSymlinks.push(entryPath);
      }
    }

    if (hasSkillFile) {
      yield join(dir, SKILL_FILE_NAME);
    }

    if (depth >= MAX_SKILL_SCAN_DEPTH) {
      continue;
    }

    for (const childDirectory of childDirectories) {
      stack.push({ dir: childDirectory, depth: depth + 1 });
    }

    // Symlinked dirs: confirm the target is a directory, dedupe by realpath, and avoid junction cycles.
    for (const childSymlink of childSymlinks) {
      let targetStat;
      try {
        targetStat = await stat(childSymlink);
      } catch (error) {
        options.onError?.(childSymlink, error);
        continue;
      }
      if (!targetStat.isDirectory()) {
        continue;
      }
      const canonical = await realpath(childSymlink).catch(() => childSymlink);
      if (visitedSymlinkTargets.has(canonical)) {
        continue;
      }
      visitedSymlinkTargets.add(canonical);
      stack.push({ dir: childSymlink, depth: depth + 1 });
    }
  }
}
