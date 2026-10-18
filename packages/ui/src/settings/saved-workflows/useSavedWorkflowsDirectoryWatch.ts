import { useEffect } from "react";
import type { IFileWatcherService } from "@zcode/services";
import { logger } from "@/logger.js";

const WATCH_DEBOUNCE_MS = 300;

/** workspacePath may be a Windows path; join the subdirectory with its own separator, never mixing "/" into "\\" paths. */
function savedWorkflowsDirectoryPath(workspacePath: string): string {
  const separator = workspacePath.includes("\\") && !workspacePath.includes("/") ? "\\" : "/";
  const trimmed = workspacePath.replace(/[\\/]+$/u, "");
  return `${trimmed}${separator}.zcode${separator}workflows`;
}

/**
 * Directory watch: the hub refreshes automatically once SaveWorkflow persists during a conversation.
 * A missing directory makes watch fail — that is normal (most projects never saved a workflow);
 * skip silently and rely on tab switches / manual refresh. Non-recursive: this level only
 * (recursive fs.watch has known issues on Linux). When the service instance changes (remote
 * reconnect), effect deps tear down the old watcher and rebuild; no stale host id leaks.
 *
 * Project groups pass `workspacePath` (joined into `<ws>/.zcode/workflows`); the global group passes
 * `directory` (the absolute dir from the protocol list, i.e. `~/.zcode/workflows`). Mutually
 * exclusive — `directory` wins.
 */
export function useSavedWorkflowsDirectoryWatch({
  fileWatcherService,
  workspacePath,
  directory,
  enabled,
  refresh,
}: {
  fileWatcherService: IFileWatcherService;
  workspacePath?: string | null | undefined;
  directory?: string | null | undefined;
  enabled: boolean;
  refresh: (options: { bypassCache?: boolean }) => Promise<void>;
}): void {
  const resolvedDirectory =
    directory ?? (workspacePath ? savedWorkflowsDirectoryPath(workspacePath) : null);
  useEffect(() => {
    if (!enabled || !resolvedDirectory) return;
    let disposed = false;
    let watchId: string | null = null;
    let subscription: { dispose: () => void } | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const directoryPath = resolvedDirectory;
    void fileWatcherService
      .watch({ path: directoryPath })
      .then(({ id }) => {
        if (disposed) {
          void fileWatcherService.unwatch({ id });
          return;
        }
        watchId = id;
        subscription = fileWatcherService.onDynamicChange(id)(() => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            void refresh({ bypassCache: true });
          }, WATCH_DEBOUNCE_MS);
        });
      })
      .catch((error: unknown) => {
        logger.debug("[SavedWorkflows] Failed to watch .zcode/workflows (directory may not exist yet)", {
          path: directoryPath,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      subscription?.dispose();
      if (watchId) void fileWatcherService.unwatch({ id: watchId });
    };
  }, [enabled, fileWatcherService, refresh, resolvedDirectory]);
}
