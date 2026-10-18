/* eslint-disable max-lines -- Settings and the input composer share connection-mode visibility rules; centralizing them stops Start/Coding/Team/API conditions from drifting apart. */
import type {
  ProviderFamilyDomain,
  ProviderFamilyConnectionSelection,
  ProviderFamilyConnectionSelectionSettings,
  UsageEntitlementSubscriptionDetail,
  UsageQuotaLimit,
} from "@zcode/shared";
import {
  getModelProviderFamilySpec,
  isIndividualCodingPlanModelProviderId,
  isStartPlanModelProviderId,
  MODEL_PROVIDER_FAMILY_SPECS,
  resolveModelProviderFamilySpecByProviderId,
} from "@zcode/shared";
import { resolveMcpQuotaLimit } from "@/lib/codingPlanQuotaPresentation.js";
import { resolveUsageEntitlementOutcome } from "@/lib/codingPlanProvider.js";
import { formatTeamPlanDisplayName } from "@/lib/teamPlanDisplayName.js";
import {
  resolveEnterpriseCodingPlanProductFamily,
  type EnterpriseCodingPlanProductDisplay,
} from "@/settings/model-provider-section/enterpriseCodingPlanProducts.js";
import {
  type CodingPlanEntitlementState,
  type CodingPlanStatus,
  type ModelProviderNavGroup,
} from "@/settings/model-provider-section/constants.js";

type TeamPlanNavItem = Extract<ModelProviderNavGroup["items"][number], { type: "teamPlan" }>;

function createTeamPlanNavigationKey(
  family: ProviderFamilyDomain,
  input: { productId: string; organizationId: string; projectId: string },
): string {
  return ["team", family, input.productId, input.organizationId, input.projectId]
    .map(encodeURIComponent)
    .join(":");
}

interface ResolvedCodingPlanEntitlementState {
  statusLabelId?: string;
  status: CodingPlanStatus;
  planLevel: string | null;
  currentProductId: string | null;
  subscriptionBillingCycle: string | null;
  subscriptionRenewTime: string | null;
  subscriptionExpireTime: string | null;
  subscriptionDetails?: UsageEntitlementSubscriptionDetail[];
  quotaLimits: UsageQuotaLimit[];
  /**
   * Official Server MCP quota (server-delivered total). Not part of quota.limits[]; filled only in
   * branches with a plan snapshot, default (hidden) elsewhere, so a dozen early-return branches
   * need no edits.
   */
  mcpQuotaLimit?: UsageQuotaLimit | null;
}

