// Automation display-layer formatting: cron expression to human-readable schedule summary / relative time / cron builder assembly.
// Note: croner runs services-side for next-run math; the UI here only prettifies known common patterns
// and falls back to the raw cron text for anything uncovered, so nothing misleads.

export interface IntlLike {
  formatMessage: (descriptor: { id: string }, values?: Record<string, string>) => string;
}

export type AutomationStatusKind = "active" | "paused" | "completed" | "failed";

interface AutomationStatusLike {
  lifecycleStatus: AutomationStatusKind;
  enabled: boolean;
}

interface AutomationFailureLike {
  lifecycleStatus: AutomationStatusKind;
  dispatchStatus?: "idle" | "claimed" | "dispatched" | "failed_to_dispatch";
  dispatchAttempts?: number;
  retryAt?: number;
  lastError?: string;
}

/** Show the failed state after a real run/dispatch failure; the recurring job itself stays active and keeps scheduling. */
export function hasAutomationFailureState(automation: AutomationFailureLike): boolean {
  return (
    automation.lifecycleStatus === "failed" ||
    automation.dispatchStatus === "failed_to_dispatch" ||
    Boolean(automation.lastError?.trim())
  );
}

/** While a dispatch failure sits in the backoff queue, show the real retry-queue info next to the failed state. */
export function hasAutomationRetryQueueState(automation: AutomationFailureLike): boolean {
  return (
    hasAutomationFailureState(automation) &&
    automation.dispatchStatus === "failed_to_dispatch" &&
    (automation.dispatchAttempts ?? 0) > 0 &&
    typeof automation.retryAt === "number"
  );
}

/** Automation lifecycle display state: terminal states first, then paused/enabled, then active. */
export function resolveAutomationStatusKind(
  automation: AutomationStatusLike,
): AutomationStatusKind {
  if (automation.lifecycleStatus === "failed") return "failed";
  if (automation.lifecycleStatus === "completed") return "completed";
  if (automation.lifecycleStatus === "paused" || !automation.enabled) return "paused";
  return "active";
}

/** Frequency types the cron builder supports (the most common Feishu custom-repeat shapes). */
export type CronFrequency = "hourly" | "daily" | "weekdays" | "weekly" | "monthly" | "custom";
export type CustomRepeatUnit = "minute" | "hourly" | "daily" | "weekly" | "monthly" | "yearly";
export type CustomMonthlyMode = "date" | "weekday";

export interface CronBuilderState {
  frequency: CronFrequency;
  /** daily/weekly/monthly: 0-23 */
  hour: number;
  /** daily/weekly/monthly: 0-59 */
  minute: number;
  /** weekly: set of 0 (Sunday) through 6 (Saturday) */
  weekdays: number[];
  /** monthly: 1-31 */
  dayOfMonth: number;
  /** custom: raw 5-field cron */
  rawExpr: string;
  customInterval: number;
  customUnit: CustomRepeatUnit;
  customWeekdays: number[];
  customMonthDays: number[];
  /** yearly: 1-12 as human months (day reuses customMonthDays[0]). */
  customMonth: number;
  customMonthlyMode: CustomMonthlyMode;
}

export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

const pad2 = (value: number): string => String(value).padStart(2, "0");
const AUTOMATION_CARD_RELATIVE_NEXT_RUN_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

export function isSessionCreatedAutomation(
  automation: { targetTaskId?: string } | null | undefined,
): boolean {
  return Boolean(automation?.targetTaskId?.trim());
}

export function buildAutomationEditCronExpr(
  state: CronBuilderState,
  automation: { cronExpr: string; targetTaskId?: string } | null | undefined,
): string {
  // Bugfix: in-session crons may exceed the UI builder's expressiveness; preserve them verbatim while editing other fields.
  return isSessionCreatedAutomation(automation) ? automation!.cronExpr : buildCronExpr(state);
}

