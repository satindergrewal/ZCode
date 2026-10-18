import { basename, resolvePath } from "../deps.js";
import { READ_DEFAULT_MAX_LINES, READ_MAX_FILE_SIZE_BYTES } from "@zcode/contracts";
import type {
  FilePartSource,
  FileSystemPort,
  ImageProcessorPort,
  SessionId,
  ToolArtifactStorePort,
  TraceContext,
  TurnAttachment,
  TurnAttachmentMeta,
  TurnState,
  TurnId,
} from "../deps.js";
import { readTextFileForModel } from "../../tool/handlers/read-text.js";
import type { ResolvedTurnAttachment } from "../types.js";
import { readInlineAttachmentContent } from "./attachment-artifacts.js";
import { parseDataUrlHeader } from "./attachment-data-url.js";
import {
  resolveInlineMediaAttachment,
  resolveLocalMediaAttachment,
} from "./attachment-media-resolver.js";
import { resolvedPlaceholderAttachment } from "./attachment-placeholder.js";
import { inferImageMimeFromPath } from "./attachment-image.js";
import {
  inferAttachmentMimeFromPath,
  isDataOrArtifactUrl,
  isTextLikePath,
  resolvedInlineTextAttachment,
  resolvedPathReferenceAttachment,
} from "./attachment-path-reference.js";

type ResolveAttachmentOptions = {
  abortSignal?: AbortSignal;
  artifactStore?: ToolArtifactStorePort;
  fileSystemPort?: FileSystemPort;
  imageProcessorPort?: ImageProcessorPort;
  sessionId?: SessionId;
  traceContext: TraceContext;
  turnId?: TurnId;
  workingDirectory: string;
};

/**
 * Attachment → lightweight display metadata for the TurnStarted event (TurnAttachmentMeta).
 * Available before resolve/persist (TurnStarted precedes resolveTurnAttachments),
 * hence IO-free inference only: filename/mimeType/sizeBytes prefer protocol-passed values,
 * falling back to path basename / extension / data URL header / content length.
 */
export function summarizeTurnAttachmentsForEvent(
  attachments: TurnState["attachments"],
): TurnAttachmentMeta[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((attachment, index) => {
    const path = attachment.path;
    const fileName =
      attachment.filename ?? (path ? basename(path) : undefined) ?? `attachment-${index + 1}`;
    const dataUrlMime =
      attachment.content !== undefined
        ? parseDataUrlHeader(attachment.content)?.mediaType
        : undefined;
    const mime =
      attachment.mimeType ??
      dataUrlMime ??
      (attachment.type === "url"
        ? "text/uri-list"
        : path
          ? attachment.type === "image"
            ? inferImageMimeFromPath(path)
            : inferAttachmentMimeFromPath(path)
          : "application/octet-stream");
    const bytes =
      attachment.sizeBytes ??
      (attachment.content !== undefined ? Buffer.byteLength(attachment.content, "utf8") : 0);
    // data URL/inline content has no stable reference; path/URL serves as the display-layer reference.
    const ref =
      path && !isDataOrArtifactUrl(path)
        ? path
        : attachment.type === "url"
          ? (attachment.content ?? path)
          : undefined;
    return { fileName, mime, bytes, ...(ref ? { ref } : {}) };
  });
}

export async function resolveTurnAttachments(
  attachments: TurnState["attachments"],
  options: ResolveAttachmentOptions,
): Promise<ResolvedTurnAttachment[]> {
  const resolved: ResolvedTurnAttachment[] = [];
  for (const [index, attachment] of (attachments ?? []).entries()) {
    resolved.push(await resolveTurnAttachment(attachment, index, options));
  }
  return resolved;
}

