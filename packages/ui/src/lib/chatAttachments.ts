/* oxlint-disable eslint(max-lines) -- Composer attachment collection, restore and serialization share one MIME/size boundary. */
import { nanoid } from "nanoid";
import {
  VIDEO_INPUT_MAX_BYTES,
  type CreateTempTextAttachmentResult,
  type ZCodePromptAttachment,
} from "@zcode/shared";
import { PROTOCOL_V4_LIMITS } from "@zcode/shared/zcode-protocol-v4";
import {
  MissingInlineImageContentError,
  MissingInlinePdfContentError,
  OversizedInlineImageAttachmentError,
  OversizedInlinePdfAttachmentError,
  OversizedInlineVideoAttachmentError,
} from "@/lib/chatAttachmentErrors.js";
import {
  basenameFromPath,
  countClipboardTextLines,
  createClipboardTextAttachmentFilename,
  inferAttachmentMimeType,
  isTextLikeAttachment,
} from "@/lib/chatAttachmentMetadata.js";

export {
  MissingInlineImageContentError,
  MissingInlinePdfContentError,
  OversizedInlineImageAttachmentError,
  OversizedInlinePdfAttachmentError,
  OversizedInlineVideoAttachmentError,
} from "@/lib/chatAttachmentErrors.js";
export {
  countClipboardTextLines,
  formatAttachmentSize,
  shouldPreferSpreadsheetClipboardText,
} from "@/lib/chatAttachmentMetadata.js";

export const MAX_CHAT_ATTACHMENTS = 8;
export const LONG_PASTE_TEXT_ATTACHMENT_CHAR_THRESHOLD = 15 * 1024;
const INLINE_IMAGE_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
const INLINE_VIDEO_ATTACHMENT_MAX_BYTES = Math.min(
  VIDEO_INPUT_MAX_BYTES,
  PROTOCOL_V4_LIMITS.attachmentMaxBytes,
);
const INLINE_TEXT_ATTACHMENT_MAX_CHARS = 64 * 1024;

export type ChatComposerAttachmentSourceKind = "clipboard-text" | "topic-history";

export interface ChatComposerAttachment {
  id: string;
  file?: File;
  filename: string;
  sourceKind?: ChatComposerAttachmentSourceKind;
  messageCount?: number;
  lineCount?: number;
  charCount?: number;
  mimeType: string;
  sizeBytes: number;
  objectUrl?: string;
  localPath?: string;
}

const PDF_MIME_TYPE = "application/pdf";

function normalizeComposerMimeType(mimeType: string): string {
  const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return normalized === PDF_MIME_TYPE ? PDF_MIME_TYPE : mimeType;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Failed to read attachment"));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error("Failed to read attachment"));
    };
    reader.readAsDataURL(file);
  });
}

export function createChatComposerAttachment(
  file: File,
  localPath?: string,
): ChatComposerAttachment {
  const mimeType = normalizeComposerMimeType(file.type || inferAttachmentMimeType(file.name));
  return {
    id: nanoid(),
    file,
    filename: file.name,
    localPath,
    mimeType,
    objectUrl: URL.createObjectURL(file),
    sizeBytes: file.size,
  };
}

export function createChatComposerPathAttachment(localPath: string): ChatComposerAttachment {
  const filename = basenameFromPath(localPath);
  return {
    id: nanoid(),
    filename,
    localPath,
    mimeType: inferAttachmentMimeType(filename),
    sizeBytes: 0,
  };
}

export function createClipboardTextComposerAttachment(
  text: string,
  options: { now?: Date } = {},
): ChatComposerAttachment {
  const filename = createClipboardTextAttachmentFilename(options.now ?? new Date());
  const file = new File([text], filename, { type: "text/plain" });
  return {
    ...createChatComposerAttachment(file),
    charCount: text.length,
    lineCount: countClipboardTextLines(text),
    sourceKind: "clipboard-text",
  };
}

export function createClipboardTextPathComposerAttachment(
  text: string,
  attachment: CreateTempTextAttachmentResult,
): ChatComposerAttachment {
  return {
    id: nanoid(),
    filename: attachment.filename,
    localPath: attachment.localPath,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    charCount: text.length,
    lineCount: countClipboardTextLines(text),
    sourceKind: "clipboard-text",
  };
}

