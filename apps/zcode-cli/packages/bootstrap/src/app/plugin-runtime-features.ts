import { join } from "node:path";
import type { AgentRuntimeConfig } from "@zcode/core";
import type { PluginLoadOutcome } from "@zcode/contracts";
import {
  OFFICIAL_BROWSER_USE_PLUGIN_ID,
  OFFICIAL_CUA_PLUGIN_ID,
} from "./official-plugin-definitions.js";

type RuntimeFeaturesConfig = NonNullable<AgentRuntimeConfig["runtimeFeatures"]>;

export function resolvePluginRuntimeFeatures(
  pluginOutcome: Pick<PluginLoadOutcome, "plugins">,
): RuntimeFeaturesConfig {
  const browserUsePlugin = pluginOutcome.plugins.find(
    (plugin) => plugin.id === OFFICIAL_BROWSER_USE_PLUGIN_ID && plugin.enabled,
  );
  const cuaPlugin = pluginOutcome.plugins.find(
    (plugin) => plugin.id === OFFICIAL_CUA_PLUGIN_ID && plugin.enabled,
  );
  if (!browserUsePlugin && !cuaPlugin) {
    return {};
  }
  return {
    // Node REPL has moved to a real MCP server; this only enables BrowserControlPort injection, no legacy core js* registration.
    ...(browserUsePlugin ? { browserUse: true } : {}),
    ...(browserUsePlugin
      ? { browserDocumentationRoot: join(browserUsePlugin.rootPath, "docs") }
      : {}),
    // CUA and Browser Use share one stateless node_repl MCP server; this only records whether the CUA
    // SDK needs its broker injected by bootstrap. Do not set nodeRepl: that field would re-register
    // the pre-migration core js tools, duplicating the MCP projection.
    ...(cuaPlugin ? { computerUse: true } : {}),
  };
}
