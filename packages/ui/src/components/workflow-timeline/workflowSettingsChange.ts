// ============================================================
// Copy for the two surfaces a settings amendment touches
// ============================================================
// One Configure leaves records on two surfaces: the transcript line above the run card
// ("Settings adjusted - subagent model X - at most N concurrent") and the detail page's
// provenance block with from -> to lines under "Adjusted by you". Both read the same
// `amend` metadata; the phrasing rules live here, once. Pure functions + injected
// formatMessage/providerName, same discipline as subagent-model-label.

import type { WorkflowSettingsAmendMeta } from "@zcode/shared/zcode-protocol-v4";
import {
  describeWorkflowSubagentModel,
  type WorkflowSubagentModelDeps,
} from "./subagent-model-label.js";

/** The model's on-screen name: name only (level lives in the tooltip), same word as the run card's model segment. */
function modelName(canonical: string, deps: WorkflowSubagentModelDeps): string {
  return describeWorkflowSubagentModel(canonical, deps).name;
}

/**
 * Transcript line segments (minus the leading "Settings adjusted" and trailing time):
 * only changed settings appear, model first, cap last. A missing or ceiling-reaching `to`
 // reads as "cap restored to the machine default".
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
    const atCeiling = to === undefined || (amend.ceiling !== undefined && to >= amend.ceiling);
    segments.push(
      atCeiling
        ? formatMessage({ id: "chat.toolCall.workflow.settingsChange.limitCeiling" })
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
 * Detail-page provenance from -> to lines. A missing end reads as the default: model ->
 * "session model", cap -> machine limit (with the number when known, "13 (machine
 * limit) -> 4").
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
    const ceiling = amend.ceiling;
    const end = (bound: number | undefined) =>
      bound !== undefined && (ceiling === undefined || bound < ceiling)
        ? String(bound)
        : ceiling === undefined
          ? formatMessage({ id: "chat.workflowLaunch.settings.machineLimit" })
          : formatMessage({ id: "chat.workflowLaunch.settings.machineLimitValue" }, { n: ceiling });
    rows.push({
      key: "limit",
      label: formatMessage({ id: "chat.workflowLaunch.settings.limit" }),
      value: `${end(amend.maxConcurrency.from)} → ${end(amend.maxConcurrency.to)}`,
    });
  }
  return rows;
}
