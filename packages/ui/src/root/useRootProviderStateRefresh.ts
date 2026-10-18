import { useCallback } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { logger } from "@/logger.js";

type RootProviderStateServices = Pick<IServiceAccessor, "providerSettingsService">;

export async function refreshRootProviderState(services: RootProviderStateServices): Promise<void> {
  try {
    // The provider runtime refreshes Config, Account Source, and Registry together; Root keeps no legacy snapshot.
    await services.providerSettingsService.refresh("root-provider-state-refresh");
  } catch (error) {
    logger.error("[Root] failed to refresh provider runtime:", error);
  }
}

export function useRootProviderStateRefresh(services: IServiceAccessor) {
  return useCallback(() => refreshRootProviderState(services), [services.providerSettingsService]);
}
