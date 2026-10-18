import { PERMISSION_FULL_ACCESS_OPTION_ID } from "@zcode/shared/zcode-protocol-v4";
// Permission/background command group: resolveInteraction / cancelBackgroundWork.
// - resolveInteraction: a forward command closing out a reverse request (permission/AskUserQuestion) via
//   host.interactions (V4InteractionRegistry) to the broker-side waiting deferred.
// - cancelBackgroundWork: drives core's optional cancelBackgroundTask (workId == taskId).
import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
  SavedWorkflowStartRejectionReason,
  WorkflowRunSettingsRejectionReason,
} from "@zcode/shared/zcode-protocol-v4";
import {
  BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX,
  SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX,
  WORKFLOW_RUN_RESUME_REJECTED_FAULT_PREFIX,
  WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX,
} from "@zcode/shared/zcode-protocol-v4";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";

/**
 * Unsupported-capability error: thrown when the session runtime lacks an optional capability (mirrors legacy
 * server-operations.ts cancelBackgroundTask's ProtocolRequestError -32031). v4 dropped JSON-RPC error codes for
 * structured Errors with reasonCode (fault namespace); the gateway closes the ACK on them.
 */
export class V4CapabilityUnsupportedError extends Error {
  readonly reasonCode = "fault.command.capabilityUnsupported";

  constructor(capability: string, sessionId: string) {
    super(`capability not supported by this session runtime: ${capability} (session ${sessionId})`);
    this.name = "V4CapabilityUnsupportedError";
  }
}

/**
 * resolveInteraction: deliver an answer to a waiting reverse request (interaction-broker race deferred).
 *
 * Semantic fidelity (survey conclusion):
 * - a miss (delivered === false; already answered/unregistered/unknown id) closes as idempotent success, no
 *   throw - multi-client first-wins; a late answer is harmless idempotence, and failed would mislead clients.
 * - no requireRecord: a late answer may arrive after the session closed/was deleted and must stay harmless;
 *   the registry addresses by interactionId globally, no record needed.
 */
async function resolveInteraction(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["resolveInteraction"];
  const delivered =
    payload.answer.optionId === PERMISSION_FULL_ACCESS_OPTION_ID
      ? ((await host.interactions?.resolveFullAccess(payload.interactionId, envelope.sessionId!)) ??
        false)
      : (host.interactions?.resolve(payload.interactionId, payload.answer) ?? false);
  if (!delivered) {
    host.logger?.info?.("v4 resolveInteraction no pending interaction (idempotent)", {
      event: "zcode_protocol.v4.interaction_already_resolved",
      interactionId: payload.interactionId,
      sessionId: envelope.sessionId,
    });
  }
  return undefined;
}

async function snoozeInteractionAutoResolution(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["snoozeInteractionAutoResolution"];
  const snoozed = (await host.interactions?.snoozeAutoResolution(payload.interactionId)) ?? false;
  if (!snoozed) {
    host.logger?.info?.("v4 snoozeInteractionAutoResolution no active countdown (idempotent)", {
      event: "zcode_protocol.v4.interaction_auto_resolution_already_snoozed",
      interactionId: payload.interactionId,
      sessionId: envelope.sessionId,
    });
  }
  return undefined;
}

class V4WorkspaceHookReviewRejectedError extends Error {
  constructor(readonly reasonCode: string) {
    super(`Workspace Hook review command rejected: ${reasonCode}`);
    this.name = "V4WorkspaceHookReviewRejectedError";
  }
}

async function respondWorkspaceHookReview(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["respondWorkspaceHookReview"];
  const record = requireWorkspaceHookReviewRecord(host, envelope, payload.sessionId);
  const result = await record.app.respondWorkspaceHookReview(payload);
  if (!result.accepted) throw new V4WorkspaceHookReviewRejectedError(result.reasonCode);
  return undefined;
}

async function toggleWorkspaceHookReviewItem(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["toggleWorkspaceHookReviewItem"];
  const record = requireWorkspaceHookReviewRecord(host, envelope, payload.sessionId);
  const result = await record.app.toggleWorkspaceHookReviewItem(payload);
  if (!result.accepted) throw new V4WorkspaceHookReviewRejectedError(result.reasonCode);
  return undefined;
}

async function revokeWorkspaceHookTrust(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["revokeWorkspaceHookTrust"];
  const record = requireWorkspaceHookReviewRecord(host, envelope, payload.sessionId);
  const result = await record.app.revokeWorkspaceHookTrust(payload);
  if (!result.accepted) throw new V4WorkspaceHookReviewRejectedError(result.reasonCode);
  return undefined;
}

