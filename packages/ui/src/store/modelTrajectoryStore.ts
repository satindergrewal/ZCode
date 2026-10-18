import { create } from "zustand";

/**
 * Request bridge store that opens the model trajectory side pane.
 *
 * Context: the trigger lives in task context menus / header menus, mounted deep in the tree,
 * while side pane tab state is owned by each workspace's useAppPanels. To avoid threading a
 * new callback through the whole task list, a lightweight singleton store bridges the two:
 * menus write a pending request; the target workspace's useAppPanels consumes it (by workspaceKey).
 */
export interface ModelTrajectoryOpenRequest {
  /** Unique request id so repeated clicks on the same task still trigger a fresh consume. */
  requestId: string;
  taskId: string;
  /** workspaceIdentity?.trim() || workspacePath; locates the target workspace's side pane. */
  workspaceKey: string;
  title?: string | null;
}

interface ModelTrajectoryStoreState {
  pendingRequest: ModelTrajectoryOpenRequest | null;
  requestOpen: (request: Omit<ModelTrajectoryOpenRequest, "requestId">) => void;
  consumeRequest: (requestId: string) => void;
}

declare global {
  interface Window {
    __zcodeModelTrajectoryStoreE2E?: typeof useModelTrajectoryStore;
  }
}

let requestSeq = 0;

export const useModelTrajectoryStore = create<ModelTrajectoryStoreState>((set) => ({
  pendingRequest: null,
  requestOpen: (request) => {
    requestSeq += 1;
    set({
      pendingRequest: { ...request, requestId: `model-trajectory-open:${requestSeq}` },
    });
  },
  consumeRequest: (requestId) => {
    set((state) =>
      state.pendingRequest?.requestId === requestId ? { pendingRequest: null } : state,
    );
  },
}));

// E2E must exercise the full request bridge -> target-workspace side pane chain in the dual-workspace shell.
// The header menu only binds its own activeTaskId, so it is not a stable split-pane test entry;
// following __zcodeSessionStoreE2E, expose the store itself instead of a test-only shim.
if (typeof window !== "undefined") {
  window.__zcodeModelTrajectoryStoreE2E = useModelTrajectoryStore;
}
