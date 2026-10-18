import { copyFile, mkdir, readdir, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, normalize, resolve, sep } from "node:path";
import type { ZCodeImportableSessionCandidate } from "@zcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { getAppConfigDir, getDataBaseDir, getWorkspaceHash } from "#src/paths.js";
import {
  extractClaudeNativeSessionHeadInfo,
  hasClaudeNativeSidechainMarker,
} from "#src/session/claude-native/claudeNativeSessionHeadParser.js";
import { readJsonLinesFileHead } from "#src/session/claude-native/sessionHistoryJsonl.js";

const logger = createServiceLogger("claude-native-import");
const CLAUDE_NATIVE_IGNORED_TRANSCRIPT_DIR_NAMES = new Set(["subagents", "worktree", "worktrees"]);

function normalizePathForComparison(path: string): string {
  const normalized = normalize(resolve(path));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isClaudeWorktreeWorkspacePath(path: string): boolean {
  const normalizedSegments = normalize(resolve(path))
    .replaceAll("\\", "/")
    .split("/")
    .map((segment) => segment.toLowerCase());

  return normalizedSegments.some(
    (segment, index) =>
      segment === ".claude" &&
      (normalizedSegments[index + 1] === "worktree" ||
        normalizedSegments[index + 1] === "worktrees"),
  );
}

function shouldIgnoreClaudeNativeTranscriptDir(name: string): boolean {
  return CLAUDE_NATIVE_IGNORED_TRANSCRIPT_DIR_NAMES.has(name.toLowerCase());
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export class ClaudeNativeSessionImportRepo {
  private getNativeProjectsRoots(): string[] {
    const homes = new Set<string>();
    homes.add(homedir());

    const envHome = process.env.HOME?.trim();
    if (envHome) {
      homes.add(envHome);
    }

    const dataBaseDir = getDataBaseDir();
    if (dataBaseDir) {
      homes.add(dataBaseDir);
    }

    // Critical: scan the Claude Code native history dir ~/.claude/projects, not zcode's own data dir.
    // When ZCODE_DATA_BASE_DIR moves .zcode elsewhere, native .claude usually stays under the real user HOME.
    return [...homes].map((homePath) => join(homePath, ".claude", "projects"));
  }

  private async findSessionFile(rootDir: string, sessionId: string): Promise<string | null> {
    try {
      const entries = await readdir(rootDir, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = join(rootDir, entry.name);
        if (entry.isDirectory()) {
          if (shouldIgnoreClaudeNativeTranscriptDir(entry.name)) {
            continue;
          }
          const nestedMatch = await this.findSessionFile(entryPath, sessionId);
          if (nestedMatch) {
            return nestedMatch;
          }
          continue;
        }
        if (entry.isFile() && entry.name === `${sessionId}.jsonl`) {
          return entryPath;
        }
      }
    } catch {
      return null;
    }

    return null;
  }

  private async collectJsonlFiles(rootDir: string): Promise<string[]> {
    try {
      const entries = await readdir(rootDir, { withFileTypes: true });
      const files: string[] = [];

      for (const entry of entries) {
        const entryPath = join(rootDir, entry.name);
        if (entry.isDirectory()) {
          if (shouldIgnoreClaudeNativeTranscriptDir(entry.name)) {
            continue;
          }
          files.push(...(await this.collectJsonlFiles(entryPath)));
          continue;
        }
        if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          files.push(entryPath);
        }
      }

      return files;
    } catch {
      return [];
    }
  }

  private getRelativeProjectsPath(sourcePath: string): string {
    const marker = `${sep}projects${sep}`;
    const markerIndex = sourcePath.lastIndexOf(marker);
    if (markerIndex < 0) {
      throw new Error(`[claude-native] Invalid Claude native session path: ${sourcePath}`);
    }
    return sourcePath.slice(markerIndex + marker.length);
  }

  async scanImportableSessions(params: {
    workspacePath?: string;
    modifiedSince?: number;
    limit?: number;
  }): Promise<ZCodeImportableSessionCandidate[]> {
    const workspaceKey = params.workspacePath
      ? normalizePathForComparison(params.workspacePath)
      : null;
    const sessionFiles = [
      ...new Set(
        (
          await Promise.all(
            this.getNativeProjectsRoots().map((rootDir) => this.collectJsonlFiles(rootDir)),
          )
        ).flat(),
      ),
    ];
    const candidates: ZCodeImportableSessionCandidate[] = [];

    for (const filePath of sessionFiles) {
      let fileStat;
      try {
        fileStat = await stat(filePath);
      } catch {
        continue;
      }

      const updatedAt = Math.trunc(fileStat.mtimeMs);
      if (params.modifiedSince && updatedAt < params.modifiedSince) {
        continue;
      }

      try {
        const headRecords = await readJsonLinesFileHead(filePath, 16);
        if (hasClaudeNativeSidechainMarker(headRecords)) {
          continue;
        }
        const headInfo = extractClaudeNativeSessionHeadInfo(headRecords);
        if (!headInfo.workspacePath) {
          continue;
        }
        // Claude puts temp worktrees under ~/.claude/worktrees.
        // Onboarding import shows real user workspaces only, never those short-lived worktrees.
        if (isClaudeWorktreeWorkspacePath(headInfo.workspacePath)) {
          continue;
        }
        if (
          workspaceKey !== null &&
          normalizePathForComparison(headInfo.workspacePath) !== workspaceKey
        ) {
          continue;
        }

        candidates.push({
          provider: "claude",
          sessionId: basename(filePath, ".jsonl"),
          workspacePath: headInfo.workspacePath,
          sourcePath: filePath,
          updatedAt,
          ...(headInfo.createdAt ? { createdAt: headInfo.createdAt } : {}),
          ...(headInfo.previewTitle ? { previewTitle: headInfo.previewTitle } : {}),
        });
      } catch (error) {
        logger.warn(undefined, `Failed to scan Claude native session path=${filePath}`, error);
      }
    }

    candidates.sort((left, right) => right.updatedAt - left.updatedAt);
    const limited =
      typeof params.limit === "number" && params.limit > 0
        ? candidates.slice(0, params.limit)
        : candidates;

    logger.info(
      undefined,
      `Claude native session scan done workspaceFilter=${params.workspacePath ?? "all"} fileCount=${sessionFiles.length} candidateCount=${limited.length}`,
    );

    return limited;
  }

  async findImportableSession(params: {
    workspacePath?: string;
    sessionId: string;
  }): Promise<ZCodeImportableSessionCandidate | null> {
    const workspaceKey = params.workspacePath
      ? normalizePathForComparison(params.workspacePath)
      : null;

    for (const nativeProjectsRoot of this.getNativeProjectsRoots()) {
      const filePath = await this.findSessionFile(nativeProjectsRoot, params.sessionId);
      if (!filePath) {
        continue;
      }

      try {
        const fileStat = await stat(filePath);
        const headRecords = await readJsonLinesFileHead(filePath, 16);
        if (hasClaudeNativeSidechainMarker(headRecords)) {
          return null;
        }
        const headInfo = extractClaudeNativeSessionHeadInfo(headRecords);
        if (!headInfo.workspacePath) {
          continue;
        }
        // Direct import by sessionId reuses the scan boundaries, so filtered-out temp worktrees stay unimportable.
        if (isClaudeWorktreeWorkspacePath(headInfo.workspacePath)) {
          return null;
        }
        if (
          workspaceKey !== null &&
          normalizePathForComparison(headInfo.workspacePath) !== workspaceKey
        ) {
          continue;
        }

        return {
          provider: "claude",
          sessionId: params.sessionId,
          workspacePath: headInfo.workspacePath,
          sourcePath: filePath,
          updatedAt: Math.trunc(fileStat.mtimeMs),
          ...(headInfo.createdAt ? { createdAt: headInfo.createdAt } : {}),
          ...(headInfo.previewTitle ? { previewTitle: headInfo.previewTitle } : {}),
        };
      } catch (error) {
        logger.warn(
          undefined,
          `Failed to locate Claude native session sessionId=${params.sessionId}`,
          error,
        );
      }
    }

    return null;
  }

  async copySessionFileToWorkspace(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    sourcePath: string;
  }): Promise<{ outputPath: string; createdOutputPaths: string[] }> {
    // Import copies keep the historical dir layout ~/.zcode/v2/agent-config/claude/{workspaceHash}/projects;
    // that is the Claude-history import location, unrelated to the agent runtime provider (glm).
    const relativeProjectsPath = this.getRelativeProjectsPath(params.sourcePath);
    const outputPath = join(
      getAppConfigDir(),
      "agent-config",
      "claude",
      getWorkspaceHash(params.workspacePath, params.workspaceIdentity),
      "projects",
      relativeProjectsPath,
    );
    const outputDir = dirname(outputPath);
    const existedBefore = await pathExists(outputPath);
    const tempPath = `${outputPath}.${process.pid}.${Date.now().toString(36)}.${Math.random()
      .toString(36)
      .slice(2, 8)}.tmp`;

    await mkdir(outputDir, { recursive: true });
    await copyFile(params.sourcePath, tempPath);
    await rename(tempPath, outputPath);

    return {
      outputPath,
      createdOutputPaths: existedBefore ? [] : [outputPath],
    };
  }
}

export const claudeNativeSessionImportRepo = new ClaudeNativeSessionImportRepo();
