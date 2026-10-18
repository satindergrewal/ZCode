/* eslint-disable max-lines */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type {
  GitBranchMutationAction,
  GitBranchMutationIssue,
  GitBranchMutationResult,
  GitCommitGraphCommit,
  GitCommitGraphRef,
  GitDiffQuery,
  GitDiffResult,
  GitIdentity,
  GitLocalBranch,
  GitLocalBranchListResult,
  GitWorkspaceRepositoryInfo,
  GitPushResult,
} from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  DEFAULT_GIT_COMMAND_TIMEOUT_MS,
  DEFAULT_GIT_DIFF_BYTES,
  DEFAULT_GIT_DIFF_TIMEOUT_MS,
  DEFAULT_GIT_OUTPUT_BYTES,
  DEFAULT_GIT_PUSH_OUTPUT_BYTES,
  DEFAULT_GIT_PUSH_TIMEOUT_MS,
  getGitNullDevicePath,
  normalizeGitPath,
  normalizeWorkspaceInRepoPath,
} from "../config.js";
import {
  createGitCommandProvider,
  type GitCommandProvider,
} from "../providers/gitCommandProvider.js";
import {
  buildUntrackedTextDiffResult,
  buildUntrackedStats,
  ensureGitCommandSucceeded,
  ensureRepositoryAvailable,
  fileExists,
  inferKindFromNumstat,
  isMissingWorkingDirectoryResult,
  isNotRepositoryResult,
  normalizeInputPath,
  parseGitBranchMutationIssues,
  parseGitConfigValue,
  parseNumstat,
  parseStatusPorcelain,
  toInvalidBranchNameIssue,
  toDiffResult,
} from "./gitCliHelpers.js";
import {
  createEmptySummary,
  type GitBranchComparisonChange,
  type GitBranchComparisonSnapshot,
  type GitCliRepo,
  type GitCommitGraphSnapshot,
  type GitResolvedRepository,
  type GitStatusSnapshot,
} from "./gitCliTypes.js";

export type {
  GitBranchComparisonChange,
  GitBranchComparisonSnapshot,
  GitCliRepo,
  GitLineStat,
  GitResolvedRepository,
  GitStatusEntry,
  GitStatusSnapshot,
} from "./gitCliTypes.js";

function toUnavailableDiff(path: string, summary: string): GitDiffResult {
  return {
    path,
    availability: "unavailable",
    patch: null,
    beforeContent: null,
    afterContent: null,
    summary,
  };
}

interface GitDiffContents {
  beforeContent: string;
  afterContent: string;
}

function toCompleteDiffContents(
  beforeContent: string | null,
  afterContent: string | null,
): GitDiffContents | null {
  // If either side of a full-diff read fails and gets patched to "", the UI misreads
  // unreadable as empty, rendering the file as fully added/deleted. Both succeed or degrade together.
  if (beforeContent === null || afterContent === null) {
    return null;
  }

  return { beforeContent, afterContent };
}

const GIT_OPERATION_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "BISECT_LOG",
] as const;

const DEFAULT_GIT_GRAPH_MAX_COUNT = 100;
const MAX_GIT_GRAPH_MAX_COUNT = 200;
const GIT_GRAPH_RECORD_SEPARATOR = "\x1e";
const GIT_GRAPH_FIELD_SEPARATOR = "\x00";
const log = createServiceLogger("git-repo");

function normalizeWatchPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "/" || /^[A-Za-z]:[\\/]?$/.test(trimmed)) {
    return trimmed;
  }

  return trimmed.replace(/[\\/]+$/, "");
}

function addAutoRefreshWatchPath(
  paths: GitResolvedRepository["autoRefreshWatchPaths"],
  path: string,
  recursive: boolean,
): void {
  const normalizedPath = normalizeWatchPath(path);
  if (!normalizedPath || paths.some((entry) => entry.path === normalizedPath)) {
    return;
  }

  paths.push({
    path: normalizedPath,
    recursive,
  });
}

function buildAutoRefreshWatchPaths(params: {
  workspacePath: string;
  absoluteGitDir: string;
  gitCommonDir: string;
}): GitResolvedRepository["autoRefreshWatchPaths"] {
  const paths: GitResolvedRepository["autoRefreshWatchPaths"] = [];
  // On Linux, recursive fs.watch over workspacePath allocates watchers for the whole tree;
  // slow mounts and huge generated dirs stall the host. The UI owns workspace content
  // watchers per platform; this layer watches only the git metadata boundary.

  // Git metadata may live outside repoRoot (linked worktree / separate git-dir);
  // the UI only knows the workspace path, so watch the dir git itself resolves.
  addAutoRefreshWatchPath(paths, params.absoluteGitDir, true);
  const resolvedCommonDir = params.gitCommonDir
    ? isAbsolute(params.gitCommonDir)
      ? params.gitCommonDir
      : // git rev-parse --git-common-dir resolves relative to the command cwd;
        // repoRoot for a subdir workspace would turn /root + ../.git into /.git.
        resolve(params.workspacePath, params.gitCommonDir)
    : params.absoluteGitDir;
  addAutoRefreshWatchPath(paths, resolvedCommonDir, true);

  return paths;
}

function isPreviewableText(content: string): boolean {
  return !content.includes("\0");
}

async function readWorkingTreePreviewContent(absolutePath: string): Promise<string | null> {
  try {
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile() || fileStat.size > DEFAULT_GIT_DIFF_BYTES) {
      return null;
    }

    const content = await readFile(absolutePath, "utf-8");
    return isPreviewableText(content) ? content : null;
  } catch {
    // Deletions and atomic-save windows make stat/readFile fail; never guess an empty file.
    return null;
  }
}

async function readGitBlobPreviewContent({
  commandProvider,
  repoRoot,
  ref,
  repoRelativePath,
}: {
  commandProvider: GitCommandProvider;
  repoRoot: string;
  ref: string;
  repoRelativePath: string;
}): Promise<string | null> {
  const result = await commandProvider.run({
    cwd: repoRoot,
    args: ["show", `${ref}:${repoRelativePath}`],
    timeoutMs: DEFAULT_GIT_DIFF_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_GIT_DIFF_BYTES,
  });

  if (
    result.timedOut ||
    result.outputTruncated ||
    result.exitCode !== 0 ||
    !isPreviewableText(result.stdout)
  ) {
    return null;
  }

  return result.stdout;
}