export function shouldCreateClipboardTextAttachment(text: string): boolean {
  return text.length >= LONG_PASTE_TEXT_ATTACHMENT_CHAR_THRESHOLD;
}

export function createClipboardTextAttachmentFilenameForDate(now: Date = new Date()): string {
  return createClipboardTextAttachmentFilename(now);
}

function decodeBase64ToBytes(dataBase64: string) {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function estimateDecodedBase64Bytes(dataBase64: string) {
  const paddingBytes = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((dataBase64.length * 3) / 4) - paddingBytes);
}

export function restoreChatComposerAttachment(
  attachment: ZCodePromptAttachment,
): ChatComposerAttachment {
  const mimeType = normalizeComposerMimeType(
    attachment.mimeType || inferAttachmentMimeType(attachment.filename),
  );
  const sizeBytes = "sizeBytes" in attachment ? (attachment.sizeBytes ?? 0) : 0;

  if (attachment.localPath && !attachment.dataBase64) {
    return {
      id: nanoid(),
      filename: attachment.filename,
      localPath: attachment.localPath,
      mimeType,
      ...("sourceKind" in attachment &&
      (attachment.sourceKind === "clipboard-text" || attachment.sourceKind === "topic-history")
        ? { sourceKind: attachment.sourceKind, messageCount: attachment.messageCount }
        : {}),
      sizeBytes,
    };
  }

  if (!attachment.dataBase64) {
    if (mimeType.startsWith("image/")) {
      if (!attachment.localPath && sizeBytes <= INLINE_IMAGE_ATTACHMENT_MAX_BYTES) {
        // 修复原因：小图片 metadata-only 状态没有 File/base64/localPath，后续发送一定不可读；
        // 恢复阶段直接结构化拒绝，避免 UI 显示一个看似可发送但最终失败的附件 chip。
        throw new MissingInlineImageContentError({
          filename: attachment.filename,
          sizeBytes,
        });
      }
      return {
        id: nanoid(),
        filename: attachment.filename,
        localPath: attachment.localPath,
        mimeType,
        sizeBytes,
      };
    }
    if (mimeType.split(";", 1)[0]?.trim().toLowerCase() === PDF_MIME_TYPE) {
      if (!attachment.localPath) {
        throw new MissingInlinePdfContentError({
          filename: attachment.filename,
          sizeBytes,
        });
      }
      return {
        id: nanoid(),
        filename: attachment.filename,
        localPath: attachment.localPath,
        mimeType,
        sizeBytes,
      };
    }
    const file = new File(
      [attachment.kind === "file" ? (attachment.textContent ?? "") : ""],
      attachment.filename,
      {
        type: mimeType,
      },
    );
    return createChatComposerAttachment(file, attachment.localPath);
  }

  const hasImageBase64 = mimeType.startsWith("image/") && Boolean(attachment.dataBase64);
  const hasVideoBase64 = mimeType.startsWith("video/") && Boolean(attachment.dataBase64);
  const hasPdfBase64 = mimeType.split(";", 1)[0]?.trim().toLowerCase() === PDF_MIME_TYPE;
  // Bug 根因：video 恢复最初复用了只为 image 计算的 effectiveSizeBytes，导致可选或低报的
  // sizeBytes 绕过解码前上限。inline 媒体统一以正文长度为准，metadata 只提供下限。
  const estimatedSizeBytes =
    hasImageBase64 || hasVideoBase64 || hasPdfBase64
      ? estimateDecodedBase64Bytes(attachment.dataBase64)
      : sizeBytes;
  const effectiveSizeBytes = Math.max(sizeBytes, estimatedSizeBytes);

  if (hasImageBase64 && effectiveSizeBytes > INLINE_IMAGE_ATTACHMENT_MAX_BYTES) {
    if (attachment.localPath) {
      // 修复原因：有 localPath 的图片最终由 agent/core 按真实文件大小决定是否降级为路径引用；
      // renderer 恢复 composer chip 时不应为了旧草稿里残留的超大 dataBase64 再完整解码一次。
      return {
        id: nanoid(),
        filename: attachment.filename,
        localPath: attachment.localPath,
        mimeType,
        sizeBytes: effectiveSizeBytes,
      };
    }
    // 修复原因：草稿/预填恢复也在 renderer 内执行，且历史/跨端附件的 sizeBytes 是可选字段；
    // 必须在 atob 前用 base64 长度兜底拦截超大内联图片，避免旧草稿仍产生解码内存峰值。
    throw new OversizedInlineImageAttachmentError({
      filename: attachment.filename,
      maxSizeBytes: INLINE_IMAGE_ATTACHMENT_MAX_BYTES,
      sizeBytes: effectiveSizeBytes,
    });
  }

  // video 与 image 同理由的超限拦截；有 localPath 的交给 agent 侧按真实大小降级。
  if (hasVideoBase64 && effectiveSizeBytes > VIDEO_INPUT_MAX_BYTES) {
    if (attachment.localPath) {
      return {
        id: nanoid(),
        filename: attachment.filename,
        localPath: attachment.localPath,
        mimeType,
        sizeBytes: effectiveSizeBytes,
      };
    }
    throw new OversizedInlineVideoAttachmentError({
      filename: attachment.filename,
      maxSizeBytes: VIDEO_INPUT_MAX_BYTES,
      sizeBytes: effectiveSizeBytes,
    });
  }

  if (hasPdfBase64 && effectiveSizeBytes > PROTOCOL_V4_LIMITS.attachmentMaxBytes) {
    if (attachment.localPath) {
      return {
        id: nanoid(),
        filename: attachment.filename,
        localPath: attachment.localPath,
        mimeType,
        sizeBytes: effectiveSizeBytes,
      };
    }
    throw new OversizedInlinePdfAttachmentError({
      filename: attachment.filename,
      maxSizeBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes,
      sizeBytes: effectiveSizeBytes,
    });
  }

  const bytes = decodeBase64ToBytes(attachment.dataBase64);
  const file = new File([bytes], attachment.filename, {
    type: mimeType,
  });
  return createChatComposerAttachment(file, attachment.localPath);
}

