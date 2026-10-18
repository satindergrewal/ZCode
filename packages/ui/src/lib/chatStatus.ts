import type { ZCodeTaskRuntimeStatus } from "@zcode/shared";

export function isChatTaskRunning(taskStatus: ZCodeTaskRuntimeStatus) {
  // ChatView used to guess thinking from displayedStatus plus last-message role; whenever the
  // message list lagged while the task was creating/restoring/streaming, the shimmer vanished early.
  // Align with the task runtime state directly, sharing one running set with the header status badge.
  return taskStatus === "creating" || taskStatus === "restoring" || taskStatus === "streaming";
}
