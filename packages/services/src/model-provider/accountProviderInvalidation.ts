export interface SettingUpdatedEvent {
  readonly keys: readonly string[];
}

interface AccountProviderInvalidationOptions {
  readonly onDidUpdateSetting: (listener: (event: SettingUpdatedEvent) => void) => () => void;
  readonly refresh: (reason: string) => Promise<unknown>;
}

const ACCOUNT_PROVIDER_SETTING_KEYS = new Set([
  "providerFamilyDomain",
  "providerFamilyConnectionSelections",
  "zcodeEndpointOrigin",
]);

/**
 * Converges Settings changes that alter the account connection selection into AccountProviderService refreshes.
 *
 * OAuth sign-in/out and purchase completion refresh the Account Source in their own flows; this no longer
 * subscribes to the retired Registry's events, avoiding a parallel fact source.
 */
export function bindAccountProviderInvalidation(
  options: AccountProviderInvalidationOptions,
): () => void {
  const requestRefresh = (reason: string): void => {
    void options.refresh(reason).catch(() => {
      // AccountProviderService records failures via onDidRefreshError and keeps last-known-good.
    });
  };
  const disposeSetting = options.onDidUpdateSetting((event) => {
    const keys = event.keys.filter((key) => ACCOUNT_PROVIDER_SETTING_KEYS.has(key));
    if (keys.length > 0) {
      requestRefresh(`settings:${keys.join(",")}`);
    }
  });

  return () => {
    disposeSetting();
  };
}
