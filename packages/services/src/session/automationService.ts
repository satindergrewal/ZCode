/* eslint-disable max-lines -- automation domain service keeps cron validation, lifecycle recompute, and update guards in one unit; the count only outgrew the cap through formatter-wrapped English error strings. */
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

//** Workspace ownership of writes/single-reads; cross-workspace isolation checks. */
interface AutomationWorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
}

/** scope -> workspaceKey; undefined default = no ownership filter, for scheduler/host cross-workspace use. */
function resolveScopeKey(scope?: AutomationWorkspaceScope): string | undefined {
  if (!scope?.workspacePath) return undefined;
  return resolveWorkspaceKey({
    workspacePath: scope.workspacePath,
    workspaceIdentity: scope.workspaceIdentity,
  });
}

/** Invalid cron expression error (displayable to the UI via the management layer). */
export class InvalidCronExprError extends Error {
  constructor(cronExpr: string) {
    super(`Invalid cron expression: ${cronExpr}`);
    this.name = "InvalidCronExprError";
  }
}

/** Invalid finite-count update; prevents contradictory states and accidentally ending running tasks. */
class InvalidAutomationMaxRunsUpdateError extends Error {
  constructor(message = "Clearing maxRuns requires recurring=true in the same update") {
    super(message);
    this.name = "InvalidAutomationMaxRunsUpdateError";
  }
}

/** Invalid custom schedule rule; rules pass domain validation before entering the task store. */
class InvalidAutomationScheduleRuleError extends Error {
  constructor(message: string) {
    super(`Invalid automation schedule rule: ${message}`);
    this.name = "InvalidAutomationScheduleRuleError";
  }
}

/** Relative delays are one-shot only, with the schedule rule anchored at server real time. */
class InvalidAutomationRelativeDelayError extends Error {
  constructor(message: string) {
    super(`Invalid relative-delay automation: ${message}`);
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
    throw new InvalidAutomationScheduleRuleError("unsupported unit");
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
    throw new InvalidAutomationScheduleRuleError("unsupported monthlyMode");
  }
  if (rule.weekdays && !hasOnlyIntegersInRange(rule.weekdays, 0, 6)) {
    throw new InvalidAutomationScheduleRuleError("weekdays must be a non-empty integer array 0-6");
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
    throw new InvalidAutomationScheduleRuleError("months must be a non-empty integer array 1-12");
  }
  if (rule.monthDays && !hasOnlyIntegersInRange(rule.monthDays, 1, 31)) {
    throw new InvalidAutomationScheduleRuleError(
      "monthDays must be a non-empty integer array 1-31",
    );
  }
}

