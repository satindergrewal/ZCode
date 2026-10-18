/**
 * plugin-ui module manifest (architecture-governance managed module).
 * ui layer: plugin inline cards, side-pane tabs, MCP Apps host state-machine wiring, MessagePort transport.
 * Layer order domain -> app -> adapters -> components: domain pure, app lifecycle, adapters bind platform, components render.
 * Behavior boundaries: this module's CONTRACT.md.
 */
export const pluginUiModule = {
  id: "plugin-ui",
  requires: ["ui", "shared", "mcp-apps-protocol", "plugin-ui-bridge", "plugin-sandbox"],
  provides: ["plugin-ui-components"],
  publicEntrypoints: ["index.ts", "contract.ts", "hostPrimitives.ts"],
} as const;
