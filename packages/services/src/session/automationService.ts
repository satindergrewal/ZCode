import type {
  ZCodeAutomation,
  ZCodeAutomationCreateParams,
  ZCodeAutomationRun,
  ZCodeAutomationScheduleRule,
  ZCodeAutomationUpdateParams,
} from "@zcode/shared";
import { resolveWorkspaceKey } from "@zcode/shared";
import { AutomationRepo } from "#src/session/automationRepo.js";
import {
  assertValidAutomationIntervalCarrier,
  forceIntervalCarrierRecurring,
} from "#src/session/automationIntervalCarrier.js";
export { InvalidAutomationIntervalCarrierError } from "#src/session/automationIntervalCarrier.js";
import {
  buildIntervalScheduleRule,
  buildRelativeDelaySchedule,
  computeInitialAutomationNextRunAt,
  computeAutomationNextRunAt,
  inferMinuteIntervalScheduleRule,
  isValidCronExpr,
  scheduleRuleDefinition,
} from "#src/session/automationCron.js";

/** Workspace ownership for writes/single reads; used for cross-workspace isolation checks. */
export interface AutomationWorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
}

/** scope -> workspaceKey; returns undefined when absent (no ownership filter, for scheduler/host cross-workspace use). */
function resolveScopeKey(scope?: AutomationWorkspaceScope): string | undefined {
  if (!scope?.workspacePath) return undefined;
  return resolveWorkspaceKey({
    workspacePath: scope.workspacePath,
    workspaceIdentity: scope.workspaceIdentity,
  });
}

/** Invalid cron expression error (surfaces a displayable message to the UI). */
export class InvalidCronExprError extends Error {
  constructor(cronExpr: string) {
    super(`Invalid cron expression: ${cronExpr}`);
    this.name = "InvalidCronExprError";
  }
}

/** Invalid finite-runs update error; guards against contradictory writes that would end a still-running task. */
export class InvalidAutomationMaxRunsUpdateError extends Error {
  constructor(message = "Clearing maxRuns requires recurring=true in the same update") {
    super(message);
    this.name = "InvalidAutomationMaxRunsUpdateError";
  }
}

/** Invalid custom schedule rule; rules must pass domain validation before entering the task store. */
export class InvalidAutomationScheduleRuleError extends Error {
  constructor(message: string) {
    super(`Invalid schedule rule: ${message}`);
    this.name = "InvalidAutomationScheduleRuleError";
  }
}

/** Relative delays apply to one-shot tasks only; the schedule rule is built from the server's real clock. */
export class InvalidAutomationRelativeDelayError extends Error {
  constructor(message: string) {
    super(`Invalid relative-delay task: ${message}`);
    this.name = "InvalidAutomationRelativeDelayError";
  }
}

const MAX_MONTHLY_AUTOMATION_SCHEDULE_INTERVAL = 1_200;
const AUTOMATION_SCHEDULE_RULE_UNITS = new Set([
  "minute",
  "hourly",
  "daily",
  "weekly",
  "monthly",
  "yearly",
]);

function hasOnlyIntegersInRange(values: number[] | undefined, min: number, max: number): boolean {
  return Boolean(
    values?.length &&
    values.every((value) => Number.isInteger(value) && value >= min && value <= max),
  );
}

