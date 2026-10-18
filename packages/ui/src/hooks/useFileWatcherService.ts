/**
 * useFileWatcherService — filesystem watcher hooks.
 *
 * Adds an fs.watch subscription on top of useReaddir: directory changes trigger an
 * automatic refresh, no manual reload.
 */
import { useState, useEffect, useCallback } from "react";
import type { FileEntry } from "@zcode/shared";
import type { IDisposable } from "@zcode/rpc";
import { useServices } from "./useServices.js";
import { logger } from "@/logger.js";

/**
 * Directory reader with filesystem watching.
 *
 * Same interface as useReaddir, but watches the directory on mount, refreshes on change
 * events, and unwatches on unmount.
 */
export function useWatchedReaddir(path: string) {
  const { fileService, fileWatcherService } = useServices();
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fileService.readdir({ path });
      setEntries(result);
    } catch (e) {
      setError(e instanceof Error ? e : new Error(String(e)));
    } finally {
      setLoading(false);
    }
  }, [fileService, path]);

  // Initial read
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Filesystem watch: watch on mount, unwatch on unmount
  useEffect(() => {
    let cancelled = false;
    let watcherId: string | null = null;
    const disposables: IDisposable[] = [];

    // Hold refresh in a ref so event callbacks never close over a stale closure.
    const refreshRef = { current: refresh };

    fileWatcherService
      .watch({ path })
      .then(({ id }) => {
        if (cancelled) {
          // Already unmounted; release the watcher immediately.
          fileWatcherService.unwatch({ id });
          return;
        }
        watcherId = id;

        // On change events, refresh the directory listing.
        const sub = fileWatcherService.onDynamicChange(id)(() => {
          logger.info(`[FileWatcher] directory changed; auto-refresh path=${path}`);
          refreshRef.current();
        });
        disposables.push(sub);
      })
      .catch((err) => {
        // A watch failure does not break the basics (readdir still works); log only.
        if (!cancelled) {
          logger.warn(`[FileWatcher] failed to watch directory path=${path}:`, err);
        }
      });

    return () => {
      cancelled = true;
      for (const d of disposables) d.dispose();
      if (watcherId) fileWatcherService.unwatch({ id: watcherId });
    };
  }, [fileWatcherService, path, refresh]);

  return { entries, loading, error, refresh };
}