/**
 * Soft gate: open a review flow on demand.
 *
 * Called when the user clicks review. Via controller.requestReview -> openOrReuseFlow +
 * superviseFlow. Idempotent reuse on a live flow; safe no-op with no pending items.
 */
async function requestWorkspaceHookReview(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["requestWorkspaceHookReview"];
  const record = requireWorkspaceHookReviewRecord(host, envelope, payload.sessionId);
  const result = await record.app.requestWorkspaceHookReview({
    workspaceIdentity: payload.workspaceIdentity,
    bundleDigest: payload.bundleDigest,
  });
  if (!result.accepted) throw new V4WorkspaceHookReviewRejectedError(result.reasonCode);
  return undefined;
}

function requireWorkspaceHookReviewRecord(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
  payloadSessionId: string,
) {
  if (envelope.sessionId !== payloadSessionId) {
    throw new V4WorkspaceHookReviewRejectedError("workspace_hooks_snapshot_mismatch");
  }
  return requireRecord(host, envelope.sessionId);
}

/**
 * cancelBackgroundWork's business refusal: core explicitly answered nothing-cancelled (reason present).
 *
 * When a stale run is left running by cold replay, the details page Cancel is clickable
 * yet core finds no such task (background_task_not_found); the legacy handler dropped the structured result and
 * returned accepted - click-with-no-effect for the user. core's reason is the sole authority; only prefix-forward it.
 */
class V4BackgroundWorkCancelRejectedError extends Error {
  readonly reasonCode: string;
  constructor(reason: string, workId: string) {
    super(`background work ${workId} was not cancelled: ${reason}`);
    this.name = "V4BackgroundWorkCancelRejectedError";
    this.reasonCode = `${BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX}${reason.replace(/^background_task_/, "")}`;
  }
}

/**
 * cancelBackgroundWork: workId == legacy taskId, straight to core.
 * - cancelBackgroundTask is an optional ZCodeApp capability: missing -> unsupported-capability (above).
 * - core returns a reason (missing/terminal/unsupported type) -> ACK with reasonCode
 *   fault.command.backgroundWorkCancelRejected.<reason>; a real cancel or absent return (stub host) is accepted.
 * - no legacy broadcast needed: BackgroundTask* (Started/Updated/Completed) lifecycle events are emitted by core
 *   directly; the v4 projection (product-projection backgroundWorks) closes itself out - unlike the legacy op's
 *   afterStateMutation(background_task_cancelled), v4 owes no such call.
 */
async function cancelBackgroundWork(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["cancelBackgroundWork"];
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.cancelBackgroundTask) {
    throw new V4CapabilityUnsupportedError("cancelBackgroundTask", record.app.sessionId);
  }
  // Note: call via app (do not destructure; the implementation may rely on this binding).
  const result = await record.app.cancelBackgroundTask(payload.workId);
  if (result?.reason !== undefined) {
    throw new V4BackgroundWorkCancelRejectedError(result.reason, payload.workId);
  }
  return undefined;
}

/**
 * resumeWorkflowRun: workId == runId, straight to the app capability.
 * - capability absent (no journal / port without resume) -> unsupported-capability (same semantics as cancel).
 * - business refusal (not_found / not_resumable / already_running / script_missing /
 *   script_mismatch / compile_failed) ACKs with reasonCode
 *   fault.command.workflowRunResumeRejected.<reason> - the gateway forwards reason-bearing domain errors verbatim
 *   and the UI dispatches on the vocabulary, never on error text.
 *   compile_failed's bounded diagnostics ride error.message into ack.message (same convention as
 *   startSavedWorkflow).
 */
class V4WorkflowRunResumeRejectedError extends Error {
  readonly reasonCode: string;
  constructor(reason: string, message?: string) {
    super(message ?? `workflow run resume rejected: ${reason}`);
    this.name = "V4WorkflowRunResumeRejectedError";
    this.reasonCode = `${WORKFLOW_RUN_RESUME_REJECTED_FAULT_PREFIX}${reason}`;
  }
}

async function resumeWorkflowRun(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["resumeWorkflowRun"];
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.resumeWorkflowRun) {
    throw new V4CapabilityUnsupportedError("resumeWorkflowRun", record.app.sessionId);
  }
  // Note: call via app (do not destructure; the implementation may rely on this binding).
  const result = await record.app.resumeWorkflowRun({
    workId: payload.workId,
    ...(payload.name === undefined ? {} : { name: payload.name }),
  });
  if (!result.ok) throw new V4WorkflowRunResumeRejectedError(result.reason, result.message);
  return undefined;
}

