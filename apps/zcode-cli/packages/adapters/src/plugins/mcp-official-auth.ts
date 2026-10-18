/*
 * Strict parsing and provenance for auth: {type: zcode_official} in plugin .mcp.json.
 *
 * A separate file, not mcp.ts: official-auth rules span http and stdio and are
 * decoupled from template-var and transport field parsing; inlining would keep growing mcp.ts (already at max-lines).
 */
import type { McpOfficialProvenance, ZCodeOfficialMcpAuthConfig } from "@zcode/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strict parse. Undefined when undeclared (plain MCP path); any declared-but-malformed shape throws,
 * no lenient fallback: fallback ships looks-configured-but-anonymous configs silently.
 */
export function parseZCodeOfficialAuth(
  value: unknown,
  mcpKey: string,
): ZCodeOfficialMcpAuthConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`MCP server ${mcpKey}: auth must be an object`);
  }
  // Exact, case-sensitive match; aliases like zcode-official or zcode_official_auth are rejected.
  if (value.type !== "zcode_official") {
    throw new Error(`MCP server ${mcpKey}: unsupported auth type: ${String(value.type)}`);
  }
  if (value.provider !== "jwt_token") {
    throw new Error(`MCP server ${mcpKey}: unsupported auth provider: ${String(value.provider)}`);
  }
  return { type: "zcode_official", provider: "jwt_token" };
}

/**
 * Host-generated runtime provenance. Even an official field in .mcp.json is overridden:
 * official identity is never self-declared by the audited party.
 */
export function buildOfficialProvenance(identity: {
  mcpKey: string;
  pluginId: string;
}): McpOfficialProvenance {
  return { mcpKey: identity.mcpKey, pluginId: identity.pluginId, source: "plugin" };
}
