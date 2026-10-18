import type { ISettingService } from "@zcode/services";
import {
  type AppSettings,
  type ProviderFamilyConnectionSelectionSettings,
  type ProviderFamilyDomain,
} from "@zcode/shared";

export function resolveLogoutProviderFamilyDomain(params: {
  currentDomain: ProviderFamilyDomain | null | undefined;
}): ProviderFamilyDomain | null {
  void params;
  return null;
}

export async function setProviderFamilyDomain(
  settingService: Pick<ISettingService, "get" | "update">,
  domain: ProviderFamilyDomain,
): Promise<void> {
  const currentSettings = await settingService.get();
  await settingService.update({
    providerFamilyDomain: domain,
    providerFamilyDomainUpdatedAt: Date.now(),
    providerFamilyDomainMigrated: true,
    // A WelcomeScreen OAuth sign-in means the user chose the same-family Coding Plan/OAuth mode.
    // Writing providerFamilyDomain only would keep the apiKey mode written by the earlier API-key entry, leaving the user on API-key after login.
    providerFamilyConnectionSelections: buildOAuthProviderFamilySelections(
      domain,
      currentSettings.providerFamilyConnectionSelections,
    ),
  });
}

export function buildOAuthProviderFamilySelections(
  domain: ProviderFamilyDomain,
  currentSelections: ProviderFamilyConnectionSelectionSettings | null | undefined,
): ProviderFamilyConnectionSelectionSettings {
  return {
    ...currentSelections,
    [domain]: { kind: "individual-coding-plan" },
  };
}

export async function clearProviderFamilyDomain(
  settingService: Pick<ISettingService, "update">,
): Promise<void> {
  await settingService.update({
    // 清理原因：providerFamilyDomain 通过 RPC 传 undefined 容易被吞掉。
    // settingService 会把空串归一成 undefined，确保退出/解绑后不会继续过滤到旧 domain。
    providerFamilyDomain: "" as AppSettings["providerFamilyDomain"],
    providerFamilyDomainUpdatedAt: Date.now(),
    providerFamilyDomainMigrated: true,
  });
}
