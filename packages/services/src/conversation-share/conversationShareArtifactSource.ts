import { open, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, win32 } from "node:path";

import type { IFileService } from "#src/file/file.js";

import { ConversationShareServiceError } from "./conversationShare.js";

export interface ConversationShareArtifactReadInput {
  workspacePath: string;
  ref: string;
  maxBytes: number;
}

export interface ConversationShareMaterializedArtifact {
  bytes: Uint8Array;
  canonicalPath: string;
}

export interface ConversationShareArtifactStat {
  canonicalPath: string;
  size: number;
  mtimeMs?: number;
}

export interface ConversationShareArtifactSource {
  read(input: ConversationShareArtifactReadInput): Promise<ConversationShareMaterializedArtifact>;
  stat?(
    input: Omit<ConversationShareArtifactReadInput, "maxBytes">,
  ): Promise<ConversationShareArtifactStat>;
}

const REMOTE_READ_CHUNK_BYTES = 512 * 1024;
const SKIPPABLE_ARTIFACT_READ_ERRNOS = new Set(["ENOENT", "ENOTDIR", "EISDIR"]);

function isSkippableArtifactReadError(error: unknown): boolean {
  const errno = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof errno === "string" && SKIPPABLE_ARTIFACT_READ_ERRNOS.has(errno);
}

/**
 * Fallback read failures always carry artifact_read_failed plus the underlying errno, letting
 * callers downgrade missing-referenced-file to a non-blocking skip instead of killing the
 * publish. errno goes through allow-listed diagnostics; paths never enter error payloads.
 */
function unreadableArtifactError(message: string, cause: unknown): ConversationShareServiceError {
  const errno = (cause as NodeJS.ErrnoException | undefined)?.code;
  return new ConversationShareServiceError("invalid_conversation", message, {
    reasonCode: "artifact_read_failed",
    cause,
    ...(typeof errno === "string" ? { diagnostics: { errno } } : {}),
  });
}

function remotePathApi(path: string): typeof posix | typeof win32 {
  return /^[A-Za-z]:[\\/]/u.test(path) || path.startsWith("\\\\") ? win32 : posix;
}

function isRemoteInsideWorkspace(workspacePath: string, targetPath: string): boolean {
  const pathApi = remotePathApi(workspacePath);
  const relativePath = pathApi.relative(workspacePath, targetPath);
  return (
    relativePath === "" || (!relativePath.startsWith("..") && !pathApi.isAbsolute(relativePath))
  );
}

/**
 * SSH/WSL/Docker resolve realpath/stat/range reads via the remote fileService; JWT and HTTP upload stay on the Desktop Host.
 */
export function createRemoteConversationShareArtifactSource(
  fileService: Pick<IFileService, "readFileRange" | "resolvePath" | "stat">,
): ConversationShareArtifactSource {
  return {
    async stat(input) {
      if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(input.ref)) {
        throw new ConversationShareServiceError(
          "unsafe_structure",
          "Conversation artifact source must be a workspace path",
        );
      }
      try {
        const pathApi = remotePathApi(input.workspacePath);
        const workspaceRealPath = await fileService.resolvePath({ path: input.workspacePath });
        const requestedPath = pathApi.isAbsolute(input.ref)
          ? input.ref
          : pathApi.resolve(input.workspacePath, input.ref);
        const artifactRealPath = await fileService.resolvePath({ path: requestedPath });
        if (!isRemoteInsideWorkspace(workspaceRealPath, artifactRealPath)) {
          throw new ConversationShareServiceError(
            "unsafe_structure",
            "Conversation artifact is outside the workspace",
          );
        }
        const artifactStat = await fileService.stat({ path: artifactRealPath });
        if (artifactStat.type !== "file" || artifactStat.size === undefined) {
          throw unreadableArtifactError("Conversation artifact source is not a readable file", {
            code: "ENOTDIR",
          });
        }
        return {
          canonicalPath: artifactRealPath,
          size: artifactStat.size,
          ...(artifactStat.mtimeMs === undefined ? {} : { mtimeMs: artifactStat.mtimeMs }),
        };
      } catch (error) {
        if (error instanceof ConversationShareServiceError) throw error;
        if (!isSkippableArtifactReadError(error)) throw error;
        throw unreadableArtifactError(
          "Conversation artifact cannot be read from the remote workspace",
          error,
        );
      }
    },
    async read(input) {
      if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
        throw new ConversationShareServiceError(
          "invalid_contract",
          "Conversation artifact byte limit is invalid",
        );
      }
      if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(input.ref)) {
        throw new ConversationShareServiceError(
          "unsafe_structure",
          "Conversation artifact source must be a workspace path",
        );
      }

      try {
        const pathApi = remotePathApi(input.workspacePath);
        const workspaceRealPath = await fileService.resolvePath({ path: input.workspacePath });
        const requestedPath = pathApi.isAbsolute(input.ref)
          ? input.ref
          : pathApi.resolve(input.workspacePath, input.ref);
        const artifactRealPath = await fileService.resolvePath({ path: requestedPath });
        if (!isRemoteInsideWorkspace(workspaceRealPath, artifactRealPath)) {
          throw new ConversationShareServiceError(
            "unsafe_structure",
            "Conversation artifact is outside the workspace",
          );
        }

        const before = await fileService.stat({ path: artifactRealPath });
        if (before.type !== "file" || before.size === undefined) {
          throw new ConversationShareServiceError(
            "invalid_conversation",
            "Conversation artifact source is not a readable file",
          );
        }
        if (before.size > input.maxBytes) {
          throw new ConversationShareServiceError(
            "limit_exceeded",
            "Conversation artifact exceeds the byte limit",
          );
        }

        const bytes = new Uint8Array(before.size);
        let offset = 0;
        while (offset < before.size) {
          const chunk = await fileService.readFileRange({
            path: artifactRealPath,
            offset,
            length: Math.min(REMOTE_READ_CHUNK_BYTES, before.size - offset),
          });
          if (chunk.byteLength === 0) {
            throw new ConversationShareServiceError(
              "invalid_conversation",
              "Conversation artifact ended during remote staging",
            );
          }
          if (offset + chunk.byteLength > before.size) {
            throw new ConversationShareServiceError(
              "invalid_conversation",
              "Conversation artifact changed during remote staging",
            );
          }
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }

        const after = await fileService.stat({ path: artifactRealPath });
        if (
          after.type !== "file" ||
          after.size !== before.size ||
          (before.mtimeMs !== undefined && after.mtimeMs !== before.mtimeMs)
        ) {
          throw new ConversationShareServiceError(
            "invalid_conversation",
            "Conversation artifact changed during remote staging",
          );
        }
        return { bytes, canonicalPath: artifactRealPath };
      } catch (error) {
        if (error instanceof ConversationShareServiceError) throw error;
        // Only explicit not-a-file/missing-path errors may downgrade to discovery warnings; remote
        // disconnects and permission errors keep throwing, or a publish succeeds while silently
        // losing artifacts.
        if (!isSkippableArtifactReadError(error)) throw error;
        throw unreadableArtifactError(
          "Conversation artifact cannot be read from the remote workspace",
          error,
        );
      }
    },
  };
}

