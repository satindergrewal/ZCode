import { parseRemoteWorkspaceIdentity, type ZCodeWorkspaceRef } from "@zcode/shared";

export function buildWorkspaceRef(input: {
  workspaceIdentity?: string;
  workspacePath: string;
}): ZCodeWorkspaceRef {
  const workspaceIdentity = input.workspaceIdentity?.trim() || undefined;
  return {
    workspaceIdentity,
    workspaceKey: workspaceIdentity ?? input.workspacePath,
    workspacePath: input.workspacePath,
  };
}

/**
 * Normalizes both shapes of a V4 workspaceId (local path / remote identity) back into a workspace ref.
 */
export function resolveWorkspaceRefFromId(workspaceId: string): ZCodeWorkspaceRef {
  const parsedRemote = parseRemoteWorkspaceIdentity(workspaceId);
  if (!parsedRemote) {
    // If a malformed remote identity is handled as a local path again, the identity gets written into
    // directory/path once more. The remote namespace must fail closed; local paths keep the original fallback.
    if (workspaceId.startsWith("remote:")) {
      throw new Error(`Invalid remote workspace identity: ${workspaceId}`);
    }
    return buildWorkspaceRef({ workspacePath: workspaceId });
  }

  // WSL identities with an explicit user used to fall into the local-path branch after a failed parse,
  // making the full identity the workingDirectory. The shared parser now splits identity and path.
  return buildWorkspaceRef({
    workspaceIdentity: workspaceId,
    workspacePath: parsedRemote.workspacePath,
  });
}
