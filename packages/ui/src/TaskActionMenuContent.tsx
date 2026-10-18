import { TID_V4_TASK_OPEN_IN_SPLIT } from "@zcode/shared";

interface TaskActionMenuItemProps {
  children: React.ReactNode;
  "data-testid"?: string;
  disabled?: boolean;
  onSelect?: () => void;
  title?: string;
}

interface TaskActionMenuSeparatorProps {
  key?: string;
}

export function TaskActionMenuContent({
  intl,
  isPinned,
  fileManagerLabel,
  taskSessionFile,
  activeSessionId,
  taskNativeSessionLogFile,
  disableTaskActions = false,
  disableTaskTargetActions = false,
  disablePinTaskAction = false,
  disabledReason,
  hideMobileUnsupportedActions = false,
  Item,
  Separator,
  onTogglePinTask,
  onStartRenameTask,
  onArchiveTask,
  onMarkTaskAsUnread,
  onOpenInSplitPane,
  openInSplitPaneDisabled = false,
  onOpenTaskFeedback,
  onOpenTaskPathInFileManager,
  onCopyWorkspacePath,
  onCopyTaskPath,
  onCopyTaskLogPath,
  onCopySessionId,
  onViewModelTrajectory,
}: {
  intl: {
    formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
  };
  isPinned: boolean;
  fileManagerLabel: string;
  taskSessionFile: { loading: boolean; path: string | null; exists: boolean };
  activeSessionId?: string | null;
  taskNativeSessionLogFile: {
    loading: boolean;
    path: string | null;
    exists: boolean;
  };
  disableTaskActions?: boolean;
  disableTaskTargetActions?: boolean;
  disablePinTaskAction?: boolean;
  disabledReason?: string;
  hideMobileUnsupportedActions?: boolean;
  Item: React.ComponentType<TaskActionMenuItemProps>;
  Separator: React.ComponentType<TaskActionMenuSeparatorProps>;
  onTogglePinTask: () => void;
  onStartRenameTask: () => void;
  onArchiveTask: () => void;
  onMarkTaskAsUnread: () => void;
  /** "Open in split view" (desktop shell only; hidden on phone remote control). */
  onOpenInSplitPane?: () => void;
  /** Disabled at the session/pane limit when the target has no home yet (layout and hierarchy preserved). */
  openInSplitPaneDisabled?: boolean;
  onOpenTaskFeedback?: () => void;
  onOpenTaskPathInFileManager: () => void;
  onCopyWorkspacePath: () => void;
  onCopyTaskPath: () => void;
  onCopyTaskLogPath: () => void;
  onCopySessionId?: () => void;
  onViewModelTrajectory?: () => void;
}) {
  const taskTargetActionsDisabled = disableTaskActions || disableTaskTargetActions;

  return (
    <>
      <Item
        disabled={taskTargetActionsDisabled || disablePinTaskAction}
        title={taskTargetActionsDisabled ? disabledReason : undefined}
        onSelect={() => {
          if (!taskTargetActionsDisabled && !disablePinTaskAction) {
            onTogglePinTask();
          }
        }}
      >
        {intl.formatMessage({ id: isPinned ? "taskList.unpin" : "taskList.pin" })}
      </Item>
      <Item
        disabled={taskTargetActionsDisabled}
        title={disabledReason}
        onSelect={() => {
          if (!taskTargetActionsDisabled) {
            onStartRenameTask();
          }
        }}
      >
        {intl.formatMessage({ id: "taskList.rename" })}
      </Item>
      <Item
        disabled={taskTargetActionsDisabled}
        title={disabledReason}
        onSelect={() => {
          if (!taskTargetActionsDisabled) {
            onArchiveTask();
          }
        }}
      >
        {intl.formatMessage({ id: "taskList.archive" })}
      </Item>
      <Item
        disabled={taskTargetActionsDisabled}
        title={disabledReason}
        onSelect={() => {
          if (!taskTargetActionsDisabled) {
            onMarkTaskAsUnread();
          }
        }}
      >
        {intl.formatMessage({ id: "taskList.markAsUnread" })}
      </Item>
      {onOpenInSplitPane ? (
        <Item
          data-testid={TID_V4_TASK_OPEN_IN_SPLIT}
          disabled={taskTargetActionsDisabled || openInSplitPaneDisabled}
          onSelect={onOpenInSplitPane}
        >
          {intl.formatMessage({ id: "taskList.openInSplitPane" })}
        </Item>
      ) : null}
      <Separator />
      {!hideMobileUnsupportedActions ? (
        <Item
          disabled={disableTaskActions}
          title={disableTaskActions ? disabledReason : undefined}
          onSelect={() => {
            if (!disableTaskActions) {
              onOpenTaskPathInFileManager();
            }
          }}
        >
          {fileManagerLabel}
        </Item>
      ) : null}
      <Item
        disabled={disableTaskActions}
        title={disableTaskActions ? disabledReason : undefined}
        onSelect={onCopyWorkspacePath}
      >
        {intl.formatMessage({ id: "appHeader.copyPath" })}
      </Item>
      <Item
        disabled={taskTargetActionsDisabled || taskSessionFile.loading || !taskSessionFile.path}
        title={taskTargetActionsDisabled ? disabledReason : undefined}
        onSelect={onCopyTaskPath}
      >
        {intl.formatMessage({ id: "appHeader.copyTaskPath" })}
      </Item>
      <Item
        disabled={
          taskTargetActionsDisabled ||
          taskNativeSessionLogFile.loading ||
          !taskNativeSessionLogFile.path
        }
        title={taskTargetActionsDisabled ? disabledReason : undefined}
        onSelect={onCopyTaskLogPath}
      >
        {/* The log path may be derived by convention before today's file exists. Copying only
            needs the path string; exists=false must not read as uncopyable or the menu looks dead. */}
        {intl.formatMessage({ id: "appHeader.copyLogPath" })}
      </Item>
      {onCopySessionId ? (
        <Item
          disabled={taskTargetActionsDisabled || !activeSessionId}
          title={taskTargetActionsDisabled ? disabledReason : undefined}
          onSelect={onCopySessionId}
        >
          {intl.formatMessage({ id: "appHeader.copySessionId" })}
        </Item>
      ) : null}
      {onViewModelTrajectory ? (
        <>
          <Separator />
          {/* Call trajectory: rebuild this task's model requests/responses/tool calls from
              ~/.zcode/cli model-io and visualize them in the side pane. Keys off the taskId
              (the sessionId) only — never off whether a snapshot file exists. */}
          <Item
            disabled={taskTargetActionsDisabled || !activeSessionId}
            title={taskTargetActionsDisabled ? disabledReason : undefined}
            onSelect={onViewModelTrajectory}
          >
            {intl.formatMessage({ id: "taskList.viewModelTrajectory" })}
          </Item>
        </>
      ) : null}
      {onOpenTaskFeedback ? (
        <>
          <Separator />
          <Item disabled={taskTargetActionsDisabled} onSelect={onOpenTaskFeedback}>
            {/* The task menu only offered copy log/path, sending users back to the feedback center
                by hand. Reporting a problem is not a task-management action; the menu footer is
                the right tier for the catch-all help entry. */}
            {intl.formatMessage({ id: "taskList.feedback" })}
          </Item>
        </>
      ) : null}
    </>
  );
}
