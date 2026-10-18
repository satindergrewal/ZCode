import { createMessageId, traceContextToLogContext } from "../deps.js";
import type { MessageId, TraceContext } from "../deps.js";
import type { BackgroundResultOriginMeta } from "@zcode/contracts";
import { createRuntimeCommandId, type TaskNotificationRuntimeCommand } from "../command-queue.js";
import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { SealBackgroundTaskNotificationsInput } from "../types.js";
import { shouldSuppressSealedSubagentBashNotification } from "../../runtime-task/notification-policy.js";

export function enqueueBackgroundTaskNotification(
  this: AgentRuntimeInternal,
  notification: {
    originMeta?: BackgroundResultOriginMeta;
    taskId?: string;
    text: string;
    toolName?: string;
    traceContext: TraceContext;
  },
): void {
  if (this.shuttingDown) {
    // Guarding the direct-call path: in session teardown only task settle runs, no new model rounds.
    this.logger?.info?.("Dropped background task notification during runtime shutdown", {
      ...traceContextToLogContext(notification.traceContext),
      event: "runtime.background_task_notification.shutdown_dropped",
      module: "core.runtime",
      taskId: notification.taskId,
      toolName: notification.toolName,
    });
    return;
  }
  const task = notification.taskId ? this.runtimeTaskRegistry.get(notification.taskId) : undefined;
  const branchGeneration = task?.branchGeneration ?? this.branchGeneration;
  if (branchGeneration !== this.branchGeneration) {
    this.logger?.debug("Dropped stale-branch background task notification", {
      ...traceContextToLogContext(notification.traceContext),
      branchGeneration,
      currentBranchGeneration: this.branchGeneration,
      event: "runtime.background_task_notification.stale_branch_dropped",
      module: "core.runtime",
      taskId: notification.taskId,
    });
    return;
  }
  const commandId = createRuntimeCommandId();
  this.enqueueRuntimeCommand({
    branchGeneration,
    createdAt: new Date(),
    id: commandId,
    mode: "task-notification",
    priority: "next",
    source: "background_task",
    originMeta: notification.originMeta,
    taskId: notification.taskId,
    text: notification.text,
    toolName: notification.toolName,
    traceContext: notification.traceContext,
  });
  // Wake enters the ledger (admitted). The command queue is pure memory; the ledger is the only
  // durable trace — after a crash the child is dead, notices unrecoverable; resume settles leftover
  // admitted to discarded(session_resumed) (on the record, not silent; same meaning).
  const admission = this.sessionStore?.saveSessionInput?.({
    id: String(commandId),
    sessionID: this.sessionId,
    kind: "backgroundNotification",
    delivery: "queue",
    payload: {
      text: notification.text,
      ...(notification.taskId ? { taskId: notification.taskId } : {}),
      ...(notification.originMeta ? { originMeta: notification.originMeta } : {}),
    },
  });
  if (admission) {
    void this.trackResidencyBlockingWork(admission).catch((error) => {
      this.logger?.warn("Failed to admit background notification to ledger", {
        ...traceContextToLogContext(notification.traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session_input.admit_failed",
        module: "core.runtime",
        status: "failed",
      });
    });
  }
}

export function sealBackgroundTaskNotifications(
  this: AgentRuntimeInternal,
  input: SealBackgroundTaskNotificationsInput,
): void {
  if (this.config.taskType !== "subagent_child") return;
  this.backgroundTaskNotificationsSealed = true;
  this.backgroundTaskNotificationSealReason = input.reason;
  this.logger?.info?.("Subagent runtime background task notifications sealed", {
    ...traceContextToLogContext(input.traceContext ?? this.rootTraceContext),
    event: "runtime.background_task_notifications.sealed",
    module: "core.runtime",
    reason: input.reason,
  });
}

export async function persistBackgroundTaskNotificationCommand(
  this: AgentRuntimeInternal,
  command: TaskNotificationRuntimeCommand,
): Promise<MessageId> {
  const persisted = await persistBackgroundTaskNotificationBatch.call(this, [command], true);
  return persisted.messageId;
}

export interface PersistedBackgroundTaskNotificationBatch {
  /** Present only when the batch shares one source; mixed/missing is not inferable from a representative. */
  backgroundSource?: BackgroundResultOriginMeta["backgroundSource"];
  messageId: MessageId;
  originMeta?: BackgroundResultOriginMeta;
  text: string;
}

const MAX_BACKGROUND_RESULT_TITLES = 3;

function resolveBackgroundTaskNotificationSource(
  commands: readonly [TaskNotificationRuntimeCommand, ...TaskNotificationRuntimeCommand[]],
): BackgroundResultOriginMeta["backgroundSource"] | undefined {
  const source = commands[0].originMeta?.backgroundSource;
  if (!source || commands.some((command) => command.originMeta?.backgroundSource !== source)) {
    // Display metadata keeps the representative; the first item is not the batch cause;
    // mixed/missing stay empty so arrival order cannot change message_source.
    return undefined;
  }
  return source;
}

export function resolveBackgroundTaskNotificationOriginMeta(
  commands: readonly [TaskNotificationRuntimeCommand, ...TaskNotificationRuntimeCommand[]],
): BackgroundResultOriginMeta | undefined {
  // Single: pass originMeta through; the workflowNotification payload rides along (the only manifest source).
  if (commands.length === 1) return commands[0].originMeta;

  const originMetas: BackgroundResultOriginMeta[] = [];
  for (const command of commands) {
    const originMeta = command.originMeta;
    if (!originMeta?.workId.trim() || !originMeta.title.trim()) return undefined;
    originMetas.push(originMeta);
  }

  const representative = originMetas[0];
  if (!representative) return undefined;
  const visibleTitles = originMetas
    .slice(0, MAX_BACKGROUND_RESULT_TITLES)
    .map((originMeta) => originMeta.title.trim());
  const remainingCount = originMetas.length - visibleTitles.length;
  const title = [...visibleTitles, ...(remainingCount > 0 ? [`+${remainingCount}`] : [])].join(
    " · ",
  );

  // Notifications sharing one turn: dropping originMeta would degrade the results to
  // plain assistant rendering. Reuse the first task display anchor, synthesize title only, no batch schema.
  //
  // The workflowNotification payload is **not synthesized**: manifest maps one-turn-one-card, false in batches — faking the first
  // would be worse than a bare title row. Keep the three base fields {backgroundSource, title, workId};
  // the round falls back to the current title row.
  return {
    backgroundSource: representative.backgroundSource,
    title,
    workId: representative.workId,
  };
}

export async function persistBackgroundTaskNotificationBatch(
  this: AgentRuntimeInternal,
  commands: readonly [TaskNotificationRuntimeCommand, ...TaskNotificationRuntimeCommand[]],
  midTurn = false,
): Promise<PersistedBackgroundTaskNotificationBatch> {
  const firstCommand = commands[0];
  const backgroundSource = resolveBackgroundTaskNotificationSource(commands);
  const originMeta = resolveBackgroundTaskNotificationOriginMeta(commands);
  const text = commands.map((command) => command.text).join("\n\n");
  await this.ensureContextInitialized(firstCommand.traceContext);
  const messageID = createMessageId();
  const inputPresentation = midTurn ? "task_notification_steer" : "task_notification";
  this.messageHistory.addUser(text, runtimeInputMetadata(inputPresentation));
  await this.persistSyntheticUserNoticeForSession({
    messageID,
    metadata: {
      inputPresentation,
      ...(originMeta ? { originMeta } : {}),
      visibility: "model-only",
    },
    sessionId: this.sessionId,
    source: "background_task",
    text,
    traceContext: firstCommand.traceContext,
    visibility: "model-only",
  });
  // The old outer drain persisted and started a round per notice; pending count scaled request count linearly.
  // One synthetic message per batch; ledger identities still settle per item.
  for (const command of commands) {
    await this.sessionStore
      ?.markSessionInputPromoted?.({
        id: String(command.id),
        sessionID: this.sessionId,
        promotedMessageID: messageID,
      })
      .catch((error) => {
        this.logger?.warn("Failed to mark background notification promoted", {
          ...traceContextToLogContext(command.traceContext),
          commandId: command.id,
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "session_input.promote_mark_failed",
          module: "core.runtime",
          status: "failed",
        });
      });
  }
  return {
    ...(backgroundSource ? { backgroundSource } : {}),
    messageId: messageID,
    ...(originMeta ? { originMeta } : {}),
    text,
  };
}

export function shouldSuppressTaskNotificationRuntimeCommand(
  this: AgentRuntimeInternal,
  command: TaskNotificationRuntimeCommand,
): boolean {
  const registryTask = command.taskId ? this.runtimeTaskRegistry.get(command.taskId) : undefined;
  if (
    !shouldSuppressSealedSubagentBashNotification({
      isSubagentChildRuntime: this.config.taskType === "subagent_child",
      notificationSealed: this.backgroundTaskNotificationsSealed,
      registryTask,
      toolName: command.toolName,
    })
  ) {
    return false;
  }

  this.logger?.info?.("Suppressed sealed subagent background Bash notification", {
    ...traceContextToLogContext(command.traceContext),
    commandId: command.id,
    event: "runtime.background_task_notification.suppressed",
    module: "core.runtime",
    reason: this.backgroundTaskNotificationSealReason,
    taskId: command.taskId,
    toolName: command.toolName,
  });
  return true;
}