export function revokeChatComposerAttachment(attachment: ChatComposerAttachment) {
  if (attachment.objectUrl) {
    URL.revokeObjectURL(attachment.objectUrl);
  }
}

export async function serializeChatComposerAttachment(
  attachment: ChatComposerAttachment,
): Promise<ZCodePromptAttachment> {
  const mimeType = normalizeComposerMimeType(
    attachment.mimeType || inferAttachmentMimeType(attachment.filename),
  );
  if (mimeType.startsWith("image/")) {
    if (!attachment.localPath && attachment.sizeBytes > INLINE_IMAGE_ATTACHMENT_MAX_BYTES) {
      // Low-level serialization boundary: never assemble user-visible copy here;
      // throw structured errors and let the UI format them by locale, keeping English locales clean.
      throw new OversizedInlineImageAttachmentError({
        filename: attachment.filename,
        maxSizeBytes: INLINE_IMAGE_ATTACHMENT_MAX_BYTES,
        sizeBytes: attachment.sizeBytes,
      });
    }

    if (
      attachment.localPath &&
      (!attachment.file || attachment.sizeBytes > INLINE_IMAGE_ATTACHMENT_MAX_BYTES)
    ) {
      // Base64-ing large images in the renderer inflates both memory and the RPC payload.
      // With a real local path, defer to the agent image-read path which already has 20MiB thresholds.
      return {
        kind: "image",
        filename: attachment.filename,
        localPath: attachment.localPath,
        mimeType,
        sizeBytes: attachment.sizeBytes,
      };
    }

    const dataBase64 = await readAttachmentBase64(attachment);
    return {
      kind: "image",
      filename: attachment.filename,
      mimeType,
      dataBase64,
      ...(attachment.localPath ? { localPath: attachment.localPath } : {}),
      sizeBytes: attachment.sizeBytes,
    };
  }

  // video: desktop localPath is zero-copy; Web inline honors the V4 transport cap before base64.
  if (mimeType.startsWith("video/")) {
    if (attachment.localPath) {
      return {
        kind: "video",
        filename: attachment.filename,
        localPath: attachment.localPath,
        mimeType,
        sizeBytes: attachment.sizeBytes,
      };
    }
    // Without a localPath, Web used to admit video by the global product cap and only hit the V4
    // 20MiB upload boundary after full base64 encoding, wasting memory and surfacing raw protocol errors.
    if (attachment.sizeBytes > INLINE_VIDEO_ATTACHMENT_MAX_BYTES) {
      throw new OversizedInlineVideoAttachmentError({
        filename: attachment.filename,
        maxSizeBytes: INLINE_VIDEO_ATTACHMENT_MAX_BYTES,
        sizeBytes: attachment.sizeBytes,
      });
    }
    const dataBase64 = await readAttachmentBase64(attachment);
    return {
      kind: "video",
      filename: attachment.filename,
      mimeType,
      dataBase64,
      sizeBytes: attachment.sizeBytes,
    };
  }

  if (mimeType.split(";", 1)[0]?.trim().toLowerCase() === PDF_MIME_TYPE) {
    if (attachment.localPath) {
      return {
        kind: "pdf",
        filename: attachment.filename,
        localPath: attachment.localPath,
        mimeType,
        sizeBytes: attachment.sizeBytes,
      };
    }
    if (attachment.sizeBytes > PROTOCOL_V4_LIMITS.attachmentMaxBytes) {
      throw new OversizedInlinePdfAttachmentError({
        filename: attachment.filename,
        maxSizeBytes: PROTOCOL_V4_LIMITS.attachmentMaxBytes,
        sizeBytes: attachment.sizeBytes,
      });
    }
    const dataBase64 = await readAttachmentBase64(attachment);
    return {
      kind: "pdf",
      filename: attachment.filename,
      mimeType,
      dataBase64,
      sizeBytes: attachment.sizeBytes,
    };
  }

  if (attachment.localPath) {
    // Plain files used to be base64-read in the renderer before session/send,
    // costing memory and bypassing agent-side read thresholds; with a real path, send the reference only.
    return {
      kind: "file",
      filename: attachment.filename,
      localPath: attachment.localPath,
      mimeType,
      ...(attachment.sourceKind
        ? { sourceKind: attachment.sourceKind, messageCount: attachment.messageCount }
        : {}),
      sizeBytes: attachment.sizeBytes,
    };
  }

  const textContent =
    attachment.file && isTextLikeAttachment(attachment)
      ? await readAttachmentText(attachment.file)
      : undefined;
  return {
    kind: "file",
    filename: attachment.filename,
    mimeType,
    sizeBytes: attachment.sizeBytes,
    ...(textContent !== undefined ? { textContent } : {}),
    ...(attachment.sourceKind
      ? { sourceKind: attachment.sourceKind, messageCount: attachment.messageCount }
      : {}),
  };
}

