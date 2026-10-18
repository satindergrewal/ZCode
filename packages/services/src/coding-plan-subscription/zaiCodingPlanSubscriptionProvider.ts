import { BUILTIN_MODEL_PROVIDER_IDS, resolveZaiBusinessBaseUrl } from "@zcode/shared";
import type { CodingPlanSubscriptionProviderId } from "@zcode/shared";
import {
  BigModelCodingPlanSubscriptionProvider,
  createZaiLoginAuthHeaders,
} from "./bigmodelCodingPlanSubscriptionProvider.js";

/**
 * ZaiCodingPlanSubscriptionProvider
 *
 * Team Plan enterprise pricing used to exist only for bigmodel: the service fired every
 * enterprise read at BigModelCodingPlanSubscriptionProvider with a hardcoded bigmodel host,
 * bigmodelCodingPlan providerId and bigmodel OAuth token. Even with a zai team-plan connection
 * key there was no pricing source (dead code).
 *
 * zai/bigmodel Team Plan are now symmetric end to end: this subclass of
 * BigModelCodingPlanSubscriptionProvider overrides only the enterprise-read family dimensions -
 *   - providerId -> zaiCodingPlan
 *   - business host -> resolveZaiCodingPlanHost() (env-configured ZAI Business origin / prod api.z.ai)
 *   - OAuth token -> loadZaiAuthorization() (oauth:zai:access_token, reused from the parent)
 *   - auth headers -> createZaiLoginAuthHeaders()
 *
 * Scope: only the family dimensions behind getEnterprisePricing +
 * enrichEnterprisePricingTeamProjects (via protected virtual). The enterprise purchase loop
 * (balance/order/pending/cancel/continue/status) stays on the parent's bigmodel domain, matching
 * the zai Team Plan product boundary of pricing+team-context reads only.
 *
 * Everything else (batchPreview/preview/productInfo/checkPayment/checkPendingOrders/Stripe/PayPal/
 * createSign/updateSign/staticConfigs) is inherited:
 *   - purchase flows route in the parent's resolveEndpointConfig via request.providerId
 *     (zai -> /api/pay + zai host + zai token; bigmodel -> /api/biz + bigmodel host + bigmodel token);
 *   - staticConfigs is the platform-level client/configs, family-agnostic.
 */
export class ZaiCodingPlanSubscriptionProvider extends BigModelCodingPlanSubscriptionProvider {
  protected codingPlanProviderId(): CodingPlanSubscriptionProviderId {
    return BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
  }

  protected resolveFamilyEnterpriseHost(): string {
    return resolveZaiCodingPlanHost();
  }

  protected async loadFamilyEnterpriseToken(): Promise<string> {
    // Reuse the parent's loadZaiAuthorization; credential key oauth:zai:access_token.
    return this.loadZaiAuthorization();
  }

  protected createFamilyEnterpriseAuthHeaders(token: string): Record<string, string> {
    return createZaiLoginAuthHeaders(token);
  }
}

/**
 * zai business host for /api/biz and /api/pay.
 * Equivalent to the parent's file-scoped resolveZaiCodingPlanHost, kept separately because the
 * parent does not export it. Must match the parent: follow the product environment (env-configured
 * ZAI Business origin / prod api.z.ai).
 */
function resolveZaiCodingPlanHost(): string {
  return resolveZaiBusinessBaseUrl(process.env);
}
