/**
 * The mcp-ui module manifest (architecture-governance managed module).
 // app layer: handlers for the three app->agent protocol methods `mcp/readResource`, `mcp/uiCallTool`, `mcp/uiReadResource`,
 // plus the fail-closed serverName ownership check (any configured MCP server may render an MCP App).
 */
export const mcpUiModule = {
  id: "mcp-ui",
  requires: ["zcode-cli", "shared", "mcp-apps-protocol"],
  provides: ["mcp-ui-handlers"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
