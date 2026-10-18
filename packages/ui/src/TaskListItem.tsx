/* eslint-disable max-lines -- the task item carries shared interaction for both default-list and two-line timeline layouts; keep action wiring in one place to avoid archive/pin regressions. */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Clock,
  CloudUpload,
  ListTree,
  LoaderIcon,
  Moon,
  Pin,
  Smartphone,
} from "lucide-react";
import { isCronTask, isOffPeakTask, type ZCodeTaskMeta } from "@zcode/shared";
import { TID_TASK_ARCHIVE, TID_TASK_ITEM, testId } from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { getPathLeaf } from "@/lib/path.js";
import { formatTaskTitleWithChanges, getTaskChangeSummary } from "@/lib/taskChangeSummary.js";
import {
  deriveTaskLeadingIndicator,
  formatTaskRelativeTime,
} from "@/lib/taskListItemPresentation.js";
import { getTaskListAttention, getTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { TaskListItemContextMenu } from "@/TaskListItemContextMenu.js";
import { TaskInteractionBadge } from "@/TaskInteractionBadge.js";
import { useTaskListItemContextActions } from "@/useTaskListItemContextActions.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { useModelTrajectoryStore } from "@/store/modelTrajectoryStore.js";
import { buildTaskFeedbackDescription } from "@/lib/taskFeedbackDraft.js";
import { toast } from "@/components/ui/toast.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { useV4SplitPaneEntry } from "@/v4/splitPaneEntryContext.js";
import { buildWorkbenchSessionKey, useWorkbenchGroupStore } from "@/v4/workbenchGroupStore.js";
import { useTaskInteractionAutoResolutionSnooze } from "@/hooks/useTaskInteractionAutoResolutionSnooze.js";
import {
  WORKBENCH_SESSION_DRAG_MIME,
  clearActiveWorkbenchSessionDragPayload,
  serializeWorkbenchSessionDragPayload,
  setActiveWorkbenchSessionDragPayload,
} from "@/v4/workbenchDragDrop.js";
import { useOptionalTabStore } from "@/store/TabStoreProvider.js";
import { isWorkspaceReadOnly } from "@/store/tabStore.js";
import { TaskTitleOverflowText } from "@/components/TaskTitleOverflowText.js";
import { createTaskWorkbenchDragPreview } from "@/lib/taskWorkbenchDragPreview.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { TaskRowActionButton } from "@/workspace-grouped-tasks/task-row-action-button.js";
import { TaskWorkflowRunLines } from "@/components/workflow-run-line/TaskWorkflowRunLines.js";

type TaskListItemIntl = {
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
};

interface TaskListItemProps {
  workspacePath: string;
  remoteSessionId?: string;
  task: ZCodeTaskMeta;
  isPinned: boolean;
  isActive: boolean;
  isMobileActive?: boolean;
  onSelectTask: (taskId: string) => void;
  onArchiveTaskInline: (e: React.MouseEvent, taskId: string) => void;
  onCancelArchiveConfirm: () => void;
  isArchiveConfirming: boolean;
  onTogglePinTask: (taskId: string, pinned: boolean) => void;
  onStartRenameTask: (taskId: string, currentTitle: string) => void;
  onArchiveTask: (taskId: string) => void;
  onMarkTaskAsUnread: (taskId: string) => void;
  onOpenTaskContextMenu?: (taskId: string) => void;
  onOpenFileTree?: (task: ZCodeTaskMeta) => void;
  variant?: "default" | "timeline";
  showPinAction?: boolean;
  intl: TaskListItemIntl;
  actionsDisabled?: boolean;
  actionsDisabledReason?: string;
}

function areJsonFieldsEqual(left: unknown, right: unknown) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function getTaskAutomationIdentity(task: ZCodeTaskMeta): string | undefined {
  return task.cronAutomationId ?? (task as ZCodeTaskMeta & { automationId?: string }).automationId;
}

function areTaskListItemTaskFieldsEqual(left: ZCodeTaskMeta, right: ZCodeTaskMeta) {
  if (left === right) {
    return true;
  }

  return (
    left.taskId === right.taskId &&
    left.workspacePath === right.workspacePath &&
    left.workspaceIdentity === right.workspaceIdentity &&
    left.provider === right.provider &&
    left.title === right.title &&
    left.forkedFromTaskId === right.forkedFromTaskId &&
    left.updatedAt === right.updatedAt &&
    left.unreadAt === right.unreadAt &&
    getTaskAutomationIdentity(left) === getTaskAutomationIdentity(right) &&
    left.status === right.status &&
    areJsonFieldsEqual(left.pendingInteraction, right.pendingInteraction) &&
    areJsonFieldsEqual(getTaskListRowActivity(left), getTaskListRowActivity(right)) &&
    areJsonFieldsEqual(left.changeSummary, right.changeSummary)
  );
}

function areTaskListItemPropsEqual(left: TaskListItemProps, right: TaskListItemProps) {
  return (
    left.workspacePath === right.workspacePath &&
    left.remoteSessionId === right.remoteSessionId &&
    areTaskListItemTaskFieldsEqual(left.task, right.task) &&
    left.isPinned === right.isPinned &&
    left.isActive === right.isActive &&
    left.isMobileActive === right.isMobileActive &&
    left.isArchiveConfirming === right.isArchiveConfirming &&
    left.variant === right.variant &&
    left.showPinAction === right.showPinAction &&
    left.intl === right.intl &&
    left.actionsDisabled === right.actionsDisabled &&
    left.actionsDisabledReason === right.actionsDisabledReason &&
    left.onSelectTask === right.onSelectTask &&
    left.onArchiveTaskInline === right.onArchiveTaskInline &&
    left.onCancelArchiveConfirm === right.onCancelArchiveConfirm &&
    left.onTogglePinTask === right.onTogglePinTask &&
    left.onStartRenameTask === right.onStartRenameTask &&
    left.onArchiveTask === right.onArchiveTask &&
    left.onMarkTaskAsUnread === right.onMarkTaskAsUnread &&
    left.onOpenTaskContextMenu === right.onOpenTaskContextMenu &&
    left.onOpenFileTree === right.onOpenFileTree
  );
}

export const MemoTaskItem = memo(function TaskListItem({
  workspacePath,
  remoteSessionId,
  task,
  isPinned,
  isActive,
  isMobileActive = false,
  onSelectTask,
  onArchiveTaskInline,
  onCancelArchiveConfirm,
  isArchiveConfirming,
  onTogglePinTask,
  onOpenTaskContextMenu,
  onOpenFileTree,
  variant = "default",
  showPinAction = true,
  intl,
  actionsDisabled = false,
  actionsDisabledReason,
}: TaskListItemProps) {
  const [hoverActionsVisible, setHoverActionsVisible] = useState(false);
  const [focusActionsVisible, setFocusActionsVisible] = useState(false);
  const [isHoverNone] = useState(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none)").matches,
  );
  const itemRef = useRef<HTMLLIElement | null>(null);
  const workspaceActionsDisabled = useOptionalTabStore(
    (state) =>
      actionsDisabled || isWorkspaceReadOnly(state, task.workspacePath, task.workspaceIdentity),
  );
  const workspaceActionsDisabledReason = workspaceActionsDisabled
    ? (actionsDisabledReason ??
      intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" }))
    : undefined;
  const snoozeInteractionAutoResolution = useTaskInteractionAutoResolutionSnooze({
    workspacePath,
    ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
    sessionId: task.taskId,
  });

  useEffect(() => {
    if (!isArchiveConfirming) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancelArchiveConfirm();
      }
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && itemRef.current?.contains(target)) {
        return;
      }
      onCancelArchiveConfirm();
    }

    // Confirm keys for the global timeline and pinned lists include workspacePath; on Windows the
    // backslashes read as CSS escapes inside selectors, so the confirm button was treated as an
    // outside click. Bound events with the item's own ref instead of coupling business keys to
    // CSS syntax.
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [isArchiveConfirming, onCancelArchiveConfirm]);

  const splitPaneEntryEnabled = useV4SplitPaneEntry().enabled;
  const taskWorkspaceScope = useMemo(
    () => ({
      workspacePath,
      ...(task.workspaceIdentity?.trim() ? { workspaceIdentity: task.workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    }),
    [remoteSessionId, task.workspaceIdentity, workspacePath],
  );
  const taskWorkbenchSessionKey = useMemo(
    () => buildWorkbenchSessionKey(taskWorkspaceScope, task.taskId),
    [task.taskId, taskWorkspaceScope],
  );
  const isSessionInWorkbenchGroup = useWorkbenchGroupStore((state) =>
    Boolean(state.sessionIndex[taskWorkbenchSessionKey]),
  );
  const canDragToWorkbench =
    !workspaceActionsDisabled && splitPaneEntryEnabled && !isSessionInWorkbenchGroup;

  // V4 runtime/interaction comes from the sessions-index projection; the legacy Zustand map no
  // longer receives background-session deltas. Consume the activity sidecar arriving with the
  // list entry so spinners/attention do not freeze.
  const taskActivity = getTaskListRowActivity(task);
  const taskAttention = getTaskListAttention(task);
  const hasPendingInteraction = Boolean(task.pendingInteraction) || taskAttention !== null;
  const taskAttentionLabel = taskAttention
    ? intl.formatMessage({
        id: taskAttention.kind === "userInput" ? "taskList.userInputTag" : "taskList.permissionTag",
      })
    : null;
  const taskAttentionDisplay =
    taskAttention && taskAttentionLabel && taskAttention.count > 1
      ? intl.formatMessage(
          { id: "taskList.attentionCount" },
          { label: taskAttentionLabel, count: String(taskAttention.count) },
        )
      : taskAttentionLabel;
  const taskTitle =
    task.title ||
    intl.formatMessage({
      id: task.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
    });
  const handleSelect = useCallback(() => {
    runUserAction({
      input: { featureId: "task.lifecycle", action: "open", trigger: "button" },
      operation: () => onSelectTask(task.taskId),
      completed: { resultSource: "optimistic_projection" },
      failureStage: "task_open",
    });
  }, [onSelectTask, task.taskId]);
  const handleDragStart = useCallback(
    (event: React.DragEvent<HTMLLIElement>) => {
      if (!canDragToWorkbench) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.effectAllowed = "copy";
      const payload = {
        kind: "zcode/session" as const,
        workspacePath,
        ...(task.workspaceIdentity?.trim() ? { workspaceIdentity: task.workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        sessionId: task.taskId,
      };
      setActiveWorkbenchSessionDragPayload(payload);
      event.dataTransfer.setData(
        WORKBENCH_SESSION_DRAG_MIME,
        serializeWorkbenchSessionDragPayload(payload),
      );
      event.dataTransfer.setData("text/plain", taskTitle);
      // The browser's default drag preview is transparent with fuzzy edges; keep the row content
      // and supply the background/border/shadow used by the Grouped drag overlay.
      const cleanupDragPreview = createTaskWorkbenchDragPreview({
        clientX: event.clientX,
        clientY: event.clientY,
        dataTransfer: event.dataTransfer,
        source: event.currentTarget,
      });
      const ownerWindow = event.currentTarget.ownerDocument.defaultView;
      if (ownerWindow) {
        ownerWindow.requestAnimationFrame(cleanupDragPreview);
      } else {
        cleanupDragPreview();
      }
    },
    [
      canDragToWorkbench,
      remoteSessionId,
      task.taskId,
      task.workspaceIdentity,
      taskTitle,
      workspacePath,
    ],
  );
  const handleDragEnd = useCallback(() => {
    clearActiveWorkbenchSessionDragPayload();
  }, []);
  const handleContextMenu = useCallback(() => {
    onOpenTaskContextMenu?.(task.taskId);
  }, [onOpenTaskContextMenu, task.taskId]);
  const handleOpenFileTree = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (workspaceActionsDisabled) {
        return;
      }
      runUserAction({
        input: { featureId: "workbench.file", action: "open_tree", trigger: "button" },
        operation: () => onOpenFileTree?.(task),
        completed: { resultSource: "local_commit" },
        failureStage: "file_tree_open",
      });
    },
    [onOpenFileTree, task, workspaceActionsDisabled],
  );

  const handleArchive = useCallback(
    (event: React.MouseEvent) => {
      if (workspaceActionsDisabled) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      runUserAction({
        input: { featureId: "task.lifecycle", action: "archive", trigger: "button" },
        operation: () => onArchiveTaskInline(event, task.taskId),
        completed: { resultSource: "optimistic_projection" },
        failureStage: "task_archive",
      });
    },
    [onArchiveTaskInline, task.taskId, workspaceActionsDisabled],
  );
  const handleTogglePin = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (workspaceActionsDisabled) {
        return;
      }
      onTogglePinTask(task.taskId, !isPinned);
    },
    [isPinned, onTogglePinTask, task.taskId, workspaceActionsDisabled],
  );
  const handleMouseEnter = useCallback(() => {
    setHoverActionsVisible(true);
  }, []);
  const handleMouseLeave = useCallback(() => {
    setHoverActionsVisible(false);
    // Archive double-confirm relies on a second click; on mouse leave, clear only the hover
    // display. Cancelling the confirmation synchronously would hide the button as soon as the
    // cursor drifts off the row, making the second click unreliable.
  }, []);

  const leadingIndicator = useMemo(
    () => deriveTaskLeadingIndicator(task, taskActivity),
    [task, taskActivity],
  );
  const isTaskCron = isCronTask(task);
  // Off-peak identity is now a persisted meta flag; the off-peak store reverse lookup lost session
  // provenance once the task was deleted and put a global store subscription on every row.
  const isTaskOffPeak = isOffPeakTask(task);
  const showTimelineIdleIndicator =
    variant === "timeline" && leadingIndicator === "none" && !isPinned;
  // The phone-remote badge and pinned state share the leading slot. A permanently visible Pin on
  // pinned tasks overlaps the absolutely-positioned phone icon; phone-active state wins by default
  // and Pin appears on hover.
  const showPinnedState = isPinned && leadingIndicator === "none" && !isMobileActive;
  const shouldMountWorkspaceTaskActions = hoverActionsVisible || focusActionsVisible || isHoverNone;
  // hover:none only means touch devices need persistent actions, not that time/status/change
  // summaries hide forever. Meta yields only during real hover/focus, keeping the old touch
  // layout's "meta + action" semantics.
  const shouldSuppressWorkspaceTaskMetadata = hoverActionsVisible || focusActionsVisible;
  const taskTimeLabel = formatTaskRelativeTime(task.updatedAt, intl);
  const taskChangeSummary = getTaskChangeSummary(task);
  const isRemoteTask = Boolean(task.workspaceIdentity?.trim());
  const archiveLabel = intl.formatMessage({
    id: isArchiveConfirming ? "common.confirm" : "taskList.archive",
  });
  const taskTitleWithChanges = formatTaskTitleWithChanges(taskTitle, taskChangeSummary, intl);
  const workspaceLabel = getPathLeaf(task.workspacePath);
  const taskItemKey = `${buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity)}:${task.taskId}`;
  // Workflow-run row: a second lane under the title,
  // disjoint from the leading 16px slot (error > unread > spinner). Mounted only for sessions with a run summary.
  const hasWorkflowRunLines = taskActivity?.workflowActivity !== undefined;
  const workflowRunLinesNode = hasWorkflowRunLines ? (
    <TaskWorkflowRunLines
      activity={taskActivity.workflowActivity}
      isActive={isActive}
      intl={intl}
      session={{
        workspacePath: task.workspacePath,
        ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
        sessionId: task.taskId,
      }}
    />
  ) : null;
  const changeSummaryNode =
    !hasPendingInteraction && taskChangeSummary ? (
      <span className="shrink-0 text-ui-base">
        {taskChangeSummary.added > 0 ? (
          <span className="text-diff-added">+{taskChangeSummary.added}</span>
        ) : null}
        {taskChangeSummary.removed > 0 ? (
          <span className="ml-1 text-diff-removed">-{taskChangeSummary.removed}</span>
        ) : null}
      </span>
    ) : null;
  const shouldRenderArchiveAction =
    !workspaceActionsDisabled &&
    !hasPendingInteraction &&
    (shouldMountWorkspaceTaskActions || isArchiveConfirming);
  const archiveActionVisibilityClassName = isArchiveConfirming ? "flex" : "flex";
  const archiveActionNode = shouldRenderArchiveAction ? (
    /* Interaction: once a task waits for archive confirmation, hide the archive button in the
       trailing hover area; "pending confirm" and "can archive" on one item fight for focus. */
    <div className={cn("items-center gap-0.5", archiveActionVisibilityClassName)}>
      {isArchiveConfirming ? (
        <ControlHintTooltip title={archiveLabel} side="top" align="center">
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={handleArchive}
            data-testid={testId(TID_TASK_ARCHIVE, task.taskId)}
            // The archive-confirm state explicitly waits for the user; keep the destructive button visible.
            className={cn("shrink-0 border-destructive/20 px-2", archiveActionVisibilityClassName)}
            aria-label={archiveLabel}
          >
            <span>{intl.formatMessage({ id: "common.confirm" })}</span>
          </Button>
        </ControlHintTooltip>
      ) : (
        // Project/Pinned plain archive buttons carried hover:bg-background/90, inconsistent with
        // the same row's file-tree action; plain states share the common bg-hover action.
        <TaskRowActionButton
          label={archiveLabel}
          onClick={handleArchive}
          showTooltip
          testId={testId(TID_TASK_ARCHIVE, task.taskId)}
        >
          {isRemoteTask ? (
            // With local and remote tasks mixed, a uniform archive icon cannot say which sqlite
            // is targeted. Remote tasks use the cloud icon so remote archiving is not mistaken
            // for local.
            <CloudUpload className="h-3.5 w-3.5" />
          ) : (
            <Archive className="h-3.5 w-3.5" />
          )}
        </TaskRowActionButton>
      )}
    </div>
  ) : null;
  // A remote task's session may not be ready and the resolver would refuse to open; hide the
  // entry at render time instead of showing a dead button. Local tasks do not depend on an open
  // tab and still open by path.
  const canOpenFileTree =
    Boolean(onOpenFileTree) && (!task.workspaceIdentity?.trim() || Boolean(remoteSessionId));
  const fileTreeActionNode =
    canOpenFileTree &&
    !workspaceActionsDisabled &&
    !hasPendingInteraction &&
    (shouldMountWorkspaceTaskActions || isMobileActive) ? (
      <span className="inline-flex shrink-0">
        {/* The pinned file-tree button hand-rolled hover background and tooltip, diverging from
            the same action on Grouped tasks. Reuse the shared action for uniform bg-hover, size,
            and pointer behavior. */}
        <TaskRowActionButton
          label={intl.formatMessage({ id: "git.action.showTree" })}
          onClick={handleOpenFileTree}
          showTooltip
        >
          <ListTree className="size-3.5" />
        </TaskRowActionButton>
      </span>
    ) : null;
  const taskActionGroupNode =
    fileTreeActionNode || archiveActionNode ? (
      <span data-task-row-actions="true" className="flex shrink-0 items-center gap-0.5">
        {fileTreeActionNode}
        {archiveActionNode}
      </span>
    ) : null;
  const pinActionButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      disabled={workspaceActionsDisabled}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={handleTogglePin}
      className="inline-flex size-4 min-w-0 rounded-sm p-0 text-foreground-subtle !bg-transparent hover:text-foreground"
      aria-label={intl.formatMessage({
        id: isPinned ? "taskList.unpin" : "taskList.pin",
      })}
    >
      <Pin className="size-4" />
    </Button>
  );
  // hover:none keeps trailing task actions persistent; also letting it own the leading slot would
  // permanently replace error/unread/loading states with Pin on touch.
  const shouldRenderPinAction =
    showPinAction && (showPinnedState || shouldSuppressWorkspaceTaskMetadata);
  return (
    <li
      ref={itemRef}
      data-testid={testId(TID_TASK_ITEM, task.taskId)}
      data-task-item-key={taskItemKey}
      data-mobile-active-task={isMobileActive ? "true" : undefined}
      data-archive-confirming-task-id={isArchiveConfirming ? task.taskId : undefined}
      onClick={handleSelect}
      onContextMenu={handleContextMenu}
      draggable={canDragToWorkbench}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onFocusCapture={() => setFocusActionsVisible(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setFocusActionsVisible(false);
        }
      }}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleSelect();
        }
      }}
      className={cn(
        "group/task-item flex cursor-pointer gap-2 rounded-lg pl-2.5 pr-1 py-1 transition-[background-color,border-color,box-shadow]",
        // At the default 32px row the leading slot centers vertically; once the workflow-run row
        // appears the body is a two-row column, so align the slot to the first row.
        variant === "timeline"
          ? "items-start py-1.5"
          : hasWorkflowRunLines
            ? "items-start"
            : "items-center",
        isActive ? "bg-selected" : "hover:bg-surface-hover",
      )}
    >
      {/* Task lists used divide-y separators; on the dark sidebar every item grew visible lines
              above and below, looking sandwiched by borders. Switch to list padding plus per-item
              rounded states so hover/active hierarchy comes from the card background, not rules. */}

      <div
        className={cn(
          "relative flex size-4 shrink-0 items-center justify-center",
          // When the body is a column (title + run row) the leading slot aligns to the first row,
          // not the whole row: default 24px first line centered = 4px top padding.
          variant === "timeline" ? "mt-0.5" : hasWorkflowRunLines ? "mt-1" : undefined,
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "flex size-4 items-center justify-center transition-opacity",
            shouldRenderPinAction && "hidden",
            isMobileActive && "invisible",
          )}
        >
          {leadingIndicator === "error" ? (
            <span data-error-indicator="true" className="h-1.5 w-1.5 rounded-full bg-destructive" />
          ) : leadingIndicator === "unread" ? (
            <span
              data-unread-indicator="true"
              className="h-1.5 w-1.5 rounded-full bg-sky-500 dark:bg-sky-400"
            />
          ) : leadingIndicator === "loading" ? (
            <LoaderIcon className="size-4 animate-spin text-foreground-subtle" />
          ) : showTimelineIdleIndicator ? (
            <span data-idle-indicator="true" className="h-1.5 w-1.5 rounded-full bg-border" />
          ) : null}
        </span>
        {shouldRenderPinAction ? (
          <ControlHintTooltip
            title={
              workspaceActionsDisabledReason ??
              intl.formatMessage({
                id: isPinned ? "taskList.unpin" : "taskList.pin",
              })
            }
            side="top"
            align="center"
          >
            {pinActionButton}
          </ControlHintTooltip>
        ) : null}
      </div>

      {variant === "timeline" ? (
        <div className="relative flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex min-w-0 items-center gap-1.5">
            {isMobileActive && !shouldSuppressWorkspaceTaskMetadata ? (
              <ControlHintTooltip
                title={intl.formatMessage({ id: "taskList.mobileActive" })}
                side="right"
                align="center"
                triggerClassName="absolute -left-6 top-2 z-10 -translate-y-1/2"
              >
                <span
                  data-mobile-active-task="true"
                  className="inline-flex size-4 items-center justify-center rounded-sm text-success"
                  aria-label={intl.formatMessage({
                    id: "taskList.mobileActive",
                  })}
                >
                  <Smartphone className="size-3.5" />
                </span>
              </ControlHintTooltip>
            ) : null}
            <TaskTitleOverflowText
              className="text-ui-base text-foreground"
              title={taskTitleWithChanges}
            >
              {/* workspace/timeline task titles used truncate, showing ellipsis on long titles;
                      grouped tasks already fade out to the right. Unify the title overflow policy
                      so one sidebar never shows two truncation semantics. */}
              {taskTitle}
            </TaskTitleOverflowText>
            {task.pendingInteraction ? (
              <TaskInteractionBadge
                interaction={task.pendingInteraction}
                formatMessage={(id) => intl.formatMessage({ id })}
                onSnoozeCountdown={snoozeInteractionAutoResolution}
              />
            ) : taskAttentionDisplay ? (
              <Badge className="h-5 shrink-0 border-transparent bg-success/14 px-2 text-ui-base font-medium text-success dark:bg-success/18">
                {taskAttentionDisplay}
              </Badge>
            ) : null}
          </div>
          <div className="flex min-w-0 items-center justify-between gap-2 text-ui-base text-foreground-subtle h-6">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="truncate">{workspaceLabel}</span>
            </div>
            <div className="ml-auto flex shrink-0 items-center justify-end gap-1.5">
              {!hasPendingInteraction ? (
                <span
                  data-task-row-metadata="true"
                  className={cn(
                    "flex items-center gap-1.5",
                    isArchiveConfirming || shouldSuppressWorkspaceTaskMetadata
                      ? "hidden"
                      : undefined,
                  )}
                >
                  {changeSummaryNode}
                  {changeSummaryNode ? (
                    <span aria-hidden="true" className="shrink-0 text-foreground-subtlest">
                      ·
                    </span>
                  ) : null}
                  {isTaskCron ? (
                    // The scheduled-task icon must not take the leading status slot; unread,
                    // running, and pinned-hover all claim it. Place it before the timestamp,
                    // matching the grouped row's meta position, so state changes cannot drop it.
                    <Clock
                      data-cron-task-icon="true"
                      aria-label={intl.formatMessage({
                        id: "taskList.cronTaskLabel",
                      })}
                      className="size-3.5 shrink-0"
                    />
                  ) : isTaskOffPeak ? (
                    <Moon
                      data-off-peak-task-icon="true"
                      aria-label={intl.formatMessage({ id: "taskList.offPeakTaskLabel" })}
                      className="size-3.5 shrink-0"
                    />
                  ) : null}
                  <span className="mr-1">{taskTimeLabel}</span>
                </span>
              ) : null}
              {taskActionGroupNode}
            </div>
          </div>
          {workflowRunLinesNode}
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <div className="relative min-w-0 flex h-6 flex-1 flex-wrap items-center gap-1.5">
              {isMobileActive && !shouldSuppressWorkspaceTaskMetadata ? (
                <ControlHintTooltip
                  title={intl.formatMessage({ id: "taskList.mobileActive" })}
                  side="right"
                  align="center"
                  triggerClassName="absolute -left-6 top-1/2 z-10 -translate-y-1/2"
                >
                  <span
                    data-mobile-active-task="true"
                    className="inline-flex size-4 items-center justify-center rounded-sm text-success"
                    aria-label={intl.formatMessage({
                      id: "taskList.mobileActive",
                    })}
                  >
                    {/* mobileViewState already tells desktop which task the phone views, but the
                        list never consumed it, so users assumed only desktop was acting. As a flex
                        child before the title it pushed titles right and misaligned rows; absolutely
                        position it into the existing leading slot so title text keeps its origin,
                        and hide the badge on hover, returning the pin button. */}
                    <Smartphone className="size-3.5" />
                  </span>
                </ControlHintTooltip>
              ) : null}
              <TaskTitleOverflowText
                className="text-ui-base text-foreground"
                title={taskTitleWithChanges}
              >
                {/* Default workspace items and timeline items share title overflow rules;
                        use a mask fade instead of ellipsis, matching grouped task rows. */}
                {taskTitle}
              </TaskTitleOverflowText>
              {changeSummaryNode ? (
                <span
                  className={cn(
                    isArchiveConfirming || shouldSuppressWorkspaceTaskMetadata
                      ? "hidden"
                      : undefined,
                  )}
                >
                  {changeSummaryNode}
                </span>
              ) : null}
              {task.pendingInteraction ? (
                <TaskInteractionBadge
                  interaction={task.pendingInteraction}
                  formatMessage={(id) => intl.formatMessage({ id })}
                  onSnoozeCountdown={snoozeInteractionAutoResolution}
                />
              ) : taskAttentionDisplay ? (
                <Badge className="h-5 shrink-0 border-transparent bg-success/14 px-2 text-ui-sm font-medium text-success dark:bg-success/18">
                  {taskAttentionDisplay}
                </Badge>
              ) : null}
            </div>

            {!hasPendingInteraction ? (
              // The interaction capsule owns the trailing status; relative time beside "awaiting
              // confirmation" would squeeze the title.
              <span
                data-task-row-metadata="true"
                className={cn(
                  "mr-0.5 flex shrink-0 items-center gap-1 text-ui-sm text-foreground-subtle",
                  isArchiveConfirming || shouldSuppressWorkspaceTaskMetadata ? "hidden" : undefined,
                )}
              >
                {isTaskCron ? (
                  // The scheduled-task icon belongs to the time meta, not the leading status slot, or unread/loading states displace it.
                  <Clock
                    data-cron-task-icon="true"
                    aria-label={intl.formatMessage({
                      id: "taskList.cronTaskLabel",
                    })}
                    className="size-3.5 shrink-0"
                  />
                ) : isTaskOffPeak ? (
                  <Moon
                    data-off-peak-task-icon="true"
                    aria-label={intl.formatMessage({ id: "taskList.offPeakTaskLabel" })}
                    className="size-3.5 shrink-0"
                  />
                ) : null}
                {taskTimeLabel}
              </span>
            ) : null}

            {taskActionGroupNode}
          </div>
          {workflowRunLinesNode}
        </div>
      )}
    </li>
  );
}, areTaskListItemPropsEqual);

