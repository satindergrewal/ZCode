import {
  isAutomationCreateLimitError,
  CoreErrorType,
  AMEND_WORKFLOW_TOOL_NAME,
  CREATE_WORKFLOW_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  type CollaborationMode,
} from "@zcode/contracts";
import type { ToolEntry, ToolExecutionResult } from "../types.js";

const DEFAULT_EXIT_PLAN_DENIED_MESSAGE = `Permission denied for ${EXIT_PLAN_MODE_TOOL_NAME}`;
const EXIT_PLAN_DENIED_BY_USER_MESSAGE = "The plan was not approved by the user.";
const WORKFLOW_REFINE_DENIED_BY_USER_MESSAGE = "The workflow run was not approved by the user.";
const AUTOMATION_CREATE_LIMIT_MODEL_MESSAGE =
  "Automation creation was not performed because the global retained-task limit of 20 was reached. " +
  "This limit cannot be recovered automatically in the current turn. Do not list, delete, overwrite, " +
  "retry, or use another tool. Reply once in the user's language that they must manually delete an " +
  "existing task on the Automations page and then retry.";

export function withAutomationCreateLimitTurnStop(
  result: ToolExecutionResult,
  input: { error: unknown; toolName: string },
): ToolExecutionResult {
  if (
    result.success ||
    input.toolName !== "CronCreate" ||
    !isAutomationCreateLimitError(input.error)
  ) {
    return result;
  }

  // The creation cap is a product boundary needing manual slot release, not an Agent-recoverable error.
  // Hide the raw error (its "Delete..." wording invites action) and ask the executor to cancel the step's remaining tools.
  return {
    ...result,
    modelContent: AUTOMATION_CREATE_LIMIT_MODEL_MESSAGE,
    turnControl: {
      reason: "automation_create_limit",
      stopTurnAfterResult: true,
    },
  };
}

export function withPlanExitDeniedTurnStop(
  result: ToolExecutionResult,
  input: {
    mode: CollaborationMode;
    planEnabled?: boolean;
    toolName: string;
  },
): ToolExecutionResult {
  if (
    !(input.planEnabled ?? input.mode === "plan") ||
    input.toolName !== EXIT_PLAN_MODE_TOOL_NAME ||
    result.success
  ) {
    return result;
  }

  const feedback = readPlanExitDeniedFeedback(result);
  if (feedback) {
    return {
      ...result,
      followUpUserInput: {
        input: feedback,
        reasonSource: "plan_approval_feedback",
      },
      // feedback reaches the model as a real user message via steer; tool_result can only say the plan was rejected,
      // never promise the feedback follows -- a rejected steer would otherwise show the provider a phantom user message.
      modelContent: EXIT_PLAN_DENIED_BY_USER_MESSAGE,
    };
  }

  // A plan-exit rejection means the user wants to keep discussing: not a normal tool error to feed back for self-rewriting.
  return {
    ...result,
    turnControl: {
      reason: "plan_exit_denied",
      stopTurnAfterResult: true,
    },
  };
}

function readPlanExitDeniedFeedback(result: ToolExecutionResult): string | undefined {
  if (result.error?.type !== CoreErrorType.PermissionDenied) {
    return undefined;
  }
  // project rules / hooks / the broker can also return deny + reason;
  // only the ExitPlanMode approval's custom-input dedicated source reads as user edits.
  if (result.error.reasonSource !== "plan_approval_feedback") {
    return undefined;
  }
  const message = result.error.message.trim();
  if (!message || message === DEFAULT_EXIT_PLAN_DENIED_MESSAGE) {
    return undefined;
  }
  return message;
}

/**
 * The Refine answer of the workflow run confirm dialog.
 * Narrower sibling of withPlanExitDeniedTurnStop: feedback escalation only, no stop-the-turn branch -- a plain
 * Deny keeps existing semantics (standard permission error, turn continues) while feedback becomes a real
 * user message via steer, after which the model amends the script and resubmits in the same turn, naturally
 * retriggering confirmation. Not keyed by mode: CreateWorkflow's ask ignores mode (alwaysAsk).
 */
export function withWorkflowRefineDeniedFollowUp(
  result: ToolExecutionResult,
  input: { toolName: string },
): ToolExecutionResult {
  if (
    (input.toolName !== CREATE_WORKFLOW_TOOL_NAME && input.toolName !== AMEND_WORKFLOW_TOOL_NAME) ||
    result.success
  ) {
    return result;
  }
  const feedback = readWorkflowRefineDeniedFeedback(result);
  if (!feedback) {
    return result;
  }
  return {
    ...result,
    followUpUserInput: {
      input: feedback,
      reasonSource: "workflow_refine_feedback",
    },
    // tool_result can only say the run was not approved, never promise feedback follows --
    // a rejected steer would otherwise show the provider a phantom user message.
    modelContent: WORKFLOW_REFINE_DENIED_BY_USER_MESSAGE,
  };
}

function readWorkflowRefineDeniedFeedback(result: ToolExecutionResult): string | undefined {
  if (result.error?.type !== CoreErrorType.PermissionDenied) {
    return undefined;
  }
  // Like readPlanExitDeniedFeedback: hook/project-rule deny + reason lacks the dedicated source and
  // must not be escalated to a user message.
  if (result.error.reasonSource !== "workflow_refine_feedback") {
    return undefined;
  }
  const message = result.error.message.trim();
  return message || undefined;
}

// Terminal tools such as submit_result declare stopTurnOnSuccess=true on ToolEntry.metadata: their success
// result is a terminal commit and must end the actor turn. Read the declarative metadata instead of hardcoding
// names -- terminality is a general intrinsic capability (any future terminal tool reuses it), unlike the
// failure-side withPlanExitDeniedTurnStop / withAutomationCreateLimitTurnStop which key on tool-specific
// error/state. Their handlers guarantee success iff terminal (gate throws, rejects fail), so no handler-side
// signal channel is needed.
export function withTerminalToolTurnStop(
  result: ToolExecutionResult,
  input: { entry: ToolEntry },
): ToolExecutionResult {
  if (!result.success || input.entry.metadata.stopTurnOnSuccess !== true) {
    return result;
  }
  return {
    ...result,
    turnControl: {
      reason: "subagent_terminal",
      stopTurnAfterResult: true,
    },
  };
}
