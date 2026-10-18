import type { ZCodeTaskPersistStatus, ZCodeTaskRuntimeStatus } from "@zcode/shared";

interface TaskRestoreTimestampedMessageLike {
  role: "user" | "assistant";
  timestamp: number;
}

interface ResolveTaskRuntimeStatusAfterRestoreOptions {
  persistedStatus?: ZCodeTaskPersistStatus;
  persistedUpdatedAt?: number;
  latestUserMessageTimestamp?: number | null;
  runtimeMainActive?: boolean;
}

interface ShouldShowTaskConfigLoadingOnSwitchParams {
  previousTaskId: string | null;
  nextTaskId: string | null;
}

export function shouldKeepTaskStreamingDuringRestore(taskStatus: ZCodeTaskRuntimeStatus): boolean {
  // Bugfix: returning to a backgrounded task that is still emitting,
  // the restore path must not reset it to restoring/ready first.
  // Otherwise ChatView reads generation as finished and the thinking animation vanishes on return.
  return taskStatus === "streaming";
}

export function shouldShowTaskConfigLoadingOnSwitch(
  params: ShouldShowTaskConfigLoadingOnSwitchParams,
): boolean {
  const nextTaskId = params.nextTaskId?.trim() ?? "";
  if (!nextTaskId) {
    return false;
  }

  const previousTaskId = params.previousTaskId?.trim() ?? "";
  // Bugfix: reusing the previous task's configOptions during a switch
  // shows the old model until resume/config_option_update corrects it.
  // Enter loading on the taskId-switch test; no stale model echo during the placeholder.
  return previousTaskId !== nextTaskId;
}

export function getLatestTaskUserMessageTimestamp(
  messages: readonly TaskRestoreTimestampedMessageLike[],
): number | null {
  let latestTimestamp: number | null = null;
  for (const message of messages) {
    if (message.role !== "user") {
      continue;
    }
    latestTimestamp =
      latestTimestamp === null ? message.timestamp : Math.max(latestTimestamp, message.timestamp);
  }
  return latestTimestamp;
}

function toTerminalRuntimeStatus(status: ZCodeTaskPersistStatus): ZCodeTaskRuntimeStatus {
  if (status === "running") {
    return "streaming";
  }
  return status === "error" ? "failed" : "completed";
}

export function resolveTaskRuntimeStatusAfterRestore(
  taskStatus: ZCodeTaskRuntimeStatus,
  hasRestoredSession: boolean,
  options?: ResolveTaskRuntimeStatusAfterRestoreOptions,
): ZCodeTaskRuntimeStatus {
  if (!hasRestoredSession) {
    return "notReady";
  }

  const persistedStatus = options?.persistedStatus;
  const persistedUpdatedAt = options?.persistedUpdatedAt;
  const latestUserMessageTimestamp = options?.latestUserMessageTimestamp ?? null;

  if (
    persistedStatus &&
    persistedStatus !== "running" &&
    typeof persistedUpdatedAt === "number" &&
    (latestUserMessageTimestamp === null || persistedUpdatedAt >= latestUserMessageTimestamp)
  ) {
    // Bugfix: on history restore the store may hold a stale streaming state from the previous frame.
    // If the host persisted the turn's true terminal (completed/error) into meta.status,
    // keeping streaming pins the UI on generating forever.
    // Require the persisted terminal to reach at least the latest user message before closing the run state,
    // so a prior completed snapshot never lands on a still-running prompt.
    return toTerminalRuntimeStatus(persistedStatus);
  }

  if (options?.runtimeMainActive === true) {
    // Fix: the mainActive snapshot is the fact that agent/session is still in its main turn.
    // It may restore runtime.status only; the real UI mainActive flag writes once status=streaming.
    return "streaming";
  }

  return shouldKeepTaskStreamingDuringRestore(taskStatus) ? "streaming" : "ready";
}
