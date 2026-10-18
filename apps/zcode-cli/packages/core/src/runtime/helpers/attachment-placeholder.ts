import type { FilePartSource, TurnAttachment } from "../deps.js";
import type { ResolvedTurnAttachment } from "../types.js";
import { safeAttachmentOriginalRef } from "./attachment-artifacts.js";

export function resolvedPlaceholderAttachment(
  attachment: TurnAttachment,
  placeholder: string,
  errorCode: string,
  options: {
    filename?: string;
    mime?: string;
    sizeBytes?: number;
    source?: FilePartSource;
  } = {},
): ResolvedTurnAttachment {
  const mime =
    options.mime ??
    (attachment.type === "image"
      ? "image/*"
      : attachment.type === "pdf"
        ? "application/pdf"
        : "text/plain");
  const safeOriginalRef = safeAttachmentOriginalRef(attachment);
  return {
    contentBlock: { type: "text", text: `[Attached ${mime}: ${placeholder}]` },
    filename: options.filename,
    metadata: {
      errorCode,
      originalUrl: safeOriginalRef,
      recoverability: "metadata_only",
      sizeBytes: options.sizeBytes,
      storageKind: attachment.path ? "local_ref" : "metadata_only",
    },
    mime,
    source: options.source,
    // Invalid media data URLs degrade to placeholder text, but the file part's url field used to leak
    // the base64 body into the session. A PDF must not write a data URL into part.data; a recoverable artifact
    // URI stays for later diagnosis and retry via the sanctioned grant path.
    url:
      attachment.type === "video" || attachment.type === "pdf"
        ? attachment.content?.startsWith("zcode-artifact://")
          ? attachment.content
          : (attachment.path ??
            (attachment.type === "pdf" ? "inline:pdf" : (safeOriginalRef ?? "")))
        : (attachment.path ?? attachment.content ?? ""),
  };
}
