import type { ZCodeAutomationScheduleRule } from "@zcode/shared";
import {
  describeCron,
  describeCronBuilder,
  type CronBuilderState,
  type IntlLike,
} from "@/settings/automationFormat.js";

function scheduleRuleToBuilder(rule: ZCodeAutomationScheduleRule): CronBuilderState {
  return {
    frequency: "custom",
    hour: rule.hour,
    minute: rule.minute,
    weekdays: rule.weekdays ?? [1],
    dayOfMonth: rule.monthDays?.[0] ?? 1,
    rawExpr: "",
    customInterval: rule.interval,
    customUnit: rule.unit,
    customWeekdays: rule.weekdays ?? [1],
    customMonthDays: rule.monthDays ?? [1],
    customMonth: rule.months?.[0] ?? new Date(rule.anchorAt).getMonth() + 1,
    customMonthlyMode: rule.monthlyMode ?? "date",
  };
}

/** Cards prefer the authoritative scheduleRule; only legacy data without one derives a summary from the compat cron. */
export function describeAutomationCardSchedule(
  automation: {
    cronExpr: string;
    scheduleRule?: ZCodeAutomationScheduleRule;
    recurring?: boolean;
    maxRuns?: number;
  },
  intl: IntlLike,
): string {
  // Relative one-shot tasks (remind in 4 minutes) persist as a minute scheduleRule for compat display,
  // which describeCronBuilder misreads as an every-4-minutes repeat. One-shots run once, no frequency;
  // like fixed-date one-shots, display custom; the true timing lives in the next-run copy.
  if (automation.recurring === false && (automation.maxRuns ?? 1) <= 1) {
    return intl.formatMessage({ id: "automations.frequency.custom" });
  }
  // Long-month compat crons are fixed monthly candidates; cron-only parsing misreads every-30-months as monthly.
  if (automation.scheduleRule) {
    return describeCronBuilder(scheduleRuleToBuilder(automation.scheduleRule), intl);
  }
  return describeCron(automation.cronExpr, intl);
}
