// Direct-launch orchestration behind the hub's Run button.
// No more synthesized conversation text: create an empty session in the target project -> send it
// the startSavedWorkflow command -> on accepted, navigate to the new session (the launch card is
// already at top); on rejected / thrown, delete the empty session and surface the error to the
// caller (args-dialog inline / toast), leaving the user in the hub. Failure happens before the
// session exists (invariant 2): createSession rejected means no start and no session; start
// rejected means an immediate deleteSession to reclaim the empty session.
import { useCallback, useRef, useState } from "react";
import {
  SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX,
  savedWorkflowStartRejectionReasonSchema,
  type CommandAck,
  type SavedWorkflowStartRejectionReason,
} from "@zcode/shared/zcode-protocol-v4";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import {
  acquireWorkspaceConnection,
  type WorkspaceConnectionAgentService,
} from "@/v4/workspaceConnectionRegistry.js";
import { logger } from "@/logger.js";

/** Target project coordinates (the workflow's own project, never the active one; invariant 7); remoteSessionId decides the connection endpoint. */
export interface SavedWorkflowLaunchTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}

/** Launch request: name guaranteed by resolution (invariant 6), scope-directed lookup, args collected by the args dialog. */
interface SavedWorkflowLaunchRequest {
  name: string;
  scope: "project" | "global";
  args: Record<string, unknown>;
}

/** Error reason = rejection vocabulary U missing-capability U fallback; maps 1:1 onto i18n key workflows.hub.launch.error.<reason>. */
export type SavedWorkflowLaunchErrorReason =
  | SavedWorkflowStartRejectionReason
  | "unsupported"
  | "generic";

export interface SavedWorkflowLaunchError {
  reason: SavedWorkflowLaunchErrorReason;
  /** Raw fault code / ACK status; for logs and troubleshooting only, never rendered directly. */
  code: string;
  /** Server human-readable reason (bounded truncation after merging compile diagnostics); shown in an inline mono block when present. */
  message?: string;
}

type SavedWorkflowLaunchResult =
  | { ok: true; sessionId: string; runId: string; toolCallId: string }
  | { ok: false; error: SavedWorkflowLaunchError };

interface UseSavedWorkflowLauncherResult {
  launch: (
    target: SavedWorkflowLaunchTarget,
    request: SavedWorkflowLaunchRequest,
  ) => Promise<SavedWorkflowLaunchResult>;
  /** Launching: args-dialog primary button loading + disabled against double clicks. */
  pending: boolean;
  /** Most recent launch failure (cleared on success / before a new attempt). */
  error: SavedWorkflowLaunchError | null;
  clearError: () => void;
}

// Fault code the v4 handler returns when the capability is missing (no dwf port) (interaction-background.ts).
const CAPABILITY_UNSUPPORTED_FAULT = "fault.command.capabilityUnsupported";

