/**
 * useTabPersistence -- tab persistence.
 *
 * - Restores the last opened tabs from settingService on mount.
 * - Subscribes to tab store changes and writes back to settingService, debounced.
 */
import { useEffect, useRef } from "react";
import { useState } from "react";
import type { AppSettings } from "@zcode/shared";
import type { ISettingService } from "@zcode/services";
import { readPersistedWorkspaceSessionEntries } from "@/lib/remoteWorkspaceHistory.js";
import { useTabStoreApi } from "../store/TabStoreProvider.js";
import { isWorkspaceTab, type TabStoreState } from "../store/tabStore.js";
import { logger } from "../logger.js";

const DEBOUNCE_MS = 300;

interface TabPersistenceRestoreLifecycle {
  settingService?: ISettingService;
  restoreSession: boolean;
  completed: boolean;
  fullyCompleted: boolean;
}

interface TabPersistenceRestoreResult {
  /** App-owned paths identified during restore; never backfilled as recent projects. */
  excludedRecentProjectPaths?: readonly string[];
  /** Once the active workspace is restored, completes inactive workspaces in a post-first-frame idle period. */
  deferredRestore?: () => void;
}

function scheduleDeferredRestore(callback: () => void): () => void {
  if (typeof globalThis.requestIdleCallback === "function") {
    const idleCallbackId = globalThis.requestIdleCallback(() => callback(), {
      timeout: 1_000,
    });
    return () => globalThis.cancelIdleCallback(idleCallbackId);
  }

  const timer = globalThis.setTimeout(callback, 0);
  return () => globalThis.clearTimeout(timer);
}

function hasCompletedTabPersistenceInitialRestore({
  settingService,
  restoreSession,
  restoreLifecycle,
}: {
  settingService?: ISettingService;
  restoreSession: boolean;
  restoreLifecycle: TabPersistenceRestoreLifecycle;
}): boolean {
  const shouldRestoreSession = Boolean(settingService && restoreSession);
  return (
    !shouldRestoreSession ||
    (restoreLifecycle.settingService === settingService &&
      restoreLifecycle.restoreSession === restoreSession &&
      restoreLifecycle.completed)
  );
}

function getRecentProjectPathsFromSettings(
  settings: Pick<AppSettings, "lastWorkspaceSession">,
  excludedPaths: readonly string[] = [],
): string[] {
  const excludedPathSet = new Set(excludedPaths);
  return readPersistedWorkspaceSessionEntries(settings)
    .flatMap((entry) =>
      entry.kind === "local" &&
      entry.workspacePurpose !== "conversation" &&
      !excludedPathSet.has(entry.workspacePath)
        ? [entry.workspacePath]
        : [],
    )
    .slice(0, 10);
}

function buildRestoredRecentProjectPaths(
  settings: Pick<AppSettings, "lastWorkspaceSession" | "recentProjects">,
  excludedPaths: readonly string[] = [],
): string[] {
  const excludedPathSet = new Set(excludedPaths);
  const existingRecent = (settings.recentProjects ?? []).filter(
    (path) => !excludedPathSet.has(path),
  );
  const restoredProjects = getRecentProjectPathsFromSettings(settings, excludedPaths);
  return [...new Set([...existingRecent, ...restoredProjects])].slice(0, 10);
}

function buildDefaultPersistPatch(state: TabStoreState): Partial<AppSettings> {
  const workspaceTabs = state.tabs.filter(isWorkspaceTab).filter((tab) => !tab.remoteSessionId);
  const activeIndex = state.activeWorkspacePath
    ? workspaceTabs.findIndex((tab) => tab.workspacePath === state.activeWorkspacePath)
    : 0;

  return {
    lastWorkspaceSession: workspaceTabs.map((tab) => ({
      kind: "local" as const,
      workspacePath: tab.workspacePath,
      ...(tab.workspacePurpose ? { workspacePurpose: tab.workspacePurpose } : {}),
    })),
    lastActiveTabIndex: Math.max(activeIndex, 0),
  };
}

