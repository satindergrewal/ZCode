import { isAbsolute, resolve } from "node:path";
import {
  ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY,
  type McpContentBlock,
  type McpToolCallResult,
  type McpToolDescriptor,
  type TraceContext,
} from "@zcode/contracts";
import {
  isOfficialCuaImageRefText,
  OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY,
} from "@zcode/zcode-cua/frame-contract";
import type { ToolExecutionContext } from "../tool/types.js";
// The frame-pixel contract (integrity gate + inline cap) is defined only in the producer; the host
// consumes it via plugin re-export and no longer mirrors the implementation. core's awareness of CUA narrows to: the authority
// branch calling the producer gate, non-authority branches stripping forged references via the contracts scanner.
import { preserveOfficialCuaFrameResult } from "@zcode/zcode-cua/frame-contract";

// The generic MCP inline-image budget and the official 200 KiB frame cap once shared a value but are semantically independent:
// define it separately here to avoid the inverted coupling of a generic budget defined by a CUA constant.
export const MCP_IMAGE_INLINE_BASE64_BYTES = 200 * 1024;
export const MCP_IMAGE_INLINE_RAW_BYTES = Math.floor((MCP_IMAGE_INLINE_BASE64_BYTES * 3) / 4);
export const HOST_NODE_REPL_IMAGE_MAX_DIMENSION = 2048;
// Provider model-image cap is 2000px; end-of-turn browser display keeps its own separate 2048px budget.
const HOST_NODE_REPL_MODEL_IMAGE_MAX_DIMENSION = 2000;

export async function normalizeMcpToolResultForModel(input: {
  compressOversizedImages: boolean;
  context: ToolExecutionContext;
  descriptor: McpToolDescriptor;
  preserveOfficialCuaFrames?: boolean;
  result: McpToolCallResult;
  toolName: string;
}): Promise<McpToolCallResult> {
  // node_repl is a generic entry, so the whole server cannot be marked official CUA; but the CUA SDK puts
  // producer-issued integrity metadata into structured results. Only such a result dynamically enters the
  // exact-raster path, preserving CUA frames without touching the same server's Browser Use images.
  const isSharedNodeRepl =
    input.descriptor.serverName === "node_repl" || input.toolName === "mcp__node_repl__js";
  if (
    input.preserveOfficialCuaFrames ||
    (isSharedNodeRepl && hasOfficialCuaFrameAuthority(input.result))
  ) {
    return await preserveOfficialCuaFrameResult(input.result, {
      imageProcessorPort: input.context.imageProcessorPort,
      signal: input.context.abortSignal,
    });
  }

  let changed = false;
  const content: McpContentBlock[] = [];
  const browserScreenshotIndices = input.compressOversizedImages
    ? readBrowserScreenshotContentIndices(input.result)
    : new Set<number>();

  for (const [index, block] of input.result.content.entries()) {
    const browserScreenshotArtifact = browserScreenshotIndices.has(index)
      ? await persistBrowserScreenshotArtifact(block, input)
      : undefined;
    const normalized = await normalizeMcpContentBlockForModel(block, {
      ...input,
      browserScreenshotArtifact,
    });
    // Defense in depth: MCP results without authority verification must not carry official frame-reference text — a third-party
    // forged actionable frame_id, even if the producer registry would reject it, must not enter model
    // context and pollute the coordinate contract. Strip only text that is entirely a frame-reference JSON; field names inside prose
    // are not false-positived; authoritative frames go through preserveOfficialCuaFrames, unaffected.
    // Placed before the push: the stripped block is necessarily text, mutually exclusive with browserScreenshotArtifact
    // (image blocks only), so the continue cannot skip the screenshot-path hint below.
    if (
      normalized.type === "text" &&
      typeof normalized.text === "string" &&
      isOfficialCuaImageRefText(normalized.text)
    ) {
      changed = true;
      continue;
    }
    changed ||= normalized !== block;
    content.push(normalized);
    // Placing the hint text before the image would flip node_repl's deliberate image-first
    // tool_result.content back to text-first; the Anthropic-compatible gateway parses only leading contiguous images,
    // so once text leads, later images are dropped and the model never sees the screenshot. Keep it after the image.
    if (browserScreenshotArtifact) {
      content.push({
        type: "text",
        text: `Browser screenshot saved to: ${browserScreenshotArtifact.absolutePath}`,
      });
      changed = true;
    }
  }

  return changed ? { ...input.result, content } : input.result;
}

