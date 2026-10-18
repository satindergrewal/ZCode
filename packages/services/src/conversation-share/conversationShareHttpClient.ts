/* oxlint-disable eslint(max-lines) -- one method per endpoint plus shared auth/sanitization/error normalization in requestData; splitting would fragment the HTTP contract. */
import {
  conversationShareArtifactDescriptorSchema,
  conversationShareArtifactUploadDataSchema,
  conversationShareCapabilitiesWireSchema,
  narrowConversationShareCapabilities,
  conversationShareConfirmDataSchema,
  conversationShareConfirmRequestSchema,
  conversationShareContinuationDataSchema,
  conversationShareContinuationRequestSchema,
  conversationShareErrorEnvelopeSchema,
  conversationShareKnownErrorCodeSchema,
  conversationSharePreparationDataSchema,
  conversationSharePreparationRequestSchema,
  conversationSharePreviewDataSchema,
  createConversationShareSuccessEnvelopeSchema,
  decodeConversationShareRows,
  isConversationShareSchemaVersionSupported,
  type ApiClient,
  type ApiRequestInit,
  type ConversationShareApiErrorCode,
  type ConversationShareArtifactDescriptor,
  type ConversationShareArtifactUpload,
  type ConversationShareCapabilities,
  type ConversationShareConfirmRequest,
  type ConversationShareContinuation,
  type ConversationShareContinuationRequest,
  type ConversationSharePreparation,
  type ConversationSharePreparationRequest,
  type ConversationSharePreview,
  type ConversationShareRecord,
} from "@zcode/shared";
import type { z } from "zod";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { REQUEST_ID_HEADER_NAME, withRequestIdHeader } from "../providers/api/requestIdHeaders.js";
import { verifyConversationShareIntegrity } from "./conversationShareIntegrity.js";

const log = createServiceLogger("conversation-share-http");

export type ConversationShareClientErrorKind =
  | "authentication_required"
  | "feature_disabled"
  | "invalid_contract"
  | "invalid_conversation"
  | "disclosure_required"
  | "unsafe_structure"
  | "artifact_not_allowed"
  | "limit_exceeded"
  | "upload_incomplete"
  | "not_found"
  | "expired"
  | "import_not_allowed"
  | "rate_limited"
  | "network"
  | "safety_check_pending"
  | "unsupported_schema_version"
  | "unknown";

export class ConversationShareClientError extends Error {
  readonly kind: ConversationShareClientErrorKind;
  readonly status?: number;
  readonly code?: ConversationShareApiErrorCode;
  /** Server request id, for reconciling against backend logs. */
  readonly requestId?: string;
  /** Reuses the RPC details field to carry security diagnostics to the renderer. */
  readonly details?: {
    requestId?: string;
    clientRequestId?: string;
    status?: number;
    code?: number;
  };
  declare readonly retryAfterMs?: number;

