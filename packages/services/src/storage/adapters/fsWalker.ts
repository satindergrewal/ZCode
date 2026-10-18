/**
 * Data-root walker: async, bounded concurrency, cancellable, no symlink following.
 * Yields (relativePath, bytes, mtimeMs); classification/aggregation happen in domain at the caller.
 * Yields the event loop every yieldEvery entries, never monopolizing Worker/host.
 */
import { lstat, opendir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { StorageScanEntry } from "../domain/usageAggregate.js";
import type { StoragePathError } from "@zcode/shared";

export interface WalkStorageRootOptions {
  rootPath: string;
  onEntry: (entry: StorageScanEntry) => void;
  onError?: (error: StoragePathError) => void;
  signal?: AbortSignal;
  /** Concurrently open dirs, default 4. */
  concurrency?: number;
  /** Event-loop yield interval in entries, default 256. */
  yieldEvery?: number;
}

export interface WalkStorageRootResult {
  directoriesScanned: number;
  filesScanned: number;
  /** true when the root itself is missing (empty root, not an error). */
  missingRoot: boolean;
}

export function createStorageAbortError(): Error {
  return new DOMException("storage scan aborted", "AbortError");
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "UNKNOWN";
}

function toRelative(rootPath: string, absolutePath: string): string {
  return relative(rootPath, absolutePath).split(sep).join("/");
}

export async function walkStorageRoot(
  options: WalkStorageRootOptions,
): Promise<WalkStorageRootResult> {
  const { rootPath, onEntry, onError, signal } = options;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const yieldEvery = Math.max(1, options.yieldEvery ?? 256);
  const pending: string[] = [rootPath];
  const result: WalkStorageRootResult = {
    directoriesScanned: 0,
    filesScanned: 0,
    missingRoot: false,
  };
  let processedSinceYield = 0;
  let active = 0;

  const throwIfAborted = () => {
    if (signal?.aborted) throw createStorageAbortError();
  };
  const maybeYield = async () => {
    processedSinceYield += 1;
    if (processedSinceYield >= yieldEvery) {
      processedSinceYield = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
      throwIfAborted();
    }
  };

  const scanDirectory = async (directoryPath: string): Promise<void> => {
    throwIfAborted();
    let directory;
    try {
      directory = await opendir(directoryPath);
    } catch (error) {
      if (directoryPath === rootPath && errorCode(error) === "ENOENT") {
        result.missingRoot = true;
        return;
      }
      onError?.({ path: toRelative(rootPath, directoryPath), code: errorCode(error) });
      return;
    }
    result.directoriesScanned += 1;
    try {
      for await (const dirent of directory) {
        throwIfAborted();
        const entryPath = join(directoryPath, dirent.name);
        if (dirent.isSymbolicLink()) continue;
        if (dirent.isDirectory()) {
          pending.push(entryPath);
          continue;
        }
        if (!dirent.isFile()) continue;
        try {
          const stats = await lstat(entryPath);
          if (!stats.isFile()) continue;
          result.filesScanned += 1;
          onEntry({
            relativePath: toRelative(rootPath, entryPath),
            bytes: stats.size,
            mtimeMs: stats.mtimeMs,
          });
        } catch (error) {
          // Files may vanish to rotation/agent during scan; ENOENT is a normal race, not an error.
          if (errorCode(error) !== "ENOENT") {
            onError?.({ path: toRelative(rootPath, entryPath), code: errorCode(error) });
          }
        }
        await maybeYield();
      }
    } finally {
      await directory.close().catch(() => {});
    }
  };

  // Bounded concurrency: at most concurrency open dirs; done when the queue empties and nothing is in flight.
  await new Promise<void>((resolve, reject) => {
    let failed = false;
    const pump = () => {
      if (failed) return;
      if (pending.length === 0 && active === 0) {
        resolve();
        return;
      }
      while (active < concurrency && pending.length > 0) {
        const next = pending.pop()!;
        active += 1;
        scanDirectory(next)
          .then(() => {
            active -= 1;
            pump();
          })
          .catch((error: unknown) => {
            failed = true;
            reject(error);
          });
      }
    };
    pump();
  });
  return result;
}
