import { chmod, mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { homedir, uptime } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { WorkspaceHookTrustRecord, WorkspaceHookTrustStoreFile } from "@zcode/contracts";
import {
  WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
  workspaceHookTrustRecordSchema,
  workspaceHookTrustStoreFileSchema,
} from "@zcode/contracts";

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const LOCK_RETRY_MS = 10;
const DEFAULT_RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;
const SECURITY_DIRECTORY = "security";
const TRUST_STORE_FILE = "workspace-hook-trust-v1.json";
// Tolerance for process start-time compares: ps/proc second precision plus scheduling delay; 2s covers it without missing reuse.
const LOCK_START_TIME_TOLERANCE_MS = 2_000;
const PROC_CLOCK_TICKS_PER_SECOND = 100;

const execFileAsync = promisify(execFile);

interface LockOwnerMetadata {
  pid: number;
  token: string;
  /** Process instance start time (wall ms); absent (undefined) in the legacy lock format. */
  startTime?: number;
}

async function defaultWriteLockOwnerMetadata(
  handle: FileHandle,
  content: string,
): Promise<void> {
  await handle.writeFile(content, "utf8");
}

/** This process' start time in wall ms (lazy; constant for the process lifetime). */
let ownStartTimeMs: number | undefined;
function currentProcessStartTimeMs(): number {
  if (ownStartTimeMs === undefined) {
    ownStartTimeMs = Math.round(Date.now() - uptime() * 1_000);
  }
  return ownStartTimeMs;
}

/**
 * Start time (wall ms) of the current instance behind pid; null when unknowable.
 * Lets stale reaping tell a living original owner from a reused pid
 (a bare pid names only a process-table slot, not unique across time).
 * - linux: field 22 of /proc/<pid>/stat (ticks since boot)
 * - darwin: ps -o lstart=
 * - win32: powershell Get-Process StartTime (costly; only on the over-age reap path)
 * - failure/unsupported -> null; callers conservatively treat the original owner as alive (no reap).
 */
async function probeProcessStartTimeDefault(pid: number): Promise<number | null> {
  if (pid === process.pid) return currentProcessStartTimeMs();
  try {
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close < 0) return null;
      // After ')' token[0] is state (field 3); starttime is field 22, i.e. token[19].
      const tokens = stat.slice(close + 2).split(" ");
      const ticks = Number(tokens[19]);
      if (!Number.isFinite(ticks)) return null;
      const bootMs = Date.now() - uptime() * 1_000;
      return Math.round(bootMs + (ticks * 1_000) / PROC_CLOCK_TICKS_PER_SECOND);
    }
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
      const parsed = Date.parse(stdout.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `[DateTimeOffset]::new((Get-Process -Id ${pid}).StartTime).ToUnixTimeMilliseconds()`,
      ]);
      const parsed = Number(stdout.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  } catch {
    return null;
  }
}

export type WorkspaceHookTrustStoreLoadResult =
  | { status: "missing"; records: [] }
  | { status: "ok"; records: WorkspaceHookTrustRecord[] }
  | { status: "corrupt"; records: []; recoveredCorruptPath: string };

export interface FileWorkspaceHookTrustStoreOptions {
  filePath: string;
  now?: () => number;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  beforeRename?: () => void | Promise<void>;
  renameFile?: typeof rename;
  renameRetryDelaysMs?: readonly number[];
  /** Test hook: instance start time by pid; defaults to the per-platform probe (/proc, ps, powershell). */
  probeProcessStartTime?: (pid: number) => Promise<number | null>;
  /** Test hook: lock owner metadata write; defaults to FileHandle.writeFile. */
  writeLockOwnerMetadata?: (handle: FileHandle, content: string) => Promise<void>;
}

export interface WorkspaceHookTrustStoreCompactOptions {
  current: Array<{ workspaceIdentity: string; hookDeclarationDigest: string }>;
  maxAgeMs: number;
  maxRecords: number;
  now?: number;
}

export interface WorkspaceHookTrustStoreRevokeOptions {
  workspaceIdentity: string;
  hookDeclarationDigests?: readonly string[];
}

export interface WorkspaceHookTrustStorePathOptions {
  homeDir?: string;
  userConfigPath?: string;
}

export async function resolveWorkspaceHookTrustStorePath(
  options: WorkspaceHookTrustStorePathOptions = {},
): Promise<string> {
  const home = resolve(options.homeDir ?? homedir());
  const userConfigPath = resolve(
    options.userConfigPath ?? join(home, ".zcode", "cli", "config.json"),
  );
  const config = await readUserConfig(userConfigPath);
  const storage = isRecord(config.storage) ? config.storage : {};
  const configured = typeof storage.dir === "string" ? storage.dir.trim() : "";
  const storageRoot = configured ? resolveTrustedUserPath(configured, home) : join(home, ".zcode");
  return join(storageRoot, SECURITY_DIRECTORY, TRUST_STORE_FILE);
}

