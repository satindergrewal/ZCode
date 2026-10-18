import {
  BUILTIN_MODEL_PROVIDER_IDS,
  type ProviderFamilyDomain,
  type UsageEntitlementSnapshot,
} from "@zcode/shared";
import type { SidebarUsageCodingPlanProviderId } from "@/lib/sidebarUsageCodingPlanProviderPreference.js";

export function resolveSidebarCodingPlanUpgradeFallbackProviderId(
  providerFamilyDomain: ProviderFamilyDomain | null,
): SidebarUsageCodingPlanProviderId {
  // API-key mode injects no plan key for Coding Plan providers, so the avatar upgrade entry
  // cannot derive the provider from entitlement/usage; fall back by provider family domain to the brand entry.
  return providerFamilyDomain === "bigmodel"
    ? BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
    : BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
}

function normalizePlanLevel(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function hasPlanLevelToken(value: string | null | undefined, token: string): boolean {
  return new RegExp(`(^|[\\s_-])${token}($|[\\s_-])`, "i").test(value?.trim() ?? "");
}

function isTerminalCodingPlanLevel(value: string | null | undefined): boolean {
  const normalized = normalizePlanLevel(value);
  // Whether the plan tier is a non-upgradable terminal state: enterprise/team count as terminal.
  return normalized.includes("enterprise") || normalized.includes("team");
}

function isMaxCodingPlanLevel(value: string | null | undefined): boolean {
  const normalized = normalizePlanLevel(value);
  return normalized === "max" || hasPlanLevelToken(value, "max");
}

export function isTerminalCodingPlanSnapshot(snapshot: UsageEntitlementSnapshot | null): boolean {
  if (!snapshot) {
    return false;
  }

  if (isTerminalCodingPlanLevel(snapshot.quota?.level)) {
    return true;
  }

  return (snapshot.subscription?.details ?? []).some((detail) => {
    const productId = normalizePlanLevel(detail.productId);
    const productName = normalizePlanLevel(detail.productName);
    return isTerminalCodingPlanLevel(productId) || isTerminalCodingPlanLevel(productName);
  });
}

export function isMaxCodingPlanSnapshot(snapshot: UsageEntitlementSnapshot | null): boolean {
  if (!snapshot) {
    return false;
  }

  if (isMaxCodingPlanLevel(snapshot.quota?.level)) {
    return true;
  }

  return (snapshot.subscription?.details ?? []).some((detail) => {
    const productId = detail.productId;
    const productName = detail.productName;
    return isMaxCodingPlanLevel(productId) || isMaxCodingPlanLevel(productName);
  });
}
