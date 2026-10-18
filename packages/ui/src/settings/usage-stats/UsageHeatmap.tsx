/* oxlint-disable max-lines -- the heatmap keeps daily, weekly and cumulative rollups in one file; splitting would fracture the shared column model. */
import { useState } from "react";
import type { AppUsageHeatmapCell, AppUsageHeatmapWeek } from "@zcode/shared";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  HeatmapColumn,
  type HeatmapDisplayColumn,
  type TokenActivityMode,
} from "@/settings/usage-stats/UsageHeatmapCells.js";
import {
  USAGE_STATS_TABS_LIST_CLASS,
  USAGE_STATS_TABS_TRIGGER_CLASS,
  formatCompactNumber,
  formatCompactTokenUsage,
  formatFullDay,
  formatMonth,
} from "@/settings/usage-stats/usageStatsUiParts.js";

const HEATMAP_DISPLAY_WEEK_COUNT = 52;
const HEATMAP_DAYS_PER_WEEK = 7;
const DAY_MS = 86_400_000;
const HEATMAP_VISIBLE_MONTH_LABEL_COUNT = 12;
const TOKEN_ACTIVITY_MODES = ["daily", "weekly", "cumulative"] as const;
const HEATMAP_GRID_STYLE = {
  // A fixed 14px min column width plus 4px gap pushes the 52-week grid past its container,
  // breaking the show-it-all-at-once product rule. Columns return to shrinkable 1fr so desktop, web
  // and mobile split one container width evenly, with no second horizontal scroll area.
  gridTemplateColumns: `repeat(${HEATMAP_DISPLAY_WEEK_COUNT}, minmax(0, 1fr))`,
};

interface HeatmapMonthLabel {
  key: string;
  label: string;
  span: number;
}

type HeatmapCountMetric = "turns" | "tools";

function renderHeatmapTooltipTitle(
  locale: string,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  cell: AppUsageHeatmapCell,
  countMetric: HeatmapCountMetric,
): string {
  return intl.formatMessage(
    {
      id: countMetric === "tools" ? "settings.usage.heatmapToolCell" : "settings.usage.heatmapCell",
    },
    {
      date: formatFullDay(locale, cell.date),
      tokens: formatCompactTokenUsage(locale, cell.totalTokens),
      turns: formatCompactNumber(locale, cell.turnCount),
      tools: formatCompactNumber(locale, cell.toolCallCount),
    },
  );
}

function renderWeeklyHeatmapTooltipTitle(
  locale: string,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  date: string,
  totalTokens: number,
  count: number,
  countMetric: HeatmapCountMetric,
): string {
  return intl.formatMessage(
    {
      id:
        countMetric === "tools"
          ? "settings.usage.heatmapWeeklyToolCell"
          : "settings.usage.heatmapWeeklyCell",
    },
    {
      date: formatFullDay(locale, date),
      tokens: formatCompactTokenUsage(locale, totalTokens),
      turns: formatCompactNumber(locale, count),
      tools: formatCompactNumber(locale, count),
    },
  );
}

function renderCumulativeHeatmapTooltipTitle(
  locale: string,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  date: string,
  totalTokens: number,
  count: number,
  countMetric: HeatmapCountMetric,
): string {
  return intl.formatMessage(
    {
      id:
        countMetric === "tools"
          ? "settings.usage.heatmapCumulativeToolCell"
          : "settings.usage.heatmapCumulativeCell",
    },
    {
      date: formatFullDay(locale, date),
      tokens: formatCompactTokenUsage(locale, totalTokens),
      turns: formatCompactNumber(locale, count),
      tools: formatCompactNumber(locale, count),
    },
  );
}

function dateKeyToUtcDayIndex(dateKey: string): number | null {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return Math.floor(date.getTime() / DAY_MS);
}

function getUtcWeekday(dayIndex: number): number {
  return new Date(dayIndex * DAY_MS).getUTCDay();
}

function utcDayIndexToDateKey(dayIndex: number): string {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
}

function createEmptyHeatmapCell(date: string): AppUsageHeatmapCell {
  return {
    date,
    level: 0,
    totalTokens: 0,
    turnCount: 0,
    toolCallCount: 0,
  };
}

