import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import type { MessageId } from "../deps.js";
import type { RuntimeCommandId } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  persistBackgroundTaskNotificationCommand,
  shouldSuppressTaskNotificationRuntimeCommand,
} from "./background-notifications.js";
import { persistSubagentMessageCommand } from "./subagent-messages.js";
import { isStaleBranchRuntimeCommand } from "./runtime-command-generation.js";
import { createRuntimeUserEntry, type RuntimeMessageEntry } from "../../agent/message-history.js";

interface ActiveLoopRuntimeCommandDrainResult {
  backgroundSubagentResultConsumed: boolean;
  workflowResultConsumed: boolean;
  consumedCommandIds: RuntimeCommandId[];
  drained: number;
  messageIds: MessageId[];
  runtimeEntries: readonly RuntimeMessageEntry[];
}

export async function drainPendingRuntimeCommandsForActiveLoop(
  this: AgentRuntimeInternal,
): Promise<ActiveLoopRuntimeCommandDrainResult> {
  const commands = this.runtimeCommandQueue.getByMaxPriority("next");
  const consumedCommandIds: RuntimeCommandId[] = [];
  let backgroundSubagentResultConsumed = false;
  let workflowResultConsumed = false;
  const messageIds: MessageId[] = [];
  const runtimeEntries: RuntimeMessageEntry[] = [];

  for (const command of commands) {
    // A queued controlOnly turn (the GUI settings turn) never enters the active turn, and later-enqueued notices must not be
    // absorbed first: they describe the run it just recorded; the model reads settings-changed-plus-which-run,
    // before that run progress. Stop here;
    // the outer queue takes the rest in order.
    if (command.mode === "control-only-turn") break;
    if (command.mode !== "task-notification" && command.mode !== "subagent-message") {
      continue;
    }
    const removed = this.runtimeCommandQueue.removeById(command.id);
    if (!removed) continue;
    if (isStaleBranchRuntimeCommand(this, removed)) continue;

    let messageId: MessageId;
    if (removed.mode === "task-notification") {
      if (shouldSuppressTaskNotificationRuntimeCommand.call(this, removed)) {
        continue;
      }
      messageId = await persistBackgroundTaskNotificationCommand.call(this, removed);
    } else if (removed.mode === "subagent-message") {
      messageId = await persistSubagentMessageCommand.call(this, removed, true);
    } else {
      continue;
    }

    consumedCommandIds.push(removed.id);
    // No new TurnStarted here; carry consumed facts to this turn terminal, structured subagent sources only, no Bash.
    if (
      removed.mode === "task-notification" &&
      removed.originMeta?.backgroundSource === "subagent"
    ) {
      backgroundSubagentResultConsumed = true;
    }
    if (
      removed.mode === "task-notification" &&
      removed.originMeta?.backgroundSource === "workflow"
    ) {
      workflowResultConsumed = true;
    }
    messageIds.push(messageId);
    runtimeEntries.push(
      createRuntimeUserEntry(
        removed.text,
        runtimeInputMetadata(
          removed.mode === "task-notification" ? "task_notification_steer" : "subagent_reply_steer",
        ),
      ),
    );
  }

  return {
    backgroundSubagentResultConsumed,
    workflowResultConsumed,
    consumedCommandIds,
    drained: consumedCommandIds.length,
    messageIds,
    runtimeEntries,
  };
}
