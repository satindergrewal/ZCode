/* eslint-disable max-lines -- the enterprise plan presentation model centralizes the static catalog, live pricing, and payment parameter conversion; splitting it would blur merge boundaries. */
import type {
  CodingPlanStaticTeamProduct,
  EnterpriseCodingPlanPricingProduct,
  EnterpriseCodingPlanSubscribePeriod,
  ProviderFamilyDomain,
} from "@zcode/shared";
import {
  normalizeCodingPlanCardCopyItems,
  type CodingPlanPriceUnit,
  type CodingPlanProductDisplay,
} from "@/settings/model-provider-section/codingPlanProductPresentation.js";

export type EnterpriseCodingPlanProductDisplay = CodingPlanProductDisplay & {
  enterpriseProduct: EnterpriseCodingPlanPricingProduct;
  tier: EnterpriseCodingPlanPricingProduct["tier"];
  subscribeMode: EnterpriseCodingPlanPricingProduct["subscribeMode"];
  subscribePeriod: EnterpriseCodingPlanPricingProduct["subscribePeriod"];
  purchaseMethodName: string;
  organizationId?: string | null;
  organizationName?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  teamProjects?: EnterpriseCodingPlanPricingProduct["teamProjects"];
  apiKeyStatus?: EnterpriseCodingPlanPricingProduct["apiKeyStatus"];
  apiKeyUnavailableReason?: EnterpriseCodingPlanPricingProduct["apiKeyUnavailableReason"];
  apiKeyUnavailableMessage?: EnterpriseCodingPlanPricingProduct["apiKeyUnavailableMessage"];
  subscribed?: boolean | null;
  dynamicPricingAvailable?: boolean;
  staticCatalogAvailable?: boolean;
  /**
   * The family (zai / bigmodel) this enterprise plan belongs to.
   * The UI layer used to hardcode team plan items as bigmodelCodingPlan-derived, so a zai-family
   * subscription could never render. With the family marker, downstream visibility functions locate
   * the family's codingPlanItem and team key prefix via product.family.
   * The bigmodel default keeps backward compatibility.
   */
  family?: ProviderFamilyDomain;
};

/** Legacy products without family are interpreted as BigModel only at this normalization boundary. */
export function resolveEnterpriseCodingPlanProductFamily(
  product: Pick<EnterpriseCodingPlanProductDisplay, "family">,
): ProviderFamilyDomain {
  return product.family ?? "bigmodel";
}

function buildEnterpriseCodingPlanProductList(
  products: EnterpriseCodingPlanPricingProduct[],
): EnterpriseCodingPlanProductDisplay[] {
  return products.map((product): EnterpriseCodingPlanProductDisplay => {
    const purchaseMethodName = product.purchaseMethodName?.trim() ?? "";
    return {
      productId: product.productId,
      productName: formatEnterpriseCodingPlanTier(product.tier),
      productBigTitle: formatEnterpriseCodingPlanTier(product.tier),
      originalAmount: product.originalAmount,
      payAmount: resolveEnterpriseCodingPlanDisplayPayAmount(product),
      renewAmount: product.renewAmount,
      canRepurchase: product.canRepurchase,
      inCurrentPeriod: product.subscribed === true,
      campaignDiscountDetails: product.campaignDiscountDetails,
      priceUnit: mapEnterpriseCodingPlanPriceUnit(product.subscribePeriod),
      priceCurrency: "CNY",
      productEquityList: [],
      hasPreview: true,
      enterpriseProduct: product,
      tier: product.tier,
      subscribeMode: product.subscribeMode,
      subscribePeriod: product.subscribePeriod,
      purchaseMethodName,
      organizationId: product.organizationId,
      organizationName: product.organizationName,
      projectId: product.projectId,
      projectName: product.projectName,
      teamProjects: product.teamProjects,
      apiKeyStatus: product.apiKeyStatus,
      apiKeyUnavailableReason: product.apiKeyUnavailableReason,
      apiKeyUnavailableMessage: product.apiKeyUnavailableMessage,
      subscribed: product.subscribed,
      dynamicPricingAvailable: true,
    };
  });
}

