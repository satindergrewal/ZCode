import type { IUsageStatsService } from "@zcode/services";
import { useProviderSettingsView } from "@/hooks/useProviderSettingsView.js";
import { useUsageEntitlementWithService } from "@/hooks/useUsageEntitlement.js";
import { buildStartPlanEntitlementOptions } from "@/lib/startPlanEntitlementOptions.js";

/** Consumes the target host's account view and entitlement owner; no local balance/auth state. */
export function useStartPlanEntitlement(
  providerId: string,
  service: IUsageStatsService | undefined,
  refreshOnAccess = false,
) {
  const settings = useProviderSettingsView();
  return useUsageEntitlementWithService(service, {
    ...buildStartPlanEntitlementOptions(
      settings.state.status === "ready" ? settings.state.view : null,
      providerId,
    ),
    refreshOnMount: refreshOnAccess,
    mountRefreshReason: "access",
  });
}
