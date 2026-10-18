import type {
  McpUiCallToolResult,
  McpUiReadResourceResult,
  McpUiSessionAccess,
} from "./contract.js";
import { McpUiNotSupportedError } from "./resourceContract.js";

/** An in-memory session view knowing a single server, for contract tests and examples. */
export function createExampleSessionAccess(): McpUiSessionAccess {
  const html: McpUiReadResourceResult = {
    contents: [
      {
        uri: "ui://example-plugin/widget.html",
        mimeType: "text/html;profile=mcp-app",
        text: "<!doctype html><p>widget</p>",
      },
    ],
  };
  const echo: McpUiCallToolResult = { content: [{ type: "text", text: "pong" }] };
  return {
    hasMcpServer: async (serverName) => serverName === "plugin:example-plugin:widget",
    // H03: echo_app_only is page-only; ping is visible to both; other tools do not exist.
    getToolVisibility: async (_serverName, toolName) =>
      toolName === "echo_app_only" ? ["app"] : toolName === "ping" ? ["model", "app"] : null,
    readResource: async () => html,
    callTool: async () => echo,
    readResourceForUi: async () => html,
    // 4b-2: the example server has one static resource and supports no subscription.
    listResourcesForUi: async () => ({
      resources: [
        {
          uri: "ui://example-plugin/widget.html",
          name: "widget",
          mimeType: "text/html;profile=mcp-app",
        },
      ],
    }),
    listResourceTemplatesForUi: async () => ({ resourceTemplates: [] }),
    subscribeResourceForUi: async () => {
      throw new McpUiNotSupportedError("plugin:example-plugin:widget", "resources/subscribe");
    },
    unsubscribeResourceForUi: async () => {},
  };
}
