// ============================================================
// Shared types for background-stop dispatch
// ============================================================
// Extracted from background.ts for it and the per-RuntimeTaskType stop branches
// (see background-stop-dynamic-workflow.ts). A separate file: branch modules need no
// background.ts import (no cycles) and background.ts stays bounded.
//
// background.ts still re-exports these names, so agent-runtime.ts /
// internal-turn-methods.ts imports stay put.

import type { BackgroundTaskInfo, BackgroundTaskInfoStatus } from "../deps.js";
import type { RuntimeTaskSnapshot, RuntimeTaskType } from "../../runtime-task/registry.js";
import type { TraceContext } from "../deps.js";

export type RuntimeBackgroundStopFailureReason =
  | "background_task_cancel_not_supported"
  | "background_task_not_found"
  | "background_task_not_running";

export type RuntimeBackgroundStopStatus = BackgroundTaskInfoStatus | RuntimeTaskSnapshot["status"];

export type RuntimeBackgroundStopResult =
  | {
      alreadyTerminal?: boolean;
      command?: string;
      ok: true;
      status: RuntimeBackgroundStopStatus;
      taskId: string;
      type: RuntimeTaskType;
    }
  | {
      reason: RuntimeBackgroundStopFailureReason;
      ok: false;
      status?: RuntimeBackgroundStopStatus;
      taskId: string;
      type?: RuntimeTaskType;
    };

/**
 * GUI / background-panel calls via
 * `runtime.cancelBackgroundTask` are `"user"`; the model `TaskStop` is `"model"`; runtime
 * cleanup leaves it unset. The dwf branch records it on the registry entry; the terminal notice tells the model this was the user
 * decision; do not resume it on your own.
 */
export type RuntimeBackgroundStopInitiator = "user" | "model";

export interface RuntimeBackgroundStopOptions {
  initiator?: RuntimeBackgroundStopInitiator;
  strict?: boolean;
  traceContext?: TraceContext;
}

export interface RuntimeBackgroundStopTarget {
  currentStatus: RuntimeBackgroundStopStatus | undefined;
  existing: BackgroundTaskInfo | undefined;
  registryTask: RuntimeTaskSnapshot | undefined;
  taskId: string;
  taskType: RuntimeTaskType | undefined;
}

/** A stop target with resolved taskType; branch modules take this shape only. */
export type TypedRuntimeBackgroundStopTarget = RuntimeBackgroundStopTarget & {
  taskType: RuntimeTaskType;
};
