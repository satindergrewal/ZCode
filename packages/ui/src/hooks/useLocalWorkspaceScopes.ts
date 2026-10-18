import { useMemo } from "react";
import { isWorkspaceTab, type WorkspaceTabState } from "@/store/tabStore.js";

function isLocalWorkspaceTab(tab: WorkspaceTabState): boolean {
  return !tab.remoteSessionId && !tab.remoteTarget && !tab.workspaceIdentity;
}

export function useLocalWorkspaceScopes({
  workspaceTabs,
}: {
  workspaceTabs: WorkspaceTabState[];
}): WorkspaceTabState[] {
  return useMemo(
    () =>
      workspaceTabs.filter((tab) => {
        // The pinned query considers only local workspaces already open in this window.
        // Remote workspaces, even when persisted in lastWorkspaceSession, must not leak into the local query as a fallback;
        // without remoteSessionId they would hit the local service and cross-read same-path tasks.
        return isWorkspaceTab(tab) && isLocalWorkspaceTab(tab);
      }),
    [workspaceTabs],
  );
}
