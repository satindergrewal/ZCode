import type { ZCodeTaskMeta } from "@zcode/shared";
import { isTaskListRowActive } from "@/v4/taskListRowActivity.js";

type TaskListTimeSortBy = "created" | "updated";

interface TaskListSortableItem {
  taskId: string;
  createdAt: number;
  updatedAt: number;
}

function compareTaskListItemsByTime(
  left: TaskListSortableItem,
  right: TaskListSortableItem,
  sortBy: TaskListTimeSortBy,
): number {
  if (sortBy === "created") {
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    if (right.updatedAt !== left.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    return right.taskId.localeCompare(left.taskId);
  }

  if (right.updatedAt !== left.updatedAt) {
    return right.updatedAt - left.updatedAt;
  }
  if (right.createdAt !== left.createdAt) {
    return right.createdAt - left.createdAt;
  }
  return right.taskId.localeCompare(left.taskId);
}

/**
 * Two-tier task ordering: running tasks sort to the top, stably by creation time; non-running
 * tasks follow the user's time preference.
 *
 * A running original and its fork child refresh updatedAt alternately. If the running tier read
 * updatedAt (even as a secondary key), every stream/tool event would swap the two rows.
 * The running tier includes tasks with live turns and tasks with background work (e.g. a dynamic
 * workflow run): the latter's turn is closed but activity time still advances, and leaving them
 * out would reproduce the same row swapping.
 */
function compareTaskListItemsWithRunningFirst<T extends TaskListSortableItem>(
  left: T,
  right: T,
  sortBy: TaskListTimeSortBy,
  isRunning: (task: T) => boolean,
): number {
  const leftRunning = isRunning(left);
  const rightRunning = isRunning(right);
  if (leftRunning !== rightRunning) {
    return leftRunning ? -1 : 1;
  }
  if (leftRunning) {
    if (right.createdAt !== left.createdAt) {
      return right.createdAt - left.createdAt;
    }
    // The running tier never tie-breaks on updatedAt; taskId is a stable, event-independent tie-break.
    return right.taskId.localeCompare(left.taskId);
  }
  return compareTaskListItemsByTime(left, right, sortBy);
}

export function compareZCodeTaskListItems(
  left: ZCodeTaskMeta,
  right: ZCodeTaskMeta,
  sortBy: TaskListTimeSortBy,
): number {
  return compareTaskListItemsWithRunningFirst(left, right, sortBy, isTaskListRowActive);
}