async function resolveTurnAttachment(
  attachment: TurnAttachment,
  index: number,
  options: ResolveAttachmentOptions,
): Promise<ResolvedTurnAttachment> {
  if (attachment.type === "url") {
    const uri = attachment.content ?? attachment.path ?? `attachment-${index + 1}`;
    return {
      contentBlock: { type: "resource_link", uri },
      metadata: {
        originalUrl: uri,
        recoverability: "metadata_only",
        storageKind: "remote_ref",
      },
      mime: "text/uri-list",
      url: uri,
    };
  }

  if (
    attachment.content &&
    (attachment.sourceKind === "topic-history" || attachment.sourceKind === "clipboard-text")
  ) {
    // Uploaded text material lands inside the owning runtime; never decode-and-inject it as body, and never use Host-local paths.
    const inline = await readInlineAttachmentContent(attachment, options);
    const write = options.artifactStore?.writeToolResultBinaryArtifact?.bind(options.artifactStore);
    if (!inline || !write || !options.sessionId)
      throw new Error("Text attachment materialization unavailable");
    const encoded = /^data:text\/plain(?:;charset=utf-8)?;base64,([A-Za-z0-9+/]*={0,2})$/.exec(
      inline.dataUrl,
    );
    if (!encoded) throw new Error("Invalid text attachment encoding");
    const data = Buffer.from(encoded[1]!, "base64");
    const file = await write(
      {
        sessionId: options.sessionId,
        turnId: options.turnId,
        trace: options.traceContext,
        toolCallId: `text-attachment-${index}`,
        toolName: "prompt-attachment:text",
        content: data,
        contentType: "text/plain",
        extension: "txt",
        retention: "session",
      },
      { signal: options.abortSignal },
    );
    if (!file.path) throw new Error("Text attachment path unavailable");
    return resolvedPathReferenceAttachment({ ...attachment, path: file.path }, file.path, {
      filename: attachment.filename,
      mime: "text/plain",
      sizeBytes: data.length,
      reason:
        attachment.sourceKind === "topic-history"
          ? "deferred_topic_history"
          : "deferred_clipboard_text",
    });
  }
  if (attachment.content) {
    if (attachment.type === "pdf" && !isDataOrArtifactUrl(attachment.content)) {
      // PDFs once rode the plain-file inline text branch, letting corrupted or fabricated bodies pass UTF-8
      // decoding into the provider; PDFs must take only data URLs or artifact URIs and degrade explicitly before the request.
      return resolvedPlaceholderAttachment(
        attachment,
        attachment.path ?? `attachment-${index + 1}`,
        "attachment_pdf_invalid",
        {
          filename: attachment.filename,
          mime: "application/pdf",
          sizeBytes: attachment.sizeBytes,
        },
      );
    }
    if (attachment.type !== "image" && !isDataOrArtifactUrl(attachment.content)) {
      return resolvedInlineTextAttachment(attachment, index);
    }

    const inline = await readInlineAttachmentContent(attachment, options);
    if (!inline) {
      const placeholder = attachment.path ?? `attachment-${index + 1}`;
      return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_read_failed");
    }
    return await resolvedInlineAttachment({ ...attachment, content: inline.dataUrl }, index, {
      ...options,
      existingArtifactUri: inline.artifactUri,
    });
  }

  const fileSystemPort = options.fileSystemPort;
  if (attachment.path && fileSystemPort) {
    if (attachment.type === "image" || attachment.type === "video" || attachment.type === "pdf") {
      return await resolveLocalMediaAttachment(attachment, index, {
        ...options,
        fileSystemPort,
      });
    }
    return await resolveLocalFileAttachment(attachment, {
      ...options,
      fileSystemPort,
    });
  }

  const placeholder = attachment.path ?? `attachment-${index + 1}`;
  return resolvedPlaceholderAttachment(attachment, placeholder, "attachment_read_failed");
}

async function resolvedInlineAttachment(
  attachment: TurnAttachment,
  index: number,
  options: {
    abortSignal?: AbortSignal;
    artifactStore?: ToolArtifactStorePort;
    existingArtifactUri?: string;
    imageProcessorPort?: ImageProcessorPort;
    sessionId?: SessionId;
    traceContext: TraceContext;
    turnId?: TurnId;
  },
): Promise<ResolvedTurnAttachment> {
  const parsed = attachment.content?.startsWith("data:")
    ? parseDataUrlHeader(attachment.content)
    : undefined;
  const media = await resolveInlineMediaAttachment(attachment, index, parsed?.mediaType, options);
  if (media) return media;

  const content = attachment.content ?? "";
  return {
    contentBlock: { type: "text", text: content },
    metadata: {
      originalUrl: attachment.path ?? attachment.content,
      preview: {
        text: content,
        truncated: false,
        originalBytes: Buffer.byteLength(content, "utf8"),
      },
      recoverability: "provider_ready",
      sizeBytes: Buffer.byteLength(content, "utf8"),
      storageKind: "inline",
    },
    mime: parsed?.mediaType ?? (attachment.type === "image" ? "image/*" : "text/plain"),
    url: attachment.content ?? "",
  };
}

