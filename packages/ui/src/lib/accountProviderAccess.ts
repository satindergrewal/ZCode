import type { ProviderSettingsView } from "@zcode/services";
import { type ZCodeProviderAccountAccess, zcodeProviderAccountAccessSchema } from "@zcode/shared";

export interface EntitledAccountProviderAccess {
  readonly providerId: string;
  readonly access: ZCodeProviderAccountAccess;
  readonly label?: string;
}

export function resolveEntitledAccountProviderAccess(
  view: ProviderSettingsView | null | undefined,
  providerId: string,
): EntitledAccountProviderAccess | null {
  const provider = view?.providers.find((entry) => entry.providerId === providerId);
  if (provider?.effectiveConfig.access?.type !== "zhipu-account") {
    return null;
  }

  // Registry Access is a static accountType/mode constraint; dynamic planKind and Team scope
  // can only be resolved by the account service at request time. The legacy schema would
  // misjudge every real Registry provider as empty.
  const parsed = zcodeProviderAccountAccessSchema.safeParse(provider.effectiveConfig.access);
  if (!parsed.success || parsed.data.entitled !== true) return null;
  const label = provider.providerName?.trim();
  return {
    providerId,
    access: parsed.data,
    ...(label ? { label } : {}),
  };
}

export function resolveEntitledAccountProviderAccessFingerprint(
  view: ProviderSettingsView | null | undefined,
  providerId: string,
): string {
  const access = resolveEntitledAccountProviderAccess(view, providerId);
  return access ? JSON.stringify([view?.revision, access.providerId, access.access]) : "";
}

/**
 * Plan read-only queries are not the execution model. Pending/unselected accounts still
 * need their entitlements shown; current must not be required.
 * Only balance/subscription queries may use this; never model requests or ModelSelection completion.
 */
export function resolveAccountProviderInspectionAccess(
  view: ProviderSettingsView | null | undefined,
  providerId: string,
): EntitledAccountProviderAccess | null {
  const provider = view?.providers.find((entry) => entry.providerId === providerId);
  if (!provider) return null;
  // Even with no explicit Start entitlement, still query the expiry reason read-only;
  // execution access stays gated by entitled.
  if (
    provider.accountState?.availability === "unavailable" &&
    !(
      provider.effectiveConfig.access?.type === "zhipu-account" &&
      provider.effectiveConfig.access.mode === "start-plan" &&
      provider.accountState.unavailableReason === "not-entitled"
    )
  )
    return null;
  const parsed = zcodeProviderAccountAccessSchema.safeParse(provider.effectiveConfig.access);
  if (!parsed.success || parsed.data.mode === "off-peak") return null;
  if (!provider.accountState && parsed.data.entitled !== true) return null;
  return { providerId, access: parsed.data };
}
