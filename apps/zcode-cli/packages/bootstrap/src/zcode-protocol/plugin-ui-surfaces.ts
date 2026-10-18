// `plugins/listUiSurfaces`: workspace-scoped read-only projection,
// returning legal entries of enabled plugins' `ui.surfaces[]`. Split from plugin-reference-catalog.ts for the same reason: plugins.ts is at the gate.
import {
  zcodePluginsListUiSurfacesParamsSchema,
  type ZCodePluginUiSurface,
  type ZCodePluginsListUiSurfacesResult,
} from "@zcode/shared";
import type { PluginMetadata } from "@zcode/contracts";
import { resolveZCodePlugins } from "../plugins.js";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

export function listPluginUiSurfacesFromPlugins(
  plugins: readonly PluginMetadata[],
): ZCodePluginUiSurface[] {
  const surfaces: ZCodePluginUiSurface[] = [];
  for (const plugin of plugins) {
    // Disabled plugins have no runtime MCP, entry unavailable; the parse stays in metadata for the management page.
    if (!plugin.enabled) continue;
    for (const surface of plugin.uiSurfaces ?? []) {
      surfaces.push({
        pluginId: plugin.id,
        pluginName: plugin.name,
        id: surface.id,
        title: surface.title,
        ...(surface.icon ? { icon: surface.icon } : {}),
        server: surface.server,
        resourceUri: surface.resourceUri,
        availability: surface.availability,
      });
    }
  }
  return surfaces;
}

export async function listPluginUiSurfaces(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodePluginsListUiSurfacesResult> {
  const params = parseParams(zcodePluginsListUiSurfacesParamsSchema, rawParams);
  const outcome = resolveZCodePlugins({
    logger: context.logger,
    workingDirectory: params.workspace.workspacePath,
  });
  return { surfaces: listPluginUiSurfacesFromPlugins(outcome.plugins) };
}
