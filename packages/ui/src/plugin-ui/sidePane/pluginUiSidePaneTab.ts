import type { WorkspaceSidePaneState } from "@/lib/workspaceSidePane.js";
import { activateSidePaneTab } from "@/lib/workspaceSidePane.js";
import type { OpenPluginUiSideTabRequest, PluginUiSidePaneTab } from "../contract.js";
import { buildPluginUiSidePaneTabId, readPluginUiScopeRef } from "../contract.js";

export type OpenScopedPluginUiSideTabRequest = OpenPluginUiSideTabRequest & {
  workspaceKey: string;
};

/**
 * plan-detail isomorph: stable id from workspaceKey + parentSessionId + scope.
 * Tool cards ...:<toolCallId>; panes ...:surface:<surfaceId> (separate namespace, prefixed against collisions).
 */
export function createPluginUiSidePaneTab(
  options: OpenScopedPluginUiSideTabRequest,
): PluginUiSidePaneTab {
  const scope = readPluginUiScopeRef(options);
  if (!scope) throw new Error("plugin-ui side tab needs toolCallId or surfaceId");
  return {
    id: buildPluginUiSidePaneTabId(options),
    type: "plugin-ui",
    openedAt: Date.now(),
    workspaceKey: options.workspaceKey,
    workspacePath: options.workspacePath,
    ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
    ...(options.remoteSessionId ? { remoteSessionId: options.remoteSessionId } : {}),
    parentSessionId: options.parentSessionId,
    ...(scope.kind === "toolCall"
      ? { toolCallId: scope.toolCallId }
      : { surfaceId: scope.surfaceId }),
    ...(options.serverName ? { serverName: options.serverName } : {}),
    pluginId: options.pluginId,
    resourceUri: options.resourceUri,
    title: options.title,
  };
}

/** One tab per scope; repeats refresh the title and activate. */
export function openPluginUiSidePane(
  current: WorkspaceSidePaneState | null,
  options: OpenScopedPluginUiSideTabRequest,
): WorkspaceSidePaneState {
  const nextTab = createPluginUiSidePaneTab(options);
  const existing = current?.tabs.find(
    (tab): tab is PluginUiSidePaneTab => tab.type === "plugin-ui" && tab.id === nextTab.id,
  );
  return activateSidePaneTab(current, existing ? { ...existing, title: nextTab.title } : nextTab);
}
