// ============================================================
// Structured explanation when a run-detail Cancel / Resume is rejected.
// ============================================================
// When a stale run is wrongly left running, Cancel hits a CLI that no longer knows the task and
// Resume collides with a script that no longer compiles -- both commands only log one warn line to
// the console, leaving the user with "clicked, nothing happened". The ACK's reasonCode is now
// looked up against two vocabularies and turned into one sentence under the status header;
// anything outside the vocabularies gets the generic copy plus the code.

import {
  BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX,
  WORKFLOW_RUN_RESUME_REJECTED_FAULT_PREFIX,
  type CommandAck,
} from "@zcode/shared/zcode-protocol-v4";

export type WorkflowRunAction = "cancel" | "resume";

/** Same capability-missing fault as useSavedWorkflowLauncher (the gateway's reasonCode for V4CapabilityUnsupportedError). */
const CAPABILITY_UNSUPPORTED_FAULT = "fault.command.capabilityUnsupported";

/** Closed set of core stopBackgroundTask reasons minus the `background_task_` prefix (minted by the bootstrap handler). */
const CANCEL_REASONS: ReadonlySet<string> = new Set([
  "not_found",
  "not_running",
  "cancel_not_supported",
]);
/** Closed set mirroring DynamicWorkflowRunResumeErrorReason. */
const RESUME_REASONS: ReadonlySet<string> = new Set([
  "not_found",
  "not_resumable",
  "superseded",
  "already_running",
  "script_missing",
  "script_mismatch",
  "compile_failed",
]);

export interface WorkflowRunActionRejection {
  action: WorkflowRunAction;
  /** In-vocabulary reason, or `unsupported` (capability missing) / `generic` (outside the vocabulary; copy carries the code). */
  reason: string;
  /** Raw reasonCode (ack.status when absent); shown in the generic copy and used in logs. */
  code: string;
  /** Human-readable detail carried by the ACK (bounded diagnostics for compile_failed). */
  message?: string;
}

/** accepted / noop are not rejections -> undefined; everything else normalizes via the vocabularies. */
export function describeWorkflowRunActionRejection(
  action: WorkflowRunAction,
  ack: Pick<CommandAck, "status" | "reasonCode" | "message">,
): WorkflowRunActionRejection | undefined {
  if (ack.status === "accepted" || ack.status === "noop") return undefined;
  const code = ack.reasonCode ?? ack.status;
  const prefix =
    action === "cancel"
      ? BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX
      : WORKFLOW_RUN_RESUME_REJECTED_FAULT_PREFIX;
  const known = action === "cancel" ? CANCEL_REASONS : RESUME_REASONS;
  let reason = "generic";
  if (ack.reasonCode === CAPABILITY_UNSUPPORTED_FAULT) reason = "unsupported";
  else if (ack.reasonCode?.startsWith(prefix)) {
    const suffix = ack.reasonCode.slice(prefix.length);
    if (known.has(suffix)) reason = suffix;
  }
  return { action, reason, code, ...(ack.message ? { message: ack.message } : {}) };
}

/** Copy key: `chat.toolCall.workflow.run.rejection.<action>.<reason>`; both vocabularies plus unsupported and generic live in locale. */
export function workflowRunActionRejectionMessageId(rejection: WorkflowRunActionRejection): string {
  return `chat.toolCall.workflow.run.rejection.${rejection.action}.${rejection.reason}`;
}