export function resolveCodingPlanEntitlementState({
  providerId,
  accountEntitled,
  accountAvailability,
  accountUnavailableReason,
  entitlement,
  modelProvidersLoading,
}: {
  providerId: string;
  /** Whether the current account explicitly holds the entitlement for this provider's product. */
  accountEntitled: boolean;
  accountAvailability?: import("@zcode/provider").AccountProviderState["availability"];
  accountUnavailableReason?: import("@zcode/provider").AccountProviderState["unavailableReason"];
  entitlement?: CodingPlanEntitlementState;
  modelProvidersLoading: boolean;
}): ResolvedCodingPlanEntitlementState {
  // A failed Start check is unknown; reading/retrying stays allowed, never rolled back to signed-out.
  const canInspect =
    accountEntitled ||
    accountAvailability === "pending" ||
    (isStartPlanModelProviderId(providerId) && accountAvailability === "unknown");
  if (!canInspect && modelProvidersLoading) {
    return {
      // On new-Host startup the first Account Overlay View can lag the old provider snapshot.
      // Hold checking through that window: no reading stale keys, no premature disconnected verdict.
      status: "checking",
      planLevel: null,
      currentProductId: null,
      subscriptionBillingCycle: null,
      subscriptionRenewTime: null,
      subscriptionExpireTime: null,
      quotaLimits: [],
    };
  }
  if (!canInspect) {
    // entitled=false is not "disconnected". Since provider-refactor the Account Overlay publishes only
    // the entitled boolean; "signed in with the server explicitly reporting no personal plan" and
    // "not connected" render merged as "disconnected + connect button" (the entitlement snapshot's
    // no_plan no longer decides "not purchased"), and unavailable providers no longer start
    // entitlement queries, so the UI cannot reconstruct the reason itself and relies on the
    // reason carried in State.
    // Start permanence displays by reason too; Team Plan keeps assembling from the team entitlement snapshot.
    // A reason exists only when availability === "unavailable"; unknown means undeterminable this round.
    if (
      accountAvailability === "unavailable" &&
      (isIndividualCodingPlanModelProviderId(providerId) || isStartPlanModelProviderId(providerId))
    ) {
      if (accountUnavailableReason === "not-entitled") {
        return {
          // The server explicitly reports no personal plan: "not purchased", not a connection failure.
          status: "notPurchased",
          ...(isStartPlanModelProviderId(providerId) && entitlement?.snapshot?.startPlanExpired
            ? { statusLabelId: "settings.modelProvider.startPlan.status.expired" }
            : {}),
          planLevel: null,
          currentProductId: null,
          subscriptionBillingCycle: null,
          subscriptionRenewTime: null,
          subscriptionExpireTime: null,
          quotaLimits: [],
        };
      }
      if (accountUnavailableReason === "credential-failed") {
        return {
          // A failed credential is an entitlement-sync failure, not "not purchased"; keep retry/re-login entry points.
          status: "unavailable",
          planLevel: null,
          currentProductId: null,
          subscriptionBillingCycle: null,
          subscriptionRenewTime: null,
          subscriptionExpireTime: null,
          quotaLimits: [],
        };
      }
    }
    return {
      // Plan connection is an Account Overlay fact, not an API-key fact the Renderer can read.
      // Once the new Host passes false explicitly, stale keys must not light the connected state.
      status:
        isStartPlanModelProviderId(providerId) && accountAvailability === "unknown"
          ? "unavailable"
          : "disconnected",
      planLevel: null,
      currentProductId: null,
      subscriptionBillingCycle: null,
      subscriptionRenewTime: null,
      subscriptionExpireTime: null,
      quotaLimits: [],
    };
  }

  const snapshot = entitlement?.snapshot ?? null;
  if (entitlement?.loading && !snapshot?.subscription) {
    return {
      // refresh keeps the previous snapshot; checking shows only when no valid subscription exists.
      status: "checking",
      planLevel: null,
      currentProductId: null,
      subscriptionBillingCycle: null,
      subscriptionRenewTime: null,
      subscriptionExpireTime: null,
      quotaLimits: [],
    };
  }

  if (!snapshot && entitlement?.error) {
    return {
      // A failed entitlement request must leave the loading state.
      status: "unavailable",
      planLevel: null,
      currentProductId: null,
      subscriptionBillingCycle: null,
      subscriptionRenewTime: null,
      subscriptionExpireTime: null,
      quotaLimits: [],
    };
  }

  const currentSubscription = snapshot?.subscription?.details[0] ?? null;
  const subscriptionDetails = snapshot?.subscription?.details ?? [];
  const currentProductId = currentSubscription?.productId ?? null;
  const planLevel =
    currentSubscription?.productName ?? snapshot?.quota?.level ?? currentProductId ?? null;
  const subscriptionBillingCycle = currentSubscription?.billingCycle ?? null;
  const subscriptionRenewTime = currentSubscription?.renewTime ?? null;
  const subscriptionExpireTime = currentSubscription?.expireTime ?? null;

  if (currentSubscription) {
    return {
      // Z.AI/BigModel plan truth comes from subscription/list.
      status: "purchased",
      ...(entitlement?.error
        ? { statusLabelId: "settings.modelProvider.codingPlan.status.unavailable" }
        : {}),
      planLevel,
      currentProductId,
      subscriptionBillingCycle,
      subscriptionRenewTime,
      subscriptionExpireTime,
      subscriptionDetails,
      quotaLimits: snapshot?.quota?.limits ?? [],
      mcpQuotaLimit: resolveMcpQuotaLimit(snapshot),
    };
  }

  const entitlementOutcome = resolveUsageEntitlementOutcome(snapshot);
  if (entitlementOutcome === "inactive") {
    return {
      status: "notPurchased",
      ...(isStartPlanModelProviderId(providerId) && snapshot?.startPlanExpired
        ? { statusLabelId: "settings.modelProvider.startPlan.status.expired" }
        : {}),
      planLevel: null,
      currentProductId: null,
      subscriptionBillingCycle: null,
      subscriptionRenewTime: null,
      subscriptionExpireTime: null,
      quotaLimits: [],
    };
  }

  if (entitlementOutcome === "unknown") {
    return {
      // Unknown non-no_plan snapshots used to fall back to "not purchased", letting the entitlement
      // overrule the account connection. With the account connected, unknown evidence may only show
      // temporarily unavailable.
      status: "unavailable",
      planLevel: null,
      currentProductId: null,
      subscriptionBillingCycle: null,
      subscriptionRenewTime: null,
      subscriptionExpireTime: null,
      quotaLimits: [],
    };
  }

  return {
    status: "purchased",
    ...(entitlement?.error
      ? { statusLabelId: "settings.modelProvider.codingPlan.status.unavailable" }
      : {}),
    planLevel,
    currentProductId,
    subscriptionBillingCycle,
    subscriptionRenewTime,
    subscriptionExpireTime,
    subscriptionDetails,
    quotaLimits: snapshot?.quota?.limits ?? [],
    mcpQuotaLimit: resolveMcpQuotaLimit(snapshot),
  };
}

