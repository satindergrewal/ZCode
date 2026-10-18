import type { ZCodeTaskMode } from "./zcode-task-types-core.js";
import type { ZCodeAutomationBotDeliveryTarget } from "./bots.js";
import type { ModelSelection } from "./model-selection.js";

// ---- Scheduled-task (automation) domain types ----
// automation / automation_runs live in tasks-index.sqlite.
// Cross services/cli/desktop/ui camelCase domain types; sqlite columns are snake_case.

/** Total scheduled-task definitions one local task index may retain; every lifecycle state counts. */
export const AUTOMATION_CREATE_LIMIT = 20;
export const AUTOMATION_CREATE_LIMIT_ERROR_CODE = "AUTOMATION_CREATE_LIMIT_REACHED";

export function isAutomationCreateLimitError(error: unknown): boolean {
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return message.includes(AUTOMATION_CREATE_LIMIT_ERROR_CODE);
}

/** Lifecycle of a whole automation. */
export type ZCodeAutomationLifecycleStatus = "active" | "completed" | "failed" | "paused";

/** Per-round dispatch info state of one automation (UI/diagnostics). */
export type ZCodeAutomationDispatchStatus =
  | "idle"
  | "claimed"
  | "dispatched"
  | "failed_to_dispatch";

/** Workspace location; always local this phase, remote reserved. */
export type ZCodeAutomationLocationKind = "local" | "remote";

/** Trigger source: scheduled or run-now. */
export type ZCodeAutomationTrigger = "schedule" | "manual";

/** Custom recurrence; cronExpr kept for compat display, this field is the scheduling authority. */
export interface ZCodeAutomationScheduleRule {
  unit: "minute" | "hourly" | "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  hour: number;
  minute: number;
  anchorAt: number;
  weekdays?: number[];
  monthDays?: number[];
  /// For yearly: 1-12 human months. Defaults to anchorAt's month (legacy rows without the field).
  months?: number[];
  monthlyMode?: "date" | "weekday";
}

/**
 * Unit enum of the session-side long-interval carrier. Same set as scheduleRule.unit, but the carrier is a controlled
 * input (the model never writes a full scheduleRule); the service layer normalizes it into the authoritative rule.
 */
export type ZCodeAutomationIntervalUnit = ZCodeAutomationScheduleRule["unit"];

/** Dispatch result of one run (scheduler-authoritative, drives retries). skipped = missed the window. */
export type ZCodeAutomationRunDispatchStatus =
  | "claimed"
  | "dispatched"
  | "failed_to_dispatch"
  | "skipped";

/** Run outcome after the run produced a session (written back by the session runtime, display only). */
export type ZCodeAutomationRunOutcome = "running" | "succeeded" | "failed" | "stopped";

