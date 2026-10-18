import {
  conversationShareErrorEnvelopeSchema,
  conversationShareKnownErrorCodeSchema,
  conversationSharePreviewDataSchema,
  createConversationShareSuccessEnvelopeSchema,
  decodeConversationShareRows,
  isConversationShareSchemaVersionSupported,
  parseConversationSharePathname,
  type ConversationShareApiErrorCode,
  type ConversationSharePreview,
  type Locale,
} from "@zcode/shared";

const SHARE_CODE_PATTERN = /^[A-Za-z0-9._~-]{1,512}$/u;

export type ConversationSharePreviewErrorKind =
  | "authentication_required"
  | "not_found"
  | "expired"
  | "rate_limited"
  | "network"
  | "invalid_contract"
  | "unsupported_schema_version"
  | "unknown";

export class ConversationSharePreviewClientError extends Error {
  readonly kind: ConversationSharePreviewErrorKind;
  readonly status?: number;
  readonly code?: ConversationShareApiErrorCode;

  constructor(options: {
    kind: ConversationSharePreviewErrorKind;
    message: string;
    status?: number;
    code?: ConversationShareApiErrorCode;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ConversationSharePreviewClientError";
    this.kind = options.kind;
    this.status = options.status;
    this.code = options.code;
  }
}

export function isSafeConversationShareCode(value: string): boolean {
  return SHARE_CODE_PATTERN.test(value);
}

export function parseConversationShareRoute(pathname: string): string | null {
  const parsed = parseConversationSharePathname(pathname);
  if (!parsed) return null;
  let code: string;
  try {
    code = decodeURIComponent(parsed.rawCode);
  } catch {
    return null;
  }
  return isSafeConversationShareCode(code) ? code : null;
}

/** Page locale comes from the path prefix: /cn/share zh, bare /share en; non-share paths fall back to the browser locale. */
export function resolveConversationShareRouteLocale(pathname: string): Locale {
  const parsed = parseConversationSharePathname(pathname);
  if (parsed) return parsed.locale;
  return /^zh(?:-|$)/iu.test(navigator.language) ? "zh-CN" : "en-US";
}

export function buildShareImportDeepLink(shareCode: string): string {
  if (!isSafeConversationShareCode(shareCode)) {
    throw new TypeError("Invalid conversation share code");
  }
  return `zcode://share/import?code=${encodeURIComponent(shareCode)}`;
}

function mapErrorKind(code: ConversationShareApiErrorCode): ConversationSharePreviewErrorKind {
  switch (code) {
    case 3213:
      return "authentication_required";
    case 3211:
      return "not_found";
    case 3212:
      return "expired";
    case 3002:
      return "rate_limited";
    default:
      return "unknown";
  }
}

function mapHttpStatus(status: number): ConversationSharePreviewErrorKind {
  if (status === 401) return "authentication_required";
  if (status === 404 || status === 403) return "not_found";
  if (status === 429) return "rate_limited";
  return "unknown";
}

export interface ConversationSharePreviewClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  diagnostics?: ConversationSharePreviewDiagnostics;
}

export interface ConversationSharePreviewDiagnostics {
  info(event: string, details: Record<string, unknown>): void;
  warn(event: string, details: Record<string, unknown>): void;
}

// fetch/CORS/DNS failures must not collapse into a generic network error: whether the
// request left and which endpoint it hit matter. Logs keep sanitized targets and transport
// metadata only -- never share codes, JWTs, response bodies, or signed URLs.
const DEFAULT_DIAGNOSTICS: ConversationSharePreviewDiagnostics = {
  info(event, details) {
    console.info("[conversation-share-web]", event, details);
  },
  warn(event, details) {
    console.warn("[conversation-share-web]", event, details);
  },
};

const successEnvelopeSchema = createConversationShareSuccessEnvelopeSchema(
  conversationSharePreviewDataSchema,
);