export function buildVisibleFamilyConnectionItems({
  items,
  codingPlanEntitlements = {},
  subscribedTeamProducts,
  connectionSelections,
  teamPlanSelections,
  showPurchasedTeamPlanFallback,
}: {
  items: Array<Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }>>;
  codingPlanEntitlements?: Partial<Record<string, CodingPlanEntitlementState>>;
  subscribedTeamProducts: EnterpriseCodingPlanProductDisplay[];
  showPurchasedTeamPlanFallback: boolean;
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
  teamPlanSelections?: Partial<
    Record<
      ProviderFamilyDomain,
      Extract<ProviderFamilyConnectionSelection, { kind: "team-coding-plan" }>
    >
  >;
}): ModelProviderNavGroup["items"] {
  return appendSubscribedTeamPlanItems({
    items: filterStartPlanItemsByEntitlement({
      items,
      codingPlanEntitlements,
      subscribedTeamProducts,
      connectionSelections,
    }),
    codingPlanEntitlements,
    teamPlanSelections,
    showPurchasedTeamPlanFallback,
    subscribedTeamProducts,
  });
}

function filterStartPlanItemsByEntitlement({
  items,
  codingPlanEntitlements,
  subscribedTeamProducts,
  connectionSelections,
}: {
  items: Array<Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }>>;
  codingPlanEntitlements: Partial<Record<string, CodingPlanEntitlementState>>;
  subscribedTeamProducts: EnterpriseCodingPlanProductDisplay[];
  connectionSelections?: ProviderFamilyConnectionSelectionSettings;
}): Array<Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }>> {
  // The old name hasBigModelTeamPlan implied bigmodel-only, but the logic (entitlement or
  // subscribedTeamProducts) is family-agnostic. Renamed neutrally and the
  // familySpec.id === "bigmodel" guard removed from the filter below, so the zai family can also
  // hide the Start Plan entry due to a team plan.
  const hasAnyTeamPlan =
    hasEntitlementTeamPlan(codingPlanEntitlements) || subscribedTeamProducts.length > 0;
  return items.filter((item) => {
    if (!isStartPlanModelProviderId(item.presetId)) {
      return true;
    }
    const familySpec = resolveModelProviderFamilySpecByProviderId(item.presetId);
    if (!familySpec) {
      return false;
    }
    const codingItem = items.find(
      (candidate) => candidate.presetId === familySpec.individualCodingPlanProviderId,
    );
    const hasStartPlanEntitlement = item.status === "purchased";
    const isSelectedStartPlan = connectionSelections?.[familySpec.id]?.kind === "start-plan";
    const shouldPreserveUnresolvedSelection =
      isSelectedStartPlan && (item.status === "checking" || item.status === "unavailable");
    const loggedIn =
      item.accountEntitled === true ||
      codingItem?.accountEntitled === true ||
      isResolvedEntitlementStatus(item.status) ||
      isResolvedEntitlementStatus(codingItem?.status ?? "disconnected") ||
      hasAnyTeamPlan;

    if (!loggedIn) {
      // Signed out, the trial plan is a detail-page guide entry only, never a connection mode.
      return false;
    }

    // Start Plan is a standalone connection; individual/team Coding entitlements no longer gate visibility.
    // Keep the user's selection while checking or temporarily unavailable; hide only on explicit no-entitlement.
    return hasStartPlanEntitlement || shouldPreserveUnresolvedSelection;
  });
}

