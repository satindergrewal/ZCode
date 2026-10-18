import { watch, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { Emitter, Event, type Event as RpcEvent } from "@zcode/rpc";
import type { FileWatchEvent } from "@zcode/shared";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import type { IFileWatcherService } from "./fileWatcher.js";
import { registerMemoryDiagnosticsProvider } from "#src/memoryDiagnostics.js";

/** Debounce (ms) - avoids refresh storms on bulk changes such as git checkout */
const DEBOUNCE_MS = 150;

interface WatcherInstance {
  path: string;
  watcher: FSWatcher;
  changeEmitter: Emitter<FileWatchEvent>;
  /** Debounce timer */
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** Pass through only when the debounce window holds a single explicit path, so same-batch target events are not filtered out */
  pendingChangedPaths: Set<string>;
  hasUnknownChangedPath: boolean;
}

export function resolveFileWatchChangedPath(
  watchedDirectoryPath: string,
  fileName: string | Buffer | null,
): string | undefined {
  if (fileName === null) {
    return undefined;
  }
  const normalizedFileName = fileName.toString().trim();
  return normalizedFileName ? resolve(watchedDirectoryPath, normalizedFileName) : undefined;
}

export function createFileWatcherService(options?: {
  logger?: ServiceLogger;
}): IFileWatcherService {
  const log = options?.logger ?? createServiceLogger("file-watcher");
  const watchers = new Map<string, WatcherInstance>();
  let nextId = 0;
  // Memory diagnostic counters: when a disconnect leaks the watcher these only ever grow.
  const memoryDiagnostics = registerMemoryDiagnosticsProvider("fileWatcher", () => ({
    open: watchers.size,
  }));

  function cleanup(id: string): void {
    const w = watchers.get(id);
    if (!w) return;
    if (w.debounceTimer) clearTimeout(w.debounceTimer);
    w.watcher.close();
    w.changeEmitter.dispose();
    watchers.delete(id);
  }

  return {
    async watch(params: { path: string; recursive?: boolean }): Promise<{ id: string }> {
      const id = String(nextId++);
      const changeEmitter = new Emitter<FileWatchEvent>();
      const recursive = params.recursive ?? false;

      let fsWatcher: FSWatcher;
      try {
        // Non-recursive single-dir watch by default; workspace-level signals like Git status opt into recursive.
        fsWatcher = watch(params.path, { recursive }, (_eventType, fileName) => {
          const instance = watchers.get(id);
          if (!instance) return;

          const changedPath = resolveFileWatchChangedPath(instance.path, fileName);
          if (changedPath) {
            instance.pendingChangedPaths.add(changedPath);
          } else {
            instance.hasUnknownChangedPath = true;
          }

          // Debounce: bursts of changes trigger a single refresh
          if (instance.debounceTimer) clearTimeout(instance.debounceTimer);
          instance.debounceTimer = setTimeout(() => {
            instance.debounceTimer = null;
            const onlyChangedPath =
              !instance.hasUnknownChangedPath && instance.pendingChangedPaths.size === 1
                ? instance.pendingChangedPaths.values().next().value
                : undefined;
            instance.pendingChangedPaths.clear();
            instance.hasUnknownChangedPath = false;
            instance.changeEmitter.fire({
              dirPath: instance.path,
              ...(onlyChangedPath ? { changedPath: onlyChangedPath } : {}),
            });
          }, DEBOUNCE_MS);
        });
      } catch (error) {
        changeEmitter.dispose();
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot watch directory '${params.path}': ${message}`);
      }

      // Watched dir deleted/renamed: emit a terminal event and clean up
      fsWatcher.on("error", (error) => {
        const instance = watchers.get(id);
        if (instance) {
          log.warn(undefined, "File watcher errored; disposing watcher", {
            id,
            path: instance.path,
            error: error instanceof Error ? error.message : String(error),
          });
          instance.changeEmitter.fire({ dirPath: instance.path });
          cleanup(id);
        }
      });

      watchers.set(id, {
        path: params.path,
        watcher: fsWatcher,
        changeEmitter,
        debounceTimer: null,
        pendingChangedPaths: new Set(),
        hasUnknownChangedPath: false,
      });

      return { id };
    },

    async unwatch(params: { id: string }): Promise<void> {
      cleanup(params.id);
    },

    disposeAll(): void {
      memoryDiagnostics.dispose();
      const ids = Array.from(watchers.keys());
      for (const id of ids) {
        cleanup(id);
      }
    },

    onDynamicChange(id: string): RpcEvent<FileWatchEvent> {
      const watcher = watchers.get(id);
      if (!watcher) {
        // Even after watch() resolves and before the renderer subscribes to onDynamicChange, the
        // underlying fs.watch can clean up on dir delete/rename/platform watcher errors. A stale
        // watcher id is recoverable; throwing into the RPC event subscription chain could kill the
        // host process.
        log.warn(undefined, "Ignoring subscription to a stale file watcher", { id });
        return Event.None;
      }
      return watcher.changeEmitter.event;
    },
  };
}