/** createSession workspaceId matches the conversation binding key: identity first, else path. */
export function launchWorkspaceId(target: SavedWorkflowLaunchTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

/**
 * Connection lease for the target project (remoteSessionId decides the endpoint). Shared by the
 * direct launcher and promote-to-global (useSavedWorkflowPromote): both create a session in the
 * target project; only the first command differs.
 */
export function acquireLaunchLease(
  target: SavedWorkflowLaunchTarget,
  agentService: WorkspaceConnectionAgentService,
) {
  return acquireWorkspaceConnection(
    {
      workspacePath: target.workspacePath,
      ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      ...(target.remoteSessionId ? { remoteSessionId: target.remoteSessionId } : {}),
    },
    agentService,
  );
}

/** Map a rejected ACK onto a structured error: missing capability -> unsupported; rejection vocabulary -> its reason; else generic. */
function mapLaunchError(ack: CommandAck): SavedWorkflowLaunchError {
  const code = ack.reasonCode ?? ack.status;
  const message = ack.message;
  if (ack.reasonCode === CAPABILITY_UNSUPPORTED_FAULT) {
    return { reason: "unsupported", code, ...(message ? { message } : {}) };
  }
  if (ack.reasonCode?.startsWith(SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX)) {
    const suffix = ack.reasonCode.slice(SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX.length);
    const parsed = savedWorkflowStartRejectionReasonSchema.safeParse(suffix);
    if (parsed.success) return { reason: parsed.data, code, ...(message ? { message } : {}) };
  }
  // Unknown faults / non-vocabulary rejections (including new codes met by old clients) render as the generic error.
  return { reason: "generic", code, ...(message ? { message } : {}) };
}

/**
 * The hub launcher hook. The carrier `agentService` is resolved by the calling group (project
 * group = the target project's resolved service; global group = the local base service with target
 * = the local project chosen in run-on). `onNavigate` switches to the new session after accepted
 * (mirrors handleSelectTaskInChat, including showChatMainView).
 */
export function useSavedWorkflowLauncher(params: {
  agentService: WorkspaceConnectionAgentService;
  onNavigate?: (target: SavedWorkflowLaunchTarget, sessionId: string) => void;
}): UseSavedWorkflowLauncherResult {
  const { agentService, onNavigate } = params;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<SavedWorkflowLaunchError | null>(null);
  // Synchronous source of truth for pending: guards same-frame double triggers (setPending is async; state alone cannot).
  const pendingRef = useRef(false);

  const clearError = useCallback(() => setError(null), []);

  const launch = useCallback(
    async (
      target: SavedWorkflowLaunchTarget,
      request: SavedWorkflowLaunchRequest,
    ): Promise<SavedWorkflowLaunchResult> => {
      if (pendingRef.current) {
        return { ok: false, error: { reason: "generic", code: "launch_in_flight" } };
      }
      pendingRef.current = true;
      setPending(true);
      setError(null);

      const workspaceId = launchWorkspaceId(target);
      const lease = acquireLaunchLease(target, agentService);

      const deleteCreatedSession = (sessionId: string) => {
        void lease.transport
          .sendCommand(createCommandEnvelope({ type: "deleteSession", payload: {}, sessionId }))
          .then((ack) => {
            if (ack.status !== "accepted" && ack.status !== "noop") {
              logger.warn("[saved-workflow-launch] empty-session cleanup rejected", {
                sessionId,
                status: ack.status,
                reasonCode: ack.reasonCode ?? null,
              });
            }
          })
          .catch(() => {
            // Cleanup failure is harmless: the in-memory session dies with the CLI and never appears in the transcript (no rows).
          });
      };

      let createdSessionId: string | null = null;
      try {
        // (1) Empty session: no firstInput, no config - runtime-default model/mode, never the composer draft config.
        const createAck = await lease.transport.sendCommand(
          createCommandEnvelope({
            type: "createSession",
            payload: { workspaceId },
            sessionId: null,
          }),
        );
        if (createAck.status !== "accepted" || createAck.result?.type !== "createSession") {
          // Session not created: no start, no session, generic error.
          logger.warn("[saved-workflow-launch] createSession rejected", {
            workspaceId,
            status: createAck.status,
            reasonCode: createAck.reasonCode ?? null,
          });
          const err: SavedWorkflowLaunchError = {
            reason: "generic",
            code: createAck.reasonCode ?? createAck.status,
            ...(createAck.message ? { message: createAck.message } : {}),
          };
          setError(err);
          return { ok: false, error: err };
        }
        createdSessionId = createAck.result.sessionId;

        // (2) startSavedWorkflow: name/scope-directed lookup + args; omit the args key when empty.
        const startAck = await lease.transport.sendCommand(
          createCommandEnvelope({
            type: "startSavedWorkflow",
            payload: {
              name: request.name,
              scope: request.scope,
              ...(Object.keys(request.args).length > 0 ? { args: request.args } : {}),
            },
            sessionId: createdSessionId,
          }),
        );
        if (startAck.status === "accepted" && startAck.result?.type === "startSavedWorkflow") {
          // accepted: the launch card already sits atop the new session; switch to it to bring it alive (without a navigator, launch silently and stay).
          onNavigate?.(target, createdSessionId);
          return {
            ok: true,
            sessionId: createdSessionId,
            runId: startAck.result.runId,
            toolCallId: startAck.result.toolCallId,
          };
        }
        // Launch rejected / failed: reclaim the just-created empty session (invariant 2) and return the reason to the args dialog / toast.
        deleteCreatedSession(createdSessionId);
        const err = mapLaunchError(startAck);
        setError(err);
        return { ok: false, error: err };
      } catch (thrown) {
        if (createdSessionId) deleteCreatedSession(createdSessionId);
        const err: SavedWorkflowLaunchError = {
          reason: "generic",
          code: "exception",
          message: thrown instanceof Error ? thrown.message : String(thrown),
        };
        setError(err);
        return { ok: false, error: err };
      } finally {
        lease.release();
        pendingRef.current = false;
        setPending(false);
      }
    },
    [agentService, onNavigate],
  );

  return { launch, pending, error, clearError };
}
