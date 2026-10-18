/**
 * plugin-ui-bridge module manifest (architecture-governance managed).
 * Host-side services: read/validate plugin ui:// resources, register sandboxes with main, proxy UI tool calls,
 * and the App-Provided Tools register/claim/return channel (appToolsContract.ts).
 */
export const pluginUiBridgeModule = {
  id: "plugin-ui-bridge",
  requires: ["services", "shared", "mcp-apps-protocol"],
  provides: ["plugin-ui-bridge-service"],
  publicEntrypoints: ["index.ts", "contract.ts", "appToolsContract.ts", "samplingContract.ts"],
} as const;
