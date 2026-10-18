import { applyDynamicWorkflowUserMode, type ApiClient } from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { ICodingPlanSubscriptionService } from "./codingPlanSubscription.js";
import { BigModelCodingPlanSubscriptionProvider } from "./bigmodelCodingPlanSubscriptionProvider.js";
import type { ModelSelectionView } from "@zcode/provider";
import { ZaiCodingPlanSubscriptionProvider } from "./zaiCodingPlanSubscriptionProvider.js";

interface CodingPlanSubscriptionServiceDependencies {
  apiClient: ApiClient;
  credentialService: Pick<ICredentialService, "load">;
  resolveOffPeakModelSelectionView?: () => Promise<ModelSelectionView>;
  /**
   * User-selected dynamic-workflow mode (launch.md "The user's choice"). Only assemblers that own settings
   * (desktop local host, web/standalone server) may inject it; otherwise the snapshot carries only the server offer.
   */
  resolveDynamicWorkflowUserMode?: () => Promise<unknown>;
}

/**
 * The old service bound every call to the single BigModelCodingPlanSubscriptionProvider,
 * leaving the zai family without its own Team Plan pricing source (dead code).
 *
 * zai and bigmodel Team Plan are now symmetric end to end:
 * both provider instances are held; the enterprise read path (getEnterprisePricing) routes by
 * request.family; the default family stays bigmodel for backward compatibility.
 *
 * Remaining methods (purchase/staticConfigs/preview etc.) are family-agnostic or already route inside the provider by
 * request.providerId, so delegating to the bigmodel base suffices:
 *   - The enterprise purchase loop (balance/order/pending/cancel/continue/status) stays bigmodel-only by product decision.
 *   - staticConfigs is the platform-level client/configs and family-agnostic.
 *   - Purchase flows (Stripe/PayPal/preview/createSign etc.) route via request.providerId inside the provider.
 */
export function createCodingPlanSubscriptionService(
  dependencies: CodingPlanSubscriptionServiceDependencies,
): ICodingPlanSubscriptionService {
  const bigmodelProvider = new BigModelCodingPlanSubscriptionProvider(dependencies);
  const zaiProvider = new ZaiCodingPlanSubscriptionProvider(dependencies);

  // Pick the enterprise read-path provider by family; the default (including legacy callers without family) is bigmodel.
  const resolveEnterprisePricingProvider = (
    family?: "bigmodel" | "zai",
  ): BigModelCodingPlanSubscriptionProvider => (family === "zai" ? zaiProvider : bigmodelProvider);

  return {
    batchPreview: (request) => bigmodelProvider.batchPreview(request),
    getStaticProducts: () => bigmodelProvider.getStaticProducts(),
    getStaticTeamProducts: () => bigmodelProvider.getStaticTeamProducts(),
    getStartPlanPreview: () => bigmodelProvider.getStartPlanPreview(),
    getManualClaimPlanPreviews: () => bigmodelProvider.getManualClaimPlanPreviews(),
    claimManualPlan: (request) => bigmodelProvider.claimManualPlan(request),
    getOffPeakClientConfig: (options) => bigmodelProvider.getOffPeakClientConfig(options),
    // Dynamic-workflow gating shares the client/configs source,
    // so like other platform-level config it always uses the bigmodel provider, family-agnostic.
    // The user choice is folded into the offer here so renderers read the effective value; the rule lives only in the shared
    // applyDynamicWorkflowUserMode, and renderers never recompute it.
    getDynamicWorkflowClientConfig: async (options) => {
      const offer = await bigmodelProvider.getDynamicWorkflowClientConfig(options);
      const resolveUserMode = dependencies.resolveDynamicWorkflowUserMode;
      return resolveUserMode ? applyDynamicWorkflowUserMode(offer, await resolveUserMode()) : offer;
    },
    getModelContextBudgetStrategy: () => bigmodelProvider.getModelContextBudgetStrategy(),
    getBillingDiscount: () => bigmodelProvider.getBillingDiscount(),
    getRequestVerificationConfig: () => bigmodelProvider.getRequestVerificationConfig(),
    getForceUpdateConfig: () => bigmodelProvider.getForceUpdateConfig(),
    productInfo: (request) => bigmodelProvider.productInfo(request),
    preview: (request) => bigmodelProvider.preview(request),
    createSign: (request) => bigmodelProvider.createSign(request),
    updateSign: (request) => bigmodelProvider.updateSign(request),
    checkPayment: (request) => bigmodelProvider.checkPayment(request),
    checkPendingOrders: (request) => bigmodelProvider.checkPendingOrders(request),
    queryStripeCards: (request) => bigmodelProvider.queryStripeCards(request),
    bindStripeCard: (request) => bigmodelProvider.bindStripeCard(request),
    unbindStripeCard: (request) => bigmodelProvider.unbindStripeCard(request),
    payStripe: (request) => bigmodelProvider.payStripe(request),
    checkPaypalSupport: (request) => bigmodelProvider.checkPaypalSupport(request),
    createPaypalSetupToken: (request) => bigmodelProvider.createPaypalSetupToken(request),
    subscribePaypal: (request) => bigmodelProvider.subscribePaypal(request),
    getEnterprisePricing: (request) =>
      resolveEnterprisePricingProvider(request?.family).getEnterprisePricing(request),
    getEnterpriseBalance: () => bigmodelProvider.getEnterpriseBalance(),
    calculateEnterpriseOrder: (request) => bigmodelProvider.calculateEnterpriseOrder(request),
    createEnterpriseOrder: (request) => bigmodelProvider.createEnterpriseOrder(request),
    getEnterprisePendingOrders: () => bigmodelProvider.getEnterprisePendingOrders(),
    cancelEnterpriseOrder: (request) => bigmodelProvider.cancelEnterpriseOrder(request),
    continueEnterpriseOrderPayment: (request) =>
      bigmodelProvider.continueEnterpriseOrderPayment(request),
    checkEnterpriseOrderStatus: (request) => bigmodelProvider.checkEnterpriseOrderStatus(request),
  };
}
