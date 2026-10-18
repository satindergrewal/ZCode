// ============================================================
// The settings round's two surfaces.
// ============================================================
// One Configure leaves two records: the transcript line above the run card (settings adjusted, subagents
// now on X, at most N at once) and the detail page's provenance from-to pair under adjusted-by-you. Both read
// the same amend metadata; wording rules written once, here. Pure functions + injected formatMessage /
// providerName, same discipline as subagent-model-label.

import type { WorkflowSettingsAmendMeta } from "@zcode/shared/zcode-protocol-v4";
import {
  describeWorkflowSubagentModel,
  type WorkflowSubagentModelDeps,
} from "./subagent-model-label.js";

/** Model display name: name only (tier lives in the tooltip), same word as the run card's model span. */
function modelName(canonical: string, deps: WorkflowSubagentModelDeps): string {
  return describeWorkflowSubagentModel(canonical, deps).name;
}

/**
 * Transcript-line spans (no Settings-adjusted prefix, no trailing time): only changed settings appear, model
 * first, cap last. A cap whose to is absent or equals default concurrency (ceiling, the key predates the
 * default-concurrency name) reads cap restored to default; any other number, above default included, reads itself.
 */
export function workflowSettingsChangeSegments(
  amend: WorkflowSettingsAmendMeta,
  deps: WorkflowSubagentModelDeps,
): string[] {
  const { formatMessage } = deps;
  const segments: string[] = [];
  if (amend.subagentModel !== undefined) {
    const to = amend.subagentModel.to;
    segments.push(
      to === undefined
        ? formatMessage({ id: "chat.toolCall.workflow.settingsChange.modelSession" })
        : formatMessage(
            { id: "chat.toolCall.workflow.settingsChange.model" },
            { model: modelName(to, deps) },
          ),
    );
  }
  if (amend.maxConcurrency !== undefined) {
    const to = amend.maxConcurrency.to;
    const atDefault = to === undefined || to === amend.ceiling;
    segments.push(
      atDefault
        ? formatMessage({ id: "chat.toolCall.workflow.settingsChange.limitDefault" })
        : formatMessage({ id: "chat.toolCall.workflow.settingsChange.limit" }, { n: to }),
    );
  }
  return segments;
}

export interface WorkflowSettingsProvenanceRow {
  key: "model" | "limit";
  label: string;
  /** 「{from} → {to}」。 */
  value: string;
}

/**
 * The detail page provenance from-to rows. A missing end reads default: model session model, cap default
 * (with the number when default concurrency is known, default 13 to 4). An end equal to default also reads
 * default; above default reads the number.
 */
export function workflowSettingsProvenanceRows(
  amend: WorkflowSettingsAmendMeta,
  deps: WorkflowSubagentModelDeps,
): WorkflowSettingsProvenanceRow[] {
  const { formatMessage } = deps;
  const rows: WorkflowSettingsProvenanceRow[] = [];
  if (amend.subagentModel !== undefined) {
    const end = (canonical: string | undefined) =>
      canonical === undefined
        ? formatMessage({ id: "chat.workflowLaunch.settings.sessionModel" })
        : modelName(canonical, deps);
    rows.push({
      key: "model",
      label: formatMessage({ id: "chat.workflowLaunch.settings.model" }),
      value: `${end(amend.subagentModel.from)} → ${end(amend.subagentModel.to)}`,
    });
  }
  if (amend.maxConcurrency !== undefined) {
    const defaultConcurrency = amend.ceiling;
    const end = (bound: number | undefined) =>
      bound !== undefined && bound !== defaultConcurrency
        ? String(bound)
        : defaultConcurrency === undefined
          ? formatMessage({ id: "chat.workflowLaunch.settings.defaultLimit" })
          : formatMessage(
              { id: "chat.workflowLaunch.settings.defaultLimitValue" },
              { n: defaultConcurrency },
            );
    rows.push({
      key: "limit",
      label: formatMessage({ id: "chat.workflowLaunch.settings.limit" }),
      value: `${end(amend.maxConcurrency.from)} → ${end(amend.maxConcurrency.to)}`,
    });
  }
  return rows;
}
