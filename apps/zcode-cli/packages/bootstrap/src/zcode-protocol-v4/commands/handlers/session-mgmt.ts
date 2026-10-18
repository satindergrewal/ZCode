// Session management commands: createSession / renameSession / deleteSession.
// One file per command group: handlers are pure (host, envelope) -> CommandResult|undefined,
// decision logic drives core directly, environment capabilities via host hooks (see the transition notes in ../types.ts).
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { mapAttachmentRefsToTurnAttachments } from "../attachment-refs.js";
import { inputIntentMetadata } from "../input-intent.js";
import { commandAdmissionOf } from "../executor.js";
import { startPromptTurn } from "../prompt-turn.js";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";
import { applyRequestedSessionConfig } from "./model-config.js";
import {
  hasPromptInput,
  V4InputAdmissionRejectedError,
  resolveSubmittedExecutionState,
} from "./session-flow.js";

/**
  * createSession: nativizing the last item of the fallback surface.
  * Semantic decisions (owned by the native layer):
  * - draft semantics: new sessions are always deferred (not in sqlite); the first send promotes via prompt-turn
  *   to immediate -- the record-creation hook always passes deferred; promotion logic is not in the hook.
  * - firstInput optional: when present, submitted via the native prompt turn (the same write path as sendText --
  *   draft promotion / submit-and-return / ready boundary come free), never via the legacy sendPrompt op.
  * - workspaceId: local workspace = workspacePath (the Workspace Identity constraint's local fallback);
  *   remote identities (remote:ssh/wsl/docker:...) are parsed uniformly by host.createSessionRecord via
  *   @zcode/shared parseRemoteWorkspaceIdentity (cross-workspace split panes).
  * Execution face (transition hooks): record creation/event wiring/catalog sync/failure cleanup are entangled with the legacy host --
  * via host.createSessionRecord (see ../types.ts).
 */
async function createSession(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["createSession"];
  if (!host.createSessionRecord) {
    throw new Error("v4 createSession requires host.createSessionRecord capability");
  }
    // A completely empty firstInput must be rejected before the record exists, avoiding a failed request leaving an invalid deferred session.
  if (
    payload.firstInput &&
    !hasPromptInput(payload.firstInput.text, payload.firstInput.attachments)
  ) {
    throw new V4InputAdmissionRejectedError("proto.invalidPayload", "input must not be empty");
  }
  const { sessionId } = await host.createSessionRecord({
    workspaceId: payload.workspaceId,
    mcpServers: payload.mcpServers,
    offPeakToolEnabled: payload.offPeakToolEnabled,
    dynamicWorkflowEnabled: payload.dynamicWorkflowEnabled,
  });
    // createSession.config consumption -- the draft UI's advance choices (model/thinking depth/
    // mode) apply before the first send, events emitted, so turn one already uses them. Must precede firstInput.
    // An apply failure does not fail the session creation (record exists; a failed ACK would only leak a session): degrade to warn,
    // session keeps runtime defaults.
  if (payload.config) {
    const record = requireRecord(host, sessionId);
    try {
      await applyRequestedSessionConfig(host, record, payload.config);
    } catch (error) {
      host.logger?.warn?.("v4 createSession config apply failed; session keeps runtime defaults", {
        error: error instanceof Error ? error.message : String(error),
        sessionId,
      });
    }
  }
  let firstInput:
    | {
        delivery: "startNow" | "queue" | "guide";
        inputId: string;
        messageId?: string;
      }
    | undefined;
  if (payload.firstInput) {
        // Attachment command surface: firstInput.attachments (AttachmentRef -> TurnAttachment) go with the first send.
    const record = requireRecord(host, sessionId);
    const admission = commandAdmissionOf(envelope);
    const durableAdmission =
      (await host.admitInputCommand?.(envelope, sessionId, admission)) ?? null;
    try {
      const attachments = await mapAttachmentRefsToTurnAttachments(
        record.app,
        payload.firstInput.attachments,
      );
      const intent = inputIntentMetadata(envelope, {
        text: payload.firstInput.text,
        requestedDelivery: "startNow",
        attachmentRefs: payload.firstInput.attachments,
        ...resolveSubmittedExecutionState(record, payload.firstInput),
      });
      const started = await startPromptTurn(host, record, {
        content: payload.firstInput.text,
        inputId: envelope.commandId,
        intent,
        ...(attachments ? { attachments } : {}),
      });
      firstInput = {
        delivery: started.admission.kind === "queued" ? "queue" : "startNow",
        inputId: envelope.commandId,
        ...(started.messageId ? { messageId: started.messageId } : {}),
      };
    } catch (error) {
      if (durableAdmission) {
        try {
          await host.cancelInputCommand?.(
            sessionId,
            admission.queueItemId,
            "fault.command.inputRejected",
          );
        } catch (cancelError) {
                    // A cancellation-ledger failure must not mask the real first-send failure, or the client gets the wrong cause
                    // while admission can still close as discarded on restart-query -- never misread as success.
          host.logger?.warn?.("v4 createSession first input cancellation failed", {
            cancelError: cancelError instanceof Error ? cancelError.message : String(cancelError),
            inputError: error instanceof Error ? error.message : String(error),
            queueItemId: admission.queueItemId,
            sessionId,
          });
        }
      }
      throw error;
    }
  }
  return { type: "createSession", sessionId, ...(firstInput ? { input: firstInput } : {}) };
}

/**
  * renameSession: explicit user rename -> core runtime.setCustomSessionTitle.
  * - titleSource=custom stickiness (later auto-titling short-circuits on custom_title) is core's guarantee
  *   (core/src/runtime/methods/session-title.ts); the handler does not reimplement it.
  * - traceContext passes the session-root traceContext (the record's narrow-view field): the rename attributes to that
  *   session's task chain, no new trace (observability discipline).
  * - No legacy broadcast: core emits SessionTitleUpdated, closed via the gateway projection,
  *   and v4 consumers learn of the title change there.
 */
async function renameSession(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["renameSession"];
  const record = requireRecord(host, envelope.sessionId);
    // Note: call through runtime (no destructuring -- the implementation relies on this binding, see methods/index.ts mounting).
  await record.app.runtime.setCustomSessionTitle({
    title: payload.title,
    traceContext: record.traceContext,
  });
  return undefined;
}

/**
  * deleteSession: semantics = closeSession (close + release runtime resources), not a real record delete --
  * the message store has no delete API, matching the legacy path (its "delete" is also just close; history stays,
  * only absent from the active registry).
  * The session registry stays with the host; the close itself goes through the host.closeSession transition hook (destination: v4-owned registry, ../types.ts).
 */
async function deleteSession(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const record = requireRecord(host, envelope.sessionId);
  if (!host.closeSession) {
        // Close must not degrade silently: a missing hook means incomplete binder wiring -- fail directly (ACK failed).
    throw new Error("v4 deleteSession requires host.closeSession capability");
  }
  await host.closeSession(record.app.sessionId);
  return undefined;
}

async function discardSharedContext(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["discardSharedContext"];
  const sessionId = envelope.sessionId;
  if (!sessionId || !host.discardSharedContext) {
    throw new Error("v4 discardSharedContext requires a session-scoped storage capability");
  }
  const updated = await host.discardSharedContext(sessionId, payload.contextId);
  if (!updated)
    throw new V4InputAdmissionRejectedError(
      "fault.command.inputRejected",
      "shared context is not pending",
    );
  return undefined;
}

export const sessionMgmtHandlers = {
  createSession,
  renameSession,
  deleteSession,
  discardSharedContext,
};
