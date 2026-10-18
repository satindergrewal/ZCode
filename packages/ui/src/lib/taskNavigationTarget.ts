import type { ZCodeTaskMeta } from "@zcode/shared";
import type { TaskNavEntry } from "@/lib/taskNavigationHistory.js";
import type { TaskEntityKey } from "@/lib/taskQueryCache.js";
import { buildTaskEntityKey } from "@/lib/taskQueryCache.js";

export function taskNavigationTargetExists(params: {
  entry: TaskNavEntry;
  visibleTasks: readonly Pick<ZCodeTaskMeta, "taskId">[];
  taskMetaByEntityKey: Record<TaskEntityKey, ZCodeTaskMeta>;
}): boolean {
  if (params.visibleTasks.some((task) => task.taskId === params.entry.taskId)) {
    return true;
  }

  const cachedTask = params.taskMetaByEntityKey[buildTaskEntityKey(params.entry)];
  if (!cachedTask) {
    return false;
  }

  // After the task list moved to the task query cache, the legacy taskListCache may be empty.
  // Back/forward must not trust visibleTasks alone, or real history targets drop and the button looks dead.
  return cachedTask.taskId === params.entry.taskId;
}
