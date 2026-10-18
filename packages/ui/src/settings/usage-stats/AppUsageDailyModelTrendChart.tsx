import { type ComponentProps, useCallback, useMemo } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import type { AppUsageSnapshot } from "@zcode/shared";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  UsageEmptyState,
  formatCompactTokenUsage,
  formatDay,
  resolveModelLabel,
} from "@/settings/usage-stats/usageStatsUiParts.js";
import { getAppUsageModelChartColor } from "@/settings/usage-stats/appUsageChartPalette.js";

// XAxis end ticks extend half their width past the plot bounds; the old 8px margin is narrower
// than half a date label, so SVG clipped the first/last text. A 24px safe area on both sides keeps
// short dates fully visible on desktop and mobile web.
export const APP_USAGE_TREND_CHART_MARGIN = {
  top: 8,
  right: 24,
  left: 24,
} as const;

type DailyModelChartRow = {
  label: string;
  tooltipLabel: string;
  total: number;
} & Record<string, number | string>;

type ModelChartKey = {
  modelId: string | null;
  key: string;
  color: string;
  label: string;
};
type UsageIntl = ReturnType<typeof useZCodeIntl>["intl"];
type ChartTooltipContentProps = ComponentProps<typeof ChartTooltipContent>;

export function filterDailyModelTooltipPayload<T extends { value?: unknown }>(
  payload: readonly T[] | undefined,
): T[] {
  // Recharts multi-series tooltip payloads include every model of the day; zero-usage models have
  // no visible trend point, and listing them reads as hovering real usage.
  return (payload ?? []).filter((item) => {
    const value = typeof item.value === "number" ? item.value : Number(item.value);
    return Number.isFinite(value) && value > 0;
  });
}

export function resolveDailyModelTooltipTokenParts(
  locale: string,
  value: unknown,
  tokenUnit: string,
): { number: string; unit: string } {
  const numericValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numericValue)) {
    return { number: String(value), unit: "" };
  }
  return {
    number: formatCompactTokenUsage(locale, numericValue),
    unit: tokenUnit,
  };
}

function shouldShowDailyChartAxisLabel(index: number, total: number): boolean {
  if (total <= 14) {
    return true;
  }
  const step = total > 45 ? 7 : 5;
  return index === 0 || index === total - 1 || index % step === 0;
}

function createEmptyChartRow(label: string, tooltipLabel: string, modelKeys: ModelChartKey[]) {
  const row: DailyModelChartRow = {
    label,
    tooltipLabel,
    total: 0,
  };

  for (const model of modelKeys) {
    row[model.key] = 0;
  }

  return row;
}

function buildDailyModelChartData({
  snapshot,
  locale,
  modelKeys,
  modelKeyById,
}: {
  snapshot: AppUsageSnapshot;
  locale: string;
  modelKeys: ModelChartKey[];
  modelKeyById: Map<string, string>;
}): DailyModelChartRow[] {
  const rows = new Map<string, DailyModelChartRow>();

  // The App Usage 30d protocol result is already a per-day series; leftover all-bucketing used to
  // aggregate the 30 days weekly into ~5 points, leaving no continuous daily trend.
  for (const day of snapshot.dailyModelUsage) {
    const label = formatDay(locale, day.date);
    const row = rows.get(day.date) ?? createEmptyChartRow(label, label, modelKeys);

    for (const model of day.models) {
      const key = modelKeyById.get(model.modelId ?? "__unknown__");
      if (key) {
        row[key] = Number(row[key] ?? 0) + model.totalTokens;
      }
      row.total += model.totalTokens;
    }

    rows.set(day.date, row);
  }

  return [...rows.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, row]) => row);
}

export function buildAppUsageDailyModelChartViewModel({
  intl,
  locale,
  snapshot,
}: {
  intl: UsageIntl;
  locale: string;
  snapshot: AppUsageSnapshot;
}) {
  const topModels = snapshot.models.slice(0, 6);
  const modelKeys = topModels.map((model, index) => ({
    modelId: model.modelId,
    key: `model${index}`,
    color: getAppUsageModelChartColor(index),
    label: resolveModelLabel(intl, model.modelId),
  }));
  const modelKeyById = new Map(
    modelKeys.map((model) => [model.modelId ?? "__unknown__", model.key]),
  );
  const chartConfig = modelKeys.reduce<ChartConfig>((config, model) => {
    config[model.key] = {
      label: model.label,
      color: model.color,
    };
    return config;
  }, {});
  const chartData = buildDailyModelChartData({
    snapshot,
    locale,
    modelKeys,
    modelKeyById,
  });
  let maxTokens = 0;
  // These are independent lines, not stacked: using the daily total as the Y cap (including
  // unrendered models) presses visible curves to the bottom. The domain must follow the peak single
  // point of visible series only.
  for (const row of chartData) {
    for (const model of modelKeys) {
      maxTokens = Math.max(maxTokens, Number(row[model.key] ?? 0));
    }
  }

  return {
    topModels,
    modelKeys,
    chartConfig,
    chartData,
    maxTokens,
  };
}

