// ============================================================
// The skill gate for workflow authoring tools (docs/dynamic-workflow/authoring.md "The authoring surface")
// ============================================================
// 2026-09-21: the four authoring tools' (CreateWorkflow / AmendWorkflow / SaveWorkflow / EvalWorkflowSnippet)
// descriptions were cut to a few hundred tokens; facade and authoring rules moved into the `dynamic-workflows` skill. The saving is ~19k tokens
// per model request; the cost is scripts written without the skill. This gate makes "has read the skill" a precondition of submitting one:
// with no successful `Skill(dynamic-workflows)` call in session history, resolveInput rejects —
// that step precedes hooks and the dialog, so the model gets a business failure and the user never sees a dialog destined to be voided.
//
// "Has read" is judged on **the history the model can still see** (the runtime's messageHistory), never a session flag: once compaction
// pushes the skill body out of context, the past call leaves history too, the gate closes again, and the model must read it once more —
// precisely Edit's read-before-write semantics (compact clears readFileState too). With no probe (sessions without the Skill
// tool, hand-built test contexts) the gate stays off: never present the model an unsatisfiable premise.

import { DYNAMIC_WORKFLOW_SKILL_NAME } from "@zcode/contracts";
import type { ToolHandlerFailure, ToolInputResolutionContext } from "../types.js";

/**
 * Stable error code for "skill not loaded". Separate from the four tools' arg-level 400s: callers must
 * and "read the skill first" — the former changes params, the latter adds one Skill call.
 */
export const WORKFLOW_SKILL_NOT_LOADED_CODE = 428;

/** The criterion when the gate is present; exported for probe implementations and tests. */
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
