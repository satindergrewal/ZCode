/**
 * MCP (Model Context Protocol) types for ZCode
 * Based on the original Tauri implementation
 */

import type { SettingsDirectoryLocation } from "./settings-source.js";
import type { McpServerFailureKind } from "./zcode-protocol/index.js";

// CUA official-plugin identity constants (ported from feat; the UI settings panel and bootstrap share them against literal drift).
export const ZCODE_CUA_OFFICIAL_PLUGIN_ID = "computer-use@zcode-plugins-official";
// CUA server identity (ported from feat mcp.ts): server key = the model-visible tool prefix segment (deliberately without zcode-);
// namespace name = the official plugin runtime namespace plugin:<pluginId>:<serverKey>.
export const ZCODE_CUA_OFFICIAL_MCP_NAMESPACE_NAME = "plugin:computer-use:computer-use";
// Plugin identity env key: the resolver (adapters/src/plugins/mcp.ts) authoritatively writes loaded.id; manifest/user env cannot override.
// bootstrap and cli/plugin-host-command.ts reuse it to spot the official zcode-cua plugin server, against literal drift.
export const ZCODE_PLUGIN_ID_ENV_KEY = "ZCODE_PLUGIN_ID";

export type McpSource =
  | "mcp"
  | "zcodeagentmcp"
  | "claudeclimcp"
  | "geminiclimcp"
  | "codexclimcp"
  | "opencodemcp";
export type CliMcpSource = Exclude<McpSource, "mcp">;
export type McpScope = "common" | "user" | "workspace";
export type McpFileFormat = "json" | "toml";

// Single MCP server configuration
export interface McpServerConfig {
  type?: string; // Supports stdio, http, sse, streamableHttp, etc.
  url?: string; // HTTP/SSE server URL
  command?: string; // stdio server command
  args?: string[]; // stdio server arguments
  env?: Record<string, string>; // stdio server environment variables
  headers?: Record<string, string>; // HTTP/SSE server request headers
  http_headers?: Record<string, string>; // legacy config field; historical BigModel MCP configs put auth headers here
  oauth?: McpOAuthConfig; // HTTP/SSE OAuth machine-credential config
  // Linear specific fields
  apiKey?: string;
  projectId?: string;
  issueType?: string;
  // Figma specific fields
  personalAccessToken?: string;
  fileId?: string;
  nodeId?: string;
  // Sentry specific fields
  organizationName?: string;
  projectName?: string;
  dsn?: string;
  // Context7 specific fields
  apiEndpoint?: string;
  [key: string]: any;
}

export type McpServerStatus = "connected" | "disconnected" | "error" | "connecting" | "unknown";

export interface CliMcpConfig {
  mcpServers: Record<string, McpServerConfig>;
  projects: Record<string, Record<string, McpServerConfig>>;
}

export interface SaveCliMcpToUserDirectoryRequest {
  action: "upsert" | "delete" | "set-enabled";
  source: CliMcpSource;
  name: string;
  config?: McpServerConfig;
  enabled?: boolean;
  projectPath?: string;
  location?: SettingsDirectoryLocation;
}

export interface NativeMcpFileReference {
  format: McpFileFormat;
  filePath: string;
}

export interface NativeMcpServerRecord {
  source: McpSource;
  scope: McpScope;
  name: string;
  config: McpServerConfig;
  enabled?: boolean;
  projectPath?: string;
  location?: SettingsDirectoryLocation;
  file?: NativeMcpFileReference;
}

export interface LoadCliMcpFromUserDirectoryRequest {
  workspacePath?: string;
}

export interface LoadCliMcpFromUserDirectoryResult {
  servers: NativeMcpServerRecord[];
}

export interface MigrateLegacyCommonMcpRequest {
  legacyStorageDir?: string;
}

export interface MigrateLegacyCommonMcpResult {
  servers: Record<string, McpServerConfig>;
  sourcePath?: string;
  /// MCP configs found in legacy data
  totalCount: number;
  /// Successfully imported
  importedCount: number;
  /// Skipped as already present
  skippedCount: number;
}

export interface McpConfig {
  mcp: {
    mcpServers: Record<string, McpServerConfig>;
  };
  zcodeagentmcp: CliMcpConfig;
  claudeclimcp: CliMcpConfig;
  geminiclimcp: CliMcpConfig;
  codexclimcp: CliMcpConfig;
  opencodemcp: CliMcpConfig;
}

