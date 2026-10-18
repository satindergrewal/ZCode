import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY,
  ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY,
} from "@zcode/contracts";
import { CUA_APP_ASSOCIATIONS_META_KEY } from "@zcode/zcode-cua/host-display-contract";
import {
  captureComputerUseRuntimeFromEnvironment,
  createInProcessNodeReplExecutor,
  createNodeReplMcpRuntime,
  main,
  type NodeReplMcpRuntime,
} from "../src/server.js";
import { toMcpRunResult } from "../src/result.js";
import {
  NODE_REPL_DEFAULT_TIMEOUT_MS,
  NODE_REPL_SERVER_INSTRUCTIONS,
  JS_TOOL_DESCRIPTION,
} from "../src/tool-contract.js";

describe("node_repl MCP server", () => {
  const packageVersion = (
    JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")) as {
      version: string;
    }
  ).version;
  let client: Client;
  let runtime: NodeReplMcpRuntime;

  const requestMeta = (
    sessionId: string,
    runtimeScope: "main" | "subagent" = "main",
    turnId = "turn-1",
  ) => ({
    "com.zcode/request-context": {
      runtime_scope: runtimeScope,
      session_id: sessionId,
      turn_id: turnId,
    },
  });

  beforeEach(async () => {
    runtime = createNodeReplMcpRuntime({ executeJs: createInProcessNodeReplExecutor() });
    client = new Client({ name: "node-repl-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await runtime.server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    runtime.dispose();
  });

  it("exports the main entrypoint required by the packaged plugin host", () => {
    expect(packageVersion).toBe("0.6.1");
    expect(main).toBeTypeOf("function");
    expect(client.getServerVersion()).toEqual({
      name: "node_repl",
      version: packageVersion,
    });
  });

  it("captures Computer Use credentials before the plugin host restores its environment", async () => {
    const capturedRuntime = captureComputerUseRuntimeFromEnvironment({
      ZCODE_CUA_PERMISSION_BROKER_SOCKET: "/tmp/deferred-cua.sock",
      ZCODE_CUA_PERMISSION_BROKER_TOKEN: "deferred-cua-token",
    });
    expect(capturedRuntime).toBeDefined();

    let forwardedBroker: unknown;
    const deferredRuntime = createNodeReplMcpRuntime({
      cuaRuntime: capturedRuntime,
      executeJs: async (input) => {
        forwardedBroker = input.cuaBroker;
        return { logs: "", result: "ok" };
      },
    });
    const deferredClient = new Client({ name: "deferred-cua-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await deferredRuntime.server.connect(serverTransport);
    await deferredClient.connect(clientTransport);

    try {
      await deferredClient.callTool({
        name: "js",
        arguments: { code: "1", title: "Verify Computer Use bridge" },
        _meta: requestMeta("deferred-cua-session"),
      });
      expect(forwardedBroker).toMatchObject({
        socketPath: expect.any(String),
        token: expect.any(String),
      });
    } finally {
      await deferredClient.close();
      deferredRuntime.dispose();
    }
  });

  it("requires user-facing titles in the model schema while preserving legacy runtime input", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(["js"]);

    const js = tools.find((tool) => tool.name === "js");
    expect(js?.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["code", "title"],
      type: "object",
    });
    expect(Object.keys(js?.inputSchema.properties ?? {}).sort()).toEqual([
      "code",
      "timeout_ms",
      "title",
    ]);
    expect(js?.inputSchema.properties?.code).toMatchObject({
      description: "JavaScript code to execute in the Node REPL session",
    });
    expect(js?.inputSchema.properties?.timeout_ms).toMatchObject({
      description: expect.stringContaining(
        "You MUST provide this when the code is expected to run longer than 30000 ms",
      ),
    });
    expect(js?.description).toContain("required `title`");
    expect(NODE_REPL_DEFAULT_TIMEOUT_MS).toBe(60_000);
    expect(NODE_REPL_SERVER_INSTRUCTIONS).toContain("default to a 60000 ms timeout");
    expect(js?.description).toContain("after 60000 ms");
    expect(js?.description).toContain(
      "you MUST set `timeout_ms` to at least the estimated total runtime plus 15000 ms",
    );
    expect(js?.description).not.toContain("after 30000 ms");

    const legacyCall = await client.callTool({
      name: "js",
      arguments: { code: '"legacy";' },
    });
    expect(legacyCall.isError).not.toBe(true);
    expect(legacyCall.content).toContainEqual(
      expect.objectContaining({ type: "text", text: "=> legacy" }),
    );
  });

  it("limits every model-visible node_repl description to official browser/computer use", async () => {
    const { tools } = await client.listTools();
    const js = tools.find((tool) => tool.name === "js");

    expect(NODE_REPL_SERVER_INSTRUCTIONS).toMatch(/^Browser Use and Computer Use only\./);
    expect(NODE_REPL_SERVER_INSTRUCTIONS).toContain("Do not use this server for unrelated tasks");
    expect(js?.description).toMatch(/^Browser Use and Computer Use only\./);
    expect(js?.description).toContain("Do not use it as a general-purpose JavaScript runtime");
  });

  it("teaches the generic node_repl tool to keep CUA results structured", () => {
    expect(JS_TOOL_DESCRIPTION).toContain("do not console.log/JSON.stringify the complete result");
    expect(JS_TOOL_DESCRIPTION).toContain("use nodeRepl.write for short text-only status");
    expect(JS_TOOL_DESCRIPTION).toContain("get_app_state");
    expect(JS_TOOL_DESCRIPTION).toContain("nodeRepl.write(state.text)");
    expect(JS_TOOL_DESCRIPTION).toContain("state.state_id");
    expect(JS_TOOL_DESCRIPTION).toContain(
      "Every Computer Use JavaScript call must start with the complete SDK bootstrap",
    );
    expect(JS_TOOL_DESCRIPTION).toContain(
      "Never rely on agent, runtime, browser, or imported bindings from an earlier call",
    );
    expect(JS_TOOL_DESCRIPTION).toContain(
      "Never use screenshot_display.bounds or app/window bounds as raster pixel coordinates",
    );
    expect(JS_TOOL_DESCRIPTION).toContain(
      "Metadata methods such as list_apps and list_windows may not return action_sent",
    );
    // open_application was removed from the Computer Use surface (get_app_state binds and launches on demand).
    // The tool description was missed in that pass, telling the model about a nonexistent method on every request.
    expect(JS_TOOL_DESCRIPTION).not.toContain("open_application");
  });

  it("creates a fresh kernel for every js call", async () => {
    const first = await client.callTool({
      name: "js",
      arguments: {
        code: "globalThis.counter = 41; counter;",
        title: "Init counter",
      },
      _meta: requestMeta("session-1"),
    });
    expect(first.content).toContainEqual(expect.objectContaining({ type: "text", text: "=> 41" }));

    const second = await client.callTool({
      name: "js",
      arguments: {
        code: "({ counterType: typeof globalThis.counter, session: nodeRepl.requestMeta.session_id });",
      },
      _meta: requestMeta("session-1", "main", "turn-2"),
    });
    expect(second.content).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining('"counterType": "undefined"'),
      }),
    );
    expect(second.content).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining('"session": "session-1"'),
      }),
    );
  });

  it("exposes js as the only node_repl tool and rejects the two retired ones", async () => {
    // Root cause: on 2026-09-18, js_reset and js_add_node_module_dir were retired, leaving node_repl with js only.
    // js_reset had been a fixed-success no-op since the fresh-kernel rework, and "never fails" made weak models call it
    // in a loop (ticket ZCT-2100503886992535552: 155 consecutive calls, 19 minutes, 48.37M input tokens, ending in a 429).
    // js_add_node_module_dir pushed a host duty onto the model, which cannot know which node_modules to pass;
    // only the skill docs could tell it, and paths the docs know the host can inject itself; measured call counts for both were zero.
    // Two things must hold: the tools vanish from the model-facing surface, and calling them fails loudly instead of silently succeeding --
    // "tool not found" is the signal the model needs to switch strategy.
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["js"]);
    for (const retired of ["js_reset", "js_add_node_module_dir"]) {
      await expect(
        client.callTool({ name: retired, arguments: {}, _meta: requestMeta("session-1") }),
      ).rejects.toThrow(`Tool ${retired} not found`);
    }
  });

  it("supports top-level await import syntax", async () => {
    const result = await client.callTool({
      name: "js",
      arguments: {
        code: 'const pathModule = await import("node:path"); pathModule.sep;',
      },
      _meta: requestMeta("session-1"),
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toContainEqual(
      expect.objectContaining({
        type: "text",
        text: expect.stringMatching(/^=> [\\/]$/),
      }),
    );
  });

  it("ignores spoofed top-level session metadata in favor of the host namespace", async () => {
    const result = await client.callTool({
      name: "js",
      arguments: { code: "nodeRepl.requestMeta.session_id;" },
      _meta: {
        session_id: "spoofed-session",
        ...requestMeta("trusted-session"),
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: "text", text: "=> trusted-session" }),
    );
  });

  it("keeps generic JavaScript available for subagent calls", async () => {
    const result = await client.callTool({
      name: "js",
      arguments: { code: "21 * 2;" },
      _meta: requestMeta("subagent-session", "subagent"),
    });

    expect(result.isError).not.toBe(true);
    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "=> 42" }));
  });

  it("returns a structured error without suppressing the standard MCP error marker", async () => {
    const result = await client.callTool({
      name: "js",
      arguments: {
        code: [
          'nodeRepl.write("internal diagnostic that must not reach the model");',
          "const error = new Error(\"browser tab 'iab-tab:test' returned an invalid viewport\");",
          'error.name = "BrowserCommandError";',
          "throw error;",
        ].join("\n"),
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: "browser tab 'iab-tab:test' returned an invalid viewport",
      },
    ]);
    expect(result._meta).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("BrowserCommandError");
    expect(JSON.stringify(result)).not.toContain("internal diagnostic");
    expect(JSON.stringify(result)).not.toContain(" at ");
  });

  it("projects images plus response metadata from a fresh call", async () => {
    const output = await client.callTool({
      name: "js",
      arguments: {
        code: 'nodeRepl.setResponseMeta({ browser_use: { url: "https://example.test" } }); await nodeRepl.emitImage({ base64: "AAAA", mimeType: "image/png" }); "done";',
      },
      _meta: requestMeta("session-1"),
    });
    expect(output.content).toContainEqual(
      expect.objectContaining({
        type: "image",
        data: "AAAA",
        mimeType: "image/png",
      }),
    );
    expect(output._meta).toEqual({
      browser_use: { url: "https://example.test" },
      "zcode/nodeReplEmittedImage": true,
    });
  });

  it("carries no copy of the Computer Use assets", () => {
    // With the host split from the two capability plugins, there is a single CUA SDK and doc set, owned by the computer-use plugin;
    // the host resolves it via ZCODE_CUA_PLUGIN_ROOT. Before 2026-09-11, browser-use kept hand-maintained copies,
    // and the doc copy silently lagged the pre-refactor API, which the fallback path would hand to the model.
    for (const relative of [
      "../../browser-use-plugin/scripts/computer-use-client.mjs",
      "../../browser-use-plugin/docs/computer-use.md",
      "../scripts/computer-use-client.mjs",
      "../docs/computer-use.md",
    ]) {
      expect(
        existsSync(resolve(import.meta.dirname, relative)),
        `${relative} must not exist: the canonical copy lives in zcode-cua-plugin`,
      ).toBe(false);
    }
    expect(
      existsSync(
        resolve(import.meta.dirname, "../../zcode-cua-plugin/scripts/computer-use-client.mjs"),
      ),
    ).toBe(true);
  });

  it("orders image blocks before the text block so image-first providers keep the raster", () => {
    const result = toMcpRunResult({
      logs: "log line",
      result: "done",
      images: [
        { base64: "AQID", mimeType: "image/png" },
        { base64: "BAUG", mimeType: "image/jpeg" },
      ],
    });

    expect(result.content).toEqual([
      { type: "image", data: "AQID", mimeType: "image/png" },
      { type: "image", data: "BAUG", mimeType: "image/jpeg" },
      { type: "text", text: "log line\n=> done" },
    ]);
    // The gateway parses only leading consecutive images in tool_result.content; once text comes first, later images are dropped.
    const firstTextIndex = result.content.findIndex((block) => block.type === "text");
    const lastImageIndex = result.content.reduce(
      (last, block, index) => (block.type === "image" ? index : last),
      -1,
    );
    expect(lastImageIndex).toBeLessThan(firstTextIndex);
  });

  it("drops a byte-identical emitImage duplicate so a redundant call cannot cost the whole frame", () => {
    // Root cause (2026-09-11, on-device): the model wrote
    //   const shot = await app.getScreenshot(); await nodeRepl.emitImage(shot);
    // getScreenshot had already published image plus authority via emitStructuredResult, so the result held two images;
    // and the exact-raster gate, allowing one final raster per result, atomically vetoed the whole frame.
    //
    // The gate cannot be relaxed (frame_id pins pixel coordinates), but the byte-identical copy is pure redundancy and can be dropped,
    // so the redundant call no longer drags the whole frame into the veto.
    const authority = JSON.stringify({
      image_ref: { actionable: true, frame_id: "frame-1", height: 2, width: 4 },
    });
    const result = toMcpRunResult({
      structuredResults: [
        {
          content: [
            { type: "image", data: "AQID", mimeType: "image/png" },
            { type: "text", text: authority },
          ],
        },
      ],
      images: [{ base64: "AQID", mimeType: "image/png" }],
    } as never);

    const images = result.content.filter((block) => block.type === "image");
    expect(images).toEqual([{ type: "image", data: "AQID", mimeType: "image/png" }]);
    // The authority must sit immediately after the surviving image -- dedupe must not split the atomic pair.
    expect(result.content[0]?.type).toBe("image");
    expect((result.content[1] as { text?: string }).text).toBe(authority);
  });

  it("keeps a different model image so a genuine two-raster result still reaches the gate", () => {
    // Differing bytes are not redundancy: those are two real rasters; the integrity gate keeps the verdict, and the host must not wave them through.
    const result = toMcpRunResult({
      structuredResults: [{ content: [{ type: "image", data: "AQID", mimeType: "image/png" }] }],
      images: [{ base64: "ZZZZ", mimeType: "image/png" }],
    } as never);

    expect(result.content.filter((block) => block.type === "image")).toHaveLength(2);
  });

  it("flattens an SDK CallToolResult so CUA action-state and image references stay top-level", () => {
    const embedded = {
      content: [
        { type: "text", text: "Clicked Save." },
        {
          type: "text",
          text: JSON.stringify({
            schema_version: "zcode-cua-action-outcome-v1",
            action_sent: true,
            verification_status: "verified",
            state_available: true,
          }),
        },
        { type: "text", text: '{"image_ref":"frame-1"}' },
      ],
      structuredContent: { action_state: { state_id: "state-2" } },
    };
    const result = toMcpRunResult({
      logs: "",
      result: `=> ${JSON.stringify(embedded)}`,
      images: [{ base64: "AQID", mimeType: "image/png" }],
    });

    expect(result.content).toEqual([
      { type: "image", data: "AQID", mimeType: "image/png" },
      ...embedded.content,
    ]);
    expect(result.content[1]).toEqual({ type: "text", text: "Clicked Save." });
    expect(result.content[2]?.text).toContain('"action_sent":true');
    expect(result.content[3]?.text).toContain('"image_ref":"frame-1"');
    expect(result).toMatchObject({ structuredContent: embedded.structuredContent });
  });

  it("keeps an SDK result authoritative when the model logs its returned value", () => {
    const structured = {
      content: [
        { type: "image", data: "AQID", mimeType: "image/png" },
        { type: "text", text: '{"image_ref":"frame-2"}' },
      ],
      structuredContent: { state_id: "state-2" },
      _meta: { "zcode-cua": "official" },
    };
    const result = toMcpRunResult({
      logs: `console output\n${JSON.stringify({ content: structured.content })}`,
      result: JSON.stringify({ content: structured.content }),
      structuredResults: [structured],
    });

    expect(result.content).toEqual([
      ...structured.content,
      {
        type: "text",
        text: 'console output\n{"content":[{"type":"image","data":"AQID","mimeType":"image/png"},{"type":"text","text":"{\\"image_ref\\":\\"frame-2\\"}"}]}',
      },
    ]);
    expect(result).toMatchObject({
      structuredContent: structured.structuredContent,
      _meta: structured._meta,
    });
  });

  it("keeps CUA sideband metadata without adding a legacy action text block", () => {
    const result = toMcpRunResult({
      logs: "state_id=s-2\nelements (1):",
      result: undefined,
      structuredResults: [
        {
          content: [],
          _meta: { "zcode.cua/target-app-display-v1": { pid: 7 } },
        },
      ],
    });

    expect(result.content).toEqual([{ type: "text", text: "state_id=s-2\nelements (1):" }]);
    expect(result._meta).toMatchObject({
      "zcode.cua/target-app-display-v1": { pid: 7 },
    });
  });

  it("keeps the single text block when no image is emitted", () => {
    expect(toMcpRunResult({ logs: "", result: undefined }).content).toEqual([
      { type: "text", text: "(no output)" },
    ]);
  });

  it("projects trusted browser screenshot image indices and removes spoofed response metadata", () => {
    const screenshot = toMcpRunResult({
      logs: "",
      images: [{ base64: "AQID", mimeType: "image/png" }],
      browserScreenshotImageIndices: [0],
    });
    // Images now start at content[0]; image indexes match content indexes with no +1 offset.
    expect(screenshot.content[0]).toEqual({
      type: "image",
      data: "AQID",
      mimeType: "image/png",
    });
    expect(screenshot._meta).toMatchObject({
      [ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY]: [0],
    });

    const spoofed = toMcpRunResult({
      logs: "",
      images: [{ base64: "BAUG", mimeType: "image/png" }],
      responseMeta: {
        [ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY]: [1],
      },
    });
    expect(spoofed._meta).not.toHaveProperty(ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY);
  });

  it("projects the CUA app identity recorded by the bridge and drops the sandbox-forgeable key", () => {
    // `nodeRepl.setResponseMeta` / `nodeRepl.emitStructuredResult` hang off the model-visible sandbox
    // globals, so producer keys arriving through those channels are untrusted -- the model could make a tool card claim it operated
    // another app. Trusted facts come only from run.cuaApp, recorded by the CUA bridge straight from the broker response.
    const trusted = toMcpRunResult({
      logs: "",
      cuaApp: { appKey: "darwin:com.apple.notes", displayName: "Notes" },
      responseMeta: {
        [CUA_APP_ASSOCIATIONS_META_KEY]: {
          schemaVersion: 1,
          primary: { appKey: "darwin:com.apple.systempreferences", displayName: "System Settings" },
        },
      },
    } as never);

    expect(trusted._meta).toMatchObject({
      [ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY]: {
        appKey: "darwin:com.apple.notes",
        displayName: "Notes",
      },
    });
    // Forged producer keys must disappear entirely; they must not coexist with trusted keys for downstream mixups.
    expect(trusted._meta).not.toHaveProperty(CUA_APP_ASSOCIATIONS_META_KEY);

    // With no trusted record, sandbox-side forgery yields no identity at all.
    const forgedOnly = toMcpRunResult({
      logs: "",
      responseMeta: {
        [CUA_APP_ASSOCIATIONS_META_KEY]: {
          schemaVersion: 1,
          primary: { appKey: "darwin:com.apple.notes" },
        },
      },
    } as never);
    expect(forgedOnly._meta ?? {}).not.toHaveProperty(ZCODE_MCP_NODE_REPL_CUA_APP_META_KEY);
    expect(forgedOnly._meta ?? {}).not.toHaveProperty(CUA_APP_ASSOCIATIONS_META_KEY);
  });

  it("maps screenshot indices to their real content positions when only some images are screenshots", () => {
    const result = toMcpRunResult({
      logs: "",
      images: [
        { base64: "AAAA", mimeType: "image/png" },
        { base64: "BBBB", mimeType: "image/png" },
        { base64: "CCCC", mimeType: "image/png" },
      ],
      browserScreenshotImageIndices: [0, 2],
    });

    expect(result._meta).toMatchObject({
      [ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY]: [0, 2],
    });
    // Every declared index must point at a real image block in content (out-of-range or text-pointing indexes would misalign the saved frames).
    for (const index of [0, 2]) {
      expect(result.content[index]?.type).toBe("image");
    }
    expect(result.content[1]).toEqual({ type: "image", data: "BBBB", mimeType: "image/png" });
  });
});
