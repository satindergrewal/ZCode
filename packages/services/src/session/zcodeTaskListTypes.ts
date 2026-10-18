import type { WorkspacePurpose, ZCodeTaskMeta } from "@zcode/shared";

export type ZCodeTaskListKind = "pinned" | "archived" | "timeline" | "active";
export type ZCodeTaskListSortBy = "created" | "updated";

export interface ZCodeTaskListWorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface ZCodeTaskListQuery {
  kind: ZCodeTaskListKind;
  workspaceScopes: ZCodeTaskListWorkspaceScope[];
  sortBy: ZCodeTaskListSortBy;
  search?: string;
  limit?: number;
}

export type ZCodeTaskListItem = ZCodeTaskMeta & {
  searchSnippet?: string;
  searchSnippets?: string[];
};

export interface ZCodeTaskListResult {
  items: ZCodeTaskListItem[];
  total: number;
  hasMore: boolean;
}

export type ZCodeTaskGroupColor =
  | "gray"
  | "red"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple";

export interface ZCodeTaskGroup {
  id: string;
  title: string;
  color: ZCodeTaskGroupColor;
  createdAt: number;
  updatedAt: number;
}

export interface ZCodeGroupedTaskRef {
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
}

export type ZCodeGroupedTaskViewTopLevelNodeRef =
  | { type: "group"; groupId: string }
  | { type: "task"; task: ZCodeGroupedTaskRef };

export type ZCodeGroupedTaskViewNode =
  | {
      type: "group";
      group: ZCodeTaskGroup;
      tasks: ZCodeTaskListItem[];
      sortOrder?: number;
    }
  | {
      type: "task";
      task: ZCodeTaskListItem;
      sortOrder?: number;
    };

export interface ZCodeGroupedTaskView {
  nodes: ZCodeGroupedTaskViewNode[];
}

export interface ZCodeGroupedTaskViewQuery {
  workspaceScopes: ZCodeTaskListWorkspaceScope[];
  includeAllWorkspaces?: boolean;
}

// -- Grouped raw structure (no tasks-table join) --
// After grouped-view task data moved to sessions-index, the server provides group structure only;
// （task_groups / task_group_members / task_group_view_node_orders），
// the client joins it with sessions-index sessions.

/** Group member reference (no task meta; content comes from sessions-index). */
export interface ZCodeGroupedTaskViewStructureMember {
  groupId: string;
  /** Server-side workspaceKey (resolveWorkspaceKey: identity ?? path), the join key. */
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  taskId: string;
  /** null = sort_order not yet persisted (newly joined); the client orders by addedAt desc in memory. */
  sortOrder: number | null;
  addedAt: number;
}

/** Root node order (task_group_view_node_orders, node_key parsed into structured references). */
export type ZCodeGroupedTaskViewStructureTopOrder =
  | { type: "group"; groupId: string; sortOrder: number }
  | { type: "task"; workspaceKey: string; taskId: string; sortOrder: number };

export interface ZCodeGroupedTaskViewStructure {
  /** Groups filtered by workspaceScopes visibility (the bootstrap workspace group shows in its workspace only). */
  groups: ZCodeTaskGroup[];
  /** All members, including invisible groups' (the root-exclusion rule needs the full set). */
  members: ZCodeGroupedTaskViewStructureMember[];
  topLevelOrders: ZCodeGroupedTaskViewStructureTopOrder[];
}

export interface ZCodeGroupedTaskViewOrderInput {
  workspaceScopes: ZCodeTaskListWorkspaceScope[];
  topLevelNodes: ZCodeGroupedTaskViewTopLevelNodeRef[];
  groups: Array<{
    groupId: string;
    taskRefs: ZCodeGroupedTaskRef[];
  }>;
}

export interface ZCodeWorkspaceEventSubscriptionParams {
  workspacePath: string;
  workspaceIdentity?: string;
}
