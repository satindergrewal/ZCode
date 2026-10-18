import type { UsageEntitlementSnapshot } from "@zcode/shared";
import { hasActiveCodingPlanSnapshot } from "@/CodingPlanUsageRemainingPanel.js";

export type SidebarFooterProfilePlanBadge =
  | {
      audience: "individual";
      snapshot: UsageEntitlementSnapshot;
    }
  | {
      audience: "team";
      snapshot?: never;
    };

export function resolveSidebarFooterProfilePlanBadge({
  hasTeamPlanEntitlement,
  individualEntitlements,
}: {
  hasTeamPlanEntitlement: boolean;
  individualEntitlements: Array<{
    providerId: string;
    snapshot: UsageEntitlementSnapshot | null;
    loading?: boolean;
  }>;
}): SidebarFooterProfilePlanBadge | null {
  const activeIndividualEntitlement = individualEntitlements.find((entitlement) =>
    hasActiveCodingPlanSnapshot(entitlement.snapshot, entitlement.providerId),
  );
  if (activeIndividualEntitlement?.snapshot) {
    return {
      audience: "individual",
      snapshot: activeIndividualEntitlement.snapshot,
    };
  }

  if (individualEntitlements.some((entitlement) => entitlement.loading)) {
    return null;
  }

  // The avatar badge shows confirmed entitlements only: personal grants show the plan tier, and
  // Team shows only with a team grant and no personal grant. Never fall back to the connection
  // kind or a stale selectedKey, or switching families mislabels the account as Team.
  return hasTeamPlanEntitlement ? { audience: "team" } : null;
}

export function resolveSidebarFooterPlanBadgeLabel(
  snapshot: UsageEntitlementSnapshot | null,
): string | null {
  if (!snapshot || snapshot.unavailableReason === "no_plan") {
    return null;
  }

  const rawLabel =
    snapshot.quota?.level?.trim() || snapshot.subscription?.details[0]?.productName?.trim() || null;
  if (!rawLabel) {
    return null;
  }

  const withoutPrefix = rawLabel.replace(/^glm\s+coding\s+/i, "").trim();
  const normalized = withoutPrefix || rawLabel;
  return normalized.length > 0 ? normalizePlanBadgeWordCasing(normalized) : null;
}

function normalizePlanBadgeWordCasing(label: string): string {
  if (!/^[a-z][a-z0-9 -]*$/i.test(label)) {
    return label;
  }

  return label.replace(/\b[a-z][a-z0-9]*\b/gi, (word) => {
    if (word.length <= 1) {
      return word.toUpperCase();
    }
    return word.slice(0, 1).toUpperCase() + word.slice(1).toLowerCase();
  });
}
