// Builds the session-frozen plugin identity catalog.
// Built once by bootstrap at App (session runtime) creation from the resolveStartupPlugins result;
// never refreshed by workspace config hot-reloads.
import type {
  PluginMetadata,
  PluginReferenceCatalog,
  PluginReferenceCatalogEntry,
} from "@zcode/contracts";

function collectDeclaredSkillQualifiedNames(plugin: PluginMetadata): string[] {
  const names = new Set<string>();
  for (const group of plugin.components) {
    if (group.kind !== "skill") continue;
    for (const item of group.items) {
      const skillName = item.name.trim();
      if (!skillName) continue;
      names.add(`${plugin.name}:${skillName}`);
    }
  }
  return [...names].sort();
}

function collectDeclaredSubagentNames(plugin: PluginMetadata): string[] {
  const names = new Set<string>();
  for (const group of plugin.components) {
    if (group.kind !== "agent") continue;
    for (const item of group.items) {
      const subagentName = item.name.trim();
      if (!subagentName) continue;
      names.add(`${plugin.name}:${subagentName}`);
    }
  }
  return [...names].sort();
}

/**
 * Builds the identity catalog from the plugin loader's authoritative metadata.
 * - Every discovered plugin (disabled included) enters the catalog: disabled entries support
 *   the `disabled_in_session` diagnosis and Picker filtering, and cannot be referenced.
 * - Conflict rule: enabled plugins sharing manifest.name mark each other in conflictingPluginIds
 *   (the machine-readable basis for V1 fail-closed). Disabled entries never conflict — they are absent from the runtime namespace.
 */
export function buildPluginReferenceCatalog(
  plugins: readonly PluginMetadata[],
): PluginReferenceCatalog {
  const enabledIdsByName = new Map<string, string[]>();
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    const ids = enabledIdsByName.get(plugin.name) ?? [];
    ids.push(plugin.id);
    enabledIdsByName.set(plugin.name, ids);
  }

  const entries: PluginReferenceCatalogEntry[] = plugins.map((plugin) => {
    const sameNameEnabledIds = plugin.enabled ? (enabledIdsByName.get(plugin.name) ?? []) : [];
    return {
      pluginId: plugin.id,
      name: plugin.name,
      marketplace: plugin.marketplace,
      enabled: plugin.enabled,
      conflictingPluginIds: sameNameEnabledIds.filter((id) => id !== plugin.id).sort(),
      skillQualifiedNames: collectDeclaredSkillQualifiedNames(plugin),
      // mcpServerNames comes from the namespaced servers (`plugin:${name}:${server}`) resolved by the enabled branch;
      // disabled plugins have no runtime MCP names, so keep an empty array.
      mcpServerNames: [...plugin.mcpServerNames].sort(),
      subagentNames: collectDeclaredSubagentNames(plugin),
      rootPath: plugin.rootPath,
    };
  });

  return { plugins: entries };
}

export function findPluginReferenceCatalogEntry(
  catalog: PluginReferenceCatalog | undefined,
  pluginId: string,
): PluginReferenceCatalogEntry | undefined {
  return catalog?.plugins.find((entry) => entry.pluginId === pluginId);
}
