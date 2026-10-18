import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type { IZCodeTaskService } from "@zcode/services";
import type { ZCodeTaskSnapshot } from "@zcode/shared";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

type GetTaskSnapshotParams = Parameters<IZCodeTaskService["getTaskSnapshot"]>[0];
type GetTaskSnapshotResult = Promise<ZCodeTaskSnapshot | null>;
type GetTaskSnapshotWithEtagParams = Parameters<IZCodeTaskService["getTaskSnapshotWithEtag"]>[0];

const zcodeTaskServiceProxyCache = new WeakMap<IZCodeTaskService, IZCodeTaskService>();
const snapshotInflightRequestsByService = new WeakMap<
  IZCodeTaskService,
  Map<string, GetTaskSnapshotResult>
>();
const snapshotCacheByService = new WeakMap<
  IZCodeTaskService,
  Map<string, { etag: string; snapshot: ZCodeTaskSnapshot }>
>();
const SNAPSHOT_CACHE_STORAGE_KEY = "zcode-task-snapshot-cache:v1";
const SNAPSHOT_CACHE_MAX_ENTRY_BYTES = 256 * 1024;
const SNAPSHOT_CACHE_MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_CACHE_MAX_ENTRIES = 20;
type PersistedSnapshotCacheEntry = {
  key: string;
  etag: string;
  snapshot: ZCodeTaskSnapshot;
  updatedAt: number;
  sizeBytes: number;
};
let persistedSnapshotCacheLoaded = false;
const persistedSnapshotCache = new Map<string, PersistedSnapshotCacheEntry>();
// Memory-diagnostics counter: WeakMaps are not enumerable, so remember the most recent
// service's in-memory cache (the renderer really has only one task service instance).
let latestSnapshotCache: Map<string, { etag: string; snapshot: ZCodeTaskSnapshot }> | undefined;
uiMemoryDiagnosticsRegistry.register("taskSnapshotCache", () => ({
  entries: latestSnapshotCache?.size ?? 0,
  persisted: persistedSnapshotCache.size,
}));

export function buildSnapshotDedupeKey(params: GetTaskSnapshotParams): string {
  return [
    params.workspacePath,
    params.workspaceIdentity ?? "",
    params.taskId,
    typeof params.messageLimit === "number" ? String(params.messageLimit) : "",
    typeof params.byteBudget === "number" ? String(params.byteBudget) : "",
    typeof params.toolLimit === "number" ? String(params.toolLimit) : "",
    // desktop-continuous and phone remote-replayable snapshots may go through different
    // recovery logic. The cache key must distinguish clientMode, or one side's snapshot gets
    // reused for the other.
    params.clientMode ?? "desktop-continuous",
    // Phone read-only recovery deliberately skips task-index model backfill.
    // Different policy means different host-side recovery semantics; never share one snapshot cache.
    params.resumeModelPolicy ?? "task-index",
    // Phone first-screen recovery activates the session with a historical model hint.
    // The same task under a different model hint may have a different context window; isolate caches.
    params.model ?? "",
    // Replayable snapshots now carry configOptions projected from session settings.
    // Under the same model, a different thoughtLevel changes toolbar config and later send
    // hints; never reuse the old snapshot.
    params.thoughtLevel ?? "",
  ].join("::");
}

function getOrCreateSnapshotInflightMap(
  service: IZCodeTaskService,
): Map<string, GetTaskSnapshotResult> {
  if (!service || typeof service !== "object") {
    return new Map();
  }
  const existing = snapshotInflightRequestsByService.get(service);
  if (existing) {
    return existing;
  }
  const created = new Map<string, GetTaskSnapshotResult>();
  snapshotInflightRequestsByService.set(service, created);
  return created;
}