/**
 * Find the Coding Plan nav item belonging to the given family.
 * appendSubscribedTeamPlanItems used to hardcode bigmodelCodingPlan, leaving zai team plan items
 * without a presentation baseline. After zai/bigmodel symmetry, the team item's providerName,
 * provider, and other display fields inherit from the family's codingPlanItem.
 */
function resolveCodingPlanItemForFamily(
  items: Array<Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }>>,
  family: ProviderFamilyDomain,
): Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }> | undefined {
  const codingPlanProviderId = getModelProviderFamilySpec(family).individualCodingPlanProviderId;
  return items.find((item) => item.presetId === codingPlanProviderId);
}

function appendSubscribedTeamPlanItems({
  items,
  codingPlanEntitlements,
  teamPlanSelections,
  showPurchasedTeamPlanFallback,
  subscribedTeamProducts,
}: {
  items: Array<Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }>>;
  codingPlanEntitlements: Partial<Record<string, CodingPlanEntitlementState>>;
  teamPlanSelections?: Partial<
    Record<
      ProviderFamilyDomain,
      Extract<ProviderFamilyConnectionSelection, { kind: "team-coding-plan" }>
    >
  >;
  showPurchasedTeamPlanFallback: boolean;
  subscribedTeamProducts: EnterpriseCodingPlanProductDisplay[];
}): ModelProviderNavGroup["items"] {
  // The old implementation did items.find(bigmodelCodingPlan) and returned items unchanged when absent.
  // With the settings page showing only the zai family (providerFamilyDomain === "zai"), bigmodelCodingPlan
  // is not in codingPlanItems, so that guard short-circuited appendSubscribedTeamPlanItems entirely:
  // no zai teamPlan item -> pickFamilyModeNavigationItem finds no saved team item
  // -> selectedNavItem=null -> the right-hand Plan Card sticks on "loading" forever.
  // Symmetric fix: drop the bigmodel-hardcoded pre-guard; the entitlement/fallback/product builders
  // each resolve their family's codingPlanItem and skip the family when absent.

  // The entitlement+fallback builders used to run only for bigmodelCodingPlanItem, so zai's
  // entitlement snapshot and fallback selectedKey never produced a team item (broken).
  // Iterate both families, deriving entitlement team items + fallback from each family's codingPlanItem.
  const entitlementTeamItems: TeamPlanNavItem[] = MODEL_PROVIDER_FAMILY_SPECS.flatMap(
    ({ id: family }) => {
      const codingPlanItem = resolveCodingPlanItemForFamily(items, family);
      if (!codingPlanItem) {
        return [];
      }
      return buildEntitlementTeamPlanItems(codingPlanItem, codingPlanEntitlements, family);
    },
  );
  const fallbackTeamItems: TeamPlanNavItem[] = MODEL_PROVIDER_FAMILY_SPECS.flatMap(
    ({ id: family }) => {
      const selection = teamPlanSelections?.[family];
      const codingPlanItem = resolveCodingPlanItemForFamily(items, family);
      return selection && codingPlanItem
        ? buildSelectedTeamPlanFallbackItems({
            codingPlanItem,
            selection,
            showPurchasedTeamPlanFallback,
            family,
          })
        : [];
    },
  );
  if (
    entitlementTeamItems.length === 0 &&
    fallbackTeamItems.length === 0 &&
    subscribedTeamProducts.length === 0
  ) {
    return items;
  }

  const seenTeamKeys = new Set<string>();
  const productTeamItems: TeamPlanNavItem[] = subscribedTeamProducts.flatMap((product) => {
    // Resolve the family's codingPlanItem via product.family as the team item's presentation baseline.
    // bigmodel default keeps pre-family data compatible.
    const productFamily = resolveEnterpriseCodingPlanProductFamily(product);
    const codingPlanItemForProduct = resolveCodingPlanItemForFamily(items, productFamily);
    if (!codingPlanItemForProduct) {
      return [];
    }
    const projectContexts =
      product.teamProjects && product.teamProjects.length > 0
        ? product.teamProjects
        : [
            {
              organizationId: product.organizationId ?? null,
              organizationName: product.organizationName ?? null,
              projectId: product.projectId ?? null,
              projectName: product.projectName ?? null,
              apiKeyStatus: product.apiKeyStatus,
              apiKeyUnavailableReason: product.apiKeyUnavailableReason,
              apiKeyUnavailableMessage: product.apiKeyUnavailableMessage,
            },
          ];

    return projectContexts.flatMap((projectContext) => {
      const organizationId = projectContext.organizationId?.trim() ?? "";
      const projectKey = projectContext.projectId?.trim() ?? "";
      if (!organizationId || !projectKey) {
        return [];
      }
      // The dedup key must include the family dimension, or identical zai/bigmodel productId+org+project overwrite each other.
      const teamKey = `${productFamily}:${product.productId}:${organizationId}:${projectKey}`;
      if (seenTeamKeys.has(teamKey)) {
        return [];
      }
      seenTeamKeys.add(teamKey);
      const teamPlanName = resolveTeamPlanDisplayName({
        ...product,
        organizationName: projectContext.organizationName ?? product.organizationName,
        projectName: projectContext.projectName ?? product.projectName,
      });
      if (!teamPlanName) {
        // Team Plan visible copy allows only the organization name; never render a blank connection item.
        return [];
      }
      const teamProjectApiKeyUnavailable = projectContext.apiKeyStatus === "unavailable";
      const teamQuotaUnavailable = isTeamPlanQuotaUnavailable({
        codingPlanEntitlements,
        family: productFamily,
        organizationId,
        projectId: projectKey,
      });
      const teamPlanUnavailable = teamProjectApiKeyUnavailable || teamQuotaUnavailable;
      const availabilityReason = teamProjectApiKeyUnavailable
        ? ("credential-unavailable" as const)
        : teamQuotaUnavailable
          ? ("not-allocated" as const)
          : undefined;
      return [
        {
          ...codingPlanItemForProduct,
          // The display key derives from family + full team project, never reusing the request auth identity.
          key: createTeamPlanNavigationKey(productFamily, {
            productId: product.productId,
            organizationId,
            projectId: projectKey,
          }),
          presetId: getModelProviderFamilySpec(productFamily).teamCodingPlanProviderId,
          type: "teamPlan" as const,
          label: `${codingPlanItemForProduct.providerName} - ${teamPlanName}`,
          teamPlanName,
          organizationId,
          projectId: projectKey,
          // The Team Plan status card must use the same team display name as the connection mode;
          // raw productName/tier regresses to "Standard/Premium" in Chinese, losing project/organization names.
          planLevel: teamPlanName,
          inactivePlanTitle: teamPlanName,
          currentProductId: product.productId,
          // Team Plan reuses the family's Coding Plan provider, but manage must enter the team plans page;
          // inheriting the individual plan's personal/overview lands users in the wrong plan context.
          purchaseUrl: getModelProviderFamilySpec(productFamily).teamCodingPlanManageUrl,
          // An existing Team Plan entry or copyable project API key proves nothing about validity;
          // validity comes from the team quota snapshot, so a personal plan's enabled state never leaks through.
          status: teamPlanUnavailable ? ("unavailable" as const) : ("purchased" as const),
          // An unusable Project Key and unallocated team quota are different facts;
          // "team plan not allocated" shows only when the server confirms no team quota.
          statusLabelId:
            availabilityReason === "not-allocated"
              ? "settings.modelProvider.codingPlan.status.teamUnavailable"
              : undefined,
          availabilityReason,
          statusMessage: teamProjectApiKeyUnavailable
            ? (projectContext.apiKeyUnavailableMessage?.trim() ?? null)
            : null,
          subscriptionBillingCycle: null,
          subscriptionRenewTime: null,
          subscriptionExpireTime: null,
          // Without a usable zcode-team-api-key, a Team Plan project must not remain an enabled connection mode.
          // The server returns apiKeyStatus per organization/project; the UI must mark connection
          // item and status card unavailable explicitly.
          statusActive: !teamPlanUnavailable,
        },
      ];
    });
  });

  const productTeamItemsByProjectKey = new Map(
    productTeamItems.map((item) => [resolveTeamPlanProjectKey(item), item] as const),
  );
  const correctedEntitlementTeamItems = entitlementTeamItems.map(
    (item) => productTeamItemsByProjectKey.get(resolveTeamPlanProjectKey(item)) ?? item,
  );
  const correctedFallbackTeamItems = fallbackTeamItems.map(
    (item) => productTeamItemsByProjectKey.get(resolveTeamPlanProjectKey(item)) ?? item,
  );
  const correctedProjectKeys = new Set(
    correctedEntitlementTeamItems.map(resolveTeamPlanProjectKey),
  );
  const correctedFallbackProjectKeys = new Set(
    correctedFallbackTeamItems.map(resolveTeamPlanProjectKey),
  );
  const teamItems: ModelProviderNavGroup["items"] = [
    ...correctedEntitlementTeamItems,
    ...correctedFallbackTeamItems.filter(
      (item) => !correctedProjectKeys.has(resolveTeamPlanProjectKey(item)),
    ),
    ...productTeamItems.filter(
      (item) =>
        !correctedProjectKeys.has(resolveTeamPlanProjectKey(item)) &&
        !correctedFallbackProjectKeys.has(resolveTeamPlanProjectKey(item)),
    ),
  ];

  if (teamItems.length === 0) {
    return items;
  }

  // The old code hardcoded items.findIndex(bigmodelCodingPlanItem.key) as the insertion point, which
  // throws in zai-only views when bigmodelCodingPlanItem is absent (.key of undefined).
  // Instead, anchor on the codingPlanItem of the family owning the first team item; append at the end
  // when absent (same semantics as the old fallback).
  const firstTeamFamily = resolveModelProviderFamilySpecByProviderId(
    (teamItems[0] as TeamPlanNavItem | undefined)?.presetId ?? "",
  )?.id;
  const anchorCodingPlanItem = firstTeamFamily
    ? resolveCodingPlanItemForFamily(items, firstTeamFamily)
    : undefined;
  const codingPlanIndex = anchorCodingPlanItem
    ? items.findIndex((item) => item.key === anchorCodingPlanItem.key)
    : -1;
  if (codingPlanIndex < 0) {
    return [...items, ...teamItems];
  }
  return [
    ...items.slice(0, codingPlanIndex + 1),
    ...teamItems,
    ...items.slice(codingPlanIndex + 1),
  ];
}