function assertValidAutomationScheduleRule(rule: ZCodeAutomationScheduleRule): void {
  if (!AUTOMATION_SCHEDULE_RULE_UNITS.has(rule.unit)) {
    throw new InvalidAutomationScheduleRuleError("Unsupported unit");
  }
  if (!Number.isInteger(rule.interval) || rule.interval < 1) {
    throw new InvalidAutomationScheduleRuleError("interval must be a positive integer");
  }
  if (rule.unit === "monthly" && rule.interval > MAX_MONTHLY_AUTOMATION_SCHEDULE_INTERVAL) {
    throw new InvalidAutomationScheduleRuleError(
      `monthly interval cannot exceed ${MAX_MONTHLY_AUTOMATION_SCHEDULE_INTERVAL}`,
    );
  }
  if (!Number.isInteger(rule.hour) || rule.hour < 0 || rule.hour > 23) {
    throw new InvalidAutomationScheduleRuleError("hour must be an integer 0-23");
  }
  if (!Number.isInteger(rule.minute) || rule.minute < 0 || rule.minute > 59) {
    throw new InvalidAutomationScheduleRuleError("minute must be an integer 0-59");
  }
  if (
    rule.monthlyMode !== undefined &&
    rule.monthlyMode !== "date" &&
    rule.monthlyMode !== "weekday"
  ) {
    throw new InvalidAutomationScheduleRuleError("Unsupported monthlyMode");
  }
  if (rule.weekdays && !hasOnlyIntegersInRange(rule.weekdays, 0, 6)) {
    throw new InvalidAutomationScheduleRuleError("weekdays must be a non-empty 0-6 integer array");
  }
  if (rule.unit === "weekly" && !hasOnlyIntegersInRange(rule.weekdays, 0, 6)) {
    throw new InvalidAutomationScheduleRuleError("weekly rules need valid weekdays");
  }
  if (rule.unit === "monthly") {
    if (rule.monthlyMode === "weekday" && !hasOnlyIntegersInRange(rule.weekdays, 0, 6)) {
      throw new InvalidAutomationScheduleRuleError("monthly weekday rules need valid weekdays");
    }
    if (rule.monthlyMode !== "weekday" && !hasOnlyIntegersInRange(rule.monthDays, 1, 31)) {
      throw new InvalidAutomationScheduleRuleError("monthly date rules need valid monthDays");
    }
  }
  if (rule.months && !hasOnlyIntegersInRange(rule.months, 1, 12)) {
    throw new InvalidAutomationScheduleRuleError("months must be a non-empty 1-12 integer array");
  }
  if (rule.monthDays && !hasOnlyIntegersInRange(rule.monthDays, 1, 31)) {
    throw new InvalidAutomationScheduleRuleError(
      "monthDays must be a non-empty 1-31 integer array",
    );
  }
}

/**
 * Automation management service wrapping AutomationRepo: owns cron semantics (validation,
 * next-run computation) plus lifecycle recomputation. The repo is storage only; this layer
 * carries the cron business rules (next_run_at on create, recompute on cron_expr change,
 * lifecycle recompute on recurring/maxRuns change and on restart) for the UI management
 * surface and RPC calls.
 */
export class AutomationService {
  constructor(private readonly repo: AutomationRepo = new AutomationRepo()) {}

