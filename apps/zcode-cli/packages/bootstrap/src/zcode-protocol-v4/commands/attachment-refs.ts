// Attachment command surface: protocol-boundary mapping from AttachmentRef (by-reference model) to core TurnAttachment.
//
// The two ref shapes (mirroring the projection side's "local path / artifact URI" note in buildUserInputRow):
// 1. URI ref (zcode-artifact:// etc., with scheme:/) -- a content reference registered via the attachment chunk transaction:
//    - images: content carries the URI; core's attachment-artifacts resolution reads the data URL back at model-request time
//      (same shape as externalizePromptAttachments' output; no inlining/decoding here,
//      avoiding large images ballooning memory at the command layer).
//    - PDF: the URI goes to core's PDF resolver; other non-images: read the artifact back and decode
//      to <=64KiB text per the legacy decodeTextProtocolAttachment
//      semantics (over-limit/undecodable -> keep display metadata, never fabricate content).
// 2. local-path ref (desktop passes absolute paths) -- mapped via the legacy mapProtocolPromptAttachment
//    localPath branch into a path reference; core already has read thresholds and degradation.
import type { TurnAttachment } from "@zcode/core";
import type { AttachmentRef } from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeApp } from "../../app/types.js";

const URI_REF_PATTERN = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//;
const INLINE_TEXT_ATTACHMENT_MAX_BYTES = 64 * 1024;

export function isUriAttachmentRef(ref: string): boolean {
  return URI_REF_PATTERN.test(ref);
}

function displayMetaOf(
  ref: AttachmentRef,
): Pick<TurnAttachment, "filename" | "mimeType" | "sizeBytes" | "sourceKind" | "messageCount"> {
  return {
    filename: ref.fileName,
    mimeType: ref.mime,
    sizeBytes: ref.bytes,
    ...(ref.sourceKind ? { sourceKind: ref.sourceKind, messageCount: ref.messageCount } : {}),
  };
}

function isImageRef(ref: AttachmentRef): boolean {
  return ref.mime.split(";", 1)[0]?.trim().toLowerCase().startsWith("image/") ?? false;
}

function isVideoRef(ref: AttachmentRef): boolean {
  return ref.mime.split(";", 1)[0]?.trim().toLowerCase().startsWith("video/") ?? false;
}

function isPdfRef(ref: AttachmentRef): boolean {
  return ref.mime.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf";
}

/** data URL (data:<mime>;base64,<payload>) -> utf8 text; non-base64 data URLs return the body as-is. */
function decodeDataUrlText(content: string): string | undefined {
  if (!content.startsWith("data:")) return content;
  const commaIndex = content.indexOf(",");
  if (commaIndex === -1) return undefined;
  const header = content.slice(0, commaIndex);
  const payload = content.slice(commaIndex + 1);
  if (!header.includes(";base64")) return decodeURIComponent(payload);
  try {
    return Buffer.from(payload, "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

async function mapAttachmentRef(app: ZCodeApp, ref: AttachmentRef): Promise<TurnAttachment> {
  const displayMeta = displayMetaOf(ref);
  if (!isUriAttachmentRef(ref.ref)) {
    // Local-path reference: handed to core's file/image read chain (thresholds and degradation built in).
    if (isVideoRef(ref)) {
      return { path: ref.ref, type: "video", ...displayMeta };
    }
    return {
      path: ref.ref,
      type: isImageRef(ref) ? "image" : isPdfRef(ref) ? "pdf" : "file",
      ...displayMeta,
    };
  }
  if (ref.sourceKind === "topic-history" || ref.sourceKind === "clipboard-text") {
    // Text material must keep its durable reference; decoding it as a plain small file would re-hide-inject the whole history.
    return { content: ref.ref, type: "file", ...displayMeta };
  }
  if (isImageRef(ref)) {
    // Image URI ref: content carries the artifact URI, read back by resolveAttachmentDataUrl at model-request time
    // (same shape as externalizePromptAttachments' output, so no re-externalization ever happens).
    return { content: ref.ref, path: ref.fileName, type: "image", ...displayMeta };
  }
  if (isVideoRef(ref)) {
    // video URI ref: same shape as images -- content carries the artifact URI, read back to a data URL at model-request time.
    return { content: ref.ref, path: ref.fileName, type: "video", ...displayMeta };
  }
  if (isPdfRef(ref)) {
    // PDF URI refs must keep the durable URI for core to read the data URL; never decode as UTF-8 text.
    return { content: ref.ref, path: ref.fileName, type: "pdf", ...displayMeta };
  }
  // Non-image URI ref: restore <=64KiB text content per the legacy decodeTextProtocolAttachment semantics.
  if (ref.bytes > INLINE_TEXT_ATTACHMENT_MAX_BYTES) {
    return { type: "file", ...displayMeta };
  }
  try {
    const artifact = await app.readToolResultArtifact(ref.ref);
    const text = decodeDataUrlText(artifact.content);
    return text !== undefined
      ? { content: text, path: ref.fileName, type: "file", ...displayMeta }
      : { type: "file", ...displayMeta };
  } catch {
    // Broken reference (TTL eviction/write failure): keep the display metadata, never fail the whole send.
    return { type: "file", ...displayMeta };
  }
}

/**
 * Shared by sendText/createSession/editUserQuery: attachment ref arrays -> core TurnAttachment[].
 * Empty/missing -> undefined (sendInput semantics: no attachments means no field).
 */
export async function mapAttachmentRefsToTurnAttachments(
  app: ZCodeApp,
  refs: readonly AttachmentRef[] | undefined,
): Promise<TurnAttachment[] | undefined> {
  if (!refs || refs.length === 0) return undefined;
  const mapped = await Promise.all(refs.map((ref) => mapAttachmentRef(app, ref)));
  return mapped.length > 0 ? mapped : undefined;
}