function resolveTeamPlanDisplayName(product: EnterpriseCodingPlanProductDisplay): string | null {
  return formatTeamPlanDisplayName(product);
}

function hasEntitlementTeamPlan(
  codingPlanEntitlements: Partial<Record<string, CodingPlanEntitlementState>>,
): boolean {
  return Object.values(codingPlanEntitlements).some(
    (entitlement) =>
      entitlement?.snapshot?.context?.scope === "team" &&
      Boolean(entitlement.snapshot.context.organizationId?.trim()) &&
      Boolean(entitlement.snapshot.context.projectId?.trim()),
  );
}

function buildEntitlementTeamPlanItems(
  codingPlanItem: Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }>,
  codingPlanEntitlements: Partial<Record<string, CodingPlanEntitlementState>>,
  family: ProviderFamilyDomain,
): TeamPlanNavItem[] {
  // Previously hardcoded to the bigmodelCodingPlan bucket + bigmodel team key.
  // After zai/bigmodel symmetry, read the family's codingPlan bucket and generate its prefixed team key.
  const familySpec = getModelProviderFamilySpec(family);
  const codingPlanProviderId = familySpec.teamCodingPlanProviderId;
  const entitlement = codingPlanEntitlements[codingPlanProviderId];
  if (!entitlement) {
    return [];
  }
  const snapshot = entitlement.snapshot ?? null;
  if (snapshot?.context?.scope !== "team") {
    return [];
  }
  const organizationId = snapshot.context.organizationId?.trim() ?? "";
  const projectId = snapshot.context.projectId?.trim() ?? "";
  if (!organizationId || !projectId) {
    return [];
  }
  const currentSubscription = snapshot.subscription?.details[0] ?? null;
  const productId =
    snapshot.context.productId?.trim() ||
    currentSubscription?.productId?.trim() ||
    codingPlanItem.currentProductId?.trim() ||
    "current";
  const teamPlanName =
    snapshot.context.displayName?.trim() ||
    currentSubscription?.productName?.trim() ||
    codingPlanItem.planLevel?.trim() ||
    "Team";
  return [
    {
      ...codingPlanItem,
      key: createTeamPlanNavigationKey(family, {
        productId,
        organizationId,
        projectId,
      }),
      presetId: codingPlanProviderId,
      type: "teamPlan" as const,
      label: `${codingPlanItem.providerName} - ${teamPlanName}`,
      teamPlanName,
      organizationId,
      projectId,
      status: "purchased" as const,
      // Team Plan connection items treat the entitlement snapshot as the primary source;
      // enterprise pricing/customerInfo only corrects names and product fields afterwards, never
      // regressing the connection mode to Coding Plan.
      planLevel: teamPlanName,
      currentProductId: productId,
      purchaseUrl: familySpec.teamCodingPlanManageUrl,
      subscriptionBillingCycle: null,
      subscriptionRenewTime: null,
      subscriptionExpireTime: null,
      statusActive: true,
    },
  ];
}

