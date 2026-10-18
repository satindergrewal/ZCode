// UI-side attachment command surface: ZCodePromptAttachment (the composer serialization
// product) -> AttachmentRef (the v4 sendText/createSession reference model).
//
// Dispatch rules (the dual of the CLI's attachment-refs.ts mapping):
// - localPath (the desktop mainline: native picker, drag getPathForFile, long-paste temp files,
//   oversized-image downgrade) -> the ref carries the absolute path, zero upload;
// - dataBase64 (pasted screenshots and other inline images) -> high-level put (begin/chunk/commit) -> artifact ref;
// - textContent (pathless text, the web fallback) -> encoded through the same put;
// - none of the three (metadata-only) -> drop with a warning (nothing to send; never fake a ref).
import type { ZCodePromptAttachment } from "@zcode/shared";
import type {
  AttachmentRef,
  V4AttachmentPutParams,
  V4AttachmentPutResult,
} from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import type { AttachmentUploadOptions } from "@/v4/attachmentUploadTransaction.js";

export type AttachmentPutFn = (
  params: V4AttachmentPutParams,
  options?: AttachmentUploadOptions,
) => Promise<V4AttachmentPutResult>;

function encodeTextToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ByteLength(dataBase64: string): number {
  const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
  return Math.floor((dataBase64.length * 3) / 4) - padding;
}

/** One attachment -> AttachmentRef (chunked transaction when upload needed). null = nothing to send (drop). */
export async function uploadComposerAttachment(
  put: AttachmentPutFn,
  sessionId: string,
  attachment: ZCodePromptAttachment,
  options?: AttachmentUploadOptions,
): Promise<AttachmentRef | null> {
  const fileName = attachment.filename;
  const mime = attachment.mimeType;
  const source =
    attachment.kind === "file" && attachment.sourceKind
      ? { sourceKind: attachment.sourceKind, messageCount: attachment.messageCount }
      : {};
  // Audio variants lack sizeBytes; read through the narrowing helper uniformly.
  const sizeBytes =
    "sizeBytes" in attachment && typeof attachment.sizeBytes === "number"
      ? attachment.sizeBytes
      : undefined;
  if (attachment.localPath) {
    return {
      ...source,
      ref: attachment.localPath,
      fileName,
      mime,
      bytes: sizeBytes ?? 0,
    };
  }
  const dataBase64 =
    "dataBase64" in attachment && attachment.dataBase64
      ? attachment.dataBase64
      : "textContent" in attachment && attachment.textContent !== undefined
        ? encodeTextToBase64(attachment.textContent)
        : null;
  if (dataBase64 === null) {
    logger.warn(
      `[v4-composer] attachment has nothing to send (no localPath/dataBase64/textContent); dropped: ${fileName}`,
    );
    return null;
  }
  const { ref } = await put({ sessionId, fileName, mime, dataBase64 }, options);
  return {
    ...source,
    ref,
    fileName,
    mime,
    bytes: sizeBytes ?? base64ByteLength(dataBase64),
  };
}

/**
 * Attachment[] -> AttachmentRef[] (order preserved). put failures throw as-is (caller aborts the send, draft kept).
 */
export async function uploadComposerAttachments(
  put: AttachmentPutFn,
  sessionId: string,
  attachments: readonly ZCodePromptAttachment[],
): Promise<AttachmentRef[]> {
  const refs: AttachmentRef[] = [];
  for (const attachment of attachments) {
    const ref = await uploadComposerAttachment(put, sessionId, attachment);
    if (ref) {
      refs.push(ref);
    }
  }
  return refs;
}