  constructor(options: {
    kind: ConversationShareClientErrorKind;
    message: string;
    status?: number;
    code?: ConversationShareApiErrorCode;
    retryAfterMs?: number;
    requestId?: string;
    clientRequestId?: string;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ConversationShareClientError";
    this.kind = options.kind;
    this.status = options.status;
    this.code = options.code;
    const requestId = options.requestId?.trim();
    if (requestId && /^[A-Za-z0-9._:-]{1,128}$/u.test(requestId)) {
      this.requestId = requestId;
    }
    const clientRequestId = normalizeRequestId(options.clientRequestId);
    if (
      this.requestId ||
      clientRequestId ||
      options.status !== undefined ||
      options.code !== undefined
    ) {
      this.details = {
        ...(this.requestId ? { requestId: this.requestId } : {}),
        ...(clientRequestId ? { clientRequestId } : {}),
        ...(options.status === undefined ? {} : { status: options.status }),
        ...(options.code === undefined ? {} : { code: options.code }),
      };
    }
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

const ERROR_KIND_BY_CODE: Record<ConversationShareApiErrorCode, ConversationShareClientErrorKind> =
  {
    3001: "invalid_contract",
    3002: "rate_limited",
    3200: "feature_disabled",
    3201: "authentication_required",
    3203: "invalid_contract",
    3204: "invalid_contract",
    3205: "invalid_conversation",
    3206: "disclosure_required",
    3207: "unsafe_structure",
    3208: "artifact_not_allowed",
    3209: "limit_exceeded",
    3210: "upload_incomplete",
    3211: "not_found",
    3212: "expired",
    3213: "authentication_required",
    3214: "import_not_allowed",
    3215: "safety_check_pending",
  };

const IMF_FIXDATE_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (?:0[1-9]|[12]\d|3[01]) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d GMT$/u;
const RFC_850_DATE_PATTERN =
  /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (?:0[1-9]|[12]\d|3[01])-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d GMT$/u;
const ASCTIME_DATE_PATTERN =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: [1-9]|0[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d \d{4}$/u;
const HTTP_WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const HTTP_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function formatHttpTime(date: Date): string {
  return [date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function parseHttpDate(value: string): number | undefined {
  if (IMF_FIXDATE_PATTERN.test(value)) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toUTCString() === value
      ? timestamp
      : undefined;
  }
  if (RFC_850_DATE_PATTERN.test(value)) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return undefined;
    const date = new Date(timestamp);
    const canonical = `${HTTP_WEEKDAYS[date.getUTCDay()]}, ${String(date.getUTCDate()).padStart(2, "0")}-${HTTP_MONTHS[date.getUTCMonth()]}-${String(date.getUTCFullYear()).slice(-2)} ${formatHttpTime(date)} GMT`;
    return canonical === value ? timestamp : undefined;
  }
  if (ASCTIME_DATE_PATTERN.test(value)) {
    const timestamp = Date.parse(`${value} GMT`);
    if (!Number.isFinite(timestamp)) return undefined;
    const date = new Date(timestamp);
    const canonical = `${date.toUTCString().slice(0, 3)} ${HTTP_MONTHS[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, " ")} ${formatHttpTime(date)} ${date.getUTCFullYear()}`;
    return canonical === value ? timestamp : undefined;
  }
  return undefined;
}

function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (/^\d+$/u.test(normalized)) {
    const delayMs = Number(normalized) * 1_000;
    return Number.isSafeInteger(delayMs) && delayMs > 0 ? delayMs : undefined;
  }
  // Date.parse accepts localized dates and normalizes invalid ones; enforce strict HTTP-date syntax first.
  const retryAt = parseHttpDate(normalized);
  if (retryAt === undefined) return undefined;
  const delayMs = retryAt - now;
  return delayMs > 0 ? delayMs : undefined;
}

const DEFAULT_TIMEOUT_MS = 30_000;
// The server runs security checks inline during confirm, easily exceeding 30s per request (50s+ aborts observed). Widen only
// this endpoint; a global 2min would stall capability discovery offline too. Unrelated to the confirmUntilReady poll timeout,
// which covers retries after a pending response and cannot rescue the request itself.
const CONFIRM_TIMEOUT_MS = 120_000;
// uploadArtifact cannot keep the 30s default: confirm alone hangs 50s+, and larger
// artifacts blow through it on slow uplinks with no retry, failing the whole publish. Scale the timeout by size:
// 30s connect/process margin plus a 128KB/s uplink floor, never below the global default (small files keep it).
const UPLOAD_TIMEOUT_BASE_MS = 30_000;
const UPLOAD_MIN_THROUGHPUT_BYTES_PER_SEC = 128 * 1024;

function computeUploadTimeoutMs(fileSizeBytes: number, floorMs: number): number {
  return Math.max(
    floorMs,
    UPLOAD_TIMEOUT_BASE_MS + Math.ceil(fileSizeBytes / UPLOAD_MIN_THROUGHPUT_BYTES_PER_SEC) * 1_000,
  );
}

function normalizeRequestId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^[A-Za-z0-9._:-]{1,128}$/u.test(trimmed) ? trimmed : undefined;
}

export interface ConversationShareHttpClientOptions {
  apiClient: ApiClient;
  baseUrl: string;
  tokenProvider: () => Promise<string | null>;
  timeoutMs?: number;
  /** Per-request confirm timeout; 2min default. */
  confirmTimeoutMs?: number;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/${path.replace(/^\/+/, "")}`;
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

export class ConversationShareHttpClient {
  private readonly apiClient: ApiClient;
  private readonly baseUrl: string;
  private readonly tokenProvider: () => Promise<string | null>;
  private readonly timeoutMs: number;
  private readonly confirmTimeoutMs: number;

  constructor(options: ConversationShareHttpClientOptions) {
    this.apiClient = options.apiClient;
    this.baseUrl = options.baseUrl;
    this.tokenProvider = options.tokenProvider;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS;
  }

  async getCapabilities(): Promise<ConversationShareCapabilities> {
    const wire = await this.requestData(
      "/shares/capabilities",
      { method: "GET" },
      conversationShareCapabilitiesWireSchema,
      "required",
    );
    const { capabilities, unsupportedArtifactTypes, unsupportedAccessModes } =
      narrowConversationShareCapabilities(wire);
    if (unsupportedArtifactTypes.length > 0 || unsupportedAccessModes.length > 0) {
      // When the backend adds artifact types/access modes, keep a searchable record: discovery survives,
      // but we still learn which case to add.
      log.info(undefined, "conversation share capabilities dropped unsupported values", {
        types: unsupportedArtifactTypes,
        accessModes: unsupportedAccessModes,
        supportedCount: capabilities.allowed_artifacts.length,
      });
    }
    return capabilities;
  }

  createPreparation(
    input: ConversationSharePreparationRequest,
  ): Promise<ConversationSharePreparation> {
    const body = conversationSharePreparationRequestSchema.parse(input);
    return this.requestData(
      "/shares/preparations",
      this.jsonRequest("POST", body),
      conversationSharePreparationDataSchema,
      "required",
    );
  }

  uploadArtifact(
    preparationId: string,
    descriptor: ConversationShareArtifactDescriptor,
    file: Blob,
  ): Promise<ConversationShareArtifactUpload> {
    const parsedDescriptor = conversationShareArtifactDescriptorSchema.parse(descriptor);
    // Privacy boundary: log only public ids, types, and byte counts, never descriptors, filenames, paths, bodies, or auth headers.
    log.debug(undefined, "conversation share artifact upload prepared", {
      preparationId,
      artifactId: parsedDescriptor.artifact_id,
      artifactType: parsedDescriptor.artifact_type,
      fileSizeBytes: file.size,
    });
    const form = new FormData();
    form.append("descriptor", JSON.stringify(parsedDescriptor));
    form.append("file", file, parsedDescriptor.display_name);
    return this.requestData(
      `/shares/preparations/${encodeURIComponent(preparationId)}/artifacts`,
      { method: "POST", body: form },
      conversationShareArtifactUploadDataSchema,
      "required",
      computeUploadTimeoutMs(file.size, this.timeoutMs),
    );
  }

  confirm(
    preparationId: string,
    input: ConversationShareConfirmRequest,
  ): Promise<ConversationShareRecord> {
    const body = conversationShareConfirmRequestSchema.parse(input);
    return this.requestData(
      `/shares/preparations/${encodeURIComponent(preparationId)}/confirm`,
      this.jsonRequest("POST", body),
      conversationShareConfirmDataSchema,
      "required",
      this.confirmTimeoutMs,
    );
  }

  async getPreview(shareCode: string): Promise<ConversationSharePreview> {
    const wire = await this.requestData(
      `/shares/${encodeURIComponent(shareCode)}/preview`,
      { method: "GET" },
      conversationSharePreviewDataSchema,
      "optional",
    );
    this.assertSupportedSchemaVersion(wire.schema_version, "preview");
    const decoded = this.decodeRows(wire.rows, "preview");
    return { ...wire, rows: decoded.rows, unsupportedRowCount: decoded.unsupportedCount };
  }

  async getContinuation(
    shareCode: string,
    input: ConversationShareContinuationRequest,
  ): Promise<ConversationShareContinuation> {
    const body = conversationShareContinuationRequestSchema.parse(input);
    const wire = await this.requestData(
      `/shares/${encodeURIComponent(shareCode)}/continuation`,
      this.jsonRequest("POST", body),
      conversationShareContinuationDataSchema,
      // public_importable continuations authorize via share code + client request id,
      // so a signed-out ZCode must not block the request client-side before it is sent.
      "optional",
    );
    this.assertSupportedSchemaVersion(wire.schema_version, "continuation");
    // Integrity checks run against server-verbatim values, not parse output; an added optional field would
    // otherwise change every old client\x27s hash (see verifyConversationShareIntegrity).
    if (
      !verifyConversationShareIntegrity({
        rawRows: wire.rows,
        rawArtifacts: wire.artifacts,
        integrity: wire.integrity,
      })
    ) {
      throw new ConversationShareClientError({
        kind: "invalid_contract",
        message: "Conversation share integrity check failed",
      });
    }
    const decoded = this.decodeRows(wire.rows, "continuation");
    return {
      ...wire,
      rows: decoded.rows,
      rawRows: wire.rows,
      unsupportedRowCount: decoded.unsupportedCount,
    };
  }

  /**
   * Never guess semantics for newer versions nor file them under invalid_contract: users should see "update ZCode",
   * not "invalid share format". Older/equal versions always proceed; new kinds/enums degrade per row.
   */
  private assertSupportedSchemaVersion(version: number, endpoint: string): void {
    if (isConversationShareSchemaVersionSupported(version)) return;
    log.warn(undefined, "conversation share payload schema version is newer than this client", {
      endpoint,
      version,
    });
    throw new ConversationShareClientError({
      kind: "unsupported_schema_version",
      message: "Conversation share payload requires a newer ZCode version",
    });
  }

  private decodeRows(
    rows: readonly unknown[],
    endpoint: string,
  ): ReturnType<typeof decodeConversationShareRows> {
    const decoded = decodeConversationShareRows(rows);
    if (decoded.unsupportedCount > 0) {
      // No silent drops: unrecognized rows vanish from the render, so record which row kind needs support.
      log.info(undefined, "conversation share dropped rows this client cannot render", {
        endpoint,
        kinds: decoded.unsupportedKinds,
        droppedCount: decoded.unsupportedCount,
        keptCount: decoded.rows.length,
      });
    }
    return decoded;
  }

  private jsonRequest(method: "POST", body: unknown): ApiRequestInit {
    return {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    };
  }

  private async requestData<T>(
    path: string,
    init: ApiRequestInit,
    dataSchema: z.ZodType<T>,
    auth: "required" | "optional",
    timeoutMsOverride?: number,
  ): Promise<T> {
    const token = (await this.tokenProvider())?.trim() || null;
    if (auth === "required" && !token) {
      throw new ConversationShareClientError({
        kind: "authentication_required",
        message: "Conversation share authentication required",
        status: 401,
      });
    }

    // ApiClient injects a request id as fallback; generate and keep one here so non-standard ApiClients
    // (remote host facades, test doubles) can still correlate request ids with server responses.
    const headers = withRequestIdHeader(init.headers);
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const url = joinUrl(this.baseUrl, path);
    const clientRequestId = normalizeRequestId(headers.get(REQUEST_ID_HEADER_NAME));
    let response: Response;
    try {
      response = await this.apiClient.request(url, {
        ...init,
        headers: Object.fromEntries(headers.entries()),
        timeoutMs: timeoutMsOverride ?? this.timeoutMs,
      });
    } catch (error) {
      if (error instanceof ConversationShareClientError) throw error;
      throw new ConversationShareClientError({
        clientRequestId,
        kind: "network",
        message: error instanceof Error ? error.message : "Conversation share network error",
        cause: error,
      });
    }

    const responseRequestId = normalizeRequestId(response.headers.get(REQUEST_ID_HEADER_NAME));
    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      // Headers arrived, so a body read abort is still a network error; keep status and request id instead of unknown.
      log.warn(undefined, "conversation share response body interrupted", {
        path,
        method: init.method ?? "GET",
        status: response.status,
        requestId: responseRequestId,
        clientRequestId,
      });
      throw new ConversationShareClientError({
        clientRequestId,
        kind: "network",
        message: "Conversation share response body interrupted",
        status: response.status,
        requestId: responseRequestId,
        cause,
      });
    }
    if (!response.ok) {
      const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
      log.warn(undefined, "conversation share HTTP response diagnostics", {
        path,
        method: init.method ?? "GET",
        status: response.status,
        requestId: responseRequestId,
        clientRequestId,
        responseBytes: new TextEncoder().encode(text).byteLength,
        mediaType:
          mediaType && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/iu.test(mediaType) ? mediaType : "unknown",
        responseFormat: /^\s*</u.test(text) ? "html" : "other",
        redirected: response.redirected,
      });
      if (response.status === 401 && !text.trim()) {
        throw new ConversationShareClientError({
          clientRequestId,
          kind: "authentication_required",
          message: "Conversation share authentication required",
          status: 401,
          requestId: responseRequestId,
        });
      }
      let parsedError: ReturnType<typeof conversationShareErrorEnvelopeSchema.safeParse> | null =
        null;
      if (text.trim()) {
        try {
          parsedError = conversationShareErrorEnvelopeSchema.safeParse(parseJson(text));
        } catch {
          // Root cause: LB/gateway 502/504 HTML error pages are not JSON and used to classify as
          // invalid_contract, misleading debugging and user copy. Non-JSON on 5xx is an infrastructure fault;
          // classify network; only 2xx-4xx non-JSON can count as a contract violation.
          if (response.status >= 500) {
            log.warn(undefined, "conversation share API upstream unavailable", {
              path,
              method: init.method ?? "GET",
              status: response.status,
              requestId: responseRequestId,
            });
            throw new ConversationShareClientError({
              clientRequestId,
              kind: "network",
              message: `Conversation share API upstream failed with HTTP ${response.status}`,
              status: response.status,
              ...(responseRequestId === undefined ? {} : { requestId: responseRequestId }),
            });
          }
          log.warn(undefined, "conversation share API returned invalid JSON", {
            path,
            method: init.method ?? "GET",
            status: response.status,
            requestId: responseRequestId,
          });
          throw new ConversationShareClientError({
            clientRequestId,
            kind: "invalid_contract",
            message: "Conversation share API returned invalid JSON",
            status: response.status,
            ...(responseRequestId === undefined ? {} : { requestId: responseRequestId }),
          });
        }
      }
      if (parsedError?.success) {
        // Unknown business codes no longer fail the whole envelope (that discarded the server msg for a context-free
        // bare "HTTP 4xx"). Known codes keep their mapping; unknown ones become unknown with msg and status kept.
        const knownCode = conversationShareKnownErrorCodeSchema.safeParse(parsedError.data.code);
        const code = knownCode.success ? knownCode.data : undefined;
        const kind = code === undefined ? "unknown" : ERROR_KIND_BY_CODE[code];
        const retryAfterMs =
          code === 3215 ? parseRetryAfterMs(response.headers.get("retry-after")) : undefined;
        log.warn(undefined, "conversation share API request rejected", {
          path,
          method: init.method ?? "GET",
          status: response.status,
          kind,
          code: parsedError.data.code,
          requestId: responseRequestId,
        });
        throw new ConversationShareClientError({
          clientRequestId,
          kind,
          message: parsedError.data.msg,
          status: response.status,
          ...(code === undefined ? {} : { code }),
          requestId: responseRequestId,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        });
      }
      log.warn(undefined, "conversation share API request rejected", {
        path,
        method: init.method ?? "GET",
        status: response.status,
        requestId: responseRequestId,
      });
      // Fallback when the body is empty or not an error envelope: 5xx is infrastructure (network),
      // never unknown/invalid_contract; 429 stays rate_limited, other envelope-less bodies count as contract faults.
      throw new ConversationShareClientError({
        clientRequestId,
        kind:
          response.status >= 500
            ? "network"
            : response.status === 429
              ? "rate_limited"
              : "invalid_contract",
        message: `Conversation share API failed with HTTP ${response.status}`,
        status: response.status,
        ...(responseRequestId === undefined ? {} : { requestId: responseRequestId }),
      });
    }

    try {
      const envelope = createConversationShareSuccessEnvelopeSchema(dataSchema).parse(
        parseJson(text),
      );
      return envelope.data;
    } catch (error) {
      if (error instanceof ConversationShareClientError) throw error;
      throw new ConversationShareClientError({
        clientRequestId,
        kind: "invalid_contract",
        message: "Conversation share API response does not match the client contract",
        status: response.status,
        ...(responseRequestId === undefined ? {} : { requestId: responseRequestId }),
      });
    }
  }
}
