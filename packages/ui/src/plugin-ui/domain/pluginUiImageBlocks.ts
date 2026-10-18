import { MCP_APPS_IMAGE_MAX_BYTES, MCP_APPS_IMAGE_MIME_TYPES } from "@zcode/shared/mcp-apps";

/** A validated image block: base64 body (no data: prefix), mimeType, decoded byte length. */
export interface PluginUiImageBlock {
  mimeType: string;
  dataBase64: string;
  bytes: number;
}

export type PluginUiImageBlocksResult =
  | { ok: true; images: PluginUiImageBlock[] }
  | {
      ok: false;
      reason: "unsupported_mime" | "too_large" | "invalid_block";
      mimeType?: string;
      bytes?: number;
    };

const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function base64ByteLength(dataBase64: string): number {
  const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
  return Math.floor((dataBase64.length * 3) / 4) - padding;
}

/**
 * Pick { type: image, data, mimeType } blocks from MCP content (text and others ignored).
 * Any image off the allowlist or oversized fails the whole request -- no partial accept; the page sends smaller images.
 */
export function readPluginUiImageBlocks(
  content: readonly Record<string, unknown>[] | undefined,
): PluginUiImageBlocksResult {
  const images: PluginUiImageBlock[] = [];
  for (const block of content ?? []) {
    if (block.type !== "image") continue;
    const data = block.data;
    const mimeType = typeof block.mimeType === "string" ? block.mimeType.trim().toLowerCase() : "";
    if (typeof data !== "string" || data.length === 0 || !BASE64_PATTERN.test(data)) {
      return { ok: false, reason: "invalid_block", ...(mimeType ? { mimeType } : {}) };
    }
    if (!(MCP_APPS_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) {
      return { ok: false, reason: "unsupported_mime", mimeType };
    }
    const bytes = base64ByteLength(data);
    if (bytes > MCP_APPS_IMAGE_MAX_BYTES)
      return { ok: false, reason: "too_large", mimeType, bytes };
    images.push({ mimeType, dataBase64: data, bytes });
  }
  return { ok: true, images };
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** Attachment name plugin-<safePluginId>-<n>.<ext>; legible to model and user alike. */
export function buildPluginUiImageFileName(
  pluginId: string,
  index: number,
  mimeType: string,
): string {
  const safe = pluginId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "plugin";
  return `plugin-${safe}-${index + 1}.${EXTENSION_BY_MIME[mimeType] ?? "bin"}`;
}
