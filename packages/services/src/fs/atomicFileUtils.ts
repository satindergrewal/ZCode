import { mkdir, writeFile, rename, rm, readdir, stat } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireFileLock } from "@zcode/shared/node";
import { isInjectedFsFaultError, maybeThrowInjectedFsFault } from "./fsFaultInjection.js";

const DEFAULT_RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800, 1600, 3200] as const;
const DEFAULT_LOCK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;
const DEFAULT_LOCK_OWNERLESS_GRACE_MS = 100;
const DEFAULT_LOCK_MAX_WAIT_MS = 8_000;
const DEFAULT_TEMP_FILE_STALE_MS = 60_000;

interface AtomicWriteTextOptions {
  renameRetryDelaysMs?: readonly number[];
  lockRetryDelaysMs?: readonly number[];
  lockOwnerlessGraceMs?: number;
  lockMaxWaitMs?: number;
  tempFileStaleMs?: number;
  useFileLock?: boolean;
  beforeRename?: () => void | Promise<void>;
  runRename?: (renameFile: () => Promise<void>) => Promise<void>;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isRetryableAtomicRenameError(error: unknown): boolean {
  if (isInjectedFsFaultError(error)) {
    return false;
  }
  const code = getErrorCode(error);
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

async function renameWithRetry(
  tempFile: string,
  filePath: string,
  retryDelaysMs: readonly number[] = DEFAULT_RENAME_RETRY_DELAYS_MS,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      maybeThrowInjectedFsFault({ operation: "rename", path: filePath });
      await rename(tempFile, filePath);
      return;
    } catch (error) {
      const retryDelayMs = retryDelaysMs[attempt];
      if (retryDelayMs === undefined || !isRetryableAtomicRenameError(error)) {
        throw error;
      }

      await sleep(retryDelayMs);
    }
  }
}

async function cleanupStaleTempFilesForTarget(
  filePath: string,
  excludeTempFile: string,
  staleMs: number,
): Promise<void> {
  const dir = dirname(filePath);
  const targetBasename = basename(filePath);
  const tempPrefix = `${targetBasename}.`;
  const now = Date.now();

  try {
    const entries = await readdir(dir);
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.startsWith(tempPrefix) || !entry.endsWith(".tmp")) {
          return;
        }

        const tempPath = join(dir, entry);
        if (tempPath === excludeTempFile) {
          return;
        }

        try {
          const info = await stat(tempPath);
          if (now - info.mtimeMs < staleMs) {
            return;
          }
          await rm(tempPath, { force: true });
        } catch {
          // best-effort cleanup
        }
      }),
    );
  } catch {
    // best-effort cleanup
  }
}

/**
 * Atomic write via temp file + rename. rename is atomic within one filesystem, avoiding
 * lost-update races in read-modify-write. The temp file lives in the target's directory so
 * Windows never cross-volume-renames.
 */
export async function atomicWriteText(
  filePath: string,
  content: string,
  options?: AtomicWriteTextOptions,
): Promise<void> {
  const dir = dirname(filePath);
  const tempFile = join(
    dir,
    `${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  maybeThrowInjectedFsFault({ operation: "mkdir", path: dir });
  await mkdir(dir, { recursive: true });
  // On Windows several windows/host processes can save the same task JSON; in-process write
  // chains cannot serialize that and rename-replacing the target EPERMs at high rate. A same-dir
  // lock file serializes cooperating ZCode processes; rename retries still absorb brief AV/indexer
  // holds.
  const releaseLock =
    options?.useFileLock === false
      ? null
      : await acquireFileLock(
          filePath,
          options?.lockRetryDelaysMs ?? DEFAULT_LOCK_RETRY_DELAYS_MS,
          options?.lockOwnerlessGraceMs ?? DEFAULT_LOCK_OWNERLESS_GRACE_MS,
          options?.lockMaxWaitMs ?? DEFAULT_LOCK_MAX_WAIT_MS,
        );
  try {
    // Failed renames from old versions/crashes leave config.json.*.tmp behind. Clean only temps of
    // this target past the age threshold, never another process's fresh active temp.
    await cleanupStaleTempFilesForTarget(
      filePath,
      tempFile,
      options?.tempFileStaleMs ?? DEFAULT_TEMP_FILE_STALE_MS,
    );
    maybeThrowInjectedFsFault({ operation: "writeFile", path: tempFile });
    await writeFile(tempFile, content, "utf-8");
    await options?.beforeRename?.();
    // Defender/indexer/another window can hold the target JSON briefly, making the atomic-replace
    // rename throw EPERM/EBUSY/EACCES. Retry only such transient locks briefly; genuine permission
    // errors still propagate - never silently lose a session snapshot.
    const renameFile = () => renameWithRetry(tempFile, filePath, options?.renameRetryDelaysMs);
    if (options?.runRename) {
      await options.runRename(renameFile);
    } else {
      await renameFile();
    }
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => {
      // best-effort cleanup
    });
    throw error;
  } finally {
    await releaseLock?.();
  }
}

export async function atomicWriteJson(
  filePath: string,
  data: Record<string, unknown>,
  options?: AtomicWriteTextOptions,
): Promise<void> {
  await atomicWriteText(filePath, JSON.stringify(data, null, 2), options);
}