function isInsideWorkspace(workspacePath: string, targetPath: string): boolean {
  const relativePath = relative(workspacePath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function createLocalConversationShareArtifactSource(): ConversationShareArtifactSource {
  return {
    async stat(input) {
      if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(input.ref)) {
        throw new ConversationShareServiceError(
          "unsafe_structure",
          "Conversation artifact source must be a local workspace path",
        );
      }
      try {
        const workspaceRealPath = await realpath(input.workspacePath);
        const requestedPath = isAbsolute(input.ref)
          ? input.ref
          : resolve(input.workspacePath, input.ref);
        const artifactRealPath = await realpath(requestedPath);
        if (!isInsideWorkspace(workspaceRealPath, artifactRealPath)) {
          throw new ConversationShareServiceError(
            "unsafe_structure",
            "Conversation artifact is outside the workspace",
          );
        }
        const handle = await open(artifactRealPath, "r");
        try {
          const artifactStat = await handle.stat();
          if (!artifactStat.isFile()) {
            throw unreadableArtifactError("Conversation artifact source is not a file", {
              code: "ENOTDIR",
            });
          }
          return {
            canonicalPath: artifactRealPath,
            size: artifactStat.size,
            mtimeMs: artifactStat.mtimeMs,
          };
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (error instanceof ConversationShareServiceError) throw error;
        if (!isSkippableArtifactReadError(error)) throw error;
        throw unreadableArtifactError("Conversation artifact cannot be read", error);
      }
    },
    async read(input) {
      if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
        throw new ConversationShareServiceError(
          "invalid_contract",
          "Conversation artifact byte limit is invalid",
        );
      }
      if (/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//u.test(input.ref)) {
        throw new ConversationShareServiceError(
          "unsafe_structure",
          "Conversation artifact source must be a local workspace path",
        );
      }

      try {
        const workspaceRealPath = await realpath(input.workspacePath);
        const requestedPath = isAbsolute(input.ref)
          ? input.ref
          : resolve(input.workspacePath, input.ref);
        const artifactRealPath = await realpath(requestedPath);
        // An artifact Row's ref comes from session data and is not trusted just because only local
        // publishing exists; re-validate the workspace boundary after following symlinks so shares
        // cannot read arbitrary local files.
        if (!isInsideWorkspace(workspaceRealPath, artifactRealPath)) {
          throw new ConversationShareServiceError(
            "unsafe_structure",
            "Conversation artifact is outside the workspace",
          );
        }
        const handle = await open(artifactRealPath, "r");
        try {
          const artifactStat = await handle.stat();
          if (!artifactStat.isFile()) {
            throw new ConversationShareServiceError(
              "invalid_conversation",
              "Conversation artifact source is not a file",
            );
          }
          if (artifactStat.size > input.maxBytes) {
            throw new ConversationShareServiceError(
              "limit_exceeded",
              "Conversation artifact exceeds the byte limit",
            );
          }
          // The backend cap can far exceed this file; allocating maxBytes wastes memory on small
          // files. Read stat size + 1 byte, still enough to detect growth between stat and read.
          const buffer = Buffer.allocUnsafe(artifactStat.size + 1);
          let bytesRead = 0;
          while (bytesRead < buffer.byteLength) {
            const result = await handle.read(
              buffer,
              bytesRead,
              buffer.byteLength - bytesRead,
              bytesRead,
            );
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
          }
          if (bytesRead > input.maxBytes) {
            throw new ConversationShareServiceError(
              "limit_exceeded",
              "Conversation artifact exceeds the byte limit",
            );
          }
          return {
            bytes: new Uint8Array(buffer.subarray(0, bytesRead)),
            canonicalPath: artifactRealPath,
          };
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (error instanceof ConversationShareServiceError) throw error;
        // Only explicit missing-path/not-a-file errors may downgrade to discovery warnings;
        // permission and other IO errors must block the publish, never pose as skippable absence.
        if (!isSkippableArtifactReadError(error)) throw error;
        throw unreadableArtifactError("Conversation artifact cannot be read", error);
      }
    },
  };
}
