import type {
  McpPort,
  McpServerConfig,
  McpServerStatus,
  McpStdioServerConfig,
} from "@zcode/contracts";
import {
  getCapturedZCodeCuaBrokerCredentials,
  isZCodeCuaMcpCommand,
  isZCodeCuaMcpPackageArg,
  ZCODE_CUA_BROKER_SOCKET_ENV_KEY,
  ZCODE_CUA_NODE_REPL_HOST_ENV_KEY,
  ZCODE_CUA_OFFICIAL_PLUGIN_ID,
  ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY,
  ZCODE_PLUGIN_ID_ENV_KEY,
} from "@zcode/shared";

export { ZCODE_CUA_BROKER_SOCKET_ENV_KEY as ZCODE_CUA_BROKER_SOCKET_ENV } from "@zcode/shared";
// The CLI entry cleans broker credentials first; the shared node_repl trusted config restores them from the in-process captured snapshot.
function resolveZCodeCuaBrokerSocket(): string | undefined {
    // captured wins; stale sockets left from a previous run must not override the trusted snapshot.
  return (
    getCapturedZCodeCuaBrokerCredentials().socket ||
    process.env[ZCODE_CUA_BROKER_SOCKET_ENV_KEY]?.trim()
  );
}

function resolveZCodeCuaBrokerToken(): string | undefined {
  return undefined;
}

const NODE_REPL_SERVER_NAME = "node_repl";
const REFRESH_MARKER_ENV = "ZCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER";

/**
 * Derive official CUA provenance from the in-memory plugin registry rather than
 * from serializable MCP fields. A user/project override replaces the config
 * object in `configuredServers`, so copied names, commands, and env values do
 * not inherit the bundled plugin's authority.
 */
export function resolveTrustedOfficialCuaServerNames(
  configuredServers: Record<string, McpServerConfig>,
  pluginServers: Record<string, McpServerConfig>,
): Set<string> {
  return new Set(
    Object.entries(pluginServers)
      .filter(
        ([name, config]) =>
          configuredServers[name] === config &&
          config.type === "stdio" &&
          config.env?.[ZCODE_PLUGIN_ID_ENV_KEY]?.trim().toLowerCase() ===
            ZCODE_CUA_OFFICIAL_PLUGIN_ID,
      )
      .map(([name]) => name),
  );
}

export async function listMcpServerStatuses(
  mcpPort: McpPort | undefined,
  servers: Record<string, McpServerConfig>,
  untrustedServerNames: ReadonlySet<string> = new Set(),
): Promise<Record<string, McpServerStatus>> {
  const liveStatuses = mcpPort ? await mcpPort.status() : {};
  const updatedAt = new Date().toISOString();
  const statuses: Record<string, McpServerStatus> = {};

  for (const [name, config] of Object.entries(servers)) {
        // After migration the legacy zcode-cua MCP is historical config only and no longer enters state projection; CUA
        // is carried by the shared node_repl, keeping the settings page from listing the removed server as available.
    if (isRetiredCuaMcpServer(name, config)) continue;
    const configuredStatus = getConfiguredServerStatus(name, config, untrustedServerNames);
    statuses[name] = liveStatuses[name] ?? {
      status: configuredStatus,
      transport: config.type,
      toolCount: 0,
      updatedAt,
      error: getConfiguredServerError(name, config, untrustedServerNames),
      ...(configuredStatus === "untrusted" ? { failureKind: "status_unavailable" as const } : {}),
    };
  }

  for (const [name, status] of Object.entries(liveStatuses)) {
    if (!(name in statuses) && !isRetiredCuaMcpServer(name, servers[name])) statuses[name] = status;
  }

  return statuses;
}

export function omitMcpServers(
  servers: Record<string, McpServerConfig>,
  omittedNames: ReadonlySet<string>,
  trustedOfficialCuaServerNames: ReadonlySet<string> = new Set(),
): Record<string, McpServerConfig> {
  const kept = Object.fromEntries(
    Object.entries(servers).filter(
      ([name, config]) => !omittedNames.has(name) && !isRetiredCuaMcpServer(name, config),
    ),
  );

  return injectZCodeCuaBrokerMcpServers(
    kept,
    resolveZCodeCuaBrokerSocket(),
    resolveZCodeCuaBrokerToken(),
    trustedOfficialCuaServerNames,
  );
}

