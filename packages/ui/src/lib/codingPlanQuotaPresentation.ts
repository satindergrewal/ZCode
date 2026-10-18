import type { UsageEntitlementSnapshot, UsageQuotaLimit } from "@zcode/shared";

export type CodingPlanQuotaResetFormat = "date" | "dateTime" | "adaptive";

/**
 * Equivalent type set for token/credit quotas.
 *
 * The zai backend tags Team Plan quota/limits `CREDIT_LIMIT`;
 * bigmodel uses `TOKENS_LIMIT`. unit/number semantics match exactly
 * (unit=3,number=5 -> 5-hour window; unit=6 -> weekly); only the type enum name differs.
 * Treat the two as equivalent so zai/bigmodel team plans hit the same UI consumers.
 * If zai later aligns on TOKENS_LIMIT, the set still matches.
 */
const TOKEN_LIMIT_TYPES = new Set(["TOKENS_LIMIT", "CREDIT_LIMIT"]);

/**
 * The tool-quota type.
 * Both backends use TIME_LIMIT for the monthly tool quota today; no equivalence set needed yet.
 */
const TOOL_LIMIT_TYPES = new Set(["TIME_LIMIT"]);

export function isSameLimitCategory(
  limitType: string,
  queryType: UsageQuotaLimit["type"],
): boolean {
  if (limitType === queryType) {
    return true;
  }
  // zai team plan returns CREDIT_LIMIT; consumers querying by TOKENS_LIMIT must still match.
  if (TOKEN_LIMIT_TYPES.has(queryType)) {
    return TOKEN_LIMIT_TYPES.has(limitType);
  }
  if (TOOL_LIMIT_TYPES.has(queryType)) {
    return TOOL_LIMIT_TYPES.has(limitType);
  }
  return false;
}

export function findCodingPlanQuotaLimit(
  limits: UsageQuotaLimit[] | undefined,
  type: UsageQuotaLimit["type"],
  unit: number,
  number?: number,
): UsageQuotaLimit | null {
  return (
    limits?.find(
      (limit) =>
        isSameLimitCategory(limit.type, type) &&
        limit.unit === unit &&
        (number == null || limit.number === number),
    ) ?? null
  );
}

/**
 * Official Server MCP quota (total granted by the server).
 *
 * The server holds it in a dedicated entitlement field, not quota.limits[], so
 * findCodingPlanQuotaLimit cannot fetch it; funnel every reader through here instead of per-slot `?.` chains.
 */
export function resolveMcpQuotaLimit(
  snapshot: UsageEntitlementSnapshot | null | undefined,
): UsageQuotaLimit | null {
  return snapshot?.mcpQuota?.aggregate ?? null;
}

export function normalizeQuotaPercentage(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}

export function getQuotaRemainingPercentage(limit: UsageQuotaLimit | null): number | null {
  if (typeof limit?.percentage !== "number" || !Number.isFinite(limit.percentage)) {
    return null;
  }

  // The quota endpoint's percentage is usage, while Usage Remaining and the usage-stats
  // quota card express "how much is left". Invert once here so both surfaces agree.
  return Math.max(0, Math.min(100, 100 - limit.percentage));
}

export function formatQuotaRemainingPercentage(
  locale: string,
  limit: UsageQuotaLimit | null,
): string {
  const remainingPercentage = getQuotaRemainingPercentage(limit);
  if (remainingPercentage == null) {
    return "--";
  }

  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits: remainingPercentage >= 10 ? 0 : 1,
  }).format(remainingPercentage)}%`;
}

/**
 * The single formatter for Start Plan bucket refresh times (settings balance card and composer bubble).
 *
 * Both sides once kept verbatim-identical formatStartPlanBalanceRenewTime copies;
 * any missed format edit diverged them again. Bucket refresh format matches Coding Plan:
 * HH:mm today, date-only otherwise.
 */
export function formatStartPlanBucketResetTime(
  locale: string,
  value: number | null | undefined,
): string | undefined {
  return formatQuotaResetTime({ locale, value, format: "adaptive" });
}

export function formatQuotaResetTime(params: {
  locale: string;
  value: number | null | undefined;
  format: CodingPlanQuotaResetFormat;
  compactToday?: boolean;
}): string | undefined {
  if (!params.value) {
    return undefined;
  }

  const resetAt = new Date(params.value);
  if (Number.isNaN(resetAt.getTime())) {
    return undefined;
  }

  const now = new Date();
  const isToday =
    resetAt.getFullYear() === now.getFullYear() &&
    resetAt.getMonth() === now.getMonth() &&
    resetAt.getDate() === now.getDate();

  if (params.format === "date") {
    return new Intl.DateTimeFormat(params.locale, {
      month: "short",
      day: "numeric",
    }).format(resetAt);
  }

  // adaptive: today renders time-only HH:mm (an actionable instant); other days render
  // date-only (same presentation semantics as Coding Plan 5-hour windows / weekly-monthly resets).
  if (params.format === "adaptive") {
    if (isToday) {
      return new Intl.DateTimeFormat(params.locale, {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(resetAt);
    }
    return new Intl.DateTimeFormat(params.locale, {
      month: "short",
      day: "numeric",
    }).format(resetAt);
  }

  return new Intl.DateTimeFormat(params.locale, {
    ...(params.compactToday && isToday
      ? {}
      : {
          month: "short",
          day: "numeric",
        }),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(resetAt);
}