/** Assemble cron builder state into a 5-field cron expression (minute hour dom mon dow). */
export function buildCronExpr(state: CronBuilderState): string {
  const { frequency, hour, minute, weekdays, dayOfMonth, rawExpr } = state;
  switch (frequency) {
    case "hourly":
      // Minute <minute> of every hour.
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly": {
      const days = weekdays.length > 0 ? [...weekdays].sort((a, b) => a - b).join(",") : "*";
      return `${minute} ${hour} * * ${days}`;
    }
    case "monthly":
      return `${minute} ${hour} ${dayOfMonth} * *`;
    case "custom": {
      const interval = Math.max(1, Math.floor(state.customInterval));
      if (state.customUnit === "minute") {
        // croner caps minute steps at 59; every-61-minutes as `*/61` fails save validation.
        // The real interval lives in scheduleRule; beyond cron's power, keep only a legal every-minute candidate.
        return interval <= 59 ? `*/${interval} * * * *` : "* * * * *";
      }
      if (state.customUnit === "hourly") {
        // croner caps hour steps at 24; `*/31` fails save validation.
        // The real interval lives in scheduleRule; keep only a legal hourly candidate.
        return interval <= 24 ? `${minute} */${interval} * * *` : `${minute} * * * *`;
      }
      if (state.customUnit === "daily") {
        // croner caps day steps at 31; `*/32` fails save validation.
        // The real interval lives in scheduleRule; keep only a legal daily candidate.
        return interval <= 31 ? `${minute} ${hour} */${interval} * *` : `${minute} ${hour} * * *`;
      }
      if (state.customUnit === "weekly") {
        const days = state.customWeekdays.length > 0 ? state.customWeekdays.join(",") : "1";
        return `${minute} ${hour} * * ${days}`;
      }
      if (state.customUnit === "monthly") {
        // Writing the interval into the month field turns every-29-months into `*/29`, but cron
        // months only allow 1-12. The real interval lives in scheduleRule; keep a legal monthly candidate.
        if (state.customMonthlyMode === "weekday") {
          return `${minute} ${hour} * * ${state.customWeekdays[0] ?? 1}#1`;
        }
        const days = state.customMonthDays.length > 0 ? state.customMonthDays.join(",") : "1";
        return `${minute} ${hour} ${days} * *`;
      }
      // yearly: assemble `M H DOM MON *` from the picked month/day (no longer pinned to the current month).
      const yearMonth = Math.min(12, Math.max(1, Math.floor(state.customMonth)));
      const yearDay = state.customMonthDays[0] ?? new Date().getDate();
      return `${minute} ${hour} ${yearDay} ${yearMonth} *`;
    }
    default:
      return rawExpr.trim();
  }
}

/** Best-effort reverse parse of a cron back into builder state; unknown shapes fall to custom. */
export function parseCronToBuilder(expr: string): CronBuilderState {
  const fallback: CronBuilderState = {
    frequency: "custom",
    hour: 9,
    minute: 0,
    weekdays: [1],
    dayOfMonth: 1,
    rawExpr: expr,
    customInterval: 1,
    customUnit: "daily",
    customWeekdays: [1],
    customMonthDays: [1],
    customMonth: new Date().getMonth() + 1,
    customMonthlyMode: "date",
  };
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return fallback;
  const min = parts[0]!;
  const hr = parts[1]!;
  const dom = parts[2]!;
  const mon = parts[3]!;
  const dow = parts[4]!;
  const minNum = Number(min);
  const hrNum = Number(hr);
  const isNum = (v: string) => /^\d+$/.test(v);

  const minuteInterval = /^\*\/([1-9]\d*)$/.exec(min);
  if (minuteInterval && hr === "*" && dom === "*" && mon === "*" && dow === "*") {
    return {
      ...fallback,
      frequency: "custom",
      customInterval: Number(minuteInterval[1]),
      customUnit: "minute",
    };
  }

  const hourlyInterval = /^\*\/(\d+)$/.exec(hr);
  if (isNum(min) && hourlyInterval && dom === "*" && mon === "*" && dow === "*") {
    return {
      ...fallback,
      frequency: "custom",
      minute: minNum,
      customInterval: Math.max(1, Number(hourlyInterval[1])),
      customUnit: "hourly",
    };
  }
  const dailyInterval = /^\*\/(\d+)$/.exec(dom);
  if (isNum(min) && isNum(hr) && dailyInterval && mon === "*" && dow === "*") {
    return {
      ...fallback,
      frequency: "custom",
      hour: hrNum,
      minute: minNum,
      customInterval: Math.max(1, Number(dailyInterval[1])),
      customUnit: "daily",
    };
  }

  // Hourly: `M * * * *`
  if (isNum(min) && hr === "*" && dom === "*" && mon === "*" && dow === "*") {
    return { ...fallback, frequency: "hourly", minute: minNum };
  }
  // Daily: `M H * * *`
  if (isNum(min) && isNum(hr) && dom === "*" && mon === "*" && dow === "*") {
    return { ...fallback, frequency: "daily", hour: hrNum, minute: minNum };
  }
  // Weekdays: `M H * * 1-5`
  if (isNum(min) && isNum(hr) && dom === "*" && mon === "*" && dow === "1-5") {
    return { ...fallback, frequency: "weekdays", hour: hrNum, minute: minNum };
  }
  // Weekly: `M H * * D(,D...)`
  if (isNum(min) && isNum(hr) && dom === "*" && mon === "*" && dow !== "*") {
    const days = dow
      .split(",")
      .map((d) => Number(d))
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (days.length > 0) {
      return { ...fallback, frequency: "weekly", hour: hrNum, minute: minNum, weekdays: days };
    }
  }
  // Yearly: `M H DOM MON *` (month 1-12, distinct from monthly's `MON === "*"`)
  if (isNum(min) && isNum(hr) && isNum(dom) && isNum(mon) && dow === "*") {
    const monthNum = Number(mon);
    if (monthNum >= 1 && monthNum <= 12) {
      return {
        ...fallback,
        frequency: "custom",
        hour: hrNum,
        minute: minNum,
        customUnit: "yearly",
        customMonth: monthNum,
        customMonthDays: [Number(dom)],
      };
    }
  }
  // Monthly: `M H DOM * *`
  if (isNum(min) && isNum(hr) && isNum(dom) && mon === "*" && dow === "*") {
    return {
      ...fallback,
      frequency: "monthly",
      hour: hrNum,
      minute: minNum,
      dayOfMonth: Number(dom),
    };
  }
  return fallback;
}