function buildDisplayHeatmapWeeks(weeks: AppUsageHeatmapWeek[]): AppUsageHeatmapWeek[] {
  const cells = weeks
    .flatMap((week) => week.days)
    .filter((cell): cell is AppUsageHeatmapCell => cell !== null);
  const datedCells = cells
    .map((cell) => ({ cell, dayIndex: dateKeyToUtcDayIndex(cell.date) }))
    .filter(
      (entry): entry is { cell: AppUsageHeatmapCell; dayIndex: number } => entry.dayIndex !== null,
    );

  if (datedCells.length === 0) {
    return weeks;
  }

  const cellsByDate = new Map(datedCells.map(({ cell }) => [cell.date, cell] as const));
  const endDayIndex = Math.max(...datedCells.map(({ dayIndex }) => dayIndex));
  const endWeekStartDayIndex = endDayIndex - getUtcWeekday(endDayIndex);
  const startDayIndex =
    endWeekStartDayIndex - (HEATMAP_DISPLAY_WEEK_COUNT - 1) * HEATMAP_DAYS_PER_WEEK;

  // The agent returns only the last 30 days of real data, which would shrink the heatmap; pad
  // display-only zero cells here, aligned to calendar weeks so every range starts its first row on
  // Sunday.
  return Array.from({ length: HEATMAP_DISPLAY_WEEK_COUNT }, (_, weekIndex) => ({
    weekIndex,
    days: Array.from({ length: HEATMAP_DAYS_PER_WEEK }, (_, dayOffset) => {
      const dayIndex = startDayIndex + weekIndex * HEATMAP_DAYS_PER_WEEK + dayOffset;
      const date = utcDayIndexToDateKey(dayIndex);
      return cellsByDate.get(date) ?? createEmptyHeatmapCell(date);
    }),
  }));
}

function levelForValue(value: number, max: number): AppUsageHeatmapCell["level"] {
  if (value <= 0 || max <= 0) {
    return 0;
  }
  return Math.min(4, Math.max(1, Math.ceil((value / max) * 4))) as AppUsageHeatmapCell["level"];
}

function filledRowsForValue(value: number, max: number): number {
  if (value <= 0 || max <= 0) {
    return 0;
  }
  return Math.min(
    HEATMAP_DAYS_PER_WEEK,
    Math.max(1, Math.ceil((value / max) * HEATMAP_DAYS_PER_WEEK)),
  );
}

function resolveHeatmapColumnMonthDate(week: AppUsageHeatmapWeek): string {
  // Deciding months by Sunday would push a non-Sunday 1st into the next week, mislabeling by up to
  // one column. When a week column contains the 1st, assign it to the new month so the label anchors
  // to the 1st's column; other columns keep the Sunday-anchored month.
  const firstDayOfMonth = week.days.find((cell) => cell?.date.endsWith("-01"));
  return firstDayOfMonth?.date ?? week.days[0]?.date ?? week.days.find(Boolean)?.date ?? "";
}

function buildDailyHeatmapColumns(
  locale: string,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  weeks: AppUsageHeatmapWeek[],
  countMetric: HeatmapCountMetric,
): HeatmapDisplayColumn[] {
  return weeks.map((week) => ({
    key: `daily-${week.weekIndex}`,
    monthDate: resolveHeatmapColumnMonthDate(week),
    tooltipTitle: null,
    cells: week.days.map((cell, dayOffset) => {
      const fallbackDate = week.days[0]?.date ?? `empty-${week.weekIndex}-${dayOffset}`;
      const displayCell = cell ?? createEmptyHeatmapCell(fallbackDate);
      return {
        key: `daily-${displayCell.date}`,
        level: displayCell.level,
        hasUsage: displayCell.totalTokens > 0,
        columnHover: false,
        tooltipTitle: renderHeatmapTooltipTitle(locale, intl, displayCell, countMetric),
      };
    }),
  }));
}

function buildWeeklyLikeHeatmapColumns(
  locale: string,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  weeks: AppUsageHeatmapWeek[],
  mode: Extract<TokenActivityMode, "weekly" | "cumulative">,
  countMetric: HeatmapCountMetric,
): HeatmapDisplayColumn[] {
  const weeklyTotals = weeks.map((week) =>
    week.days.reduce((sum, cell) => sum + (cell?.totalTokens ?? 0), 0),
  );
  const weeklyCounts = weeks.map((week) =>
    week.days.reduce(
      (sum, cell) =>
        sum + (countMetric === "tools" ? (cell?.toolCallCount ?? 0) : (cell?.turnCount ?? 0)),
      0,
    ),
  );
  const values =
    mode === "weekly"
      ? weeklyTotals
      : weeklyTotals.reduce<number[]>((acc, total) => {
          acc.push((acc.at(-1) ?? 0) + total);
          return acc;
        }, []);
  const countValues =
    mode === "weekly"
      ? weeklyCounts
      : weeklyCounts.reduce<number[]>((acc, total) => {
          acc.push((acc.at(-1) ?? 0) + total);
          return acc;
        }, []);
  const maxValue = Math.max(0, ...values);

  return weeks.map((week, weekIndex) => {
    const value = values[weekIndex] ?? 0;
    const count = countValues[weekIndex] ?? 0;
    const level = levelForValue(value, maxValue);
    const filledRows = filledRowsForValue(value, maxValue);
    const weekEndDate =
      week.days[HEATMAP_DAYS_PER_WEEK - 1]?.date ??
      week.days.findLast((cell) => cell !== null)?.date ??
      "";
    const tooltipTitle =
      mode === "weekly"
        ? renderWeeklyHeatmapTooltipTitle(locale, intl, weekEndDate, value, count, countMetric)
        : renderCumulativeHeatmapTooltipTitle(locale, intl, weekEndDate, value, count, countMetric);

    return {
      key: `${mode}-${week.weekIndex}`,
      monthDate: resolveHeatmapColumnMonthDate(week) || weekEndDate,
      tooltipTitle,
      cells: week.days.map((cell, dayOffset) => {
        const isFilled = dayOffset >= HEATMAP_DAYS_PER_WEEK - filledRows;
        return {
          key: `${mode}-${cell?.date ?? `${week.weekIndex}-${dayOffset}`}`,
          level: isFilled ? level : 0,
          hasUsage: isFilled && value > 0,
          columnHover: true,
        };
      }),
    };
  });
}