function getOrCreateSnapshotCacheMap(
  service: IZCodeTaskService,
): Map<string, { etag: string; snapshot: ZCodeTaskSnapshot }> {
  if (!service || typeof service !== "object") {
    return new Map();
  }
  const existing = snapshotCacheByService.get(service);
  if (existing) {
    latestSnapshotCache = existing;
    return existing;
  }
  const created = new Map<string, { etag: string; snapshot: ZCodeTaskSnapshot }>();
  snapshotCacheByService.set(service, created);
  latestSnapshotCache = created;
  return created;
}

function getBrowserStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function ensurePersistedSnapshotCacheLoaded() {
  if (persistedSnapshotCacheLoaded) {
    return;
  }
  persistedSnapshotCacheLoaded = true;
  const storage = getBrowserStorage();
  const raw = storage?.getItem(SNAPSHOT_CACHE_STORAGE_KEY);
  if (!raw) {
    return;
  }

  try {
    const parsed = JSON.parse(raw) as {
      entries?: PersistedSnapshotCacheEntry[];
    };
    const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    for (const entry of entries) {
      if (
        typeof entry?.key !== "string" ||
        typeof entry?.etag !== "string" ||
        !entry.snapshot ||
        typeof entry.updatedAt !== "number" ||
        typeof entry.sizeBytes !== "number"
      ) {
        continue;
      }
      persistedSnapshotCache.set(entry.key, entry);
    }
  } catch {
    // ignore storage parse errors
  }
}

function flushPersistedSnapshotCache() {
  const storage = getBrowserStorage();
  if (!storage) {
    return;
  }
  try {
    storage.setItem(
      SNAPSHOT_CACHE_STORAGE_KEY,
      JSON.stringify({ entries: [...persistedSnapshotCache.values()] }),
    );
  } catch {
    // ignore storage write errors (quota/private mode)
  }
}

function prunePersistedSnapshotCache() {
  const entries = [...persistedSnapshotCache.values()].sort(
    (left, right) => right.updatedAt - left.updatedAt,
  );
  const nextEntries: PersistedSnapshotCacheEntry[] = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (nextEntries.length >= SNAPSHOT_CACHE_MAX_ENTRIES) {
      continue;
    }
    if (totalBytes + entry.sizeBytes > SNAPSHOT_CACHE_MAX_TOTAL_BYTES) {
      continue;
    }
    nextEntries.push(entry);
    totalBytes += entry.sizeBytes;
  }
  persistedSnapshotCache.clear();
  for (const entry of nextEntries) {
    persistedSnapshotCache.set(entry.key, entry);
  }
}

function readPersistedSnapshotEntry(key: string) {
  ensurePersistedSnapshotCacheLoaded();
  const entry = persistedSnapshotCache.get(key);
  if (!entry) {
    return null;
  }
  return { etag: entry.etag, snapshot: entry.snapshot };
}

function writePersistedSnapshotEntry(key: string, etag: string, snapshot: ZCodeTaskSnapshot): void {
  ensurePersistedSnapshotCacheLoaded();
  const serializedSnapshot = JSON.stringify(snapshot);
  const sizeBytes = new TextEncoder().encode(serializedSnapshot).byteLength;
  if (sizeBytes > SNAPSHOT_CACHE_MAX_ENTRY_BYTES) {
    // Persisting a large task's snapshot to localStorage as-is quickly hits the quota and slows
    // the main thread. Persist small snapshots only and drop the old cache when over the limit,
    // so "speed up loading" never becomes "storage pressure".
    persistedSnapshotCache.delete(key);
    flushPersistedSnapshotCache();
    return;
  }

  persistedSnapshotCache.set(key, {
    key,
    etag,
    snapshot,
    updatedAt: Date.now(),
    sizeBytes,
  });
  prunePersistedSnapshotCache();
  flushPersistedSnapshotCache();
}

function deletePersistedSnapshotEntry(key: string): void {
  ensurePersistedSnapshotCacheLoaded();
  persistedSnapshotCache.delete(key);
  flushPersistedSnapshotCache();
}

