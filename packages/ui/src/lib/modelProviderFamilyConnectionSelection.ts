import type {
  EnterpriseCodingPlanPricingProduct,
  ProviderFamilyConnectionSelection,
  ProviderFamilyDomain,
  UsageEntitlementSnapshot,
} from "@zcode/shared";
import { getModelProviderFamilySpec } from "@zcode/shared";
import { hasActiveUsageEntitlementSnapshot } from "@/lib/codingPlanProvider.js";

export type ModelProviderFamilyConnectionSelection = ProviderFamilyConnectionSelection;

/** Map the current family connection intent to the corresponding built-in account provider identity. */
export function resolveModelProviderFamilyConnectionProviderId(params: {
  providerFamilyDomain: ProviderFamilyDomain;
  selection: ProviderFamilyConnectionSelection;
}): string {
  const familySpec = getModelProviderFamilySpec(params.providerFamilyDomain);
  switch (params.selection.kind) {
    case "start-plan":
      return familySpec.startPlanProviderId;
    case "individual-coding-plan":
      return familySpec.individualCodingPlanProviderId;
    case "team-coding-plan":
      return familySpec.teamCodingPlanProviderId;
  }
}

export function resolveFirstSubscribedTeamPlanConnectionWithContext(params: {
  teamProducts: readonly EnterpriseCodingPlanPricingProduct[];
}): Extract<ProviderFamilyConnectionSelection, { kind: "team-coding-plan" }> | null {
  for (const product of params.teamProducts) {
    if (product.subscribed !== true) continue;
    const projectContexts =
      product.teamProjects && product.teamProjects.length > 0
        ? product.teamProjects
        : [
            {
              organizationId: product.organizationId ?? "",
              projectId: product.projectId ?? "",
              apiKeyStatus: product.apiKeyStatus,
            },
          ];
    for (const projectContext of projectContexts) {
      if (projectContext.apiKeyStatus === "unavailable") continue;
      const organizationId = projectContext.organizationId?.trim() ?? "";
      const projectId = projectContext.projectId?.trim() ?? "";
      if (!organizationId || !projectId) continue;
      return {
        kind: "team-coding-plan",
        productId: product.productId,
        organizationId,
        projectId,
      };
    }
  }
  return null;
}

export function resolveAutomaticModelProviderFamilyConnectionSelection(params: {
  providerFamilyDomain: ProviderFamilyDomain;
  codingPlanEntitlement: UsageEntitlementSnapshot | null;
  startPlanEntitlement: UsageEntitlementSnapshot | null;
  teamProducts?: readonly EnterpriseCodingPlanPricingProduct[];
  /** First login may land on the purchase entry; repairing an existing connection only picks confirmed-available plans. */
  allowPurchaseEntry?: boolean;
  /** The Account View's canonical verdict takes precedence over legacy balance snapshots, especially pending-vs-available. */
  codingPlanAvailable?: boolean;
  startPlanAvailable?: boolean;
}): ModelProviderFamilyConnectionSelection | null {
  const familySpec = getModelProviderFamilySpec(params.providerFamilyDomain);

  if (
    params.codingPlanAvailable ??
    hasActiveUsageEntitlementSnapshot(
      params.codingPlanEntitlement,
      familySpec.individualCodingPlanProviderId,
    )
  ) {
    return {
      kind: "individual-coding-plan",
    };
  }

  // The old familySpec.id === "bigmodel" guard left zai unrecognized even with a subscribed
  // team. With the guard gone, both provider families read the structured team selection.
  const teamSelection = resolveFirstSubscribedTeamPlanConnectionWithContext({
    teamProducts: params.teamProducts ?? [],
  });
  if (teamSelection) return teamSelection;

  if (params.allowPurchaseEntry === false) return null;
  // The post-OAuth-login composer connection must keep OAuth semantics. Even without Start,
  // personal Coding, or team Coding on the current account, land on the personal Coding entry
  // and let the purchase/unavailable states take over, instead of silently switching to API key.
  return {
    kind: "individual-coding-plan",
  };
}
