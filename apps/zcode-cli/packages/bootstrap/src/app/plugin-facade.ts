import type { ConfigResult } from "@zcode/adapters/config";
import type { PluginLoadOutcome } from "@zcode/contracts";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";
import {
  listZCodePlugins,
  setZCodePluginEnabled,
  uninstallZCodeMarketplacePlugin,
} from "../plugins.js";
import type {
  ZCodeApp,
  ZCodeAppOptions,
  ZCodePluginSetResult,
  ZCodePluginUninstallResult,
} from "./types.js";

type PluginFacade = Pick<
  ZCodeApp,
  "listPlugins" | "setPluginEnabled" | "uninstallPlugin"
>;

interface CreatePluginFacadeOptions {
  configResult: ConfigResult;
  env?: NodeJS.ProcessEnv;
  officialPluginRoots?: string[];
  pluginStorageRoot?: string;
  workingDirectory: string;
}

function createPluginFacade(options: CreatePluginFacadeOptions): PluginFacade {
  let enabledPlugins = { ...options.configResult.config.plugins.enabledPlugins };
  // The session must also mirror suppressedBuiltins: after a builtin plugin is uninstalled, reusing the startup suppression set would
  // make later list calls resolve it again. Keep a local copy like enabledPlugins and update it on uninstall.
  let suppressedBuiltins = [...options.configResult.config.plugins.suppressedBuiltins];
  const commonOptions = () => ({
    configResult: currentConfigResult(options.configResult, enabledPlugins, suppressedBuiltins),
    env: options.env,
    officialPluginRoots: options.officialPluginRoots,
    pluginStorageRoot: options.pluginStorageRoot,
    workingDirectory: options.workingDirectory,
  });

  return {
    listPlugins: async (): Promise<PluginLoadOutcome> => listZCodePlugins(commonOptions()),
    setPluginEnabled: async (
      plugin: string,
      enabled: boolean,
    ): Promise<ZCodePluginSetResult> => {
      const result = await setZCodePluginEnabled({
        ...commonOptions(),
        enabled,
        plugin,
      });
      enabledPlugins = {
        ...enabledPlugins,
        [result.plugin.id]: result.enabled,
      };
      return result;
    },
    uninstallPlugin: async (plugin: string): Promise<ZCodePluginUninstallResult> => {
      const removed = await uninstallZCodeMarketplacePlugin({
        ...commonOptions(),
        pluginId: plugin,
      });
      if (removed) {
        // Uninstall clears enabledPlugins[id] in user config; sync the local cache so later list calls do not resolve the stale value.
        const next = { ...enabledPlugins };
        delete next[removed.id];
        enabledPlugins = next;
        // Builtin (official) plugin uninstall writes the suppressedBuiltins mark; sync the local suppression set,
        // or later list calls in the same session reuse the startup set and resolve it again.
        if (removed.marketplace === ZCODE_OFFICIAL_PLUGIN_MARKETPLACE) {
          if (!suppressedBuiltins.includes(removed.id)) {
            suppressedBuiltins = [...suppressedBuiltins, removed.id];
          }
        }
      }
      return { removed };
    },
  };
}

export function createPluginFacadeForApp(input: {
  configResult: ConfigResult;
  options: ZCodeAppOptions;
  workingDirectory: string;
}): PluginFacade {
  return createPluginFacade({
    configResult: input.configResult,
    env: input.options.env,
    officialPluginRoots: input.options.officialPluginRoots,
    pluginStorageRoot: input.options.pluginStorageRoot,
    workingDirectory: input.workingDirectory,
  });
}

function currentConfigResult(
  configResult: ConfigResult,
  enabledPlugins: Record<string, boolean>,
  suppressedBuiltins: string[],
): ConfigResult {
  return {
    ...configResult,
    config: {
      ...configResult.config,
      plugins: {
        ...configResult.config.plugins,
        enabledPlugins,
        suppressedBuiltins,
      },
    },
  };
}