function buildSelectedTeamPlanFallbackItems({
  codingPlanItem,
  selection,
  showPurchasedTeamPlanFallback,
  family,
}: {
  codingPlanItem: Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }>;
  selection: Extract<ProviderFamilyConnectionSelection, { kind: "team-coding-plan" }>;
  showPurchasedTeamPlanFallback: boolean;
  family: ProviderFamilyDomain;
}): TeamPlanNavItem[] {
  if (!showPurchasedTeamPlanFallback) {
    return [];
  }
  const teamPlanName = codingPlanItem.planLevel?.trim() || "Team";
  const familySpec = getModelProviderFamilySpec(family);
  const teamProviderId = familySpec.teamCodingPlanProviderId;
  return [
    {
      ...codingPlanItem,
      key: createTeamPlanNavigationKey(family, {
        productId: selection.productId,
        organizationId: selection.organizationId,
        projectId: selection.projectId,
      }),
      presetId: teamProviderId,
      type: "teamPlan" as const,
      label: `${codingPlanItem.providerName} - ${teamPlanName}`,
      teamPlanName,
      organizationId: selection.organizationId,
      projectId: selection.projectId,
      status: "purchased" as const,
      // Enterprise pricing may not have returned subscribed team projects yet, while shared settings
      // already persist the Team Plan selectedKey. Show the same connection mode first to avoid a
      // transient split from the input composer/registry Team Plan selection.
      planLevel: teamPlanName,
      currentProductId: selection.productId,
      purchaseUrl: familySpec.teamCodingPlanManageUrl,
      subscriptionBillingCycle: null,
      subscriptionRenewTime: null,
      subscriptionExpireTime: null,
      statusActive: true,
    },
  ];
}

