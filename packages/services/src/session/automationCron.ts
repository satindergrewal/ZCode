import { Cron } from "croner";
import type { ZCodeAutomation, ZCodeAutomationScheduleRule } from "@zcode/shared";
import { isValidCronExpr } from "#src/session/automationCronValidation.js";

export { isValidCronExpr } from "#src/session/automationCronValidation.js";

const ONE_SHOT_MISSED_RUN_GRACE_MS = 60 * 1_000;
// Recognition window for one-shot fixed month/day crons whose target just passed. The model's "now" is often
// stale (time context frozen at turn start), so relative requests self-converted to absolute cron land minutes past.
// Within the window treat an expired target as a model slip, not a real next-year intent: <1min runs at once,
// otherwise reject before persisting and suggest delayMinutes; 30min covers real skew, later targets keep next-year.
const ONE_SHOT_STALE_TARGET_WINDOW_MS = 30 * 60 * 1_000;
const FIXED_CALENDAR_CRON = /^\d+\s+\d+\s+\d+\s+\d+\s+\*$/;

/** Whether a directly submitted scheduleRule only touches display fields, ignoring anchorAt in comparisons. */
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

/** A one-shot fixed-calendar task whose target time just passed and can no longer be safely run late. */
class StaleOneShotAutomationScheduleError extends Error {
  constructor(targetAt: number) {
    super(
      `One-shot scheduled task target (${new Date(targetAt).toLocaleString()}) already passed; use delayMinutes for relative times, or confirm a future time`,
    );
    this.name = "StaleOneShotAutomationScheduleError";
  }
}

/**
 * Pure one-shot tasks (non-recurring, at most one run). A relative delay means one definite target instant,
 * not an interval rule: after the window passes it must terminate, never re-deriving promises from the compat
 * scheduleRule (e.g. the minute rule delayMinutes lands as).
 */
export function isOneShotAutomation(
  automation: Pick<ZCodeAutomation, "recurring" | "maxRuns">,
): boolean {
  return !automation.recurring && (automation.maxRuns ?? 1) <= 1;
}

/**
 * Next-run computation for cron expressions (local timezone). Scheduling uses croner only to parse and get next,
 * never to drive the loop - the scheduler polls automation_runs / claimDue itself.
 */

/**
 * Next trigger time of a cron (ms timestamp).
 * @param from base time (ms); defaults to now. Returns the first strictly after from; null when none future.
 */
export function computeNextRunAt(cronExpr: string, from?: number): number | null {
  const cron = new Cron(cronExpr);
  const next = cron.nextRun(from === undefined ? undefined : new Date(from));
  return next ? next.getTime() : null;
}

/**
 * Pins "in a few minutes" to a one-shot rule anchored at server real time. cronExpr is compat display only;
 * actual nextRunAt comes from the scheduleRule's second-precision anchorAt, avoiding whole-minute cron drift.
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
 * First trigger of a new task. A one-shot fixed month/day cron that just missed its minute rolls to next year;
 * only sub-minute tool-call skew may run at once; stale targets must be rejected and recomputed.
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

    // Treating any past time as "just crossed the minute" runs model-miscalculated
    // relative times immediately. Past one minute, intent is no longer safe to infer; reject before persisting.
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

/** Next run of a custom recurrence rule; every computation uses local calendar time. */
export function computeScheduleRuleNextRunAt(
  rule: ZCodeAutomationScheduleRule,
  from = Date.now(),
): number | null {
  const interval = Math.max(1, Math.floor(rule.interval));
  const anchor = new Date(rule.anchorAt);

  if (rule.unit === "minute") {
    const step = interval * 60 * 1_000;
    // Minute intervals start at create/modify time, not snapped to the next wall tick like \`*/N\` cron.
    // Deriving from the fixed anchor also avoids per-round drift when the scheduler dispatches late.
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
    // 1200 is both a legal monthly interval and a search bound; the old strict < checked only offset=0 and
    // wrongly returned null once this month's candidate passed. Include the bound to reach 100 years ahead.
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

  // yearly: month prefers rule.months (1-12 -> 0-indexed), falling back to the anchor month (legacy rows);
  // day takes monthDays[0] or the anchor day. Overflow guard: 2/30, non-leap 2/29 roll a month; skip the year.
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

/** Recognize a every-N-minutes cron display expression as the product rule anchored at creation time. */
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
 * Parse the five cron fields. Only standard 5-field cron (minute hour dom month dow);
 * returns numeric lists per field, range fields (dow/dom/month) comma-split, wildcard fields undefined.
 * Failure returns undefined; the caller picks the degradation.
 */
function parseCronFields(cronExpr: string): {
  minute?: number;
  hour?: number;
  monthDays?: number[];
  months?: number[];
  weekdays?: number[];
} {
  const parts = cronExpr.trim().split(/\s+/);
  // Under noUncheckedIndexedAccess parts[i] includes undefined; destructure the first 5. Only 5-field crons parse;
  // fewer fields return an empty object and the caller falls back to anchorAt defaults (never read "0 9" as cron).
  const [minuteToken, hourToken, domToken, monthToken, dowToken] = parts;
  if (parts.length < 5 || minuteToken === undefined) return {};
  const parseSingle = (token: string): number | undefined => {
    if (token === "*" || token === "?") return undefined;
    const value = Number(token);
    return Number.isInteger(value) ? value : undefined;
  };
  // Range fields accept comma lists ("1,3,5"); ignore non-numeric tokens ("*/2", "1#1") -
  // step/ordinal syntax exceeds the carrier scenario (only over-cap steps go carrier); degrade to defaults.
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
 * Normalizes the session-side custom recurrence carrier (intervalUnit + interval) into the authoritative scheduleRule.
 *
 * Cron fields cap steps (minute 59, hour 24, dom 31, month 12), so "every 50 hours/40 days/13 months"
 * cannot be a 5-field cron. Every session-side every-N-unit rides the controlled carrier
 * intervalUnit+interval; cronExpr is legal compat display. This function parses the compat cron fields into
 * the hour/minute/weekdays/monthDays/months the scheduleRule needs; the true interval comes from the carrier,
 * and anchorAt is the real create/modify instant passed by the service, driving the engine.
 *
 * Missing compat cron fields (e.g. a '* * * * *' placeholder) fall back to safe defaults (weekday=[1], monthDays=[1],
 * months=anchor month) so the engine can always compute a next run, never silently null.
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
  // cron month/dow mix 1-based/0-based; normalize into scheduleRule semantics (see the engine).
  const months = fields.months ?? [anchor.getMonth() + 1];
  const weekdays = fields.weekdays ?? [1];

  switch (intervalUnit) {
    case "minute":
      // Minute-interval scheduling advances purely on anchorAt; hour/minute are display, kept for the card.
      return {
        unit: "minute",
        interval,
        hour: anchor.getHours(),
        minute: anchor.getMinutes(),
        anchorAt,
      };
    case "hourly":
      // The engine's hourly branch aligns only on rule.minute; hour never participates (computeScheduleRuleNextRunAt).
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
      // Invalid units must be rejected at normalization, never silently persisted as a wrong rule.
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