function weekdayLabel(day: number, intl: IntlLike): string {
  return intl.formatMessage({ id: `automations.weekday.${day}` });
}

/** Builder to readable schedule summary; used directly while editing so custom rules never lose UI semantics in a cron round-trip. */
export function describeCronBuilder(state: CronBuilderState, intl: IntlLike): string {
  const time = `${pad2(state.hour)}:${pad2(state.minute)}`;
  switch (state.frequency) {
    case "hourly":
      return intl.formatMessage(
        { id: "automations.schedule.hourly" },
        { minute: pad2(state.minute) },
      );
    case "daily":
      return intl.formatMessage({ id: "automations.schedule.daily" }, { time });
    case "weekdays":
      return intl.formatMessage({ id: "automations.schedule.weekdays" }, { time });
    case "weekly": {
      const days = [...state.weekdays]
        .sort((a, b) => WEEKDAY_ORDER.indexOf(a as never) - WEEKDAY_ORDER.indexOf(b as never))
        .map((d) => weekdayLabel(d, intl))
        .join("、");
      return intl.formatMessage({ id: "automations.schedule.weekly" }, { days, time });
    }
    case "monthly":
      return intl.formatMessage(
        { id: "automations.schedule.monthly" },
        { day: String(state.dayOfMonth), time },
      );
    case "custom": {
      if (state.customUnit === "minute") {
        return intl.formatMessage(
          { id: "automations.schedule.customMinutes" },
          { interval: String(state.customInterval) },
        );
      }
      if (state.customUnit === "hourly") {
        // Hourly has no fixed hour; the shared time template would present the
        // default hour=9 reserved for other frequencies as 09:00.
        return intl.formatMessage(
          { id: "automations.schedule.customHourly" },
          {
            interval: String(state.customInterval),
            time: pad2(state.minute),
          },
        );
      }
      if (state.customUnit === "weekly") {
        const days = state.customWeekdays
          .map((day) => weekdayLabel(day, intl))
          .join(intl.formatMessage({ id: "automations.weekday.separator" }));
        return intl.formatMessage(
          { id: "automations.schedule.customWeekly" },
          { interval: String(state.customInterval), days, time },
        );
      }
      if (state.customUnit === "monthly") {
        if (state.customMonthlyMode === "weekday") {
          return intl.formatMessage(
            { id: "automations.schedule.customMonthlyWeekday" },
            {
              interval: String(state.customInterval),
              day: weekdayLabel(state.customWeekdays[0] ?? 1, intl),
              time,
            },
          );
        }
        return intl.formatMessage(
          { id: "automations.schedule.customMonthlyDates" },
          {
            interval: String(state.customInterval),
            days: state.customMonthDays.join(", "),
            time,
          },
        );
      }
      if (state.customUnit === "yearly") {
        return intl.formatMessage(
          { id: "automations.schedule.customYearly" },
          {
            interval: String(state.customInterval),
            month: String(state.customMonth),
            day: String(state.customMonthDays[0] ?? 1),
            time,
          },
        );
      }
      // Only daily remains here (hourly/weekly/monthly/yearly handled above).
      const unitId = "automations.customRepeat.unit.day";
      return intl.formatMessage(
        { id: "automations.schedule.custom" },
        {
          interval: String(state.customInterval),
          unit: intl.formatMessage({ id: unitId }),
          time,
        },
      );
    }
    default:
      return state.rawExpr;
  }
}

