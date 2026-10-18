import { Cron } from "croner";
import type { ZCodeAutomation, ZCodeAutomationScheduleRule } from "@zcode/shared";
import { isValidCronExpr } from "#src/session/automationCronValidation.js";

export { isValidCronExpr } from "#src/session/automationCronValidation.js";

const ONE_SHOT_MISSED_RUN_GRACE_MS = 60 * 1_000;
// Window for treating a one-shot fixed-date cron whose target just passed as stale-model error, not intent.
// Models anchor now to the turn start, so self-computed crons land minutes late. Inside the window,
// an expired target is a miscalculation, not next-year intent: <1min runs immediately, otherwise reject pre-write and
// point at delayMinutes. 30min covers real clock skew; beyond it (created after the target month) next-year stands.
const ONE_SHOT_STALE_TARGET_WINDOW_MS = 30 * 60 * 1_000;
const FIXED_CALENDAR_CRON = /^\d+\s+\d+\s+\d+\s+\d+\s+\*$/;

/** Whether a submitted scheduleRule only touches display fields; anchorAt ignored in the comparison. */
export function scheduleRuleDefinition(rule: ZCodeAutomationScheduleRule): string {
  return JSON.stringify([
    rule.unit,
    rule.interval,
    rule.hour,
    rule.minute,
    rule.weekdays ? [...rule.weekdays].sort((a, b) => a - b) : null,
    rule.monthDays ? [...rule.monthDays].sort((a, b) => a - b) : null,
    rule.months ? [...rule.months].sort((a, b) => a - b) : null,
    rule.monthlyMode ?? null,
  ]);
}

/** One-shot calendar task whose target just passed and can no longer be safely backfilled. */
export class StaleOneShotAutomationScheduleError extends Error {
  constructor(targetAt: number) {
    super(
      `The one-shot target (${new Date(targetAt).toLocaleString()}) already passed; use delayMinutes for relative times, or confirm a future instant and retry`,
    );
    this.name = "StaleOneShotAutomationScheduleError";
  }
}

/**
 * Pure one-shot tasks (non-recurring, at most one run). A relative delay means one concrete instant,
 * not a repeating interval: past its window the task terminates and never derives new runs from the
 * compatibility scheduleRule (the minute rule delayMinutes compiles to).
 */
export function isOneShotAutomation(
  automation: Pick<ZCodeAutomation, "recurring" | "maxRuns">,
): boolean {
  return !automation.recurring && (automation.maxRuns ?? 1) <= 1;
}

/**
 * Next-run math for cron expressions (local time). croner only parses and computes next runs;
 * scheduling itself is the scheduler polling automation_runs / claimDue.
 */

/**
 * Next cron fire time as a ms timestamp.
 * @param from base time in ms (default now). Returns the first fire strictly after from, else null.
 */
export function computeNextRunAt(cronExpr: string, from?: number): number | null {
  const cron = new Cron(cronExpr);
  const next = cron.nextRun(from === undefined ? undefined : new Date(from));
  return next ? next.getTime() : null;
}

/**
 * Folds in-N-minutes into a one-shot rule anchored at server now. cronExpr is display-only;
 * nextRunAt comes from the second-precision anchor so 5-field crons cannot drift a minute.
 */
export function buildRelativeDelaySchedule(
  delayMinutes: number,
  from = Date.now(),
): Pick<ZCodeAutomation, "cronExpr" | "scheduleRule"> {
  const target = new Date(from + delayMinutes * 60 * 1_000);
  return {
    cronExpr: `${target.getMinutes()} ${target.getHours()} ${target.getDate()} ${target.getMonth() + 1} *`,
    scheduleRule: {
      unit: "minute",
      interval: delayMinutes,
      hour: target.getHours(),
      minute: target.getMinutes(),
      anchorAt: from,
    },
  };
}

/**
 * First fire for new tasks. A just-missed fixed-date one-shot would roll a year ahead;
 * Sub-minute tool-call skew backfills at once; staler targets are rejected and recomputed.
 */
export function computeInitialAutomationNextRunAt(
  automation: Pick<ZCodeAutomation, "cronExpr" | "recurring" | "scheduleRule">,
  from = Date.now(),
): number | null {
  const nextRunAt = computeAutomationNextRunAt(automation, from);
  if (
    automation.recurring ||
    automation.scheduleRule ||
    !FIXED_CALENDAR_CRON.test(automation.cronExpr.trim())
  ) {
    return nextRunAt;
  }

  const cron = new Cron(automation.cronExpr);
  const previousRun = cron.previousRuns(1, new Date(from))[0]?.getTime();
  const targetAge =
    previousRun !== undefined &&
    from >= previousRun &&
    from - previousRun <= ONE_SHOT_STALE_TARGET_WINDOW_MS
      ? from - previousRun
      : undefined;
  const rolledToNextCalendarOccurrence =
    nextRunAt === null || nextRunAt - from > ONE_SHOT_STALE_TARGET_WINDOW_MS;
  if (targetAge !== undefined && rolledToNextCalendarOccurrence) {
    if (targetAge < ONE_SHOT_MISSED_RUN_GRACE_MS) return from;

    // Treating any past instant as just-crossed would run model-miscalculated
    // delays instantly. Past a minute, backfill intent is unsafe; reject before writing.
    throw new StaleOneShotAutomationScheduleError(from - targetAge);
  }
  return nextRunAt;
}