  async create(params: ZCodeAutomationCreateParams): Promise<ZCodeAutomation> {
    const createdAt = Date.now();
    const relativeDelayMinutes = params.relativeDelayMinutes;
    if (
      relativeDelayMinutes !== undefined &&
      (!Number.isInteger(relativeDelayMinutes) ||
        relativeDelayMinutes < 1 ||
        relativeDelayMinutes > 525_600)
    ) {
      throw new InvalidAutomationRelativeDelayError("delayMinutes must be an integer 1-525600");
    }
    if (relativeDelayMinutes !== undefined && params.recurring) {
      throw new InvalidAutomationRelativeDelayError("Relative-delay tasks require recurring=false");
    }
    if (relativeDelayMinutes !== undefined && params.maxRuns !== undefined) {
      throw new InvalidAutomationRelativeDelayError(
        "Relative-delay tasks run once; maxRuns is not allowed",
      );
    }
    if (relativeDelayMinutes !== undefined && params.scheduleRule) {
      throw new InvalidAutomationRelativeDelayError(
        "delayMinutes and scheduleRule are mutually exclusive",
      );
    }
    const intervalUnit = params.intervalUnit;
    const interval = params.interval;
    assertValidAutomationIntervalCarrier({
      intervalUnit,
      interval,
      scheduleRule: params.scheduleRule,
      relativeDelayMinutes,
      recurring: params.recurring,
      maxRuns: params.maxRuns,
    });
    // The carrier serves this normalization only; never pass it through to the repository as an undefined persisted field.
    const {
      relativeDelayMinutes: _relativeDelayMinutes,
      intervalUnit: _intervalUnit,
      interval: _interval,
      ...persistedParams
    } = params;
    // Given only a date, the model guesses the current time and can turn "in 3 minutes" into
    // two hours later or the past. The domain layer must anchor relative times on a real
    // Date.now(); never trust a model-converted absolute cron.
    const relativeNormalizedParams =
      relativeDelayMinutes === undefined
        ? persistedParams
        : {
            ...persistedParams,
            ...buildRelativeDelaySchedule(relativeDelayMinutes, createdAt),
            recurring: false,
          };
    // Session-side custom-repeat carrier normalization: assemble intervalUnit+interval plus a
    // compat cron into the authoritative scheduleRule. The real cadence lives in scheduleRule;
    // cronExpr is display-only. The anchor is the server's real creation time (as with relativeDelay).
    const normalizedParams =
      intervalUnit !== undefined && interval !== undefined
        ? {
            ...relativeNormalizedParams,
            // A carrier must loop forever, or legacy clients/internal calls could write the contradictory run-once-then-done state.
            recurring: true,
            maxRuns: undefined,
            scheduleRule: buildIntervalScheduleRule(
              intervalUnit,
              interval,
              relativeNormalizedParams.cronExpr,
              createdAt,
            ),
          }
        : relativeNormalizedParams;
    if (!isValidCronExpr(normalizedParams.cronExpr)) {
      throw new InvalidCronExprError(normalizedParams.cronExpr);
    }
    // computeScheduleRuleNextRunAt used to silently repair interval=0 and return null on huge
    // intervals, persisting invalid rules as active. Reject them in the domain layer before the
    // write; never lean on the UI picker as the backstop.
    if (normalizedParams.scheduleRule) {
      assertValidAutomationScheduleRule(normalizedParams.scheduleRule);
    }
    // Standard */N crons align to wall-clock ticks, so a every-10-minutes rule created at
    // 11:46 fires early at 11:50. Product semantics count from creation time, so the domain
    // layer adds a minute anchor when no explicit rule is given.
    const scheduleRule = normalizedParams.scheduleRule
      ? { ...normalizedParams.scheduleRule, anchorAt: createdAt }
      : inferMinuteIntervalScheduleRule(normalizedParams.cronExpr, createdAt);
    const createParams = scheduleRule ? { ...normalizedParams, scheduleRule } : normalizedParams;
    // Five-field crons carry no year: a one-shot fixed-month/day task that barely misses its
    // minute during creation rolls to next year on a plain nextRun. The first computation
    // compensates only sub-minute cross-minute drift; stale targets are rejected pre-write.
    const nextRunAt = computeInitialAutomationNextRunAt(createParams, createdAt);
    const endedBeforeFirstRun =
      createParams.endAt !== undefined && (nextRunAt ?? Infinity) > createParams.endAt;
    return this.repo.create(createParams, {
      nextRunAt: endedBeforeFirstRun ? null : nextRunAt,
      ...(endedBeforeFirstRun ? { lifecycleStatus: "completed" as const } : {}),
    });
  }