/**
 * Automation management service over AutomationRepo: cron semantics (validation/next-run) + lifecycle recompute.
 * The repo only stores; this layer owns compute-next-on-create, recompute on cron change, lifecycle recompute on
 * recurring/maxRuns change, restart recompute - for the UI management surface / RPC.
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
      throw new InvalidAutomationRelativeDelayError("relative-delay tasks require recurring=false");
    }
    if (relativeDelayMinutes !== undefined && params.maxRuns !== undefined) {
      throw new InvalidAutomationRelativeDelayError(
        "relative-delay tasks run once and cannot set maxRuns",
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
    // The carrier serves this normalization only; never leak it into the repository as an undefined persisted field.
    const {
      relativeDelayMinutes: _relativeDelayMinutes,
      intervalUnit: _intervalUnit,
      interval: _interval,
      ...persistedParams
    } = params;
    // Given only a date, models guess the current instant, turning in 3 minutes into two hours or the past.
    // The domain layer must anchor relative times on real Date.now(), never trusting model-converted crons.
    const relativeNormalizedParams =
      relativeDelayMinutes === undefined
        ? persistedParams
        : {
            ...persistedParams,
            ...buildRelativeDelaySchedule(relativeDelayMinutes, createdAt),
            recurring: false,
          };
    // Session-side carrier normalization: assemble intervalUnit+interval + compat cron into the authoritative rule,
    // the interval carried by scheduleRule, cronExpr display only. Anchor at real server create time (as relativeDelay).
    const normalizedParams =
      intervalUnit !== undefined && interval !== undefined
        ? {
            ...relativeNormalizedParams,
            // Carriers must loop forever, or legacy clients/internal calls persist done-on-first-dispatch states.
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
    // computeScheduleRuleNextRunAt used to silently fix interval=0 and return null on huge intervals,
    // persisting invalid rules as active. Reject at the domain layer before writing; never trust UI selectors.
    if (normalizedParams.scheduleRule) {
      assertValidAutomationScheduleRule(normalizedParams.scheduleRule);
    }
    // Standard \`*/N\` cron snaps to wall ticks: an 11:46 every-10-minutes fires at 11:50.
    // Product semantics count from creation, so without an explicit rule add the minute anchor at the domain layer.
    const scheduleRule = normalizedParams.scheduleRule
      ? { ...normalizedParams.scheduleRule, anchorAt: createdAt }
      : inferMinuteIntervalScheduleRule(normalizedParams.cronExpr, createdAt);
    const createParams = scheduleRule ? { ...normalizedParams, scheduleRule } : normalizedParams;
    // Five-field crons carry no year: a one-shot fixed month/day task missing its minute during creation
    // rolls to next year on plain nextRun. Compensate only sub-minute skew on first compute; reject staler targets.
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

    // Session carrier validation: intervalUnit+interval must pair, 1-200, and exclude explicit scheduleRule.
    const { intervalUnit, interval, scheduleRule: directScheduleRule, ...restParams } = params;
    // \`undefined\` = no change, \`null\` = clear the rule; never conflate them after destructuring.
    // A \`??\` merge reads scheduleRule:null as absent, blocking users from returning to plain cron.
    const hasDirectScheduleRule = directScheduleRule !== undefined;
    assertValidAutomationIntervalCarrier({
      intervalUnit,
      interval,
      scheduleRule: hasDirectScheduleRule ? directScheduleRule : undefined,
      recurring: restParams.recurring,
      maxRuns: restParams.maxRuns,
    });
    const hasIntervalCarrier = intervalUnit !== undefined && interval !== undefined;

    // Turning maxRuns=null into undefined then computing the one-shot cap 1
    // silently completes finite tasks that already ran. Clearing the cap commits atomically with the infinite switch.
    if (!hasIntervalCarrier && restParams.maxRuns === null && restParams.recurring !== true) {
      throw new InvalidAutomationMaxRunsUpdateError();
    }

    const nextRecurring = hasIntervalCarrier ? true : (restParams.recurring ?? existing.recurring);
    if (nextRecurring && typeof restParams.maxRuns === "number") {
      throw new InvalidAutomationMaxRunsUpdateError(
        "Infinite-recurrence tasks cannot set a finite maxRuns",
      );
    }

    // With only recurring=true, repo.update keeps the old maxRuns,
    // hiding an infinite+finite contradiction. The domain layer normalizes to null for compat and clears atomically,
    // also repairing legacy dirty rows of the same shape.
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

    // cron_expr change: validate + recompute next_run_at from now + clear retry state.
    const cronChanged =
      normalizedParams.cronExpr !== undefined && normalizedParams.cronExpr !== existing.cronExpr;
    if (normalizedParams.cronExpr !== undefined && !isValidCronExpr(normalizedParams.cronExpr)) {
      throw new InvalidCronExprError(normalizedParams.cronExpr);
    }
    const updatedAt = Date.now();
    const effectiveCron = normalizedParams.cronExpr ?? existing.cronExpr;
    // Session carrier normalization: intervalUnit+interval + compat cron -> authoritative scheduleRule.
    // Carriers must re-anchor (anchorAt=updatedAt): the explicitScheduleRule keep-anchor-on-unchanged-rule
    // check is meaningless for carriers - submitting a carrier means resetting the interval; retime on this save.
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
          // Unchanged rule + other field edits keep the anchor; real frequency changes retime from this save.
          anchorAt:
            existing.scheduleRule &&
            scheduleRuleDefinition(existing.scheduleRule) ===
              scheduleRuleDefinition(effectiveDirectScheduleRule)
              ? existing.scheduleRule.anchorAt
              : updatedAt,
        }
      : effectiveDirectScheduleRule;
    // cron changed without an explicit scheduleRule: the old rule must not shadow the new cron; minute intervals
    // re-anchor at this modification, others clear the rule restoring calendar-cron semantics.
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

    // recurring / max_runs change: recompute lifecycle.
    if (normalizedParams.recurring !== undefined || normalizedParams.maxRuns !== undefined) {
      const nextMaxRuns =
        normalizedParams.maxRuns === undefined
          ? existing.maxRuns
          : (normalizedParams.maxRuns ?? undefined);
      // runCount is the Card total including manual runs; recomputing finite plans from it lets
      // one manual run flip the task to completed during a maxRuns edit.
      const scheduledRunCount = await this.repo.getScheduledRunCount(automationId, workspaceKey);
      if (scheduledRunCount === null) return null;
      // Same rule as markDispatched: finite tasks without explicit max_runs count as one-shot (cap 1).
      const reachedMax = !nextRecurring && scheduledRunCount >= (nextMaxRuns ?? 1);
      if (reachedMax) {
        options.lifecycleStatus = "completed";
      } else if (
        existing.lifecycleStatus === "completed" ||
        existing.lifecycleStatus === "failed"
      ) {
        // Terminal -> runnable again via edit: revive to active and recompute next_run_at.
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

  /** Pause / resume. */
  async setEnabled(
    automationId: string,
    enabled: boolean,
    scope?: AutomationWorkspaceScope,
  ): Promise<void> {
    return this.repo.setEnabled(automationId, enabled, resolveScopeKey(scope));
  }

  /** Manual rerun of a failed task: back to active, clear counts, recompute next from cron. */
  async restart(automationId: string, scope?: AutomationWorkspaceScope): Promise<void> {
    const workspaceKey = resolveScopeKey(scope);
    const existing = await this.repo.get(automationId, workspaceKey);
    if (!existing) return;
    // completed is the natural terminal of an exhausted finite plan; legacy UI/RPC restart must not revive it.
    // Only failed marks a recoverable error and may be manually rescheduled.
    if (existing.lifecycleStatus !== "failed") return;
    const nextRunAt = computeAutomationNextRunAt(existing);
    return this.repo.restart(automationId, { nextRunAt }, workspaceKey);
  }

  /** Run now: create a manual run for direct host dispatch, never touching the cron plan. */
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
