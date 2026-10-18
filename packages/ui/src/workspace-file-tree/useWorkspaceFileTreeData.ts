/* eslint-disable max-lines -- the file tree data hook centralizes directory loads, watcher refreshes, and Git status races. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import {
  WORKSPACE_FILE_TREE_WATCH_BULK_REFRESH_THRESHOLD,
  WORKSPACE_FILE_TREE_WATCH_DEBOUNCE_MS,
  WORKSPACE_FILE_TREE_WATCH_REFRESH_CONCURRENCY,
  WORKSPACE_FILE_TREE_REFRESH_DIRECTORY_TIMEOUT_MS,
  WORKSPACE_FILE_TREE_REFRESH_GIT_TIMEOUT_MS,
} from "@/workspace-file-tree/constants.js";
import { replaceSetValue, toError } from "@/workspace-file-tree/helpers.js";
import {
  buildWorkspaceFileIgnoredPathSet,
  getWorkspaceFileDirectoryChildDepth,
  getWorkspaceFileParentDirectory,
  isWorkspaceFileTreeAutoFlattenableDirectory,
  isWorkspaceFilePathInside,
  type WorkspaceFileGitStatus,
  type WorkspaceFileTreeNode,
} from "@/workspace-file-tree/model.js";
import { loadWorkspaceFileTreeGitStatus } from "@/workspace-file-tree/gitStatus.js";
import { useWorkspaceFileTreeWatchers } from "@/workspace-file-tree/useWorkspaceFileTreeWatchers.js";
import { getWorkspaceFileTreeRefreshDirectoryPaths } from "@/workspace-file-tree/refreshDirectories.js";
import { useWorkspaceFileTreeRows } from "@/workspace-file-tree/useWorkspaceFileTreeRows.js";

type WorkspaceFileTreeDirectoryLoadResult = "loaded" | "stale" | "failed";

function createWorkspaceFileTreeTimeoutError(label: string, timeoutMs: number) {
  return new Error(`${label} timed out after ${timeoutMs}ms`);
}

async function withWorkspaceFileTreeTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(createWorkspaceFileTreeTimeoutError(label, timeoutMs));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export function useWorkspaceFileTreeData({
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
  enableWorkspaceFeatures = true,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  enableWorkspaceFeatures?: boolean;
}) {
  const { fileService, fileWatcherService, gitService } = useWorkspaceServices(
    workspacePath,
    workspaceRemoteSessionId,
    workspaceIdentity,
  );
  const workspaceGenerationRef = useRef(0);
  const requestVersionRef = useRef(0);
  const directoryRequestVersionRef = useRef<Map<string, number>>(new Map());
  const gitStatusRequestVersionRef = useRef(0);
  const refreshBatchVersionRef = useRef(0);
  const pendingWatchRefreshPathsRef = useRef<Set<string>>(new Set());
  const watchRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadingDirectoryPathsRef = useRef<Set<string>>(new Set());
  const loadedDirectoryPathsRef = useRef<Set<string>>(new Set());
  const [childrenByDirectory, setChildrenByDirectory] = useState<
    Map<string, WorkspaceFileTreeNode[]>
  >(new Map());
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadedDirectoryPaths, setLoadedDirectoryPaths] = useState<Set<string>>(new Set());
  const [loadingDirectoryPaths, setLoadingDirectoryPaths] = useState<Set<string>>(new Set());
  const [errorByDirectory, setErrorByDirectory] = useState<Map<string, Error>>(new Map());
  const [gitStatusByPath, setGitStatusByPath] = useState<Map<string, WorkspaceFileGitStatus>>(
    new Map(),
  );
  const [gitStatusAvailable, setGitStatusAvailable] = useState(false);
  const [ignoredPathSet, setIgnoredPathSet] = useState<Set<string>>(new Set());
  const [refreshingLoadedDirectories, setRefreshingLoadedDirectories] = useState(false);
  const refreshingLoadedDirectoriesRef = useRef(false);

  useEffect(() => {
    loadingDirectoryPathsRef.current = loadingDirectoryPaths;
  }, [loadingDirectoryPaths]);

  useEffect(() => {
    loadedDirectoryPathsRef.current = loadedDirectoryPaths;
  }, [loadedDirectoryPaths]);

  const setDirectoryLoading = useCallback((path: string, loading: boolean) => {
    const next = replaceSetValue(loadingDirectoryPathsRef.current, path, loading);
    loadingDirectoryPathsRef.current = next;
    setLoadingDirectoryPaths(next);
  }, []);

  const setDirectoryLoaded = useCallback((path: string, loaded: boolean) => {
    const next = replaceSetValue(loadedDirectoryPathsRef.current, path, loaded);
    loadedDirectoryPathsRef.current = next;
    setLoadedDirectoryPaths(next);
  }, []);

  const invalidateDirectoryRequest = useCallback((directoryPath: string) => {
    directoryRequestVersionRef.current.set(
      directoryPath,
      (directoryRequestVersionRef.current.get(directoryPath) ?? 0) + 1,
    );
  }, []);

  const cancelRefreshBatch = useCallback(() => {
    refreshBatchVersionRef.current += 1;
  }, []);

  const pruneDirectorySubtree = useCallback(
    (directoryPath: string) => {
      for (const path of directoryRequestVersionRef.current.keys()) {
        if (isWorkspaceFilePathInside(directoryPath, path)) {
          // Do not delete the request version when a subtree is pruned, or a recreated path
          // would reuse the old version and let a pre-delete response resurrect stale data.
          invalidateDirectoryRequest(path);
        }
      }
      setChildrenByDirectory((current) => {
        const next = new Map(current);
        for (const path of current.keys()) {
          if (isWorkspaceFilePathInside(directoryPath, path)) {
            next.delete(path);
          }
        }
        return next;
      });
      setExpandedPaths((current) => {
        const next = new Set(
          [...current].filter((path) => !isWorkspaceFilePathInside(directoryPath, path)),
        );
        return next;
      });
      setErrorByDirectory((current) => {
        const next = new Map(current);
        for (const path of current.keys()) {
          if (isWorkspaceFilePathInside(directoryPath, path)) {
            next.delete(path);
          }
        }
        return next;
      });

      const nextLoaded = new Set(
        [...loadedDirectoryPathsRef.current].filter(
          (path) => !isWorkspaceFilePathInside(directoryPath, path),
        ),
      );
      loadedDirectoryPathsRef.current = nextLoaded;
      setLoadedDirectoryPaths(nextLoaded);

      const nextLoading = new Set(
        [...loadingDirectoryPathsRef.current].filter(
          (path) => !isWorkspaceFilePathInside(directoryPath, path),
        ),
      );
      loadingDirectoryPathsRef.current = nextLoading;
      setLoadingDirectoryPaths(nextLoading);
    },
    [invalidateDirectoryRequest],
  );

  const loadDirectory = useCallback(
    async (
      directoryPath: string,
      childDepth: number,
      options?: {
        force?: boolean;
        silent?: boolean;
        workspaceGeneration?: number;
      },
    ): Promise<WorkspaceFileTreeDirectoryLoadResult> => {
      const force = options?.force ?? false;
      const silent = options?.silent ?? false;
      const expectedWorkspaceGeneration =
        options?.workspaceGeneration ?? workspaceGenerationRef.current;
      if (workspaceGenerationRef.current !== expectedWorkspaceGeneration) {
        return "stale";
      }
      if (
        !force &&
        (loadingDirectoryPathsRef.current.has(directoryPath) ||
          loadedDirectoryPathsRef.current.has(directoryPath))
      ) {
        return "loaded";
      }

      const requestVersion = requestVersionRef.current;
      // Manual refreshes and watchers may read the same directory concurrently; the per-directory
      // version keeps a late old snapshot from overwriting the newer tree.
      const directoryRequestVersion =
        (directoryRequestVersionRef.current.get(directoryPath) ?? 0) + 1;
      directoryRequestVersionRef.current.set(directoryPath, directoryRequestVersion);
      const isCurrentDirectoryRequest = () =>
        workspaceGenerationRef.current === expectedWorkspaceGeneration &&
        requestVersionRef.current === requestVersion &&
        directoryRequestVersionRef.current.get(directoryPath) === directoryRequestVersion;
      if (!silent) {
        setDirectoryLoading(directoryPath, true);
      }
      setErrorByDirectory((current) => {
        const next = new Map(current);
        next.delete(directoryPath);
        return next;
      });

      try {
        const entries = await fileService.readdir({
          path: directoryPath,
          includeHidden: true,
        });
        if (!isCurrentDirectoryRequest()) {
          return "stale";
        }

        if (enableWorkspaceFeatures) {
          void gitService
            .getIgnoredPaths({
              workspacePath,
              paths: entries.map((entry) => entry.path),
            })
            .then((ignoredPaths) => {
              if (!isCurrentDirectoryRequest()) {
                return;
              }
              const ignoredPathKeys = buildWorkspaceFileIgnoredPathSet(ignoredPaths);
              setIgnoredPathSet((current) => {
                const next = new Set(current);
                for (const path of entries.map((entry) => entry.path)) {
                  next.delete(path.replace(/\\/g, "/").replace(/\/+$/, ""));
                }
                for (const path of ignoredPathKeys) {
                  next.add(path);
                }
                return next;
              });
            })
            .catch((error) => {
              const nextError = toError(error);
              logger.warn("[WorkspaceFileTree] Failed to load Git ignored paths", {
                workspacePath,
                path: directoryPath,
                error: nextError.message,
              });
            });
        }

        setChildrenByDirectory((current) => {
          const next = new Map(current);
          next.set(
            directoryPath,
            entries.map((entry) => ({
              path: entry.path,
              name: entry.name,
              type: entry.type,
              isSymbolicLink: entry.isSymbolicLink === true,
              depth: childDepth,
            })),
          );
          return next;
        });
        setDirectoryLoaded(directoryPath, true);

        if (entries.length === 1 && isWorkspaceFileTreeAutoFlattenableDirectory(entries[0])) {
          // Fix: flatten-empty-directories only preloads plain single-child chains, avoiding symlink loops.
          void loadDirectory(entries[0].path, childDepth + 1, {
            silent: true,
            workspaceGeneration: expectedWorkspaceGeneration,
          });
        }
        return "loaded";
      } catch (error) {
        if (!isCurrentDirectoryRequest()) {
          return "stale";
        }
        const nextError = toError(error);
        logger.warn("[WorkspaceFileTree] Failed to read directory", {
          path: directoryPath,
          error: nextError.message,
        });
        setErrorByDirectory((current) => {
          const next = new Map(current);
          next.set(directoryPath, nextError);
          return next;
        });
        return "failed";
      } finally {
        if (isCurrentDirectoryRequest()) {
          setDirectoryLoading(directoryPath, false);
        }
      }
    },
    [
      enableWorkspaceFeatures,
      fileService,
      gitService,
      setDirectoryLoaded,
      setDirectoryLoading,
      workspacePath,
    ],
  );

  const loadGitStatus = useCallback(
    async (options?: { workspaceGeneration?: number }) => {
      const workspaceGeneration = options?.workspaceGeneration ?? workspaceGenerationRef.current;
      if (workspaceGenerationRef.current !== workspaceGeneration) {
        return;
      }
      if (!enableWorkspaceFeatures) {
        setGitStatusByPath(new Map());
        setGitStatusAvailable(false);
        return;
      }
      const requestVersion = gitStatusRequestVersionRef.current + 1;
      gitStatusRequestVersionRef.current = requestVersion;
      try {
        const gitStatus = await loadWorkspaceFileTreeGitStatus({
          gitService,
          workspacePath,
        });
        if (
          gitStatusRequestVersionRef.current !== requestVersion ||
          workspaceGenerationRef.current !== workspaceGeneration
        ) {
          return;
        }
        setGitStatusAvailable(gitStatus.available);
        setGitStatusByPath(gitStatus.statusByPath);
      } catch (error) {
        if (
          gitStatusRequestVersionRef.current !== requestVersion ||
          workspaceGenerationRef.current !== workspaceGeneration
        ) {
          return;
        }
        const nextError = toError(error);
        logger.warn("[WorkspaceFileTree] Failed to load Git status", {
          workspacePath,
          error: nextError.message,
        });
        // Fix: when Git status fails, drop the change filter entry points too, or users keep
        // filtering the tree from a stale status.
        setGitStatusAvailable(false);
        setGitStatusByPath(new Map());
      }
    },
    [enableWorkspaceFeatures, gitService, workspacePath],
  );

  const refreshDirectoryFromWatcher = useCallback(
    async (directoryPath: string, workspaceGeneration: number) => {
      if (workspaceGenerationRef.current !== workspaceGeneration) {
        return;
      }
      if (!isWorkspaceFilePathInside(workspacePath, directoryPath)) {
        return;
      }
      const refreshed = await loadDirectory(
        directoryPath,
        getWorkspaceFileDirectoryChildDepth(workspacePath, directoryPath),
        { force: true, silent: true, workspaceGeneration },
      );
      if (refreshed === "loaded" || refreshed === "stale") {
        return;
      }
      if (workspaceGenerationRef.current !== workspaceGeneration) {
        return;
      }
      // When a watched directory is deleted or renamed, prune the stale subtree before refreshing the parent.
      pruneDirectorySubtree(directoryPath);
      const parentDirectoryPath = getWorkspaceFileParentDirectory(workspacePath, directoryPath);
      if (parentDirectoryPath) {
        await loadDirectory(
          parentDirectoryPath,
          getWorkspaceFileDirectoryChildDepth(workspacePath, parentDirectoryPath),
          { force: true, silent: true, workspaceGeneration },
        );
      }
    },
    [loadDirectory, pruneDirectorySubtree, workspacePath],
  );

  const refreshDirectoryManually = useCallback(
    async (directoryPath: string, workspaceGeneration: number) => {
      if (workspaceGenerationRef.current !== workspaceGeneration) {
        return;
      }
      if (!isWorkspaceFilePathInside(workspacePath, directoryPath)) {
        return;
      }
      // readdir failures in manual refresh are usually remote disconnects, permissions, or
      // transient I/O; they do not mean the directory is gone, so do not reuse the watcher's
      // subtree pruning, which would wipe the old tree and error state.
      try {
        await withWorkspaceFileTreeTimeout(
          loadDirectory(
            directoryPath,
            getWorkspaceFileDirectoryChildDepth(workspacePath, directoryPath),
            { force: true, silent: true, workspaceGeneration },
          ),
          WORKSPACE_FILE_TREE_REFRESH_DIRECTORY_TIMEOUT_MS,
          `workspace file tree refresh ${directoryPath}`,
        );
      } catch (error) {
        if (workspaceGenerationRef.current !== workspaceGeneration) {
          return;
        }
        invalidateDirectoryRequest(directoryPath);
        const nextError = toError(error);
        logger.warn("[WorkspaceFileTree] Manual directory refresh timed out or failed", {
          path: directoryPath,
          error: nextError.message,
        });
        setErrorByDirectory((current) => {
          const next = new Map(current);
          next.set(directoryPath, nextError);
          return next;
        });
      }
    },
    [invalidateDirectoryRequest, loadDirectory, workspacePath],
  );

  const refreshDirectoryPaths = useCallback(
    async (
      directoryPaths: string[],
      workspaceGeneration: number,
      refreshBatchVersion: number,
      refreshDirectory: (directoryPath: string, workspaceGeneration: number) => Promise<void>,
    ) => {
      const queue = [...new Set(directoryPaths)];
      const workerCount = Math.min(WORKSPACE_FILE_TREE_WATCH_REFRESH_CONCURRENCY, queue.length);
      const runWorker = async () => {
        while (
          queue.length > 0 &&
          workspaceGenerationRef.current === workspaceGeneration &&
          refreshBatchVersionRef.current === refreshBatchVersion
        ) {
          const directoryPath = queue.shift();
          if (directoryPath) {
            await refreshDirectory(directoryPath, workspaceGeneration);
          }
        }
      };

      await Promise.allSettled(Array.from({ length: workerCount }, runWorker));
    },
    [],
  );

  const refreshLoadedDirectories = useCallback(async () => {
    if (refreshingLoadedDirectoriesRef.current) {
      return;
    }
    const workspaceGeneration = workspaceGenerationRef.current;
    const refreshBatchVersion = refreshBatchVersionRef.current + 1;
    refreshBatchVersionRef.current = refreshBatchVersion;
    refreshingLoadedDirectoriesRef.current = true;
    setRefreshingLoadedDirectories(true);
    const directoryPaths = getWorkspaceFileTreeRefreshDirectoryPaths({
      workspacePath,
      expandedPaths,
      loadedDirectoryPaths: loadedDirectoryPathsRef.current,
    });
    // Manual refreshes used to re-read only the workspace root; loaded subdirectories kept stale
    // children, so AI renames/additions there never appeared. Refresh every loaded or expanded
    // directory without a full-repo recursive scan, keeping large-repo refresh costs bounded.
    try {
      await refreshDirectoryPaths(
        directoryPaths,
        workspaceGeneration,
        refreshBatchVersion,
        refreshDirectoryManually,
      );
      // The workspace may be switched while a stale refresh is in flight; once it settles, the
      // old gitService must not overwrite the new workspace's Git status.
      if (
        workspaceGenerationRef.current === workspaceGeneration &&
        refreshBatchVersionRef.current === refreshBatchVersion
      ) {
        try {
          await withWorkspaceFileTreeTimeout(
            loadGitStatus({ workspaceGeneration }),
            WORKSPACE_FILE_TREE_REFRESH_GIT_TIMEOUT_MS,
            "workspace file tree git refresh",
          );
        } catch (error) {
          if (
            workspaceGenerationRef.current === workspaceGeneration &&
            refreshBatchVersionRef.current === refreshBatchVersion
          ) {
            gitStatusRequestVersionRef.current += 1;
            const nextError = toError(error);
            logger.warn("[WorkspaceFileTree] Manual Git status refresh timed out or failed", {
              workspacePath,
              error: nextError.message,
            });
          }
        }
      }
    } finally {
      if (
        workspaceGenerationRef.current === workspaceGeneration &&
        refreshBatchVersionRef.current === refreshBatchVersion
      ) {
        refreshingLoadedDirectoriesRef.current = false;
        setRefreshingLoadedDirectories(false);
      }
    }
  }, [
    expandedPaths,
    loadGitStatus,
    refreshDirectoryManually,
    refreshDirectoryPaths,
    workspacePath,
  ]);

  const flushWatchRefreshQueue = useCallback(() => {
    const changedDirectoryPaths = [...pendingWatchRefreshPathsRef.current];
    pendingWatchRefreshPathsRef.current = new Set();
    if (changedDirectoryPaths.length === 0) {
      return;
    }
    const refreshPaths =
      changedDirectoryPaths.length > WORKSPACE_FILE_TREE_WATCH_BULK_REFRESH_THRESHOLD
        ? [workspacePath, ...expandedPaths]
        : changedDirectoryPaths;
    const workspaceGeneration = workspaceGenerationRef.current;
    const refreshBatchVersion = refreshBatchVersionRef.current;
    void refreshDirectoryPaths(
      refreshPaths,
      workspaceGeneration,
      refreshBatchVersion,
      refreshDirectoryFromWatcher,
    ).finally(() => {
      if (
        workspaceGenerationRef.current === workspaceGeneration &&
        refreshBatchVersionRef.current === refreshBatchVersion
      ) {
        void loadGitStatus({ workspaceGeneration });
      }
    });
  }, [
    expandedPaths,
    loadGitStatus,
    refreshDirectoryFromWatcher,
    refreshDirectoryPaths,
    workspacePath,
  ]);

  const enqueueWatchRefresh = useCallback(
    (directoryPath: string) => {
      if (!isWorkspaceFilePathInside(workspacePath, directoryPath)) {
        return;
      }
      pendingWatchRefreshPathsRef.current.add(directoryPath);
      if (watchRefreshTimerRef.current) {
        clearTimeout(watchRefreshTimerRef.current);
      }
      watchRefreshTimerRef.current = setTimeout(() => {
        watchRefreshTimerRef.current = null;
        flushWatchRefreshQueue();
      }, WORKSPACE_FILE_TREE_WATCH_DEBOUNCE_MS);
    },
    [flushWatchRefreshQueue, workspacePath],
  );

  useEffect(() => {
    workspaceGenerationRef.current += 1;
    const workspaceGeneration = workspaceGenerationRef.current;
    requestVersionRef.current += 1;
    cancelRefreshBatch();
    directoryRequestVersionRef.current = new Map();
    loadingDirectoryPathsRef.current = new Set();
    loadedDirectoryPathsRef.current = new Set();
    setChildrenByDirectory(new Map());
    setExpandedPaths(new Set());
    setLoadedDirectoryPaths(new Set());
    setLoadingDirectoryPaths(new Set());
    setErrorByDirectory(new Map());
    setGitStatusByPath(new Map());
    setGitStatusAvailable(false);
    setIgnoredPathSet(new Set());
    refreshingLoadedDirectoriesRef.current = false;
    setRefreshingLoadedDirectories(false);
    pendingWatchRefreshPathsRef.current = new Set();
    if (watchRefreshTimerRef.current) {
      clearTimeout(watchRefreshTimerRef.current);
      watchRefreshTimerRef.current = null;
    }
    void loadDirectory(workspacePath, 0, {
      force: true,
      workspaceGeneration,
    });
    void loadGitStatus({ workspaceGeneration });
    return () => {
      cancelRefreshBatch();
    };
  }, [cancelRefreshBatch, loadDirectory, loadGitStatus, workspaceIdentity, workspacePath]);

  const rows = useWorkspaceFileTreeRows({
    workspacePath,
    childrenByDirectory,
    expandedPaths,
    loadedDirectoryPaths,
    loadingDirectoryPaths,
    errorByDirectory,
    gitStatusByPath,
  });

  const watchedDirectoryPaths = useMemo(
    () => new Set([workspacePath, ...expandedPaths]),
    [expandedPaths, workspacePath],
  );
  const effectiveWatchedDirectoryPaths = useMemo(
    () => (enableWorkspaceFeatures ? watchedDirectoryPaths : new Set<string>()),
    [enableWorkspaceFeatures, watchedDirectoryPaths],
  );

  useWorkspaceFileTreeWatchers({
    fileWatcherService,
    watchedDirectoryPaths: effectiveWatchedDirectoryPaths,
    onDirectoryChange: enqueueWatchRefresh,
  });

  return {
    rows,
    setExpandedPaths,
    loadedDirectoryPaths,
    loadingDirectoryPaths,
    errorByDirectory,
    gitStatusByPath,
    gitStatusAvailable,
    ignoredPathSet,
    refreshingLoadedDirectories,
    loadDirectory,
    loadGitStatus,
    refreshLoadedDirectories,
    setLoadedDirectoryPaths,
    loadedDirectoryPathsRef,
  };
}