/**
 * startSavedWorkflow: hub-side launch of a saved workflow.
 * - capability absent (no dwf port / stub host) -> unsupported-capability (one semantics for the resume family);
 *   the GUI shows direct-launch-unsupported verbatim and reclaims the empty session.
 * - business refusal (invalid_name / not_found / invalid_args / compile_failed / session_busy / start_failed)
 *   ACKs with reasonCode fault.command.savedWorkflowStartRejected.<reason>; message carries human-readable
 *   diagnostics (bounded post-merge compile output) for inline display in the args dialog. The gateway forwards
 *   reason-bearing domain errors verbatim and collects error.message into ack.message; the UI dispatches on the
 *   vocabulary, never flow-decides on error text.
 * - success ACKs result { type: startSavedWorkflow, runId, toolCallId } (tool card -> details page).
 * Note: a non-input command (no queueing, no baseRevision), same family as resume/cancel, registered in this
 * interaction-background group.
 */
class V4SavedWorkflowStartRejectedError extends Error {
  readonly reasonCode: string;
  constructor(reason: SavedWorkflowStartRejectionReason, message?: string) {
    // message goes straight into ack.message (gateway convention: error.message closes into ACK); readable
    // fallback when absent.
    this.name = "V4SavedWorkflowStartRejectedError";
    this.reasonCode = `${SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX}${reason}`;
  }
}

async function startSavedWorkflow(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["startSavedWorkflow"];
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.startSavedWorkflow) {
    throw new V4CapabilityUnsupportedError("startSavedWorkflow", record.app.sessionId);
  }
  // Note: call via app (do not destructure; the implementation may rely on this binding).
  const result = await record.app.startSavedWorkflow({
    name: payload.name,
    ...(payload.scope === undefined ? {} : { scope: payload.scope }),
    ...(payload.args === undefined ? {} : { args: payload.args }),
  });
  if (!result.ok) throw new V4SavedWorkflowStartRejectedError(result.reason, result.message);
  return { type: "startSavedWorkflow", runId: result.runId, toolCallId: result.toolCallId };
}

/**
 * amendWorkflowRunSettings: the run card / details page Configure. workId == runId; the two settings' tri-state
 * passes through to the runtime verbatim.
 * - capability absent (no dwf port, or port without amend/getScript) -> unsupported-capability dialog.
 * - business refusal ACKs fault.command.workflowRunSettingsRejected.<reason> with message carrying diagnostics
 *   (compile / model-resolution / start failure); on refusal the old run keeps running.
 * - success ACKs result { type, runId, toolCallId, supersededRunId? } - the two linkage keys the details page
 *   uses to switch the tab to the new run.
 */
class V4WorkflowRunSettingsRejectedError extends Error {
  readonly reasonCode: string;
  constructor(reason: WorkflowRunSettingsRejectionReason, message?: string) {
    super(message ?? `workflow run settings rejected: ${reason}`);
    this.name = "V4WorkflowRunSettingsRejectedError";
    this.reasonCode = `${WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX}${reason}`;
  }
}

async function amendWorkflowRunSettings(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["amendWorkflowRunSettings"];
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.amendWorkflowRunSettings) {
    throw new V4CapabilityUnsupportedError("amendWorkflowRunSettings", record.app.sessionId);
  }
  // Note: call via app (do not destructure; the implementation may rely on this binding).
  const result = await record.app.amendWorkflowRunSettings({
    runId: payload.workId,
    ...(payload.subagentModel === undefined ? {} : { subagentModel: payload.subagentModel }),
    ...(payload.maxConcurrency === undefined ? {} : { maxConcurrency: payload.maxConcurrency }),
  });
  if (!result.ok) throw new V4WorkflowRunSettingsRejectedError(result.reason, result.message);
  return {
    type: "amendWorkflowRunSettings",
    runId: result.runId,
    toolCallId: result.toolCallId,
    ...(result.supersededRunId === undefined ? {} : { supersededRunId: result.supersededRunId }),
  };
}

export const interactionBackgroundHandlers = {
  resolveInteraction,
  respondWorkspaceHookReview,
  toggleWorkspaceHookReviewItem,
  revokeWorkspaceHookTrust,
  requestWorkspaceHookReview,
  snoozeInteractionAutoResolution,
  cancelBackgroundWork,
  resumeWorkflowRun,
  startSavedWorkflow,
  amendWorkflowRunSettings,
};
