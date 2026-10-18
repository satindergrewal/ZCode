import { copyFile, lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  GitCheckpointConflict,
  GitCheckpointDiff,
  GitCheckpointMeta,
  GitCheckpointRestoreResult,
} from "@zcode/shared";
import { getGitCheckpointIndexRootDir } from "../../paths.js";
import { toWorkspaceRelativeGitPath } from "../config.js";
import {
  createGitCommandProvider,
  type GitCommandProvider,
} from "../providers/gitCommandProvider.js";
import { createGitCliRepo, type GitCliRepo } from "./gitCliRepo.js";
import {
  buildAffectedRepoPaths,
  buildCheckpointEnv,
  getCheckpointRefName,
  getWorkspacePathspec,
  mergeCheckpointDiff,
  normalizeAffectedRepoPath,
  parseLsTree,
  parseNameStatus,
  parseNumstat,
  removeFileIfExists,
  toAbsolutePath,
} from "./gitCheckpointHelpers.js";
import { ensureGitCommandSucceeded } from "./gitCliHelpers.js";

interface GitCheckpointRepo {
  createCheckpoint(params: {
    workspacePath: string;
    checkpointId: string;
  }): Promise<GitCheckpointMeta>;
  diffCheckpoints(params: {
    workspacePath: string;
    from: GitCheckpointMeta;
    to: GitCheckpointMeta;
  }): Promise<GitCheckpointDiff>;
  restoreBetweenCheckpoints(params: {
    workspacePath: string;
    from: GitCheckpointMeta;
    to: GitCheckpointMeta;
    force?: boolean;
  }): Promise<GitCheckpointRestoreResult>;
  deleteCheckpoint(params: { workspacePath: string; checkpoint: GitCheckpointMeta }): Promise<void>;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export function createGitCheckpointRepo(options?: {
  commandProvider?: GitCommandProvider;
  gitRepo?: Pick<GitCliRepo, "resolveRepository">;
}): GitCheckpointRepo {
  const commandProvider = options?.commandProvider ?? createGitCommandProvider();
  const gitRepo = options?.gitRepo ?? createGitCliRepo({ commandProvider });

  async function ensureRepository(
    workspacePath: string,
  ): Promise<Awaited<ReturnType<typeof gitRepo.resolveRepository>>> {
    // Every checkpoint operation assumes the workspace maps to a real git repository;
    // resolve and prevalidate here so error semantics stay consistent across all methods.
    const resolution = await gitRepo.resolveRepository(workspacePath);
    if (!resolution.isGitAvailable) {
      throw new Error("Git binary is not available in the current environment.");
    }
    if (!resolution.isRepository) {
      throw new Error("Workspace is not inside a Git repository.");
    }
    return resolution;
  }

  async function computeCheckpointDiff(params: {
    workspacePath: string;
    from: GitCheckpointMeta;
    to: GitCheckpointMeta;
  }): Promise<GitCheckpointDiff> {
    // Checkpoint diffs cover only the current workspace scope, never the whole repo, so
    // restore/summary/conflict detection stays inside monorepo subdirectory bounds.
    const resolution = await ensureRepository(params.workspacePath);
    const pathspec = getWorkspacePathspec(resolution.workspaceInRepoPath);
    const [nameStatusResult, numstatResult] = await Promise.all([
      commandProvider.run({
        cwd: resolution.repoRoot,
        args: [
          "diff",
          "--name-status",
          "--find-renames",
          "-z",
          params.from.commitOid,
          params.to.commitOid,
          "--",
          pathspec,
        ],
      }),
      commandProvider.run({
        cwd: resolution.repoRoot,
        args: [
          "diff",
          "--numstat",
          "--find-renames",
          "-z",
          params.from.commitOid,
          params.to.commitOid,
          "--",
          pathspec,
        ],
      }),
    ]);
    ensureGitCommandSucceeded("git diff --name-status checkpoint", nameStatusResult);
    ensureGitCommandSucceeded("git diff --numstat checkpoint", numstatResult);

    // name-status says which paths changed and how; numstat adds the added/removed counts.
    // Combined they become the structured checkpoint diff, not raw git text.
    return mergeCheckpointDiff({
      repoRoot: resolution.repoRoot,
      workspaceInRepoPath: resolution.workspaceInRepoPath,
      fromCheckpointId: params.from.checkpointId,
      toCheckpointId: params.to.checkpointId,
      nameStatusEntries: parseNameStatus(nameStatusResult.stdout),
      numstat: parseNumstat(numstatResult.stdout),
    });
  }

  async function collectWorkspaceConflicts(params: {
    repoRoot: string;
    workspaceInRepoPath: string;
    from: GitCheckpointMeta;
    affectedRepoPaths: string[];
  }): Promise<GitCheckpointConflict[]> {
    if (params.affectedRepoPaths.length === 0) {
      return [];
    }

    // Conflict detection is not "is the work dirty": it asks whether the paths restore will
    // touch still match the caller-declared fromCheckpoint on disk.
    // Only then is restore safe amid unrelated changes, instead of condemning the whole repo.
    const treeResult = await commandProvider.run({
      cwd: params.repoRoot,
      args: ["ls-tree", "-r", "-z", params.from.commitOid, "--", ...params.affectedRepoPaths],
    });
    ensureGitCommandSucceeded("git ls-tree checkpoint paths", treeResult);
    const treeEntries = parseLsTree(treeResult.stdout);

    const conflicts: GitCheckpointConflict[] = [];
    for (const repoRelativePath of params.affectedRepoPaths) {
      const absolutePath = toAbsolutePath(params.repoRoot, repoRelativePath);
      const expectedEntry = treeEntries.get(repoRelativePath);

      if (!expectedEntry) {
        // Missing from fromCheckpoint: by baseline semantics it should not be on disk at all.
        // Its presence means it appeared after the checkpoint - an overwrite risk.
        if (!(await pathExists(absolutePath))) {
          continue;
        }
        conflicts.push({
          path: absolutePath,
          repoRelativePath,
          workspaceRelativePath: toWorkspaceRelativeGitPath(
            repoRelativePath,
            params.workspaceInRepoPath,
          ),
          reason: "unexpected-file-in-worktree",
        });
        continue;
      }

      let stats: Awaited<ReturnType<typeof lstat>>;
      try {
        stats = await lstat(absolutePath);
      } catch {
        // fromCheckpoint expects the file but it is gone; writing it back would clobber
        // whatever removed it, so report the conflict explicitly.
        conflicts.push({
          path: absolutePath,
          repoRelativePath,
          workspaceRelativePath: toWorkspaceRelativeGitPath(
            repoRelativePath,
            params.workspaceInRepoPath,
          ),
          reason: "missing-in-worktree",
        });
        continue;
      }

      const expectsSymlink = expectedEntry.mode === "120000";
      if (stats.isDirectory() || (expectsSymlink && !stats.isSymbolicLink())) {
        // Only git-stable states are handled; if the checkpoint expects a file/symlink and the
        // disk now has a directory, restore would misalign - treat it as a type conflict.
        conflicts.push({
          path: absolutePath,
          repoRelativePath,
          workspaceRelativePath: toWorkspaceRelativeGitPath(
            repoRelativePath,
            params.workspaceInRepoPath,
          ),
          reason: "type-mismatch",
        });
        continue;
      }

      const hashResult = await commandProvider.run({
        cwd: params.repoRoot,
        args: ["hash-object", "--no-filters", absolutePath],
      });
      ensureGitCommandSucceeded("git hash-object checkpoint verify", hashResult);
      if (hashResult.stdout.trim() === expectedEntry.objectId) {
        continue;
      }

      // Compare blob hashes, not timestamps/sizes: only identical content
      // counts as "disk still matches the fromCheckpoint baseline".
      conflicts.push({
        path: absolutePath,
        repoRelativePath,
        workspaceRelativePath: toWorkspaceRelativeGitPath(
          repoRelativePath,
          params.workspaceInRepoPath,
        ),
        reason: "content-mismatch",
      });
    }

    const deduped = new Map<string, GitCheckpointConflict>();
    for (const conflict of conflicts) {
      deduped.set(conflict.repoRelativePath, conflict);
    }
    return [...deduped.values()];
  }

  return {
    /**
     * Creates an immutable snapshot of workspace files.
     *
     * Flow:
     * 1. Resolve the git repo and scope for the workspace
     * 2. Collect live worktree state via a temp GIT_INDEX_FILE
     * 3. Produce a hidden internal commit via write-tree / commit-tree
     * 4. Pin the commit with a hidden ref so git GC cannot collect it early
     * 5. Return the metadata the manifest needs
     *
     * Hard constraints:
     * - never touch the user's real index
     * - no user-visible branches or ordinary commits
     * - scope always follows the workspace, never a whole-repo snapshot
     */
    async createCheckpoint(params) {
      const resolution = await ensureRepository(params.workspacePath);
      const refName = getCheckpointRefName(params.workspacePath, params.checkpointId);
      const tempIndexRootDir = getGitCheckpointIndexRootDir();
      await mkdir(tempIndexRootDir, { recursive: true });
      const tempIndexDir = await mkdtemp(resolve(tempIndexRootDir, "index-"));
      const tempIndexPath = resolve(tempIndexDir, "index");
      const env = buildCheckpointEnv(tempIndexPath);
      const pathspec = getWorkspacePathspec(resolution.workspaceInRepoPath);

      try {
        // Warm the temp index: copy the user's index, else read-tree HEAD, else empty.
        // On an empty index, git add -A must open/read/hash every file into the object store;
        // on Windows+Defender that is 5-15ms per file, blowing the 15s budget on big repos.
        // Reusing the user's index stat cache lets unchanged files take the stat-match fast path,
        // and the resulting tree is identical because it is built from the worktree.
        // Resolve the real index via rev-parse --git-path index (worktree/submodule safe).
        const indexPathResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["rev-parse", "--git-path", "index"],
        });
        let primed = false;
        if (indexPathResult.exitCode === 0) {
          const indexRelPath = indexPathResult.stdout.trim();
          if (indexRelPath.length > 0) {
            const userIndexPath = resolve(resolution.repoRoot, indexRelPath);
            try {
              await copyFile(userIndexPath, tempIndexPath);
              primed = true;
            } catch {
              // User index missing (fresh init) or unreadable: degrade.
            }
          }
        }
        if (!primed) {
          // Without a copyable index, seed from the HEAD tree so tracked files still hash-match.
          // A missing HEAD (fresh repo) fails read-tree; silently fall back to an empty index.
          const readTreeResult = await commandProvider.run({
            cwd: resolution.repoRoot,
            args: ["read-tree", "HEAD"],
            env,
          });
          if (readTreeResult.exitCode === 0) {
            primed = true;
          }
        }

        // Core move: freeze live workspace state into a hidden commit via a temp GIT_INDEX_FILE,
        // reusing git object storage without touching the user's index or staged state.
        const addResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["add", "-A", "--", pathspec],
          env,
        });
        ensureGitCommandSucceeded("git add checkpoint", addResult);

