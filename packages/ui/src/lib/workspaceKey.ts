/**
 * Identity/isolation semantics always use workspaceIdentity; legacy local callers without one fall back to the path.
 * remoteSessionId is deliberately excluded: it describes the connection instance, not workspace identity.
 */
export function getWorkspaceKey(workspacePath: string, workspaceIdentity?: string | null): string {
  return workspaceIdentity?.trim() || workspacePath;
}