function mergeEnterpriseCodingPlanProductList(
  staticProducts: CodingPlanStaticTeamProduct[],
  pricingProducts: EnterpriseCodingPlanPricingProduct[],
): EnterpriseCodingPlanProductDisplay[] {
  const pricingByProductId = new Map(
    pricingProducts.map((product) => [product.productId, product]),
  );
  const staticProductIds = new Set(staticProducts.map((product) => product.productId));
  const mergedStaticProducts = staticProducts.map((staticProduct) => {
    const pricingProduct = pricingByProductId.get(staticProduct.productId);
    const enterpriseProduct: EnterpriseCodingPlanPricingProduct = pricingProduct ?? {
      productId: staticProduct.productId,
      tier: staticProduct.tier,
      subscribeMode: staticProduct.subscribeMode,
      subscribePeriod: staticProduct.subscribePeriod,
      purchaseMethodName: staticProduct.purchaseMethodName,
      originalAmount: staticProduct.originalAmount,
      discountAmount: staticProduct.discountAmount,
      payAmount: staticProduct.payAmount,
      renewAmount: staticProduct.renewAmount,
      canRepurchase: false,
    };
    const display = buildEnterpriseCodingPlanProductList([enterpriseProduct])[0]!;
    return {
      ...display,
      productName: staticProduct.productName,
      productBigTitle: staticProduct.productName,
      originalAmount: pricingProduct?.originalAmount ?? staticProduct.originalAmount,
      payAmount: pricingProduct
        ? display.payAmount
        : (staticProduct.payAmount ?? staticProduct.renewAmount),
      renewAmount: pricingProduct?.renewAmount ?? staticProduct.renewAmount,
      priceCurrency: staticProduct.priceCurrency,
      equity: normalizeCodingPlanCardCopyItems(staticProduct.equity ?? []),
      descriptionItems: normalizeCodingPlanCardCopyItems(staticProduct.description ?? []),
      dynamicPricingAvailable: pricingProduct !== undefined,
      staticCatalogAvailable: true,
    };
  });
  const purchasedPricingProducts = pricingProducts
    .filter((product) => product.subscribed === true && !staticProductIds.has(product.productId))
    .map((product) => ({
      ...buildEnterpriseCodingPlanProductList([product])[0]!,
      // The client/configs team static catalog only feeds purchasable-SKU display.
      // Purchased Team Plan identity comes from pricing/customerInfo; an empty or incomplete static
      // catalog grayscale must never hide the real team connection mode or usage-stats entry.
      staticCatalogAvailable: false,
    }));
  return [...mergedStaticProducts, ...purchasedPricingProducts];
}

export function resolveEnterpriseCodingPlanProductList(
  staticProducts: CodingPlanStaticTeamProduct[] | undefined,
  pricingProducts: EnterpriseCodingPlanPricingProduct[],
): EnterpriseCodingPlanProductDisplay[] {
  // With the static catalog missing or unreadable, pricing stays the authority for team subscription
  // identity and project context; only a successfully read explicit empty array hides all team SKUs
  // per its configured semantics.
  return !Array.isArray(staticProducts)
    ? buildEnterpriseCodingPlanProductList(pricingProducts)
    : mergeEnterpriseCodingPlanProductList(staticProducts, pricingProducts);
}

function resolveEnterpriseCodingPlanDisplayPayAmount(
  product: EnterpriseCodingPlanPricingProduct,
): number | undefined {
  const candidateAmounts = [product.payAmount, product.renewAmount].filter(hasPositiveOrZeroAmount);
  if (candidateAmounts.length > 0) {
    // Real enterprise annual pricing ships payAmount=originalAmount and renewAmount=discounted price.
    // Cards must match personal plans ("discounted price + struck-through original"), so the display
    // price is the lowest payable amount.
    return Math.min(...candidateAmounts);
  }
  if (
    hasPositiveOrZeroAmount(product.originalAmount) &&
    hasPositiveAmount(product.discountAmount)
  ) {
    // Personal plan cards show discounted price plus struck-through original; enterprise discountAmount
    // is a discount magnitude, not a price, but annual products may ship only originalAmount + discountAmount.
    return roundCurrencyAmount(Math.max(0, product.originalAmount - product.discountAmount));
  }
  return undefined;
}

function hasPositiveAmount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasPositiveOrZeroAmount(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function roundCurrencyAmount(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function formatEnterpriseCodingPlanTier(tier: EnterpriseCodingPlanPricingProduct["tier"]): string {
  const normalized = tier.trim();
  if (!normalized) {
    return tier;
  }
  return normalized.charAt(0).toUpperCase() + normalized.slice(1).toLowerCase();
}

function mapEnterpriseCodingPlanPriceUnit(
  period: EnterpriseCodingPlanSubscribePeriod,
): CodingPlanPriceUnit {
  return period === "YEARLY" ? "year" : period === "QUARTERLY" ? "quarter" : "month";
}
