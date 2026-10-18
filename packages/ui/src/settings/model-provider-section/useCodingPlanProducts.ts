/* eslint-disable max-lines -- Coding Plan handling centralizes static plans, remote previews, caching, and signed-out fallbacks; splitting it would scatter shared state. */
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
const ZAI_START_FREE_PRODUCT_ID = "zai-start-free";
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
          // Signed-out/disconnected states skip the paid batch-preview but still show static plans.
          // Returning an empty snapshot + loading here used to leave the plan list stuck loading.
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
        // With static plans now remote-configured, there is no local fallback on first view.
        // Keep an empty snapshot while config/preview load so the outer shell shows a full loading
        // state instead of flashing an empty list.
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
        logger.warn("[useCodingPlanProducts] Failed to load Coding Plan products", {
          providerId,
          error: message,
        });
        setState((current) => ({
          // A failed manual refresh must not overwrite the last valid preview with static plans.
          // soldOut/canPurchase/forbidden exist only in batch-preview; overwriting would make period
          // lists count "sold out" as subscribable.
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

async function loadCodingPlanProductsForTest(
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

  // React strict mode and settings refreshes remount plan cards in quick bursts, and the
  // BigModel/Z.AI preview endpoints intermittently return "system busy" on bursts. Coalesce in-flight
  // requests and short-cache successes only; manual refresh, login/connect success, and purchase
  // completion all bypass the cache with force so transactional state never goes stale.
  // Login/connect must also strip older signed-out previews of cache-write eligibility, so a
  // late-returning unauthenticated preview cannot overwrite the authenticated result.
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

async function loadCodingPlanStaticProductsSnapshotForTest(
  providerId: CodingPlanProviderId,
  service: NonNullable<ReturnType<typeof useOptionalServices>>["codingPlanSubscriptionService"],
): Promise<CodingPlanProductsSnapshot> {
  const staticProducts = await loadCodingPlanStaticProductListForTest(providerId, service);
  return buildStaticProductsSnapshotFromList(providerId, staticProducts);
}

const loadCodingPlanProducts = loadCodingPlanProductsForTest;

function resolveCodingPlanProductsFailureSnapshot(
  currentSnapshot: CodingPlanProductsSnapshot | null,
  fallbackSnapshot: CodingPlanProductsSnapshot,
): CodingPlanProductsSnapshot {
  return currentSnapshot ?? fallbackSnapshot;
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

function isZaiStartFreeProductId(productId: string | null | undefined) {
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
      // The display model still needs the newline-joined string for legacy card logic, alongside the
      // structured items, or per-item tooltips from client/configs are lost in normalization.
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

async function loadCodingPlanStaticProductListForTest(
  providerId: CodingPlanProviderId,
  service: NonNullable<ReturnType<typeof useOptionalServices>>["codingPlanSubscriptionService"],
): Promise<CodingPlanStaticProduct[]> {
  try {
    const config = await loadCodingPlanStaticProductsConfig(service);
    // Plan descriptions are maintained centrally in remote client/configs; the frontend must not
    // hardcode Lite/Pro/Max overrides, or the settings page shows stale copy after remote updates.
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
      // Trial-plan existence is decided by client/configs.startPlanPreview.
      // No local hardcoded fallback when the field is missing, or a config-disabled trial plan would show.
      return remoteProducts;
    }

    // The free Start tier now belongs to the dedicated Start Plan entry and must be enabled explicitly
    // by the remote preview flag. The Z.AI - Coding Plan purchase list shows paid upgrades only, so
    // Start is never listed as a purchasable duplicate.
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
    logger.warn("[useCodingPlanProducts] Failed to load remote static Coding Plan products", {
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

  // Static plans come from remote client/configs but are needed only once the user actually opens the
  // plan list. One-day in-memory cache plus in-flight request coalescing avoids re-fetching per
  // settings re-render or per provider card.
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
    // The payment endpoints can return WAF HTML or JSON parse errors; never show that raw content.
    // Normalize to the system-busy message.
    return CODING_PLAN_SYSTEM_BUSY;
  }
  if (isCodingPlanOAuthRequiredMessage(message)) {
    // Plan/payment endpoints still rely on the OAuth session. An expired, corrupted, or missing token
    // must route the user to re-login/reconnect, not surface the backend's raw token error.
    return CODING_PLAN_OAUTH_REQUIRED_ERROR;
  }
  return message;
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
