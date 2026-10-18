import type { IPluginUiBridgeService } from "./contract.js";

/** Typical UI flow: prepare the sandbox for a handle, mount it in the webview; panel scope is `surface:<id>`. */
export async function examplePrepareAndMount(bridge: IPluginUiBridgeService) {
  const handle = await bridge.prepareSandbox({
    workspacePath: "/repo",
    sessionId: "session_1",
    pluginId: "example-plugin@example-marketplace",
    serverName: "plugin:example-plugin:widget",
    scopeId: "tool:call_1",
    resourceUri: "ui://example-plugin/widget.html",
    ownerWebContentsId: 1,
  });
  return { src: handle.shellUrl, partition: handle.partition, initId: handle.initId };
}

/** Page resources/read fetches same-plugin binary resources via the bridge; MCP-shaped result. */
export async function exampleReadBlob(bridge: IPluginUiBridgeService) {
  const result = await bridge.readResource({
    instance: {
      runtimeId: "test-agent",
      generation: 1,
      token: "test-token",
      appIdentity: "a".repeat(64),
    },
    workspacePath: "/repo",
    sessionId: "session_1",
    pluginId: "example-plugin@example-marketplace",
    serverName: "plugin:example-plugin:widget",
    uri: "ui://example-plugin/model.glb",
  });
  return result.contents[0]?.blob ?? null;
}

/** Sampling binds the page identity; the app submits history and receives the result. */
export function exampleSample(
  service: import("./samplingContract.js").IPluginUiSamplingService,
  scope: import("./contract.js").PluginUiPluginScope,
) {
  return service.sample({
    ...scope,
    operationId: "sample-1",
    request: {
      messages: [{ role: "user", content: { type: "text", text: "Explain 1/2" } }],
      maxTokens: 128,
    },
  });
}
