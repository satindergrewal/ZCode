import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
  ZCODE_PLUGIN_HOST_COMMAND,
  type McpServerConfig,
} from "@zcode/contracts";
import { ZCODE_PLUGIN_ID_ENV_KEY } from "@zcode/shared";
import {
  createOfficialPluginCacheRetryBudget,
  type OfficialPluginCacheRetryBudget,
  writeTextFileAtomicallyWithRetry,
} from "./official-plugin-cache-fs.js";

type SeaModule = typeof import("node:sea");

const MCP_SERVER_RELATIVE_PATH = ["dist", "mcp", "server.js"] as const;

export function createBundledMcpRuntimeConfig(input: {
  cwd: string;
  env?: Record<string, string>;
  relativeServerPath?: readonly string[];
  rootPath: string;
  timeoutMs?: number;
}): McpServerConfig | undefined {
  const hostPrefixArgs = officialPluginHostPrefixArgs();
  if (!hostPrefixArgs) return undefined;
  return {
    args: [
      ...hostPrefixArgs,
      join(input.rootPath, ...(input.relativeServerPath ?? MCP_SERVER_RELATIVE_PATH)),
    ],
    command: process.execPath,
    cwd: input.cwd,
    env: {
      ...input.env,
      // In the desktop package, process.execPath is the ZCode Helper; without Node mode it mistakenly enters the Electron main.
      ELECTRON_RUN_AS_NODE: "1",
    },
    timeoutMs: input.timeoutMs,
    type: "stdio",
  };
}

interface OfficialRuntimeManifestInput {
  pluginName: string;
  retryBudget?: OfficialPluginCacheRetryBudget;
  rootPath: string;
}

export function writeOfficialPluginRuntimeManifest(input: OfficialRuntimeManifestInput): void {
  const manifestPath = join(input.rootPath, ".zcode-plugin", "plugin.json");
  const currentContents = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(currentContents) as Record<string, unknown>;
  // skill-only / command-only official plugins carry no mcpServers; skip the rewrite.
  // The previous unconditional asRecord(manifest.mcpServers) threw on undefined,
  // blocking the whole seed flow, including listZCodeSkills' plugin skills.
  if (manifest.mcpServers === undefined) return;
  const mcpServers = asRecord(manifest.mcpServers);
  const hostPrefixArgs = officialPluginHostPrefixArgs();
  if (!hostPrefixArgs) return;

  // Keep the generic rewrite for other legacy official plugin MCPs; zcode-cua is currently skill/SDK-only,
  // never entering this branch and never producing a separate CUA MCP server.
  for (const [serverKey, serverRaw] of Object.entries(mcpServers)) {
    const mcpServer = asRecord(serverRaw);
    const mcpServerEnv = isRecord(mcpServer.env) ? mcpServer.env : {};
    mcpServer.command = process.execPath;
    mcpServer.args = [...hostPrefixArgs, join(input.rootPath, ...MCP_SERVER_RELATIVE_PATH)];
    mcpServer.env = {
      ...mcpServerEnv,
      // In the desktop package, process.execPath is the ZCode Helper.
      // Without Node-mode env, official plugin MCP servers mistakenly enter the Electron main, triggering desktop side effects like deep-link registration.
      ELECTRON_RUN_AS_NODE: "1",
      // Authoritatively write the plugin identity (pluginName@marketplace, from the local plugin registry; manifest/user env cannot override).
      // Other official plugins still carry the unforgeable plugin identity; CUA broker credentials are injected by the shared
      // node_repl trusted config, no longer written into a separate server.
      [ZCODE_PLUGIN_ID_ENV_KEY]: `${input.pluginName}@${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
    };
    mcpServers[serverKey] = mcpServer;
  }
  manifest.mcpServers = mcpServers;

  const nextContents = `${JSON.stringify(manifest, null, 2)}\n`;
  // Unconditionally renaming an identical plugin.json at startup amplifies transient Windows AV/indexer
  // file locks. Skip the file when bytes are identical; real updates keep the atomic failure semantics.
  if (nextContents === currentContents) return;
  writeTextFileAtomicallyWithRetry(
    manifestPath,
    nextContents,
    input.retryBudget ?? createOfficialPluginCacheRetryBudget(),
  );
}

export function officialPluginHostPrefixArgs(): string[] | undefined {
  if (isSeaRuntime()) return [ZCODE_PLUGIN_HOST_COMMAND];

  const entrypoint = process.argv[1];
  if (!entrypoint) return undefined;

  return [...process.execArgv, resolve(entrypoint), ZCODE_PLUGIN_HOST_COMMAND];
}

function isSeaRuntime(): boolean {
  const getBuiltinModule = process.getBuiltinModule as ((id: "node:sea") => SeaModule) | undefined;
  try {
    return getBuiltinModule?.("node:sea").isSea() === true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("Official plugin manifest has invalid mcpServers.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
