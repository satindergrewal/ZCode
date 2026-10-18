// Client-side Grouped projection: the server returns the raw group structure, tasks-index
// task rows decide the persisted rows, and sessions-index only contributes live
// activity/detail; the result is assembled into the same shape as the legacy
// ZCodeGroupedTaskView. Ordering semantics mirror taskIndexRepo.queryGroupedTaskView, but the
// server's lazy backfill (normalize* writing to sqlite) becomes a read-only in-memory
// backfill here: members/top-level nodes missing sort_order derive a display order by the
// same rule (added_at / createdAt descending, max+STEP increments) without persisting;
// applyGroupedTaskViewOrder fully persists once the user saves a drag.
import type {
  ZCodeGroupedTaskView,
  ZCodeGroupedTaskViewNode,
  ZCodeGroupedTaskViewStructure,
  ZCodeGroupedTaskViewStructureMember,
  ZCodeTaskListItem,
} from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { mergeTaskIndexRowsWithSessions } from "@/v4/buildTaskListResultFromSessions.js";

// Mirrors taskIndexRepo GROUPED_TASK_ORDER_STEP.
const GROUPED_TASK_ORDER_STEP = 1000;

function memberTaskKey(params: { workspaceKey: string; taskId: string }): string {
  return `${params.workspaceKey}\u0000${params.taskId}`;
}

function taskKeyOf(task: ZCodeTaskMeta): string {
  return memberTaskKey({
    workspaceKey: buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
    taskId: task.taskId,
  });
}

/** Mirrors taskIndexRepo.taskOrderNodeKey (node_key = JSON.stringify([workspaceKey, taskId])). */
function taskOrderMapKey(task: ZCodeTaskMeta): string {
  return `task:${JSON.stringify([
    buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity),
    task.taskId,
  ])}`;
}

function nodeMapKey(node: ZCodeGroupedTaskViewNode): string {
  return node.type === "group" ? `group:${node.group.id}` : taskOrderMapKey(node.task);
}

function compareGroupedNodes(
  left: ZCodeGroupedTaskViewNode,
  right: ZCodeGroupedTaskViewNode,
): number {
  const leftOrder = left.sortOrder ?? 0;
  const rightOrder = right.sortOrder ?? 0;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return nodeMapKey(left).localeCompare(nodeMapKey(right));
}

/** In-group member order: use sort_order when present; backfill missing ones in memory after max, added_at descending. */
function sortGroupTasks(
  tasks: ZCodeTaskListItem[],
  membersByTaskKey: Map<string, ZCodeGroupedTaskViewStructureMember>,
): ZCodeTaskListItem[] {
  const resolvedOrderByTaskKey = new Map<string, number>();
  let maxOrder = 0;
  const missing: Array<{ task: ZCodeTaskListItem; addedAt: number; key: string }> = [];
  for (const task of tasks) {
    const key = taskKeyOf(task);
    const member = membersByTaskKey.get(key);
    if (member && member.sortOrder !== null) {
      resolvedOrderByTaskKey.set(key, member.sortOrder);
      maxOrder = Math.max(maxOrder, member.sortOrder);
    } else {
      missing.push({ task, addedAt: member?.addedAt ?? task.createdAt, key });
    }
  }
  missing.sort((left, right) => {
    if (right.addedAt !== left.addedAt) {
      return right.addedAt - left.addedAt;
    }
    return left.key.localeCompare(right.key);
  });
  let nextOrder = maxOrder;
  for (const entry of missing) {
    nextOrder += GROUPED_TASK_ORDER_STEP;
    resolvedOrderByTaskKey.set(entry.key, nextOrder);
  }
  return [...tasks].sort((left, right) => {
    const leftOrder = resolvedOrderByTaskKey.get(taskKeyOf(left)) ?? 0;
    const rightOrder = resolvedOrderByTaskKey.get(taskKeyOf(right)) ?? 0;
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return taskKeyOf(left).localeCompare(taskKeyOf(right));
  });
}

