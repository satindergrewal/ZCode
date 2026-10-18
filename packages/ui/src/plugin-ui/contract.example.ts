import type {
  OpenPluginUiSideTabRequest,
  PluginUiPresentation,
  PluginUiSidePaneTab,
} from "./contract.js";
import { buildPluginUiSidePaneTabId, readPluginUiScopeRef } from "./contract.js";

export const examplePresentation: PluginUiPresentation = {
  serverName: "plugin:example-plugin:widget",
  pluginId: "example-plugin@example-marketplace",
  resourceUri: "ui://example-plugin/widget.html",
  preferredDisplayMode: "fullscreen",
  prefersBorder: true,
};

/** Payload when an inline card/pane entry asks for the side pane, plus the tab it creates. */
export function exampleOpenSideTab(request: OpenPluginUiSideTabRequest): PluginUiSidePaneTab {
  const scope = readPluginUiScopeRef(request);
  if (!scope) throw new Error("request needs toolCallId or surfaceId");
  return {
    id: buildPluginUiSidePaneTabId(request),
    type: "plugin-ui",
    parentSessionId: request.parentSessionId,
    ...(request.toolCallId ? { toolCallId: request.toolCallId } : {}),
    ...(request.surfaceId ? { surfaceId: request.surfaceId } : {}),
    ...(request.serverName ? { serverName: request.serverName } : {}),
    pluginId: request.pluginId,
    resourceUri: request.resourceUri,
    title: request.title,
    workspacePath: request.workspacePath,
    workspaceIdentity: request.workspaceIdentity,
    remoteSessionId: request.remoteSessionId ?? null,
  };
}
