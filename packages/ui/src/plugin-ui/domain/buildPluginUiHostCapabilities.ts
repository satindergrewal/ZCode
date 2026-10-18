import type { McpUiHostCapabilities } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  MCP_APPS_RESOURCE_SUBSCRIBE_EXPERIMENTAL_KEY,
  MCP_APPS_SURFACE_EXPERIMENTAL_KEY,
  MCP_APPS_WIDGET_STATE_EXPERIMENTAL_KEY,
  buildMcpAppsCspExperimentalCapability,
} from "@zcode/shared/mcp-apps";

/** Interactions the host instance actually supports; undeclared keys degrade gracefully. */
export interface PluginUiHostCapabilityInput {
  canSample?: boolean;
  canSendFollowUpMessage: boolean;
  canUpdateModelContext: boolean;
  canSetWidgetState: boolean;
  /** Host proxies resources/subscribe and routes server notices back to this instance. */
  canSubscribeResources: boolean;
  /** downloadFile only when the platform has saveFile (desktop). */
  canDownloadFile: boolean;
  /** Pane instance: declares experimental zcode/surface { id } so the page knows it runs in the pane. */
  surfaceId?: string;
}

/**
 * Sole constructor of hostCapabilities. Declarations mirror handlers: no session actions, no message; no composer, no
 * updateModelContext. ZCode extensions (widgetState, resourceSubscribe, surface, CSP relax) go under experimental zcode/*,
 * since the official SDK zod strips unknown capability keys.
 */
export function buildPluginUiHostCapabilities(
  input: PluginUiHostCapabilityInput,
): McpUiHostCapabilities {
  return {
    openLinks: {},
    serverTools: {},
    serverResources: input.canSubscribeResources ? { listChanged: true } : {},
    logging: {},
    ...(input.canSample ? { sampling: {} } : {}),
    ...(input.canDownloadFile ? { downloadFile: {} } : {}),
    // image declared beside text (png/jpeg/webp, 4 MiB each).
    ...(input.canSendFollowUpMessage ? { message: { text: {}, image: {} } } : {}),
    ...(input.canUpdateModelContext
      ? { updateModelContext: { text: {}, structuredContent: {}, image: {} } }
      : {}),
    experimental: {
      ...buildMcpAppsCspExperimentalCapability(),
      ...(input.canSetWidgetState ? { [MCP_APPS_WIDGET_STATE_EXPERIMENTAL_KEY]: {} } : {}),
      ...(input.canSubscribeResources
        ? { [MCP_APPS_RESOURCE_SUBSCRIBE_EXPERIMENTAL_KEY]: {} }
        : {}),
      ...(input.surfaceId ? { [MCP_APPS_SURFACE_EXPERIMENTAL_KEY]: { id: input.surfaceId } } : {}),
    },
  };
}