export async function createDefaultFileWorkspaceHookTrustStore(
  options: WorkspaceHookTrustStorePathOptions &
    Omit<FileWorkspaceHookTrustStoreOptions, "filePath"> = {},
): Promise<FileWorkspaceHookTrustStore> {
  return createFileWorkspaceHookTrustStore({
    ...options,
    filePath: await resolveWorkspaceHookTrustStorePath(options),
  });
}

export function createFileWorkspaceHookTrustStore(
  options: FileWorkspaceHookTrustStoreOptions,
): FileWorkspaceHookTrustStore {
  return new FileWorkspaceHookTrustStore(options);
}

export class FileWorkspaceHookTrustStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly now: () => number;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly beforeRename?: () => void | Promise<void>;
  private readonly renameFile: typeof rename;
  private readonly renameRetryDelaysMs: readonly number[];
  private readonly probeProcessStartTime: (pid: number) => Promise<number | null>;
  private readonly writeLockOwnerMetadata: (
    handle: FileHandle,
    content: string,
  ) => Promise<void>;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: FileWorkspaceHookTrustStoreOptions) {
    this.filePath = resolve(options.filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.now = options.now ?? Date.now;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.beforeRename = options.beforeRename;
    this.renameFile = options.renameFile ?? rename;
    this.renameRetryDelaysMs = options.renameRetryDelaysMs ?? DEFAULT_RENAME_RETRY_DELAYS_MS;
    this.probeProcessStartTime = options.probeProcessStartTime ?? probeProcessStartTimeDefault;
    this.writeLockOwnerMetadata = options.writeLockOwnerMetadata ?? defaultWriteLockOwnerMetadata;
  }

  load(): Promise<WorkspaceHookTrustStoreLoadResult> {
    return this.enqueue(async () => {
      await this.ensureSecurityDirectory();
      return this.withLock(() => this.readCurrent(true));
    });
  }

  grant(records: readonly WorkspaceHookTrustRecord[]): Promise<WorkspaceHookTrustStoreFile> {
    const validated = records.map((record) => workspaceHookTrustRecordSchema.parse(record));
    return this.mutate((current) => {
      const next = new Map(current.records.map((record) => [trustKey(record), record] as const));
      for (const record of validated) next.set(trustKey(record), record);
      return {
        schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
        records: [...next.values()],
      };
    });
  }

  revoke(options: WorkspaceHookTrustStoreRevokeOptions): Promise<WorkspaceHookTrustStoreFile> {
    if (options.hookDeclarationDigests?.length === 0) {
      // An empty array yields an empty Set, the filter keeps everything and silently succeeds, so callers
      // cannot tell revoke-all (undefined) from an invalid no-target request. Fix the tri-state: undefined
      // revokes the whole workspace, non-empty revokes exactly, empty rejects before any IO.
      return Promise.reject(
        new Error("hookDeclarationDigests must be undefined or non-empty"),
      );
    }
    const selected = options.hookDeclarationDigests
      ? new Set(options.hookDeclarationDigests)
      : undefined;
    return this.mutate((current) => ({
      schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
      records: current.records.filter(
        (record) =>
          record.workspaceIdentity !== options.workspaceIdentity ||
          (selected !== undefined && !selected.has(record.hookDeclarationDigest)),
      ),
    }));
  }

  touch(input: {
    workspaceIdentity: string;
    hookDeclarationDigests: readonly string[];
    usedAt?: string;
  }): Promise<WorkspaceHookTrustStoreFile> {
    const selected = new Set(input.hookDeclarationDigests);
    const usedAt = input.usedAt ?? new Date(this.now()).toISOString();
    return this.mutate((current) => ({
      schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
      records: current.records.map((record) =>
        record.workspaceIdentity === input.workspaceIdentity &&
        selected.has(record.hookDeclarationDigest)
          ? { ...record, lastUsedAt: usedAt }
          : record,
      ),
    }));
  }

  compact(options: WorkspaceHookTrustStoreCompactOptions): Promise<WorkspaceHookTrustStoreFile> {
    if (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 0) {
      throw new Error("maxAgeMs must be a nonnegative finite number");
    }
    if (!Number.isInteger(options.maxRecords) || options.maxRecords < 1) {
      throw new Error("maxRecords must be a positive integer");
    }
    const now = options.now ?? this.now();
    const current = new Set(
      options.current.map((entry) =>
        trustKey({
          workspaceIdentity: entry.workspaceIdentity,
          hookDeclarationDigest: entry.hookDeclarationDigest,
        }),
      ),
    );
    return this.mutate((store) => {
      const retained = store.records.filter((record) => {
        if (current.has(trustKey(record))) return true;
        const timestamp = Date.parse(record.lastUsedAt ?? record.grantedAt);
        return Number.isFinite(timestamp) && now - timestamp <= options.maxAgeMs;
      });
      const currentRecords = retained.filter((record) => current.has(trustKey(record)));
      const nonCurrent = retained
        .filter((record) => !current.has(trustKey(record)))
        .sort((left, right) => recordTimestamp(right) - recordTimestamp(left));
      const available = Math.max(0, options.maxRecords - currentRecords.length);
      return {
        schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
        records: [...currentRecords, ...nonCurrent.slice(0, available)],
      };
    });
  }

  private mutate(
    update: (current: WorkspaceHookTrustStoreFile) => WorkspaceHookTrustStoreFile,
  ): Promise<WorkspaceHookTrustStoreFile> {
    return this.enqueue(async () => {
      await this.ensureSecurityDirectory();
      return this.withLock(async () => {
        const loaded = await this.readCurrent(true);
        const current: WorkspaceHookTrustStoreFile = {
          schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
          records: loaded.status === "ok" ? loaded.records : [],
        };
        const next = workspaceHookTrustStoreFileSchema.parse(update(current));
        await this.atomicWrite(next);
        return next;
      });
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const { handle, token } = await this.acquireLock();
    try {
      return await operation();
    } finally {
      await handle.close().catch(() => undefined);
      // Verify ownership before release. Our lock may already be reaped and owned
      // by a new holder; unconditional unlink deletes theirs, letting later writers
      // enter the critical section concurrently and overwrite committed revoke/grant with stale snapshots.
      await this.releaseLockIfOwned(token);
    }
  }

  private async acquireLock(): Promise<{ handle: FileHandle; token: string }> {
    const startedAt = Date.now();
    while (true) {
      let handle: FileHandle | undefined;
      try {
        handle = await open(this.lockPath, "wx", 0o600);
        // Lock content: pid + process start time + unpredictable owner token.
        // startTime identifies the instance: a bare pid is reusable, so
        // liveness via process.kill(pid, 0) alone mistakes a recycled
        // pid for a live owner and never reaps, deadlocking revoke/grant. The reaper compares
        // the recorded start time against the current instance via the probe.
        const token = randomUUID();
        const owner = `${JSON.stringify({
          pid: process.pid,
          startTime: currentProcessStartTimeMs(),
          token,
        })}\n`;
        await this.writeLockOwnerMetadata(handle, owner);
        return { handle, token };
      } catch (error) {
        // If open(wx) succeeded but the metadata write failed (disk full), close the handle
        // and delete our just-created lock: an empty leftover would be reaped as ownerless,
        // breaking exclusion. Only our own wx-exclusive file is deleted, no overreach.
        if (handle) {
          await handle.close().catch(() => undefined);
          await unlink(this.lockPath).catch(() => undefined);
        }
        if (!isNodeError(error, "EEXIST")) throw error;
        await this.removeStaleLock();
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new Error(`Timed out acquiring Workspace Hook Trust store lock: ${this.lockPath}`);
        }
        await delay(LOCK_RETRY_MS);
      }
    }
  }

  /** Delete only while the lock still belongs to the token's holder; ownerless/foreign locks untouched. */
  private async releaseLockIfOwned(token: string): Promise<void> {
    const owner = await this.readLockOwner();
    if (!owner || owner.token !== token) return;
    await unlink(this.lockPath).catch(() => undefined);
  }

  private async readLockOwner(): Promise<LockOwnerMetadata | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.lockPath, "utf8"));
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { pid?: unknown }).pid === "number" &&
        typeof (parsed as { token?: unknown }).token === "string"
      ) {
        return {
          pid: (parsed as { pid: number }).pid,
          token: (parsed as { token: string }).token,
          startTime:
            typeof (parsed as { startTime?: unknown }).startTime === "number"
              ? (parsed as { startTime: number }).startTime
              : undefined,
        };
      }
      return null;
    } catch {
      // Legacy empty/corrupt lock -> ownerless.
      return null;
    }
  }

