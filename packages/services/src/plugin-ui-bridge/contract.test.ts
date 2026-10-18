import { ServiceChannels, hostPluginSandboxRegisterResultMessageSchema } from "@zcode/shared";
import type { PluginSandboxHandle } from "@zcode/shared/mcp-apps";
import { describe, expect, it } from "vitest";
import { examplePrepareAndMount, exampleReadBlob } from "./contract.example.js";
import { IPluginUiBridgeService } from "./contract.js";

describe("plugin-ui-bridge contract", () => {
  it("binds descriptors to the plugin-ui-bridge channel", () => {
    expect(IPluginUiBridgeService.channelName).toBe(ServiceChannels.PluginUiBridge);
    expect(ServiceChannels.PluginUiBridge).toBe("plugin-ui-bridge");
  });

  it("every resource-level handle field passes the strict main-to-host reply schema", () => {
    // The reply schema is strict: a PluginSandboxHandle.resourceMeta field missing from validation.ts
    // gets the whole reply rejected, the bridge never receives the handle, and the card sticks on preparing (2026-09-20 repro).
    const handle: PluginSandboxHandle = {
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
      resourceMeta: {
        prefersBorder: true,
        heightHint: 320,
        minFrameHeight: 120,
        showInline: false,
        permissions: ["clipboardWrite"],
      },
    };
    expect(
      hostPluginSandboxRegisterResultMessageSchema.safeParse({
        type: "plugin-sandbox-register-result",
        requestId: "req-1",
        ok: true,
        ...handle,
      }).success,
    ).toBe(true);
  });

  it("example relies on contract methods only", async () => {
    const bridge: IPluginUiBridgeService = {
      recycleInstance: async () => true,
      validateInstance: async () => undefined,
      closeInstance: async () => undefined,
      prepareSandbox: async (params) => ({
        instance: {
          runtimeId: "test-agent",
          generation: 1,
          token: "test-token",
          appIdentity: "a".repeat(64),
        },
        sandboxId: `sb-${params.scopeId}`,
        initId: 1,
        shellUrl: `zcode-sandbox://shell-sb-${params.scopeId}/`,
        partition: `plugin-sandbox:sb-${params.scopeId}`,
      }),
      callTool: async () => ({ content: [] }),
      cancelToolCall: async () => ({ cancelled: false }),
      readResource: async (params) => ({
        contents: [{ uri: params.uri, mimeType: "model/gltf-binary", blob: "AAAA" }],
      }),
      // New resource-subscription surface must be fully implemented in the example stub too, or typecheck breaks on the stale sample.
      listResources: async () => ({ resources: [] }),
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
      subscribeResource: async () => undefined,
      unsubscribeResource: async () => undefined,
      listSurfaces: async () => [],
    };
    await expect(examplePrepareAndMount(bridge)).resolves.toEqual({
      src: "zcode-sandbox://shell-sb-tool:call_1/",
      partition: "plugin-sandbox:sb-tool:call_1",
      initId: 1,
    });
    await expect(exampleReadBlob(bridge)).resolves.toBe("AAAA");
  });
});
