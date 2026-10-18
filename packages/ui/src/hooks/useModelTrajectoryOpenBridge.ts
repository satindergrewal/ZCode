import { useEffect } from "react";
import { useModelTrajectoryStore } from "@/store/modelTrajectoryStore.js";

/**
 * Subscribes to "open model trajectory" requests and hands them to this workspace's
 * sidebar controller.
 *
 * Raised deep in task context menus / the Header menu via a singleton store; matched by
 * workspaceKey here, then onOpen opens the sidebar tab and the request is consumed, so
 * multiple workspace instances do not open each other's tabs.
 */
export function useModelTrajectoryOpenBridge(
  ownWorkspaceKey: string,
  onOpen: (params: { taskId: string; title?: string | null }) => void,
): void {
  useEffect(() => {
    const handlePending = (
      pendingRequest: ReturnType<typeof useModelTrajectoryStore.getState>["pendingRequest"],
    ) => {
      if (!pendingRequest || pendingRequest.workspaceKey !== ownWorkspaceKey) {
        return;
      }
      onOpen({ taskId: pendingRequest.taskId, title: pendingRequest.title });
      useModelTrajectoryStore.getState().consumeRequest(pendingRequest.requestId);
    };

    // A request may already be pending when this subscribes (click vs mount race); handle the current value once.
    handlePending(useModelTrajectoryStore.getState().pendingRequest);
    return useModelTrajectoryStore.subscribe((state) => {
      handlePending(state.pendingRequest);
    });
  }, [onOpen, ownWorkspaceKey]);
}
