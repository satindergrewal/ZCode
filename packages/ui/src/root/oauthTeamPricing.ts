import type { IServiceAccessor } from "@zcode/services";
import type { EnterpriseCodingPlanPricingProduct, ProviderFamilyDomain } from "@zcode/shared";
import { logger } from "@/logger.js";

type EnterprisePricingProductsResult =
  | { status: "success"; productList: EnterpriseCodingPlanPricingProduct[] }
  | { status: "error" };

export async function getEnterprisePricingProducts(
  services: IServiceAccessor,
  domain: ProviderFamilyDomain,
): Promise<EnterprisePricingProductsResult> {
  // Both account domains must query their own Family; keep failure distinct from an explicit empty list, and never auto-rewrite existing connections.
  try {
    const pricing = await services.codingPlanSubscriptionService.getEnterprisePricing({
      authenticated: true,
      family: domain,
    });
    return { status: "success", productList: pricing.productList };
  } catch (error) {
    logger.warn("[Root] Failed to refresh team plans after sign-in", { domain, error });
    return { status: "error" };
  }
}

export async function getEnterprisePricingProductsOrEmpty(
  services: IServiceAccessor,
  domain: ProviderFamilyDomain,
): Promise<EnterpriseCodingPlanPricingProduct[]> {
  const pricing = await getEnterprisePricingProducts(services, domain);
  return pricing.status === "success" ? pricing.productList : [];
}
