import { createMessageId, traceContextToLogContext } from "../deps.js";
import type { TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ActiveTurnSteeringState } from "../types.js";

export async function recordGoalStateChangeReminder(
  this: AgentRuntimeInternal,
  input: {
    text: string;
    traceContext?: TraceContext;
  },
): Promise<void> {
  const traceContext = input.traceContext ?? this.rootTraceContext;
  const activeTurn = this.activeTurn;
  if (
    activeTurn?.kind === "regular" &&
    activeTurn.goalStateChangeReminderDeferralOpen
  ) {
    // Stop pauses the goal, then aborts running tools; writing history here at once would
    // drop the reminder between tool_use and cancelled tool_result, breaking provider grammar next request.
    activeTurn.pendingGoalStateChangeReminder = { text: input.text };
    return;
  }
  await materializeGoalStateChangeReminder.call(this, input.text, traceContext);
}

export function openGoalStateChangeReminderDeferral(
  activeTurn: ActiveTurnSteeringState | undefined,
): void {
  if (activeTurn?.kind === "regular") {
    activeTurn.goalStateChangeReminderDeferralOpen = true;
  }
}

export async function closeGoalStateChangeReminderDeferral(
  this: AgentRuntimeInternal,
  activeTurn: ActiveTurnSteeringState | undefined,
  traceContext: TraceContext,
): Promise<void> {
  if (activeTurn?.kind !== "regular") return;

  // activeTurn lives past terminal/accounting; its presence no longer proves
  // pending ownership. Close synchronously; later reminders materialize directly.
  activeTurn.goalStateChangeReminderDeferralOpen = false;
  const pending = activeTurn.pendingGoalStateChangeReminder;
  if (!pending) return;

  activeTurn.pendingGoalStateChangeReminder = undefined;
  try {
    await materializeGoalStateChangeReminder.call(this, pending.text, traceContext);
  } catch (error) {
    // The authoritative target persisted; a reminder-persist failure must not block the Stop terminal event.
    // Single materialization; no retry, cursor or persistence state machine at turn end.
    this.logger?.warn("Failed to materialize pending goal state reminder", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.reminder.materialize.failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

async function materializeGoalStateChangeReminder(
  this: AgentRuntimeInternal,
  text: string,
  traceContext: TraceContext,
): Promise<void> {
  await this.ensureContextInitialized(traceContext);
  this.messageHistory.addAttachment("goal_state_change", text);
  await this.persistSyntheticUserNoticeForSession({
    messageID: createMessageId(),
    sessionId: this.sessionId,
    source: "goal_state_change",
    text,
    traceContext,
    visibility: "model-only",
  });
}
