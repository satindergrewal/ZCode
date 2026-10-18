import type { AppSettings } from "@zcode/shared";

export function normalizeSettingsPatch(patch: Partial<AppSettings>): Partial<AppSettings> {
  const normalizedPatch = { ...patch };

  if (
    "locale" in normalizedPatch &&
    !("localePreference" in normalizedPatch) &&
    typeof normalizedPatch.locale === "string"
  ) {
    // locale is the resolved language; localePreference is the user's choice.
    // Legacy locale-only writes count as an explicit fix, not a revert to system next boot.
    normalizedPatch.localePreference = normalizedPatch.locale;
  }

  if (
    "terminalFontFamily" in normalizedPatch &&
    typeof normalizedPatch.terminalFontFamily === "string"
  ) {
    // Terminal font override must support clearing back to system auto-detection.
    // RPC drops undefined: normalize empty string to undefined so old fonts do not stick.
    const trimmedTerminalFontFamily = normalizedPatch.terminalFontFamily.trim();
    normalizedPatch.terminalFontFamily =
      trimmedTerminalFontFamily.length > 0 ? trimmedTerminalFontFamily : undefined;
  }

  if ("integratedTerminalShell" in normalizedPatch) {
    const selection = normalizedPatch.integratedTerminalShell;
    if (selection?.mode === "auto") {
      // The settings 'auto' means removing the override; the Bash layer keeps platform auto-detect.
      normalizedPatch.integratedTerminalShell = undefined;
    } else if (selection?.mode === "shell") {
      normalizedPatch.integratedTerminalShell = {
        ...selection,
        id: selection.id.trim(),
        label: selection.label.trim(),
        path: selection.path.trim(),
      };
    }
  }

  if ("httpProxy" in normalizedPatch && typeof normalizedPatch.httpProxy === "string") {
    // Clearing the proxy now means explicit direct, no fallback to shell env.
    // RPC drops undefined: empty string normalizes to undefined so old proxies leave setting.json.
    const trimmedHttpProxy = normalizedPatch.httpProxy.trim();
    normalizedPatch.httpProxy = trimmedHttpProxy.length > 0 ? trimmedHttpProxy : undefined;
  }

  if (
    "httpProxyNoProxy" in normalizedPatch &&
    typeof normalizedPatch.httpProxyNoProxy === "string"
  ) {
    // No-proxy is part of proxy policy; clearing must delete the old value
    // or agents/renderers bypass the explicit proxy next boot.
    const trimmedHttpProxyNoProxy = normalizedPatch.httpProxyNoProxy.trim();
    normalizedPatch.httpProxyNoProxy =
      trimmedHttpProxyNoProxy.length > 0 ? trimmedHttpProxyNoProxy : undefined;
  }

  if (
    "httpProxyCaCertPath" in normalizedPatch &&
    typeof normalizedPatch.httpProxyCaCertPath === "string"
  ) {
    // Custom CA comes from an explicit settings path; clearing must delete the old value
    // or NODE_EXTRA_CA_CERTS returns on restart.
    const trimmedHttpProxyCaCertPath = normalizedPatch.httpProxyCaCertPath.trim();
    normalizedPatch.httpProxyCaCertPath =
      trimmedHttpProxyCaCertPath.length > 0 ? trimmedHttpProxyCaCertPath : undefined;
  }

  if (
    "zcodeEndpointOrigin" in normalizedPatch &&
    typeof normalizedPatch.zcodeEndpointOrigin === "string"
  ) {
    // Non-prod endpoint override supports Reset-to-clear; empty string also restores the default domain.
    const trimmedZCodeEndpointOrigin = normalizedPatch.zcodeEndpointOrigin.trim();
    normalizedPatch.zcodeEndpointOrigin =
      trimmedZCodeEndpointOrigin.length > 0 ? trimmedZCodeEndpointOrigin : undefined;
  }

  if (
    "providerFamilyDomain" in normalizedPatch &&
    typeof normalizedPatch.providerFamilyDomain === "string"
  ) {
    // Leaving a provider family clears the runtime domain;
    // RPC drops undefined: empty string normalizes so the old choice stops filtering the registry.
    const trimmedProviderFamilyDomain = normalizedPatch.providerFamilyDomain.trim();
    normalizedPatch.providerFamilyDomain =
      trimmedProviderFamilyDomain.length > 0 ? normalizedPatch.providerFamilyDomain : undefined;
  }

  if (
    "dynamicWorkflowMode" in normalizedPatch &&
    (normalizedPatch.dynamicWorkflowMode as string | undefined) === ""
  ) {
    // docs/dynamic-workflow/launch.md「The user's choice」：选回服务端提供的模式等于删除选择，
    // 安装才能继续跟随服务端翻转。RPC 会吞掉 undefined，这里把空串哨兵归一成删除。
    normalizedPatch.dynamicWorkflowMode = undefined;
  }

  return normalizedPatch;
}
