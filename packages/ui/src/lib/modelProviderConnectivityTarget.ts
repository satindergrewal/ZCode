interface ConnectivityWorkspaceTab {
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
  localWorkspacePath?: string | null;
}

function isRemoteWorkspaceTab(tab: ConnectivityWorkspaceTab | null | undefined): boolean {
  return Boolean(
    tab?.workspaceIdentity?.trim() || tab?.remoteSessionId?.trim() || tab?.remoteTarget,
  );
}

/**
 * Provider Settings belong to the local environment; when a connectivity probe needs a cwd,
 * only a local workspace qualifies. A remote tab's workspacePath is a remote filesystem path
 * and must not be handed to the Local Host.
 */
export function resolveModelProviderConnectivityWorkspacePath(params: {
  activeWorkspacePath?: string | null;
  activeWorkspaceIdentity?: string | null;
  activeWorkspaceTab?: ConnectivityWorkspaceTab | null;
  workspaceTabs: readonly ConnectivityWorkspaceTab[];
}): string {
  const rememberedLocalPath = params.activeWorkspaceTab?.localWorkspacePath?.trim();
  if (rememberedLocalPath) {
    return rememberedLocalPath;
  }

  // Legacy tabs may carry only remoteSessionId or remoteTarget without workspaceIdentity.
  // Their workspacePath is still a remote path; a missing identity must not route them to
  // the Local Host.
  const activeWorkspaceIsRemote = Boolean(
    params.activeWorkspaceIdentity?.trim() || isRemoteWorkspaceTab(params.activeWorkspaceTab),
  );
  if (!activeWorkspaceIsRemote) {
    const activeLocalPath = params.activeWorkspaceTab?.workspacePath.trim();
    if (activeLocalPath) {
      return activeLocalPath;
    }
    const activeWorkspacePath = params.activeWorkspacePath?.trim();
    if (activeWorkspacePath) {
      return activeWorkspacePath;
    }
  }

  const localTab = params.workspaceTabs.find((tab) => !isRemoteWorkspaceTab(tab));
  return localTab?.workspacePath.trim() ?? "";
}