async function readAttachmentBase64(attachment: ChatComposerAttachment): Promise<string> {
  if (!attachment.file) {
    throw new Error("Attachment has no readable content");
  }
  const dataUrl = await readFileAsDataUrl(attachment.file);
  const base64MarkerIndex = dataUrl.indexOf(",");
  if (base64MarkerIndex === -1) {
    throw new Error("Invalid attachment data shape");
  }
  return dataUrl.slice(base64MarkerIndex + 1);
}

export function getChatAttachmentPreviewUrl(attachment: ZCodePromptAttachment): string | null {
  if (!attachment.dataBase64) {
    return null;
  }
  return `data:${attachment.mimeType};base64,${attachment.dataBase64}`;
}

export function isImageChatComposerAttachment(attachment: ChatComposerAttachment): boolean {
  return attachment.mimeType.startsWith("image/");
}

export function isVideoChatComposerAttachment(attachment: ChatComposerAttachment): boolean {
  return attachment.mimeType.startsWith("video/");
}

export function isPdfChatComposerAttachment(attachment: ChatComposerAttachment): boolean {
  return attachment.mimeType.split(";", 1)[0]?.trim().toLowerCase() === PDF_MIME_TYPE;
}

/** Images and video form the media group: composer and timeline render them as media cards. */
export function isMediaChatComposerAttachment(attachment: ChatComposerAttachment): boolean {
  return isImageChatComposerAttachment(attachment) || isVideoChatComposerAttachment(attachment);
}

async function readAttachmentText(file: File): Promise<string> {
  const text = await file.text();
  return text.length > INLINE_TEXT_ATTACHMENT_MAX_CHARS
    ? `${text.slice(0, INLINE_TEXT_ATTACHMENT_MAX_CHARS)}\n\n[Content too long, truncated]`
    : text;
}