export class ConversationSharePreviewClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly diagnostics: ConversationSharePreviewDiagnostics;

  constructor(options: ConversationSharePreviewClientOptions) {
    this.baseUrl = options.baseUrl.trim().replace(/\/+$/u, "");
    // Storing window.fetch and calling it as an instance method binds this to the Client;
    // Chromium throws Illegal invocation.
    this.fetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.diagnostics = options.diagnostics ?? DEFAULT_DIAGNOSTICS;
  }

  async getPreview(shareCode: string, accessToken?: string): Promise<ConversationSharePreview> {
    if (!isSafeConversationShareCode(shareCode)) {
      throw new ConversationSharePreviewClientError({
        kind: "invalid_contract",
        message: "Invalid conversation share code",
      });
    }

    const headers = accessToken?.trim()
      ? { Authorization: `Bearer ${accessToken.trim()}` }
      : undefined;
    const authenticated = headers !== undefined;
    const requestTarget = `${this.baseUrl}/shares/<redacted>/preview`;
    this.diagnostics.info("preview_request_started", {
      requestTarget,
      pageOrigin: globalThis.location?.origin ?? "unavailable",
      authenticated,
      shareCodeLength: shareCode.length,
    });
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/shares/${encodeURIComponent(shareCode)}/preview`,
        { method: "GET", ...(headers ? { headers } : {}) },
      );
    } catch (error) {
      const errorName = error instanceof Error ? error.name : typeof error;
      const rawErrorMessage = error instanceof Error ? error.message : String(error);
      const errorMessage = rawErrorMessage
        .replaceAll(shareCode, "<redacted>")
        .replaceAll(encodeURIComponent(shareCode), "<redacted>");
      this.diagnostics.warn("preview_request_failed", {
        requestTarget,
        authenticated,
        errorName,
        errorMessage,
      });
      throw new ConversationSharePreviewClientError({
        kind: "network",
        message: "Unable to load this conversation share",
        cause: error,
      });
    }

    this.diagnostics.info("preview_response_received", {
      requestTarget,
      authenticated,
      status: response.status,
      ok: response.ok,
      redirected: response.redirected,
      contentType: response.headers.get("content-type"),
    });

    const body = await response.text();
    if (!response.ok && !body.trim()) {
      throw new ConversationSharePreviewClientError({
        kind: mapHttpStatus(response.status),
        message: "Conversation share API failed",
        status: response.status,
      });
    }
    let payload: unknown;
    try {
      payload = JSON.parse(body) as unknown;
    } catch (error) {
      throw new ConversationSharePreviewClientError({
        kind: "invalid_contract",
        message: "Conversation share API returned invalid JSON",
        status: response.status,
        cause: error,
      });
    }

    if (!response.ok) {
      const parsedError = conversationShareErrorEnvelopeSchema.safeParse(payload);
      if (parsedError.success) {
        // Unknown business codes keep the server msg instead of failing the whole envelope into a context-free HTTP error.
        const knownCode = conversationShareKnownErrorCodeSchema.safeParse(parsedError.data.code);
        throw new ConversationSharePreviewClientError({
          kind: knownCode.success ? mapErrorKind(knownCode.data) : mapHttpStatus(response.status),
          message: parsedError.data.msg,
          status: response.status,
          ...(knownCode.success ? { code: knownCode.data } : {}),
        });
      }
      throw new ConversationSharePreviewClientError({
        kind: mapHttpStatus(response.status),
        message: "Conversation share API failed",
        status: response.status,
      });
    }

    const parsed = successEnvelopeSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ConversationSharePreviewClientError({
        kind: "invalid_contract",
        message: "Conversation share preview does not match the public contract",
        status: response.status,
        cause: parsed.error,
      });
    }
    const data = parsed.data.data;
    // Landing mirrors deploy and roll back independently, so one can be older than the client
    // that published the share. A version newer than this build means 'please upgrade',
    // not 'invalid share format'.
    if (!isConversationShareSchemaVersionSupported(data.schema_version)) {
      this.diagnostics.warn("preview_schema_version_unsupported", {
        requestTarget,
        version: data.schema_version,
      });
      throw new ConversationSharePreviewClientError({
        kind: "unsupported_schema_version",
        message: "Conversation share requires a newer ZCode version",
        status: response.status,
      });
    }
    // Degrade per row: skip and count unrecognized rows instead of failing the whole page.
    const decoded = decodeConversationShareRows(data.rows);
    if (decoded.unsupportedCount > 0) {
      this.diagnostics.info("preview_dropped_unsupported_rows", {
        requestTarget,
        kinds: decoded.unsupportedKinds,
        droppedCount: decoded.unsupportedCount,
        keptCount: decoded.rows.length,
      });
    }
    return { ...data, rows: decoded.rows, unsupportedRowCount: decoded.unsupportedCount };
  }
}
