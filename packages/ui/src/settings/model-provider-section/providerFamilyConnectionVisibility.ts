/* eslint-disable max-lines -- Connection-mode visibility rules shared by Settings and the composer, kept in one place so Start/Coding/Team/API conditions cannot drift. */
import type {
  ProviderFamilyDomain,
  ProviderFamilyConnectionSelection,
  ProviderFamilyConnectionSelectionSettings,
  UsageEntitlementSubscriptionDetail,
  UsageQuotaLimit,
} from "@zcode/shared";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
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

export interface ResolvedCodingPlanEntitlementState {
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
   * Official Server MCP quota (the server-issued total). Not in quota.limits[]; filled only on the plan-snapshot branch,
   * other branches stay default (i.e. hidden) so a dozen early returns need no edits.
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
  // A failed Start check counts as unknown; keep read/retry available, never downgrade to logged-out.
  const canInspect =
    accountEntitled ||
    accountAvailability === "pending" ||
    (isStartPlanModelProviderId(providerId) && accountAvailability === "unknown");
  if (!canInspect && modelProvidersLoading) {
    return {
      // On a new host, the Account Overlay's first View may lag the old
      // provider snapshot. The window must stay checking: no reads of the old key, no early disconnected verdict.
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
    // entitled=false is not disconnected. After provider-refactor the Account Overlay publishes
    // only a boolean, so logged-in-with-no-personal-plan and not-connected render
    // merged as not-connected + connect button (not no_plan's not-provisioned), and an unavailable provider
    // never re-queries entitlement; the UI cannot reconstruct why and must trust the reason shipped with state.
    // The always-on Start surface reasons the same way; Team Plan keeps assembling from the team entitlement snapshot.
    // Reasons apply only when availability === "unavailable"; unknown means undetermined this round.
    if (
      accountAvailability === "unavailable" &&
      (isIndividualCodingPlanModelProviderId(providerId) || isStartPlanModelProviderId(providerId))
    ) {
      if (accountUnavailableReason === "not-entitled") {
        return {
          // The server explicitly has no personal plan: not provisioned, not a connection failure.
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
          // Invalid credentials are an entitlement-sync failure, not a non-purchase; keep retry/re-login available.
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
      // Plan connection is Account Overlay truth, not an API-key fact the renderer can read.
      // Once the new host passes false, the old key must not light up connected again.
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
      // refresh keeps the previous round's snapshot; show checking only when no valid subscription exists.
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
      // A failed entitlement request must exit the loading state.
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
      // Z.AI/BigModel's real plan state comes from subscription/list.
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
      // Unknown non-no_plan snapshots used to fall back to not-purchased, letting entitlement
      // overrule the account's connected state. With the account connected, unknown evidence may only show temporarily unavailable.
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

export function buildVisibleFamilyConnectionKeys({
  items,
  subscribedTeamProducts,
  showPurchasedTeamPlanFallback,
  modelProviders,
}: {
  items: Array<Extract<ModelProviderNavGroup["items"][number], { type: "codingPlan" }>>;
  subscribedTeamProducts: EnterpriseCodingPlanProductDisplay[];
  showPurchasedTeamPlanFallback: boolean;
  modelProviders: readonly ProviderSettingsFormProvider[];
}): Set<string> {
  const visibleItems = buildVisibleFamilyConnectionItems({
    items,
    codingPlanEntitlements: {},
    subscribedTeamProducts,
    connectionSelections: {},
    teamPlanSelections: {},
    showPurchasedTeamPlanFallback,
  });
  const keys = new Set(visibleItems.map((item) => item.key));
  void modelProviders;
  return keys;
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
  // The old hasBigModelTeamPlan name implies bigmodel-only, but the logic
  // (entitlement or subscribedTeamProducts) is family-agnostic.
  // Renamed neutrally and dropped the familySpec.id === "bigmodel" guard in the filter below,
  // so the zai family can also hide the Start Plan entry via team plan.
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
      // Logged out, the trial plan is a detail-page guide entry only, never a connection mode.
      return false;
    }

    // Start Plan is a separate connection; personal/team Coding entitlements no longer affect visibility.
    // While querying or temporarily unavailable, keep the user's selection; hide only on an explicit no-entitlement.
    return hasStartPlanEntitlement || shouldPreserveUnresolvedSelection;
  });
}

/**
 * Find the Coding Plan nav item for the given family.
 * The old appendSubscribedTeamPlanItems hardcoded bigmodelCodingPlan, leaving
 * zai team plan items without a display baseline. After the zai/bigmodel symmetry pass, the team item's
 * providerName/provider and other display fields inherit from that family's codingPlanItem.
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
  // The old code did items.find(bigmodelCodingPlan) and otherwise returned items.
  // When the settings page shows only the zai family (providerFamilyDomain === "zai"), codingPlanItems
  // has no bigmodelCodingPlan and that guard short-circuits the whole append,
  // the zai team item never spawns, pickFamilyModeNavigationItem finds no saved team item,
  // selectedNavItem stays null and the right-hand Plan card is stuck loading forever.
  // Symmetry fix: drop the bigmodel-hardcoded guard; the entitlement/fallback/product builders
  // each resolve their own family's codingPlanItem, skipping the family when absent.

  // The entitlement and fallback builders used to run only for bigmodelCodingPlanItem,
  // so zai's entitlement snapshot and fallback selectedKey never produced a team item (broken).
  // Walk both families, deriving each one's entitlement team items + fallback from its own codingPlanItem.
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
    // Pick the per-family codingPlanItem by product.family as the team item's display baseline.
    // Default to bigmodel for legacy data without a family marker.
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
      // The dedup key must include the family dimension, or equal productId+org+project across zai/bigmodel overwrite each other.
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
        // Team Plan visible copy may only use the org name; without it, never render a blank connection item.
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
          // The display key is per family and full team project; never reuse the request auth identity.
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
          // The Team Plan status card must use the same team display name as the connection mode.
          // Rendering the raw tier degrades to generic tier labels, losing the project/org name.
          planLevel: teamPlanName,
          inactivePlanTitle: teamPlanName,
          currentProductId: product.productId,
          // Team Plan reuses the family's Coding Plan provider, but Manage must open the team plan page;
          // inheriting the personal plan's personal/overview lands users in the wrong plan context.
          purchaseUrl: getModelProviderFamilySpec(productFamily).teamCodingPlanManageUrl,
          // Fix rationale: an existing Team Plan entry plus a ready Project Key ID do not prove the team plan is valid.
          // Validity comes from the team quota snapshot, avoiding a stale personal-plan enabled state.
          status: teamPlanUnavailable ? ("unavailable" as const) : ("purchased" as const),
          // A missing Project Key and unassigned team quota are different facts.
          // Show team-plan-unassigned only when the server explicitly reports no team quota.
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
          // Fix rationale: without a dedicated Key ID the Team Plan project cannot switch tokens; mark the connection unavailable.
          // The server returns apiKeyStatus per org/project; mark the connection item and status card unavailable.
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

  // The old code hardcoded items.findIndex(bigmodelCodingPlanItem.key) as the insertion point;
  // in zai-only views bigmodelCodingPlanItem is missing and .key throws on undefined.
  // Anchor instead on the codingPlanItem of the family that owns the first team item;
  // append at the end when missing (same semantics as the old fallback).
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
  // The old code hardcoded the bigmodelCodingPlan bucket plus the bigmodel team key.
  // After the symmetry pass: read the family's codingPlan bucket and build its prefixed team key.
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
      // The Team Plan connection item treats the entitlement snapshot as the primary source.
      // enterprise pricing/customerInfo only correct name/product fields later; never fall back to Coding Plan.
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
      // enterprise pricing may not yet have returned subscribed team projects,
      // but shared settings already persist the Team Plan selectedKey. The settings page must show the same connection mode
      // to avoid a transient mismatch with the composer/registry Team Plan selection.
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
  // loading/error mean the quota fact is undetermined; do not treat a transient no-quota
  // as a server-declared team-plan-unassigned. The detail page keeps refreshing this connection.
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