  async list(scope?: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeAutomation[]> {
    return this.repo.list(scope);
  }

  async hasTaskBinding(scope: {
    workspacePath: string;
    workspaceIdentity?: string;
    targetTaskId: string;
  }): Promise<boolean> {
    return this.repo.hasTaskBinding(scope);
  }

  async get(
    automationId: string,
    scope?: AutomationWorkspaceScope,
  ): Promise<ZCodeAutomation | null> {
    return this.repo.get(automationId, resolveScopeKey(scope));
  }

  async update(
    automationId: string,
    params: ZCodeAutomationUpdateParams,
    scope?: AutomationWorkspaceScope,
  ): Promise<ZCodeAutomation | null> {
    const workspaceKey = resolveScopeKey(scope);
    const existing = await this.repo.get(automationId, workspaceKey);
    if (!existing) return null;

    if (params.scheduleRule) assertValidAutomationScheduleRule(params.scheduleRule);

    // Session-side custom-repeat carrier check: intervalUnit+interval must be paired, bounded to 1-200, and mutually exclusive with a direct scheduleRule.
    const { intervalUnit, interval, scheduleRule: directScheduleRule, ...restParams } = params;
    // undefined means no change, null means explicitly clear the existing rule; do not
    // conflate them after destructuring. A ?? merge would treat scheduleRule:null as absent,
    // blocking users from returning to a plain cron schedule.
    const hasDirectScheduleRule = directScheduleRule !== undefined;
    assertValidAutomationIntervalCarrier({
      intervalUnit,
      interval,
      scheduleRule: hasDirectScheduleRule ? directScheduleRule : undefined,
      recurring: restParams.recurring,
      maxRuns: restParams.maxRuns,
    });
    const hasIntervalCarrier = intervalUnit !== undefined && interval !== undefined;

    // Converting maxRuns=null to undefined and then applying the one-shot cap of 1 would
    // silently complete a finite task that already ran. Clearing the cap and switching to
    // unbounded must commit atomically.
    if (!hasIntervalCarrier && restParams.maxRuns === null && restParams.recurring !== true) {
      throw new InvalidAutomationMaxRunsUpdateError();
    }

    const nextRecurring = hasIntervalCarrier ? true : (restParams.recurring ?? existing.recurring);
    if (nextRecurring && typeof restParams.maxRuns === "number") {
      throw new InvalidAutomationMaxRunsUpdateError("Endless tasks cannot set a finite maxRuns");
    }

    // A finite task sending only recurring=true would keep its old maxRuns verbatim through
    // repo.update, hiding a contradictory unbounded-plus-cap state. The domain layer normalizes
    // to null, staying compatible with legacy clients, atomically clearing the stale cap, and
    // repairing historically dirty rows of the same kind.
    const normalizedParams: ZCodeAutomationUpdateParams = hasIntervalCarrier
      ? forceIntervalCarrierRecurring(restParams)
      : nextRecurring &&
          restParams.maxRuns === undefined &&
          (restParams.recurring === true || existing.maxRuns !== undefined)
        ? { ...restParams, maxRuns: null }
        : restParams;

    const options: {
      nextRunAt?: number | null;
      lifecycleStatus?: ZCodeAutomation["lifecycleStatus"];
      resetRetry?: boolean;
    } = {};

    // cron_expr change: validate, recompute next_run_at from now, clear retry state.
    const cronChanged =
      normalizedParams.cronExpr !== undefined && normalizedParams.cronExpr !== existing.cronExpr;
    if (normalizedParams.cronExpr !== undefined && !isValidCronExpr(normalizedParams.cronExpr)) {
      throw new InvalidCronExprError(normalizedParams.cronExpr);
    }
    const updatedAt = Date.now();
    const effectiveCron = normalizedParams.cronExpr ?? existing.cronExpr;
    // Session-side long-interval carrier normalization: assemble intervalUnit+interval plus a
    // compat cron into the authoritative scheduleRule. Carriers must always re-anchor
    // (anchorAt=updatedAt); the later explicitScheduleRule keep-old-anchor-when-unchanged check
    // is meaningless for carriers, because submitting a carrier means the user is resetting the
    // interval, so timing always restarts from this save.
    const carrierScheduleRule = hasIntervalCarrier
      ? buildIntervalScheduleRule(intervalUnit, interval, effectiveCron, updatedAt)
      : undefined;
    const effectiveDirectScheduleRule = hasDirectScheduleRule
      ? directScheduleRule
      : carrierScheduleRule;
    const normalizedWithSchedule: ZCodeAutomationUpdateParams =
      effectiveDirectScheduleRule !== undefined
        ? { ...normalizedParams, scheduleRule: effectiveDirectScheduleRule }
        : normalizedParams;
    if (effectiveDirectScheduleRule) {
      assertValidAutomationScheduleRule(effectiveDirectScheduleRule);
    }
    const explicitScheduleRule = effectiveDirectScheduleRule
      ? {
          ...effectiveDirectScheduleRule,
          // Keep the original anchor when only unrelated fields change; re-anchor from this save only when the cadence itself changes.
          anchorAt:
            existing.scheduleRule &&
            scheduleRuleDefinition(existing.scheduleRule) ===
              scheduleRuleDefinition(effectiveDirectScheduleRule)
              ? existing.scheduleRule.anchorAt
              : updatedAt,
        }
      : effectiveDirectScheduleRule;
    // When the cron changes without an explicit scheduleRule, the old rule must not keep
    // overriding it: minute intervals re-anchor to this modification time, other crons clear
    // the rule and return to calendar-cron semantics.
    const inferredScheduleRule =
      cronChanged && effectiveDirectScheduleRule === undefined
        ? inferMinuteIntervalScheduleRule(effectiveCron, updatedAt)
        : undefined;
    const effectiveScheduleRule =
      effectiveDirectScheduleRule === undefined
        ? cronChanged
          ? inferredScheduleRule
          : existing.scheduleRule
        : (explicitScheduleRule ?? undefined);
    const updateParams =
      cronChanged && effectiveDirectScheduleRule === undefined
        ? { ...normalizedWithSchedule, scheduleRule: inferredScheduleRule ?? null }
        : effectiveDirectScheduleRule === undefined
          ? normalizedWithSchedule
          : { ...normalizedWithSchedule, scheduleRule: explicitScheduleRule ?? null };
    if (
      cronChanged ||
      normalizedParams.endAt !== undefined ||
      effectiveDirectScheduleRule !== undefined
    ) {
      options.nextRunAt = computeAutomationNextRunAt(
        {
          cronExpr: effectiveCron,
          scheduleRule: effectiveScheduleRule,
        },
        updatedAt,
      );
      options.resetRetry = true;
    }

    const effectiveEndAt =
      normalizedParams.endAt === undefined ? existing.endAt : (normalizedParams.endAt ?? undefined);
    if (
      effectiveEndAt !== undefined &&
      (options.nextRunAt ?? existing.nextRunAt ?? Infinity) > effectiveEndAt
    ) {
      options.nextRunAt = null;
      options.lifecycleStatus = "completed";
    } else if (
      normalizedParams.endAt !== undefined &&
      (existing.lifecycleStatus === "completed" || existing.lifecycleStatus === "failed")
    ) {
      options.lifecycleStatus = "active";
    }

    // recurring/max_runs change: recompute the lifecycle.
    if (normalizedParams.recurring !== undefined || normalizedParams.maxRuns !== undefined) {
      const nextMaxRuns =
        normalizedParams.maxRuns === undefined
          ? existing.maxRuns
          : (normalizedParams.maxRuns ?? undefined);
      // runCount is the card's cumulative display count including manual runs; recomputing a
      // finite plan from it lets any manual run flip the task to completed early on a maxRuns edit.
      const scheduledRunCount = await this.repo.getScheduledRunCount(automationId, workspaceKey);
      if (scheduledRunCount === null) return null;
      // Same accounting as markDispatched: a finite task without explicit max_runs is treated as one-shot (cap 1).
      const reachedMax = !nextRecurring && scheduledRunCount >= (nextMaxRuns ?? 1);
      if (reachedMax) {
        options.lifecycleStatus = "completed";
      } else if (
        existing.lifecycleStatus === "completed" ||
        existing.lifecycleStatus === "failed"
      ) {
        // Terminal state made runnable again by the edit -> revive as active and recompute next_run_at.
        options.lifecycleStatus = "active";
        if (options.nextRunAt === undefined) {
          options.nextRunAt = computeAutomationNextRunAt(
            {
              cronExpr: effectiveCron,
              scheduleRule: effectiveScheduleRule,
            },
            updatedAt,
          );
        }
      }
    }

    return this.repo.update(automationId, updateParams, options, workspaceKey);
  }

  async delete(automationId: string, scope?: AutomationWorkspaceScope): Promise<boolean> {
    return this.repo.delete(automationId, resolveScopeKey(scope));
  }

  /** Pause/resume. */
  async setEnabled(
    automationId: string,
    enabled: boolean,
    scope?: AutomationWorkspaceScope,
  ): Promise<void> {
    return this.repo.setEnabled(automationId, enabled, resolveScopeKey(scope));
  }

  /** Manual retry of a failed task: back to active, counters cleared, next run recomputed from cron. */
  async restart(automationId: string, scope?: AutomationWorkspaceScope): Promise<void> {
    const workspaceKey = resolveScopeKey(scope);
    const existing = await this.repo.get(automationId, workspaceKey);
    if (!existing) return;
    // completed is the natural terminal of an exhausted finite plan; a legacy UI/RPC restart
    // must not revive it. Only failed is a recoverable state that may be manually rescheduled.
    if (existing.lifecycleStatus !== "failed") return;
    const nextRunAt = computeAutomationNextRunAt(existing);
    return this.repo.restart(automationId, { nextRunAt }, workspaceKey);
  }

  /** Run now: create a manual run for the current host to dispatch; the cron plan itself is untouched. */
  async runNow(
    automationId: string,
    scope?: AutomationWorkspaceScope,
  ): Promise<{ automation: ZCodeAutomation; run: ZCodeAutomationRun } | null> {
    const workspaceKey = resolveScopeKey(scope);
    const existing = await this.repo.get(automationId, workspaceKey);
    if (!existing) return null;
    return this.repo.runNow(automationId, { now: Date.now() }, workspaceKey);
  }

  async listRuns(
    automationId: string,
    scope?: AutomationWorkspaceScope,
  ): Promise<ZCodeAutomationRun[]> {
    return this.repo.listRuns(automationId, resolveScopeKey(scope));
  }
  async deleteRun(runId: string, scope?: AutomationWorkspaceScope): Promise<void> {
    return this.repo.deleteRun(runId, resolveScopeKey(scope));
  }
}