function injectZCodeCuaBrokerMcpServers(
  servers: Record<string, McpServerConfig>,
  socketPath: string | undefined,
  token: string | undefined = undefined,
  trustedOfficialCuaServerNames: ReadonlySet<string> = new Set(),
): Record<string, McpServerConfig> {
  const normalizedSocketPath = socketPath?.trim();
  const normalizedToken = token?.trim();

  let changed = false;
  const next: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    if (isRetiredCuaMcpServer(name, config)) {
      changed = true;
      continue;
    }
    if (
      name !== NODE_REPL_SERVER_NAME ||
      !normalizedSocketPath ||
      !trustedOfficialCuaServerNames.has(name)
    ) {
      next[name] = config;
      continue;
    }
    const injected = injectCuaCredentialsIntoNodeRepl(
      config,
      normalizedSocketPath,
      normalizedToken,
    );
    next[name] = injected;
    changed ||= injected !== config;
  }

  return changed ? next : servers;
}

function injectCuaCredentialsIntoNodeRepl(
  config: McpServerConfig,
  socketPath: string,
  token: string | undefined,
): McpServerConfig {
  if (config.type !== "stdio") return config;
  const captured = getCapturedZCodeCuaBrokerCredentials();
  const pluginAuthority = captured.pluginAuthority;
    // The CLI runtime env is cleaned before bootstrap. Like socket/token, the marker must come from the private credential snapshot,
    // or after the SDK migration the broker survives while permission refresh silently stops.
  const refreshMarker = captured.refreshMarker || process.env[REFRESH_MARKER_ENV]?.trim();
  return {
    ...config,
    env: {
      ...config.env,
      [ZCODE_CUA_BROKER_SOCKET_ENV_KEY]: socketPath,
      ...(refreshMarker ? { [REFRESH_MARKER_ENV]: refreshMarker } : {}),
      ...(pluginAuthority ? { [ZCODE_CUA_PLUGIN_AUTHORITY_ENV_KEY]: pluginAuthority } : {}),
      [ZCODE_CUA_NODE_REPL_HOST_ENV_KEY]: "1",
      [ZCODE_PLUGIN_ID_ENV_KEY]: ZCODE_CUA_OFFICIAL_PLUGIN_ID,
    },
  };
}

function isZCodeCuaStdioServer(
  name: string,
  config: McpServerConfig,
): config is McpStdioServerConfig {
  if (config.type !== "stdio") return false;
  if (name === "computer-use") return true;
    // The builtin official zcode-cua plugin's MCP server uses __zcode-plugin-host; command is Helper
    // (not zcode-cua) and args are [zcode.cjs, __zcode-plugin-host, server.js] (not the zcode-cua package arg),
    // so none of the three name/command/args checks above match. The _plugin id is written into env authoritatively by the adapters resolver
    // (manifest/user env cannot override); use it to identify official plugin servers.
  if (
    config.env?.[ZCODE_PLUGIN_ID_ENV_KEY]?.trim().toLowerCase() === ZCODE_CUA_OFFICIAL_PLUGIN_ID
  ) {
    return true;
  }
    // The check shares @zcode/shared's single source of truth with desktop/services, keeping both injection entries from drifting.
  if (isZCodeCuaMcpCommand(config.command)) return true;
  return (config.args ?? []).some(isZCodeCuaMcpPackageArg);
}

function isRetiredCuaMcpServer(name: string, config: McpServerConfig | undefined): boolean {
  // node_repl is the single supported CUA host and may share the CUA plugin's
  // authority marker; all other CUA-shaped MCP entries are retired.
  return (
    name !== NODE_REPL_SERVER_NAME && config !== undefined && isZCodeCuaStdioServer(name, config)
  );
}

function getConfiguredServerStatus(
  name: string,
  config: McpServerConfig,
  untrustedServerNames: ReadonlySet<string>,
): McpServerStatus["status"] {
  if (config.enabled === false) return "disabled";
  return untrustedServerNames.has(name) ? "untrusted" : "disconnected";
}

function getConfiguredServerError(
  name: string,
  config: McpServerConfig,
  untrustedServerNames: ReadonlySet<string>,
): string | undefined {
  if (config.enabled === false || !untrustedServerNames.has(name)) return undefined;
  return "Project MCP server requires explicit connection before use.";
}
