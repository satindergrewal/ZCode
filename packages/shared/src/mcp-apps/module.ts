/**
 * mcp-apps-protocol module manifest (architecture-governance managed module).
 * Pure domain: the ZCode extensions for MCP Apps -- constants, `_meta` normalization, the `display.ui` schema, sandbox contract types. No IO.
 * The page<->host wire protocol belongs to the official `@modelcontextprotocol/ext-apps` SDK; this module holds no state machine.
 */
export const mcpAppsProtocolModule = {
  id: "mcp-apps-protocol",
  requires: [],
  provides: ["mcp-apps-protocol"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
