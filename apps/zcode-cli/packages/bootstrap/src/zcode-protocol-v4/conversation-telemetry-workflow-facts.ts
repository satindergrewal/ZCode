// ============================================================
// Attribution facts for dynamic-workflow subagents (subagent token telemetry).
// ============================================================
// The parent session's DynamicWorkflowRunProgress events -> `workflow.lifecycle` telemetry facts. Derived only on two engine events:
// actor-created (registers subagent <-> child session <-> origin turn) and run-settled (terminal state of all of the run's subagents).
// Without a `launchInputId` (pre-upgrade runs) nothing is emitted: an anchorless step has nowhere to hang -- prefer missing over fabricated.

import type { DynamicWorkflowRunProgressPayload } from "@zcode/contracts";
import {
  conversationTelemetryFactSchema,
  type ConversationTelemetryFact,
} from "@zcode/shared/zcode-protocol-v4";

const ACTOR_CREATED_EVENT_TYPE = "actor-created";
const RUN_SETTLED_EVENT_TYPE = "run-settled";
const RUN_STOPPED_ERROR_MESSAGE = "Workflow run stopped";

/** The run's three terminal-state words plus stop reasons; same set as the engine's RunStatus / RunStopReason. */
type WorkflowRunSettledStatus = "completed" | "errored" | "stopped";
type WorkflowRunStopReason = "user" | "model" | "provider" | "interrupted" | "superseded";

/** Derived fields on the progress event envelope (attached by toProgressPayload; contract in DynamicWorkflowRunProgressPayload). */
interface WorkflowProgressDerivedFields {
  actorSessionId?: unknown;
  launchInputId?: unknown;
}

export function workflowLifecycleFactFromProgress(
  base: Record<string, unknown>,
  progress: DynamicWorkflowRunProgressPayload,
): ConversationTelemetryFact | null {
  const derived = progress as DynamicWorkflowRunProgressPayload & WorkflowProgressDerivedFields;
  const launchInputId = optionalString(derived.launchInputId);
  if (launchInputId === undefined) return null;
  const toolCallId = optionalString(progress.toolCallId);

  if (progress.eventType === ACTOR_CREATED_EVENT_TYPE) {
    const childSessionId = optionalString(derived.actorSessionId);
    const agentId = actorRefString(progress.payload.actor);
    if (childSessionId === undefined || agentId === undefined) return null;
    return conversationTelemetryFactSchema.parse({
      ...base,
      kind: "workflow.lifecycle",
      phase: "actor-spawned",
      // The anchor is the sourceCommandId: the subagent step hangs under the message of the turn that started the run.
      sourceCommandId: launchInputId,
      runId: progress.runId,
      ...(toolCallId === undefined ? {} : { toolCallId }),
      agentId,
      childSessionId,
    });
  }

  if (progress.eventType === RUN_SETTLED_EVENT_TYPE) {
    const status = settledStatus(progress.payload.status);
    if (status === undefined) return null;
    const stopReason =
      status === "stopped" ? settledStopReason(progress.payload.stopReason) : undefined;
    // Error text mirrors the engine event: errored always carries error; stopped carries it only for provider / interrupted;
    // user / model stops have none, so a fixed string plus the reason keeps the dashboard able to tell who stopped it.
    const engineMessage = optionalString(errorRecord(progress.payload.error)?.message);
    const errorMessage =
      status === "completed"
        ? undefined
        : (engineMessage ?? (status === "stopped" ? stoppedMessage(stopReason) : undefined));
    return conversationTelemetryFactSchema.parse({
      ...base,
      kind: "workflow.lifecycle",
      phase: "run-settled",
      sourceCommandId: launchInputId,
      runId: progress.runId,
      ...(toolCallId === undefined ? {} : { toolCallId }),
      status,
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(errorMessage === undefined ? {} : { errorMessage }),
    });
  }

  return null;
}

/** `siteId@ordinal`: the same string as the dwf engine's refToString (also the run side panel's subagent label). */
function actorRefString(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const ref = value as { siteId?: unknown; ordinal?: unknown };
  const siteId = optionalString(ref.siteId);
  if (siteId === undefined || typeof ref.ordinal !== "number" || !Number.isFinite(ref.ordinal)) {
    return undefined;
  }
  return `${siteId}@${ref.ordinal}`;
}

function settledStatus(value: unknown): WorkflowRunSettledStatus | undefined {
  return value === "completed" || value === "errored" || value === "stopped" ? value : undefined;
}

function settledStopReason(value: unknown): WorkflowRunStopReason | undefined {
  return value === "user" ||
    value === "model" ||
    value === "provider" ||
    value === "interrupted" ||
    value === "superseded"
    ? value
    : undefined;
}

function stoppedMessage(reason: WorkflowRunStopReason | undefined): string {
  return reason === undefined
    ? RUN_STOPPED_ERROR_MESSAGE
    : `${RUN_STOPPED_ERROR_MESSAGE} (${reason})`;
}

function errorRecord(value: unknown): { message?: unknown } | undefined {
  return typeof value === "object" && value !== null ? (value as { message?: unknown }) : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
