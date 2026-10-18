// Shared video-attachment mime inference and size validation.
// Both the Read tool (read-video.ts) and prompt-attachment parsing (attachments.ts) take it here,
// keeping one source of truth for the extension-to-mime map; the mime enum's truth lives in contracts (ReadVideoOutput).
import type { ReadVideoOutput } from "@zcode/contracts";
import { base64PayloadByteLength, isStrictBase64Payload } from "./attachment-data-url.js";

export type VideoInputMimeType = ReadVideoOutput["mimeType"];

const VIDEO_INPUT_MIME_BY_EXTENSION: Record<string, VideoInputMimeType> = {
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
};

/** Infers video mime from extension; undefined for unsupported video extensions. */
export function inferVideoMimeFromPath(path: string): VideoInputMimeType | undefined {
  const lower = path.toLowerCase();
  for (const [extension, mime] of Object.entries(VIDEO_INPUT_MIME_BY_EXTENSION)) {
    if (lower.endsWith(extension)) return mime;
  }
  return undefined;
}

export function parseInlineVideoDataUrl(
  dataUrl: string,
): { mediaType: string; sizeBytes: number } | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/i.exec(dataUrl);
  const mediaType = match?.[1]?.toLowerCase();
  const payload = match?.[2];
  // Video inline used to check only a loose data URL header, letting missing base64 markers,
  // invalid bodies, and non-video MIME slip into persistence or the generic text branch.
  if (
    !mediaType?.startsWith("video/") ||
    payload === undefined ||
    !isStrictBase64Payload(payload)
  ) {
    return undefined;
  }
  return { mediaType, sizeBytes: base64PayloadByteLength(payload) };
}
