import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";

interface WorkspaceShellTargetTab {
  workspacePath: string;
  remoteSessionId?: string;
  workspaceIdentity?: string;
}

export interface RootWorkspaceShellTarget {
  workspaceShellPath: string | null;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}

function normalizeOptionalString(value?: string | null): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function resolveRootWorkspaceShellTarget({
  activeWorkspaceTab,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  workspaceTabs,
}: {
  activeWorkspaceTab: WorkspaceShellTargetTab | null;
  activeWorkspacePath: string | null;
  activeWorkspaceIdentity: string | null;
  /** Every workspace tab of this window; recovers the covered tab when Settings or similar activate. */
  workspaceTabs: readonly WorkspaceShellTargetTab[];
}): RootWorkspaceShellTarget {
  if (activeWorkspaceTab) {
    return {
      workspaceShellPath: activeWorkspaceTab.workspacePath,
      workspaceIdentity: normalizeOptionalString(activeWorkspaceTab.workspaceIdentity),
      workspaceRemoteSessionId: normalizeOptionalString(activeWorkspaceTab.remoteSessionId),
    };
  }

  // With a Settings tab covering the workspace, the active tab is not a workspace tab.
  // The old fallback covered workspacePath only, no workspaceIdentity, misreading a disconnected SSH path as the local base service.
  const workspaceIdentity = normalizeOptionalString(activeWorkspaceIdentity);
  // That fix still left workspaceRemoteSessionId undefined. The app completion-notification hook uses it as the
  // sessions-index registry endpointKey; missing, a second store is created for the same remote workspace under __base__,
  // and the same topic is subscribed again; the CLI keeps only the newest subscription per connection/topic, silently replacing
  // the sidebar live one, which then never receives frames - the left list spins forever, frozen at the moment Settings opened.
  // The covered workspace tab is still in the tab list; recover it by workspaceKey so the shell target matches the tab activation exactly.
  const coveredWorkspaceTab =
    activeWorkspacePath === null
      ? undefined
      : workspaceTabs.find(
          (tab) =>
            buildTaskWorkspaceKey(tab.workspacePath, tab.workspaceIdentity) ===
            buildTaskWorkspaceKey(activeWorkspacePath, workspaceIdentity),
        );

  return {
    workspaceShellPath: activeWorkspacePath,
    workspaceIdentity,
    workspaceRemoteSessionId: normalizeOptionalString(coveredWorkspaceTab?.remoteSessionId),
  };
}