function isTeamPlanQuotaUnavailable({
  codingPlanEntitlements,
  family,
  organizationId,
  projectId,
}: {
  codingPlanEntitlements: Partial<Record<string, CodingPlanEntitlementState>>;
  family: ProviderFamilyDomain;
  organizationId: string;
  projectId: string;
}): boolean {
  const codingPlanProviderId = getModelProviderFamilySpec(family).teamCodingPlanProviderId;
  const entitlement = codingPlanEntitlements[codingPlanProviderId];
  // loading/error both mean the quota truth is not settled; a momentary lack of quota must not read
  // as the server-confirmed "team plan not allocated". The detail page keeps refreshing this connection.
  if (!entitlement || entitlement.loading || entitlement.error) {
    return false;
  }
  const snapshot = entitlement.snapshot ?? null;
  if (snapshot?.context?.scope !== "team") {
    return false;
  }
  if (
    snapshot.context.organizationId?.trim() !== organizationId ||
    snapshot.context.projectId?.trim() !== projectId
  ) {
    return false;
  }
  return !snapshot.quota;
}

function resolveTeamPlanProjectKey(item: TeamPlanNavItem): string {
  const organizationId = item.organizationId?.trim() || "";
  const projectId = item.projectId?.trim() || "";
  if (organizationId && projectId) {
    return `${organizationId}:${projectId}`;
  }
  return item.key;
}

function isResolvedEntitlementStatus(status: CodingPlanStatus): boolean {
  return status !== "checking" && status !== "disconnected";
}