async function readBranchDiffContents({
  commandProvider,
  repoRoot,
  repoRelativePath,
  trackingBranchName,
}: {
  commandProvider: GitCommandProvider;
  repoRoot: string;
  repoRelativePath: string;
  trackingBranchName: string;
}): Promise<GitDiffContents | null> {
  const mergeBaseResult = await commandProvider.run({
    cwd: repoRoot,
    args: ["merge-base", trackingBranchName, "HEAD"],
    timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
  });
  const mergeBase = mergeBaseResult.exitCode === 0 ? mergeBaseResult.stdout.trim() : "";
  const beforeContent = await readGitBlobPreviewContent({
    commandProvider,
    repoRoot,
    ref: mergeBase || trackingBranchName,
    repoRelativePath,
  });
  const afterContent = await readGitBlobPreviewContent({
    commandProvider,
    repoRoot,
    ref: "HEAD",
    repoRelativePath,
  });

  return toCompleteDiffContents(beforeContent, afterContent);
}

async function readStagedDiffContents({
  commandProvider,
  repoRoot,
  repoRelativePath,
}: {
  commandProvider: GitCommandProvider;
  repoRoot: string;
  repoRelativePath: string;
}): Promise<GitDiffContents | null> {
  const beforeContent = await readGitBlobPreviewContent({
    commandProvider,
    repoRoot,
    ref: "HEAD",
    repoRelativePath,
  });
  const afterContent = await readGitBlobPreviewContent({
    commandProvider,
    repoRoot,
    ref: "",
    repoRelativePath,
  });

  return toCompleteDiffContents(beforeContent, afterContent);
}

async function readUnstagedDiffContents({
  absolutePath,
  commandProvider,
  repoRoot,
  repoRelativePath,
}: {
  absolutePath: string;
  commandProvider: GitCommandProvider;
  repoRoot: string;
  repoRelativePath: string;
}): Promise<GitDiffContents | null> {
  const beforeContent = await readGitBlobPreviewContent({
    commandProvider,
    repoRoot,
    ref: "",
    repoRelativePath,
  });
  const afterContent = await readWorkingTreePreviewContent(absolutePath);

  return toCompleteDiffContents(beforeContent, afterContent);
}

function withDiffContents(diff: GitDiffResult, contents: GitDiffContents | null): GitDiffResult {
  if (diff.availability !== "patch") {
    return diff;
  }

  if (!contents) {
    // With the patch already built, a preview failure must only drop the preview, not the patch.
    return diff;
  }

  return {
    ...diff,
    beforeContent: contents.beforeContent,
    afterContent: contents.afterContent,
  };
}

function toBranchMutationFailure(params: {
  action: GitBranchMutationAction;
  branchName: string | null;
  created?: boolean;
  summary: GitStatusSnapshot["summary"];
  issues: GitBranchMutationIssue[];
}): GitBranchMutationResult {
  return {
    ok: false,
    action: params.action,
    branchName: params.branchName,
    didChange: false,
    created: params.created ?? false,
    summary: params.summary,
    issues: params.issues,
  };
}

function toBranchMutationSuccess(params: {
  action: GitBranchMutationAction;
  branchName: string;
  didChange: boolean;
  created: boolean;
  summary: GitStatusSnapshot["summary"];
}): GitBranchMutationResult {
  return {
    ok: true,
    action: params.action,
    branchName: params.branchName,
    didChange: params.didChange,
    created: params.created,
    summary: params.summary,
    issues: [],
  };
}

function parseBranchRefRecords(stdout: string, currentBranchName: string | null): GitLocalBranch[] {
  return stdout
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line): GitLocalBranch | null => {
      const [name, upstreamName, commitHash, commitTimestamp] = line.split("\0");
      if (!name) {
        return null;
      }

      const timestampSeconds = commitTimestamp ? Number.parseInt(commitTimestamp, 10) : Number.NaN;
      return {
        name,
        isCurrent: name === currentBranchName,
        upstreamName: upstreamName || null,
        commitHash: commitHash || null,
        commitTimestampMs: Number.isNaN(timestampSeconds) ? null : timestampSeconds * 1000,
      };
    })
    .filter((branch): branch is GitLocalBranch => Boolean(branch))
    .sort((left, right) => {
      if (left.isCurrent !== right.isCurrent) {
        return left.isCurrent ? -1 : 1;
      }

      const leftTimestamp = left.commitTimestampMs ?? Number.NEGATIVE_INFINITY;
      const rightTimestamp = right.commitTimestampMs ?? Number.NEGATIVE_INFINITY;
      if (leftTimestamp !== rightTimestamp) {
        return rightTimestamp - leftTimestamp;
      }

      return left.name.localeCompare(right.name);
    });
}

function normalizeGitGraphMaxCount(maxCount: number | undefined): number {
  if (typeof maxCount !== "number" || !Number.isFinite(maxCount)) {
    return DEFAULT_GIT_GRAPH_MAX_COUNT;
  }

  return Math.min(MAX_GIT_GRAPH_MAX_COUNT, Math.max(1, Math.floor(maxCount)));
}

function normalizeGitGraphSkip(skip: number | undefined): number {
  if (typeof skip !== "number" || !Number.isFinite(skip)) {
    return 0;
  }

  return Math.max(0, Math.floor(skip));
}

function addGitGraphRef(refs: GitCommitGraphRef[], ref: GitCommitGraphRef): void {
  if (refs.some((candidate) => candidate.kind === ref.kind && candidate.name === ref.name)) {
    return;
  }

  refs.push(ref);
}

function parseGitGraphDecorationRef(rawRef: string): GitCommitGraphRef | null {
  const ref = rawRef.trim();
  if (!ref) {
    return null;
  }

  if (ref === "HEAD") {
    return { name: "HEAD", kind: "head" };
  }

  const tagPrefix = "tag: ";
  if (ref.startsWith(tagPrefix)) {
    const tagRef = ref.slice(tagPrefix.length).trim();
    const name = tagRef.startsWith("refs/tags/") ? tagRef.slice("refs/tags/".length) : tagRef;
    return name ? { name, kind: "tag" } : null;
  }

  if (ref.startsWith("refs/heads/")) {
    const name = ref.slice("refs/heads/".length);
    return name ? { name, kind: "branch" } : null;
  }

  if (ref.startsWith("refs/remotes/")) {
    const name = ref.slice("refs/remotes/".length);
    return name ? { name, kind: "remote" } : null;
  }

  if (ref.startsWith("refs/tags/")) {
    const name = ref.slice("refs/tags/".length);
    return name ? { name, kind: "tag" } : null;
  }

  return { name: ref, kind: ref.includes("/") ? "remote" : "branch" };
}

