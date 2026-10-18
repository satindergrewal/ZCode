// ============================================================
// The confirm dialog's two adjustable run settings: pure rules.
// ============================================================
// docs/dynamic-workflow/launch.md, adjusting settings in the window; looks in
// docs/dynamic-workflow/presentation.md, the confirmation window.
//
// Same draft and same what-changed rule as the Configure popover (workflowRunSettings.ts); only the start
// and the exit differ. The start reads THIS call's input (CLI resolveInput-normalized); the exit is the Allow
// content in the tool's own field names and tri-state, so the agent side keeps one parser (contracts
// WorkflowSettingsAdjustmentSchema).

import {
  readWorkflowMaxConcurrency,
  readWorkflowSubagentModel,
} from "@/ToolCallBlocks/renderers/createWorkflowInput.js";
import {
  workflowRunSettingsChange,
  workflowRunSettingsModelOf,
  type WorkflowRunSettingsDraft,
} from "./workflowRunSettings.js";

/** Allow content: changed fields only; null = back to defaults (session model / default concurrency). */
export interface WorkflowAskSettingsContent {
  subagent_model?: string | null;
  max_concurrency?: number | null;
}

/**
 * Start: the call's input values. No model means the session model; no cap means default concurrency (no
 * own bound reads as that number on the stepper); unknown default yields null (empty stepper, a typed number
 * sets the bound).
 */
export function initialWorkflowAskSettingsDraft(
  input: unknown,
  defaultConcurrency: number | undefined,
): WorkflowRunSettingsDraft {
  return {
    model: workflowRunSettingsModelOf(readWorkflowSubagentModel(input)),
    bound: readWorkflowMaxConcurrency(input) ?? defaultConcurrency ?? null,
  };
}

/**
 * Exit: changed fields to the Allow content; unchanged means undefined (Allow still carries only optionId).
 * The popover owns the rules: thinking-tier-only still counts as a model change; a cap equal to default
 * concurrency sends null (above default is a real number).
 */
export function workflowAskSettingsContent(
  initial: WorkflowRunSettingsDraft,
  draft: WorkflowRunSettingsDraft,
  defaultConcurrency: number | undefined,
): WorkflowAskSettingsContent | undefined {
  const change = workflowRunSettingsChange(initial, draft, defaultConcurrency);
  if (change === undefined) return undefined;
  return {
    ...(change.subagentModel === undefined ? {} : { subagent_model: change.subagentModel }),
    ...(change.maxConcurrency === undefined ? {} : { max_concurrency: change.maxConcurrency }),
  };
}

/** Which row changed (bolded, with a was-X note). */
export function workflowAskSettingsChangedLines(
  initial: WorkflowRunSettingsDraft,
  draft: WorkflowRunSettingsDraft,
  defaultConcurrency: number | undefined,
): { model: boolean; bound: boolean } {
  const content = workflowAskSettingsContent(initial, draft, defaultConcurrency);
  return {
    model: content?.subagent_model !== undefined,
    bound: content?.max_concurrency !== undefined,
  };
}
