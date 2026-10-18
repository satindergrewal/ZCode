// Structured error codes for attachment read/probe (the classification basis of share precheck and publish).
//
// Share precheck once distinguished missing / unauthorized / other by `error.message` regexes.
 // Any RPC-layer wrap, localization, or message replacement (e.g. ZodError on schema failure) kills the classification
 // and degrades a definite verdict into deferred. Repo discipline (AGENTS.md "never branch on error text")
 // demands stable codes; this module is that contract's single source.
//
// Wire path: CLI-side Errors carry a `code` field; `toProtocolError` passes string codes into JSON-RPC
// error.data.code; clients read them back via readZCodeAttachmentFaultCode.

export const ZCODE_ATTACHMENT_FAULT_CODES = {
  /// Host does not implement stat.
  statUnsupported: "fault.attachment.statUnsupported",
  /// Host does not implement read.
  readUnsupported: "fault.attachment.readUnsupported",
  /// The ref's path exists but is not a regular file.
  statNotFile: "fault.attachment.statNotFile",
  /// The share-stat row/ref is not in the current session projection; unauthorized.
  shareStatNotAuthorized: "fault.attachment.shareStatNotAuthorized",
  /// The share-read row/ref is not in the current session projection; unauthorized.
  shareReadNotAuthorized: "fault.attachment.shareReadNotAuthorized",
  /// The share-stat connection is untrusted.
  shareStatConnectionUntrusted: "fault.attachment.shareStatConnectionUntrusted",
  /// The share-read connection is untrusted.
  shareReadConnectionUntrusted: "fault.attachment.shareReadConnectionUntrusted",
  /// The attachment vanished from disk (ENOENT and other definite absences).
  shareStatNotFound: "fault.attachment.shareStatNotFound",
  /// The real size exceeds what the stat protocol can express.
  shareStatTooLarge: "fault.attachment.shareStatTooLarge",
  /// Bytes exceed the preview/read channel cap; cannot be carried.
  previewTooLarge: "fault.attachment.previewTooLarge",
  /// The read result is not a previewable media type.
  previewNotMedia: "fault.attachment.previewNotMedia",
} as const;

export type ZCodeAttachmentFaultCode =
  (typeof ZCODE_ATTACHMENT_FAULT_CODES)[keyof typeof ZCODE_ATTACHMENT_FAULT_CODES];

const KNOWN_FAULT_CODES = new Set<string>(Object.values(ZCODE_ATTACHMENT_FAULT_CODES));

export function isZCodeAttachmentFaultCode(value: unknown): value is ZCodeAttachmentFaultCode {
  return typeof value === "string" && KNOWN_FAULT_CODES.has(value);
}

/**
 * Attachment error with a stable code. `code` is a string; `toProtocolError` puts it into JSON-RPC
 * error.data.code, so both in-process and cross-process can classify by code.
 */
export class ZCodeAttachmentFaultError extends Error {
  readonly code: ZCodeAttachmentFaultCode;

  constructor(code: ZCodeAttachmentFaultCode, options?: { cause?: unknown; message?: string }) {
    // The message defaults to the fault code itself, so legacy clients' text matching still hits.
    super(
      options?.message ?? code,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ZCodeAttachmentFaultError";
    this.code = code;
  }
}

/**
 * Read the attachment fault code from any error:
 * - in-process ZCodeAttachmentFaultError / Error with code;
 * - `error.data.code` returned over JSON-RPC;
 * - legacy-CLI compat fallback via message text (see below).
 */
export function readZCodeAttachmentFaultCode(error: unknown): ZCodeAttachmentFaultCode | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; data?: unknown };
  if (isZCodeAttachmentFaultCode(candidate.code)) return candidate.code;
  if (candidate.data && typeof candidate.data === "object") {
    const data = candidate.data as { code?: unknown };
    if (isZCodeAttachmentFaultCode(data.code)) return data.code;
  }
  // Compat fallback: desktops may face legacy zcode-cli without structured codes. Hits only when the message equals
  // a fault code exactly--no fuzzy matching, so wrapped arbitrary text never counts as a definite class.
  if (error instanceof Error && isZCodeAttachmentFaultCode(error.message)) return error.message;
  return undefined;
}
