import { Archive, ArchiveX, CloudDownload, LoaderIcon, Pin, Trash2 } from "lucide-react";
import {
  TID_TASK_ARCHIVE,
  TID_TASK_ITEM,
  resolveWebRemoteControlWorkspaceKey,
  testId,
  type WebRemoteControlTaskTarget,
} from "@zcode/shared";
import { useCallback, useState, type MouseEvent as ReactMouseEvent } from "react";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { buildWebRemoteControlTaskRowKey } from "@/hooks/useWebRemoteControlTaskOpen.js";
import { TaskWorkflowRunLines } from "@/components/workflow-run-line/TaskWorkflowRunLines.js";
import type { WebRemoteControlTaskIndexSortBy } from "@/lib/webRemoteControlTaskIndex.js";

interface WebRemoteControlTaskIndexRowIntl {
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
}

export function WebRemoteControlTaskIndexRow({
  activeTaskId,
  activeWorkspaceKey,
  canMutateTask,
  intl,
  mutatingTaskKey,
  onArchiveTask,
  onDeleteArchivedTask,
  onOpenTask,
  onToggleTaskPin,
  onUnarchiveTask,
  pendingArchiveTaskKey,
  showWorkspaceLabel = false,
  switchingTaskKey,
  task,
  taskSortBy,
}: {
  activeTaskId: string | null;
  activeWorkspaceKey: string;
  canMutateTask: boolean;
  intl: WebRemoteControlTaskIndexRowIntl;
  mutatingTaskKey: string | null;
  onArchiveTask: (event: ReactMouseEvent, task: WebRemoteControlTaskTarget) => void;
  onDeleteArchivedTask: (event: ReactMouseEvent, task: WebRemoteControlTaskTarget) => void;
  onOpenTask: (task: WebRemoteControlTaskTarget) => void;
  onToggleTaskPin: (event: ReactMouseEvent, task: WebRemoteControlTaskTarget) => void;
  onUnarchiveTask: (event: ReactMouseEvent, task: WebRemoteControlTaskTarget) => void;
  pendingArchiveTaskKey: string | null;
  showWorkspaceLabel?: boolean;
  switchingTaskKey: string | null;
  task: WebRemoteControlTaskTarget;
  taskSortBy: WebRemoteControlTaskIndexSortBy;
}) {
  const [hoverActionsVisible, setHoverActionsVisible] = useState(false);
  const rowKey = buildWebRemoteControlTaskRowKey(task);
  const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);
  const isActive = taskWorkspaceKey === activeWorkspaceKey && task.taskId === activeTaskId;
  const isSwitching = switchingTaskKey === rowKey;
  const isMutating = mutatingTaskKey === rowKey;
  const isArchiveConfirming = pendingArchiveTaskKey === rowKey;
  const canPinTask = canMutateTask && !task.archived;
  const canArchiveTask = canMutateTask && !task.archived;
  const canUnarchiveTask = canMutateTask && Boolean(task.archived);
  const canDeleteArchivedTask = canMutateTask && Boolean(task.archived);
  const showPinnedState = Boolean(task.pinned && !task.archived);
  const rowDisabled = Boolean(switchingTaskKey);
  // Bugfix: the open button covers the row body, so CSS group-hover buried the pin action;
  // mount row actions on hover state exactly like desktop TaskListItem.
  const showPinAction = canPinTask && hoverActionsVisible;
  const showArchiveAction = canArchiveTask && (hoverActionsVisible || isArchiveConfirming);
  const showArchivedActions = (canUnarchiveTask || canDeleteArchivedTask) && hoverActionsVisible;
  const taskTitle = task.title || intl.formatMessage({ id: "taskList.untitled" });
  const timeLabel = formatTaskRelativeTime(
    taskSortBy === "created" ? task.createdAt : task.updatedAt,
    intl,
  );
  const pinLabel = intl.formatMessage({
    id: task.pinned ? "taskList.unpin" : "taskList.pin",
  });
  const archiveLabel = intl.formatMessage({
    id: isArchiveConfirming ? "common.confirm" : "taskList.archive",
  });
  const unarchiveLabel = intl.formatMessage({ id: "taskList.unarchive" });
  const deleteLabel = intl.formatMessage({ id: "taskList.delete" });
  const isRemoteTask = Boolean(task.workspaceIdentity?.trim() || task.workspaceKind === "remote");
  const handleMouseEnter = useCallback(() => {
    setHoverActionsVisible(true);
  }, []);
  const handleMouseLeave = useCallback(() => {
    setHoverActionsVisible(false);
  }, []);

  return (
    <li
      data-web-remote-task-row={rowKey}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      className={cn(
        "group/task-item relative flex w-full cursor-pointer items-center gap-2 rounded-lg text-left transition-[background-color,border-color,box-shadow]",
        rowDisabled && "cursor-wait opacity-80",
        isActive ? "bg-selected" : "hover:bg-surface-hover",
      )}
    >
      {/* Bugfix: wide remote rows render solely from the listWorkspaces() source of truth.
          workspace/timeline/archived used to hit different stores, diverging order/search/cross-workspace views. */}
      <button
        type="button"
        aria-label={intl.formatMessage({ id: "webRemoteControl.openTask" }, { title: taskTitle })}
        data-testid={testId(TID_TASK_ITEM, task.taskId)}
        disabled={rowDisabled}
        onClick={() => onOpenTask(task)}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-1 pl-2.5 pr-1 text-left disabled:cursor-wait disabled:opacity-80"
      >
        <span className="relative flex size-4 shrink-0 items-center justify-center">
          <span
            aria-hidden="true"
            className={cn(
              "flex size-4 items-center justify-center transition-opacity",
              showPinAction && "hidden",
            )}
          >
            {isSwitching || isMutating ? (
              <LoaderIcon className="size-4 animate-spin text-foreground-subtle" />
            ) : task.unreadAt ? (
              <span
                data-unread-indicator="true"
                className="h-1.5 w-1.5 rounded-full bg-sky-500 dark:bg-sky-400"
              />
            ) : showPinnedState ? (
              <Pin className="size-4 text-foreground-subtle" />
            ) : null}
          </span>
        </span>

        <span className="flex min-w-0 flex-1 flex-col">
          <span className="min-w-0 flex h-6 flex-wrap items-center gap-1.5">
            <span
              className="min-w-0 flex-1 truncate text-ui-base text-foreground"
              title={taskTitle}
            >
              {taskTitle}
            </span>
            {showWorkspaceLabel ? (
              <span
                className="max-w-28 shrink truncate text-ui-base text-foreground-subtlest"
                title={task.workspaceLabel}
              >
                {task.workspaceLabel}
              </span>
            ) : null}
          </span>
          {/* Workflow run row (docs/dynamic-workflow/presentation.md "The sidebar run line"): the row is a button;
              this only draws it; ended rows collapse into the remote side's own confirmation set. */}
          {task.workflowActivity ? (
            <TaskWorkflowRunLines
              activity={task.workflowActivity}
              isActive={isActive}
              intl={intl}
              density="compact"
            />
          ) : null}
        </span>

        <span
          className={cn(
            "mr-0.5 shrink-0 text-ui-base text-foreground-subtle",
            showArchiveAction && "hidden",
          )}
        >
          {timeLabel}
        </span>
      </button>
      {showPinAction ? (
        <ControlHintTooltip title={pinLabel} side="right" align="center">
          {/* Bugfix: archived rows show no pin entry (desktop archive semantics); else setTaskPinned
              flips pinned while the optimistic update clears archived, forking server membership. */}
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={rowDisabled || isMutating}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => onToggleTaskPin(event, task)}
            className={cn(
              "absolute left-2.5 top-1/2 z-10 inline-flex size-4 min-w-0 -translate-y-1/2 rounded-sm !bg-transparent p-0 text-foreground-subtle hover:text-foreground",
            )}
            aria-label={pinLabel}
          >
            <Pin className="size-4" />
          </Button>
        </ControlHintTooltip>
      ) : null}
      {showArchiveAction ? (
        <ControlHintTooltip title={archiveLabel} side="right" align="center">
          <Button
            type="button"
            variant={isArchiveConfirming ? "destructive" : "ghost"}
            size={isArchiveConfirming ? "sm" : "icon-sm"}
            disabled={rowDisabled || isMutating}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => onArchiveTask(event, task)}
            data-testid={testId(TID_TASK_ARCHIVE, task.taskId)}
            className={cn(
              "shrink-0",
              isArchiveConfirming ? "flex border-destructive/20 px-2" : "flex",
            )}
            aria-label={archiveLabel}
          >
            {isArchiveConfirming ? (
              <span>{intl.formatMessage({ id: "common.confirm" })}</span>
            ) : (
              <Archive className="size-3.5" />
            )}
          </Button>
        </ControlHintTooltip>
      ) : null}
      {showArchivedActions ? (
        <>
          {canUnarchiveTask ? (
            <ControlHintTooltip title={unarchiveLabel} side="right" align="center">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={rowDisabled || isMutating}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => onUnarchiveTask(event, task)}
                className="shrink-0 text-foreground-subtle hover:text-foreground"
                aria-label={unarchiveLabel}
              >
                {/* Bugfix: the web archive list reuses the plain row and lacked desktop's restore entry.
                    Add unarchive per desktop semantics; the remote icon marks it lands on the remote host. */}
                {isRemoteTask ? (
                  <CloudDownload className="size-3.5" />
                ) : (
                  <ArchiveX className="size-3.5" />
                )}
              </Button>
            </ControlHintTooltip>
          ) : null}
          {canDeleteArchivedTask ? (
            <ControlHintTooltip title={deleteLabel} side="right" align="center">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={rowDisabled || isMutating}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => onDeleteArchivedTask(event, task)}
                className="shrink-0 text-destructive hover:text-destructive"
                aria-label={deleteLabel}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </ControlHintTooltip>
          ) : null}
        </>
      ) : null}
    </li>
  );
}
