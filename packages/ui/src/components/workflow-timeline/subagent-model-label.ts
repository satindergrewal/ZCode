import { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { formatProviderModelLabel } from "@/v4/composer/modelTriggerDisplay.js";

/**
 * The subagent model's **words**: what the run stores is the canonical string
 * `providerId/modelId[$reasoningLevel]` — meant for machine backfill, not human eyes. Team-plan provider ids are
 * UUIDs; pasted onto the screen, the first thing a user sees is hex.
 *
 * So the three surfaces (approval dialog, run card, detail side panel) share one pure function: the naming rule reuses the model menu's
 * (`formatProviderModelLabel`: built-in families show the model name only, custom providers show "name/model"),
 * and reasoning levels reuse the reasoning control's vocabulary. The canonical string itself lives only in the tooltip.
 *
 * Pure function + injected formatMessage / providerName: the same discipline as timeline-summary; this file never touches stores.
 */
type FormatMessage = (
  descriptor: { id: string },
  values?: Record<string, string | number>,
) => string;

export interface WorkflowSubagentModelLabel {
  /** The on-screen model name; **never contains the providerId**. */
  name: string;
  /** Localized reasoning-level word; absent when the canonical string has no `$level`. */
  level?: string;
  /** Canonical string verbatim (trimmed), tooltip only. */
  canonical: string;
}

export interface WorkflowSubagentModelDeps {
  formatMessage: FormatMessage;
  /**
   * providerId -> provider name from the session's model list. Falls back to the bare modelId when absent (or unresolved) —
   * a **deliberate** fallback: never surface the providerId, even when the name cannot be resolved.
   */
  providerName?: (providerId: string) => string | undefined;
}

/** Fallback naming when parsing fails: strip the `providerId/` prefix and the `$level` suffix; whatever remains is the human-readable part. */
function fallbackName(canonical: string): string {
  const separatorIndex = canonical.indexOf("/");
  const rest = separatorIndex > 0 ? canonical.slice(separatorIndex + 1) : canonical;
  const levelIndex = rest.indexOf("$");
  const name = levelIndex > 0 ? rest.slice(0, levelIndex) : rest;
  return name.length > 0 ? name : canonical;
}

/**
 * Canonical string -> on-screen words. Parse failures (missing provider segment, shape off the schema) do not throw: the UI is not a
 * second parser; when in doubt, fall back to the bare modelId.
 */
export function describeWorkflowSubagentModel(
  canonical: string,
  deps: WorkflowSubagentModelDeps,
): WorkflowSubagentModelLabel {
  const trimmed = canonical.trim();
  let parsed: ReturnType<typeof parseModelPickerValue> | undefined;
  try {
    parsed = parseModelPickerValue(trimmed);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) {
    return { canonical: trimmed, name: fallbackName(trimmed) };
  }

  // When the session list has no providerName it falls back to the providerId itself (see zcodeSessionSettingsToConfigOptions);
  // exactly the thing screened out here — treat as not found.
  const resolvedName = deps.providerName?.(parsed.providerId)?.trim();
  const providerName =
    resolvedName === undefined || resolvedName === parsed.providerId ? undefined : resolvedName;
  const name = formatProviderModelLabel(parsed.providerId, providerName, parsed.modelId);

  const rawLevel = parsed.options?.reasoningLevel;
  if (rawLevel === undefined) {
    return { canonical: trimmed, name };
  }
  // Level words share the reasoning control's table; unknown values render verbatim (provider-defined level names).
  const labelId = thoughtLevelLabelId(rawLevel);
  return {
    canonical: trimmed,
    level: labelId === undefined ? rawLevel : deps.formatMessage({ id: labelId }),
    name,
  };
}

/** The model and level in one sentence: without a level it is just the model name (shared by approval dialog and tooltip). */
export function workflowSubagentModelText(
  formatMessage: FormatMessage,
  label: WorkflowSubagentModelLabel,
): string {
  return label.level === undefined
    ? label.name
    : formatMessage(
        { id: "chat.toolCall.workflow.subagentModel.withLevel" },
        { level: label.level, model: label.name },
      );
}

/**
 * The three surfaces' tooltip: one explanation (where the subagent runs, main agent unchanged) + newline + canonical string.
 * The canonical string exists for machine backfill; this is the only place it should appear.
 */
export function workflowSubagentModelTooltip(
  formatMessage: FormatMessage,
  label: WorkflowSubagentModelLabel,
): string {
  const explained = formatMessage(
    { id: "chat.toolCall.workflow.subagentModel.tooltip" },
    { model: workflowSubagentModelText(formatMessage, label) },
  );
  return `${explained}\n${label.canonical}`;
}

/**
 * The two things card and side panel need: the on-screen name (name only; the level lives in the tooltip) and the tooltip.
 * Absent when the run never pinned a model — following the session model is the norm, nothing to say.
 */
export function workflowSubagentModelCardLabel(
  canonical: string | undefined,
  deps: WorkflowSubagentModelDeps,
): { name: string; title: string } | undefined {
  if (canonical === undefined) {
    return undefined;
  }
  const label = describeWorkflowSubagentModel(canonical, deps);
  return { name: label.name, title: workflowSubagentModelTooltip(deps.formatMessage, label) };
}
