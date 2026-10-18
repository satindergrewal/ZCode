import type { McpServerConfig, PluginLoadOutcome } from "@zcode/contracts";
import { createBundledMcpRuntimeConfig } from "./official-plugin-runtime.js";
import {
  OFFICIAL_BROWSER_USE_PLUGIN_ID,
  OFFICIAL_CUA_PLUGIN_ID,
  OFFICIAL_NODE_REPL_HOST_PLUGIN_ID,
} from "./official-plugin-definitions.js";

export const BUILT_IN_NODE_REPL_SERVER_NAME = "node_repl";

/**
 * node_repl is the host tool shared by official capabilities, not a plugin MCP declared in any manifest. Its artifacts ride in a separate
 * `node-repl-host` seed unit (unlisted, never user-visible); Browser Use and Computer Use
 * each contribute only their own skill, docs, and native dependency roots.
 */
export function resolveBuiltInNodeReplMcpServers(input: {
  pluginOutcome: Pick<PluginLoadOutcome, "plugins">;
  workingDirectory: string;
}): Record<string, McpServerConfig> {
  const browserUsePackage = input.pluginOutcome.plugins.find(
    (plugin) => plugin.id === OFFICIAL_BROWSER_USE_PLUGIN_ID && plugin.enabled,
  );
  const cuaPackage = input.pluginOutcome.plugins.find(
    (plugin) => plugin.id === OFFICIAL_CUA_PLUGIN_ID && plugin.enabled,
  );
  if (!browserUsePackage && !cuaPackage) return {};
  // The host itself takes no part in enablement: it has no skill and no user surface, so a missing host means there is nothing to run --
  // skip registration safely instead of falling back to a stale artifact inside some plugin package.
  const hostPackage = input.pluginOutcome.plugins.find(
    (plugin) => plugin.id === OFFICIAL_NODE_REPL_HOST_PLUGIN_ID,
  );
  if (!hostPackage) return {};

  const nodeRepl = createBundledMcpRuntimeConfig({
    cwd: input.workingDirectory,
    env: {
      // Domain roots are injected individually, and only while that capability is enabled: the host uses this to decide which half of the docs to expose.
      ...(browserUsePackage ? { ZCODE_PLUGIN_ROOT: browserUsePackage.rootPath } : {}),
      ...(cuaPackage ? { ZCODE_CUA_PLUGIN_ROOT: cuaPackage.rootPath } : {}),
    },
    rootPath: hostPackage.rootPath,
    timeoutMs: 600_000,
  });
  if (!nodeRepl) return {};
  return {
    [BUILT_IN_NODE_REPL_SERVER_NAME]: {
      ...nodeRepl,
      isolation: "workspace",
      protocolVersion: "2026-07-28",
    },
  };
}