function atTime(date: Date, hour: number, minute: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
}

function firstWeekdayOfMonth(year: number, month: number, weekday: number): Date {
  const first = new Date(year, month, 1);
  return new Date(year, month, 1 + ((weekday - first.getDay() + 7) % 7));
}

/** Next run of a custom repeat rule; all math in local calendar time. */
export function computeScheduleRuleNextRunAt(
  rule: ZCodeAutomationScheduleRule,
  from = Date.now(),
): number | null {
  const interval = Math.max(1, Math.floor(rule.interval));
  const anchor = new Date(rule.anchorAt);

  if (rule.unit === "minute") {
    const step = interval * 60 * 1_000;
    // Minute intervals anchor at creation/edit, never snapping to the next wall-clock tick like */N.
    // Deriving from the fixed anchor also stops per-run drift when the scheduler dispatches late.
    const steps = Math.max(1, Math.floor((from - rule.anchorAt) / step) + 1);
    return rule.anchorAt + steps * step;
  }

  if (rule.unit === "hourly") {
    const base = new Date(anchor);
    base.setMinutes(rule.minute, 0, 0);
    const step = interval * 60 * 60 * 1_000;
    const steps = Math.max(0, Math.floor((from - base.getTime()) / step) + 1);
    return base.getTime() + steps * step;
  }

  if (rule.unit === "daily") {
    for (let index = 0; index < 36_600; index += 1) {
      const date = new Date(
        anchor.getFullYear(),
        anchor.getMonth(),
        anchor.getDate() + index * interval,
      );
      const candidate = atTime(date, rule.hour, rule.minute).getTime();
      if (candidate > from) return candidate;
    }
    return null;
  }

  if (rule.unit === "weekly") {
    const anchorWeek = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
    anchorWeek.setDate(anchorWeek.getDate() - ((anchorWeek.getDay() + 6) % 7));
    const weekdays = [...(rule.weekdays?.length ? rule.weekdays : [1])].sort();
    for (let week = 0; week < 5_220; week += interval) {
      for (const weekday of weekdays) {
        const dayOffset = (weekday + 6) % 7;
        const date = new Date(
          anchorWeek.getFullYear(),
          anchorWeek.getMonth(),
          anchorWeek.getDate() + week * 7 + dayOffset,
        );
        const candidate = atTime(date, rule.hour, rule.minute).getTime();
        if (candidate > from) return candidate;
      }
    }
    return null;
  }

  if (rule.unit === "monthly") {
    // 1200 is both a legal month offset and the search bound; the old strict-less check tested only offset=0
    // and returned null once this month passed. Include the bound to reach runs a century out.
    for (let offset = 0; offset <= 1_200; offset += interval) {
      const month = new Date(anchor.getFullYear(), anchor.getMonth() + offset, 1);
      const candidates =
        rule.monthlyMode === "weekday"
          ? [firstWeekdayOfMonth(month.getFullYear(), month.getMonth(), rule.weekdays?.[0] ?? 1)]
          : [...(rule.monthDays?.length ? rule.monthDays : [1])]
              .sort((left, right) => left - right)
              .map((day) => new Date(month.getFullYear(), month.getMonth(), day))
              .filter((date) => date.getMonth() === month.getMonth());
      for (const date of candidates) {
        const candidate = atTime(date, rule.hour, rule.minute).getTime();
        if (candidate > from) return candidate;
      }
    }
    return null;
  }

  // yearly: months from rule.months (1-12, 0-indexed) else the anchor month (legacy compat);
  // day from monthDays[0] or the anchor day. Overflow (2/30, 2/29 non-leap) rolls a month; skip the year.
  const targetMonth =
    rule.months?.[0] != null ? (((rule.months[0] - 1) % 12) + 12) % 12 : anchor.getMonth();
  const targetDay = rule.monthDays?.[0] ?? anchor.getDate();
  for (let offset = 0; offset < 400; offset += interval) {
    const date = new Date(anchor.getFullYear() + offset, targetMonth, targetDay);
    if (date.getMonth() !== targetMonth) continue;
    const candidate = atTime(date, rule.hour, rule.minute).getTime();
    if (candidate > from) return candidate;
  }
  return null;
}

/** Recognizes every-N-minutes cron display strings as anchored product schedule rules. */
export function inferMinuteIntervalScheduleRule(
  cronExpr: string,
  anchorAt: number,
): ZCodeAutomationScheduleRule | undefined {
  const match = /^\*\/([1-9]\d*)\s+\*\s+\*\s+\*\s+\*$/.exec(cronExpr.trim());
  if (!match) return undefined;
  return {
    unit: "minute",
    interval: Number(match[1]),
    hour: new Date(anchorAt).getHours(),
    minute: new Date(anchorAt).getMinutes(),
    anchorAt,
  };
}

