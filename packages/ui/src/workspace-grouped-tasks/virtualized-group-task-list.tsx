import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { GroupedTaskItem } from "@/workspace-grouped-tasks/task-item.js";
import { taskKey } from "@/workspace-grouped-tasks/ids.js";
import {
  isPotentialVerticalScrollContainer,
  scrollGroupedTaskVirtualizerToOffset,
} from "@/workspace-grouped-tasks/virtualized-scroll.js";
import type { TaskGroupMenuItem } from "@/workspace-grouped-tasks/types.js";

const GROUPED_TASK_ROW_ESTIMATE_PX = 32;
const GROUPED_TASK_VIRTUALIZATION_THRESHOLD = 80;
const GROUPED_TASK_VIRTUALIZATION_OVERSCAN = 12;

function shouldVirtualizeGroupedTasks(taskCount: number): boolean {
  return taskCount > GROUPED_TASK_VIRTUALIZATION_THRESHOLD;
}

function findNearestScrollableAncestor(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;
  while (current) {
    const style = window.getComputedStyle(current);
    if (isPotentialVerticalScrollContainer(style.overflowY)) {
      // Early in a group-expand animation ancestors may not yet scroll past clientHeight;
      // returning null then leaves react-virtual without scrollElement: tall content, zero rows.
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function resolveScrollMargin(listElement: HTMLElement, scrollElement: HTMLElement): number {
  return (
    listElement.getBoundingClientRect().top -
    scrollElement.getBoundingClientRect().top +
    scrollElement.scrollTop
  );
}

export function VirtualizedGroupedTaskList({
  tasks,
  groupId,
  groups,
  activeWorkspacePath,
  activeWorkspaceIdentity,
  activeTaskId,
  mobileActiveTaskKey,
  getTaskRemoteSessionId,
  getTaskWorkspaceLabel,
  onSelectTask,
  onCloseTask,
  onOpenFileTree,
  onMoveTaskToGroup,
  onMoveTaskToTop,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  activeDragTaskKey,
  tooltipsDisabled,
}: {
  tasks: ZCodeTaskMeta[];
  groupId: string;
  groups: TaskGroupMenuItem[];
  activeWorkspacePath: string;
  activeWorkspaceIdentity?: string;
  activeTaskId: string | null;
  mobileActiveTaskKey?: string | null;
  getTaskRemoteSessionId: (task: ZCodeTaskMeta) => string | undefined;
  getTaskWorkspaceLabel: (task: ZCodeTaskMeta) => string;
  onSelectTask: (workspacePath: string, taskId: string, workspaceIdentity?: string) => void;
  onCloseTask: (task: ZCodeTaskMeta) => void;
  onOpenFileTree?: (task: ZCodeTaskMeta) => void;
  onMoveTaskToGroup: (task: ZCodeTaskMeta, groupId: string | null) => void;
  onMoveTaskToTop: (task: ZCodeTaskMeta) => void;
  onStartRenameTask: (task: ZCodeTaskMeta) => void;
  onArchiveTask: (task: ZCodeTaskMeta) => void;
  onMarkTaskAsUnread: (task: ZCodeTaskMeta) => void;
  activeDragTaskKey?: string | null;
  tooltipsDisabled?: boolean;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const shouldVirtualize = shouldVirtualizeGroupedTasks(tasks.length);
  const getItemKey = useCallback(
    (index: number) => taskKey(tasks[index] ?? { workspacePath: "", taskId: String(index) }),
    [tasks],
  );

  const updateScrollMargin = useCallback(() => {
    const listElement = listRef.current;
    if (!listElement) {
      return;
    }
    const nextScrollElement = findNearestScrollableAncestor(listElement);
    setScrollElement(nextScrollElement);
    if (!nextScrollElement) {
      setScrollMargin(0);
      return;
    }
    setScrollMargin(resolveScrollMargin(listElement, nextScrollElement));
  }, []);
  const resolveInitialScrollOffset = useCallback(() => {
    const listElement = listRef.current;
    const currentScrollElement =
      scrollElement ?? (listElement ? findNearestScrollableAncestor(listElement) : null);
    return currentScrollElement?.scrollTop ?? 0;
  }, [scrollElement]);

  useLayoutEffect(() => {
    if (!shouldVirtualize) {
      setScrollElement(null);
      setScrollMargin(0);
      return undefined;
    }
    updateScrollMargin();
    const listElement = listRef.current;
    const resizeObserver =
      typeof ResizeObserver === "undefined" || !listElement
        ? null
        : new ResizeObserver(updateScrollMargin);
    if (listElement) {
      resizeObserver?.observe(listElement);
    }
    const animationFrame = window.requestAnimationFrame(updateScrollMargin);
    window.addEventListener("resize", updateScrollMargin);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", updateScrollMargin);
      resizeObserver?.disconnect();
    };
  }, [groupId, shouldVirtualize, tasks.length, updateScrollMargin]);

  const rowVirtualizer = useVirtualizer({
    count: shouldVirtualize ? tasks.length : 0,
    getScrollElement: () => scrollElement,
    estimateSize: () => GROUPED_TASK_ROW_ESTIMATE_PX,
    getItemKey,
    overscan: GROUPED_TASK_VIRTUALIZATION_OVERSCAN,
    scrollMargin,
    scrollToFn: scrollGroupedTaskVirtualizerToOffset,
    // The nested virtual list shares the top-level scroller.
    // On mid-scroll remount react-virtual defaults initialOffset=0 and
    // scrollTo(0)s in _willUpdate; read the live scrollTop from the DOM
    // so the first layout effect never caches 0 before scrollElement state lands.
    initialOffset: resolveInitialScrollOffset,
  });
  const virtualRows = rowVirtualizer.getVirtualItems();
  const measureElement = rowVirtualizer.measureElement;

  const renderTask = useCallback(
    (task: ZCodeTaskMeta) => (
      <GroupedTaskItem
        key={taskKey(task)}
        task={task}
        groupId={groupId}
        groups={groups}
        remoteSessionId={getTaskRemoteSessionId(task)}
        workspaceLabel={getTaskWorkspaceLabel(task)}
        activeWorkspacePath={activeWorkspacePath}
        activeWorkspaceIdentity={activeWorkspaceIdentity}
        activeTaskId={activeTaskId}
        mobileActiveTaskKey={mobileActiveTaskKey}
        onSelectTask={onSelectTask}
        onCloseTask={onCloseTask}
        onOpenFileTree={onOpenFileTree}
        onMoveTaskToGroup={onMoveTaskToGroup}
        onMoveTaskToTop={onMoveTaskToTop}
        onStartRenameTask={onStartRenameTask}
        onArchiveTask={onArchiveTask}
        onMarkTaskAsUnread={onMarkTaskAsUnread}
        dragId={taskKey(task)}
        dragging={activeDragTaskKey === taskKey(task)}
        tooltipsDisabled={tooltipsDisabled}
      />
    ),
    [
      activeTaskId,
      activeWorkspaceIdentity,
      activeWorkspacePath,
      getTaskRemoteSessionId,
      getTaskWorkspaceLabel,
      groupId,
      groups,
      mobileActiveTaskKey,
      onArchiveTask,
      onCloseTask,
      onMarkTaskAsUnread,
      onMoveTaskToGroup,
      onMoveTaskToTop,
      onOpenFileTree,
      onSelectTask,
      onStartRenameTask,
      activeDragTaskKey,
      tooltipsDisabled,
    ],
  );

  const renderedVirtualTasks = useMemo(
    () =>
      virtualRows.map((virtualRow) => {
        const task = tasks[virtualRow.index];
        if (!task) {
          return null;
        }
        return (
          <div
            key={virtualRow.key}
            // Heights vary: workflow-run rows are 48px, not 28px. The estimate is a seed only;
            // measureElement supplies the real height, or neighbors overlap.
            ref={measureElement}
            data-index={virtualRow.index}
            className="absolute left-0 top-0 w-full"
            style={{
              transform: `translateY(${virtualRow.start - scrollMargin}px)`,
            }}
          >
            {renderTask(task)}
          </div>
        );
      }),
    [measureElement, renderTask, scrollMargin, tasks, virtualRows],
  );

  if (!shouldVirtualize) {
    return <>{tasks.map((task) => renderTask(task))}</>;
  }

  return (
    <div
      ref={listRef}
      className="relative w-full"
      style={{
        height: `${rowVirtualizer.getTotalSize()}px`,
        overflowAnchor: "none",
      }}
    >
      {/* Bugfix: big groups rendered every row; 2,000 tasks made tens of thousands of DOM nodes
          and burned JS/layout CPU. Mount the scrolled window only; clicks and menus keep working. */}
      {/* Bugfix: virtualized rows mount/unmount while scrolling and browser scroll anchoring
          treats these absolutely-positioned rows as anchors; measurement can yank scrollTop
          to the top. Disable anchoring in this subtree; react-virtual owns positioning. */}
      {renderedVirtualTasks}
    </div>
  );
}

export {
  GROUPED_TASK_ROW_ESTIMATE_PX,
  GROUPED_TASK_VIRTUALIZATION_THRESHOLD,
  shouldVirtualizeGroupedTasks,
};
