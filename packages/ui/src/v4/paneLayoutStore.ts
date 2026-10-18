// zustand assembly for the split-pane Layout/Focus layers. The model and pure state machine
// live in paneLayoutTree.ts, persistence in paneLayoutPersistence.ts; this file only wires the
// store plus the persistence subscription and re-exports both (single consumer entry).
import { create } from "zustand";
import { isRendererReloadNavigation } from "@/lib/rendererNavigation.js";
import { persistPaneLayout, readPersistedPaneLayout } from "@/v4/paneLayoutPersistence.js";
import {
  bindPaneSession,
  closePane,
  confirmRestoredPaneSession,
  focusPane,
  INITIAL_PANE_LAYOUT,
  openSessionInNewPane,
  replacePaneBinding,
  setSplitNodeRatio,
  splitPaneAt,
  splitPaneAtSide,
  type PaneBinding,
  type PaneLayoutSnapshot,
  type PaneSplitSide,
  type PaneWorkspaceScope,
  type SplitDirection,
} from "@/v4/paneLayoutTree.js";

const persistedPaneLayoutAtModuleLoad = readPersistedPaneLayout();
const restoredPaneLayoutAtModuleLoad = isRendererReloadNavigation()
  ? persistedPaneLayoutAtModuleLoad
  : null;

/** Cold-start entry: detects and clears a layout left by the previous renderer that must not restore now. */
export function hadPersistedPaneLayoutAtModuleLoad(): boolean {
  return persistedPaneLayoutAtModuleLoad !== null;
}

export * from "@/v4/paneLayoutTree.js";
export * from "@/v4/paneLayoutPersistence.js";

interface PaneLayoutStore extends PaneLayoutSnapshot {
  /** Splits a draft pane at the anchor (scope-bound; binds in place after the first createSession). */
  splitPane: (anchorPaneId: string, direction: SplitDirection, scope: PaneWorkspaceScope) => void;
  /** Splits a session-bound pane around the anchor (draft drop / non-group drag entry). */
  splitPaneWithBinding: (anchorPaneId: string, side: PaneSplitSide, binding: PaneBinding) => void;
  /** Sidebar/drill-down entry: focus when already open, else split the focused pane right and bind. */
  openSessionInNewPane: (scope: PaneWorkspaceScope, sessionId: string) => void;
  /** Transient draft layout: a plain sidebar click replaces the focused secondary, never the primary draft. */
  replacePaneBinding: (paneId: string, binding: PaneBinding) => void;
  closePane: (paneId: string) => void;
  focusPane: (paneId: string) => void;
  bindPaneSession: (paneId: string, sessionId: string) => void;
  setSplitRatio: (splitId: string, ratio: number) => void;
  confirmRestoredPaneSession: (paneId: string) => void;
  /** Exits split view on new task/draft, back to the single primary panel. */
  resetToPrimaryPane: () => void;
}

/** One per window; action references are stable and safe to hand to memoized components. */
export const usePaneLayoutStore = create<PaneLayoutStore>()((set) => ({
  // Only the same-renderer reload restores layout from localStorage; a cold app start begins from the single primary draft.
  ...(restoredPaneLayoutAtModuleLoad ?? INITIAL_PANE_LAYOUT),

  splitPane: (anchorPaneId, direction, scope) => {
    set((state) =>
      splitPaneAt(state, anchorPaneId, direction, {
        workspaceScope: scope,
        sessionId: null,
      }),
    );
  },

  splitPaneWithBinding: (anchorPaneId, side, binding) => {
    set((state) => splitPaneAtSide(state, anchorPaneId, side, binding));
  },

  openSessionInNewPane: (scope, sessionId) => {
    set((state) => openSessionInNewPane(state, scope, sessionId));
  },

  replacePaneBinding: (paneId, binding) => {
    set((state) => replacePaneBinding(state, paneId, binding));
  },

  closePane: (paneId) => {
    set((state) => closePane(state, paneId));
  },

  focusPane: (paneId) => {
    set((state) => focusPane(state, paneId));
  },

  bindPaneSession: (paneId, sessionId) => {
    set((state) => bindPaneSession(state, paneId, sessionId));
  },

  setSplitRatio: (splitId, ratio) => {
    set((state) => setSplitNodeRatio(state, splitId, ratio));
  },

  confirmRestoredPaneSession: (paneId) => {
    set((state) => confirmRestoredPaneSession(state, paneId));
  },

  resetToPrimaryPane: () => {
    set(INITIAL_PANE_LAYOUT);
  },
}));

// Layout changes persist immediately (no-op transitions keep the reference, zustand stays silent, no redundant writes).
usePaneLayoutStore.subscribe((state) => {
  persistPaneLayout(state);
});