function DailyModelChartTooltipContent(props: ChartTooltipContentProps) {
  const filteredPayload = useMemo(
    () => filterDailyModelTooltipPayload(props.payload),
    [props.payload],
  );

  if (!props.active || filteredPayload.length === 0) {
    return null;
  }

  return <ChartTooltipContent {...props} payload={filteredPayload} />;
}

export function AppUsageDailyModelTrendChart({ snapshot }: { snapshot: AppUsageSnapshot }) {
  const { intl, locale } = useZCodeIntl();
  const { topModels, modelKeys, chartConfig, chartData, maxTokens } = useMemo(
    // Recharts 3.8 mirrors data / legend / graphical-item props into its internal store. Keep the
    // derived arrays and config objects referentially stable so parent re-renders do not spam
    // internal dispatches.
    () => buildAppUsageDailyModelChartViewModel({ intl, locale, snapshot }),
    [intl, locale, snapshot],
  );
  const shouldShowAxisLabel = useCallback(
    (_value: string, index: number) =>
      shouldShowDailyChartAxisLabel(index, chartData.length) ? _value : "",
    [chartData.length],
  );
  const formatTooltipLabel = useCallback(
    (_: unknown, payload: readonly { payload?: unknown }[]) => {
      const row = payload[0]?.payload as DailyModelChartRow | undefined;
      const total = typeof row?.total === "number" ? row.total : 0;
      return `${row?.tooltipLabel ?? ""} - ${formatCompactTokenUsage(locale, total)} ${intl.formatMessage(
        {
          id: "settings.usage.tokenUnit",
        },
      )}`;
    },
    [intl, locale],
  );
  const tokenUnit = intl.formatMessage({ id: "settings.usage.tokenUnit" });
  const formatTooltipItem = useCallback(
    (value: unknown, name: unknown, item: { color?: string }) => {
      const itemName = String(name);
      const label = chartConfig[itemName]?.label ?? itemName;
      const color = item.color ?? `var(--color-${itemName})`;
      const tokenValue = resolveDailyModelTooltipTokenParts(locale, value, tokenUnit);
      return (
        <>
          <span
            className="size-2 shrink-0 self-center rounded-full"
            style={{ backgroundColor: color }}
          />
          <div className="flex flex-1 items-center justify-between gap-3">
            <span className="text-foreground-subtle">{label}</span>
            <span className="flex items-baseline gap-1 text-foreground">
              <span className="font-mono font-medium tabular-nums">{tokenValue.number}</span>
              {tokenValue.unit ? (
                <span className="text-foreground-subtle">{tokenValue.unit}</span>
              ) : null}
            </span>
          </div>
        </>
      );
    },
    [chartConfig, locale, tokenUnit],
  );
  const tooltipContent = useMemo(
    () => (
      <DailyModelChartTooltipContent
        indicator="line"
        labelFormatter={formatTooltipLabel}
        formatter={formatTooltipItem}
      />
    ),
    [formatTooltipItem, formatTooltipLabel],
  );

  return (
    <section className="space-y-3 rounded-xl bg-surface p-4">
      <h3 className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "settings.usage.dailyChartTitle" })}
      </h3>
      {maxTokens <= 0 ? (
        <UsageEmptyState
          title={intl.formatMessage({ id: "settings.usage.emptyTitle" })}
          description={intl.formatMessage({
            id: "settings.usage.emptyDescription",
          })}
        />
      ) : (
        <div className="px-3 py-3">
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2" role="list">
            {topModels.map((model, index) => (
              <div
                key={model.modelId ?? "__unknown__"}
                className="flex min-w-0 items-center gap-2 text-ui-sm"
                role="listitem"
              >
                <span
                  className="size-2.5 shrink-0 rounded-sm"
                  style={{
                    backgroundColor: getAppUsageModelChartColor(index),
                  }}
                />
                <span className="truncate text-foreground-subtle">
                  {resolveModelLabel(intl, model.modelId)}
                </span>
              </div>
            ))}
          </div>
          <ChartContainer config={chartConfig} className="h-60 w-full">
            <LineChart accessibilityLayer data={chartData} margin={APP_USAGE_TREND_CHART_MARGIN}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                interval={0}
                minTickGap={0}
                tickMargin={8}
                tickFormatter={shouldShowAxisLabel}
              />
              <YAxis hide domain={[0, maxTokens]} />
              <ChartTooltip cursor={false} content={tooltipContent} />
              {modelKeys.map((model) => (
                <Line
                  key={model.key}
                  dataKey={model.key}
                  type="monotone"
                  stroke={`var(--color-${model.key})`}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              ))}
            </LineChart>
          </ChartContainer>
        </div>
      )}
    </section>
  );
}
