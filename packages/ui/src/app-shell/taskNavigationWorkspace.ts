export type TaskNavigationWorkspaceResult =
  | { accepted: true; openedLocalTab: boolean }
  | { accepted: false; reason: "remote_attachment_missing" };

export function ensureTaskNavigationWorkspace(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  activateTabByPath: (workspacePath: string, options?: { workspaceIdentity?: string }) => boolean;
  addLocalWorkspaceTab: (workspacePath: string) => void;
}): TaskNavigationWorkspaceResult {
  const workspaceIdentity = params.workspaceIdentity?.trim();
  if (
    params.activateTabByPath(
      params.workspacePath,
      workspaceIdentity ? { workspaceIdentity } : undefined,
    )
  ) {
    return { accepted: true, openedLocalTab: false };
  }

  if (workspaceIdentity) {
    // A remote workspace identity only expresses the isolation identity; SSH/WSL/Docker
    // attachments cannot be rebuilt from it. With no matching tab in this window, fail closed rather than create an unreachable pseudo-remote tab.
    return { accepted: false, reason: "remote_attachment_missing" };
  }

  // Automations is a cross-project list; the local workspace owning a run history may already be closed.
  // Merely calling activate would still close Automations on failure, stranding the current project's old session.
  params.addLocalWorkspaceTab(params.workspacePath);
  return { accepted: true, openedLocalTab: true };
}
