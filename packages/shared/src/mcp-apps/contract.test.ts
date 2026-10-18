import { describe, expect, it } from "vitest";
import {
  MCP_APPS_EXTENSION_ID,
  MCP_APPS_RESOURCE_MIME_TYPE,
  MCP_APPS_UI_RESOURCE_SCHEME,
  MCP_APPS_LEGACY_RESOURCE_URI_META_KEY,
  buildMcpAppsClientCapabilities,
  isMcpAppsUiReadResourceMimeAllowed,
} from "./contract.js";
import { normalizeMcpAppCspRelaxations, normalizeMcpToolUiMeta } from "./toolMeta.js";
import {
  exampleClientCapabilities,
  exampleResourceMetaWithRelaxations,
  exampleSandboxHandle,
  exampleToolUiDescriptor,
} from "./contract.example.js";

describe("mcp-apps-protocol contract", () => {
  it.each([
    ["PDF document", " Application/PDF ; version=1.7 "],
    ["Office document", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["Spreadsheet", "application/vnd.ms-excel"],
    ["Open presentation", "application/vnd.oasis.opendocument.presentation"],
    ["Vector image", "image/svg+xml; charset=utf-8"],
    ["Camera image", "image/heic"],
    ["Animated image", "image/gif"],
    ["Audio", "audio/mpeg"],
    ["WAV alias", "audio/x-wav"],
    ["Video", "video/mp4"],
    ["Archive", "application/zip"],
    ["GZIP alias", "application/x-gzip"],
    ["Font", "font/woff2"],
    ["Structured data", "application/yaml"],
    ["JSON model", "model/gltf+json"],
    ["Known text prefix", "text/csv; charset=utf-8"],
    ["Known binary", "application/octet-stream"],
    ["Known model", "model/gltf-binary"],
  ])("accepts page resource %s (%s)", (_label, mimeType) => {
    expect(isMcpAppsUiReadResourceMimeAllowed(mimeType)).toBe(true);
  });

  it.each([
    "application/x-msdownload",
    "application/x-executable",
    "application/vnd.example.unknown",
    "image/x-example-unknown",
    "application/pdf-malware",
    "application/pdf,application/x-msdownload",
    "",
    " ; charset=utf-8",
  ])("resource-cap expansion still rejects unknown or invalid MIME: %s", (mimeType) => {
    expect(isMcpAppsUiReadResourceMimeAllowed(mimeType)).toBe(false);
  });

  it("extension id and UI resource mimeType match the official SDK constants", () => {
    expect(MCP_APPS_EXTENSION_ID).toBe("io.modelcontextprotocol/ui");
    expect(MCP_APPS_RESOURCE_MIME_TYPE).toBe("text/html;profile=mcp-app");
    expect(MCP_APPS_LEGACY_RESOURCE_URI_META_KEY).toBe("ui/resourceUri");
    expect(buildMcpAppsClientCapabilities()).toEqual(exampleClientCapabilities);
  });

  it("resourceUri accepts the standard key, the deprecated flat key, and openai/outputTemplate", () => {
    expect(normalizeMcpToolUiMeta({ ui: { resourceUri: "ui://a/b" } })?.resourceUri).toBe(
      "ui://a/b",
    );
    expect(normalizeMcpToolUiMeta({ "ui/resourceUri": "ui://a/c" })?.resourceUri).toBe("ui://a/c");
    expect(normalizeMcpToolUiMeta({ "openai/outputTemplate": "ui://a/d" })?.resourceUri).toBe(
      "ui://a/d",
    );
    expect(normalizeMcpToolUiMeta({ ui: { resourceUri: "https://a/b" } })).toBeNull();
  });

  it("zcode/csp honors known boolean keys only", () => {
    expect(normalizeMcpAppCspRelaxations(exampleResourceMetaWithRelaxations)).toEqual({
      unsafeEval: true,
    });
    expect(normalizeMcpAppCspRelaxations({ "zcode/csp": { unsafeEval: false, other: true } })).toBe(
      null,
    );
  });

  it("example descriptor and handle satisfy the contract shapes", () => {
    expect(exampleToolUiDescriptor.resourceUri.startsWith(MCP_APPS_UI_RESOURCE_SCHEME)).toBe(true);
    expect(exampleSandboxHandle.shellUrl).toBe(
      `zcode-sandbox://shell-${exampleSandboxHandle.sandboxId}/`,
    );
    expect(exampleSandboxHandle.partition.startsWith("persist:plugin-sandbox-")).toBe(true);
  });
});
