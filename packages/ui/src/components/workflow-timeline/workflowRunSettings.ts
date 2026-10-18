// ============================================================
// Pure rules behind the Configure popover.
// ============================================================
// The popover component only renders and wires; every decision lives here: which runs are
// configurable, where the form starts, what Apply sends, and what a rejected ACK says.
// Pure functions, no store access, enumerable case by case.

import {
  WORKFLOW_RUN_SETTINGS_REJECTED_FAULT_PREFIX,
  workflowRunSettingsRejectionReasonSchema,
  type AmendWorkflowRunSettingsPayload,
  type CommandAck,
  type WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import { formatModelPickerValue, parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";

/**
 * The session's current model (the session-model entry's label comes from it): prefer the
 * session-persisted sparse choice, falling back to the UI effective provider/model projection;
 * absent when neither can be read.
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

/** The form's subagent model: the session model, or one concrete model (optionally with a thinking level). */
export type WorkflowRunSettingsModel =
  | { kind: "session" }
  | { kind: "model"; providerId: string; modelId: string; level?: string };

/** The form's two settings. A `null` bound means the run has no limit of its own (it runs at the default concurrency). */
export interface WorkflowRunSettingsDraft {
  model: WorkflowRunSettingsModel;
  bound: number | null;
}

/** The payload fragment Apply sends (the host fills in workId). */
export type WorkflowRunSettingsChange = Omit<AmendWorkflowRunSettingsPayload, "workId">;

/**
 * Which runs are configurable:
 * pending / running yes (the main throttle-or-switch case); stopped yes unless superseded by an
 * amend whose successor is the live one; errored yes (retrying on another model is the common
 * fix); completed no (every ask replays from cache, nothing runs under new settings); a run
 * missing from the projection has no settings to show. Host callbacks and rollout gates are
 * layered on by the caller.
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
 * Default concurrency D (docs/dynamic-workflow/concurrency.md "Protocol state"): read only from
 * `run.concurrencyCeiling` (carried by `run-started`, always present; the key predates the
 * "default concurrency" name). It is a starting point, not a ceiling: the stepper renders
 * "default N" from it and treats equal-to-default as no own limit; there is no upper bound.
 *
 * Bug root cause (user report: "local limit 2"): older CLIs omit the field and the fallback read
 * the usage chip's high-water mark `concurrency.ceiling`, the largest cap ever seen — when the
 * shared bucket was throttled before this run started, that learned cap was read out as the local
 * limit. Better to admit the default is unknown than to pass a learned number off as one.
 */
export function workflowRunDefaultConcurrency(run: WorkflowRunState): number | undefined {
  return run.concurrencyCeiling;
}

/** Canonical string to form model; a string that fails to parse cannot pass for the session model, so it is kept verbatim as a concrete model lookup misses. */
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

/** Form model to canonical string `providerId/modelId[$level]`; the session model has no string (undefined). */
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

/** Initial value when the popover opens: both fields from the run's own current settings. With no own limit it rests on the default (null when the default is unknown too). */
export function initialWorkflowRunSettingsDraft(run: WorkflowRunState): WorkflowRunSettingsDraft {
  const limit = run.concurrency?.limit;
  return {
    model: workflowRunSettingsModelOf(run.subagentModel),
    bound: limit ?? workflowRunDefaultConcurrency(run) ?? null,
  };
}

/** Limit normalization: equal to the default means no own limit; above the default is a real number (the default is not a ceiling). */
function normalizedBound(
  bound: number | null,
  defaultConcurrency: number | undefined,
): number | null {
  if (bound === null) return null;
  return bound === defaultConcurrency ? null : bound;
}

/**
 * What Apply sends: only the changed fields (the tool's usual three-state: omitted = keep). The
 * model compares by canonical string — a thinking-level-only change still counts as a model
 * change; returning to the session model sends `null`. A limit equal to the default sends `null`
 * (clears this run's own limit). Nothing changed: undefined (Apply disabled).
 */
export function workflowRunSettingsChange(
  initial: WorkflowRunSettingsDraft,
  draft: WorkflowRunSettingsDraft,
  defaultConcurrency: number | undefined,
): WorkflowRunSettingsChange | undefined {
  const change: WorkflowRunSettingsChange = {};
  const fromModel = workflowRunSettingsModelCanonical(initial.model);
  const toModel = workflowRunSettingsModelCanonical(draft.model);
  if (fromModel !== toModel) change.subagentModel = toModel ?? null;
  const fromBound = normalizedBound(initial.bound, defaultConcurrency);
  const toBound = normalizedBound(draft.bound, defaultConcurrency);
  if (fromBound !== toBound) change.maxConcurrency = toBound;
  return Object.keys(change).length === 0 ? undefined : change;
}

/** Stepper clamping: a floor of 1, rounding down, no ceiling (the default concurrency is a starting point, not a cap). */
export function clampWorkflowRunSettingsBound(value: number): number {
  return Math.max(1, Math.floor(value));
}

/**
 * Only the concurrency limit changed (`null` = clearing this run's own limit, also counts). The
 * test is that the payload carries this key and nothing else — the same rule as the agent-side
 * router: it too accepts only this shape; one extra field routes to the regular amend.
 */
function isConcurrencyOnlyChange(change: WorkflowRunSettingsChange | undefined): boolean {
  if (change === undefined) return false;
  return Object.keys(change).length === 1 && change.maxConcurrency !== undefined;
}

/**
 * Copy key for the consequence line: the closing sentence varies with run status (completed never reaches here).
 *
 * Nothing changed: undefined (no consequence line) — Apply is disabled, no consequence to state. This used to fall back to a status-based line,
 * telling running runs "will stop the current run" — but a concurrency-only change never stops it, so concluding on the user's behalf always had one wrong branch.
 *
 * One exception: for a **running** run, a concurrency-only amend applies in place — it stops neither this run nor starts another;
 * see docs/dynamic-workflow/concurrency.md. This is the only case the old "will stop the current run" line got wrong,
 * so only this cell rewords it. `pending` does not count: its engine may not exist yet, and a failed in-place set falls back to a regular
 * amend, where the original line holds.
 */
export function workflowRunSettingsConsequenceId(
  status: WorkflowRunState["status"],
  change: WorkflowRunSettingsChange | undefined,
): string | undefined {
  if (change === undefined) return undefined;
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

/** The same capability-missing fault as Stop / Resume (the gateway's reasonCode for V4CapabilityUnsupportedError). */
const CAPABILITY_UNSUPPORTED_FAULT = "fault.command.capabilityUnsupported";
const KNOWN_REASONS: ReadonlySet<string> = new Set(
  workflowRunSettingsRejectionReasonSchema.options,
);

export interface WorkflowRunSettingsRejection {
  /** A reason from the table, or `unsupported` (capability missing) / `generic` (unknown; the copy carries the code). */
  reason: string;
  /** Raw reasonCode (the ack.status when absent). */
  code: string;
  /** Human-readable detail carried by the ACK (compile_failed's bounded diagnostics, start_failed's cause). */
  message?: string;
}

/** accepted / noop are not rejections: undefined; everything else resolves through the fault-prefix table. */
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
 * Whether the detail block shows: start_failed's cause is already embedded in the sentence
 * (`{message}`) and is not repeated; other rejections carrying a message (compile_failed's
 * diagnostics) go into a bounded monospace block.
 */
export function workflowRunSettingsRejectionDetail(
  rejection: WorkflowRunSettingsRejection,
): string | undefined {
  return rejection.reason === "start_failed" ? undefined : rejection.message;
}
