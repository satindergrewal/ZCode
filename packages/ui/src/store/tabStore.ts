/* oxlint-disable eslint(max-lines) */
/**
 * Tab store - multi-tab state.
 *
 * Each window owns its tab store (no cross-window broadcast).
 * Tab state persists via settingService (see useTabPersistence).
 */
import { create } from "zustand";
import {
  createUuid,
  type RemoteTarget,
  type TabId,
  type TabState,
  type WorkspacePurpose,
} from "@zcode/shared";
import {
  persistWorkspaceExpandedPreference,
  readWorkspaceExpansionState,
  resolveExpandedWorkspacePaths,
  type WorkspaceExpansionState,
} from "@/lib/workspaceExpansionPreference.js";
import { isSameWorkspaceTab } from "@/store/tabWorkspaceIdentity.js";

export const SETTINGS_TAB_ID = "__settings__" satisfies TabId;

export type WorkspaceAvailability = "available" | "unavailable-local-directory";

export interface SettingsTabState {
  id: typeof SETTINGS_TAB_ID;
  kind: "settings";
  label: "settings";
}

export interface WorkspaceTabState extends TabState {
  kind: "workspace";
  /** One-shot startup validation result; never persisted, never rechecked during the run. */
  availability?: WorkspaceAvailability;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  remoteHistoryId?: string;
  workspaceIdentity?: string;
  localWorkspacePath?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface WorkspaceTabOptions {
  availability?: WorkspaceAvailability;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  remoteHistoryId?: string;
  workspaceIdentity?: string;
  localWorkspacePath?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface RestorableWorkspaceTab {
  workspacePath: string;
  availability?: WorkspaceAvailability;
  remoteSessionId?: string;
  remoteTarget?: RemoteTarget;
  workspaceIdentity?: string;
  localWorkspacePath?: string;
  workspacePurpose?: WorkspacePurpose;
}

export type WindowTabState = WorkspaceTabState | SettingsTabState;

export function isWorkspaceTab(tab: WindowTabState): tab is WorkspaceTabState {
  return tab.kind === "workspace";
}

export function isWorkspaceTabReadOnly(tab: WindowTabState): tab is WorkspaceTabState & {
  availability: "unavailable-local-directory";
} {
  return isWorkspaceTab(tab) && tab.availability === "unavailable-local-directory";
}

export function isWorkspaceReadOnly(
  state: Pick<TabStoreState, "tabs">,
  workspacePath: string,
  workspaceIdentity?: string,
): boolean {
  const workspaceKey = workspaceIdentity?.trim() || workspacePath;
  return state.tabs.some(
    (tab) =>
      isWorkspaceTabReadOnly(tab) &&
      (tab.workspaceIdentity?.trim() || tab.workspacePath) === workspaceKey,
  );
}

export function isSettingsTab(tab: WindowTabState): tab is SettingsTabState {
  return tab.kind === "settings";
}

// ============================================================================
// State shape
// ============================================================================

export interface TabStoreState {
  /** Every open tab of this window (ordered) */
  tabs: WindowTabState[];
  /** Currently active tab id; null when none */
  activeTabId: TabId | null;
  /** Current or last-active workspace path */
  activeWorkspacePath: string | null;
  /** Current or last-active workspace identity (same-path remote isolation) */
  activeWorkspaceIdentity: string | null;
  /** Workspace paths expanded in the left sidebar */
  expandedWorkspacePaths: Set<string>;
  /** Add a tab; returns the new tab id */
  addTab: (workspacePath: string, options?: WorkspaceTabOptions) => TabId;
  /** Ensure the workspace is in the task-pane sources without stealing focus */
  ensureWorkspaceTab: (workspacePath: string, options?: WorkspaceTabOptions) => TabId;
  /** Close a tab */
  closeTab: (tabId: TabId) => void;
  /** Activate a tab */
  activateTab: (tabId: TabId) => void;
  /** Drag reorder: move the tab at fromIndex to toIndex */
  reorderTabs: (fromIndex: number, toIndex: number) => void;
  /** Reorder by workspace subsequence only, keeping slots of non-workspace tabs such as Settings */
  reorderWorkspaceTabs: (fromIndex: number, toIndex: number) => void;
  /** Open the settings tab (unique per window) */
  openSettingsTab: () => void;
  /** Activate a tab by workspace path (for cross-window focus); returns whether found */
  activateTabByPath: (path: string, options?: { workspaceIdentity?: string }) => boolean;
  /** Toggle a workspace expanded/collapsed */
  toggleWorkspaceExpanded: (path: string) => void;
  /** Expand every workspace in the task pane */
  expandAllWorkspaceTabs: (paths: string[]) => void;
  /** Collapse every workspace in the task pane */
  collapseAllWorkspaceTabs: (paths: string[]) => void;
  /** Batch-restore tabs (startup, from persistence) */
  restoreTabs: (tabs: Array<string | RestorableWorkspaceTab>, activeIndex: number) => void;
  /** Backfill persisted tabs after the first frame; keeps the active identity and tabs added meanwhile. */
  completeTabRestore: (tabs: Array<string | RestorableWorkspaceTab>) => void;
}

// ============================================================================
// Helpers
// ============================================================================

/** Derive the tab display name from the last path segment. */
function labelFromPath(path: string): string {
  // Handle both Windows backslashes and Unix slashes.
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function createWorkspaceTab(
  workspacePath: string,
  options?: WorkspaceTabOptions,
): WorkspaceTabState {
  return {
    id: createUuid(),
    kind: "workspace",
    workspacePath,
    label: labelFromPath(workspacePath),
    availability: options?.availability,
    remoteSessionId: options?.remoteSessionId,
    remoteTarget: options?.remoteTarget,
    workspaceIdentity: options?.workspaceIdentity,
    localWorkspacePath: options?.localWorkspacePath,
    workspacePurpose: options?.workspacePurpose,
  };
}

function mergeWorkspaceTabOptions(
  tab: WorkspaceTabState,
  options?: WorkspaceTabOptions,
): WorkspaceTabState {
  return {
    ...tab,
    availability: options?.availability ?? tab.availability,
    remoteSessionId: options?.remoteSessionId ?? tab.remoteSessionId,
    remoteTarget: options?.remoteTarget ?? tab.remoteTarget,
    remoteHistoryId: options?.remoteHistoryId ?? tab.remoteHistoryId,
    workspaceIdentity: options?.workspaceIdentity ?? tab.workspaceIdentity,
    localWorkspacePath: options?.localWorkspacePath ?? tab.localWorkspacePath,
    workspacePurpose: options?.workspacePurpose ?? tab.workspacePurpose,
  };
}

function normalizeRestorableWorkspaceTab(
  tab: string | RestorableWorkspaceTab,
): RestorableWorkspaceTab {
  if (typeof tab === "string") {
    return {
      workspacePath: tab,
    };
  }

  return tab;
}

function createSettingsTab(): SettingsTabState {
  return {
    id: SETTINGS_TAB_ID,
    kind: "settings",
    label: "settings",
  };
}

function moveItem<T>(items: readonly T[], fromIndex: number, toIndex: number): T[] {
  const nextItems = [...items];
  const [movedItem] = nextItems.splice(fromIndex, 1);
  if (!movedItem) {
    return nextItems;
  }

  nextItems.splice(toIndex, 0, movedItem);
  return nextItems;
}

function ensureWorkspaceExpanded(
  expandedWorkspacePaths: Set<string>,
  workspacePath: string,
): Set<string> {
  if (expandedWorkspacePaths.has(workspacePath)) {
    return expandedWorkspacePaths;
  }

  const next = new Set(expandedWorkspacePaths);
  next.add(workspacePath);
  return next;
}

function pruneExpandedWorkspace(
  expandedWorkspacePaths: Set<string>,
  workspacePath: string,
): Set<string> {
  if (!expandedWorkspacePaths.has(workspacePath)) {
    return expandedWorkspacePaths;
  }

  const next = new Set(expandedWorkspacePaths);
  next.delete(workspacePath);
  return next;
}

// ============================================================================
// Store creation
// ============================================================================

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function createTabStore(storage: StorageLike | null | undefined = undefined) {
  return create<TabStoreState>()((set, get) => ({
    tabs: [],
    activeTabId: null,
    activeWorkspacePath: null,
    activeWorkspaceIdentity: null,
    expandedWorkspacePaths: new Set<string>(),

    addTab: (workspacePath: string, options) => {
      // Tab reuse used to match on workspacePath plus history/session fragments, which
      // collapsed same-path different-remote targets (e.g. 10.0.0.1:/home/dev vs
      // 10.0.0.2:/home/dev) into one tab. Match on workspaceIdentity
      // (authority + canonicalPath) first; the path is only a last-resort fallback.
      const existing = get().tabs.find(
        (tab): tab is WorkspaceTabState =>
          isWorkspaceTab(tab) && isSameWorkspaceTab(tab, workspacePath, options),
      );
      if (existing) {
        persistWorkspaceExpandedPreference(existing.workspacePath, true, storage);
        set((state) => ({
          // A successful manual reconnect of a remote workspace calls addTab again, but
          // hitting an existing tab only activated it and never wrote the new remoteSessionId
          // and other metadata back onto the old tab. The UI kept reading a stale
          // "remoteSessionId not yet updated" state, so the reconnect button stayed visible
          // as if the connection never landed. Overwrite the remote session fields on reuse.
          tabs: state.tabs.map((tab) =>
            tab.id !== existing.id || !isWorkspaceTab(tab)
              ? tab
              : mergeWorkspaceTabOptions(tab, options),
          ),
          activeTabId: existing.id,
          activeWorkspacePath: existing.workspacePath,
          // Plugin management on the Settings page must keep hitting the same remote by the
          // "most recently activated workspace" identity. Only the path used to be stored, so
          // the identity was lost after switching to the settings tab and broke same-path
          // remote isolation.
          activeWorkspaceIdentity: options?.workspaceIdentity ?? existing.workspaceIdentity ?? null,
          expandedWorkspacePaths: ensureWorkspaceExpanded(
            state.expandedWorkspacePaths,
            existing.workspacePath,
          ),
        }));
        return existing.id;
      }

      const tab = createWorkspaceTab(workspacePath, options);
      persistWorkspaceExpandedPreference(workspacePath, true, storage);
      set((state) => ({
        // The sidebar workspace list supports manual ordering, but newly opened projects were
        // still appended to the bottom, forcing a scroll hunt for the latest workspace and
        // contradicting the sidebar's "newest context first" browsing model. Insert new
        // workspaces at the front so they appear at the top of the list.
        tabs: [tab, ...state.tabs],
        activeTabId: tab.id,
        activeWorkspacePath: workspacePath,
        activeWorkspaceIdentity: tab.workspaceIdentity ?? null,
        expandedWorkspacePaths: ensureWorkspaceExpanded(
          state.expandedWorkspacePaths,
          workspacePath,
        ),
      }));
      return tab.id;
    },

    ensureWorkspaceTab: (workspacePath: string, options) => {
      const existing = get().tabs.find(
        (tab): tab is WorkspaceTabState =>
          isWorkspaceTab(tab) && isSameWorkspaceTab(tab, workspacePath, options),
      );
      if (existing) {
        persistWorkspaceExpandedPreference(existing.workspacePath, true, storage);
        set((state) => ({
          tabs: state.tabs.map((tab) =>
            tab.id !== existing.id || !isWorkspaceTab(tab)
              ? tab
              : mergeWorkspaceTabOptions(tab, options),
          ),
          expandedWorkspacePaths: ensureWorkspaceExpanded(
            state.expandedWorkspacePaths,
            existing.workspacePath,
          ),
        }));
        return existing.id;
      }

      const tab = createWorkspaceTab(workspacePath, options);
      persistWorkspaceExpandedPreference(workspacePath, true, storage);
      set((state) => ({
        // Claude history imports can write tasks into a workspace this window never opened.
        // The task pane only iterates workspace tabs; bumping just the task-list version here
        // would persist the task while the sidebar still has no group to render it in. Add a
        // visibility-only entry so the workspace feeds the task pane without disturbing the
        // tab / settings context the user is looking at.
        tabs: [tab, ...state.tabs],
        expandedWorkspacePaths: ensureWorkspaceExpanded(
          state.expandedWorkspacePaths,
          workspacePath,
        ),
      }));
      return tab.id;
    },

    closeTab: (tabId: TabId) => {
      const stateBefore = get();
      const { tabs, activeTabId } = stateBefore;
      const index = tabs.findIndex((t) => t.id === tabId);
      if (index === -1) {
        return;
      }

      const closingTab = tabs[index] ?? null;
      const newTabs = tabs.filter((t) => t.id !== tabId);

      // Closing the active tab requires switching to a neighboring tab.
      let newActiveTabId = activeTabId;
      if (activeTabId === tabId) {
        if (newTabs.length === 0) {
          newActiveTabId = null;
        } else {
          // Prefer the tab to the right; fall back to the left one at the end of the list.
          const newIndex = Math.min(index, newTabs.length - 1);
          newActiveTabId = newTabs[newIndex]!.id;
        }
      }

      const nextWorkspaceTab = newTabs.find((tab) => tab.id === newActiveTabId);
      const fallbackWorkspacePath = (() => {
        if (nextWorkspaceTab && isWorkspaceTab(nextWorkspaceTab)) {
          return nextWorkspaceTab.workspacePath;
        }

        if (closingTab && isWorkspaceTab(closingTab)) {
          const replacementWorkspace = newTabs.find(isWorkspaceTab);
          return replacementWorkspace?.workspacePath ?? null;
        }

        return stateBefore.activeWorkspacePath;
      })();
      const fallbackWorkspaceIdentity = (() => {
        if (nextWorkspaceTab && isWorkspaceTab(nextWorkspaceTab)) {
          return nextWorkspaceTab.workspaceIdentity ?? null;
        }

        if (closingTab && isWorkspaceTab(closingTab)) {
          const replacementWorkspace = newTabs.find(isWorkspaceTab);
          return replacementWorkspace?.workspaceIdentity ?? null;
        }

        return stateBefore.activeWorkspaceIdentity;
      })();

      const nextState = {
        tabs: newTabs,
        activeTabId: newActiveTabId,
        activeWorkspacePath: fallbackWorkspacePath,
        activeWorkspaceIdentity: fallbackWorkspaceIdentity,
        expandedWorkspacePaths: (() => {
          const prunedExpandedWorkspacePaths =
            closingTab && isWorkspaceTab(closingTab)
              ? pruneExpandedWorkspace(stateBefore.expandedWorkspacePaths, closingTab.workspacePath)
              : stateBefore.expandedWorkspacePaths;

          // After closing the active workspace the main content auto-switches to a neighbor.
          // When expansion lived in component-local state, the successor got expanded as a
          // side effect of workspacePath changing; now that the store owns it, carry the
          // fallback over too, or "close current tab" leaves an active-but-collapsed workspace.
          return fallbackWorkspacePath
            ? ensureWorkspaceExpanded(prunedExpandedWorkspacePaths, fallbackWorkspacePath)
            : prunedExpandedWorkspacePaths;
        })(),
      };

      if (fallbackWorkspacePath) {
        persistWorkspaceExpandedPreference(fallbackWorkspacePath, true, storage);
      }

      set(nextState);
    },

    activateTab: (tabId: TabId) => {
      const stateBefore = get();
      const tab = stateBefore.tabs.find((t) => t.id === tabId);
      if (!tab) {
        return;
      }

      const nextState = {
        activeTabId: tabId,
        activeWorkspacePath: isWorkspaceTab(tab)
          ? tab.workspacePath
          : stateBefore.activeWorkspacePath,
        activeWorkspaceIdentity: isWorkspaceTab(tab)
          ? (tab.workspaceIdentity ?? null)
          : stateBefore.activeWorkspaceIdentity,
        expandedWorkspacePaths: isWorkspaceTab(tab)
          ? ensureWorkspaceExpanded(stateBefore.expandedWorkspacePaths, tab.workspacePath)
          : stateBefore.expandedWorkspacePaths,
      };

      if (isWorkspaceTab(tab)) {
        persistWorkspaceExpandedPreference(tab.workspacePath, true, storage);
      }

      set(nextState);
    },

    reorderTabs: (fromIndex: number, toIndex: number) => {
      set((state) => {
        if (
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= state.tabs.length ||
          toIndex >= state.tabs.length ||
          fromIndex === toIndex
        ) {
          return state;
        }

        const newTabs = moveItem(state.tabs, fromIndex, toIndex);
        return { tabs: newTabs };
      });
    },

    reorderWorkspaceTabs: (fromIndex: number, toIndex: number) => {
      set((state) => {
        const workspaceTabs = state.tabs.filter(isWorkspaceTab);
        if (
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= workspaceTabs.length ||
          toIndex >= workspaceTabs.length ||
          fromIndex === toIndex
        ) {
          return state;
        }

        const reorderedWorkspaceTabs = moveItem(workspaceTabs, fromIndex, toIndex);
        let workspaceIndex = 0;
        const newTabs = state.tabs.map((tab) => {
          if (!isWorkspaceTab(tab)) {
            return tab;
          }

          return reorderedWorkspaceTabs[workspaceIndex++] ?? tab;
        });

        return { tabs: newTabs };
      });
    },

    openSettingsTab: () => {
      const existing = get().tabs.find(isSettingsTab);
      if (existing) {
        set({ activeTabId: existing.id });
        return;
      }

      const settingsTab = createSettingsTab();
      set((state) => ({
        tabs: [...state.tabs, settingsTab],
        activeTabId: settingsTab.id,
      }));
    },

    toggleWorkspaceExpanded: (path: string) => {
      set((state) => {
        const expandedWorkspacePaths = new Set(state.expandedWorkspacePaths);
        const nextExpanded = !expandedWorkspacePaths.has(path);
        if (expandedWorkspacePaths.has(path)) {
          expandedWorkspacePaths.delete(path);
        } else {
          expandedWorkspacePaths.add(path);
        }

        persistWorkspaceExpandedPreference(path, nextExpanded, storage);

        return { expandedWorkspacePaths };
      });
    },

    expandAllWorkspaceTabs: (paths: string[]) => {
      set((state) => {
        const expandedWorkspacePaths = new Set(state.expandedWorkspacePaths);
        for (const path of paths) {
          expandedWorkspacePaths.add(path);
          persistWorkspaceExpandedPreference(path, true, storage);
        }
        return { expandedWorkspacePaths };
      });
    },

    collapseAllWorkspaceTabs: (paths: string[]) => {
      set((state) => {
        const expandedWorkspacePaths = new Set(state.expandedWorkspacePaths);
        for (const path of paths) {
          expandedWorkspacePaths.delete(path);
          persistWorkspaceExpandedPreference(path, false, storage);
        }
        return { expandedWorkspacePaths };
      });
    },

    activateTabByPath: (path: string, options) => {
      const stateBefore = get();
      const tab = stateBefore.tabs.find((currentTab): currentTab is WorkspaceTabState => {
        if (!isWorkspaceTab(currentTab) || currentTab.workspacePath !== path) {
          return false;
        }

        if (options?.workspaceIdentity) {
          return currentTab.workspaceIdentity === options.workspaceIdentity;
        }

        return true;
      });
      if (!tab) {
        return false;
      }

      const nextState = {
        activeTabId: tab.id,
        activeWorkspacePath: path,
        activeWorkspaceIdentity: tab.workspaceIdentity ?? null,
        expandedWorkspacePaths: ensureWorkspaceExpanded(stateBefore.expandedWorkspacePaths, path),
      };

      persistWorkspaceExpandedPreference(path, true, storage);

      set(nextState);
      return true;
    },

    restoreTabs: (tabsInput, activeIndex: number) => {
      if (tabsInput.length === 0) return;
      const tabs = tabsInput.map((tab) => {
        const normalized = normalizeRestorableWorkspaceTab(tab);
        return createWorkspaceTab(normalized.workspacePath, {
          remoteSessionId: normalized.remoteSessionId,
          remoteTarget: normalized.remoteTarget,
          workspaceIdentity: normalized.workspaceIdentity,
          workspacePurpose: normalized.workspacePurpose,
          availability: normalized.availability,
        });
      });
      const safeIndex = Math.min(Math.max(activeIndex, 0), tabs.length - 1);
      const activeWorkspaceTab = tabs[safeIndex];
      if (!activeWorkspaceTab || !isWorkspaceTab(activeWorkspaceTab)) {
        return;
      }
      const expansionState: WorkspaceExpansionState = readWorkspaceExpansionState(storage);
      set({
        tabs,
        activeTabId: activeWorkspaceTab.id,
        activeWorkspacePath: activeWorkspaceTab.workspacePath,
        activeWorkspaceIdentity: activeWorkspaceTab.workspaceIdentity ?? null,
        expandedWorkspacePaths: resolveExpandedWorkspacePaths(
          tabs.map((tab) => tab.workspacePath),
          expansionState,
        ),
      });
    },

    completeTabRestore: (tabsInput) => {
      if (tabsInput.length === 0) return;
      set((state) => {
        const consumedTabIds = new Set<TabId>();
        const completedTabs = tabsInput.map((tabInput) => {
          const normalized = normalizeRestorableWorkspaceTab(tabInput);
          const options: WorkspaceTabOptions = {
            remoteSessionId: normalized.remoteSessionId,
            remoteTarget: normalized.remoteTarget,
            workspaceIdentity: normalized.workspaceIdentity,
            localWorkspacePath: normalized.localWorkspacePath,
            workspacePurpose: normalized.workspacePurpose,
            availability: normalized.availability,
          };
          const existing = state.tabs.find(
            (tab): tab is WorkspaceTabState =>
              isWorkspaceTab(tab) &&
              !consumedTabIds.has(tab.id) &&
              isSameWorkspaceTab(tab, normalized.workspacePath, options),
          );
          if (existing) {
            consumedTabIds.add(existing.id);
            return mergeWorkspaceTabOptions(existing, options);
          }
          return createWorkspaceTab(normalized.workspacePath, options);
        });
        const extraWorkspaceTabs = state.tabs.filter(
          (tab): tab is WorkspaceTabState => isWorkspaceTab(tab) && !consumedTabIds.has(tab.id),
        );
        const nonWorkspaceTabs = state.tabs.filter((tab) => !isWorkspaceTab(tab));
        const tabs = [...extraWorkspaceTabs, ...completedTabs, ...nonWorkspaceTabs];
        const expansionState = readWorkspaceExpansionState(storage);

        // A second restoreTabs pass in the active-first phase's completion step would rebuild
        // the active tab id, dropping identity from already-mounted session views and
        // clobbering tabs the user opened after the first frame. The completion pass only
        // merges missing tabs and explicitly preserves focus and the active workspace projection.
        return {
          tabs,
          activeTabId: state.activeTabId,
          activeWorkspacePath: state.activeWorkspacePath,
          activeWorkspaceIdentity: state.activeWorkspaceIdentity,
          expandedWorkspacePaths: resolveExpandedWorkspacePaths(
            tabs.filter(isWorkspaceTab).map((tab) => tab.workspacePath),
            expansionState,
          ),
        };
      });
    },
  }));
}

export type TabStore = ReturnType<typeof createTabStore>;
