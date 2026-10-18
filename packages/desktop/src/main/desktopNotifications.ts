import { app, BrowserWindow, Notification } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { TaskNotificationPayload } from "@zcode/shared";
import { formatZodError, PlatformChannels, taskNotificationPayloadSchema } from "@zcode/shared";

const TASK_NOTIFICATION_DEDUPE_WINDOW_MS = 3000;
const MAX_ACTIVE_TASK_NOTIFICATIONS = 100;
const recentTaskNotificationTimestamps = new Map<string, number>();
const activeTaskNotifications = new Set<Notification>();

function isAnyAppWindowFocused() {
  return BrowserWindow.getAllWindows().some(
    (window) => !window.isDestroyed() && window.isFocused(),
  );
}

function shouldSuppressDuplicateTaskNotification(
  taskId: string,
  status: TaskNotificationPayload["status"],
  requestId?: string,
) {
  const now = Date.now();

  for (const [key, timestamp] of recentTaskNotificationTimestamps) {
    if (now - timestamp > TASK_NOTIFICATION_DEDUPE_WINDOW_MS) {
      recentTaskNotificationTimestamps.delete(key);
    }
  }

  // elicitation_request, like permission_request, is a concrete human-in-the-loop block;
  // task-id dedup would drop the second of back-to-back AskUserQuestion/plan confirmations.
  const dedupeTarget =
    status === "permission_request" || status === "elicitation_request"
      ? requestId?.trim() || taskId
      : taskId;
  const dedupeKey = `${status}:${dedupeTarget}`;
  const lastTimestamp = recentTaskNotificationTimestamps.get(dedupeKey);
  if (lastTimestamp != null && now - lastTimestamp < TASK_NOTIFICATION_DEDUPE_WINDOW_MS) {
    return true;
  }

  recentTaskNotificationTimestamps.set(dedupeKey, now);
  return false;
}

function retainTaskNotification(notification: Notification) {
  activeTaskNotifications.add(notification);

  if (activeTaskNotifications.size <= MAX_ACTIVE_TASK_NOTIFICATIONS) {
    return;
  }

  const oldestNotification = activeTaskNotifications.values().next().value;
  if (oldestNotification) {
    activeTaskNotifications.delete(oldestNotification);
  }
}

function releaseTaskNotification(notification: Notification) {
  activeTaskNotifications.delete(notification);
}

function focusTaskNotificationWindow(senderWindow: BrowserWindow) {
  if (senderWindow.isMinimized()) {
    senderWindow.restore();
  }

  if (!senderWindow.isVisible()) {
    senderWindow.show();
  }

  // macOS notification click with a hidden/minimized window: restore window, activate app, then focus
  // the BrowserWindow -- else app.focus wins foreground with no visible window and focus is ignored.
  if (process.platform === "darwin") {
    app.dock?.show();
    app.show();
    app.focus({ steal: true });
  }

  senderWindow.focus();
}

export function dispatchTaskNotification(options: {
  event: IpcMainEvent | IpcMainInvokeEvent;
  payload: unknown;
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
}): boolean {
  const result = taskNotificationPayloadSchema.safeParse(options.payload);
  if (!result.success) {
    options.logger.warn("[show-task-notification] invalid payload:", formatZodError(result.error));
    return false;
  }

  if (!Notification.isSupported()) {
    options.logger.warn("[show-task-notification] notification is not supported on this platform");
    return false;
  }

  if (isAnyAppWindowFocused()) {
    return false;
  }

  const { taskId, status, requestId, title, body } = result.data;
  const notificationTitle = title.trim();
  const notificationBody = body.trim();
  if (!notificationTitle || !notificationBody) {
    // Main has no renderer locale context and must not fabricate localized copy here.
    // Copy is renderer-i18n-generated; without it, refuse to show rather than hardcode a wrong language.
    options.logger.warn("[show-task-notification] missing localized notification copy", {
      taskId,
      status,
      hasTitle: Boolean(notificationTitle),
      hasBody: Boolean(notificationBody),
    });
    return false;
  }

  if (shouldSuppressDuplicateTaskNotification(taskId, status, requestId)) {
    return false;
  }

  const senderWindow = BrowserWindow.fromWebContents(options.event.sender);
  const notification = new Notification({
    title: notificationTitle,
    body: notificationBody,
    silent: true,
  });

  // A Notification held only in a local still displays, but main's JS object can be GC'd before the
  // click, losing the listener. Hold it explicitly and release on click/close so exists and clickable
  // share one lifetime.
  retainTaskNotification(notification);

  notification.once("click", () => {
    releaseTaskNotification(notification);

    if (!senderWindow || senderWindow.isDestroyed()) {
      options.logger.warn("[show-task-notification] click ignored: sender window is gone", {
        taskId,
      });
      return;
    }

    focusTaskNotificationWindow(senderWindow);
    senderWindow.webContents.send(PlatformChannels.TaskNotificationClick, taskId);
    options.logger.info("[show-task-notification] notification click handled", {
      taskId,
      windowId: senderWindow.id,
    });
  });
  notification.once("close", () => {
    releaseTaskNotification(notification);
  });

  notification.show();
  options.event.sender.send(PlatformChannels.TaskNotificationSound);
  return true;
}
