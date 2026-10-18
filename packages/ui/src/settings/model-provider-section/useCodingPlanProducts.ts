/* eslint-disable max-lines -- Coding Plan products centralize static plans, remote quoting, caching and logged-out fallback; splitting would scatter shared state. */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BUILTIN_MODEL_PROVIDER_IDS,
  CODING_PLAN_SYSTEM_BUSY,
  type CodingPlanBatchPreviewResponse,
  type CodingPlanProductPreviewPayment,
  type CodingPlanStaticProduct,
  type CodingPlanStaticProductsConfig,
  type StartPlanPreviewConfig,
  isZaiCodingPlanProviderId,
} from "@zcode/shared";
import { useOptionalServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import {
  normalizeCodingPlanCardCopyItems,
  type CodingPlanProductDisplay,
} from "@/settings/model-provider-section/codingPlanProductPresentation.js";
import type { CodingPlanProviderId } from "@/settings/model-provider-section/constants.js";

interface CodingPlanProductsState {
  snapshot: CodingPlanProductsSnapshot | null;
  loading: boolean;
  error: string | null;
}

type CodingPlanProductsSnapshot = Omit<CodingPlanBatchPreviewResponse, "productList"> & {
  productList: CodingPlanProductDisplay[];
};

const CODING_PLAN_OAUTH_REQUIRED_ERROR = "coding_plan_oauth_required";
export const ZAI_START_FREE_PRODUCT_ID = "zai-start-free";
const ZAI_START_FREE_PRODUCT_IDS = {
  month: `${ZAI_START_FREE_PRODUCT_ID}-monthly`,
  quarter: `${ZAI_START_FREE_PRODUCT_ID}-quarterly`,
  year: `${ZAI_START_FREE_PRODUCT_ID}-yearly`,
} as const;
const CODING_PLAN_PRODUCTS_CACHE_TTL_MS = 30_000;
const CODING_PLAN_STATIC_PRODUCTS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const productRequestCache = new Map<string, Promise<CodingPlanProductsSnapshot>>();
const productSnapshotCache = new Map<
  string,
  { snapshot: CodingPlanProductsSnapshot; expiresAt: number }
>();
const productCacheGeneration = new Map<string, number>();
let staticProductsConfigCache: {
  config: CodingPlanStaticProductsConfig;
  expiresAt: number;
} | null = null;
let staticProductsConfigRequest: Promise<CodingPlanStaticProductsConfig> | null = null;

export function useCodingPlanProducts(
  providerId: CodingPlanProviderId,
  options?: { remotePreviewEnabled?: boolean },
) {
  const services = useOptionalServices();
  const service = services?.codingPlanSubscriptionService;
  const supportedProvider =
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    isZaiCodingPlanProviderId(providerId);
  const enabled = supportedProvider && options?.remotePreviewEnabled !== false;
  const staticSnapshot = useMemo(() => buildStaticProductsSnapshot(providerId), [providerId]);
  const [state, setState] = useState<CodingPlanProductsState>(() => ({
    snapshot: null,
    loading: supportedProvider,
    error: null,
  }));

  const refresh = useCallback(
    async (options?: { force?: boolean }) => {
      if (!supportedProvider) {
        setState({
          snapshot: staticSnapshot,
          loading: false,
          error: "unsupported",
        });
        return;
      }
      if (!enabled) {
        const loadedStaticSnapshot = service
          ? await loadCodingPlanStaticProductsSnapshotForTest(providerId, service)
          : staticSnapshot;
        setState({
          // Logged out/unconnected must not hit the paid batch-preview, but static plans still show.
          // This used to return an empty snapshot plus loading, leaving the plan list stuck in loading.
          snapshot: loadedStaticSnapshot,
          loading: false,
          error: null,
        });
        return;
      }
      if (!service) {
        setState({
          snapshot: staticSnapshot,
          loading: false,
          error: "service_unavailable",
        });
        return;
      }

      setState((current) => ({
        // With static plans moved to remote config there is no local fallback on first view;
        // keep an empty snapshot through config fetch and quote so the outer block shows one loading state, not a flash of an empty list.
        snapshot: options?.force === true ? current.snapshot : null,
        loading: true,
        error: null,
      }));

      let loadedStaticSnapshot = staticSnapshot;
      try {
        const staticProducts = await loadCodingPlanStaticProductListForTest(providerId, service);
        loadedStaticSnapshot = buildStaticProductsSnapshotFromList(providerId, staticProducts);
        const snapshot = await loadCodingPlanProducts(
          providerId,
          service,
          options?.force === true,
          staticProducts,
        );
        setState({
          snapshot,
          loading: false,
          error: null,
        });
      } catch (error) {
        const message = normalizeErrorMessage(error);
        logger.warn("[useCodingPlanProducts] Failed to read Coding Plan products", {
          providerId,
          error: message,
        });
        setState((current) => ({
          // A failed manual refresh must not overwrite the last valid preview with static plans.
          // soldOut/canPurchase/forbidden exist only in batch-preview; after fallback the cycle list miscounts sold-out as purchasable.
          snapshot: resolveCodingPlanProductsFailureSnapshot(
            current.snapshot,
            loadedStaticSnapshot,
          ),
          loading: false,
          error: message,
        }));
      }
    },
    [enabled, providerId, service, staticSnapshot, supportedProvider],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    ...state,
    refresh,
  };
}

export async function loadCodingPlanProductsForTest(
  providerId: CodingPlanProviderId,
  service: NonNullable<ReturnType<typeof useOptionalServices>>["codingPlanSubscriptionService"],
  force: boolean,
  staticProducts?: CodingPlanStaticProduct[],
): Promise<CodingPlanProductsSnapshot> {
  const now = Date.now();
  const generation = force
    ? invalidateCodingPlanProductsCache(providerId)
    : (productCacheGeneration.get(providerId) ?? 0);
  const cachedSnapshot = productSnapshotCache.get(providerId);
  if (!force && cachedSnapshot && cachedSnapshot.expiresAt > now) {
    return cachedSnapshot.snapshot;
  }

  const cachedPromise = productRequestCache.get(providerId);
  if (!force && cachedPromise) {
    return cachedPromise;
  }

  // React strict mode and settings refreshes remount plan cards in bursts;
  // the BigModel/Z.AI preview APIs sporadically return system-busy on rapid retries. Merge in-flight requests, cache only successes briefly,
  // and bypass the cache via force for manual refresh, login/connect success and completed purchases, so trade state never goes stale.
  // Login/connect must also strip older logged-out quotes of cache-write rights, so a late return cannot overwrite the logged-in quote.
  const promise = loadBatchPreviewWithStaticProducts(providerId, service, staticProducts ?? []);
  productRequestCache.set(providerId, promise);

  try {
    const snapshot = await promise;
    if ((productCacheGeneration.get(providerId) ?? 0) === generation) {
      productSnapshotCache.set(providerId, {
        snapshot,
        expiresAt: now + CODING_PLAN_PRODUCTS_CACHE_TTL_MS,
      });
    }
    return snapshot;
  } finally {
    if (productRequestCache.get(providerId) === promise) {
      productRequestCache.delete(providerId);
    }
  }
}

export async function loadCodingPlanStaticProductsSnapshotForTest(
  providerId: CodingPlanProviderId,
  service: NonNullable<ReturnType<typeof useOptionalServices>>["codingPlanSubscriptionService"],
): Promise<CodingPlanProductsSnapshot> {
  const staticProducts = await loadCodingPlanStaticProductListForTest(providerId, service);
  return buildStaticProductsSnapshotFromList(providerId, staticProducts);
}

const loadCodingPlanProducts = loadCodingPlanProductsForTest;

export function resolveCodingPlanProductsFailureSnapshot(
  currentSnapshot: CodingPlanProductsSnapshot | null,
  fallbackSnapshot: CodingPlanProductsSnapshot,
): CodingPlanProductsSnapshot {
  return currentSnapshot ?? fallbackSnapshot;
}

export function clearCodingPlanProductsCacheForTest() {
  productRequestCache.clear();
  productSnapshotCache.clear();
  productCacheGeneration.clear();
  staticProductsConfigCache = null;
  staticProductsConfigRequest = null;
}

function invalidateCodingPlanProductsCache(providerId: CodingPlanProviderId) {
  const nextGeneration = (productCacheGeneration.get(providerId) ?? 0) + 1;
  productCacheGeneration.set(providerId, nextGeneration);
  productRequestCache.delete(providerId);
  productSnapshotCache.delete(providerId);
  return nextGeneration;
}

async function loadBatchPreviewWithStaticProducts(
  providerId: CodingPlanProviderId,
  service: NonNullable<ReturnType<typeof useOptionalServices>>["codingPlanSubscriptionService"],
  staticProducts: CodingPlanStaticProduct[],
): Promise<CodingPlanProductsSnapshot> {
  const previewSnapshot = await service.batchPreview({ providerId });
  const previewByProductId = new Map(
    previewSnapshot.productList.map((product) => [product.productId, product]),
  );
  const productList =
    staticProducts.length > 0
      ? buildStaticProductDisplayList(staticProducts).map((product) =>
          mergeStaticProductWithPreview(product, previewByProductId.get(product.productId)),
        )
      : previewSnapshot.productList.map((product) => ({
          ...product,
          hasPreview: true,
        }));

  return {
    ...previewSnapshot,
    productList: filterCodingPlanPurchaseProducts(providerId, productList),
  };
}

function buildStaticProductsSnapshot(providerId: CodingPlanProviderId): CodingPlanProductsSnapshot {
  return buildStaticProductsSnapshotFromList(providerId, []);
}

function buildZaiStartStaticProducts(preview: StartPlanPreviewConfig): CodingPlanStaticProduct[] {
  const isChineseLocale =
    typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh");
  const previewName = preview.name.trim() || "Z.ai Start";
  const equityList = preview.entitlements.map((entitlement) => ({
    productEquityTitle: entitlement.showName,
    productEquityDetails: formatStartPlanPreviewEntitlement(entitlement, isChineseLocale),
  }));

  return [
    {
      productId: ZAI_START_FREE_PRODUCT_IDS.month,
      productName: previewName,
      productSmallTitle: "Free Coding Plan",
      description: "Free Coding Plan entry for connected Z.ai users.",
      productEquityList: equityList,
      priceUnit: "month",
      displayOrder: 0,
      priceCurrency: "USD",
      originalAmount: 0,
      payAmount: 0,
      monthlyPayAmount: 0,
    },
    {
      productId: ZAI_START_FREE_PRODUCT_IDS.quarter,
      productName: previewName,
      productSmallTitle: "Free Coding Plan",
      description: "Free Coding Plan entry for signed-in Z.ai users.",
      productEquityList: equityList,
      priceUnit: "quarter",
      displayOrder: 0,
      priceCurrency: "USD",
      originalAmount: 0,
      payAmount: 0,
      monthlyPayAmount: 0,
    },
    {
      productId: ZAI_START_FREE_PRODUCT_IDS.year,
      productName: previewName,
      productSmallTitle: "Free Coding Plan",
      description: "Free Coding Plan entry for signed-in Z.ai users.",
      productEquityList: equityList,
      priceUnit: "year",
      displayOrder: 0,
      priceCurrency: "USD",
      originalAmount: 0,
      payAmount: 0,
      monthlyPayAmount: 0,
    },
  ];
}

function formatStartPlanPreviewEntitlement(
  entitlement: StartPlanPreviewConfig["entitlements"][number],
  isChineseLocale: boolean,
): string {
  const amount = new Intl.NumberFormat(isChineseLocale ? "zh-CN" : "en-US").format(
    entitlement.grantUnits,
  );
  const unit = entitlement.unitType.trim();
  const period = entitlement.period.trim();
  return [amount, unit, period].filter(Boolean).join(" ");
}

export function isZaiStartFreeProductId(productId: string | null | undefined) {
  if (!productId) {
    return false;
  }
  return (
    productId === ZAI_START_FREE_PRODUCT_ID || productId.startsWith(`${ZAI_START_FREE_PRODUCT_ID}-`)
  );
}

function buildStaticProductsSnapshotFromList(
  providerId: CodingPlanProviderId,
  staticProducts: CodingPlanStaticProduct[],
): CodingPlanProductsSnapshot {
  return {
    productList: filterCodingPlanPurchaseProducts(
      providerId,
      buildStaticProductDisplayList(staticProducts),
    ),
    isSubscribed: false,
    isAuthenticated: null,
  };
}

function buildStaticProductDisplayList(
  products: CodingPlanStaticProduct[],
): CodingPlanProductDisplay[] {
  return products.map((product) => {
    const descriptionItems = normalizeCodingPlanCardCopyItems(
      typeof product.description === "string"
        ? product.description.split(/\r?\n/)
        : product.description,
    );
    return {
      ...product,
      // Display models still need the newline string for legacy card logic, while structured items are kept,
      // or per-item tooltips from client/configs are lost in normalization.
      productDescription:
        descriptionItems.length > 0
          ? descriptionItems.map((item) => item.text).join("\n")
          : typeof product.description === "string"
            ? product.description
            : undefined,
      descriptionItems,
      equity: normalizeCodingPlanCardCopyItems(product.equity ?? []),
      hasPreview: false,
    };
  });
}

export async function loadCodingPlanStaticProductListForTest(
  providerId: CodingPlanProviderId,
  service: NonNullable<ReturnType<typeof useOptionalServices>>["codingPlanSubscriptionService"],
): Promise<CodingPlanStaticProduct[]> {
  try {
    const config = await loadCodingPlanStaticProductsConfig(service);
    // Plan descriptions are maintained remotely via client/configs; the frontend must not hardcode Lite/Pro/Max overrides,
    // or the settings page keeps stale copy after remote updates.
    const remoteProducts = config[providerId] ?? [];
    if (providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan) {
      return filterCodingPlanPurchaseProducts(providerId, remoteProducts);
    }
    if (providerId !== BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan) {
      return remoteProducts;
    }

    const startPlanPreview =
      typeof service.getStartPlanPreview === "function"
        ? await service.getStartPlanPreview()
        : null;
    if (!startPlanPreview) {
      // Whether the trial plan exists is decided by client/configs.startPlanPreview.
      // No local hardcoded fallback when the field is missing, or disabled trials reappear.
      return remoteProducts;
    }

    // The Start free tier now belongs to the separate Start Plan entry and must be enabled explicitly by the remote preview flag.
    // Z.AI Coding Plan's purchase list shows paid upgrades only, so Start is not listed twice as purchasable.
    const seen = new Set<string>();
    return [...buildZaiStartStaticProducts(startPlanPreview), ...remoteProducts].filter(
      (product) => {
        if (seen.has(product.productId)) {
          return false;
        }
        seen.add(product.productId);
        return true;
      },
    );
  } catch (error) {
    logger.warn("[useCodingPlanProducts] Failed to load remote Coding Plan catalog", {
      providerId,
      error: normalizeErrorMessage(error),
    });
    return [];
  }
}

function filterCodingPlanPurchaseProducts<
  TProduct extends { productId: string | null | undefined },
>(providerId: CodingPlanProviderId, products: TProduct[]): TProduct[] {
  if (providerId !== BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan) {
    return products;
  }
  return products.filter((product) => !isZaiStartFreeProductId(product.productId));
}

async function loadCodingPlanStaticProductsConfig(
  service: NonNullable<ReturnType<typeof useOptionalServices>>["codingPlanSubscriptionService"],
): Promise<CodingPlanStaticProductsConfig> {
  const now = Date.now();
  if (staticProductsConfigCache && staticProductsConfigCache.expiresAt > now) {
    return staticProductsConfigCache.config;
  }
  if (staticProductsConfigRequest) {
    return staticProductsConfigRequest;
  }

  if (typeof service.getStaticProducts !== "function") {
    return {};
  }

  // Static plans come from remote client/configs but are only needed once the user opens the plan list;
  // a one-day cache plus in-flight merge avoids re-fetching per settings rerender or provider card.
  const request = service.getStaticProducts();
  staticProductsConfigRequest = request;
  try {
    const config = await request;
    staticProductsConfigCache = {
      config,
      expiresAt: now + CODING_PLAN_STATIC_PRODUCTS_CACHE_TTL_MS,
    };
    return config;
  } finally {
    if (staticProductsConfigRequest === request) {
      staticProductsConfigRequest = null;
    }
  }
}

function mergeStaticProductWithPreview(
  staticProduct: CodingPlanProductDisplay,
  previewProduct: CodingPlanProductPreviewPayment | undefined,
): CodingPlanProductDisplay {
  if (!previewProduct) {
    return {
      ...staticProduct,
      hasPreview: false,
    };
  }

  return {
    ...staticProduct,
    inCurrentPeriod: previewProduct.inCurrentPeriod,
    lastValid: previewProduct.lastValid,
    effectiveTime: previewProduct.effectiveTime,
    originalAmount: previewProduct.originalAmount,
    discountAmount: previewProduct.discountAmount,
    payAmount: previewProduct.payAmount,
    monthlyOriginalAmount: previewProduct.monthlyOriginalAmount,
    monthlyRenewAmount: previewProduct.monthlyRenewAmount,
    monthlyPayAmount: previewProduct.monthlyPayAmount,
    renewAmount: previewProduct.renewAmount,
    canPurchase: previewProduct.canPurchase,
    soldOut: previewProduct.soldOut,
    hasFirstTimeSubscriptionPromo: previewProduct.hasFirstTimeSubscriptionPromo,
    delay: previewProduct.delay,
    canRepurchase: previewProduct.canRepurchase,
    forbidden: previewProduct.forbidden,
    campaignDiscountDetails: previewProduct.campaignDiscountDetails,
    hasPreview: true,
  };
}

export function normalizeErrorMessage(error: unknown): string {
  const message = readErrorMessage(error);
  if (isCodingPlanSystemBusyMessage(message)) {
    // The pay API may return WAF HTML or JSON parse errors.
    // Never show that raw content; always surface a system-busy notice.
    return CODING_PLAN_SYSTEM_BUSY;
  }
  if (isCodingPlanOAuthRequiredMessage(message)) {
    // Plan/payment APIs still rely on the OAuth session.
    // On expired/corrupt/missing tokens, guide re-login/reconnect instead of surfacing the raw backend token error.
    return CODING_PLAN_OAUTH_REQUIRED_ERROR;
  }
  return message;
}

export function isCodingPlanOAuthRequiredError(error: string): boolean {
  return (
    error === CODING_PLAN_OAUTH_REQUIRED_ERROR ||
    error === "bigmodel_oauth_required" ||
    error === "zai_oauth_required" ||
    isCodingPlanOAuthRequiredMessage(error)
  );
}

export function isCodingPlanSystemBusyError(error: string): boolean {
  return error === CODING_PLAN_SYSTEM_BUSY || isCodingPlanSystemBusyMessage(error);
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return String(error);
}

function isCodingPlanSystemBusyMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized.startsWith("<!doctype") ||
    /<\s*(html|head|body|script|style|title|meta)\b/.test(normalized) ||
    normalized.includes("errors.aliyun.com") ||
    normalized.includes("request has been blocked") ||
    normalized.includes("unexpected token '<'") ||
    normalized.includes("unexpected end of json input") ||
    normalized.includes("invalid json response")
  );
}

function isCodingPlanOAuthRequiredMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized === "bigmodel_oauth_required" ||
    normalized === "zai_oauth_required" ||
    normalized.includes("oauth_required") ||
    /\b401\b|\b403\b/.test(normalized) ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("token expired") ||
    normalized.includes("expired or incorrect") ||
    normalized.includes("invalid token") ||
    normalized.includes("access token")
  );
}
