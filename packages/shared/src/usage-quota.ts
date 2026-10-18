/**
 * Pure types of Coding Plan quota.
 *
 * Split from usage-stats.ts: the MCP quota pushed that file past oxlint max-lines(400),
 * and quotas are an independently describable set (no stats-aggregate deps); both sides fit the cap after the split.
 * Self-standing deps; usage-stats.ts imports one-way and re-exports, no cycle.
 */

export interface UsageQuotaSnapshot {
  level: string | null;
  limits: UsageQuotaLimit[];
}

export interface UsageQuotaLimit {
  type: string;
  /// Start Plan server quota bucket and period identity; period times in millis, for reminder dedupe.
  bucketId?: string;
  userPlanId?: string;
  periodStart?: number;
  periodEnd?: number;
  /// The owning entitlement's period kind, e.g. daily / one_time.
  period?: string;
  meter?: string;
  unitType?: string;
  /// The Start Plan bucket's plan identity, for per-plan grouping in settings only.
  planId?: string;
  unit?: number;
  number?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  percentage?: number;
  nextResetTime?: number;
  usageDetails: UsageQuotaUsageDetail[];
}

export interface UsageQuotaUsageDetail {
  modelCode: string;
  displayName?: string;
  usage: number;
}

/**
 * The synthetic value of aggregate.type.
 *
 * Not TOKENS_LIMIT / TIME_LIMIT: isSameLimitCategory would class TIME_LIMIT as the same kind,
 * letting findCodingPlanQuotaLimit mis-hit MCP aggregate quotas.
 */
export const MCP_USAGE_QUOTA_LIMIT_TYPE = "MCP_USAGE_LIMIT" as const;

/** The Coding Plan connection a MCP quota belongs to; lets the UI judge the current provider tab. */
export type UsageMcpQuotaScope =
  | {
      providerFamily: "zai" | "bigmodel";
      targetType: "PERSONAL";
    }
  | {
      providerFamily: "zai" | "bigmodel";
      targetType: "TEAM";
      organizationId: string;
      projectId: string;
    };

export interface UsageMcpQuotaSnapshot {
  /// Server server_time in millis (the API returns Unix seconds).
  serverTime: number;
  level: string | null;
  scope: UsageMcpQuotaScope;
  /**
   * Equivalent of the server's total_usage (used/total/remaining), reusable by the existing quota bar/card
   * rendering. percentage follows the quota API's convention: **used ratio**; display inverts to remaining.
   */
  aggregate: UsageQuotaLimit;
}