export function hasOfficialCuaFrameAuthority(result: unknown): result is McpToolCallResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const candidate = result as {
    content?: unknown;
    _meta?: Record<string, unknown>;
  };
  if (
    !Array.isArray(candidate.content) ||
    !candidate._meta?.[OFFICIAL_CUA_FRAME_INTEGRITY_META_KEY]
  ) {
    return false;
  }
  const blocks = candidate.content;
  return blocks.some((block, index) => {
    if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") {
      return false;
    }
    const nextText = (blocks[index + 1] as { text?: unknown } | undefined)?.text;
    return typeof nextText === "string" && isOfficialCuaImageRefText(nextText);
  });
}

async function normalizeMcpContentBlockForModel(
  block: McpContentBlock,
  input: {
    compressOversizedImages: boolean;
    context: ToolExecutionContext;
    descriptor: McpToolDescriptor;
    toolName: string;
    browserScreenshotArtifact?: BrowserScreenshotArtifact;
  },
): Promise<McpContentBlock> {
  if (block.type !== "image") return block;

  const data = typeof block.data === "string" ? block.data : undefined;
  const mimeType = typeof block.mimeType === "string" ? block.mimeType : undefined;
  if (!data || !mimeType) return block;

  const base64Payload = base64PayloadFromMcpImageData(data);
  const base64Bytes = Buffer.byteLength(base64Payload, "utf8");
  if (base64Bytes <= MCP_IMAGE_INLINE_BASE64_BYTES) return block;

  if (input.compressOversizedImages) {
    // Browser screenshots come from the trusted host node_repl; they must not be dumped to an artifact like third-party MCP images,
    // blinding the model; reuse the unified image port to compress to 200 KiB instead of adding another codec.
    const compressed = await tryCompressHostNodeReplImage({
      base64Payload,
      context: input.context,
      mimeType,
    });
    if (compressed) return compressed;
  }

  const summary = {
    base64Bytes,
    inlineLimitBytes: MCP_IMAGE_INLINE_BASE64_BYTES,
    mimeType,
  };

  if (input.browserScreenshotArtifact) {
    return {
      type: "text",
      text: [
        `MCP image content omitted: ${mimeType}, base64=${formatByteSize(base64Bytes)} exceeds inline limit ${formatByteSize(MCP_IMAGE_INLINE_BASE64_BYTES)}.`,
        "The original browser screenshot remains available at the adjacent absolute path.",
      ].join("\n"),
    };
  }

  if (!input.context.artifactStore) {
    return {
      type: "text",
      text: [
        `MCP image content omitted: ${mimeType}, base64=${formatByteSize(base64Bytes)} exceeds inline limit ${formatByteSize(MCP_IMAGE_INLINE_BASE64_BYTES)}.`,
        "No artifact store is configured, so the original image could not be saved.",
      ].join("\n"),
    };
  }

  const artifact = await writeMcpImageArtifact({
    base64Payload,
    context: input.context,
    dataUrl: asDataUrl(data, mimeType),
    descriptor: input.descriptor,
    summary,
    toolName: input.toolName,
  });

  return {
    type: "text",
    text: [
      `MCP image content saved instead of being inlined: ${mimeType}, base64=${formatByteSize(base64Bytes)}, inlineLimit=${formatByteSize(MCP_IMAGE_INLINE_BASE64_BYTES)}.`,
      `Artifact: ${artifact.path ?? artifact.uri}`,
      `Artifact URI: ${artifact.uri}`,
    ].join("\n"),
  };
}

interface BrowserScreenshotArtifact {
  absolutePath: string;
}

function readBrowserScreenshotContentIndices(result: McpToolCallResult): Set<number> {
  const value = result._meta?.[ZCODE_MCP_BROWSER_SCREENSHOT_CONTENT_INDICES_META_KEY];
  if (!Array.isArray(value)) return new Set<number>();
  return new Set(
    value.filter(
      (index): index is number =>
        Number.isInteger(index) && index >= 0 && index < result.content.length,
    ),
  );
}

async function persistBrowserScreenshotArtifact(
  block: McpContentBlock,
  input: {
    context: ToolExecutionContext;
    toolName: string;
  },
): Promise<BrowserScreenshotArtifact | undefined> {
  if (block.type !== "image") return undefined;
  const data = typeof block.data === "string" ? block.data : undefined;
  const mimeType = typeof block.mimeType === "string" ? block.mimeType : undefined;
  const artifactStore = input.context.artifactStore;
  const writeBinary = artifactStore?.writeToolResultBinaryArtifact;
  if (!data || !mimeType || !artifactStore || !writeBinary) return undefined;

  const content = Buffer.from(base64PayloadFromMcpImageData(data), "base64");
  if (content.byteLength === 0) return undefined;
  try {
    const artifact = await writeBinary.call(
      artifactStore,
      {
        sessionId: input.context.sessionId,
        turnId: input.context.turnId,
        toolCallId: input.context.toolCallId,
        toolName: input.toolName,
        content,
        contentType: mimeType,
        extension: extensionForMimeType(mimeType),
        retention: "session",
        trace: traceFromToolContext(input.context),
      },
      { signal: input.context.abortSignal },
    );
    if (!artifact.path) return undefined;
    return {
      absolutePath: isAbsolute(artifact.path) ? artifact.path : resolve(artifact.path),
    };
  } catch (error) {
    // A failure writing the extra screenshot path must not overwrite the already-successful browser result;
    // but on tool cancellation, exit immediately without processing more large images.
    if (input.context.abortSignal.aborted) throw error;
    return undefined;
  }
}

