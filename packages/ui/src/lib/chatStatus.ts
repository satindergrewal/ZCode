import type { ZCodeTaskRuntimeStatus, ZCodeWorkspaceInitStatus } from "@zcode/shared";

type ChatComposerStatus = "idle" | "submitting" | "streaming" | "error";

export function deriveChatComposerStatusFromTaskRuntime(
  taskStatus: ZCodeTaskRuntimeStatus,
): ChatComposerStatus {
  switch (taskStatus) {
    case "creating":
    case "restoring":
      return "submitting";
    case "streaming":
      return "streaming";
    case "failed":
      return "error";
    default:
      return "idle";
  }
}

export function isChatComposerEditingDisabled(status: ChatComposerStatus) {
  // Bugfix: users must keep drafting the next message while preparing.
  // submitting used to be an edit lock, freezing input for the whole slow create/restore.
  // Editing is now uniformly open; submissionBlocked alone gates re-submitting.
  return false;
}

export function isChatComposerSubmissionBlocked(status: ChatComposerStatus) {
  // Bugfix: the next message may now queue in memory while the previous turn streams.
  // Treating streaming as a submit lock let the UI block button and Enter outright,
  // so the queue never ran. Only the true submitting phase (create/restore/submit RPC) blocks sends.
  return status === "submitting";
}

export function shouldShowChatSubmitSpinner(status: ChatComposerStatus) {
  // Bugfix: re-sending after a failure passes through a resumeTask/re-submit submitting phase.
  // The button kept the send arrow, hiding the loading state.
  // Expose an is-submitting-show-spinner check so ChatView matches the state semantics.
  return status === "submitting";
}

export function isChatTaskRunning(taskStatus: ZCodeTaskRuntimeStatus) {
  // ChatView used to guess thinking from displayedStatus plus last-message role; whenever the
  // message list lagged while the task was creating/restoring/streaming, the shimmer vanished early.
  // Align with the task runtime state directly, sharing one running set with the header status badge.
  return taskStatus === "creating" || taskStatus === "restoring" || taskStatus === "streaming";
}

export function deriveChatTaskStatusForMainActivity(
  taskStatus: ZCodeTaskRuntimeStatus,
  isMainActive: boolean,
): ZCodeTaskRuntimeStatus {
  if (taskStatus === "streaming" && !isMainActive) {
    return "completed";
  }
  return taskStatus;
}

export function canForkFromTaskRuntimeStatus(taskStatus: ZCodeTaskRuntimeStatus) {
  // Product semantics: failed/error partial is no stable history boundary -- do not fork like interrupted/completed.
  // running stays owned by isChatTaskRunning, avoiding a second active-turn check.
  return taskStatus !== "notReady" && taskStatus !== "failed" && !isChatTaskRunning(taskStatus);
}

export function shouldShowChatThinkingShimmer(taskStatus: ZCodeTaskRuntimeStatus) {
  // Bugfix: restoring is session restore only -- thinking has not started.
  // Split task-running from show-thinking-shimmer so restored histories avoid a misleading thinking hint.
  return taskStatus === "creating" || taskStatus === "streaming";
}

export function getChatSubmitLabelId(
  status: ChatComposerStatus,
  workspaceInitStatus: ZCodeWorkspaceInitStatus,
  taskStatus: ZCodeTaskRuntimeStatus,
) {
  if (status !== "submitting") {
    return "chat.send";
  }

  // Bugfix: submitting shows Preparing... uniformly.
  // Preparing and thinking used to be distinct, but after resumeTask the UI should flip straight to streaming's
  // Stop-generation button -- no thinking state belongs in submitting.
  return "chat.preparing";
}