/**
 * Parses 5-field cron (minute hour dom month dow) only;
 * numeric values per field, comma lists for dow/dom/month, undefined for wildcards.
 * Failures return undefined; callers pick the degrade.
 */
function parseCronFields(cronExpr: string): {
  minute?: number;
  hour?: number;
  monthDays?: number[];
  months?: number[];
  weekdays?: number[];
} {
  const parts = cronExpr.trim().split(/\s+/);
  // Under noUncheckedIndexedAccess parts[i] includes undefined; destructure five fields. Only true 5-field crons parse,
  // otherwise return empty and let callers fall back to the anchor (never treat "0 9" as cron).
  const [minuteToken, hourToken, domToken, monthToken, dowToken] = parts;
  if (parts.length < 5 || minuteToken === undefined) return {};
  const parseSingle = (token: string): number | undefined => {
    if (token === "*" || token === "?") return undefined;
    const value = Number(token);
    return Number.isInteger(value) ? value : undefined;
  };
  // Range fields take comma lists (1,3,5); non-numeric tokens (*/2, 1#1) are ignored,
  // since step/ordinal forms belong to the carrier path; degrade to defaults.
  const parseList = (token: string): number[] | undefined => {
    if (token === "*" || token === "?") return undefined;
    const values = token
      .split(",")
      .map((piece) => Number(piece))
      .filter((value) => Number.isInteger(value));
    return values.length > 0 ? values : undefined;
  };
  return {
    minute: parseSingle(minuteToken),
    hour: hourToken === undefined ? undefined : parseSingle(hourToken),
    monthDays: domToken === undefined ? undefined : parseList(domToken),
    months: monthToken === undefined ? undefined : parseList(monthToken),
    weekdays: dowToken === undefined ? undefined : parseList(dowToken),
  };
}

/**
 * Normalizes the session-side repeat carrier (intervalUnit + interval) into the authoritative scheduleRule.
 *
 * Cron fields cap steps (minute 59, hour 24, dom 31, month 12),
 * so every-50-hours/40-days/13-months cannot be plain cron. Every-N-unit input rides the carrier
 * (intervalUnit+interval) with cronExpr for display only; this maps the compat cron fields onto
 * hour/minute/weekdays/monthDays/months while the carrier carries the true interval,
 * and anchorAt comes from the service's real create/edit time for the engine to advance from.
 *
 * Missing compat fields (a '* * * * *' placeholder) fall back to safe defaults (weekday [1], monthDays [1],
 * anchor month) so the engine can always compute a next run instead of nulling out.
 */
export function buildIntervalScheduleRule(
  intervalUnit: ZCodeAutomationScheduleRule["unit"],
  interval: number,
  cronExpr: string,
  anchorAt: number,
): ZCodeAutomationScheduleRule {
  const fields = parseCronFields(cronExpr);
  const anchor = new Date(anchorAt);
  const minute = fields.minute ?? anchor.getMinutes();
  const hour = fields.hour ?? anchor.getHours();
  const monthDays = fields.monthDays ?? [anchor.getDate()];
  // cron mixes 1-based months with 0-based dow; normalize to scheduleRule semantics (see the engine).
  const months = fields.months ?? [anchor.getMonth() + 1];
  const weekdays = fields.weekdays ?? [1];

  switch (intervalUnit) {
    case "minute":
      // Minute intervals advance from anchorAt alone; hour/minute stay display-only for cards.
      return {
        unit: "minute",
        interval,
        hour: anchor.getHours(),
        minute: anchor.getMinutes(),
        anchorAt,
      };
    case "hourly":
      // The hourly branch aligns on rule.minute; hour never participates (computeScheduleRuleNextRunAt).
      return { unit: "hourly", interval, hour: 0, minute, anchorAt };
    case "daily":
      return { unit: "daily", interval, hour, minute, anchorAt };
    case "weekly":
      return { unit: "weekly", interval, hour, minute, weekdays, anchorAt };
    case "monthly":
      return {
        unit: "monthly",
        interval,
        hour,
        minute,
        monthDays,
        monthlyMode: "date",
        anchorAt,
      };
    case "yearly":
      return { unit: "yearly", interval, hour, minute, months, monthDays, anchorAt };
    default: {
      // Reject invalid units here so bad rules never reach the database.
      const exhaustive: never = intervalUnit;
      throw new Error(`Unsupported intervalUnit: ${String(exhaustive)}`);
    }
  }
}

export function computeAutomationNextRunAt(
  automation: Pick<ZCodeAutomation, "cronExpr" | "scheduleRule">,
  from?: number,
): number | null {
  return automation.scheduleRule
    ? computeScheduleRuleNextRunAt(automation.scheduleRule, from)
    : computeNextRunAt(automation.cronExpr, from);
}
