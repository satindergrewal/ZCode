import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BotConfig, BotProviderCallbackResult, BotRuntimeInfo } from "@zcode/shared";
import { getAppConfigDir } from "../paths.js";

export const BOT_RUNTIME_LOCK_RETRY_MS = 10_000;
export const BOT_RUNTIME_LOCK_LEASE_MS = 30_000;
const BOT_RUNTIME_LOCK_HEARTBEAT_MS = 10_000;
const BOT_RUNTIME_LOCK_CLEANUP_RETRY_DELAYS_MS = [100, 250, 500] as const;

export interface BotRuntimeLogger {
  debug(traceId: string | undefined, message: string): void;
  info(traceId: string | undefined, message: string): void;
  warn(traceId: string | undefined, message: string): void;
}

export interface BotRuntimeStatusSink {
  getRuntimeStatus(botId: string): BotRuntimeInfo | undefined;
  setRuntimeStatus(status: BotRuntimeInfo): void;
}

export function createBotConnectionFingerprint(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function assertBotCallbackSucceeded(
  provider: string,
  result: BotProviderCallbackResult,
): void {
  if (result.ok) {
    return;
  }
  // Bugfix: a provider callback signals recoverable business failure via its return value, not
  // necessarily a rejection. Commit the external consumption cursor only after ok=true, or a
  // transient failure gets acked and the message is lost for good.
  throw new Error(`${provider} callback failed: status=${result.status ?? "unknown"}`);
}

export function createLatestRuntimeRefreshQueue() {
  let generation = 0;
  let queue: Promise<void> = Promise.resolve();

  return {
    enqueue(reconcile: (isLatest: () => boolean) => Promise<void>): Promise<void> {
      const currentGeneration = ++generation;
      const result = queue
        .catch(() => undefined)
        .then(() => reconcile(() => currentGeneration === generation));
      // Bugfix: config saves fire back-to-back refreshes. The serial queue must let each round
      // await the previous one releasing the connection, without a failed round blocking newer configs forever.
      queue = result.catch(() => undefined);
      return result;
    },
    invalidate(): void {
      generation += 1;
    },
  };
}

interface BotRuntimeLockOwner {
  pid: number;
  botId: string;
  nonce: string;
  createdAt: number;
}

interface BotRuntimeLock {
  release(): Promise<void>;
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function isBotRuntimeLockConflictError(error: unknown): boolean {
  return (
    isNodeError(error) &&
    (error.code === "EEXIST" ||
      error.code === "ENOTEMPTY" ||
      error.code === "EISDIR" ||
      error.code === "EPERM")
  );
}

function isBotRuntimeLockCleanupRetryable(error: unknown): boolean {
  return (
    isNodeError(error) &&
    (error.code === "EPERM" ||
      error.code === "EBUSY" ||
      error.code === "ENOTEMPTY")
  );
}

async function removeBotRuntimeLockPath(lockPath: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(lockPath, { recursive: true, force: true });
      return;
    } catch (error) {
      const delay = BOT_RUNTIME_LOCK_CLEANUP_RETRY_DELAYS_MS[attempt];
      if (!isBotRuntimeLockCleanupRetryable(error) || delay === undefined) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}

function getBotRuntimeLockPath(namespace: string, lockKey: string): string {
  const lockHash = createHash("sha256").update(lockKey.trim()).digest("hex");
  return join(getAppConfigDir(), "bots-runtime-locks", namespace, `${lockHash}.lock`);
}

async function readBotRuntimeLockOwner(lockPath: string): Promise<BotRuntimeLockOwner | null> {
  try {
    const raw = JSON.parse(
      await readFile(join(lockPath, "owner.json"), "utf-8"),
    ) as Partial<BotRuntimeLockOwner>;
    return typeof raw.pid === "number" &&
      typeof raw.botId === "string" &&
      typeof raw.nonce === "string"
      ? {
          pid: raw.pid,
          botId: raw.botId,
          nonce: raw.nonce,
          createdAt: typeof raw.createdAt === "number" ? raw.createdAt : 0,
        }
      : null;
  } catch {
    return null;
  }
}

async function readBotRuntimeLockLeaseAt(lockPath: string, nonce: string): Promise<number> {
  try {
    return (await stat(join(lockPath, `lease-${nonce}`))).mtimeMs;
  } catch {
    return 0;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

async function acquireBotRuntimeLock(
  namespace: string,
  lockKey: string,
  botId: string,
): Promise<BotRuntimeLock | null> {
  const lockPath = getBotRuntimeLockPath(namespace, lockKey);
  const owner: BotRuntimeLockOwner = {
    pid: process.pid,
    botId,
    nonce: randomBytes(8).toString("hex"),
    createdAt: Date.now(),
  };
  const leasePath = join(lockPath, `lease-${owner.nonce}`);
  await mkdir(dirname(lockPath), {
    recursive: true,
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const pendingLockPath = `${lockPath}.${owner.nonce}.pending`;
    try {
      // Bugfix: lock dir + owner file must be visible as one complete state. Write the owner in a
      // unique temp dir, then rename atomically, so competitors never see a half-initialized lock as stale.
      await mkdir(pendingLockPath);
      await writeFile(join(pendingLockPath, "owner.json"), `${JSON.stringify(owner)}\n`);
      await writeFile(join(pendingLockPath, `lease-${owner.nonce}`), "");
      try {
        await rename(pendingLockPath, lockPath);
      } catch (error) {
        // Bugfix: on Windows, renaming a temp lock dir onto an existing one returns EPERM; treat
        // only rename conflicts as lock contention, not mkdir/writeFile permission errors.
        if (!isBotRuntimeLockConflictError(error)) {
          throw error;
        }
        // EPERM can also be a plain permission error; enter the take-over branch only when the real lock path exists.
        if (!(await stat(lockPath).catch(() => undefined))) {
          throw error;
        }
        const currentOwner = await readBotRuntimeLockOwner(lockPath);
        if (currentOwner) {
          const leaseAt = await readBotRuntimeLockLeaseAt(
            lockPath,
            currentOwner.nonce,
          );
          const leaseAge = Date.now() - leaseAt;
          if (
            isProcessAlive(currentOwner.pid) &&
            leaseAt > 0 &&
            leaseAge < BOT_RUNTIME_LOCK_LEASE_MS
          ) {
            return null;
          }
        }
        // Bugfix: a stale dir may be briefly held by a Windows file handle; retry a bounded number of times before giving up, avoiding silent leftovers.
        await removeBotRuntimeLockPath(lockPath);
        continue;
      }
      let heartbeatWriting = false;
      const heartbeat = setInterval(() => {
        if (heartbeatWriting) return;
        heartbeatWriting = true;
        const now = new Date();
        void utimes(leasePath, now, now)
          .catch(() => undefined)
          .finally(() => {
            heartbeatWriting = false;
          });
      }, BOT_RUNTIME_LOCK_HEARTBEAT_MS);
      heartbeat.unref();
      return {
        async release() {
          clearInterval(heartbeat);
          const currentOwner = await readBotRuntimeLockOwner(lockPath);
          if (
            currentOwner?.pid === owner.pid &&
            currentOwner.botId === owner.botId &&
            currentOwner.nonce === owner.nonce
          ) {
            await removeBotRuntimeLockPath(lockPath);
          }
        },
      };
    } finally {
      await removeBotRuntimeLockPath(pendingLockPath);
    }
  }
  return null;
}

export async function acquireTelegramPollingLock(
  token: string,
  botId: string,
): Promise<BotRuntimeLock | null> {
  return acquireBotRuntimeLock("telegram-polling", token, botId);
}

export async function acquireWeixinPollingLock(
  token: string,
  botId: string,
): Promise<BotRuntimeLock | null> {
  return acquireBotRuntimeLock("weixin-polling", token, botId);
}

export function acquireFeishuWebSocketLock(
  bot: Pick<BotConfig, "id" | "provider" | "feishuAppId">,
): Promise<BotRuntimeLock | null> {
  return acquireBotRuntimeLock(`${bot.provider}-websocket`, bot.feishuAppId?.trim() ?? "", bot.id);
}

export function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = () => finish();
    const timeout = setTimeout(finish, ms);
    // Bugfix: the runtime reuses one signal forever; remove listeners after every wait so retries do not accumulate them.
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
