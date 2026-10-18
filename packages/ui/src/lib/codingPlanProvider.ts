import { type UsageEntitlementSnapshot } from "@zcode/shared";
import { type ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";

export function pickCodingPlanEntitlementProvider(
  codingPlanProvider: ProviderSettingsFormProvider | null | undefined,
): ProviderSettingsFormProvider | null {
  // Coding Plan and plain API keys are separate entry points.
  // Entitlement/model entries follow only the Coding Plan provider's own key so a plain
  // provider key cannot light up the subscription state.
  return codingPlanProvider ?? null;
}

export function hasActiveUsageEntitlementSnapshot(
  snapshot: UsageEntitlementSnapshot | null,
  providerId?: string,
): boolean {
  return resolveUsageEntitlementOutcome(snapshot, providerId) === "active";
}

type UsageEntitlementOutcome = "active" | "inactive" | "unknown";

/** Only the authoritative no_plan outcome counts as inactive; network/auth and partial snapshots stay unknown. */
export function resolveUsageEntitlementOutcome(
  snapshot: UsageEntitlementSnapshot | null,
  providerId?: string,
): UsageEntitlementOutcome {
  if (!snapshot) return "unknown";
  if (providerId && snapshot.provider?.id && snapshot.provider.id !== providerId) {
    return "unknown";
  }
  if (snapshot.unavailableReason === "no_plan") return "inactive";
  // Quota or remaining quota does not prove a subscription; personal/team entitlements
  // are proven by the subscription summary returned by the service.
  return snapshot.subscription?.details.length ? "active" : "unknown";
}
