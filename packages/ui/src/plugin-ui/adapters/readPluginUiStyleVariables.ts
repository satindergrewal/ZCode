import type { McpAppsStyleVariables } from "@zcode/shared/mcp-apps";
import { buildPluginUiStyleVariables } from "../domain/pluginUiStyleVariables.js";

/**
 * Read theme tokens' computed values from the host root (follows .dark / zai theme class flips);
 * non-DOM (tests, SSR) always falls back.
 */
export function readPluginUiStyleVariables(): McpAppsStyleVariables {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") {
    return buildPluginUiStyleVariables(() => undefined);
  }
  const style = getComputedStyle(document.documentElement);
  return buildPluginUiStyleVariables((token) => style.getPropertyValue(token));
}