export function useTabPersistence({
  settingService,
  restoreSession = true,
  persistSession = restoreSession,
  restorePersistedSession,
  buildPersistPatch,
}: {
  settingService?: ISettingService;
  /** Whether to restore the last session: true for the first window, false for new windows. */
  restoreSession?: boolean;
  /** Whether to write this window's session back to global settings: true for the first window, false for new windows. */
  persistSession?: boolean;
  /** Custom restore flow; falls back to the default local tab restore when omitted. */
  restorePersistedSession?: (
    settings: AppSettings,
  ) => Promise<TabPersistenceRestoreResult | void> | TabPersistenceRestoreResult | void;
  /** Custom persist patch; when omitted, only the local workspace session is written back. */
  buildPersistPatch?: (state: TabStoreState) => Partial<AppSettings>;
}) {
  const store = useTabStoreApi();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldRestoreSession = Boolean(settingService && restoreSession);
  const initialRestoreFullyCompletedRef = useRef(!shouldRestoreSession);
  const [restoreLifecycle, setRestoreLifecycle] = useState<TabPersistenceRestoreLifecycle>(() => ({
    settingService,
    restoreSession,
    completed: !shouldRestoreSession,
    fullyCompleted: !shouldRestoreSession,
  }));
  // In the same render where the provider/OAuth gate flips false->true, the restore effect
  // has not yet set isRestoring. Bind completion to the current settingService +
  // restoreSession so initialWorkspacePath cannot addTab ahead of restoreTabs.
  const hasCompletedInitialRestore = hasCompletedTabPersistenceInitialRestore({
    settingService,
    restoreSession,
    restoreLifecycle,
  });
  const hasCompletedFullRestore =
    !shouldRestoreSession ||
    (restoreLifecycle.settingService === settingService &&
      restoreLifecycle.restoreSession === restoreSession &&
      restoreLifecycle.fullyCompleted);
  const isRestoring = shouldRestoreSession && !hasCompletedInitialRestore;

  // Session restore
  useEffect(() => {
    if (!settingService || !restoreSession) {
      initialRestoreFullyCompletedRef.current = true;
      setRestoreLifecycle({
        settingService,
        restoreSession,
        completed: true,
        fullyCompleted: true,
      });
      return;
    }

    let cancelled = false;
    let cancelDeferredRestore: (() => void) | null = null;
    initialRestoreFullyCompletedRef.current = false;
    // The root first frame renders the default empty tab store, i.e. the open-workspace
    // placeholder, before lastWorkspaceSession is restored asynchronously here -- a visible
    // "open project" flash on startup. Expose the restoring state so the shell keeps showing
    // loading until the session check finishes instead of flashing the default empty state.
    setRestoreLifecycle({
      settingService,
      restoreSession,
      completed: false,
      fullyCompleted: false,
    });

    settingService
      .get()
      .then(async (settings) => {
        let restoreResult: TabPersistenceRestoreResult | void = undefined;
        if (restorePersistedSession) {
          restoreResult = await restorePersistedSession(settings);
        } else {
          const tabs = readPersistedWorkspaceSessionEntries(settings).flatMap((entry) =>
            entry.kind === "local"
              ? [
                  entry.workspacePurpose
                    ? {
                        workspacePath: entry.workspacePath,
                        workspacePurpose: entry.workspacePurpose,
                      }
                    : entry.workspacePath,
                ]
              : [],
          );
          const activeIndex = settings.lastActiveTabIndex ?? 0;
          if (tabs.length > 0) {
            logger.info("[useTabPersistence] restored tabs:", tabs);
            store.getState().restoreTabs(tabs, activeIndex);
          }
        }

        const excludedRecentProjectPaths = restoreResult?.excludedRecentProjectPaths ?? [];
        // recentProjects only updated when the user manually picks a project, yet most
        // workspaces are opened via session restore, so recentProjects stayed empty. Session
        // restore now covers local + remote and both share lastActiveTabIndex. Derive local
        // workspaces from the full session snapshot and backfill recentProjects, so remote
        // restore does not regress history to "manually opened local projects only".
        // Legacy entries that lost workspacePurpose wrote the app-owned default cwd into
        // recentProjects as a plain project. Filtering just this restore's session is not
        // enough -- stale history must be cleaned too, or the project picker renders it as a
        // workspace again.
        const merged = buildRestoredRecentProjectPaths(settings, excludedRecentProjectPaths);
        const persistedRecent = settings.recentProjects ?? [];
        if (
          merged.length !== persistedRecent.length ||
          merged.some((p, i) => p !== persistedRecent[i])
        ) {
          settingService.update({ recentProjects: merged }).catch((err) => {
            logger.error("[useTabPersistence] Failed to sync recentProjects:", err);
          });
        }
        if (!cancelled) {
          const deferredRestore = restoreResult?.deferredRestore;
          setRestoreLifecycle({
            settingService,
            restoreSession,
            completed: true,
            fullyCompleted: !deferredRestore,
          });
          if (deferredRestore) {
            cancelDeferredRestore = scheduleDeferredRestore(() => {
              if (cancelled) {
                return;
              }
              // The active-only state is a startup transient and must not be persisted early;
              // the store event emitted by the completion merge is the first full session
              // snapshot allowed to be written back.
              initialRestoreFullyCompletedRef.current = true;
              try {
                deferredRestore();
              } catch (error) {
                logger.error("[useTabPersistence] Failed to restore inactive workspaces:", error);
              } finally {
                if (!cancelled) {
                  setRestoreLifecycle({
                    settingService,
                    restoreSession,
                    completed: true,
                    fullyCompleted: true,
                  });
                }
              }
            });
          } else {
            initialRestoreFullyCompletedRef.current = true;
          }
        }
      })
      .catch((err) => {
        logger.error("[useTabPersistence] Failed to restore tabs:", err);
        if (!cancelled) {
          initialRestoreFullyCompletedRef.current = true;
          setRestoreLifecycle({
            settingService,
            restoreSession,
            completed: true,
            fullyCompleted: true,
          });
        }
      });

    return () => {
      cancelled = true;
      cancelDeferredRestore?.();
    };
  }, [restorePersistedSession, settingService, restoreSession, store]);

  // Persistence: subscribe to store changes, write back debounced.
  useEffect(() => {
    if (!settingService || !persistSession) return;

    const unsubscribe = store.subscribe((state) => {
      if (!initialRestoreFullyCompletedRef.current) {
        return;
      }
      if (timerRef.current) clearTimeout(timerRef.current);

      timerRef.current = setTimeout(() => {
        // If a secondary window also wrote its tabs to global settings, it would overwrite
        // the session the main window wants to restore and recover into the wrong window on
        // next launch. Persisting is therefore a separate toggle; only the first local
        // window writes back.
        settingService
          .update((buildPersistPatch ?? buildDefaultPersistPatch)(state))
          .catch((err) => {
            logger.error("[useTabPersistence] Failed to persist tabs:", err);
          });
      }, DEBOUNCE_MS);
    });

    return () => {
      unsubscribe();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [buildPersistPatch, persistSession, store, settingService]);

  return { isRestoring, hasCompletedInitialRestore, hasCompletedFullRestore };
}
