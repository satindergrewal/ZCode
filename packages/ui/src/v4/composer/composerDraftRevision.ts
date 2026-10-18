// Deferred trusted resolution of recommended prompts needs to know whether the user edited the
// Composer while waiting. The revision lives in renderer memory only - never in draft
// persistence, protocol, or remote sync - and keys the same workspaceKey as the Zustand draft so
// local paths and remote identities never cross-write.
const revisionByWorkspaceKey = new Map<string, number>();

function getWorkspaceKey(workspacePath: string, workspaceIdentity?: string): string {
  return workspaceIdentity?.trim() || workspacePath;
}

export function getComposerDraftRevision(
  workspacePath: string,
  workspaceIdentity?: string,
): number {
  return revisionByWorkspaceKey.get(getWorkspaceKey(workspacePath, workspaceIdentity)) ?? 0;
}

export function advanceComposerDraftRevision(
  workspacePath: string,
  workspaceIdentity?: string,
): number {
  const workspaceKey = getWorkspaceKey(workspacePath, workspaceIdentity);
  const nextRevision = (revisionByWorkspaceKey.get(workspaceKey) ?? 0) + 1;
  revisionByWorkspaceKey.set(workspaceKey, nextRevision);
  return nextRevision;
}