export interface ZCodeMcpServer {
  id: string;
  name: string;
  config: McpServerConfig;
  enabled: boolean;
  changed?: boolean;
  status?: McpServerStatus;
  lastConnected?: Date;
  error?: string;
  failureKind?: McpServerFailureKind;
  serverRequestId?: string;
  toolCount?: number;
  authorization?: {
    type: "oauth_authorization_code";
    authorizationUrl: string;
    startedAt: string;
  };
  source: McpSource;
  projectPath?: string;
  scope: McpScope;
  location?: SettingsDirectoryLocation;
  file?: NativeMcpFileReference;
}

export interface McpServerListItem {
  id: string;
  name: string;
  enabled: boolean;
  status: McpServerStatus;
  hasConfig: boolean;
  error?: string;
  toolCount?: number;
  source: McpSource;
  projectPath?: string;
  scope: McpScope;
  file?: NativeMcpFileReference;
}

export interface McpTestResult {
  success: boolean;
  error?: string;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema?: any;
  }>;
  serverInfo?: {
    name: string;
    version: string;
  };
  response_time?: number;
}

export type ZCodeAgentMcpServer =
  | {
      name: string;
      command: string;
      args: string[];
      env: Array<{ name: string; value: string }>;
      isolation?: "session" | "workspace";
      protocolVersion?: "legacy" | "auto" | "2026-07-28";
      timeoutMs?: number;
    }
  | {
      name: string;
      type: "http" | "sse";
      url: string;
      isolation?: "session" | "workspace";
      protocolVersion?: "legacy" | "auto" | "2026-07-28";
      headers: Array<{ name: string; value: string }>;
      oauth?: McpOAuthConfig;
      timeoutMs?: number;
    };

export interface McpClientCredentialsOAuthConfig {
  type: "client_credentials";
  clientId: string;
  clientSecret: string;
  clientName?: string;
  scope?: string;
}

export interface McpAuthorizationCodeOAuthConfig {
  type: "authorization_code";
  clientId?: string;
  clientSecret?: string;
  clientName?: string;
  redirectPath?: string;
  scope?: string;
}

export type McpOAuthConfig = McpAuthorizationCodeOAuthConfig | McpClientCredentialsOAuthConfig;

export function getMcpServerRequestHeaders(
  config: McpServerConfig,
): Record<string, string> | undefined {
  return config.headers ?? config.http_headers;
}

// Single source of truth for zcode-cua MCP server detection. The desktop product broker resolver
// (mcpBrokerInjection in @zcode/services) and the CLI bootstrap (mcp-config in apps/zcode-cli) are two injection
// entrances that must decide identically, or the same config behaves differently per entrance, skipping the product
// broker and leaving macOS TCC permissions with Python/uvx (violating the fail-closed boundary). Edit here, both paths change.
function zcodeCuaArgLeaf(value: string): string {
  // Strip trailing separators before the leaf: splitting .../zcode-cua/ directly yields an empty leaf -> miss -> fail-open.
  return (
    value
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? value
  );
}

// Is this candidate string a zcode-cua package spec? PyPI treats _ and - as equal, so normalize underscores first (zcode_cua ->
// zcode-cua); covers uv/npm @version, pip ==version, extras [...], git .git/.git@, and dotted submodules
// like python -m zcode_cua.server (zcode-cua.<submodule>). The fail-closed boundary prefers
// over-matching to missing; still never matches zcode-cua-proxy (hyphen-continued, not ./@/[==-bounded).
function matchesZCodeCuaSpec(candidate: string): boolean {
  const c = candidate.replace(/_/g, "-");
  return (
    c === "zcode-cua" ||
    c.startsWith("zcode-cua[") ||
    c.startsWith("zcode-cua@") ||
    c.startsWith("zcode-cua==") ||
    // The . branch also covers zcode-cua.git / zcode-cua.git@v1 and python submodules like zcode-cua.server.
    c.startsWith("zcode-cua.")
  );
}

/**
 // Does the MCP server's command point at zcode-cua? Same package-spec test as args (plus the path leaf),
 // covering command: "zcode-cua", /opt/bin/zcode-cua, and package-spec-as-command
 *(zcode-cua@1.2.3 etc.). Fail-closed prefers over-matching.
 */
export function isZCodeCuaMcpCommand(command: string): boolean {
  return matchesZCodeCuaSpec(command) || matchesZCodeCuaSpec(zcodeCuaArgLeaf(command));
}

/**
 // Is this arg a zcode-cua package spec? Covers zcode-cua, zcode-cua[macos], zcode-cua@1.2.3,
 // zcode-cua==1.2.3, zcode_cua, and git/local forms (.../zcode-cua, zcode-cua.git,
 // git+https://.../zcode-cua.git@v1). Checks raw value and path leaf, covering --from <path>/<git-url>.
 */