MemoTaskItem.displayName = "MemoTaskItem";

export function TaskListItemContextMenuContent({
  workspacePath,
  remoteSessionId,
  task,
  isPinned,
  intl,
  onTogglePinTask,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  disableTaskActions = false,
  disabledReason,
}: {
  workspacePath: string;
  remoteSessionId?: string;
  task: ZCodeTaskMeta;
  isPinned: boolean;
  intl: TaskListItemIntl;
  onTogglePinTask: (taskId: string, pinned: boolean) => void;
  onStartRenameTask: (taskId: string, currentTitle: string) => void;
  onArchiveTask: (taskId: string) => void;
  onMarkTaskAsUnread: (taskId: string) => void;
  disableTaskActions?: boolean;
  disabledReason?: string;
}) {
  const workspaceActionsDisabled = useOptionalTabStore(
    (state) =>
      disableTaskActions || isWorkspaceReadOnly(state, task.workspacePath, task.workspaceIdentity),
  );
  const workspaceActionsDisabledReason = workspaceActionsDisabled
    ? (disabledReason ?? intl.formatMessage({ id: "workspaceSidebar.unavailableLocalDirectory" }))
    : undefined;
  // Wrap-up: "open in split" is desktop-shell only (context provided by WorkspaceShellLayout;
  // phone remote/no-provider environments default false, so the menu item does not render).
  const splitPaneEntry = useV4SplitPaneEntry();
  const splitPaneEntryEnabled = splitPaneEntry.enabled;
  const splitPaneTarget = useMemo(
    () => ({
      workspacePath,
      ...(task.workspaceIdentity?.trim() ? { workspaceIdentity: task.workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
      sessionId: task.taskId,
    }),
    [remoteSessionId, task.taskId, task.workspaceIdentity, workspacePath],
  );
  // Focused session, existing groups, and pane limits are all adjudicated by the shell owner; rows no longer write the layout store directly.
  const canOpenInSplitPane = splitPaneEntry.canOpenSession(splitPaneTarget);
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const {
    taskSessionFile,
    taskNativeSessionLogFile,
    fileManagerLabel,
    handleCopyText,
    handleOpenTaskPathInFileManager,
  } = useTaskListItemContextActions({
    workspacePath,
    remoteSessionId,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
    provider: task.provider,
    intl,
    // Row-level menus collapsed into a single list-level instance mounted only while open, so
    // path and provider probing can simply run with the open state instead of every idle row
    // subscribing and computing.
    loadTaskPaths: true,
  });
  const taskTitle =
    task.title ||
    intl.formatMessage({
      id: task.forkedFromTaskId ? "taskList.forkedUntitled" : "taskList.untitled",
    });

  const handleOpenTaskFeedback = useCallback(async () => {
    // The task context menu used to offer only copy log/path, lacking task context for feedback.
    // Reuse the feedback-center draft, prefilled with sanitized task clues only; attachments stay
    // user-chosen.
    openFeedbackSubmit({
      title: intl
        .formatMessage(
          { id: "feedback.submit.template.section.taskFeedbackTitle" },
          { title: taskTitle },
        )
        .slice(0, 80),
      type: "bug",
      module: "Agent任务执行失败",
      severity: "P2-中",
      includeLogs: false,
      description: buildTaskFeedbackDescription({
        taskTitle,
        taskId: task.taskId,
        workspacePath,
        taskSessionPath: taskSessionFile.path,
        taskLogPath: taskNativeSessionLogFile.path,
        formatMessage: (id: string, values?: Record<string, string>) =>
          intl.formatMessage({ id }, values),
      }),
      screenshots: [],
    });
    toast(intl.formatMessage({ id: "taskList.feedbackOpened" }));
  }, [
    intl,
    openFeedbackSubmit,
    task.taskId,
    taskNativeSessionLogFile.path,
    taskSessionFile.path,
    taskTitle,
    workspacePath,
  ]);

  return (
    <TaskListItemContextMenu
      intl={intl}
      isPinned={isPinned}
      fileManagerLabel={fileManagerLabel}
      taskSessionFile={taskSessionFile}
      activeSessionId={task.taskId}
      taskNativeSessionLogFile={taskNativeSessionLogFile}
      disableTaskActions={workspaceActionsDisabled}
      disabledReason={workspaceActionsDisabledReason}
      onTogglePinTask={() => {
        onTogglePinTask(task.taskId, !isPinned);
      }}
      onStartRenameTask={() => {
        onStartRenameTask(task.taskId, task.title);
      }}
      onArchiveTask={() => {
        onArchiveTask(task.taskId);
      }}
      onMarkTaskAsUnread={() => {
        onMarkTaskAsUnread(task.taskId);
      }}
      onOpenInSplitPane={
        splitPaneEntryEnabled
          ? () => {
              // The legacy entry wrote paneLayout directly, bypassing active-group/shell
              // navigation; after a draft split, the next plain click would pour the session into
              // primary. Route everything through the shell controller.
              splitPaneEntry.openSession(splitPaneTarget);
            }
          : undefined
      }
      openInSplitPaneDisabled={workspaceActionsDisabled || !canOpenInSplitPane}
      onOpenTaskFeedback={() => {
        void handleOpenTaskFeedback();
      }}
      onOpenTaskPathInFileManager={() => {
        void handleOpenTaskPathInFileManager();
      }}
      onCopyWorkspacePath={() => {
        void handleCopyText(intl.formatMessage({ id: "appHeader.copyPath" }), workspacePath);
      }}
      onCopyTaskPath={() => {
        void handleCopyText(
          intl.formatMessage({ id: "appHeader.copyTaskPath" }),
          taskSessionFile.path,
        );
      }}
      onCopyTaskLogPath={() => {
        void handleCopyText(
          intl.formatMessage({ id: "appHeader.copyLogPath" }),
          taskNativeSessionLogFile.path,
        );
      }}
      onCopySessionId={() => {
        void handleCopyText(intl.formatMessage({ id: "appHeader.copySessionId" }), task.taskId);
      }}
      onViewModelTrajectory={() => {
        // Hand the "open trace" request to the owning workspace's sidebar controller (useAppPanels) via the singleton store.
        useModelTrajectoryStore.getState().requestOpen({
          taskId: task.taskId,
          workspaceKey: task.workspaceIdentity?.trim() || workspacePath,
          title: taskTitle,
        });
      }}
    />
  );
}