        // The temp index now holds the full workspace scope; freeze it into a tree object.
        const treeResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["write-tree"],
          env,
        });
        ensureGitCommandSucceeded("git write-tree checkpoint", treeResult);

        // Checkpoints stay out of branch history, but the objects need a stable anchor:
        // create an internal commit for the hidden ref to point at.
        const commitResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: [
            "commit-tree",
            treeResult.stdout.trim(),
            "-m",
            `zcode checkpoint ${params.checkpointId}`,
          ],
          env,
        });
        ensureGitCommandSucceeded("git commit-tree checkpoint", commitResult);
        const commitOid = commitResult.stdout.trim();

        // The hidden ref is the checkpoint's long-term anchor. It guarantees:
        // 1. git will not GC the objects away
        // 2. diff/restore/delete can always resolve the commit by refName
        const updateRefResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["update-ref", refName, commitOid],
        });
        ensureGitCommandSucceeded("git update-ref checkpoint", updateRefResult);

        return {
          checkpointId: params.checkpointId,
          workspacePath: params.workspacePath,
          repoRoot: resolution.repoRoot,
          workspaceInRepoPath: resolution.workspaceInRepoPath,
          createdAt: Date.now(),
          refName,
          commitOid,
          scope: "workspace",
        };
      } finally {
        // The temp index serves only this checkpoint; clear it so nothing leaks into the host env.
        await rm(tempIndexDir, { recursive: true, force: true });
      }
    },

    /**
     * Compares two checkpoints within the current workspace scope.
     *
     * This method knows nothing about agents/tasks/turns; it answers one pure file question:
     * "from fromCheckpoint to toCheckpoint, which files changed how inside this workspace?"
     *
     * restore, summaries, and future tooling reuse the result, so this stays pure/read-only.
     */
    async diffCheckpoints(params) {
      return await computeCheckpointDiff(params);
    },

    /**
     * Restores the live workspace from fromCheckpoint to toCheckpoint, safely.
     *
     * The core of this layer. The semantics are not "hard reset to a checkpoint" but a
     * three-way check:
     * - caller's claim: disk should still match fromCheckpoint
     * - goal: restore file state to toCheckpoint
     * - reality: disk may have moved on since
     *
     * Order of operations:
     * 1. compute the paths affected by from -> to
     * 2. verify they still match fromCheckpoint
     * 3. return conflicts instead of overwriting
     * 4. on no-conflict or force, write toCheckpoint content back
     * 5. re-verify the worktree now equals toCheckpoint
     */
    async restoreBetweenCheckpoints(params) {
      const resolution = await ensureRepository(params.workspacePath);
      const diff = await computeCheckpointDiff({
        workspacePath: params.workspacePath,
        from: params.from,
        to: params.to,
      });
      // A diff may list both the renamed and the pre-rename path; fold them into the final
      // affected set up front; conflict checks and deletions below work from that set.
      const affectedRepoPaths = buildAffectedRepoPaths(diff.files).map((path) =>
        normalizeAffectedRepoPath(resolution.repoRoot, path),
      );

      if (affectedRepoPaths.length === 0) {
        return {
          success: true,
          restoredPaths: [],
        };
      }

      const conflicts = await collectWorkspaceConflicts({
        repoRoot: resolution.repoRoot,
        workspaceInRepoPath: resolution.workspaceInRepoPath,
        from: params.from,
        affectedRepoPaths,
      });
      if (conflicts.length > 0 && params.force !== true) {
        // In the default mode, any drift from fromCheckpoint rejects the write so the
        // caller can surface conflicts instead of this layer clobbering newer changes.
        return {
          success: false,
          conflicts,
        };
      }

      const restoreRepoPaths = diff.files
        .filter((file) => file.kind !== "deleted")
        .map((file) => file.repoRelativePath);
      if (restoreRepoPaths.length > 0) {
        // restore is worktree-only: user staging must survive, keeping this a file-state
        // rollback rather than a destructive index change.
        const restoreResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: [
            "restore",
            `--source=${params.to.commitOid}`,
            "--worktree",
            "--",
            ...restoreRepoPaths,
          ],
        });
        ensureGitCommandSucceeded("git restore checkpoint", restoreResult);
      }

      const deleteAbsolutePaths = new Set<string>();
      for (const file of diff.files) {
        if (file.kind === "deleted") {
          // Paths no longer in toCheckpoint must have their leftovers removed from the worktree.
          deleteAbsolutePaths.add(file.path);
          continue;
        }
        if (file.kind === "renamed" && file.originalPath) {
          // On renames git restore recreates only the new path;
          // delete the old path explicitly so old and new never coexist.
          deleteAbsolutePaths.add(file.originalPath);
        }
      }
      for (const path of deleteAbsolutePaths) {
        await removeFileIfExists(path);
      }

      const verifyConflicts = await collectWorkspaceConflicts({
        repoRoot: resolution.repoRoot,
        workspaceInRepoPath: resolution.workspaceInRepoPath,
        from: params.to,
        affectedRepoPaths,
      });
      if (verifyConflicts.length > 0) {
        // No drift is expected here; any leftover means restore failed and reporting success
        // would cement a wrong state, so throw.
        throw new Error("Checkpoint restore verification failed.");
      }

      return {
        success: true,
        restoredPaths: diff.files.map((file) => file.path),
      };
    },

    /**
     * Deletes a checkpoint's git ref.
     *
     * Only the hidden ref is deleted here; manifest removal belongs to the store/service layer.
     * The repo layer owns git refs; the store layer owns local metadata.
     */
    async deleteCheckpoint(params) {
      const resolution = await ensureRepository(params.workspacePath);
      const deleteRefResult = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: ["update-ref", "-d", params.checkpoint.refName],
      });
      ensureGitCommandSucceeded("git update-ref -d checkpoint", deleteRefResult, [0, 1]);
    },
  };
}

export type { GitCheckpointRepo };
