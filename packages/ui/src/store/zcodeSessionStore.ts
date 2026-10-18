/**
 * ZCode session UI state store.
 *
 * One tab maps to one workspace, so chat state must be bucketed per workspace as well:
 * only then do the current task, the in-progress draft and the init state survive tab switches without bleeding into each other.
 */
import { create } from "zustand";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import { type ZCodeSessionStoreState } from "./zcodeSessionStoreTypes.js";
import { getWorkspaceState } from "./zcodeSessionStoreSelectors.js";
import { createNavigationSlice } from "./zcodeSessionStoreNavigation.js";
import { createTaskSlice } from "./zcodeSessionStoreTaskSlice.js";
import { createWorkspaceSlice } from "./zcodeSessionStoreWorkspaceSlice.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

export const useZCodeSessionStore = create<ZCodeSessionStoreState>()((set, get) => ({
  workspaces: {},
  ...createNavigationSlice(set, get),
  ...createWorkspaceSlice(set),
  ...createTaskSlice(set),
  getWorkspaceState: (workspacePath: string, workspaceIdentity?: string) =>
    getWorkspaceState(get(), workspacePath, workspaceIdentity),
}));

type ZCodeSessionStoreE2EBridge = typeof useZCodeSessionStore;

declare global {
  interface Window {
    __zcodeSessionStoreE2E?: ZCodeSessionStoreE2EBridge;
  }
}

if (shouldExposeE2EStoreBridge()) {
  // The E2E diagnostics entry must be opened explicitly by WDIO, not via ZCODE_ENV=test, so the product test env keeps no mutable global store.
  window.__zcodeSessionStoreE2E = useZCodeSessionStore;
}

// ────────────────────────────────────────────
// Re-exports: keep the legacy zcodeSessionStore import path working
// ────────────────────────────────────────────
export * from "./zcodeSessionStoreTypes.js";
export * from "./zcodeSessionStoreSelectors.js";
// Re-export navigation types used externally:
export type {
  TaskNavigationHistory,
  TaskNavEntry,
  WorkspaceNavEntry,
} from "@/lib/taskNavigationHistory.js";

// In-memory diagnostic counter: workspace buckets are never deleted anywhere; log it first.
uiMemoryDiagnosticsRegistry.register("sessionStore", () => ({
  workspaces: Object.keys(useZCodeSessionStore.getState().workspaces).length,
}));
