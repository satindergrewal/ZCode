import type { UsageEntitlementSnapshot, UsageQuotaLimit } from "@zcode/shared";

type CodingPlanQuotaResetFormat = "date" | "dateTime" | "adaptive";

/**
 * Equivalent type set for token/credit quotas.
 *
 * The zai business backend reports Team Plan quota/limit with type `CREDIT_LIMIT`
 * while the bigmodel backend uses `TOKENS_LIMIT`. Their unit/number semantics are
 * identical (unit=3,number=5 -> 5-hour window; unit=6 -> weekly); only the type enum
 * name differs. Treating the two types as equivalent lets zai/bigmodel team plans hit
 * the same UI consumers. If the zai backend later aligns on TOKENS_LIMIT, this set
 * remains compatible.
 */
const TOKEN_LIMIT_TYPES = new Set(["TOKENS_LIMIT", "CREDIT_LIMIT"]);

/**
 * Tool quota types.
 * Both bigmodel/zai backends currently use TIME_LIMIT for the monthly tool-call quota,
 * so no equivalent set is needed yet.
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
 * The server stores it in a dedicated entitlement-snapshot field rather than
 * quota.limits[], so findCodingPlanQuotaLimit cannot query it. This funnel is the single
 * access point so each surface does not re-derive its own `?.` chain.
 */
export function resolveMcpQuotaLimit(
  snapshot: UsageEntitlementSnapshot | null | undefined,
): UsageQuotaLimit | null {
  return snapshot?.mcpQuota?.aggregate ?? null;
}

export function getQuotaRemainingPercentage(limit: UsageQuotaLimit | null): number | null {
  if (typeof limit?.percentage !== "number" || !Number.isFinite(limit.percentage)) {
    return null;
  }

  // The quota endpoint's percentage is usage, while Usage Remaining and the usage-stats
  // quota card express "how much is left". Invert once here so both surfaces agree.
  return Math.max(0, Math.min(100, 100 - limit.percentage));
}

/**
 * At 100% remaining (nothing consumed yet) a reset has no value, so the UI hides the
 * reset button and the opportunity badge. Pure presentation gating: server-side grants,
 * status polling, and opportunity state are unaffected; processing/completed surfaces
 * skip this check so the manual-reset completion feedback always plays out.
 */
export function isCodingPlanQuotaLimitFull(limit: UsageQuotaLimit | null | undefined): boolean {
  return getQuotaRemainingPercentage(limit ?? null) === 100;
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
 * Single formatter for Start Plan bucket reset times (shared by the settings balance card
 * and the chat input bubble).
 *
 * Both surfaces used to keep verbatim-identical copies of
 * formatStartPlanBalanceRenewTime, and a format tweak missing one copy reintroduced
 * drift. Bucket reset times follow the Coding Plan convention: time-only (HH:mm) for
 * today, date-only otherwise.
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
