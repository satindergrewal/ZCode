// Promote-to-global orchestration.
//
// Project -> global is not a file copy: project workflows reference this repo's paths / commands /
// conventions, and a byte-for-byte copy is a global definition guaranteed to break elsewhere. This
// step is the model's **generalization**: the GUI opens a new session in that project whose first
// user message is the generalization prompt (createSession.firstInput, auto-sent); the model reads
// the file, lifts parameters and saves a copy via SaveWorkflow (scope global). The source stays
// untouched; the confirmation flow is unaffected.
//
// Why not onCreateViaChat (revise / create-via-chat): that path only prefills the composer draft
// without sending, while this is a clicked action that must not demand a second Send press. Why not
// the direct launcher: it sends the startSavedWorkflow command (run the workflow), here we need a
// plain user input. A create with firstInput is accepted or rejected atomically - no
// session-created-message-not-sent middle state - so no reclaim logic is needed.
import { useCallback, useRef, useState } from "react";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import type { WorkspaceConnectionAgentService } from "@/v4/workspaceConnectionRegistry.js";
import { logger } from "@/logger.js";
import { buildSavedWorkflowPromotePrompt } from "@/settings/saved-workflows/savedWorkflowLaunchPrompt.js";
import {
  acquireLaunchLease,
  launchWorkspaceId,
  type SavedWorkflowLaunchTarget,
} from "@/settings/saved-workflows/useSavedWorkflowLauncher.js";

/** The project workflow being promoted: name and path feed the prompt (the model reads the file); locale picks the wording. */
interface SavedWorkflowPromoteRequest {
  name: string;
  path: string;
  locale: string;
}

type SavedWorkflowPromoteResult =
  | { ok: true; sessionId: string }
  | {
      ok: false;
      /** Raw fault code / ACK status; for logs and the toast fallback text. */
      code: string;
      /** Server human-readable reason (shown first when present). */
      message?: string;
    };

interface UseSavedWorkflowPromoteResult {
  promote: (
    target: SavedWorkflowLaunchTarget,
    request: SavedWorkflowPromoteRequest,
  ) => Promise<SavedWorkflowPromoteResult>;
  /** Promoting: card / detail menu disabled against double clicks. */
  pending: boolean;
}

/**
 * Carrier agentService = the project's resolved agent service (the project group already holds it);
 * onNavigate switches to the new session once accepted (sharing onNavigateToLaunchedRun with the
 * direct launcher). Runtime-default model/mode, never the composer draft config - same trade-off as
 * direct launch.
 */
export function useSavedWorkflowPromote(params: {
  agentService: WorkspaceConnectionAgentService;
  onNavigate?: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
}): UseSavedWorkflowPromoteResult {
  const { agentService, onNavigate } = params;
  const [pending, setPending] = useState(false);
  // Synchronous re-entry guard (setPending is async; state alone cannot stop double clicks).
  const pendingRef = useRef(false);

  const promote = useCallback(
    async (
      target: SavedWorkflowLaunchTarget,
      request: SavedWorkflowPromoteRequest,
    ): Promise<SavedWorkflowPromoteResult> => {
      if (pendingRef.current) {
        return { ok: false, code: "promote_in_flight" };
      }
      pendingRef.current = true;
      setPending(true);
      const lease = acquireLaunchLease(target, agentService);
      try {
        const ack = await lease.transport.sendCommand(
          createCommandEnvelope({
            type: "createSession",
            payload: {
              workspaceId: launchWorkspaceId(target),
              firstInput: { text: buildSavedWorkflowPromotePrompt(request) },
            },
            sessionId: null,
          }),
        );
        if (ack.status !== "accepted" || ack.result?.type !== "createSession") {
          logger.warn("[saved-workflow-promote] createSession(firstInput) rejected", {
            workspacePath: target.workspacePath,
            name: request.name,
            status: ack.status,
            reasonCode: ack.reasonCode ?? null,
          });
          return {
            ok: false,
            code: ack.reasonCode ?? ack.status,
            ...(ack.message ? { message: ack.message } : {}),
          };
        }
        onNavigate?.(target, ack.result.sessionId);
        return { ok: true, sessionId: ack.result.sessionId };
      } catch (thrown) {
        return {
          ok: false,
          code: "exception",
          message: thrown instanceof Error ? thrown.message : String(thrown),
        };
      } finally {
        lease.release();
        pendingRef.current = false;
        setPending(false);
      }
    },
    [agentService, onNavigate],
  );

  return { promote, pending };
}
