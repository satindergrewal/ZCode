/**
 * useTabPersistence: tab session persistence.
 *
 * - On mount, restore the last open tabs from settingService.
 * - Subscribe to tab store changes; write back debounced.
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

export interface TabPersistenceRestoreLifecycle {
  settingService?: ISettingService;
  restoreSession: boolean;
  completed: boolean;
  fullyCompleted: boolean;
}

export interface TabPersistenceRestoreResult {
  /** App-owned paths recognized during restore; never backfilled as recent projects. */
  excludedRecentProjectPaths?: readonly string[];
  /** After the active workspace restores, backfill inactive ones in a post-first-frame idle pass. */
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

export function hasCompletedTabPersistenceInitialRestore({
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

export function getRecentProjectPathsFromSettings(
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

export function buildRestoredRecentProjectPaths(
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
  /** Restore the last session; true for the first window, false for new ones. */
  restoreSession?: boolean;
  /** Write sessions back to global settings; first window true, new windows false. */
  persistSession?: boolean;
  /** Custom restore flow; falls back to the default local tab restore when omitted. */
  restorePersistedSession?: (
    settings: AppSettings,
  ) => Promise<TabPersistenceRestoreResult | void> | TabPersistenceRestoreResult | void;
  /** Custom persistence patch; when omitted only the local workspace session is written. */
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
  // In the render where the provider/OAuth gate flips false->true, restore has not yet
  // set isRestoring. Bind completion to the active settingService + restoreSession so
  // initialWorkspacePath cannot addTab before restoreTabs.
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

  // Restore session
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
    // The root first paints the open-workspace page from the empty default store, then this
    // async restore lands, flashing the picker at startup.
    // Expose a restoring flag so the shell keeps loading until the check settles
    // instead of flashing the default empty state.
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
        // recentProjects updated only on manual open-workspace picks, while most entries come
        // from session restore, so it stayed empty. Restore now spans local+remote on a shared
        // lastActiveTabIndex; extract local workspaces from the full session snapshot back into
        // recentProjects
        // so remote restore never regresses history to manual-opens-only.
        // Legacy sessions lost workspacePurpose and wrote the app-owned default cwd
        // into recentProjects as a plain project. Filtering this restore is not enough;
        // clean historical residue too, or the picker renders it as a workspace again.
        const merged = buildRestoredRecentProjectPaths(settings, excludedRecentProjectPaths);
        const persistedRecent = settings.recentProjects ?? [];
        if (
          merged.length !== persistedRecent.length ||
          merged.some((p, i) => p !== persistedRecent[i])
        ) {
          settingService.update({ recentProjects: merged }).catch((err) => {
            logger.error("[useTabPersistence] failed to sync recentProjects:", err);
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
              // active-only is a startup transient, never persisted early; the merged store event
              // is the first complete snapshot allowed to persist.
              initialRestoreFullyCompletedRef.current = true;
              try {
                deferredRestore();
              } catch (error) {
                logger.error("[useTabPersistence] failed to backfill inactive workspace:", error);
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
        logger.error("[useTabPersistence] failed to restore tabs:", err);
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

  // Persist: subscribe to store changes, write back debounced.
  useEffect(() => {
    if (!settingService || !persistSession) return;

    const unsubscribe = store.subscribe((state) => {
      if (!initialRestoreFullyCompletedRef.current) {
        return;
      }
      if (timerRef.current) clearTimeout(timerRef.current);

      timerRef.current = setTimeout(() => {
        // A secondary window writing its own tabs to global settings clobbers the session
        // the main window wants restored, landing in the wrong window next launch.
        // Only the first local window may persist.
        settingService
          .update((buildPersistPatch ?? buildDefaultPersistPatch)(state))
          .catch((err) => {
            logger.error("[useTabPersistence] failed to persist:", err);
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
