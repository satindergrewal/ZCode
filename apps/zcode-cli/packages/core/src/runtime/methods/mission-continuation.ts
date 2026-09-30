// ============================================================
// Mission continuation — task-list-driven autonomous continuation
// ============================================================
// Semantics (docs/specs/goal-continuation-mission-hardening.md):
// when enabled (Desktop setting -> Host env -> Agent env, or exported
// ZCODE_MISSION_CONTINUATION=1 for standalone CLI), a turn never "ends" while the
// session task list still has open items: the loop re-issues model-only
// continuation turns carrying the FULL authoritative list until every item is
// completed, the user queues input / hits Stop, or the no-progress cap trips.

import { traceContextToLogContext } from "../deps.js";
import type { TodoItem } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { TurnResult } from "../types.js";
import { wrapSystemReminderForSource } from "../../system-reminder/source.js";

const DEFAULT_IDLE_CONTINUATION_CAP = 100;

export function isMissionContinuationEnabled(runtime: AgentRuntimeInternal): boolean {
  if (runtime.config.missionContinuation?.enabled === true) return true;
  return process.env.ZCODE_MISSION_CONTINUATION === "1";
}

export function formatMissionContinuationPrompt(input: {
  open: readonly TodoItem[];
  total: number;
}): string {
  const list = input.open
    .map((todo, index) => `${index + 1}. [${todo.status}][${todo.priority}] ${todo.content}`)
    .join("\n");
  return [
    "Mission continuation: the session task list still has open items. Continue working",
    `through them now (${input.open.length} of ${input.total} open). Do not end the turn with a`,
    "status report while open items remain.",
    "",
    "Rules:",
    "- The list below is the authoritative FULL task list. Never remove or shrink it;",
    "  newly discovered work becomes new list items via TodoWrite.",
    "- If an item is genuinely blocked by something only the user can resolve, mark it in",
    "  the list, state the blocker in one line, and continue with everything else.",
    "- Shortcutting, minimal-effort stubs, or dropping items count as not done.",
    "",
    "<open_tasks>",
    list,
    "</open_tasks>",
  ].join("\n");
}

function todoListChanged(before: readonly TodoItem[], after: readonly TodoItem[]): boolean {
  if (before.length !== after.length) return true;
  return before.some((todo, index) => {
    const next = after[index];
    return (
      !next ||
      next.status !== todo.status ||
      next.content !== todo.content ||
      next.priority !== todo.priority
    );
  });
}

export async function runMissionContinuationLoop(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    inputId?: string;
    traceContext?: import("../deps.js").TraceContext;
  },
): Promise<TurnResult | null> {
  if (!isMissionContinuationEnabled(this)) return null;
  if (this.getPlanEnabled()) return null;
  if (!this.sessionStore || !this.sessionPersisted) return null;

  const traceContext = options.traceContext ?? this.rootTraceContext;
  const cap = Math.max(
    1,
    this.config.missionContinuation?.idleContinuationCap ?? DEFAULT_IDLE_CONTINUATION_CAP,
  );
  let idleStreak = 0;
  let lastResult: TurnResult | null = null;
  // Yield to anything the user queued before firing the first continuation.
  let yieldToPendingCommands = true;

  while (!options.abortSignal?.aborted) {
    if (yieldToPendingCommands && this.runtimeCommandQueue.hasPending()) {
      return lastResult;
    }
    if (this.activeTurn || this.activeTurnStartReservation) {
      return lastResult;
    }

    const todos = await this.readSessionTodosForContext(traceContext);
    const open = todos.filter((todo) => todo.status !== "completed");
    if (open.length === 0) {
      return lastResult;
    }
    if (idleStreak >= cap) {
      this.logger?.warn(
        "Mission continuation stopped after repeated no-progress continuations",
        {
          ...traceContextToLogContext(traceContext),
          event: "mission.continuation.idle_cap_reached",
          module: "core.runtime",
          idleStreak,
          idleContinuationCap: cap,
          openTasks: open.length,
        },
      );
      return lastResult;
    }

    this.logger?.info("Mission continuation started", {
      ...traceContextToLogContext(traceContext),
      event: "mission.continuation.started",
      module: "core.runtime",
      status: "started",
      openTasks: open.length,
      totalTasks: todos.length,
      idleStreak,
    });

    const prompt = wrapSystemReminderForSource(
      "mission_continuation",
      formatMissionContinuationPrompt({ open, total: todos.length }),
    );
    const result = await this.executeTurnCommand(prompt, undefined, {
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
      ...(options.inputId !== undefined ? { inputId: options.inputId } : {}),
      inputSource: "mission-continuation",
      inputVisibility: "model-only",
      traceContext,
    });
    lastResult = result;
    yieldToPendingCommands = true;

    const todosAfter = await this.readSessionTodosForContext(traceContext);
    if (todoListChanged(todos, todosAfter)) {
      idleStreak = 0;
    } else {
      idleStreak += 1;
    }
  }

  return lastResult;
}
