import { useCallback, useRef } from "react";
import { ensureAgentV4ConnectionHandshake } from "@/v4/agentV4ConnectionHandshake.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { resolveWorkspaceRemoteSessionId } from "@/lib/workspaceServiceResolver.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { sendInteractionAutoResolutionSnooze } from "@/v4/interactionAutoResolutionCommand.js";

interface TaskInteractionAutoResolutionTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
}

/**
 * Sidebar tasks may come from local, remote, timeline, or pinned lists; the snooze command
 * must reach the originating host via workspace identity, never the current window's
 * service just because a different tab is active.
 */
export function useTaskInteractionAutoResolutionSnooze(
  target: TaskInteractionAutoResolutionTarget,
) {
  const loggedInteractionIdsRef = useRef(new Set<string>());
  const contextServices = useOptionalServices();
  const workspaceIdentity = target.workspaceIdentity?.trim() || undefined;
  const remoteSessionId = target.remoteSessionId?.trim() || undefined;
  const isRemoteTarget = Boolean(workspaceIdentity || remoteSessionId);
  const selectTargetServices = useCallback(
    (state: ReturnType<typeof useRemoteWorkspaceSessionStore.getState>) => {
      if (!isRemoteTarget) {
        return state.baseServices ?? contextServices;
      }

      const resolvedRemoteSessionId = resolveWorkspaceRemoteSessionId(
        {
          workspacePath: target.workspacePath,
          workspaceIdentity,
          remoteSessionId,
          // This hook's target type carries only task-routing fields; a present
          // remoteSessionId is already proof that legacy data can restore via the path
          // fallback, with no need to fabricate a concrete RemoteTarget.
          remoteTarget: remoteSessionId ? true : undefined,
        },
        state,
      );
      if (resolvedRemoteSessionId) {
        return state.sessionsById[resolvedRemoteSessionId]?.services ?? null;
      }
      // Never fall back to the local service when a remote task's host is missing, or the
      // same taskId could be delivered to the wrong workspace; keep the retryable failure
      // and wait for the remote attachment to recover.
      return null;
    },
    [contextServices, isRemoteTarget, remoteSessionId, target.workspacePath, workspaceIdentity],
  );
  const targetServices = useRemoteWorkspaceSessionStore(selectTargetServices);

  return useCallback(
    async (interactionId: string): Promise<boolean> => {
      const agentService = targetServices?.zcodeAgentService;
      if (!agentService) {
        logger.warn("[task-interaction] target workspace not connected for auto-resolution snooze", {
          interactionId,
          sessionId: target.sessionId,
          workspaceKey: workspaceIdentity ?? target.workspacePath,
        });
        return false;
      }
      if (!loggedInteractionIdsRef.current.has(interactionId)) {
        loggedInteractionIdsRef.current.add(interactionId);
        logger.debug("[task-interaction] user requested auto-resolution snooze from sidebar", {
          interactionId,
          sessionId: target.sessionId,
          source: "taskBadge",
        });
      }

      return sendInteractionAutoResolutionSnooze({
        sessionId: target.sessionId,
        interactionId,
        source: "taskBadge",
        sendCommand: async (envelope) => {
          await ensureAgentV4ConnectionHandshake(agentService);
          return agentService.sendConversationCommandV4({
            workspacePath: target.workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            envelope,
          });
        },
      });
    },
    [target.sessionId, target.workspacePath, targetServices, workspaceIdentity],
  );
}
