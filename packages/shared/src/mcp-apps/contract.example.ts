import type { McpToolUiDescriptor, PluginSandboxHandle } from "./contract.js";
import {
  MCP_APPS_CSP_RELAXATION_META_KEY,
  MCP_APPS_SET_WIDGET_STATE_METHOD,
  PLUGIN_SANDBOX_PORT_NAME,
  buildMcpAppsClientCapabilities,
  buildMcpAppsCspExperimentalCapability,
} from "./contract.js";

/** What a tool with UI resources yields once its `_meta` is normalized. */
export const exampleToolUiDescriptor: McpToolUiDescriptor = {
  resourceUri: "ui://example-plugin/widget.html",
  visibility: ["model", "app"],
  preferredDisplayMode: "inline",
  csp: { connectDomains: ["https://api.example.com"], resourceDomains: [] },
  prefersBorder: true,
};

/** Handle returned to the renderer after main registers the server; the partition derives from server identity and is shared by that server's pages. */
export const exampleSandboxHandle: PluginSandboxHandle = {
  instance: {
    runtimeId: "test-agent",
    generation: 1,
    token: "test-token",
    appIdentity: "a".repeat(64),
  },
  sandboxId: "sb-01",
  initId: 1,
  shellUrl: "zcode-sandbox://shell-sb-01/",
  partition: "persist:plugin-sandbox-v1-0123456789abcdef",
  // Carries every resource-level field the handle allows: contract.test asserts it against the host strict reply schema, and missing fields fail here.
  resourceMeta: {
    prefersBorder: true,
    heightHint: 320,
    minFrameHeight: 120,
    showInline: false,
    permissions: ["clipboardWrite"],
  },
};

/** ui extension capabilities the agent declares during the MCP server `initialize`. */
export const exampleClientCapabilities = buildMcpAppsClientCapabilities();
/** CSP relaxation keys the host declares in hostCapabilities.experimental. */
export const exampleCspExperimental = buildMcpAppsCspExperimentalCapability();
/** How relaxations are declared in resource-level `_meta`. */
export const exampleResourceMetaWithRelaxations = {
  ui: { csp: { connectDomains: ["https://api.example.com"] } },
  [MCP_APPS_CSP_RELAXATION_META_KEY]: { unsafeEval: true },
};
export const exampleSetWidgetStateMethod = MCP_APPS_SET_WIDGET_STATE_METHOD;
export const examplePortName = PLUGIN_SANDBOX_PORT_NAME;
