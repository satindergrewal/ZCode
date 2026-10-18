// Config Merger - Merge configs by priority

import type {
  HookEventName,
  HookMatcherConfig,
  PluginOptionValues,
  RuntimeConfigPatch,
} from "@zcode/contracts";
import { ConfigScope, ConfigScopePriority } from "@zcode/contracts";

type PluginOptions = Record<string, PluginOptionValues>;

/**
 * Config source with priority info
 */
interface PrioritizedConfig {
  config: RuntimeConfigPatch;
  scope: ConfigScope;
  priority: number;
}

/**
 * Merge multiple configs by scope priority
 * Lower priority = applied first, higher priority = applied last (overwrites)
 */
export function mergeConfigs(...configs: PrioritizedConfig[]): RuntimeConfigPatch {
  // Sort by priority (ascending)
  const sorted = [...configs].sort((a, b) => a.priority - b.priority);

  const result: RuntimeConfigPatch = {};

  for (const { config: inputConfig, scope } of sorted) {
    const config =
      scope === ConfigScope.Project && inputConfig.plugins
        ? (() => {
            // Marketplace belongs to the Host User inventory, not Workspace project config.
            // Keep the schema for legacy files, but do not let project-level fields reach merged RuntimeConfig/catalog.
            const projectPlugins = { ...inputConfig.plugins };
            delete projectPlugins.extraKnownMarketplaces;
            return { ...inputConfig, plugins: projectPlugins };
          })()
        : inputConfig;
    const previousHooks = result.hooks;
    const previousPlugins = result.plugins;
    Object.assign(result, config);

    // Deep merge nested objects
    if (config.modelStream) {
      result.modelStream = { ...result.modelStream, ...config.modelStream };
    }
    if (config.permission) {
      result.permission = { ...result.permission, ...config.permission };
    }
    if (config.storage) {
      result.storage = { ...result.storage, ...config.storage };
    }
    if (config.network) {
      result.network = { ...result.network, ...config.network };
    }
    if (config.features) {
      result.features = { ...result.features, ...config.features };
    }
    if (config.memory) {
      result.memory = { ...result.memory, ...config.memory };
    }
    if (config.mcp) {
      result.mcp = {
        ...result.mcp,
        ...config.mcp,
        servers: {
          ...result.mcp?.servers,
          ...config.mcp.servers,
        },
      };
    }
    if (config.plugins) {
      // Workspace and User plugin config share one RuntimeConfig; a later `plugins` object must not
      // wholesale replace the earlier source, or a Workspace declaring one plugin would drop User
      // enablements and options. Merge enabledPlugins by pluginId, options by pluginId/option key;
      // keep both candidate roots in dirs and let the final resolver dedup and validate paths.
      result.plugins = {
        // Object.assign already pointed result.plugins at the higher-priority layer. Spreading only
        // result.plugins when Workspace sets options alone would drop User dirs, breaking even plugin
        // discovery on the next configure. Always build from previousPlugins explicitly.
        ...previousPlugins,
        ...config.plugins,
        ...(config.plugins.dirs
          ? {
              dirs: [...new Set([...(previousPlugins?.dirs ?? []), ...config.plugins.dirs])],
            }
          : {}),
        ...(config.plugins.enabledPlugins
          ? {
              enabledPlugins: {
                ...previousPlugins?.enabledPlugins,
                ...config.plugins.enabledPlugins,
              },
            }
          : {}),
        ...(config.plugins.extraKnownMarketplaces
          ? {
              extraKnownMarketplaces: {
                ...previousPlugins?.extraKnownMarketplaces,
                ...config.plugins.extraKnownMarketplaces,
              },
            }
          : {}),
        ...(config.plugins.options
          ? {
              options: mergePluginOptions(previousPlugins?.options, config.plugins.options),
            }
          : {}),
      };
    }
    if (config.skills) {
      result.skills = {
        ...result.skills,
        ...config.skills,
      };
    }
    if (config.skillOverrides) {
      result.skillOverrides = {
        ...result.skillOverrides,
        ...config.skillOverrides,
      };
    }
    if (config.commandOverrides) {
      result.commandOverrides = {
        ...result.commandOverrides,
        ...config.commandOverrides,
      };
    }
    if (config.logging) {
      result.logging = { ...result.logging, ...config.logging };
    }
    if (config.toolConcurrency) {
      result.toolConcurrency = { ...result.toolConcurrency, ...config.toolConcurrency };
    }
    if (config.modelAnomalyGuard) {
      result.modelAnomalyGuard = {
        ...result.modelAnomalyGuard,
        ...config.modelAnomalyGuard,
      };
    }
    if (config.hooks) {
      result.hooks = mergeHooksConfig(previousHooks, config.hooks);
    }
    if (config.ui) {
      result.ui = { ...result.ui, ...config.ui };
    }
  }

  return result;
}

function mergePluginOptions(
  current: PluginOptions | undefined,
  next: PluginOptions,
): PluginOptions {
  const merged: PluginOptions = { ...(current ?? {}) };
  for (const [pluginId, options] of Object.entries(next)) {
    merged[pluginId] = {
      ...(merged[pluginId] ?? {}),
      ...options,
    };
  }
  return merged;
}

function mergeHooksConfig(
  current: RuntimeConfigPatch["hooks"],
  next: NonNullable<RuntimeConfigPatch["hooks"]>,
): NonNullable<RuntimeConfigPatch["hooks"]> {
  const events: Partial<Record<HookEventName, HookMatcherConfig[]>> = {
    ...current?.events,
  };

  // Project hooks must not wholesale replace user hooks, and an empty project `enabled:false` must not
  // disable user hooks. Each config file governs its own events: append only when that source enables,
  // with effective enabled true if any source enables.
  if (next.enabled !== false) {
    for (const [eventName, matchers] of Object.entries(next.events ?? {}) as Array<
      [HookEventName, HookMatcherConfig[]]
    >) {
      if (!matchers) continue;
      events[eventName] = [...(events[eventName] ?? []), ...matchers];
    }
  }

  return {
    ...current,
    ...next,
    enabled: current?.enabled === true || next.enabled === true,
    events,
  };
}

/**
 * Get priority for a config scope
 */
export function getScopePriority(scope: ConfigScope): number {
  return ConfigScopePriority[scope];
}

/**
 * Create a prioritized config entry
 */
export function createPrioritizedConfig(
  config: RuntimeConfigPatch,
  scope: ConfigScope,
): PrioritizedConfig {
  return {
    config,
    scope,
    priority: getScopePriority(scope),
  };
}
