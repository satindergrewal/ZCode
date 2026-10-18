import { memo, useCallback, useMemo, type CSSProperties } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { WorkspaceSidebarItem, type SortableBindings } from "./WorkspaceSidebarItem.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import type { RemoteConnectionLogEntry } from "@/hooks/useRemoteConnectionLogs.js";
import type { ZCodeTaskMeta } from "@zcode/shared";

export type { SortableBindings };

// The vertical dnd container constraints moved to lib (idle-time intra-group drag reuses them without this module's dependency chain).
export { restrictVerticalDragWithinContainer } from "@/lib/restrictVerticalDragWithinContainer.js";

export const SortableWorkspaceSidebarItem = memo(function SortableWorkspaceSidebarItem({
  tab,
  isActiveWorkspace,
  isExpanded,
  activateTab,
  closeTab,
  toggleWorkspaceExpanded,
  onSelectTask,
  onStartDraftInWorkspace,
  taskItems,
  taskListLoading,
  taskListHasMore,
  taskListHasUnread = false,
  taskListLiveWorkflowCount = 0,
  mobileActiveTaskKey,
  isWebRemoteControl = false,
  workspaceKey,
  onShowMoreWorkspaceTasks,
  reconnectingRemoteWorkspaceKeys,
  remoteWorkspaceErrorByWorkspaceKey,
  reconnectingRemoteWorkspaceLogsByWorkspaceKey,
  onReconnectRemoteWorkspace,
  onOpenFileTree,
}: {
  tab: WorkspaceTabState;
  isActiveWorkspace: boolean;
  isExpanded: boolean;
  activateTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  toggleWorkspaceExpanded: (workspacePath: string) => void;
  onSelectTask: (
    targetWorkspacePath: string,
    taskId: string,
    targetWorkspaceIdentity?: string,
  ) => void;
  onStartDraftInWorkspace: (targetWorkspacePath: string, targetWorkspaceIdentity?: string) => void;
  taskItems: ZCodeTaskMeta[];
  taskListLoading: boolean;
  taskListHasMore: boolean;
  taskListHasUnread?: boolean;
  taskListLiveWorkflowCount?: number;
  mobileActiveTaskKey?: string | null;
  isWebRemoteControl?: boolean;
  workspaceKey: string;
  onShowMoreWorkspaceTasks: (workspaceKey: string) => void;
  reconnectingRemoteWorkspaceKeys: string[];
  remoteWorkspaceErrorByWorkspaceKey: Record<string, string>;
  reconnectingRemoteWorkspaceLogsByWorkspaceKey: Record<string, RemoteConnectionLogEntry[]>;
  onReconnectRemoteWorkspace: (workspaceKey: string) => Promise<void>;
  onOpenFileTree: (target: {
    workspacePath: string;
    workspaceName: string;
    workspaceIdentity?: string;
    workspaceRemoteSessionId?: string;
  }) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
  });
  // Streaming task events refresh the sidebar at high frequency; dnd-kit may hand back a new
  // transform object even when values are unchanged. Derive stable props from primitives so
  // row-level memo holds.
  const transformString = useMemo(() => {
    if (!transform) {
      return undefined;
    }

    return CSS.Transform.toString({
      ...transform,
      // Without DragOverlay, dnd-kit attaches scaleX/scaleY from the over node's rect to the
      // active item. Workspace rows vary in height, so dragging across expanded/collapsed rows
      // squashes or stretches the dragged row. Clamp sidebar drag scale to 1: translation only,
      // the real node never matches the target's height.
      scaleX: 1,
      scaleY: 1,
    });
  }, [transform?.x, transform?.y]);

  const style = useMemo<CSSProperties>(
    () => ({
      transform: transformString,
      transition,
      zIndex: isDragging ? 10 : undefined,
      // The real row collapses at drag start and DragOverlay carries the visuals; rendering both
      // duplicates the header and confuses drop targeting.
      opacity: isDragging ? 0 : 1,
    }),
    [isDragging, transition, transformString],
  );
  const sortableBindings = useMemo<SortableBindings>(
    () => ({ attributes, listeners }),
    [attributes, listeners],
  );
  const handleShowMoreTasks = useCallback(() => {
    onShowMoreWorkspaceTasks(workspaceKey);
  }, [onShowMoreWorkspaceTasks, workspaceKey]);

  return (
    <WorkspaceSidebarItem
      tab={tab}
      isActiveWorkspace={isActiveWorkspace}
      isExpanded={isExpanded}
      activateTab={activateTab}
      closeTab={closeTab}
      toggleWorkspaceExpanded={toggleWorkspaceExpanded}
      onSelectTask={onSelectTask}
      onStartDraftInWorkspace={onStartDraftInWorkspace}
      taskItems={taskItems}
      taskListLoading={taskListLoading}
      taskListHasMore={taskListHasMore}
      taskListHasUnread={taskListHasUnread}
      taskListLiveWorkflowCount={taskListLiveWorkflowCount}
      mobileActiveTaskKey={mobileActiveTaskKey}
      isWebRemoteControl={isWebRemoteControl}
      onShowMoreTasks={handleShowMoreTasks}
      reconnectingRemoteWorkspaceKeys={reconnectingRemoteWorkspaceKeys}
      remoteWorkspaceErrorByWorkspaceKey={remoteWorkspaceErrorByWorkspaceKey}
      reconnectingRemoteWorkspaceLogsByWorkspaceKey={reconnectingRemoteWorkspaceLogsByWorkspaceKey}
      onReconnectRemoteWorkspace={onReconnectRemoteWorkspace}
      onOpenFileTree={onOpenFileTree}
      itemRef={setNodeRef}
      itemStyle={style}
      sortableBindings={sortableBindings}
      isDragging={isDragging}
    />
  );
});
SortableWorkspaceSidebarItem.displayName = "SortableWorkspaceSidebarItem";
