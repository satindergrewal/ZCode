import type { SessionTaskType } from "@zcode/contracts";

/**
 * Session-type projection for the left-hand task list.
 *
 * List visibility must not be replaced by a `parent_id is null` hierarchy query: explicit forks
 * are parented main tasks that the cold-start seed filters after CLI restart. Visibility must be decided by taskType,
 * while side conversations, subagents, and workflow children keep their dedicated projections.
 */
export const TASK_LIST_SESSION_TYPES = [
  "interactive",
  "fork",
  "workflow_parent",
] as const satisfies readonly SessionTaskType[];

const TASK_LIST_SESSION_TYPE_SET = new Set<SessionTaskType>(
  TASK_LIST_SESSION_TYPES,
);

export function isTaskListSessionType(
  taskType: SessionTaskType | undefined,
): boolean {
  return TASK_LIST_SESSION_TYPE_SET.has(taskType ?? "interactive");
}
