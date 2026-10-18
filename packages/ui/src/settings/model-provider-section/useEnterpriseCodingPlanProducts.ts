import { useCallback, useEffect, useMemo, useState } from "react";
import {
  getModelProviderFamilySpec,
  type CodingPlanStaticTeamProduct,
  type EnterpriseCodingPlanPricingResponse,
  type ProviderFamilyDomain,
} from "@zcode/shared";
import { useOptionalServices } from "@/hooks/useServices.js";
import { isRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";
import { logger } from "@/logger.js";
import {
  resolveEnterpriseCodingPlanProductList,
  type EnterpriseCodingPlanProductDisplay,
} from "@/settings/model-provider-section/enterpriseCodingPlanProducts.js";
import { normalizeErrorMessage } from "@/settings/model-provider-section/useCodingPlanProducts.js";

interface EnterpriseCodingPlanProductsState {
  snapshot: EnterpriseCodingPlanProductsSnapshot | null;
  loading: boolean;
  error: string | null;
}

export interface EnterpriseCodingPlanProductsSnapshot {
  productList: EnterpriseCodingPlanProductDisplay[];
  raw: EnterpriseCodingPlanPricingResponse;
  authenticated: boolean;
  /** The static catalog gates the purchase banner; live pricing must not fabricate products missing from it. */
  staticProductIds?: string[];
}

export function shouldRetainEnterprisePricingSnapshotForRefresh(
  snapshot: EnterpriseCodingPlanProductsSnapshot | null,
  authenticated: boolean,
): boolean {
  return snapshot?.authenticated === authenticated;
}

export function resolveEnterprisePricingFailureSnapshot({
  currentSnapshot,
  authenticated,
  staticProducts,
  family = "bigmodel",
}: {
  currentSnapshot: EnterpriseCodingPlanProductsSnapshot | null;
  authenticated: boolean;
  staticProducts: CodingPlanStaticTeamProduct[] | undefined;
  family?: ProviderFamilyDomain;
}): EnterpriseCodingPlanProductsSnapshot | null {
  if (shouldRetainEnterprisePricingSnapshotForRefresh(currentSnapshot, authenticated)) {
    return currentSnapshot;
  }
  if (!Array.isArray(staticProducts)) {
    return null;
  }
  const raw: EnterpriseCodingPlanPricingResponse = { productList: [] };
  return {
    raw,
    productList: tagEnterpriseProductsFamily(
      resolveEnterpriseCodingPlanProductList(staticProducts, raw.productList),
      family,
    ),
    authenticated,
  };
}

/**
 * Tag the enterprise plan display list with its family (zai / bigmodel).
 * Downstream visibility functions (appendSubscribedTeamPlanItems etc.) locate the family's
 * codingPlanItem and team key prefix via family; the old list had no family field and could only
 * derive from bigmodelCodingPlan, so zai team plans never rendered.
 */
function tagEnterpriseProductsFamily(
  products: EnterpriseCodingPlanProductDisplay[],
  family: ProviderFamilyDomain,
): EnterpriseCodingPlanProductDisplay[] {
  return products.map((product) => ({ ...product, family }));
}

/**
 * The hook used to serve only the bigmodel family: getStaticTeamProducts hardcoded the
 * bigmodelCodingPlan bucket and getEnterprisePricing passed no family.
 * After zai-family symmetry, the hook takes a family parameter:
 *   - reads the family's static bucket (zaiCodingPlan / bigmodelCodingPlan)
 *   - passes family to service.getEnterprisePricing, which routes to the matching provider
 * A missing family keeps bigmodel, preserving existing call sites.
 */
export function useEnterpriseCodingPlanProducts({
  enabled,
  authenticated,
  family = "bigmodel",
  staticOnly = false,
}: {
  enabled: boolean;
  /** The signed-out purchase banner reads only the public static catalog, never live pricing. */
  staticOnly?: boolean;
  authenticated: boolean;
  family?: ProviderFamilyDomain;
}) {
  const services = useOptionalServices();
  const service = services?.codingPlanSubscriptionService;
  const codingPlanProviderId = getModelProviderFamilySpec(family).individualCodingPlanProviderId;
  const [state, setState] = useState<EnterpriseCodingPlanProductsState>({
    snapshot: null,
    loading: enabled,
    error: null,
  });

  const refresh = useCallback(
    async (_options?: { force?: boolean }) => {
      if (!enabled) {
        setState((current) => ({
          snapshot: current.snapshot,
          loading: false,
          error: null,
        }));
        return;
      }
      if (!service) {
        setState({
          snapshot: null,
          loading: false,
          error: "service_unavailable",
        });
        return;
      }

      setState((current) => ({
        // Enterprise/individual switches and auth refreshes must not replace the plan area with a
        // full-block loading; keep the previous enterprise data so refresh state shows only in the
        // refresh button and per-card status.
        // Public and authenticated pricing differ in field semantics, so switching the auth source
        // must drop stale data, or the upgrade list keeps showing unauthenticated plan results.
        snapshot: shouldRetainEnterprisePricingSnapshotForRefresh(current.snapshot, authenticated)
          ? current.snapshot
          : null,
        loading: true,
        error: null,
      }));

      try {
        // The static catalog is display configuration; pricing is the authority for subscription
        // identity and live prices. Request them independently so a grayscale environment missing new
        // config fields cannot block purchased-Team Plan recovery.
        const [staticResult, pricingResult] = await Promise.allSettled([
          service.getStaticTeamProducts(),
          staticOnly
            ? Promise.resolve<EnterpriseCodingPlanPricingResponse>({ productList: [] })
            : service.getEnterprisePricing({ authenticated, family }),
        ]);
        const staticProducts =
          staticResult.status === "fulfilled"
            ? Object.prototype.hasOwnProperty.call(staticResult.value, codingPlanProviderId)
              ? staticResult.value[codingPlanProviderId]
              : undefined
            : undefined;
        const raw: EnterpriseCodingPlanPricingResponse =
          pricingResult.status === "fulfilled" ? pricingResult.value : { productList: [] };
        const pricingError = pricingResult.status === "rejected" ? pricingResult.reason : null;
        if (pricingError) {
          const message = normalizeErrorMessage(pricingError);
          setState((current) => ({
            // A pricing refresh failure means live state is unknown; never overwrite the last valid
            // same-auth subscription identity and prices with the static catalog or an empty list.
            // Static disabled cards appear only on first failure.
            snapshot: resolveEnterprisePricingFailureSnapshot({
              currentSnapshot: current.snapshot,
              authenticated,
              staticProducts,
              family,
            }),
            loading: false,
            error: message,
          }));
          if (!isRemoteWorkspaceDisconnectedError(pricingError)) {
            logger.warn("[useEnterpriseCodingPlanProducts] Failed to load enterprise live pricing", {
              authenticated,
              error: message,
            });
          }
          return;
        }
        setState({
          snapshot: {
            raw,
            staticProductIds: staticProducts?.map((product) => product.productId) ?? [],
            productList: tagEnterpriseProductsFamily(
              resolveEnterpriseCodingPlanProductList(staticProducts, raw.productList),
              family,
            ),
            authenticated,
          },
          loading: false,
          error: pricingError ? normalizeErrorMessage(pricingError) : null,
        });
        if (
          staticResult.status === "rejected" &&
          !isRemoteWorkspaceDisconnectedError(staticResult.reason)
        ) {
          logger.warn("[useEnterpriseCodingPlanProducts] Team static config failed; falling back to live pricing", {
            authenticated,
            error: normalizeErrorMessage(staticResult.reason),
          });
        }
      } catch (error) {
        const message = normalizeErrorMessage(error);
        // The remote workspace shell can render briefly before attachment binding; a disconnected-proxy
        // error is then an expected initialization wait, not a pricing failure. Real RPC errors keep warn.
        if (!isRemoteWorkspaceDisconnectedError(error)) {
          logger.warn("[useEnterpriseCodingPlanProducts] Failed to load enterprise Coding Plan products", {
            authenticated,
            error: message,
          });
        }
        setState((current) => ({
          // Clearing the snapshot on pricing failure would leave the team plan page with only
          // "no purchasable plans", hiding whether the API failed or the catalog is truly empty.
          // Keep the last visible plans and surface the error to the UI instead of disguising a
          // recoverable refresh failure as an empty list.
          snapshot: shouldRetainEnterprisePricingSnapshotForRefresh(current.snapshot, authenticated)
            ? current.snapshot
            : null,
          loading: false,
          error: message,
        }));
      }
    },
    [authenticated, codingPlanProviderId, enabled, family, service, staticOnly],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return useMemo(
    () => ({
      ...state,
      refresh,
    }),
    [refresh, state],
  );
}
