import type { CodingPlanRegularTpsRequest } from "@zcode/shared";
import type { IUsageStatsService } from "@zcode/services";

export interface HighspeedTimingMetricsForSavedTime {
  outputTokens: number;
  durationMs: number;
  modelDurationMs?: number;
  toolDurationMs?: number;
  otherDurationMs?: number;
}

export function calculateHighspeedSavedDurationMs(params: {
  outputTokens: number;
  regularTps: number;
  highspeedTps: number;
  durationMs: number;
  modelDurationMs?: number;
  toolDurationMs?: number;
  otherDurationMs?: number;
}): number {
  if (
    !Number.isFinite(params.regularTps) ||
    params.regularTps <= 0 ||
    !Number.isFinite(params.highspeedTps) ||
    params.highspeedTps <= 0
  ) {
    return 0;
  }
  const modelSpeedup = params.highspeedTps / params.regularTps;
  if (!Number.isFinite(modelSpeedup) || modelSpeedup <= 0) return 0;
  if (
    params.modelDurationMs !== undefined &&
    params.toolDurationMs !== undefined &&
    Number.isFinite(params.modelDurationMs) &&
    Number.isFinite(params.toolDurationMs) &&
    params.modelDurationMs >= 0 &&
    params.toolDurationMs >= 0
  ) {
    const modelDurationMs = params.modelDurationMs;
    const toolDurationMs = params.toolDurationMs;
    const otherDurationMs =
      params.otherDurationMs !== undefined &&
      Number.isFinite(params.otherDurationMs) &&
      params.otherDurationMs >= 0
        ? params.otherDurationMs
        : Math.max(0, params.durationMs - modelDurationMs - toolDurationMs);
    // The CLI persists real model/tool spans; tool and other waits never shrink with model speed.
    const regularDurationMs = toolDurationMs + otherDurationMs + modelDurationMs * modelSpeedup;
    const actualDurationMs = modelDurationMs + toolDurationMs + otherDurationMs;
    return Math.max(0, Math.round(regularDurationMs - actualDurationMs));
  }
  // Bug: card-level TPS was treated as whole-turn duration, shrinking tool time by model speed too.
  // Tools are a fixed 20%; only the 80% model inference scales with the Highspeed ratio.
  const highspeedShare = 0.2 + 0.8 / modelSpeedup;
  const estimatedRegularDurationMs = params.durationMs / highspeedShare;
  return Math.max(0, Math.round(estimatedRegularDurationMs - params.durationMs));
}

/**
 * Always pass the completed turn's real split; a missing split field must not silently fall back to 20/80.
 */
export function calculateHighspeedSavedDurationFromMetrics(
  metrics: HighspeedTimingMetricsForSavedTime,
  regularTps: number,
  highspeedTps: number,
): number {
  return calculateHighspeedSavedDurationMs({
    ...metrics,
    regularTps,
    highspeedTps,
  });
}

export async function readHighspeedRegularTpsFromHealth(params: {
  usageStatsService: IUsageStatsService;
  preferredProviderId: string;
  /**
   * Current Coding Plan account context. Post-provider-refactor only this resolves request auth;
   * without it the host cannot pick the account/team project and must throw.
   */
  accountAccess: CodingPlanRegularTpsRequest["accountAccess"];
  timeZone?: string;
}): Promise<number | undefined> {
  const getRegularTps = params.usageStatsService.getCodingPlanRegularTps;
  if (!getRegularTps) return undefined;
  return getRegularTps.call(params.usageStatsService, {
    preferredProviderId: params.preferredProviderId,
    accountAccess: params.accountAccess,
    ...(params.timeZone ? { timeZone: params.timeZone } : {}),
  });
}