interface BuildGroupedTaskViewParams {
  structure: ZCodeGroupedTaskViewStructure;
  /** Union of task rows from the tasks-index active/pinned/archived partitions. */
  taskIndexItems: ZCodeTaskMeta[];
  /** Session activity/detail derived from the sessions-index; only enriches matching persisted rows. */
  sessions: ZCodeTaskMeta[];
  /** Server-authoritative pin/archive id sets (grouped view semantics = not pinned and not archived). */
  pinnedIds: ReadonlySet<string>;
  archivedIds: ReadonlySet<string>;
  /** Persisted-delete tombstones from tasks-index; takes precedence over all task rows/session details. */
  deletedIds?: ReadonlySet<string>;
}

/** Client-side join: group structure + task rows + session details -> a view shaped like the legacy listGroupedTaskView. */
export function buildGroupedTaskViewFromSessions(
  params: BuildGroupedTaskViewParams,
): ZCodeGroupedTaskView {
  const { structure } = params;
  const activeTaskByKey = new Map<string, ZCodeTaskListItem>();
  const taskRows = mergeTaskIndexRowsWithSessions({
    taskIndexItems: params.taskIndexItems,
    sessions: params.sessions,
  });
  for (const task of taskRows) {
    // The sessions-index may still hold deleted sessions; deleted is the negative guard
    // ahead of all grouped membership checks and must not be inferred from a missing
    // archivedIds entry.
    if (params.deletedIds?.has(task.taskId)) {
      continue;
    }
    if (params.pinnedIds.has(task.taskId) || params.archivedIds.has(task.taskId)) {
      continue;
    }
    activeTaskByKey.set(taskKeyOf(task), task);
  }

  const membersByTaskKey = new Map(
    structure.members.map((member) => [memberTaskKey(member), member]),
  );
  const membersByGroupId = new Map<string, ZCodeGroupedTaskViewStructureMember[]>();
  for (const member of structure.members) {
    const groupMembers = membersByGroupId.get(member.groupId) ?? [];
    groupMembers.push(member);
    membersByGroupId.set(member.groupId, groupMembers);
  }
  const topOrderByMapKey = new Map<string, number>();
  for (const order of structure.topLevelOrders) {
    const mapKey =
      order.type === "group"
        ? `group:${order.groupId}`
        : `task:${JSON.stringify([order.workspaceKey, order.taskId])}`;
    topOrderByMapKey.set(mapKey, order.sortOrder);
  }

  const nodes: ZCodeGroupedTaskViewNode[] = structure.groups.map((group) => {
    const groupTasks = (membersByGroupId.get(group.id) ?? [])
      .map((member) => activeTaskByKey.get(memberTaskKey(member)))
      .filter((task): task is ZCodeTaskListItem => Boolean(task));
    const order = topOrderByMapKey.get(`group:${group.id}`);
    return {
      type: "group",
      group,
      tasks: sortGroupTasks(groupTasks, membersByTaskKey),
      ...(order !== undefined ? { sortOrder: order } : {}),
    };
  });

  for (const [taskKey, task] of activeTaskByKey) {
    // Members of any group (including invisible bootstrap groups) never appear at the
    // top level, mirroring the server-side exclusion rule.
    if (membersByTaskKey.has(taskKey)) {
      continue;
    }
    const order = topOrderByMapKey.get(taskOrderMapKey(task));
    nodes.push({
      type: "task",
      task,
      ...(order !== undefined ? { sortOrder: order } : {}),
    });
  }

  // Read-only in-memory backfill for top-level nodes missing an order (the non-persisting
  // variant of normalizeGroupedTopNodeOrders): createdAt descending -> max+STEP.
  const missingNodes = nodes
    .filter((node) => node.sortOrder === undefined)
    .sort((left, right) => {
      const leftCreated = left.type === "group" ? left.group.createdAt : left.task.createdAt;
      const rightCreated = right.type === "group" ? right.group.createdAt : right.task.createdAt;
      if (rightCreated !== leftCreated) {
        return rightCreated - leftCreated;
      }
      return nodeMapKey(left).localeCompare(nodeMapKey(right));
    });
  let nextSortOrder = structure.topLevelOrders.reduce(
    (max, order) => Math.max(max, order.sortOrder),
    0,
  );
  for (const node of missingNodes) {
    nextSortOrder += GROUPED_TASK_ORDER_STEP;
    node.sortOrder = nextSortOrder;
  }

  nodes.sort(compareGroupedNodes);
  return { nodes };
}
