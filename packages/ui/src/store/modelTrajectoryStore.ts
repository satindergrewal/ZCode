import { create } from "zustand";

/**
 * Request-bridge store for opening the model-call-trajectory side pane.
 *
 * Context: the entries live in the task context menu / header menu, mounted deep in the tree, while the side-pane tab state
 * is held by each workspace useAppPanels. To avoid threading a new callback through the whole task-list tree,
 * a lightweight singleton store acts as the bridge: the menu writes a pending request, and the target workspace
 * useAppPanels subscribes and consumes it (matched by workspaceKey so multi-workspace instances stay apart).
 */
interface ModelTrajectoryOpenRequest {
  /** Unique request id so repeated clicks on the same task still trigger consumption. */
  requestId: string;
  taskId: string;
  /** workspaceIdentity?.trim() || workspacePath; locates the target workspace side pane. */
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

// E2E must verify the full request-bridge -> target-workspace side-pane chain inside the dual-workspace shell.
// The header menu binds only that header activeTaskId and is not a stable test entry for split-pane shells;
// like __zcodeSessionStoreE2E, expose the store itself instead of a separate test-only business implementation.
if (typeof window !== "undefined") {
  window.__zcodeModelTrajectoryStoreE2E = useModelTrajectoryStore;
}