async function tryCompressHostNodeReplImage(input: {
  base64Payload: string;
  context: ToolExecutionContext;
  mimeType: string;
}): Promise<McpContentBlock | undefined> {
  const imageProcessorPort = input.context.imageProcessorPort;
  if (!imageProcessorPort) return undefined;

  const decoded = Buffer.from(input.base64Payload, "base64");
  if (decoded.byteLength === 0) return undefined;

  try {
    const prepared = await imageProcessorPort.prepareForModel(
      {
        data: decoded,
        maxBase64Bytes: MCP_IMAGE_INLINE_BASE64_BYTES,
        maxDimension: HOST_NODE_REPL_MODEL_IMAGE_MAX_DIMENSION,
        maxRawBytes: MCP_IMAGE_INLINE_RAW_BYTES,
        mediaType: input.mimeType,
        trace: traceFromToolContext(input.context),
      },
      { signal: input.context.abortSignal },
    );
    const compressedBase64 = Buffer.from(prepared.data).toString("base64");
    const compressedBase64Bytes = Buffer.byteLength(compressedBase64, "utf8");
    if (
      compressedBase64Bytes === 0 ||
      compressedBase64Bytes > MCP_IMAGE_INLINE_BASE64_BYTES ||
      !prepared.mediaType.startsWith("image/")
    ) {
      return undefined;
    }
    return {
      type: "image",
      data: compressedBase64,
      mimeType: prepared.mediaType,
    };
  } catch (error) {
    if (input.context.abortSignal.aborted) throw error;
    return undefined;
  }
}

async function writeMcpImageArtifact(input: {
  base64Payload: string;
  context: ToolExecutionContext;
  dataUrl: string;
  descriptor: McpToolDescriptor;
  summary: {
    base64Bytes: number;
    inlineLimitBytes: number;
    mimeType: string;
  };
  toolName: string;
}): Promise<{
  bytes: number;
  contentType: string;
  path?: string;
  uri: string;
}> {
  const artifactStore = input.context.artifactStore;
  if (!artifactStore) {
    throw new Error("MCP image artifact store is not configured");
  }

  if (artifactStore.writeToolResultBinaryArtifact) {
    return artifactStore.writeToolResultBinaryArtifact(
      {
        sessionId: input.context.sessionId,
        turnId: input.context.turnId,
        toolCallId: input.context.toolCallId,
        toolName: input.toolName,
        content: Buffer.from(input.base64Payload, "base64"),
        contentType: input.summary.mimeType,
        extension: extensionForMimeType(input.summary.mimeType),
        retention: "session",
        trace: traceFromToolContext(input.context),
      },
      { signal: input.context.abortSignal },
    );
  }

  return artifactStore.writeToolResultArtifact(
    {
      sessionId: input.context.sessionId,
      turnId: input.context.turnId,
      toolCallId: input.context.toolCallId,
      toolName: input.toolName,
      content: JSON.stringify(
        {
          type: "mcp-image-artifact",
          createdAt: new Date().toISOString(),
          dataUrl: input.dataUrl,
          registeredToolName: input.toolName,
          serverName: input.descriptor.serverName,
          toolName: input.descriptor.toolName,
          ...input.summary,
        },
        null,
        2,
      ),
      contentType: "application/json",
      retention: "session",
      trace: traceFromToolContext(input.context),
    },
    { signal: input.context.abortSignal },
  );
}

export function asDataUrl(data: string, mimeType: string): string {
  return data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`;
}

export function base64PayloadFromMcpImageData(data: string): string {
  if (!data.startsWith("data:")) return data;
  const commaIndex = data.indexOf(",");
  return commaIndex >= 0 ? data.slice(commaIndex + 1) : data;
}

function extensionForMimeType(mimeType: string): string {
  const mime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (mime) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return ".bin";
  }
}

function traceFromToolContext(context: ToolExecutionContext): TraceContext {
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: context.parentSpanId,
    sessionId: context.sessionId,
    turnId: context.turnId,
  } as TraceContext;
}

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const formatted =
    value >= 10 || unitIndex === 0 ? Math.round(value).toString() : value.toFixed(1);
  return `${formatted} ${units[unitIndex]}`;
}