function parseGitGraphRefs(rawDecorations: string): GitCommitGraphRef[] {
  const refs: GitCommitGraphRef[] = [];
  for (const rawDecoration of rawDecorations.split(",")) {
    const decoration = rawDecoration.trim();
    if (!decoration) {
      continue;
    }

    const headPointer = "HEAD -> ";
    if (decoration.startsWith(headPointer)) {
      addGitGraphRef(refs, { name: "HEAD", kind: "head" });
      const pointedRef = parseGitGraphDecorationRef(decoration.slice(headPointer.length));
      if (pointedRef) {
        addGitGraphRef(refs, pointedRef);
      }
      continue;
    }

    const parsedRef = parseGitGraphDecorationRef(decoration);
    if (parsedRef) {
      addGitGraphRef(refs, parsedRef);
    }
  }

  return refs;
}

function parseGitGraphRecords(stdout: string): GitCommitGraphCommit[] {
  return stdout
    .split(GIT_GRAPH_RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter((record) => record.length > 0)
    .map((record): GitCommitGraphCommit | null => {
      const [hash, parents, authorName, authoredAtSeconds, subject, decorations] =
        record.split(GIT_GRAPH_FIELD_SEPARATOR);
      if (!hash) {
        return null;
      }

      const timestampSeconds = authoredAtSeconds
        ? Number.parseInt(authoredAtSeconds, 10)
        : Number.NaN;
      return {
        hash,
        parents: parents ? parents.split(" ").filter(Boolean) : [],
        refs: parseGitGraphRefs(decorations ?? ""),
        subject: subject ?? "",
        authorName: authorName || null,
        authoredAtMs: Number.isNaN(timestampSeconds) ? null : timestampSeconds * 1000,
      };
    })
    .filter((commit): commit is GitCommitGraphCommit => Boolean(commit));
}

function parseTrackingRemoteName(trackingBranchName: string | null): string | null {
  const remoteName = trackingBranchName?.split("/")[0]?.trim() ?? "";
  return remoteName.length > 0 ? remoteName : null;
}

function parseRemoteList(stdout: string): string[] {
  return stdout
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

interface GitIndexEntry {
  mode: string;
  objectHash: string;
  stage: string;
  path: string;
}

function parseGitIndexEntries(stdout: string): GitIndexEntry[] {
  return stdout
    .split("\0")
    .filter((record) => record.length > 0)
    .map((record) => {
      const tabIndex = record.indexOf("\t");
      if (tabIndex < 0) {
        throw new Error("Failed to parse staged Git index entry.");
      }

      const [mode, objectHash, stage] = record.slice(0, tabIndex).trim().split(/\s+/);
      const path = normalizeGitPath(record.slice(tabIndex + 1));
      if (!mode || !objectHash || !stage || !path) {
        throw new Error("Failed to parse staged Git index entry.");
      }

      return { mode, objectHash, stage, path };
    });
}

export function createGitCliRepo(options?: { commandProvider?: GitCommandProvider }): GitCliRepo {
  const commandProvider = options?.commandProvider ?? createGitCommandProvider();
  const repositoryResolutionRequests = new Map<string, Promise<GitResolvedRepository>>();
  const workspaceRepositoryInfoRequests = new Map<string, Promise<GitWorkspaceRepositoryInfo>>();
  const statusRequests = new Map<string, Promise<GitStatusSnapshot>>();
  const collapsedUntrackedRepoRoots = new Set<string>();

  function executeGitStatus(resolution: GitResolvedRepository, untrackedMode: "all" | "normal") {
    return commandProvider.run({
      cwd: resolution.repoRoot,
      args: ["status", "--porcelain=v2", "--branch", `--untracked-files=${untrackedMode}`, "-z"],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
    });
  }

  async function runGitStatus(resolution: GitResolvedRepository) {
    const useCollapsedUntracked = collapsedUntrackedRepoRoots.has(resolution.repoRoot);
    const result = await executeGitStatus(resolution, useCollapsedUntracked ? "normal" : "all");
    if (useCollapsedUntracked || !result.outputTruncated) {
      return result;
    }

    // Per-file untracked status can exceed the output cap on huge repos; raising the cap would
    // trigger concurrent reads of thousands of files. Once over the cap, remember dir-collapse
    // per repoRoot: keep a usable summary/changes entry, skip the doomed detailed call.
    collapsedUntrackedRepoRoots.add(resolution.repoRoot);
    log.warn(
      undefined,
      `git status detailed output exceeded limit; collapsing untracked directories repoRoot=${resolution.repoRoot}`,
    );
    return await executeGitStatus(resolution, "normal");
  }

  function reuseInFlightRequest<T>(
    requests: Map<string, Promise<T>>,
    key: string,
    factory: () => Promise<T>,
  ): Promise<T> {
    const existing = requests.get(key);
    if (existing) {
      return existing;
    }

    const request = factory();
    requests.set(key, request);
    const cleanup = () => {
      if (requests.get(key) === request) {
        requests.delete(key);
      }
    };
    void request.then(cleanup, cleanup);
    return request;
  }

  function invalidate(workspacePath: string): void {
    repositoryResolutionRequests.delete(workspacePath);
    workspaceRepositoryInfoRequests.delete(workspacePath);
    statusRequests.delete(workspacePath);
  }

  async function validateBranchName(
    resolution: GitResolvedRepository,
    branchName: string,
  ): Promise<GitBranchMutationIssue | null> {
    const result = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: ["check-ref-format", "--branch", branchName],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    if (result.timedOut || result.outputTruncated) {
      ensureGitCommandSucceeded("git check-ref-format --branch", result);
    }

    return result.exitCode === 0 ? null : toInvalidBranchNameIssue(result.stderr);
  }

  async function hasOperationInProgress(resolution: GitResolvedRepository): Promise<boolean> {
    // In-progress merge/rebase/cherry-pick errors vary across git versions;
    // probe the git-dir marker files first so callers get a stable blocked reason.
    const gitPathResult = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: ["rev-parse", ...GIT_OPERATION_MARKERS.flatMap((marker) => ["--git-path", marker])],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    ensureGitCommandSucceeded("git rev-parse --git-path", gitPathResult);

    const candidatePaths = gitPathResult.stdout
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => (isAbsolute(line) ? line : resolve(resolution.repoRoot, line)));

    const markerExists = await Promise.all(candidatePaths.map((path) => fileExists(path)));
    return markerExists.some(Boolean);
  }

  async function readOptionalGitConfig(
    resolution: GitResolvedRepository,
    key: string,
  ): Promise<string | null> {
    const result = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: ["config", "--get", key],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
    });
    if (result.timedOut || result.outputTruncated) {
      ensureGitCommandSucceeded(`git config --get ${key}`, result);
    }

    if (result.exitCode === 0) {
      const value = result.stdout.trim();
      return value.length > 0 ? value : null;
    }

    if (result.exitCode === 1) {
      return null;
    }

    ensureGitCommandSucceeded(`git config --get ${key}`, result);
    return null;
  }

  async function listRemotes(resolution: GitResolvedRepository): Promise<string[]> {
    const result = await commandProvider.run({
      cwd: resolution.repoRoot,
      args: ["remote"],
      timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
    });
    ensureGitCommandSucceeded("git remote", result);
    return parseRemoteList(result.stdout);
  }

  async function resolvePushRemote(status: GitStatusSnapshot): Promise<string> {
    const resolution = ensureRepositoryAvailable(status.resolution, "push changes");
    const branchName = status.summary.branchName?.trim() ?? "";
    if (branchName.length === 0) {
      throw new Error("Cannot resolve a Git push remote without a current branch.");
    }

    const branchRemote = await readOptionalGitConfig(resolution, `branch.${branchName}.remote`);
    if (branchRemote) {
      return branchRemote;
    }

    const pushDefaultRemote = await readOptionalGitConfig(resolution, "remote.pushDefault");
    if (pushDefaultRemote) {
      return pushDefaultRemote;
    }

    const remotes = await listRemotes(resolution);
    if (remotes.includes("origin")) {
      return "origin";
    }

    if (remotes.length === 1) {
      return remotes[0]!;
    }

    if (remotes.length === 0) {
      throw new Error("No Git remote is configured for the current repository.");
    }

    throw new Error(
      "Multiple Git remotes are configured. Configure branch.<name>.remote or remote.pushDefault first.",
    );
  }

  return {
    invalidate,

    async resolveRepository(workspacePath: string): Promise<GitResolvedRepository> {
      // Startup fires summary/changes/branch/identity concurrently per workspace;
      // reuse the in-flight repo resolution instead of repeating git rev-parse.
      return await reuseInFlightRequest(repositoryResolutionRequests, workspacePath, async () => {
        const gitBinary = await commandProvider.resolveGitBinary();
        if (!gitBinary) {
          return {
            workspacePath,
            repoRoot: workspacePath,
            workspaceInRepoPath: ".",
            autoRefreshWatchPaths: [],
            isGitAvailable: false,
            isRepository: false,
          };
        }

        const result = await commandProvider.run({
          cwd: workspacePath,
          args: [
            "rev-parse",
            "--show-toplevel",
            "--show-prefix",
            "--absolute-git-dir",
            "--git-common-dir",
          ],
          timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        });
        if (result.exitCode !== 0) {
          // Workspace dirs can vanish mid-request (temp dir cleanup, tests, window switches).
          // Throwing here became unhandled rejections on fire-and-forget paths and hung Vitest;
          // a missing dir is not a git protocol failure - degrade to not-a-repository.
          if (isMissingWorkingDirectoryResult(result)) {
            return {
              workspacePath,
              repoRoot: workspacePath,
              workspaceInRepoPath: ".",
              autoRefreshWatchPaths: [],
              isGitAvailable: true,
              isRepository: false,
            };
          }

          if (isNotRepositoryResult(result)) {
            return {
              workspacePath,
              repoRoot: workspacePath,
              workspaceInRepoPath: ".",
              autoRefreshWatchPaths: [],
              isGitAvailable: true,
              isRepository: false,
            };
          }

          ensureGitCommandSucceeded("git rev-parse", result);
        }

        const lines = result.stdout.replace(/\r\n/g, "\n").split("\n");
        const repoRoot = lines[0]?.trim();
        if (!repoRoot) {
          throw new Error("Failed to resolve Git repository root");
        }

        return {
          workspacePath,
          repoRoot,
          workspaceInRepoPath: normalizeWorkspaceInRepoPath(lines[1] ?? ""),
          autoRefreshWatchPaths: buildAutoRefreshWatchPaths({
            workspacePath,
            absoluteGitDir: lines[2]?.trim() ?? "",
            gitCommonDir: lines[3]?.trim() ?? "",
          }),
          isGitAvailable: true,
          isRepository: true,
        };
      });
    },

    async getWorkspaceRepositoryInfo(workspacePath: string): Promise<GitWorkspaceRepositoryInfo> {
      return await reuseInFlightRequest(
        workspaceRepositoryInfoRequests,
        workspacePath,
        async () => {
          const resolution = await this.resolveRepository(workspacePath);
          if (!resolution.isGitAvailable || !resolution.isRepository) {
            return {
              workspacePath,
              kind: "not-repository",
              isGitAvailable: resolution.isGitAvailable,
            };
          }

          const gitEntryPath = resolve(resolution.repoRoot, ".git");
          try {
            const gitEntryStat = await stat(gitEntryPath);
            if (gitEntryStat.isDirectory()) {
              return {
                workspacePath,
                kind: "main-tree",
                isGitAvailable: true,
              };
            }

            if (gitEntryStat.isFile()) {
              const gitEntryContent = await readFile(gitEntryPath, "utf-8");
              const firstLine = gitEntryContent.replace(/\r\n/g, "\n").split("\n")[0]?.trim() ?? "";
              const gitDirPrefix = "gitdir:";
              if (firstLine.startsWith(gitDirPrefix)) {
                const rawGitDir = firstLine.slice(gitDirPrefix.length).trim();
                const resolvedGitDir = rawGitDir
                  ? isAbsolute(rawGitDir)
                    ? rawGitDir
                    : resolve(resolution.repoRoot, rawGitDir)
                  : "";
                const normalizedGitDir = resolvedGitDir ? resolvedGitDir.replace(/\\/g, "/") : "";

                // Key: a linked worktree's .git file points at <main-tree>/.git/worktrees/<name>;
                // matching that shape classifies as worktree. Any other .git file form
                // (submodule/separate-git-dir) passes as main-tree: this filter is best-effort,
                // prefer under-filtering over dropping valid history.
                if (normalizedGitDir.includes("/.git/worktrees/")) {
                  return {
                    workspacePath,
                    kind: "linked-worktree",
                    isGitAvailable: true,
                  };
                }
              }
            }
          } catch {
            // Worktree detection only filters migration candidates; not a hard precondition.
            // On missing/unreadable/unusual .git, fail open as main-tree
            // so migratable records are not dropped.
          }

          return {
            workspacePath,
            kind: "main-tree",
            isGitAvailable: true,
          };
        },
      );
    },

    async getStatus(workspacePath: string): Promise<GitStatusSnapshot> {
      // staged/unstaged/summary/branch views share one status snapshot;
      // reuse collapses a render's repeated status + diff --numstat into one CLI round.
      return await reuseInFlightRequest(statusRequests, workspacePath, async () => {
        const resolution = await this.resolveRepository(workspacePath);
        if (!resolution.isGitAvailable || !resolution.isRepository) {
          return {
            resolution,
            summary: createEmptySummary(resolution),
            entries: [],
            stagedStats: new Map(),
            unstagedStats: new Map(),
            untrackedStats: new Map(),
          };
        }

        const [statusResult, stagedStatsResult, unstagedStatsResult] = await Promise.all([
          // Keep per-file untracked status by default; dir-collapse only once the repoRoot cap is hit.
          runGitStatus(resolution),
          commandProvider.run({
            cwd: resolution.repoRoot,
            args: ["diff", "--cached", "--numstat", "-z", "--find-renames", "--"],
            timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
            maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
          }),
          commandProvider.run({
            cwd: resolution.repoRoot,
            args: ["diff", "--numstat", "-z", "--find-renames", "--"],
            timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
            maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
          }),
        ]);

        ensureGitCommandSucceeded("git status", statusResult);
        ensureGitCommandSucceeded("git diff --cached --numstat", stagedStatsResult);
        ensureGitCommandSucceeded("git diff --numstat", unstagedStatsResult);

        const parsedStatus = parseStatusPorcelain(statusResult.stdout);
        const untrackedStats = await buildUntrackedStats(resolution.repoRoot, parsedStatus.entries);

        return {
          resolution,
          summary: {
            workspacePath: resolution.workspacePath,
            repoRoot: resolution.repoRoot,
            workspaceInRepoPath: resolution.workspaceInRepoPath,
            autoRefreshWatchPaths: resolution.autoRefreshWatchPaths,
            branchName: parsedStatus.branchName,
            trackingBranchName: parsedStatus.trackingBranchName,
            headRefType: parsedStatus.headRefType,
            ahead: parsedStatus.ahead,
            behind: parsedStatus.behind,
            isDirty: parsedStatus.entries.length > 0,
            isGitAvailable: true,
            isRepository: true,
          },
          entries: parsedStatus.entries,
          stagedStats: parseNumstat(stagedStatsResult.stdout),
          unstagedStats: parseNumstat(unstagedStatsResult.stdout),
          untrackedStats,
        };
      });
    },

    async getIgnoredPaths(workspacePath: string, paths: string[]): Promise<string[]> {
      if (paths.length === 0) {
        return [];
      }

      const resolution = await this.resolveRepository(workspacePath);
      if (!resolution.isGitAvailable || !resolution.isRepository) {
        return [];
      }

      const inputPairs = await Promise.all(
        paths.map(async (path) => {
          try {
            return {
              absolutePath: isAbsolute(path)
                ? path
                : resolve(resolution.workspacePath, path.split("/").join(sep)),
              repoRelativePath: await normalizeInputPath(resolution, path),
            };
          } catch {
            return null;
          }
        }),
      );
      const validInputPairs = inputPairs.filter(
        (pair): pair is { absolutePath: string; repoRelativePath: string } => Boolean(pair),
      );
      if (validInputPairs.length === 0) {
        return [];
      }

      const ignoredResult = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: ["check-ignore", "--", ...validInputPairs.map((pair) => pair.repoRelativePath)],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
      });

      if (ignoredResult.exitCode === 1) {
        return [];
      }

      ensureGitCommandSucceeded("git check-ignore", ignoredResult);

      const ignoredRepoRelativePaths = new Set(
        ignoredResult.stdout
          // Fix: git check-ignore -z requires --stdin; paths go via argv, so parse
          // plain newline output, or the call fails and the tree never learns ignored state.
          .split(/\r?\n/)
          .filter(Boolean)
          .map((path) => path.replace(/\\/g, "/")),
      );

      return validInputPairs
        .filter((pair) => ignoredRepoRelativePaths.has(pair.repoRelativePath))
        .map((pair) => pair.absolutePath);
    },

    async listLocalBranches(workspacePath: string): Promise<GitLocalBranchListResult> {
      const status = await this.getStatus(workspacePath);
      if (!status.resolution.isGitAvailable || !status.resolution.isRepository) {
        return {
          headRefType: status.summary.headRefType,
          currentBranchName: status.summary.branchName,
          branches: [],
        };
      }

      const result = await commandProvider.run({
        cwd: status.resolution.repoRoot,
        args: [
          "for-each-ref",
          "refs/heads",
          "--format=%(refname:short)%00%(upstream:short)%00%(objectname)%00%(committerdate:unix)",
        ],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
      });
      ensureGitCommandSucceeded("git for-each-ref refs/heads", result);

      return {
        headRefType: status.summary.headRefType,
        currentBranchName: status.summary.branchName,
        branches: parseBranchRefRecords(
          result.stdout,
          status.summary.headRefType === "branch" ? status.summary.branchName : null,
        ),
      };
    },

    async getCommitGraph(
      workspacePath: string,
      maxCount?: number,
      skip?: number,
    ): Promise<GitCommitGraphSnapshot> {
      const resolution = await this.resolveRepository(workspacePath);
      if (!resolution.isGitAvailable || !resolution.isRepository) {
        return {
          resolution,
          commits: [],
          hasMore: false,
        };
      }

      const normalizedMaxCount = normalizeGitGraphMaxCount(maxCount);
      const normalizedSkip = normalizeGitGraphSkip(skip);
      const result = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: [
          "log",
          // --all pulls internal hidden refs (refs/zcode/checkpoints) into the graph;
          // limit to HEAD, branches, tags, and remotes for user-visible history only.
          "HEAD",
          "--branches",
          "--tags",
          "--remotes",
          "--date-order",
          "--topo-order",
          `--skip=${normalizedSkip}`,
          `--max-count=${normalizedMaxCount + 1}`,
          "--format=%H%x00%P%x00%an%x00%at%x00%s%x00%D%x1e",
        ],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
      });

      if (result.exitCode !== 0) {
        const stderr = result.stderr.toLowerCase();
        if (
          stderr.includes("does not have any commits yet") ||
          stderr.includes("your current branch") ||
          stderr.includes("bad default revision") ||
          stderr.includes("ambiguous argument 'head'")
        ) {
          return {
            resolution,
            commits: [],
            hasMore: false,
          };
        }

        ensureGitCommandSucceeded("git log visible refs", result);
      }

      const parsedCommits = parseGitGraphRecords(result.stdout);
      return {
        resolution,
        commits: parsedCommits.slice(0, normalizedMaxCount),
        hasMore: parsedCommits.length > normalizedMaxCount,
      };
    },

    async switchBranch(
      workspacePath: string,
      targetBranchName: string,
    ): Promise<GitBranchMutationResult> {
      const status = await this.getStatus(workspacePath);
      const resolution = ensureRepositoryAvailable(status.resolution, "switch branches");
      const normalizedBranchName = targetBranchName.trim();
      if (normalizedBranchName.length === 0) {
        return toBranchMutationFailure({
          action: "switch",
          branchName: null,
          summary: status.summary,
          issues: [toInvalidBranchNameIssue()],
        });
      }

      if (
        status.summary.headRefType === "branch" &&
        status.summary.branchName === normalizedBranchName
      ) {
        return toBranchMutationSuccess({
          action: "switch",
          branchName: normalizedBranchName,
          didChange: false,
          created: false,
          summary: status.summary,
        });
      }

      // Return the known blocked state first instead of one vague raw git error.
      if (status.entries.some((entry) => entry.isConflicted)) {
        return toBranchMutationFailure({
          action: "switch",
          branchName: normalizedBranchName,
          summary: status.summary,
          issues: [
            {
              code: "conflicts-present",
              message: "Repository still has unresolved conflicts.",
            },
          ],
        });
      }

      if (await hasOperationInProgress(resolution)) {
        return toBranchMutationFailure({
          action: "switch",
          branchName: normalizedBranchName,
          summary: status.summary,
          issues: [
            {
              code: "operation-in-progress",
              message: "Another Git operation is still in progress.",
            },
          ],
        });
      }

      const invalidBranchIssue = await validateBranchName(resolution, normalizedBranchName);
      if (invalidBranchIssue) {
        return toBranchMutationFailure({
          action: "switch",
          branchName: normalizedBranchName,
          summary: status.summary,
          issues: [invalidBranchIssue],
        });
      }

      const result = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: ["switch", "--no-guess", normalizedBranchName],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
      });
      if (result.exitCode !== 0) {
        return toBranchMutationFailure({
          action: "switch",
          branchName: normalizedBranchName,
          summary: status.summary,
          issues: parseGitBranchMutationIssues(result),
        });
      }

      invalidate(workspacePath);
      const nextStatus = await this.getStatus(workspacePath);
      return toBranchMutationSuccess({
        action: "switch",
        branchName: normalizedBranchName,
        didChange: true,
        created: false,
        summary: nextStatus.summary,
      });
    },

    async createBranchAndSwitch(
      workspacePath: string,
      branchName: string,
      startPoint?: string,
    ): Promise<GitBranchMutationResult> {
      const status = await this.getStatus(workspacePath);
      const resolution = ensureRepositoryAvailable(status.resolution, "create and switch branches");
      const normalizedBranchName = branchName.trim();
      if (normalizedBranchName.length === 0) {
        return toBranchMutationFailure({
          action: "create-and-switch",
          branchName: null,
          summary: status.summary,
          issues: [toInvalidBranchNameIssue()],
        });
      }

      if (status.entries.some((entry) => entry.isConflicted)) {
        return toBranchMutationFailure({
          action: "create-and-switch",
          branchName: normalizedBranchName,
          summary: status.summary,
          issues: [
            {
              code: "conflicts-present",
              message: "Repository still has unresolved conflicts.",
            },
          ],
        });
      }

      if (await hasOperationInProgress(resolution)) {
        return toBranchMutationFailure({
          action: "create-and-switch",
          branchName: normalizedBranchName,
          summary: status.summary,
          issues: [
            {
              code: "operation-in-progress",
              message: "Another Git operation is still in progress.",
            },
          ],
        });
      }

      const invalidBranchIssue = await validateBranchName(resolution, normalizedBranchName);
      if (invalidBranchIssue) {
        return toBranchMutationFailure({
          action: "create-and-switch",
          branchName: normalizedBranchName,
          summary: status.summary,
          issues: [invalidBranchIssue],
        });
      }

      const normalizedStartPoint = startPoint?.trim();
      // startPoint can be external input; a value with a leading '-'
      // would be parsed as another switch option, not a start reference.
      // Insert an explicit -- so the value is always positional.
      const result = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: normalizedStartPoint
          ? ["switch", "--no-guess", "-c", normalizedBranchName, "--", normalizedStartPoint]
          : ["switch", "--no-guess", "-c", normalizedBranchName],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
      });
      if (result.exitCode !== 0) {
        return toBranchMutationFailure({
          action: "create-and-switch",
          branchName: normalizedBranchName,
          summary: status.summary,
          issues: parseGitBranchMutationIssues(result),
        });
      }

      invalidate(workspacePath);
      const nextStatus = await this.getStatus(workspacePath);
      return toBranchMutationSuccess({
        action: "create-and-switch",
        branchName: normalizedBranchName,
        didChange: true,
        created: true,
        summary: nextStatus.summary,
      });
    },

    async getDiff(params: GitDiffQuery): Promise<GitDiffResult> {
      const resolution = await this.resolveRepository(params.workspacePath);
      const absolutePath = isAbsolute(params.path)
        ? params.path
        : resolve(params.workspacePath, params.path.split("/").join(sep));
      if (!resolution.isGitAvailable) {
        return toUnavailableDiff(
          absolutePath,
          "Git binary is not available in the current environment.",
        );
      }

      if (!resolution.isRepository) {
        return toUnavailableDiff(absolutePath, "Workspace is not inside a Git repository.");
      }

      const repoRelativePath = await normalizeInputPath(resolution, params.path);
      if (params.sourceId === "branch") {
        const status = await this.getStatus(params.workspacePath);
        const trackingBranchName = status.summary.trackingBranchName;
        if (!trackingBranchName) {
          return toUnavailableDiff(
            absolutePath,
            "Current branch does not have an upstream branch.",
          );
        }

        const branchDiffResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: [
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--binary",
            "--find-renames",
            `${trackingBranchName}...HEAD`,
            "--",
            repoRelativePath,
          ],
          timeoutMs: DEFAULT_GIT_DIFF_TIMEOUT_MS,
          maxOutputBytes: DEFAULT_GIT_DIFF_BYTES,
        });
        const parsedBranchDiff = toDiffResult(absolutePath, branchDiffResult, {
          emptySummary: "No branch comparison diff is available for this file.",
        });
        return withDiffContents(
          parsedBranchDiff,
          await readBranchDiffContents({
            commandProvider,
            repoRoot: resolution.repoRoot,
            repoRelativePath,
            trackingBranchName,
          }),
        );
      }

      const staged = params.staged ?? params.sourceId === "staged";
      const diffResult = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: staged
          ? ["diff", "--cached", "--no-ext-diff", "--no-color", "--binary", "--", repoRelativePath]
          : ["diff", "--no-ext-diff", "--no-color", "--binary", "--", repoRelativePath],
        timeoutMs: DEFAULT_GIT_DIFF_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_GIT_DIFF_BYTES,
      });
      const parsedDiff = toDiffResult(absolutePath, diffResult, {
        emptySummary: "No Git diff is available for this file.",
      });
      if (parsedDiff.availability !== "unavailable" || staged) {
        const contents = staged
          ? await readStagedDiffContents({
              commandProvider,
              repoRoot: resolution.repoRoot,
              repoRelativePath,
            })
          : await readUnstagedDiffContents({
              absolutePath,
              commandProvider,
              repoRoot: resolution.repoRoot,
              repoRelativePath,
            });
        return withDiffContents(parsedDiff, contents);
      }

      // Untracked files never appear in git diff, so build a stable single-file patch first;
      // fall back to --no-index only when text preview fails, keeping binaries working.
      if (!(await fileExists(absolutePath))) {
        return parsedDiff;
      }

      const normalizedUntrackedDiff = await buildUntrackedTextDiffResult(
        absolutePath,
        repoRelativePath,
        DEFAULT_GIT_DIFF_BYTES,
      );
      if (normalizedUntrackedDiff) {
        return normalizedUntrackedDiff;
      }

      const noIndexDiffResult = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: [
          "diff",
          "--no-index",
          "--no-ext-diff",
          "--no-color",
          "--binary",
          getGitNullDevicePath(),
          absolutePath,
        ],
        timeoutMs: DEFAULT_GIT_DIFF_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_GIT_DIFF_BYTES,
      });
      return toDiffResult(absolutePath, noIndexDiffResult, {
        allowedExitCodes: [0, 1],
        emptySummary: "No previewable diff is available for this file.",
      });
    },

    async getBranchComparison(workspacePath: string): Promise<GitBranchComparisonSnapshot> {
      const status = await this.getStatus(workspacePath);
      if (
        !status.resolution.isGitAvailable ||
        !status.resolution.isRepository ||
        !status.summary.trackingBranchName
      ) {
        return {
          resolution: status.resolution,
          baseRef: status.summary.trackingBranchName,
          headRef: status.summary.branchName ?? "HEAD",
          comparisonLabel: null,
          changes: [],
        };
      }

      const result = await commandProvider.run({
        cwd: status.resolution.repoRoot,
        args: [
          "diff",
          "--numstat",
          "-z",
          "--find-renames",
          `${status.summary.trackingBranchName}...HEAD`,
          "--",
        ],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
      });
      ensureGitCommandSucceeded("git diff --numstat upstream...HEAD", result);

      const changes = Array.from(parseNumstat(result.stdout).entries()).map(
        ([path, stat]): GitBranchComparisonChange => ({
          path,
          originalPath: stat.originalPath ?? null,
          kind: inferKindFromNumstat(stat),
          added: stat.added,
          removed: stat.removed,
        }),
      );

      return {
        resolution: status.resolution,
        baseRef: status.summary.trackingBranchName,
        headRef: status.summary.branchName ?? "HEAD",
        comparisonLabel: status.summary.branchName
          ? `${status.summary.branchName} -> ${status.summary.trackingBranchName}`
          : `HEAD -> ${status.summary.trackingBranchName}`,
        changes,
      };
    },

    async stage(workspacePath: string, paths: string[]): Promise<void> {
      const resolution = ensureRepositoryAvailable(
        await this.resolveRepository(workspacePath),
        "stage paths",
      );
      const repoPaths = Array.from(
        new Set(await Promise.all(paths.map((path) => normalizeInputPath(resolution, path)))),
      );
      if (repoPaths.length === 0) {
        return;
      }

      const result = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: ["add", "--", ...repoPaths],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      });
      ensureGitCommandSucceeded("git add", result);
      invalidate(workspacePath);
    },

    async unstage(workspacePath: string, paths: string[]): Promise<void> {
      const resolution = ensureRepositoryAvailable(
        await this.resolveRepository(workspacePath),
        "unstage paths",
      );
      const repoPaths = Array.from(
        new Set(await Promise.all(paths.map((path) => normalizeInputPath(resolution, path)))),
      );
      if (repoPaths.length === 0) {
        return;
      }

      const result = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: ["restore", "--staged", "--", ...repoPaths],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      });
      ensureGitCommandSucceeded("git restore --staged", result);
      invalidate(workspacePath);
    },

    async discard(workspacePath: string, paths: string[], staged: boolean): Promise<void> {
      const resolution = ensureRepositoryAvailable(
        await this.resolveRepository(workspacePath),
        "discard paths",
      );
      const repoPaths = Array.from(
        new Set(await Promise.all(paths.map((path) => normalizeInputPath(resolution, path)))),
      );
      if (repoPaths.length === 0) {
        return;
      }

      const result = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: staged
          ? ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...repoPaths]
          : ["restore", "--worktree", "--", ...repoPaths],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      });
      ensureGitCommandSucceeded("git restore", result);
      invalidate(workspacePath);
    },

    async commit(
      workspacePath: string,
      message: string,
      paths?: string[],
      options?: { stagedOnly?: boolean },
    ): Promise<{ commitHash: string }> {
      const resolution = ensureRepositoryAvailable(
        await this.resolveRepository(workspacePath),
        "commit changes",
      );
      const trimmedMessage = message.trim();
      if (trimmedMessage.length === 0) {
        throw new Error("Commit message cannot be empty");
      }
      const repoPaths =
        paths && paths.length > 0
          ? Array.from(
              new Set(await Promise.all(paths.map((path) => normalizeInputPath(resolution, path)))),
            )
          : [];

      if (options?.stagedOnly && repoPaths.length > 0) {
        const scopedStatusResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["status", "--porcelain=v2", "-z", "--", ...repoPaths],
          timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
          maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
        });
        ensureGitCommandSucceeded("git status selected paths", scopedStatusResult);

        const cleanupRepoPaths = Array.from(
          new Set([
            ...repoPaths,
            ...parseStatusPorcelain(scopedStatusResult.stdout)
              .entries.filter((entry) => repoPaths.includes(entry.path))
              .map((entry) => entry.originalPath)
              .filter((path): path is string => Boolean(path)),
          ]),
        );
        const stagedEntriesResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["ls-files", "--stage", "-z", "--", ...repoPaths],
          timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
          maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
        });
        ensureGitCommandSucceeded("git ls-files selected staged entries", stagedEntriesResult);
        const stagedEntries = parseGitIndexEntries(stagedEntriesResult.stdout);
        if (stagedEntries.some((entry) => entry.stage !== "0")) {
          throw new Error("Cannot commit selected staged paths while index conflicts exist.");
        }

        const headResult = await commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["rev-parse", "--verify", "HEAD"],
          timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        });
        const parentHash = headResult.exitCode === 0 ? headResult.stdout.trim() : null;
        const tempIndexDir = await mkdtemp(join(tmpdir(), "zcode-git-index-"));
        const tempIndexPath = join(tempIndexDir, "index");
        const tempIndexEnv = { GIT_INDEX_FILE: tempIndexPath };

        try {
          const readTreeResult = await commandProvider.run({
            cwd: resolution.repoRoot,
            args: parentHash ? ["read-tree", parentHash] : ["read-tree", "--empty"],
            env: tempIndexEnv,
            timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
          });
          ensureGitCommandSucceeded("git read-tree selected commit base", readTreeResult);

          if (cleanupRepoPaths.length > 0) {
            const removeResult = await commandProvider.run({
              cwd: resolution.repoRoot,
              args: ["update-index", "--force-remove", "--", ...cleanupRepoPaths],
              env: tempIndexEnv,
              timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
            });
            ensureGitCommandSucceeded("git update-index remove selected paths", removeResult);
          }

          for (const entry of stagedEntries) {
            const addResult = await commandProvider.run({
              cwd: resolution.repoRoot,
              args: [
                "update-index",
                "--add",
                "--cacheinfo",
                entry.mode,
                entry.objectHash,
                entry.path,
              ],
              env: tempIndexEnv,
              timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
            });
            ensureGitCommandSucceeded("git update-index add selected paths", addResult);
          }

          const scopedCommitResult = await commandProvider.run({
            cwd: resolution.repoRoot,
            args: ["commit", "-m", trimmedMessage],
            env: tempIndexEnv,
            timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
            maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
          });
          ensureGitCommandSucceeded("git commit selected staged paths", scopedCommitResult);

          const hashResult = await commandProvider.run({
            cwd: resolution.repoRoot,
            args: ["rev-parse", "HEAD"],
            timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
          });
          ensureGitCommandSucceeded("git rev-parse selected commit HEAD", hashResult);
          const commitHash = hashResult.stdout.trim();

          // Committing session files must not replace the real index with the temp one:
          // sync only the committed paths onto the new HEAD; other staged files wait for the user.
          const resetSelectedResult = await commandProvider.run({
            cwd: resolution.repoRoot,
            args: ["reset", "--quiet", "HEAD", "--", ...cleanupRepoPaths],
            timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
          });
          ensureGitCommandSucceeded("git reset selected committed paths", resetSelectedResult);
          invalidate(workspacePath);
          return { commitHash };
        } finally {
          await rm(tempIndexDir, { recursive: true, force: true });
        }
      }

      const commitResult = await commandProvider.run({
        cwd: resolution.repoRoot,
        args:
          repoPaths.length > 0
            ? ["commit", "-m", trimmedMessage, "--", ...repoPaths]
            : ["commit", "-m", trimmedMessage],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
      });
      ensureGitCommandSucceeded("git commit", commitResult);
      invalidate(workspacePath);

      const hashResult = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: ["rev-parse", "HEAD"],
        timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
      });
      ensureGitCommandSucceeded("git rev-parse HEAD", hashResult);
      return { commitHash: hashResult.stdout.trim() };
    },

    async push(workspacePath: string): Promise<GitPushResult> {
      const status = await this.getStatus(workspacePath);
      const resolution = ensureRepositoryAvailable(status.resolution, "push changes");
      const branchName = status.summary.branchName?.trim() ?? "";
      if (status.summary.headRefType !== "branch" || branchName.length === 0) {
        throw new Error("Cannot push while HEAD is detached.");
      }

      const hasTrackingBranch = Boolean(status.summary.trackingBranchName);
      const remoteName = hasTrackingBranch
        ? parseTrackingRemoteName(status.summary.trackingBranchName)
        : await resolvePushRemote(status);
      const pushResult = await commandProvider.run({
        cwd: resolution.repoRoot,
        args: hasTrackingBranch
          ? ["push"]
          : ["push", "--set-upstream", remoteName ?? "origin", branchName],
        // Push is an explicit user action and can run long behind pre-push hooks;
        // use the longer push timeout so a still-running hook is not flagged as failure.
        timeoutMs: DEFAULT_GIT_PUSH_TIMEOUT_MS,
        // A pre-push hook may print entire test logs;
        // raise the output cap for push alone so hook output cannot truncate the run.
        maxOutputBytes: DEFAULT_GIT_PUSH_OUTPUT_BYTES,
      });
      ensureGitCommandSucceeded("git push", pushResult);
      invalidate(workspacePath);

      const nextStatus = await this.getStatus(workspacePath);
      return {
        branchName,
        trackingBranchName: nextStatus.summary.trackingBranchName,
        remoteName: remoteName ?? parseTrackingRemoteName(nextStatus.summary.trackingBranchName),
        setUpstream: !hasTrackingBranch,
        summary: nextStatus.summary,
      };
    },

    async getIdentity(workspacePath: string): Promise<GitIdentity> {
      const resolution = await this.resolveRepository(workspacePath);
      if (!resolution.isGitAvailable || !resolution.isRepository) {
        return {
          userName: null,
          userEmail: null,
          nameSource: null,
          emailSource: null,
          scopeLabel: null,
        };
      }

      const [nameResult, emailResult] = await Promise.all([
        commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["config", "--show-scope", "--show-origin", "--get", "user.name"],
          timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        }),
        commandProvider.run({
          cwd: resolution.repoRoot,
          args: ["config", "--show-scope", "--show-origin", "--get", "user.email"],
          timeoutMs: DEFAULT_GIT_COMMAND_TIMEOUT_MS,
        }),
      ]);

      const name = parseGitConfigValue(nameResult);
      const email = parseGitConfigValue(emailResult);
      return {
        userName: name.value,
        userEmail: email.value,
        nameSource: name.source,
        emailSource: email.source,
        scopeLabel: name.scope ?? email.scope ?? null,
      };
    },
  };
}
