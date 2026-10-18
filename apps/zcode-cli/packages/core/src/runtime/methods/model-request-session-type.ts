import { ModelRequestSessionType, ModelRetryBudget, type SessionTaskType } from "@zcode/contracts";

/**
 * Model requests classify coarsely by host session; a workflow child is no subagent — server stats file it under other.
 */
export function resolveModelRequestSessionTypeFromTaskType(
  taskType: SessionTaskType | undefined,
): ModelRequestSessionType {
  if (taskType === "subagent_child") return ModelRequestSessionType.Subagent;
  if (taskType === "selection_side_chat") return ModelRequestSessionType.SideChat;
  if (taskType === "workflow_child" || taskType === "nested_workflow_child") {
    return ModelRequestSessionType.Other;
  }
  return ModelRequestSessionType.Main;
}

/**
 * Workflow-actor model requests (nested included) get an **unlimited** retry budget: a model error is never
 * a workflow error; the runner recovers best-effort.
 * All other sessions (main, subagent, fork…) keep the adapter default budget.
 */
export function resolveModelRetryBudgetFromTaskType(
  taskType: SessionTaskType | undefined,
): ModelRetryBudget {
  if (taskType === "workflow_child" || taskType === "nested_workflow_child") {
    return ModelRetryBudget.Unbounded;
  }
  return ModelRetryBudget.Default;
}