/** One scheduled-task definition plus scheduling state. */
export interface ZCodeAutomation {
  automationId: string;
  title: string;
  /// 5-field cron, local timezone.
  cronExpr: string;
  prompt: string;
  /// Absent = the Select stage keeps following the Workspace preference; present pins the structured model intent.
  modelSelection?: ModelSelection;
  /// Permission mode, passed to createTask at dispatch; defaults to the workspace's.
  mode?: ZCodeTaskMode;
  /** workspaceIdentity?.trim() || workspacePath */
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  /// An in-session cron binds to the current task; later triggers deliver there, no new sessions.
  targetTaskId?: string;
  locationKind: ZCodeAutomationLocationKind;
  /// true = infinite; false = finite (with maxRuns).
  recurring: boolean;
  maxRuns?: number;
  /// Custom recurrence end (end of the locally chosen day, millis).
  endAt?: number;
  scheduleRule?: ZCodeAutomationScheduleRule;
  /// Whether a session-sourced schedule was explicitly deleted and reset in the manage page.
  scheduleEditedByUser?: boolean;
  runCount: number;
  enabled: boolean;
  lifecycleStatus: ZCodeAutomationLifecycleStatus;
  nextRunAt?: number;
  lastRunAt?: number;
  dispatchStatus: ZCodeAutomationDispatchStatus;
  dispatchAttempts: number;
  retryAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

/** parseAutomationRunId's result; scheduledAt exists only for schedule triggers. */
export interface ZCodeAutomationRunIdParts {
  automationId: string;
  trigger: ZCodeAutomationTrigger;
  /// The theoretical trigger time embedded in the runId (Unix millis).
  scheduledAt?: number;
}

/**
 * The only parser of the runId contract (see ZCodeAutomationRun.runId); desktop host/scheduler and
 * CLI telemetry never guess the format from strings. Anything outside the two declared shapes returns null.
 */
export function parseAutomationRunId(runId: string): ZCodeAutomationRunIdParts | null {
  const separatorIndex = runId.indexOf(":");
  if (separatorIndex <= 0) return null;
  const automationId = runId.slice(0, separatorIndex);
  const rest = runId.slice(separatorIndex + 1);
  if (rest.startsWith("manual:")) {
    return rest.length > "manual:".length ? { automationId, trigger: "manual" } : null;
  }
  const scheduledAt = Number(rest);
  if (!Number.isSafeInteger(scheduledAt) || scheduledAt <= 0) return null;
  return { automationId, trigger: "schedule", scheduledAt };
}

/** One trigger's run history / runId idempotence ledger. */
export interface ZCodeAutomationRun {
  /** automationId:scheduledAt / automationId:manual:uuid */
  runId: string;
  automationId: string;
  workspaceKey: string;
  scheduledAt?: number;
  trigger: ZCodeAutomationTrigger;
  /// Fixed at Select->Submission; a run's dispatch retries never re-read the Workspace preference.
  modelSelection?: ModelSelection;
  dispatchStatus: ZCodeAutomationRunDispatchStatus;
  outcome?: ZCodeAutomationRunOutcome;
  /// Backfilled on successful dispatch, for history jump.
  sessionId?: string;
  error?: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
}

/** create-inputs of an automation (workspace injected by the caller from session context). */
export interface ZCodeAutomationCreateParams {
  title: string;
  cronExpr: string;
  /// Creation-time only: the service layer converts from real now into cronExpr; never persisted.
  relativeDelayMinutes?: number;
  prompt: string;
  modelSelection?: ModelSelection;
  mode?: ZCodeTaskMode;
  workspacePath: string;
  workspaceIdentity?: string;
  /// Injected by the runtime on in-session creation; not model-controlled.
  targetTaskId?: string;
  /// Injected by the Host on bot-session creation; scheduler terminal callback only, never the UI model.
  botDeliveryTarget?: ZCodeAutomationBotDeliveryTarget;
  recurring: boolean;
  maxRuns?: number;
  endAt?: number;
  scheduleRule?: ZCodeAutomationScheduleRule;
  /**
   * Session-side custom-recurrence carrier. Every N minutes/hours/days/weeks/months/years pairs intervalUnit + interval;
   * the service layer normalizes into the authoritative scheduleRule; cronExpr is legal compat display only.
   * Mutually exclusive with scheduleRule and relativeDelayMinutes. undefined = carrier unused.
   */
  intervalUnit?: ZCodeAutomationIntervalUnit;
  /// Integer interval 1-200, always paired with intervalUnit.
  interval?: number;
}

/** Mutable fields for editing an automation. */
export interface ZCodeAutomationUpdateParams {
  title?: string;
  cronExpr?: string;
  prompt?: string;
  /// undefined = no change; null = clear, back to the Workspace preference.
  modelSelection?: ModelSelection | null;
  /// undefined = no change; null = clear, back to the workspace default permission mode.
  mode?: ZCodeTaskMode | null;
  recurring?: boolean;
  /// undefined = usually no change; recurring=true auto-clears the old cap; explicit null requires recurring=true too.
  maxRuns?: number | null;
  /// undefined = no change; null = never ends.
  endAt?: number | null;
  /// undefined = no change; null = back to a plain cron.
  scheduleRule?: ZCodeAutomationScheduleRule | null;
  /**
   * Session-side custom-recurrence carrier (as on create). Pairs intervalUnit + interval; the service layer
   * normalizes into the authoritative scheduleRule (anchorAt reset to this edit). undefined = no change.
   */
  intervalUnit?: ZCodeAutomationIntervalUnit;
  /// Integer interval 1-200, always paired with intervalUnit.
  interval?: number;
  /// Written by the manage page only on real schedule edits; undefined = keep the provenance state.
  scheduleEditedByUser?: boolean;
}