function buildHeatmapDisplayColumns(
  locale: string,
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  weeks: AppUsageHeatmapWeek[],
  mode: TokenActivityMode,
  countMetric: HeatmapCountMetric,
): HeatmapDisplayColumn[] {
  if (mode === "daily") {
    return buildDailyHeatmapColumns(locale, intl, weeks, countMetric);
  }
  return buildWeeklyLikeHeatmapColumns(locale, intl, weeks, mode, countMetric);
}

function buildHeatmapMonthLabels(
  locale: string,
  columns: HeatmapDisplayColumn[],
): HeatmapMonthLabel[] {
  const labels: HeatmapMonthLabel[] = [];

  for (const column of columns) {
    const monthKey = column.monthDate.slice(0, 7);
    const lastLabel = labels.at(-1);
    if (lastLabel?.key === monthKey) {
      lastLabel.span += 1;
    } else {
      labels.push({
        key: monthKey,
        label: formatMonth(locale, column.monthDate),
        span: 1,
      });
    }
  }

  // 52 calendar weeks can span 13 months; rendering them all shows the same month from last year
  // and this year along the bottom. Keep extra leading-month spans to preserve month/column
  // alignment but hide their text: at most the latest 12 months render at the bottom.
  const hiddenLabelCount = Math.max(0, labels.length - HEATMAP_VISIBLE_MONTH_LABEL_COUNT);
  for (let index = 0; index < hiddenLabelCount; index += 1) {
    const label = labels[index];
    if (label) {
      label.label = "";
    }
  }

  return labels;
}

export function UsageHeatmap({
  locale,
  intl,
  weeks,
  countMetric = "turns",
}: {
  locale: string;
  intl: ReturnType<typeof useZCodeIntl>["intl"];
  weeks: AppUsageHeatmapWeek[];
  /** Coding Plan remotes provide mcpCalls only; real conversation turns come from App Usage. */
  countMetric?: HeatmapCountMetric;
}) {
  const [mode, setMode] = useState<TokenActivityMode>("daily");
  const displayWeeks = buildDisplayHeatmapWeeks(weeks);
  const displayColumns = buildHeatmapDisplayColumns(locale, intl, displayWeeks, mode, countMetric);
  const monthLabels = buildHeatmapMonthLabels(locale, displayColumns);

  return (
    <div className="space-y-4">
      <div className="rounded-xl bg-surface px-3 py-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="min-w-0 truncate text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.usage.heatmapTitle" })}
          </h3>
          <Tabs
            value={mode}
            onValueChange={(value) => setMode(value as TokenActivityMode)}
            className="shrink-0"
          >
            <TabsList className={USAGE_STATS_TABS_LIST_CLASS}>
              {TOKEN_ACTIVITY_MODES.map((option) => (
                <TabsTrigger
                  key={option}
                  value={option}
                  onClick={() => setMode(option)}
                  className={USAGE_STATS_TABS_TRIGGER_CLASS}
                >
                  {intl.formatMessage({
                    id: `settings.usage.heatmap.range.${option}`,
                  })}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>

        <div>
          <div className="grid w-full gap-x-0.5" style={HEATMAP_GRID_STYLE}>
            {displayColumns.map((column) => (
              <HeatmapColumn key={column.key} column={column} mode={mode} />
            ))}
          </div>
          <div className="mt-3 grid w-full gap-x-0.5" style={HEATMAP_GRID_STYLE}>
            {monthLabels.map((label) => (
              <div
                key={label.key}
                data-usage-heatmap-month-label
                className="min-w-0 truncate text-ui-sm text-foreground-subtle"
                style={{ gridColumn: `span ${label.span}` }}
              >
                {label.label}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