async function resolveLocalFileAttachment(
  attachment: TurnAttachment,
  options: {
    abortSignal?: AbortSignal;
    fileSystemPort: FileSystemPort;
    traceContext: TraceContext;
    workingDirectory: string;
  },
): Promise<ResolvedTurnAttachment> {
  const absolutePath = resolvePath(options.workingDirectory, attachment.path!);
  const filename = basename(absolutePath);
  const mime = "text/plain";
  const source: FilePartSource = {
    type: "file",
    path: absolutePath,
    text: { value: attachment.path!, start: 0, end: attachment.path!.length },
  };

  try {
    const stat = await options.fileSystemPort.stat(
      { path: absolutePath, trace: options.traceContext },
      { signal: options.abortSignal },
    );
    if (stat.kind !== "file") {
      return resolvedPlaceholderAttachment(attachment, attachment.path!, "attachment_not_file", {
        filename,
        mime,
        sizeBytes: stat.sizeBytes,
        source,
      });
    }

    if (!isTextLikePath(absolutePath)) {
      // Suspected binaries must not be read into the prompt as text; hand over a path reference for later tools.
      return resolvedPathReferenceAttachment(attachment, attachment.path!, {
        filename,
        mime: inferAttachmentMimeFromPath(absolutePath),
        sizeBytes: stat.sizeBytes,
        source,
        reason: "binary_file",
      });
    }

    if (attachment.sourceKind === "clipboard-text" || attachment.sourceKind === "topic-history") {
      // Long pastes already spilled to a temp file; pre-reading would stuff the body back into the prompt_attachment system hint.
      // Deliver only the real local-attachment reference; the model pulls it in via file-read tools when actually needed.
      return resolvedPathReferenceAttachment(attachment, attachment.path!, {
        filename,
        mime,
        sizeBytes: stat.sizeBytes,
        source,
        reason:
          attachment.sourceKind === "topic-history"
            ? "deferred_topic_history"
            : "deferred_clipboard_text",
      });
    }

    const isOversizedText = stat.sizeBytes > READ_MAX_FILE_SIZE_BYTES;
    const read = await readTextFileForModel({
      abortSignal: options.abortSignal,
      filePath: absolutePath,
      fileSystemPort: options.fileSystemPort,
      ...(isOversizedText
        ? {
            allowPartialFallback: true,
            limit: READ_DEFAULT_MAX_LINES,
            offset: 1,
          }
        : {}),
      trace: options.traceContext,
    });
    return {
      contentBlock: { type: "text", text: read.content },
      filename,
      metadata: {
        originalUrl: attachment.path,
        preview: {
          text: read.content,
          truncated: read.truncated ?? false,
          ...(read.sizeBytes !== undefined ? { originalBytes: read.sizeBytes } : {}),
          startLine: read.startLine,
          totalLines: read.totalLines,
          ...(read.truncatedByTokenCap !== undefined
            ? { truncatedByTokenCap: read.truncatedByTokenCap }
            : {}),
          ...(read.partialViewNotice !== undefined
            ? { partialViewNotice: read.partialViewNotice }
            : {}),
        },
        recoverability: read.truncated ? "preview_only" : "provider_ready",
        ...(read.sizeBytes !== undefined ? { sizeBytes: read.sizeBytes } : {}),
        storageKind: "inline",
      },
      mime: "text/plain",
      source,
      url: attachment.path!,
    };
  } catch {
    return resolvedPlaceholderAttachment(attachment, attachment.path!, "attachment_read_failed", {
      filename,
      mime,
      source,
    });
  }
}

export { parseDataUrlHeader } from "./attachment-data-url.js";
export { inferImageMimeFromPath, prepareImageDataUrl } from "./attachment-image.js";
