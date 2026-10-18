// Skill-load gate for the workflow authoring tools.
// CreateWorkflow/AmendWorkflow/SaveWorkflow/EvalWorkflowSnippet keep short descriptions; facade and
// writing rules come from the `dynamic-workflows` skill. The skill must load before submit: without a
// successful Skill(dynamic-workflows) in history, resolveInput rejects up front -- no hooks, no invalid dialog.
//
// The test reads the model's current visible messageHistory. Compaction removes the skill body and its
// call -> reload required; resume/rewind restore the test with history, no second session-state copy.
// Absent probe = this assembly has no skill gate; never set an unsatisfiable precondition.

import { DYNAMIC_WORKFLOW_SKILL_NAME } from "@zcode/contracts";
import type { ToolHandlerFailure, ToolInputResolutionContext } from "../types.js";

/**
 * Stable error code for "skill not loaded". Separate from the four tools' arg-level 400s: callers must
 distinguish "fix the args" from "load the skill first" without parsing text -- one edits args, one adds a Skill call.
 */
export const WORKFLOW_SKILL_NOT_LOADED_CODE = 428;

/** The test when the gate is present; exported for the probe impl. */
export function isDynamicWorkflowSkillLoaded(context: ToolInputResolutionContext): boolean {
  return context.hasLoadedSkill?.(DYNAMIC_WORKFLOW_SKILL_NAME) ?? true;
}

/**
 * Reject when the skill was never loaded. Undefined = proceed: loaded, or no probe in this session (see header).
 *
 * @param toolName Tool named in the rejection so the model knows what to retry.
 */
export function requireDynamicWorkflowSkill(
  context: ToolInputResolutionContext,
  toolName: string,
): ToolHandlerFailure | undefined {
  if (isDynamicWorkflowSkillLoaded(context)) return undefined;
  return {
    result: false,
    errorCode: WORKFLOW_SKILL_NOT_LOADED_CODE,
    message: `${toolName} needs the \`${DYNAMIC_WORKFLOW_SKILL_NAME}\` skill loaded in this session before it accepts a script. Call the Skill tool with skill "${DYNAMIC_WORKFLOW_SKILL_NAME}" first — it carries the facade declarations the script is checked against, the authoring rules and this tool's full contract — then call ${toolName} again. Nothing was started.`,
  };
}

/** CreateWorkflow exception: running a saved workflow by name writes no script -- no skill needed. */
export function createWorkflowNeedsSkill(input: unknown): boolean {
  const fields = asRecord(input);
  if (fields === undefined) return true;
  const runsSavedOnly =
    fields.saved !== undefined && fields.script === undefined && fields.path === undefined;
  return !runsSavedOnly;
}

/** AmendWorkflow exception: settings-only (no path/script) inherits the predecessor script -- not writing. */
export function amendWorkflowNeedsSkill(input: unknown): boolean {
  const fields = asRecord(input);
  if (fields === undefined) return true;
  return fields.script !== undefined || fields.path !== undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