export function isZCodeCuaMcpPackageArg(value: string): boolean {
  return matchesZCodeCuaSpec(value) || matchesZCodeCuaSpec(zcodeCuaArgLeaf(value));
}

export function convertToZCodeAgentMcpServer(
  name: string,
  config: McpServerConfig,
): ZCodeAgentMcpServer | null {
  let inferredType = config.type;
  if (!inferredType) {
    if (config.command) inferredType = "stdio";
    else if (config.url) inferredType = "http";
  }

  const isStdio = inferredType === "stdio";
  if (isStdio && config.command) {
    // Windows agents usually spawn with shell:true, and
    // "cmd /c npx ..." double-wraps into "cmd.exe /c cmd /c npx ...", failing the connection.
    // Unwrap the cmd /c and use the inner command.
    let command = config.command;
    let args = config.args || [];
    // Auto-detect the platform: process.platform on Node, navigator.platform in browsers.
    const isWin32 =
      (typeof process !== "undefined" && process.platform === "win32") ||
      (typeof navigator !== "undefined" && /win/i.test(navigator.platform));
    if (isWin32) {
      const lowerCmd = command.toLowerCase();
      const unwrappedCommand = args[1];
      if ((lowerCmd === "cmd" || lowerCmd === "cmd.exe") && args[0] === "/c" && unwrappedCommand) {
        // Under noUncheckedIndexedAccess args[1] stays string | undefined even after a length check.
        // Take and test explicitly: narrows the type and never hands an empty command to the agent.
        command = unwrappedCommand;
        args = args.slice(2);
      }
    }
    return {
      name,
      command,
      args,
      env: config.env
        ? Object.entries(config.env).map(([key, value]) => ({
            name: key,
            value,
          }))
        : [],
      // The MCP settings page writes timeoutMs into config; over the session/create protocol DTO only positive
      // integers pass, or strict schema validation turns "ignored" into "creation failed" for legacy bad configs.
      ...(isValidMcpTimeoutMs(config.timeoutMs) ? { timeoutMs: config.timeoutMs } : {}),
      ...(isMcpIsolation(config.isolation) ? { isolation: config.isolation } : {}),
      ...(isMcpProtocolVersion(config.protocolVersion)
        ? { protocolVersion: config.protocolVersion }
        : {}),
    };
  } else if (config.url && inferredType) {
    const normalizedType: "http" | "sse" = inferredType === "sse" ? "sse" : "http";
    const headers = getMcpServerRequestHeaders(config);
    return {
      name,
      type: normalizedType,
      url: config.url,
      headers: headers
        ? Object.entries(headers).map(([key, value]) => ({
            name: key,
            value,
          }))
        : [],
      ...(isValidMcpOAuthConfig(config.oauth) ? { oauth: config.oauth } : {}),
      // HTTP/SSE MCP needs the timeout kept like stdio, or the saved UI config loses the field in real sessions.
      ...(isValidMcpTimeoutMs(config.timeoutMs) ? { timeoutMs: config.timeoutMs } : {}),
      ...(isMcpIsolation(config.isolation) ? { isolation: config.isolation } : {}),
      ...(isMcpProtocolVersion(config.protocolVersion)
        ? { protocolVersion: config.protocolVersion }
        : {}),
    };
  }
  return null;
}

function isValidMcpTimeoutMs(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isMcpIsolation(value: unknown): value is "session" | "workspace" {
  return value === "session" || value === "workspace";
}

function isMcpProtocolVersion(value: unknown): value is "legacy" | "auto" | "2026-07-28" {
  return value === "legacy" || value === "auto" || value === "2026-07-28";
}

function isValidMcpOAuthConfig(value: unknown): value is McpOAuthConfig {
  if (!isRecord(value)) return false;
  if (
    value.type === "client_credentials" &&
    typeof value.clientId === "string" &&
    value.clientId.trim().length > 0 &&
    typeof value.clientSecret === "string" &&
    value.clientSecret.trim().length > 0
  ) {
    return (
      (value.clientName === undefined || typeof value.clientName === "string") &&
      (value.scope === undefined || typeof value.scope === "string")
    );
  }
  if (value.type === "authorization_code") {
    return (
      (value.clientId === undefined || typeof value.clientId === "string") &&
      (value.clientSecret === undefined || typeof value.clientSecret === "string") &&
      (value.clientName === undefined || typeof value.clientName === "string") &&
      (value.redirectPath === undefined || typeof value.redirectPath === "string") &&
      (value.scope === undefined || typeof value.scope === "string")
    );
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
