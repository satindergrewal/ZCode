/* eslint-disable max-lines -- the group header's color menu, context menu, rename guards, and child rows share one group context; split by interaction domain later. */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { ZCodeGroupedTaskViewNode, ZCodeTaskGroupColor } from "@zcode/services";
import {
  CRON_DEFAULT_GROUP_ID,
  OFF_PEAK_DEFAULT_GROUP_ID,
  type ZCodeTaskMeta,
} from "@zcode/shared";
import { ChevronDownIcon, ChevronRightIcon, MessageCirclePlus } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { isImeComposingKeyEvent } from "@/lib/imeComposition.js";
import { EmptyGroupDropZone } from "@/workspace-grouped-tasks/task-item.js";
import { GroupedDraftTaskRow } from "@/workspace-grouped-tasks/draft-task-row.js";
import { getTaskGroupDisplayTitle } from "@/workspace-grouped-tasks/group-title.js";
import { VirtualizedGroupedTaskList } from "@/workspace-grouped-tasks/virtualized-group-task-list.js";
import {
  TASK_GROUP_BORDER_COLOR_CLASS,
  TASK_GROUP_COLORS,
  TASK_GROUP_CONTAINER_CLASS,
  TASK_GROUP_CONTENT_CLASS,
  TASK_GROUP_COUNT_BADGE_CLASS,
  TASK_GROUP_HEADER_CLASS,
  TASK_GROUP_TITLE_CLASS,
  TaskGroupColorDot,
  TaskGroupColorMark,
} from "@/workspace-grouped-tasks/shared.js";
import type { TaskGroupMenuItem } from "@/workspace-grouped-tasks/shared.js";

