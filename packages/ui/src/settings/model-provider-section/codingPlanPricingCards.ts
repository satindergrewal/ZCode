import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import type { CodingPlanProviderId } from "@/settings/model-provider-section/constants.js";

// Dead-code cleanup: the native purchase component CodingPlanPricingCards and its resolver were
// retired together with CodingPlanPurchasePanel (purchases moved to the embedded official-site webview).
// This file keeps only the login option types and product-source resolution still used by settings.

export type CodingPlanLoginOptions = {
  forceOAuth?: boolean;
};

export function resolveCodingPlanUpgradeProductsProviderId(
  providerId: CodingPlanProviderId,
): CodingPlanProviderId {
  // Start Plan is the free entry; the coding-plan list must show the original paid Z.AI Coding Plan SKUs.
  // Keeping the Start Plan providerId would list the free Start SKU as purchasable, duplicated.
  if (providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan) {
    return BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
  }

  // BigModel Start Plan is also a free entry; the upgrade flow must use the BigModel paid Coding Plan
  // product source, not request free SKUs via the Start providerId.
  return providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
    ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
    : providerId;
}
