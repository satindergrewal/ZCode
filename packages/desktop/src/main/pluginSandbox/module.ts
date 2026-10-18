/**
 * plugin-sandbox module manifest (architecture-governance managed module).
 * Electron adapter layer: the `zcode-sandbox://` scheme, sandbox registry, CSP generation, guest
 * policy, user-gesture proxy, host-registration adapter, host/guest preloads, the trusted relay
 * shell, and the page-side window.zcode alias (thin wrapper over the official App).
 */
export const pluginSandboxModule = {
  id: "plugin-sandbox",
  requires: ["desktop", "shared", "mcp-apps-protocol", "gen-ui-protocol"],
  provides: ["plugin-sandbox-registry", "plugin-sandbox-platform"],
  publicEntrypoints: ["index.ts", "contract.ts", "aliasRuntime.ts", "aliasApi.ts"],
} as const;
