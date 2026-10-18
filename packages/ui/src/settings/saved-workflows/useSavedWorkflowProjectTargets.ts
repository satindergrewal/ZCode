import { useMemo } from "react";
import type { ZCodeAgentWorkspaceTarget } from "@zcode/services";
import type { AutomationWorkspaceOption } from "@/settings/automationWorkspaceOptions.js";
import type { SavedWorkflowProjectTarget } from "@/settings/saved-workflows/savedWorkflowContract.js";
import type { SavedWorkflowLaunchTarget } from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";

interface SavedWorkflowProjectTargets {
  /** /** RPC target (with remoteSessionId) for store/service calls. */
  target: ZCodeAgentWorkspaceTarget;
  /** /** Conversation/open-instance coordinates: workspacePath + identity only (no remoteSessionId). */
  projectTarget: SavedWorkflowProjectTarget;
  /** /** Direct-start connection coordinates: plus remoteSessionId, fixing the conversation endpoint and navigation target. */
  launchTarget: SavedWorkflowLaunchTarget;
}

/**
 * The three coordinate sets a project group needs (every action carries this
 * project's target). They differ only in remoteSessionId; refs stay stable while inputs do, for memo/effect deps.
 */
export function useSavedWorkflowProjectTargets(
  project: Pick<AutomationWorkspaceOption, "workspacePath" | "workspaceIdentity">,
  remoteSessionId: string | null,
): SavedWorkflowProjectTargets {
  const target = useMemo<ZCodeAgentWorkspaceTarget>(
    () => ({
      workspacePath: project.workspacePath,
      ...(project.workspaceIdentity?.trim()
        ? { workspaceIdentity: project.workspaceIdentity }
        : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    }),
    [project.workspacePath, project.workspaceIdentity, remoteSessionId],
  );
  const projectTarget = useMemo<SavedWorkflowProjectTarget>(
    () => ({
      workspacePath: project.workspacePath,
      ...(project.workspaceIdentity ? { workspaceIdentity: project.workspaceIdentity } : {}),
    }),
    [project.workspacePath, project.workspaceIdentity],
  );
  const launchTarget = useMemo<SavedWorkflowLaunchTarget>(
    () => ({
      workspacePath: project.workspacePath,
      ...(project.workspaceIdentity ? { workspaceIdentity: project.workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    }),
    [project.workspacePath, project.workspaceIdentity, remoteSessionId],
  );
  return { target, projectTarget, launchTarget };
}
