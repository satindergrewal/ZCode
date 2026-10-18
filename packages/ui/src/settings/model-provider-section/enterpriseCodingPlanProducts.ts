/* eslint-disable max-lines -- the enterprise plan presentation model centralizes the static catalog, live pricing, and payment parameter conversion; splitting it would blur merge boundaries. */
import type {
  CodingPlanCampaignDiscountDetail,
  CodingPlanStaticTeamProduct,
  EnterpriseCodingPlanCreateOrderRequest,
  EnterpriseCodingPlanCreateOrderResponse,
  EnterpriseCodingPlanDiscountDetail,
  EnterpriseCodingPlanOrderCalculateResponse,
  EnterpriseCodingPlanPendingOrder,
  EnterpriseCodingPlanPaymentStatus,
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

const ENTERPRISE_CODING_PLAN_FAILURE_STATUSES = ["FAIL", "CLOSED", "CANCELLED"] as const;

export function buildEnterpriseCodingPlanProductList(
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

export function mergeEnterpriseCodingPlanProductList(
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

export function buildEnterpriseCodingPlanCalculateRequest({
  product,
  maxSeats,
  duration,
  giveAmount = 0,
  balanceDeductAmount = 0,
}: {
  product: EnterpriseCodingPlanProductDisplay;
  maxSeats: number;
  duration: number;
  giveAmount?: number;
  balanceDeductAmount?: number;
}) {
  return {
    productId: product.productId,
    maxSeats,
    subscribePeriod: product.subscribePeriod,
    subscribeMode: product.subscribeMode,
    duration: product.subscribeMode === "ONE_TIME" ? duration : undefined,
    giveAmount,
    balanceDeductAmount,
  };
}

export function buildEnterpriseCodingPlanCreateOrderRequest({
  product,
  maxSeats,
  duration,
  estimate,
  giveAmount = 0,
  balanceDeductAmount = 0,
}: {
  product: EnterpriseCodingPlanProductDisplay;
  maxSeats: number;
  duration: number;
  giveAmount?: number;
  balanceDeductAmount?: number;
  estimate: Pick<
    EnterpriseCodingPlanOrderCalculateResponse,
    "totalOriginalAmount" | "totalPayAmount" | "thirdPayAmount"
  >;
}): EnterpriseCodingPlanCreateOrderRequest {
  return {
    productId: product.productId,
    maxSeats,
    subscribePeriod: product.subscribePeriod,
    subscribeMode: product.subscribeMode,
    purchaseType: "PAY",
    duration: product.subscribeMode === "ONE_TIME" ? duration : undefined,
    giveAmount,
    balanceDeductAmount,
    totalOriginalAmount: estimate.totalOriginalAmount,
    totalPayAmount: estimate.totalPayAmount,
    thirdPayAmount: estimate.thirdPayAmount,
  };
}

export function buildEnterpriseCodingPlanPaymentContent(
  order: Pick<EnterpriseCodingPlanCreateOrderResponse, "alipayJumpSchema" | "payUrl">,
): string {
  // Bugfix: the enterprise PC QR code uses payUrl per the API doc; alipayJumpSchema is the mobile Alipay schema and is too long for QR generation.
  return order.payUrl?.trim() || order.alipayJumpSchema?.trim() || "";
}

export function isEnterpriseCodingPlanThirdPartyPaymentRequired(
  order: Pick<
    EnterpriseCodingPlanCreateOrderResponse,
    "alipayJumpSchema" | "payUrl" | "thirdPayAmount"
  >,
): boolean {
  // Bugfix: when gift credit/balance covers the full amount, the backend creates an order without third-party payment content.
  // Such orders must not enter the Alipay QR page, or users stick on finish-payment page. -- typo alipay
  return order.thirdPayAmount > 0 || buildEnterpriseCodingPlanPaymentContent(order) !== "";
}

export function buildEnterpriseCodingPlanEstimateFromPendingOrder(
  order: EnterpriseCodingPlanPendingOrder,
): EnterpriseCodingPlanOrderCalculateResponse {
  const discountAmount = hasPositiveAmount(order.deductionAmount)
    ? order.deductionAmount
    : Math.max(0, order.totalAmount - order.amount);
  return {
    totalOriginalAmount: order.totalAmount,
    campaignDiscountAmount: discountAmount,
    totalPayAmount: order.amount,
    // Bugfix: the pending-orders API has no thirdPayAmount field; the confirm page must placeholder with the pending payable amount,
    // and the real payment flow refreshes the QR dialog amount from continue-pay's thirdPayAmount.
    thirdPayAmount: order.amount,
  };
}

export function buildEnterpriseCodingPlanEstimateFromOrderResponse(
  order: EnterpriseCodingPlanCreateOrderResponse,
): EnterpriseCodingPlanOrderCalculateResponse {
  return {
    totalOriginalAmount: order.totalOriginalAmount,
    campaignDiscountAmount: order.campaignDiscountAmount,
    discountDetails: order.discountDetails,
    totalPayAmount: order.totalPayAmount,
    thirdPayAmount: order.thirdPayAmount,
  };
}

export function buildEnterpriseCodingPlanCampaignDiscountDetails({
  campaignDiscountAmount,
  discountDetails,
  pricingCampaignDiscountDetails,
}: {
  campaignDiscountAmount?: number;
  discountDetails?: EnterpriseCodingPlanDiscountDetail[];
  pricingCampaignDiscountDetails?: CodingPlanCampaignDiscountDetail[];
}): CodingPlanCampaignDiscountDetail[] {
  const pricingDetails = normalizePricingCampaignDiscountDetails(
    pricingCampaignDiscountDetails,
    campaignDiscountAmount,
  );
  if (pricingDetails.length > 0) {
    return pricingDetails;
  }

  const mappedDetails = (discountDetails ?? []).flatMap((detail) => {
    if (typeof detail.discountAmount !== "number" || detail.discountAmount <= 0) {
      return [];
    }
    const discountName = detail.discountName?.trim();
    return [
      {
        campaignName: discountName || undefined,
        campaignDiscountAmount: detail.discountAmount,
        rewardDetail: discountName || undefined,
        applyScene: detail.discountType,
      },
    ];
  });
  if (mappedDetails.length > 0) {
    return mappedDetails;
  }
  if (typeof campaignDiscountAmount === "number" && campaignDiscountAmount > 0) {
    return [{ campaignDiscountAmount }];
  }
  return [];
}

export function calculateEnterpriseCodingPlanPricingDiscountAmount({
  product,
  maxSeats,
  duration,
}: {
  product: EnterpriseCodingPlanProductDisplay;
  maxSeats: number;
  duration: number;
}): number | undefined {
  const discountAmount = product.enterpriseProduct.discountAmount;
  const displayDiscountAmount = hasPositiveAmount(discountAmount)
    ? discountAmount
    : calculateEnterpriseCodingPlanDisplayDiscountAmount(product);
  if (!hasPositiveAmount(displayDiscountAmount)) {
    return undefined;
  }
  const periodCount = product.subscribeMode === "ONE_TIME" ? Math.max(1, duration) : 1;
  return roundCurrencyAmount(
    // Fix rationale: enterprise pricing's discountAmount may be 0; the real yearly discount is the originalAmount-renewAmount gap,
    // so the per-seat discount is reconstructed from the card display price for confirm/payment detail.
    displayDiscountAmount * Math.max(1, maxSeats) * periodCount,
  );
}

function calculateEnterpriseCodingPlanDisplayDiscountAmount(
  product: EnterpriseCodingPlanProductDisplay,
): number | undefined {
  const displayPayAmount = resolveEnterpriseCodingPlanDisplayPayAmount(product.enterpriseProduct);
  if (
    !hasPositiveAmount(product.enterpriseProduct.originalAmount) ||
    !hasPositiveOrZeroAmount(displayPayAmount)
  ) {
    return undefined;
  }
  const discountAmount = product.enterpriseProduct.originalAmount - displayPayAmount;
  return discountAmount > 0 ? roundCurrencyAmount(discountAmount) : undefined;
}

function normalizePricingCampaignDiscountDetails(
  details: CodingPlanCampaignDiscountDetail[] | undefined,
  campaignDiscountAmount: number | undefined,
): CodingPlanCampaignDiscountDetail[] {
  const sourceDetails = (details ?? []).filter(
    (detail) =>
      hasPositiveAmount(detail.campaignDiscountAmount) ||
      Boolean(detail.campaignName?.trim()) ||
      Boolean(detail.rewardDetail?.trim()),
  );
  if (sourceDetails.length === 0) {
    return [];
  }

  const totalDiscountAmount = hasPositiveAmount(campaignDiscountAmount)
    ? campaignDiscountAmount
    : undefined;
  const sourceAmountSum = sourceDetails.reduce(
    (sum, detail) =>
      sum + (hasPositiveAmount(detail.campaignDiscountAmount) ? detail.campaignDiscountAmount : 0),
    0,
  );
  let allocatedAmount = 0;

  return sourceDetails.flatMap((detail, index) => {
    const amount = resolvePricingCampaignDiscountAmount({
      detail,
      index,
      count: sourceDetails.length,
      totalDiscountAmount,
      sourceAmountSum,
      allocatedAmount,
    });
    allocatedAmount += amount;
    if (!hasPositiveAmount(amount)) {
      return [];
    }
    return [
      {
        ...detail,
        // Fix rationale: enterprise pricing returns per-seat/per-period promo data while quote/order return the total for current seats x duration;
        // keep pricing's promo name and copy but use the order's total discount, or multi-seat discounts render too small.
        campaignDiscountAmount: amount,
      },
    ];
  });
}

function resolvePricingCampaignDiscountAmount({
  detail,
  index,
  count,
  totalDiscountAmount,
  sourceAmountSum,
  allocatedAmount,
}: {
  detail: CodingPlanCampaignDiscountDetail;
  index: number;
  count: number;
  totalDiscountAmount: number | undefined;
  sourceAmountSum: number;
  allocatedAmount: number;
}): number {
  if (!hasPositiveAmount(totalDiscountAmount)) {
    return hasPositiveAmount(detail.campaignDiscountAmount) ? detail.campaignDiscountAmount : 0;
  }

  if (count === 1) {
    return totalDiscountAmount;
  }

  if (sourceAmountSum <= 0) {
    return index === 0 ? totalDiscountAmount : 0;
  }

  if (index === count - 1) {
    return roundCurrencyAmount(totalDiscountAmount - allocatedAmount);
  }

  const sourceAmount = hasPositiveAmount(detail.campaignDiscountAmount)
    ? detail.campaignDiscountAmount
    : 0;
  return roundCurrencyAmount((totalDiscountAmount * sourceAmount) / sourceAmountSum);
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

export function isEnterpriseCodingPlanPaymentSuccessStatus(
  status: EnterpriseCodingPlanPaymentStatus,
): boolean {
  return status === "SUCCESS";
}

export function isEnterpriseCodingPlanPaymentFailureStatus(
  status: EnterpriseCodingPlanPaymentStatus,
): boolean {
  return ENTERPRISE_CODING_PLAN_FAILURE_STATUSES.includes(
    status as (typeof ENTERPRISE_CODING_PLAN_FAILURE_STATUSES)[number],
  );
}

export function getEnterpriseCodingPlanFailureStatuses(): string[] {
  return [...ENTERPRISE_CODING_PLAN_FAILURE_STATUSES];
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