/** Cron to readable schedule summary (e.g. daily 09:00, Mon and Wed 18:30); unknown falls back to the raw expression. */
export function describeCron(expr: string, intl: IntlLike): string {
  const normalizedExpr = expr.trim().replace(/\s+/g, " ");
  const minuteInterval = /^\*\/([1-9]\d*) \* \* \* \*$/.exec(normalizedExpr);
  if (minuteInterval) {
    return intl.formatMessage(
      { id: "automations.schedule.customMinutes" },
      { interval: minuteInterval[1]! },
    );
  }

  // A 5-field cron carries no year, so `M H DOM MON *` cannot tell a one-off date from a yearly repeat.
  // The card must not guess product semantics nor expose the raw expression, so it labels these custom.
  if (/^\d+ \d+ \d+ \d+ \*$/.test(normalizedExpr)) {
    return intl.formatMessage({ id: "automations.frequency.custom" });
  }
  // `M H DOM */N *` cannot be restored reliably in the normal schedule editor; the card labels it custom too.
  if (/^\d+ \d+ \d+ \*\/\d+ \*$/.test(normalizedExpr)) {
    return intl.formatMessage({ id: "automations.frequency.custom" });
  }

  const builder = parseCronToBuilder(normalizedExpr);
  // Unrecognized crons land in a custom state with the 09:00 default; never present that default as the real schedule.
  if (builder.frequency === "custom" && buildCronExpr(builder) !== normalizedExpr) {
    return intl.formatMessage({ id: "automations.frequency.custom" });
  }
  return describeCronBuilder(builder, intl);
}

/** Whether the UI scheduler builder can echo a cron losslessly; fixed month/day and unknown shapes must go through the custom-replace flow. */
export function canVisualizeCronInAutomationEditor(expr: string): boolean {
  const normalizedExpr = expr.trim().replace(/\s+/g, " ");
  if (/^\d+ \d+ \d+ \d+ \*$/.test(normalizedExpr)) return false;
  if (/^\d+ \d+ \d+ \*\/\d+ \*$/.test(normalizedExpr)) return false;
  const builder = parseCronToBuilder(normalizedExpr);
  return buildCronExpr(builder) === normalizedExpr;
}

/** Local tz offset to GMT label; supports half-hour zones such as GMT+8 and GMT+5:30. */
export function formatGmtOffset(offsetMinutes = -new Date().getTimezoneOffset()): string {
  if (offsetMinutes === 0) return "GMT";
  const sign = offsetMinutes > 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `GMT${sign}${hours}${minutes > 0 ? `:${pad2(minutes)}` : ""}`;
}

/** Millisecond timestamp to local date-time (YYYY-MM-DD HH:MM). */
export function formatDateTime(ts: number | undefined): string {
  if (!ts) return "-";
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Relative time (e.g. in 2h, 3d ago) for next run / last run. */
export function formatRelativeToNow(ts: number | undefined, now: number, intl: IntlLike): string {
  if (!ts) return "-";
  const diff = ts - now;
  const abs = Math.abs(diff);
  const future = diff >= 0;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  let value: number;
  let unitId: string;
  if (abs < minute) {
    return intl.formatMessage({
      id: future ? "automations.time.soon" : "automations.time.justNow",
    });
  }
  if (abs < hour) {
    value = Math.round(abs / minute);
    unitId = "automations.time.minutes";
  } else if (abs < day) {
    value = Math.round(abs / hour);
    unitId = "automations.time.hours";
  } else {
    value = Math.round(abs / day);
    unitId = "automations.time.days";
  }
  const amount = intl.formatMessage({ id: unitId }, { value: String(value) });
  return intl.formatMessage(
    { id: future ? "automations.time.in" : "automations.time.ago" },
    { amount },
  );
}

/** Automation card next-run time: hidden once past; relative within a month, absolute beyond. */
export function formatAutomationCardNextRun(
  ts: number | undefined,
  now: number,
  intl: IntlLike,
): string | null {
  if (!ts || ts <= now) return null;
  return ts - now <= AUTOMATION_CARD_RELATIVE_NEXT_RUN_THRESHOLD_MS
    ? formatRelativeToNow(ts, now, intl)
    : formatDateTime(ts);
}

/** Duration (ms) to readable text (e.g. 1m 20s, 3s). */
export function formatDuration(startTs: number | undefined, endTs: number | undefined): string {
  if (!startTs || !endTs || endTs < startTs) return "-";
  const totalSec = Math.round((endTs - startTs) / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min <= 0) return `${sec}s`;
  return `${min}m ${sec}s`;
}
