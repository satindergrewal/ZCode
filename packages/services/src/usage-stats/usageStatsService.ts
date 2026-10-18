import type {
  ApiClient,
  AppUsageRequest,
  AppUsageSnapshot,
  CodingPlanUsageRequest,
  CodingPlanUsageSnapshot,
  CodingPlanRegularTpsRequest,
  CodingPlanResetOpportunityRequest,
  CodingPlanResetOpportunityResult,
  CodingPlanResetScopeRequest,
  CodingPlanResetStatusSnapshot,
  CodingPlanResetUseRequest,
  CodingPlanResetUseResult,
  UsageEntitlementRequest,
  UsageEntitlementSnapshot,
  UsageStatsRequest,
  UsageStatsSnapshot,
} from "@zcode/shared";
import { isCodingPlanModelProviderId } from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { IAccountRequestAuthService } from "../model-provider/accountRequestAuthService.js";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { IUsageStatsService } from "./usageStats.js";
import {
  BigModelUsageQuotaProvider,
  type UsageApiAuthorizationRequest,
  type UsageApiAuthorization,
} from "./providers/bigmodelUsageQuotaProvider.js";
import type { OfficialMcpCredentialSource } from "./providers/zcodeMcpQuotaProvider.js";

interface UsageStatsServiceDependencies {
  apiClient: ApiClient;
  accountRequestAuthService: Pick<
    IAccountRequestAuthService,
    "resolveAccessCurrent" | "resolveCurrent" | "assertCurrent"
  >;
  resolveApiAuthorization?: (
    request: UsageApiAuthorizationRequest,
  ) => Promise<UsageApiAuthorization | null>;
  credentialService?: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
  /** App Usage reads real agent-DB stats over the ZCode protocol. */
  zcodeAgentService: Pick<IZCodeAgentService, "getAppUsageStats">;
  /**
   * Credential source for official server MCP quota (same 5 identity headers as server MCP calls).
   * When absent the entitlement snapshot carries no MCP quota.
   */
  officialMcpCredentialSource?: OfficialMcpCredentialSource;
}

const CODING_PLAN_REGULAR_TPS_CACHE_MS = 5 * 60_000;

function isCodingPlanProviderId(providerId: string | undefined): boolean {
  return Boolean(providerId && isCodingPlanModelProviderId(providerId));
}

export function createUsageStatsService(
  dependencies: UsageStatsServiceDependencies,
): IUsageStatsService {
  const quotaProvider = new BigModelUsageQuotaProvider({
    apiClient: dependencies.apiClient,
    accountRequestAuthService: dependencies.accountRequestAuthService,
    resolveApiAuthorization: dependencies.resolveApiAuthorization,
    credentialService: dependencies.credentialService,
    env: dependencies.env,
    ...(dependencies.officialMcpCredentialSource
      ? { officialMcpCredentialSource: dependencies.officialMcpCredentialSource }
      : {}),
  });
  const regularTpsCache = new Map<string, { expiresAt: number; value: number | undefined }>();
  const regularTpsInFlight = new Map<string, Promise<number | undefined>>();

  function regularTpsCacheKey(request: CodingPlanRegularTpsRequest): string {
    return JSON.stringify([
      request.preferredProviderId,
      // Team scope (organizationId/projectId) is inside accountAccess; key on the whole thing so
      // sibling accounts/team projects never share one TPS cache entry.
      request.accountAccess,
      request.timeZone ?? null,
    ]);
  }

  return {
    async getAppUsageSnapshot(request: AppUsageRequest): Promise<AppUsageSnapshot> {
      // App Usage now reads real agent DB stats (model_usage/turn_usage/tool_usage)
      // via ZCode Protocol usage/stats. No local session JSON estimates.
      return dependencies.zcodeAgentService.getAppUsageStats({
        range: request.range,
        timeZone: request.timeZone,
      });
    },
    async getCodingPlanUsageSnapshot(
      request: CodingPlanUsageRequest,
    ): Promise<CodingPlanUsageSnapshot> {
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        // The Coding Plan page allows only preset Z.AI/BigModel Coding Plan accounts.
        // Plain provider ids never enter the monitor path, avoiding API key/env misreads.
        throw new Error("no_bigmodel_api_key");
      }
      return quotaProvider.getCodingPlanUsageSnapshot(request);
    },
    async getCodingPlanRegularTps(
      request: CodingPlanRegularTpsRequest,
    ): Promise<number | undefined> {
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        throw new Error("no_bigmodel_api_key");
      }
      const key = regularTpsCacheKey(request);
      const cached = regularTpsCache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const existing = regularTpsInFlight.get(key);
      if (existing) return existing;

      const requestPromise = quotaProvider
        .getCodingPlanRegularTps(request)
        .then((value) => {
          regularTpsCache.set(key, {
            expiresAt: Date.now() + CODING_PLAN_REGULAR_TPS_CACHE_MS,
            value,
          });
          return value;
        })
        .finally(() => {
          regularTpsInFlight.delete(key);
        });
      regularTpsInFlight.set(key, requestPromise);
      return requestPromise;
    },
    async getCodingPlanResetStatus(
      request: CodingPlanResetScopeRequest,
    ): Promise<CodingPlanResetStatusSnapshot> {
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        throw new Error("no_bigmodel_api_key");
      }
      return quotaProvider.getCodingPlanResetStatus(request);
    },
    async requestCodingPlanResetOpportunity(
      request: CodingPlanResetOpportunityRequest,
    ): Promise<CodingPlanResetOpportunityResult> {
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        throw new Error("no_bigmodel_api_key");
      }
      return quotaProvider.requestCodingPlanResetOpportunity(request);
    },
    async useCodingPlanReset(
      request: CodingPlanResetUseRequest,
    ): Promise<CodingPlanResetUseResult> {
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        throw new Error("no_bigmodel_api_key");
      }
      return quotaProvider.useCodingPlanReset(request);
    },
    async markCodingPlanResetHistoryRead(request: CodingPlanResetScopeRequest): Promise<void> {
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        throw new Error("no_bigmodel_api_key");
      }
      await quotaProvider.markCodingPlanResetHistoryRead(request);
    },
    async getSnapshot(request: UsageStatsRequest): Promise<UsageStatsSnapshot> {
      // App Usage moved to getAppUsageSnapshot (agent DB). getSnapshot serves the Coding Plan monitor only.
      // Monitor failures never fall back to local data; keep sources isolated.
      return quotaProvider.getUsageStatsSnapshot(request);
    },
    async getEntitlementSnapshot(
      request: UsageEntitlementRequest = {},
    ): Promise<UsageEntitlementSnapshot> {
      return quotaProvider.getSnapshotForRequest(request);
    },
  };
}