export function GroupItem({
  node,
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
  onCreateTask,
  hasDraftTask,
  draftTaskActive,
  draftWorkspaceLabel,
  onSelectDraftTask,
  onCloseDraftTask,
  onRenameGroup,
  onUpdateGroupColor,
  onUngroupGroup,
  onMoveTaskToGroup,
  onMoveTaskToTop,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  newGroupSetup,
  onNewGroupSetupStarted,
  collapsed,
  onToggleCollapsed,
  activeDragTaskKey,
  activeDragGroupId,
  tooltipsDisabled,
}: {
  node: Extract<ZCodeGroupedTaskViewNode, { type: "group" }>;
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
  onCreateTask: () => void;
  hasDraftTask?: boolean;
  draftTaskActive?: boolean;
  draftWorkspaceLabel?: string;
  onSelectDraftTask?: () => void;
  onCloseDraftTask?: () => void;
  onRenameGroup: (groupId: string, title: string) => void;
  onUpdateGroupColor: (groupId: string, color: ZCodeTaskGroupColor) => void;
  onUngroupGroup: (groupId: string) => void;
  onMoveTaskToGroup: (task: ZCodeTaskMeta, groupId: string | null) => void;
  onMoveTaskToTop: (task: ZCodeTaskMeta) => void;
  onStartRenameTask: (task: ZCodeTaskMeta) => void;
  onArchiveTask: (task: ZCodeTaskMeta) => void;
  onMarkTaskAsUnread: (task: ZCodeTaskMeta) => void;
  newGroupSetup: boolean;
  onNewGroupSetupStarted: (groupId: string) => void;
  collapsed: boolean;
  onToggleCollapsed: (groupId: string) => void;
  activeDragTaskKey?: string | null;
  activeDragGroupId?: string | null;
  tooltipsDisabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(node.group.title);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const titleMeasureButtonRef = useRef<HTMLButtonElement | null>(null);
  const menuRenamePendingRef = useRef(false);
  const menuRenameFocusGuardRef = useRef(false);
  const menuRenameFocusGuardTimeoutRef = useRef<number | null>(null);
  const newGroupInitialFocusGuardRef = useRef(false);
  const newGroupInitialFocusGuardTimeoutRef = useRef<number | null>(null);
  const renameCompositionActiveRef = useRef(false);
  const [colorMenuOpen, setColorMenuOpen] = useState(false);
  const [titleEditorWidth, setTitleEditorWidth] = useState<number | null>(null);
  const groupContentId = useId();
  const [shouldRenderGroupContent, setShouldRenderGroupContent] = useState(() => !collapsed);
  const shouldShowEmptyDropZone = !hasDraftTask && node.tasks.length === 0;
  const visualCollapsed = collapsed;
  const titleEditorText = renameDraft || node.group.title;
  // System groups (cron / off-peak) are fixed: no rename or delete; color allowed (cron precedent).
  const isCronGroup = node.group.id === CRON_DEFAULT_GROUP_ID;
  const isOffPeakGroup = node.group.id === OFF_PEAK_DEFAULT_GROUP_ID;
  const isSystemGroup = isCronGroup || isOffPeakGroup;
  // Titles localize by locale, ignoring the fixed DB placeholders (cron / off-peak).
  const displayTitle = getTaskGroupDisplayTitle(node.group, {
    cron: intl.formatMessage({ id: "taskGroup.cronGroupName" }),
    offPeak: intl.formatMessage({ id: "offPeak.sidebar.groupTitle" }),
  });
  const dragging = activeDragGroupId === node.group.id;
  const groupDraggable = useDraggable({
    id: `group:${node.group.id}`,
    disabled: renaming,
    data: {
      type: "grouped-group",
      groupId: node.group.id,
    },
  });
  const groupOverDroppable = useDroppable({
    id: `group-over:${node.group.id}`,
    data: {
      type: "grouped-group-over",
      groupId: node.group.id,
    },
  });
  const collapsedGroupDroppable = useDroppable({
    id: `group-drop:${node.group.id}`,
    disabled: !visualCollapsed,
    data: {
      type: "grouped-collapsed-group",
      groupId: node.group.id,
    },
  });
  const expandedGroupHeaderDroppable = useDroppable({
    id: `group-header-drop:${node.group.id}`,
    disabled: visualCollapsed,
    data: {
      type: "grouped-expanded-group-header",
      groupId: node.group.id,
    },
  });
  const expandedGroupFooterDroppable = useDroppable({
    id: `group-footer-drop:${node.group.id}`,
    disabled: visualCollapsed,
    data: {
      type: "grouped-expanded-group-footer",
      groupId: node.group.id,
    },
  });
  const setGroupHeaderNodeRef = useCallback(
    (element: HTMLDivElement | null) => {
      groupDraggable.setNodeRef(element);
      expandedGroupHeaderDroppable.setNodeRef(element);
    },
    [expandedGroupHeaderDroppable.setNodeRef, groupDraggable.setNodeRef],
  );
  const setGroupItemNodeRef = useCallback(
    (element: HTMLDivElement | null) => {
      collapsedGroupDroppable.setNodeRef(element);
      groupOverDroppable.setNodeRef(element);
    },
    [collapsedGroupDroppable.setNodeRef, groupOverDroppable.setNodeRef],
  );
  useLayoutEffect(() => {
    if (!renaming) {
      setRenameDraft(node.group.title);
    }
  }, [node.group.title, renaming]);

  useLayoutEffect(() => {
    if (!renaming) {
      setTitleEditorWidth(null);
      return undefined;
    }
    const measureButton = titleMeasureButtonRef.current;
    if (!measureButton) {
      return undefined;
    }
    const updateWidth = () => {
      setTitleEditorWidth(Math.ceil(measureButton.getBoundingClientRect().width));
    };
    updateWidth();
    const resizeObserver = new ResizeObserver(updateWidth);
    resizeObserver.observe(measureButton);
    return () => resizeObserver.disconnect();
  }, [renaming, titleEditorText]);

  useLayoutEffect(() => {
    if (!renaming) {
      return undefined;
    }
    const animationFrame = window.requestAnimationFrame(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(animationFrame);
  }, [renaming]);

  const focusRenameInput = useCallback((options?: { select?: boolean }) => {
    const focus = () => {
      titleInputRef.current?.focus();
      if (options?.select) {
        titleInputRef.current?.select();
      }
    };
    const animationFrame = window.requestAnimationFrame(focus);
    window.setTimeout(focus, 0);
    return () => window.cancelAnimationFrame(animationFrame);
  }, []);

  const armMenuRenameFocusGuard = useCallback(() => {
    menuRenameFocusGuardRef.current = true;
    if (menuRenameFocusGuardTimeoutRef.current !== null) {
      window.clearTimeout(menuRenameFocusGuardTimeoutRef.current);
    }
    menuRenameFocusGuardTimeoutRef.current = window.setTimeout(() => {
      menuRenameFocusGuardRef.current = false;
      menuRenameFocusGuardTimeoutRef.current = null;
    }, 350);
  }, []);

  const armNewGroupInitialFocusGuard = useCallback(() => {
    newGroupInitialFocusGuardRef.current = true;
    if (newGroupInitialFocusGuardTimeoutRef.current !== null) {
      window.clearTimeout(newGroupInitialFocusGuardTimeoutRef.current);
    }
    newGroupInitialFocusGuardTimeoutRef.current = window.setTimeout(() => {
      newGroupInitialFocusGuardRef.current = false;
      newGroupInitialFocusGuardTimeoutRef.current = null;
    }, 350);
  }, []);

  const startRename = useCallback(() => {
    setRenameDraft(node.group.title);
    setRenaming(true);
  }, [node.group.title]);

  const startRenameFromMenu = useCallback(() => {
    menuRenamePendingRef.current = true;
  }, []);

  const consumePendingMenuRename = useCallback(() => {
    if (!menuRenamePendingRef.current) {
      return false;
    }
    menuRenamePendingRef.current = false;
    logger.debug("[WorkspaceGroupedTasksSection] context menu rename focus handoff", {
      groupId: node.group.id,
    });
    armMenuRenameFocusGuard();
    startRename();
    focusRenameInput({ select: true });
    return true;
  }, [armMenuRenameFocusGuard, focusRenameInput, node.group.id, startRename]);

  const handleContextMenuOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        window.setTimeout(consumePendingMenuRename, 0);
      }
    },
    [consumePendingMenuRename],
  );

  const handleContextMenuCloseAutoFocus = useCallback(
    (event: Event) => {
      // Radix hands focus back to the trigger on close;
      // rename needs it on the fresh input: block the restore, then enter editing.
      if (consumePendingMenuRename()) {
        event.preventDefault();
      }
    },
    [consumePendingMenuRename],
  );

  const cancelRename = useCallback(() => {
    setRenameDraft(node.group.title);
    setRenaming(false);
  }, [node.group.title]);

  const commitRename = useCallback(() => {
    const nextTitle = renameDraft.trim() || node.group.title;
    setRenaming(false);
    if (nextTitle === node.group.title) {
      return;
    }
    onRenameGroup(node.group.id, nextTitle);
  }, [node.group.id, node.group.title, onRenameGroup, renameDraft]);

  const handleRenameKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        if (
          isImeComposingKeyEvent({
            compositionActive: renameCompositionActiveRef.current,
            nativeEvent: event.nativeEvent,
          })
        ) {
          // IME Enter (confirming a candidate) fires keydown during rename too;
          // not a submit; blurring would run commitRename.
          logger.debug("[WorkspaceGroupedTasksSection] ignore group rename enter during IME", {
            groupId: node.group.id,
          });
          return;
        }
        event.currentTarget.blur();
        return;
      }
      if (event.key === "Escape") {
        // Esc here cancels this rename only, no bubbling to overlay shortcuts.
        event.preventDefault();
        event.stopPropagation();
        cancelRename();
      }
    },
    [cancelRename, node.group.id],
  );

  const handleRenameBlur = useCallback(() => {
    if (menuRenameFocusGuardRef.current) {
      // Close animation/focus-restore can blur the input right after its first focus;
      // teardown noise, not a finished rename: the guard window keeps editing and refocuses.
      logger.debug(
        "[WorkspaceGroupedTasksSection] keep group rename focus after context menu blur",
        {
          groupId: node.group.id,
        },
      );
      focusRenameInput({ select: true });
      return;
    }
    if (newGroupInitialFocusGuardRef.current) {
      // A new group also opens the color menu; Radix can grab focus during the opening frame.
      // That blur is not rename-end; within the window, refocus the name input.
      logger.debug("[WorkspaceGroupedTasksSection] keep new group initial name focus", {
        groupId: node.group.id,
      });
      focusRenameInput({ select: true });
      return;
    }
    commitRename();
  }, [commitRename, focusRenameInput, node.group.id]);

  useEffect(() => {
    return () => {
      if (menuRenameFocusGuardTimeoutRef.current !== null) {
        window.clearTimeout(menuRenameFocusGuardTimeoutRef.current);
      }
      if (newGroupInitialFocusGuardTimeoutRef.current !== null) {
        window.clearTimeout(newGroupInitialFocusGuardTimeoutRef.current);
      }
    };
  }, []);

  const handleColorMenuOpenChange = useCallback(
    (open: boolean) => {
      if (!open && newGroupInitialFocusGuardRef.current) {
        // Creation needs the name input focused and the color menu auto-opened.
        // Radix reads the refocus as outside focus and requests a close;
        // ignore just that one; later outside clicks close normally.
        logger.debug("[WorkspaceGroupedTasksSection] keep new group initial color menu open", {
          groupId: node.group.id,
        });
        setColorMenuOpen(true);
        return;
      }
      setColorMenuOpen(open);
    },
    [node.group.id],
  );

  const handleGroupColorChange = useCallback(
    (color: string) => {
      onUpdateGroupColor(node.group.id, color as ZCodeTaskGroupColor);
    },
    [node.group.id, onUpdateGroupColor],
  );

  const handleHeaderClick = useCallback(() => {
    onToggleCollapsed(node.group.id);
  }, [node.group.id, onToggleCollapsed]);

  const handleHeaderKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.currentTarget !== event.target) {
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      onToggleCollapsed(node.group.id);
    },
    [node.group.id, onToggleCollapsed],
  );

  useEffect(() => {
    if (!visualCollapsed) {
      setShouldRenderGroupContent(true);
      return undefined;
    }
    const timeout = window.setTimeout(() => {
      setShouldRenderGroupContent(false);
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [visualCollapsed]);

  useEffect(() => {
    if (!newGroupSetup) {
      return;
    }
    logger.debug("[WorkspaceGroupedTasksSection] start new group setup", {
      groupId: node.group.id,
    });
    armNewGroupInitialFocusGuard();
    startRename();
    setColorMenuOpen(true);
    focusRenameInput({ select: true });
    onNewGroupSetupStarted(node.group.id);
  }, [
    armNewGroupInitialFocusGuard,
    focusRenameInput,
    newGroupSetup,
    node.group.id,
    onNewGroupSetupStarted,
    startRename,
  ]);

  const newTaskButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="shrink-0 text-foreground-subtle hover:text-foreground"
      aria-label={intl.formatMessage({ id: "taskGroup.newTask" })}
      onClick={(event) => {
        event.stopPropagation();
        onCreateTask();
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
    >
      <MessageCirclePlus aria-hidden="true" className="size-3.5" />
    </Button>
  );
  const newTaskAction = tooltipsDisabled ? (
    newTaskButton
  ) : (
    <ControlHintTooltip title={intl.formatMessage({ id: "taskGroup.newTask" })}>
      {newTaskButton}
    </ControlHintTooltip>
  );

  return (
    <div
      ref={setGroupItemNodeRef}
      className={TASK_GROUP_CONTAINER_CLASS}
      data-grouped-group-item-id={node.group.id}
      data-group-collapsed={visualCollapsed ? "true" : "false"}
    >
      <ContextMenu onOpenChange={handleContextMenuOpenChange}>
        <ContextMenuTrigger asChild>
          <div
            ref={setGroupHeaderNodeRef}
            {...groupDraggable.attributes}
            {...groupDraggable.listeners}
            data-grouped-group-header-id={node.group.id}
            role="button"
            tabIndex={0}
            aria-controls={groupContentId}
            aria-expanded={!visualCollapsed}
            className={cn(
              TASK_GROUP_HEADER_CLASS,
              renaming ? "cursor-default" : "cursor-pointer",
              dragging && "opacity-0",
            )}
            onClick={handleHeaderClick}
            onKeyDown={handleHeaderKeyDown}
          >
            <DropdownMenu
              open={colorMenuOpen}
              onOpenChange={handleColorMenuOpenChange}
              modal={false}
            >
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex size-5 shrink-0 items-center justify-center rounded-full hover:bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-input-border-focused"
                  aria-label={intl.formatMessage({ id: "taskGroup.color" })}
                  onClick={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                  onPointerDown={(event) => event.stopPropagation()}
                  onTouchStart={(event) => event.stopPropagation()}
                >
                  <TaskGroupColorMark color={node.group.color} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="w-40 min-w-40"
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <DropdownMenuLabel>
                  {intl.formatMessage({ id: "taskGroup.color" })}
                </DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={node.group.color}
                  onValueChange={handleGroupColorChange}
                >
                  {TASK_GROUP_COLORS.map((color) => (
                    <DropdownMenuRadioItem key={color} value={color}>
                      <TaskGroupColorDot color={color} />
                      <span>{intl.formatMessage({ id: `taskGroup.color.${color}` })}</span>
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="flex min-w-0 flex-1 items-center gap-1">
              {renaming ? (
                <label
                  className="relative min-w-6 max-w-full shrink overflow-hidden align-middle"
                  onClick={(event) => event.stopPropagation()}
                  style={titleEditorWidth ? { width: `${titleEditorWidth}px` } : undefined}
                >
                  <span className="sr-only">{intl.formatMessage({ id: "taskGroup.rename" })}</span>
                  <button
                    ref={titleMeasureButtonRef}
                    type="button"
                    tabIndex={-1}
                    aria-hidden="true"
                    className="pointer-events-none absolute left-0 top-0 invisible overflow-hidden rounded-sm px-1 text-left text-ui-base text-foreground"
                    // The sizer must not inherit max-w-full or long input width sticks.
                    // The label keeps max-w-full for visuals; measure true content width here.
                    style={{ whiteSpace: "pre" }}
                  >
                    {titleEditorText}
                  </button>
                  <input
                    ref={titleInputRef}
                    autoFocus
                    className="w-full min-w-0 truncate rounded-sm border-0 bg-transparent px-1 py-0 text-left text-ui-base leading-normal text-foreground outline-none hover:bg-hover focus-visible:ring-1 focus-visible:ring-input-border-focused"
                    value={renameDraft}
                    onBlur={handleRenameBlur}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    onCompositionEnd={() => {
                      renameCompositionActiveRef.current = false;
                    }}
                    onCompositionStart={() => {
                      renameCompositionActiveRef.current = true;
                    }}
                    onFocus={(event) => event.currentTarget.select()}
                    onKeyDown={handleRenameKeyDown}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onTouchStart={(event) => event.stopPropagation()}
                    placeholder={node.group.title}
                  />
                </label>
              ) : (
                <button
                  type="button"
                  className={TASK_GROUP_TITLE_CLASS}
                  title={displayTitle}
                  aria-label={displayTitle}
                >
                  {displayTitle}
                </button>
              )}
              {visualCollapsed ? (
                <ChevronRightIcon
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-foreground-subtlest"
                />
              ) : (
                <ChevronDownIcon
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-foreground-subtlest"
                />
              )}
            </div>
            <span className={TASK_GROUP_COUNT_BADGE_CLASS}>
              {node.tasks.length + (hasDraftTask ? 1 : 0)}
            </span>
            {newTaskAction}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44" onCloseAutoFocus={handleContextMenuCloseAutoFocus}>
          <ContextMenuItem onSelect={onCreateTask}>
            {intl.formatMessage({ id: "taskGroup.newTask" })}
          </ContextMenuItem>
          {isSystemGroup ? null : (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={startRenameFromMenu}>
                {intl.formatMessage({ id: "taskGroup.renameAction" })}
              </ContextMenuItem>
            </>
          )}
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              {intl.formatMessage({ id: "taskGroup.changeColor" })}
            </ContextMenuSubTrigger>
            <ContextMenuSubContent
              className="w-40"
              onClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {TASK_GROUP_COLORS.map((color) => (
                <ContextMenuItem key={color} onSelect={() => handleGroupColorChange(color)}>
                  <TaskGroupColorDot color={color} />
                  <span>{intl.formatMessage({ id: `taskGroup.color.${color}` })}</span>
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
          {isSystemGroup ? null : (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => onUngroupGroup(node.group.id)}>
                {intl.formatMessage({ id: "taskGroup.ungroup" })}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      <div
        id={groupContentId}
        data-grouped-group-content-id={node.group.id}
        aria-hidden={visualCollapsed}
        className={cn(
          "grid overflow-hidden",
          "transition-[grid-template-rows,opacity] duration-200 ease-out",
          visualCollapsed ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          {/* Bugfix: grouped task collapse no longer uses Radix Collapsible:
                Presence/height vars replay on frequent mounts. A local controlled container
                unmounts children after the collapse animation. */}
          {shouldRenderGroupContent ? (
            <div
              className={cn(
                TASK_GROUP_CONTENT_CLASS,
                TASK_GROUP_BORDER_COLOR_CLASS[node.group.color],
              )}
            >
              {hasDraftTask ? (
                <>
                  <GroupedDraftTaskRow
                    active={Boolean(draftTaskActive)}
                    workspaceLabel={draftWorkspaceLabel ?? ""}
                    onSelect={onSelectDraftTask ?? onCreateTask}
                    onClose={onCloseDraftTask}
                  />
                  <VirtualizedGroupedTaskList
                    tasks={node.tasks}
                    groupId={node.group.id}
                    groups={groups}
                    getTaskRemoteSessionId={getTaskRemoteSessionId}
                    getTaskWorkspaceLabel={getTaskWorkspaceLabel}
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
                    activeDragTaskKey={activeDragTaskKey}
                    tooltipsDisabled={tooltipsDisabled}
                  />
                </>
              ) : (
                <>
                  {shouldShowEmptyDropZone ? (
                    <EmptyGroupDropZone groupId={node.group.id} onCreateTask={onCreateTask} />
                  ) : null}
                  {node.tasks.length > 0 ? (
                    <VirtualizedGroupedTaskList
                      tasks={node.tasks}
                      groupId={node.group.id}
                      groups={groups}
                      getTaskRemoteSessionId={getTaskRemoteSessionId}
                      getTaskWorkspaceLabel={getTaskWorkspaceLabel}
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
                      activeDragTaskKey={activeDragTaskKey}
                      tooltipsDisabled={tooltipsDisabled}
                    />
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </div>
      </div>
      <div
        ref={expandedGroupFooterDroppable.setNodeRef}
        aria-hidden="true"
        className={cn(
          "transition-[height,opacity] duration-150 ease-out motion-reduce:transition-none",
          visualCollapsed ? "h-0 pointer-events-none opacity-0" : "h-2.5 opacity-100",
        )}
      />
    </div>
  );
}
