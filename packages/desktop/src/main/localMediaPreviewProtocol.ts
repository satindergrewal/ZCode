import { realpath as fsRealpath } from "node:fs/promises";
import { realpathSync as fsRealpathSync, statSync as fsStatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { LOCAL_MEDIA_PREVIEW_SCHEME, buildLocalMediaPreviewUrl } from "@zcode/shared";

interface LocalMediaPreviewSchemeRegistrar {
  registerSchemesAsPrivileged(
    schemes: Array<{
      scheme: string;
      privileges: Record<string, boolean>;
    }>,
  ): void;
}

interface LocalMediaPreviewProtocolRequest {
  url: string;
}

type LocalMediaPreviewProtocolResponse = string | { error: number };

interface LocalMediaPreviewProtocol {
  registerFileProtocol(
    scheme: string,
    handler: (
      request: LocalMediaPreviewProtocolRequest,
      callback: (response: LocalMediaPreviewProtocolResponse) => void,
    ) => void,
  ): boolean;
}

const installedProtocols = new WeakSet<object>();
const NET_ERR_INVALID_URL = -300;

export interface LocalMediaPreviewPathRegistry {
  authorize(path: string): Promise<string>;
  isAuthorized(path: string): boolean;
  clear(): void;
}

const LOCAL_MEDIA_AUTHORIZATION_TTL_MS = 30 * 60 * 1000;
const LOCAL_MEDIA_AUTHORIZATION_MAX_ENTRIES = 256;

/**
 * * Main registers only exact files the Host validated via workspace/session/message/attachment checks.
 * The legacy protocol trusted absolute paths from renderer URLs, letting any script read any file.
 */
export function createLocalMediaPreviewPathRegistry(
  dependencies: {
    isAbsolutePath?: (path: string) => boolean;
    realpath?: (path: string) => Promise<string>;
    realpathSync?: (path: string) => string;
    isRegularFileSync?: (path: string) => boolean;
    now?: () => number;
    ttlMs?: number;
    maxEntries?: number;
  } = {},
): LocalMediaPreviewPathRegistry {
  const authorizedPaths = new Map<
    string,
    { canonicalPath: string; expiresAt: number; lastUsedAt: number }
  >();
  // A permanent Set grows unbounded and keeps file-loader rights after paths turn into symlinks.
  const isAbsolutePath = dependencies.isAbsolutePath ?? isAbsolute;
  const realpath = dependencies.realpath ?? fsRealpath;
  const realpathSync = dependencies.realpathSync ?? fsRealpathSync;
  const isRegularFileSync =
    dependencies.isRegularFileSync ?? ((path: string) => fsStatSync(path).isFile());
  const now = dependencies.now ?? Date.now;
  const ttlMs = dependencies.ttlMs ?? LOCAL_MEDIA_AUTHORIZATION_TTL_MS;
  const maxEntries = dependencies.maxEntries ?? LOCAL_MEDIA_AUTHORIZATION_MAX_ENTRIES;

  const pruneExpired = (observedAt: number) => {
    for (const [path, entry] of authorizedPaths) {
      if (entry.expiresAt <= observedAt) authorizedPaths.delete(path);
    }
  };

  const evictLeastRecentlyUsed = () => {
    while (authorizedPaths.size > maxEntries) {
      let oldestPath: string | undefined;
      let oldestAccess = Number.POSITIVE_INFINITY;
      for (const [path, entry] of authorizedPaths) {
        if (entry.lastUsedAt < oldestAccess) {
          oldestAccess = entry.lastUsedAt;
          oldestPath = path;
        }
      }
      if (!oldestPath) return;
      authorizedPaths.delete(oldestPath);
    }
  };

  return {
    async authorize(path) {
      if (!isAbsolutePath(path)) {
        throw new Error("Local media preview path must be absolute");
      }
      const canonicalPath = await realpath(path);
      const observedAt = now();
      pruneExpired(observedAt);
      authorizedPaths.set(canonicalPath, {
        canonicalPath,
        expiresAt: observedAt + ttlMs,
        lastUsedAt: observedAt,
      });
      evictLeastRecentlyUsed();
      return canonicalPath;
    },
    isAuthorized(path) {
      const observedAt = now();
      pruneExpired(observedAt);
      const entry = authorizedPaths.get(path);
      if (!entry) return false;
      try {
        if (realpathSync(path) !== entry.canonicalPath || !isRegularFileSync(path)) {
          authorizedPaths.delete(path);
          return false;
        }
      } catch {
        authorizedPaths.delete(path);
        return false;
      }
      entry.lastUsedAt = observedAt;
      return true;
    },
    clear() {
      authorizedPaths.clear();
    },
  };
}

/**
 * * Electron registers privileged schemes only before app ready.
 * Without standard, Chromium mis-handles tail reads and misjudges MP4s with moov after mdat
 * as undecodable; standard + stream keep metadata reads and seeks working for local video.
 */
export function registerLocalMediaPreviewScheme(
  protocol: LocalMediaPreviewSchemeRegistrar,
  // registerSchemesAsPrivileged may be called once (the later call wins); other privileged schemes
  // (such as the plugin UI sandbox's zcode-sandbox) must register in that same call.
  additionalSchemes: Array<{ scheme: string; privileges: Record<string, boolean> }> = [],
): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: LOCAL_MEDIA_PREVIEW_SCHEME,
      privileges: { standard: true, secure: true, stream: true },
    },
    ...additionalSchemes,
  ]);
}

export function installLocalMediaPreviewProtocol(
  protocol: LocalMediaPreviewProtocol,
  options: { isPathAuthorized: (path: string) => boolean },
): void {
  if (installedProtocols.has(protocol)) return;
  // protocol.handle(Response) on Electron 41 cannot give local A/V a stable seekable range, and hand-built
  // Range responses read as unplayable. Reuse the native file loader so Chromium handles Range
  // while only vetted A/V absolute paths ever reach it.
  const registered = protocol.registerFileProtocol(
    LOCAL_MEDIA_PREVIEW_SCHEME,
    (request, callback) => {
      try {
        const url = new URL(request.url);
        const path = url.searchParams.get("path") ?? "";
        if (
          url.hostname !== "local" ||
          url.pathname !== "/preview" ||
          !options.isPathAuthorized(path)
        ) {
          callback({ error: NET_ERR_INVALID_URL });
          return;
        }
        callback(path);
      } catch {
        callback({ error: NET_ERR_INVALID_URL });
      }
    },
  );
  if (!registered) throw new Error("Failed to register local media preview protocol");
  installedProtocols.add(protocol);
}

export { buildLocalMediaPreviewUrl };
