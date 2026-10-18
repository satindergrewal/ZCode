import type {
  McpUiAppCapabilities,
  McpUiDisplayMode,
  McpUiHostContext,
  McpUiStyles,
} from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpAppsHostTitleBar, McpAppsStyleVariables } from "@zcode/shared/mcp-apps";
import { PLUGIN_UI_CARD_MAX_HEIGHT_PX } from "../contract.js";

export interface PluginUiHostContextInput {
  theme: "light" | "dark";
  locale: string;
  displayMode: McpUiDisplayMode;
  /** Container width (px); 0 when unknown. */
  width: number;
  /** Card height cap (spec containerDimensions.maxHeight; pages decide size-changed); host default when absent. */
  maxHeight?: number;
  timeZone?: string;
  /** fullscreen header; absent inline. Host extension keys allowed (hostContext permits extra keys). */
  titleBar?: McpAppsHostTitleBar;
  /** Modes this instance may switch to; both when absent. */
  availableDisplayModes?: readonly McpUiDisplayMode[];
  /** Theme tokens mapped to MCP Apps standard variables; no styles when absent. */
  styleVariables?: McpAppsStyleVariables;
}

/** Sole constructor of hostContext. */
export function buildPluginUiHostContext(input: PluginUiHostContextInput): McpUiHostContext {
  return {
    theme: input.theme,
    locale: input.locale,
    displayMode: input.displayMode,
    availableDisplayModes: [...(input.availableDisplayModes ?? ["inline", "fullscreen"])],
    // Spec: inline card height follows content (size-changed), host gives only the cap; width is exact.
    containerDimensions: {
      width: Math.max(0, Math.round(input.width)),
      maxHeight: input.maxHeight ?? PLUGIN_UI_CARD_MAX_HEIGHT_PX,
    },
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    platform: "desktop",
    userAgent: "zcode",
    timeZone: input.timeZone ?? resolveTimeZone(),
    // Desktop hosts always hover, never touch.
    deviceCapabilities: { hover: true, touch: false },
    ...(input.styleVariables ? { styles: { variables: input.styleVariables as McpUiStyles } } : {}),
    ...(input.titleBar ? { titleBar: input.titleBar } : {}),
  };
}

function resolveTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** No availableDisplayModes means both; declared means only declared modes (spec MUST NOT). */
export function appAllowsDisplayMode(
  capabilities: McpUiAppCapabilities | undefined,
  mode: McpUiDisplayMode,
): boolean {
  const declared = capabilities?.availableDisplayModes;
  return !declared || declared.includes(mode);
}

/** Inline instance ui/request-display-mode: switch only within the host-allowed set; pip and unavailable echo current. */
export function resolveRequestedDisplayMode(
  requested: McpUiDisplayMode,
  current: McpUiDisplayMode,
  available: readonly McpUiDisplayMode[],
): McpUiDisplayMode {
  return requested !== "pip" && available.includes(requested) ? requested : current;
}

/**
 * Pane instance ui/request-display-mode: inline only lands while the scope still has an inline card to take over
 * (host closes pane, back to inline); else echo fullscreen. pip also falls back to fullscreen.
 */
export function resolveSidePaneDisplayModeRequest(
  requested: McpUiDisplayMode,
  canReturnInline: boolean,
): McpUiDisplayMode {
  return requested === "inline" && canReturnInline ? "inline" : "fullscreen";
}