/** pid liveness via signal 0; EPERM (Windows, no permission) counts alive, ESRCH/EINVAL dead. */
  private isProcessAlive(pid: number): boolean {
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return isNodeError(error, "EPERM");
    }
  }

  private async removeStaleLock(): Promise<void> {
    try {
      const lockStats = await stat(this.lockPath);
      if (Date.now() - lockStats.mtimeMs <= this.staleLockMs) return;
      // Over-age but holder alive (sleep/debug pause/AV-slowed IO) -> no reap.
      // mtime cannot tell a dead holder from a paused one; the pid liveness probe can.
      // Unparsable locks (legacy empty file) have no pid -> reap as dead.
      const owner = await this.readLockOwner();
      if (!owner) {
        await rm(this.lockPath, { force: true });
        return;
      }
      if (owner.pid === process.pid) return;
      if (!this.isProcessAlive(owner.pid)) {
        await rm(this.lockPath, { force: true });
        return;
      }
      // pid alive does not mean original owner alive: pids get recycled. If the
      // recycled pid lands on an unrelated long-lived process, kill(0)-only checks never reap,
      // deadlocking revoke/grant. Verify by instance start time: recorded startTime
      // equal to the pid's current instance -> original owner alive (no reap);
      // different -> owner dead, pid reassigned (safe reap). Unavailable probe or legacy
      // lock without startTime -> conservatively
      // treat the original owner as alive, no reap.
      const currentStart = await this.probeProcessStartTime(owner.pid);
      if (currentStart === null || owner.startTime === undefined) return;
      if (Math.abs(currentStart - owner.startTime) > LOCK_START_TIME_TOLERANCE_MS) {
        await rm(this.lockPath, { force: true });
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }

  private async ensureSecurityDirectory(): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }

  private async readCurrent(recoverCorrupt: boolean): Promise<WorkspaceHookTrustStoreLoadResult> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { status: "missing", records: [] };
      throw error;
    }

    try {
      const parsed = workspaceHookTrustStoreFileSchema.parse(JSON.parse(content) as unknown);
      // chmod is a hardening side effect, not load's duty. Read-only dirs/odd ownership
      // make chmod throw EPERM/EROFS; bubbling would fail the whole load, far worse than
      // one failed hardening. Degrade to ignore: the record still loads,
      // the next mutate's atomicWrite retries.
      await chmod(this.filePath, 0o600).catch(() => undefined);
      return { status: "ok", records: parsed.records };
    } catch (error) {
      if (!recoverCorrupt) throw error;
      const recoveredCorruptPath = `${this.filePath}.corrupt-${this.now()}`;
      // If rename-of-corrupt-file bubbles, it bypasses the designed
      // corrupt return: callers see an accident, not fail-closed state.
      // On rename failure still return corrupt: corrupt means all hooks untrusted (fail-closed),
      // and the leftover file lets no record count as trusted.
      try {
        await rename(this.filePath, recoveredCorruptPath);
        await chmod(recoveredCorruptPath, 0o600).catch(() => undefined);
      } catch {
        // Rename failed: return corrupt, leaving the file for the next load to judge again.
      }
      return { status: "corrupt", records: [], recoveredCorruptPath };
    }
  }

  private async atomicWrite(store: WorkspaceHookTrustStoreFile): Promise<void> {
    const directory = dirname(this.filePath);
    const tempPath = join(
      directory,
      `.${basename(this.filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.beforeRename?.();
      await renameWithRetry(
        this.renameFile,
        tempPath,
        this.filePath,
        this.renameRetryDelaysMs,
      );
      await chmod(this.filePath, 0o600);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

async function renameWithRetry(
  renameFile: typeof rename,
  tempPath: string,
  filePath: string,
  retryDelaysMs: readonly number[],
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(tempPath, filePath);
      return;
    } catch (error) {
      const delayMs = retryDelaysMs[attempt];
      if (delayMs === undefined || !isRetryableRenameError(error)) throw error;
      // Windows AV/indexers hold target files briefly; a single rename fails an already
      // fsynced trust mutation. Bounded async retry for known transient locks only.
      await sleep(delayMs);
    }
  }
}

function isRetryableRenameError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

async function readUserConfig(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return {};
    throw new Error(`Unable to read trusted user config for Workspace Hook Trust store: ${path}`, {
      cause: error,
    });
  }
}

function resolveTrustedUserPath(path: string, home: string): string {
  if (path.startsWith("~/")) return join(home, path.slice(2));
  if (isAbsolute(path)) return resolve(path);
  // Security: a relative storage.dir in user config binds to the user home, never drift with workspace cwd.
  return resolve(home, path);
}

function trustKey(record: { workspaceIdentity: string; hookDeclarationDigest: string }): string {
  return `${record.workspaceIdentity}\u0000${record.hookDeclarationDigest}`;
}

function recordTimestamp(record: WorkspaceHookTrustRecord): number {
  return Date.parse(record.lastUsedAt ?? record.grantedAt);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
