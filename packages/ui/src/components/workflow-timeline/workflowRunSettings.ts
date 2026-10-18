// ============================================================
// Pure rules behind the "Configure" dialog
// ============================================================
// The dialog component only draws and wires; every decision lives here: which runs are configurable, where the form starts, what Apply sends,
// which message a rejected ACK carries. Pure functions, no store access, exhaustively enumerable.

import {
  WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX,
  workflowRunSettingsRejectionReasonSchema,
  type AmendWorkflowRunSettingsPayload,
  type CommandAck,
  type WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import { formatModelPickerValue, parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";

/**
 * The session's current model (whence the "session model" entry's name): prefers the session's persisted sparse choice, falls back to the
 * UI-effective provider / model projection; absent when neither can be read.
 */
export function workflowSessionModelOf(
  config:
    | { modelSelection?: { providerId: string; modelId: string }; provider: string; model: string }
    | null
    | undefined,
): { providerId: string; modelId: string } | undefined {
  if (config === null || config === undefined) return undefined;
  const selection = config.modelSelection;
  if (selection !== undefined)
    return { providerId: selection.providerId, modelId: selection.modelId };
  const providerId = config.provider.trim();
  const modelId = config.model.trim();
  return providerId && modelId ? { providerId, modelId } : undefined;
}

/** The subagent model in the form: the session model, or one concrete model (optionally with a reasoning level). */
export type WorkflowRunSettingsModel =
  | { kind: "session" }
  | { kind: "model"; providerId: string; modelId: string; level?: string };

/** The form's two settings. `bound` null = "this run has no own bound" (runs on the machine ceiling). */
export interface WorkflowRunSettingsDraft {
  model: WorkflowRunSettingsModel;
  bound: number | null;
}

/** The part of the payload Apply sends (workId is filled in by the host). */
export type WorkflowRunSettingsChange = Omit<AmendWorkflowRunSettingsPayload, "workId">;

/**
 * Which runs are configurable:
 * pending / running yes (throttling or model swap is the main case); stopped yes, unless superseded by a revision (its
 * successor is the live one); errored yes (retry on another model is the most common fix); completed no (every ask replays from cache, nothing
 * runs under the new settings); a run missing from the projection has no settings to show. Host callbacks and rollout gates are layered on by the caller.
 */
export function isWorkflowRunConfigurable(run: WorkflowRunState | undefined): boolean {
  if (run === undefined) return false;
  switch (run.status) {
    case "pending":
    case "running":
    case "errored":
      return true;
    case "stopped":
      return run.supersededBy === undefined && run.stopReason !== "superseded";
    case "completed":
      return false;
  }
}

/**
 * This machine's concurrency ceiling: prefer `run.concurrencyCeiling` (attached by `run-started`, always present); on older CLIs without it, fall back to
 * the readout chip's own level `concurrency.ceiling`. With neither, unknown — the stepper gets no maximum and writes no hint.
 */
export function workflowRunSettingsCeiling(run: WorkflowRunState): number | undefined {
  return run.concurrencyCeiling ?? run.concurrency?.ceiling;
}

/** Canonical string -> form model; when parsing fails (malformed string) reading it as the session model does not hold, so keep it verbatim as an unresolvable concrete model. */
export function workflowRunSettingsModelOf(
  canonical: string | undefined,
): WorkflowRunSettingsModel {
  const text = canonical?.trim();
  if (!text) return { kind: "session" };
  try {
    const parsed = parseModelPickerValue(text);
    const level = parsed.options?.reasoningLevel;
    return {
      kind: "model",
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      ...(level === undefined ? {} : { level }),
    };
  } catch {
    return { kind: "model", providerId: "", modelId: text };
  }
}

/** Form model -> canonical string `providerId/modelId[$level]`; the session model has no string (undefined). */
export function workflowRunSettingsModelCanonical(
  model: WorkflowRunSettingsModel,
): string | undefined {
  if (model.kind === "session") return undefined;
  if (model.providerId === "") return model.modelId;
  return formatModelPickerValue({
    providerId: model.providerId,
    modelId: model.modelId,
    ...(model.level === undefined ? {} : { options: { reasoningLevel: model.level } }),
  });
}

/** Starting point when the dialog opens: both values from the run's own current settings. With no bound, stop at the ceiling (null if that is unknown too). */
export function initialWorkflowRunSettingsDraft(run: WorkflowRunState): WorkflowRunSettingsDraft {
  const limit = run.concurrency?.limit;
  return {
    model: workflowRunSettingsModelOf(run.subagentModel),
    bound: limit ?? workflowRunSettingsCeiling(run) ?? null,
  };
}

/** Normalizing the bound: at or above the ceiling counts as "no own bound". */
function normalizedBound(bound: number | null, ceiling: number | undefined): number | null {
  if (bound === null) return null;
  return ceiling !== undefined && bound >= ceiling ? null : bound;
}

/**
 * What Apply sends: only the **changed** values (the tool's same three-state: omitted = keep). Models compare by canonical string —
 * a reasoning-level-only change still counts as a model change; back to the session model sends `null`. Bound equal to the ceiling sends `null` (lift this run's own bound).
 * Neither changed -> undefined (Apply disabled).
 */
export function workflowRunSettingsChange(
  initial: WorkflowRunSettingsDraft,
  draft: WorkflowRunSettingsDraft,
  ceiling: number | undefined,
): WorkflowRunSettingsChange | undefined {
  const change: WorkflowRunSettingsChange = {};
  const fromModel = workflowRunSettingsModelCanonical(initial.model);
  const toModel = workflowRunSettingsModelCanonical(draft.model);
  if (fromModel !== toModel) change.subagentModel = toModel ?? null;
  const fromBound = normalizedBound(initial.bound, ceiling);
  const toBound = normalizedBound(draft.bound, ceiling);
  if (fromBound !== toBound) change.maxConcurrency = toBound;
  return Object.keys(change).length === 0 ? undefined : change;
}

/** Stepper clamping: lower bound 1, upper bound the ceiling (no maximum while unknown). */
export function clampWorkflowRunSettingsBound(value: number, ceiling: number | undefined): number {
  const floor = Math.max(1, Math.floor(value));
  return ceiling === undefined ? floor : Math.min(floor, ceiling);
}

/**
 * Only the concurrency cap changed (`null` = lift this run's own bound, also counts). The test is that the payload carries **only** this key —
 * same rule as the agent-side router: it too accepts only this payload shape; one extra field and it takes the regular revision path.
 */
function isConcurrencyOnlyChange(change: WorkflowRunSettingsChange | undefined): boolean {
  if (change === undefined) return false;
  return Object.keys(change).length === 1 && change.maxConcurrency !== undefined;
}

/**
 * Copy key of the consequence sentence: the last sentence swaps with the run state (completed never reaches here).
 *
 * A **running** run that only changes its concurrency cap applies in place, without stopping or starting another run,
 * hence the in-place consequence note here. `pending` does not count: its engine may not exist yet, and a failed in-place set falls back to a real
 * revision, where the original sentence is still the right one.
 */
export function workflowRunSettingsConsequenceId(
  status: WorkflowRunState["status"],
  change?: WorkflowRunSettingsChange,
): string {
  if (status === "running" && isConcurrencyOnlyChange(change))
    return "chat.toolCall.workflow.run.settings.consequence.concurrencyLive";
  switch (status) {
    case "pending":
      return "chat.toolCall.workflow.run.settings.consequence.pending";
    case "stopped":
      return "chat.toolCall.workflow.run.settings.consequence.stopped";
    case "errored":
      return "chat.toolCall.workflow.run.settings.consequence.errored";
    default:
      return "chat.toolCall.workflow.run.settings.consequence.running";
  }
}

/** Same capability-missing fault as Stop / Resume (the gateway's reasonCode for V4CapabilityUnsupportedError). */
const CAPABILITY_UNSUPPORTED_FAULT = "fault.command.capabilityUnsupported";
const KNOWN_REASONS: ReadonlySet<string> = new Set(
  workflowRunSettingsRejectionReasonSchema.options,
);

export interface WorkflowRunSettingsRejection {
  /** A reason from the table, or `unsupported` (capability missing) / `generic` (outside the table, copy includes the code). */
  reason: string;
  /** Raw reasonCode (the ack.status when absent). */
  code: string;
  /** Human-readable detail carried by the ACK (compile_failed's bounded diagnostics, start_failed's cause). */
  message?: string;
}

/** accepted / noop are not rejections -> undefined; otherwise look the fault prefix up in the table. */
export function describeWorkflowRunSettingsRejection(
  ack: Pick<CommandAck, "status" | "reasonCode" | "message">,
): WorkflowRunSettingsRejection | undefined {
  if (ack.status === "accepted" || ack.status === "noop") return undefined;
  const code = ack.reasonCode ?? ack.status;
  let reason = "generic";
  if (ack.reasonCode === CAPABILITY_UNSUPPORTED_FAULT) reason = "unsupported";
  else if (ack.reasonCode?.startsWith(WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX)) {
    const suffix = ack.reasonCode.slice(WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX.length);
    if (KNOWN_REASONS.has(suffix)) reason = suffix;
  }
  return { reason, code, ...(ack.message ? { message: ack.message } : {}) };
}

/** Copy key: `chat.toolCall.workflow.run.settings.rejection.<reason>`. */
export function workflowRunSettingsRejectionMessageId(
  rejection: WorkflowRunSettingsRejection,
): string {
  return `chat.toolCall.workflow.run.settings.rejection.${rejection.reason}`;
}

/**
 * Whether to show the detail block: start_failed's cause is already embedded in the sentence (`{message}`), no repeat;
 * other rejections carrying a message (compile_failed's diagnostics) go into a bounded monospace block.
 */
export function workflowRunSettingsRejectionDetail(
  rejection: WorkflowRunSettingsRejection,
): string | undefined {
  return rejection.reason === "start_failed" ? undefined : rejection.message;
}