function createZCodeTaskServiceProxy(service: IZCodeTaskService): IZCodeTaskService {
  const inflight = getOrCreateSnapshotInflightMap(service);
  const snapshotCache = getOrCreateSnapshotCacheMap(service);

  return new Proxy(service, {
    get(target, prop, receiver) {
      if (prop !== "getTaskSnapshot") {
        return Reflect.get(target, prop, receiver);
      }

      return (params: GetTaskSnapshotParams) => {
        const requestKey = buildSnapshotDedupeKey(params);
        const existing = inflight.get(requestKey);
        if (existing) {
          return existing;
        }
        const cachedSnapshotEntry =
          snapshotCache.get(requestKey) ?? readPersistedSnapshotEntry(requestKey);
        if (cachedSnapshotEntry && !snapshotCache.has(requestKey)) {
          snapshotCache.set(requestKey, cachedSnapshotEntry);
        }

        // During remote-control first-screen recovery, multiple hooks request the same task
        // snapshot concurrently, making the host run getTaskSnapshot repeatedly and re-shipping
        // huge snapshots through the relay. Dedupe concurrently by service + params, reusing one
        // Promise so a single RPC is in flight; also send if-none-match so unchanged snapshots
        // reuse the local cache instead of re-downloading large JSON.
        const request = (async () => {
          const firstResult = await target.getTaskSnapshotWithEtag({
            ...(params as GetTaskSnapshotWithEtagParams),
            ...(cachedSnapshotEntry?.etag ? { ifNoneMatch: cachedSnapshotEntry.etag } : {}),
          });
          if (firstResult.notModified) {
            if (cachedSnapshotEntry?.snapshot) {
              return cachedSnapshotEntry.snapshot;
            }
            // When only the etag was persisted without a snapshot body, do not pass notModified
            // through -- the first screen would render empty. Fall back to one hard fetch without
            // if-none-match; data integrity wins.
            const fallbackResult = await target.getTaskSnapshotWithEtag(
              params as GetTaskSnapshotWithEtagParams,
            );
            if (fallbackResult.snapshot && fallbackResult.etag) {
              const nextEntry = {
                etag: fallbackResult.etag,
                snapshot: fallbackResult.snapshot,
              };
              snapshotCache.set(requestKey, nextEntry);
              writePersistedSnapshotEntry(requestKey, fallbackResult.etag, fallbackResult.snapshot);
            }
            return fallbackResult.snapshot;
          }
          if (firstResult.snapshot && firstResult.etag) {
            const nextEntry = {
              etag: firstResult.etag,
              snapshot: firstResult.snapshot,
            };
            snapshotCache.set(requestKey, nextEntry);
            writePersistedSnapshotEntry(requestKey, firstResult.etag, firstResult.snapshot);
          } else if (!firstResult.snapshot) {
            snapshotCache.delete(requestKey);
            deletePersistedSnapshotEntry(requestKey);
          }
          return firstResult.snapshot;
        })().finally(() => {
          if (inflight.get(requestKey) === request) {
            inflight.delete(requestKey);
          }
        });
        inflight.set(requestKey, request);
        return request;
      };
    },
  });
}

/** ZCode task wrapper service instance. */
export function useZCodeTaskService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeTaskService {
  // The ZCode task service resolves by workspace identity so every task RPC lands on the
  // matching host.
  const services = workspacePath
    ? useWorkspaceServices(workspacePath, preferredRemoteSessionId, workspaceIdentity)
    : useServices();
  const rawService = services.zcodeTaskService;
  if (!rawService || typeof rawService !== "object") {
    return rawService;
  }
  const cachedProxy = zcodeTaskServiceProxyCache.get(rawService);
  if (cachedProxy) {
    return cachedProxy;
  }
  const nextProxy = createZCodeTaskServiceProxy(rawService);
  zcodeTaskServiceProxyCache.set(rawService, nextProxy);
  return nextProxy;
}
