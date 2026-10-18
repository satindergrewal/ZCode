/* Official-server MCP: per-request dynamic identity header injection and failure classification.
 *
 * The single credential egress: wraps the fetch from createMcpTransportFetch, injecting after the SDK builds
 * _commonHeaders() and requestInit, right before the request is sent. Existing HTTP proxy, custom CA and
 * no-proxy policy are all preserved: this wrapper wraps, never bypasses.
 */
import {
  findOfficialMcpReservedHeaders,
  isOfficialMcpReservedHeaderName,
  summarizeOfficialMcpIdentityHeaders,
  type McpServerFailureKind,
  type OfficialMcpAuthFailureKind,
} from "@zcode/shared";
import type {
  Logger,
  McpOfficialProvenance,
  OfficialMcpAuthHeadersPort,
  OfficialMcpTrustedOriginRegistry,
} from "@zcode/contracts";

/** Official auth error thrown by the adapter with a stable class; callers must never branch on message text. */
export class OfficialMcpAuthError extends Error {
  constructor(
    readonly kind: OfficialMcpAuthFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "OfficialMcpAuthError";
  }
}

/**
 * Correlation-id header names.
 *
 * Two uses, neither is sending:
 * 1. strip from request headers, so plugin static config cannot inject these observability channels at official endpoints;
 * 2. read the server-generated request id from response headers for end-to-end reconciliation logs.
 *
 * The client never sends them: the server always mints its own request ids and ignores inbound values.
 */
const REQUEST_ID_HEADER = "x-request-id";
const TRACE_ID_HEADER = "x-trace-id";

interface CreateOfficialMcpAuthFetchInput {
  authHeadersPort?: OfficialMcpAuthHeadersPort;
  baseFetch: typeof globalThis.fetch;
  logger?: Logger;
  /**
   * Classification report hook. SDK version negotiation re-wraps OfficialMcpAuthError as a plain Error
   * (message kept, identity lost), so instanceof is unreliable above this layer.
   * Classification must be reported at the throw site, never by parsing text (project rule: no branching on error text).
   */
  onAuthFailure?: (kind: OfficialMcpAuthFailureKind) => void;
  /**
   * Report hook for the server request id, to correlate it back to one tools/call.
   *
   * Only this layer sees response headers: above it sits the MCP SDK, which hands the adapter JSON-RPC results only.
   * So an in-band failure (HTTP 200 + isError, e.g. quota exhausted) can carry the request id only if
   * this layer emits it, for the adapter to join by span.
   */
  onServerResponse?: (response: OfficialMcpServerResponseInfo) => void;
  official: McpOfficialProvenance;
  serverName: string;
  trustedOrigins: OfficialMcpTrustedOriginRegistry;
  /** MCP endpoint URL; Origin is validated per request URL, not once at connect. */
  url: string;
  workspaceIdentity?: string;
  workspacePath?: string;
}

/** Non-sensitive correlatable facts of one official MCP response. No body, no header values. */
export interface OfficialMcpServerResponseInfo {
  failureKind?: McpServerFailureKind;
  httpStatus: number;
  rpcMethod?: string;
  rpcToolName?: string;
  /** Server-generated x-request-id; absent without an HTTP response, never fabricated. */
  serverRequestId?: string;
  /** Tool call span that issued the request; the adapter joins the request id back to the call with it. */
  spanId?: string;
  traceId?: string;
}

/**
 * Re-resolve identity headers before every trusted-origin request; degrade to anonymous only on resolution failure.
 *
 * Key semantics:
 * - Origin is validated per request. The SDK may send several request kinds over one transport;
 *   connect-time-only checks leave a hole for later URL changes.
 * - Retained headers use set semantics. append yields comma-joined multi-value Authorization, and
 *   only-if-missing lets unexpected existing values survive (e.g. an OAuth token written by authProvider);
 * - redirect manual: fail on 3xx so the Bearer token cannot ride a cross-origin redirect;
 * - only requests that actually carried credentials retry once after 401; 403/3xx never retry.
 */
export function createOfficialMcpAuthFetch(
  input: CreateOfficialMcpAuthFetchInput,
): typeof globalThis.fetch {
  const expectedOrigin = safeOrigin(input.url);

  /**
   * Report the class and build the error; the call site throws.
   * Do not throw here: a never-returning arrow does not narrow TS control flow
   * (the callee needs an explicit type annotation), leaving origin/resolved as unions after the throw.
   */
  const failWith = (kind: OfficialMcpAuthFailureKind, message: string): OfficialMcpAuthError => {
    input.onAuthFailure?.(kind);
    return new OfficialMcpAuthError(kind, message);
  };

  const authFetch = async (
    resource: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const requestUrl = resolveRequestUrl(resource);
    const origin = safeOrigin(requestUrl);
    if (!origin || !expectedOrigin || origin !== expectedOrigin) {
      throw failWith(
        "official_mcp_origin_untrusted",
        `official MCP request origin does not match the configured endpoint: ${input.serverName}`,
      );
    }
    const trust = await input.trustedOrigins.isTrusted({
      mcpKey: input.official.mcpKey,
      origin,
      pluginId: input.official.pluginId,
    });
    if (!trust.trusted) {
      // Fail closed: zero network requests, credentials never parsed.
      // Include origin and pluginId in the message: serverName alone cannot tell what the
      // inputs even were (a pluginId suffix issue was once misdiagnosed as a url config problem).
      throw failWith(
        "official_mcp_origin_untrusted",
        `official MCP origin is not trusted (${trust.detail ?? "unknown"}): ` +
          `${input.serverName} origin=${origin} pluginId=${input.official.pluginId}`,
      );
    }

    // Request-scoped debug context, non-sensitive by construction: rpc method, body byte count, path.
    // No body content (user queries included), no header values.
    const rpc = describeJsonRpc(init?.body);
    const logBase = {
      event: "mcp.official_auth.request",
      mcpKey: input.official.mcpKey,
      mcpServerName: input.serverName,
      module: "adapters.mcp.official_auth",
      requestBodyBytes: byteLength(init?.body),
      urlPath: safePath(requestUrl),
      ...(rpc.method ? { rpcMethod: rpc.method } : {}),
      ...(rpc.id !== undefined ? { rpcId: rpc.id } : {}),
      ...(rpc.toolName ? { rpcToolName: rpc.toolName } : {}),
      ...(rpc.traceId ? { mcpTraceId: rpc.traceId } : {}),
    };

    const send = async (attempt: number): Promise<{ authApplied: boolean; response: Response }> => {
      let authHeaders: Record<string, string> = {};
      let resolveDurationMs: number | undefined;
      if (input.authHeadersPort) {
        const resolveStartedAt = Date.now();
        const resolved = await input.authHeadersPort.resolveHeaders({
          mcpKey: input.official.mcpKey,
          pluginId: input.official.pluginId,
          targetOrigin: origin,
          ...(input.workspaceIdentity ? { workspaceIdentity: input.workspaceIdentity } : {}),
          ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
          ...(init?.signal ? { signal: init.signal } : {}),
        });
        resolveDurationMs = Date.now() - resolveStartedAt;
        if (resolved.ok) {
          authHeaders = resolved.headers;
        } else {
          // Without resolvable identity, send the anonymous request and let the server be the authority;
          // never cache stale credentials nor dress parse failure up as a network failure.
          input.logger?.warn("Official MCP auth headers unavailable for request", {
            ...logBase,
            attempt,
            event: "mcp.official_auth.resolve",
            fallback: "anonymous",
            reason: resolved.reason,
            resolveDurationMs,
            status: "failed",
          });
        }
      } else {
        input.logger?.warn("Official MCP auth port unavailable for request", {
          ...logBase,
          attempt,
          event: "mcp.official_auth.resolve",
          fallback: "anonymous",
          reason: "official_auth_unavailable",
          status: "failed",
        });
      }
      // Log header names and plan tier only, never values. targetType (PERSONAL/TEAM) is a
      // low-sensitivity enum but the key to why the server denied entitlement, so keep the raw value.
      const identity = summarizeOfficialMcpIdentityHeaders(authHeaders);
      const headers = mergeOfficialAuthHeaders(init?.headers, authHeaders);

      // Correlation ids are never sent, only stripped.
      //
      // The server ignores client request ids, always minting its own and never reading inbound headers,
      // so sending X-Request-Id / X-Trace-Id
      // is dead code that misleads the next reader.
      //
      // Reconciliation runs the other way: read x-request-id from the response headers and log it
      // (see serverRequestId below), then look it up in server logs.
      //
      // Still delete explicitly rather than let them ride: these are correlation/observability channels and
      // plugin static config must not inject them into official endpoints; plugin values land verbatim in server and intermediary logs.
      headers.delete(REQUEST_ID_HEADER);
      headers.delete(TRACE_ID_HEADER);

      input.logger?.debug("Official MCP request sending", {
        ...logBase,
        attempt,
        resolveDurationMs,
        status: "started",
        timeoutHint: describeAbortSignal(init?.signal),
        ...identity,
      });

      const sendStartedAt = Date.now();
      try {
        const response = await input.baseFetch(resource, {
          ...init,
          headers,
          // No redirects on the first leg; the endpoint must be configured canonical.
          redirect: "manual",
        });
        // Server-minted request id, read back from response headers. The only key that joins client
        // and server logs: the client never sends it and the server ignores inbound values.
        const serverRequestId = readServerRequestId(response);
        // Settings consumes connect/initialize/tools-list diagnostics only. tools/call may return large media whose
        // request id is already projected onto the tool result by span; never re-clone the body for the settings page.
        const failureKind =
          rpc.method === "tools/call" ? undefined : await classifyOfficialMcpResponse(response);
        if (serverRequestId || failureKind) {
          // Report to the adapter for correlation, before logging: even if the log level filters both entries,
          // the in-band failure keeps the id.
          input.onServerResponse?.({
            httpStatus: response.status,
            ...(failureKind ? { failureKind } : {}),
            ...(serverRequestId ? { serverRequestId } : {}),
            ...(rpc.method ? { rpcMethod: rpc.method } : {}),
            ...(rpc.toolName ? { rpcToolName: rpc.toolName } : {}),
            ...(rpc.spanId ? { spanId: rpc.spanId } : {}),
            ...(rpc.traceId ? { traceId: rpc.traceId } : {}),
          });
        }
        const outcome = {
          ...logBase,
          attempt,
          httpStatus: response.status,
          responseBodyBytes: numericHeader(response.headers.get("content-length")),
          sendDurationMs: Date.now() - sendStartedAt,
          ...(serverRequestId ? { serverRequestId } : {}),
        };
        if (response.ok) {
          input.logger?.debug("Official MCP response received", {
            ...outcome,
            status: "completed",
          });
        } else {
          // Non-2xx must be a warn; the debug above does not survive production levels.
          //
          // Production loggers bottom out at Info (see getDefaultMinLevel in logging/index.ts),
          // debug is dropped. The result: at failure time, the only moment needing reconciliation, the server
          // request id is absent from logs, recoverable only by reading code (the 3001
          // parameter-error hunt proved it).
          //
          // Deliberately swallow nothing: 4xx/5xx go back to the SDK untouched for protocol errors; this wrapper
          // only adds one searchable record. 401/403/3xx classification failures throw separately below.
          input.logger?.warn("Official MCP response failed", {
            ...outcome,
            status: "failed",
          });
        }
        return { authApplied: Object.keys(authHeaders).length > 0, response };
      } catch (error) {
        // Timeout/cancel surface here as AbortError. Telling them apart names the cutter:
        // the tool budget expiry and a user cancel both abort, but elapsed-vs-budget differs.
        const sendDurationMs = Date.now() - sendStartedAt;
        input.logger?.warn("Official MCP request did not complete", {
          ...logBase,
          aborted: isAbortError(error),
          attempt,
          error: error instanceof Error ? error.message : String(error),
          errorName: error instanceof Error ? error.name : "unknown",
          sendDurationMs,
          status: "failed",
        });
        throw error;
      }
    };

    let sent = await send(1);
    let response = sent.response;
    if (response.status === 401 && sent.authApplied) {
      // At most one retry, unconditional. Only the narrow race of credentials refreshed mid-flight is self-healing;
      // the cap is 1, no spin.
      input.logger?.info("Official MCP retrying once after 401", {
        ...logBase,
        attempt: 2,
        status: "started",
      });
      await discardBody(response);
      sent = await send(2);
      response = sent.response;
    }

    if (response.status === 401) {
      const baseMessage = "official MCP rejected the current credential";
      const message =
        rpc.method === "tools/call" ? withServerRequestId(baseMessage, response) : baseMessage;
      await discardBody(response);
      throw failWith("official_auth_rejected", message);
    }
    if (response.status === 403) {
      // Identity valid but entitlement/plan insufficient; re-fetching the same credential changes nothing.
      const baseMessage = "official MCP denied access for the current plan";
      const message =
        rpc.method === "tools/call" ? withServerRequestId(baseMessage, response) : baseMessage;
      await discardBody(response);
      throw failWith("official_auth_forbidden", message);
    }
    if (isRedirect(response.status)) {
      const baseMessage = `official MCP responded with a blocked redirect (${response.status})`;
      const message =
        rpc.method === "tools/call" ? withServerRequestId(baseMessage, response) : baseMessage;
      await discardBody(response);
      throw failWith("official_auth_redirect_blocked", message);
    }
    return response;
  };

  return authFetch as typeof globalThis.fetch;
}

const MAX_DIAGNOSTIC_RESPONSE_BYTES = 64 * 1024;

async function classifyOfficialMcpResponse(
  response: Response,
): Promise<McpServerFailureKind | undefined> {
  if (response.status === 429) return "rate_limited";
  if (response.status >= 500) return "server_internal_error";

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) {
    return response.ok ? undefined : "connection_failed";
  }
  const text = await readBoundedResponseText(response, MAX_DIAGNOSTIC_RESPONSE_BYTES);
  if (!text) return response.ok ? undefined : "connection_failed";
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return response.ok ? undefined : "connection_failed";
    }
    const record = parsed as Record<string, unknown>;
    if (record["code"] === 3001) return "server_not_found";
    if (record["code"] === 1000) return "server_unavailable";
    if (record["jsonrpc"] === "2.0" && record["error"] !== undefined) {
      const rpcError = record["error"];
      if (rpcError && typeof rpcError === "object" && !Array.isArray(rpcError)) {
        const code = (rpcError as Record<string, unknown>)["code"];
        if (code === 1006) return "not_authenticated";
        if (code === 3101) return "coding_plan_required";
      }
      return "protocol_error";
    }
  } catch {
    return response.ok ? undefined : "connection_failed";
  }
  return response.ok ? undefined : "connection_failed";
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<string | undefined> {
  const declaredLength = numericHeader(response.headers.get("content-length"));
  if (declaredLength !== undefined && declaredLength > maxBytes) return undefined;
  const body = response.clone().body;
  if (!body) return undefined;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Merge static and identity headers. Identity headers always set, and strip residual reserved headers from the source side:
 * parse already blocked static reserved headers; this is the second enforcement at the merge point.
 * mcp-session-id / mcp-protocol-version / accept / content-type are untouched.
 */
function mergeOfficialAuthHeaders(
  incoming: HeadersInit | undefined,
  authHeaders: Record<string, string>,
): Headers {
  const merged = new Headers();
  const authHeaderNames = new Set(Object.keys(authHeaders).map((name) => name.toLowerCase()));
  new Headers(incoming ?? {}).forEach((value, name) => {
    const normalized = name.toLowerCase();
    // Identity headers are written later in one place; other reserved headers (e.g. authProvider Authorization) are dropped.
    if (authHeaderNames.has(normalized)) return;
    if (
      isOfficialMcpReservedHeaderName(normalized) &&
      normalized !== "mcp-session-id" &&
      normalized !== "mcp-protocol-version"
    ) {
      return;
    }
    merged.set(name, value);
  });
  for (const [name, value] of Object.entries(authHeaders)) {
    merged.set(name, value);
  }
  return merged;
}

/** Reused by the adapter at config parse so the blocklist is identical in parse and merge. */
export { findOfficialMcpReservedHeaders };

function resolveRequestUrl(resource: Parameters<typeof globalThis.fetch>[0]): string {
  if (typeof resource === "string") return resource;
  if (resource instanceof URL) return resource.toString();
  return resource.url;
}

function safeOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    // A credentialed URL and its origin are not the same trust surface: untrusted.
    if (url.username !== "" || url.password !== "") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

/** Request id the server returns in response headers; undefined when missing. */
function readServerRequestId(response: Response): string | undefined {
  const value = response.headers.get(REQUEST_ID_HEADER)?.trim();
  return value ? value : undefined;
}

/**
 * Attach the server request id to the classified error message.
 *
 * Tool-call classification errors surface directly, so use the compact message-requestId form. Connection-phase request ids
 * are joined by the adapter's structured status diagnostic, avoiding duplication across SDK wrapping.
 */
function withServerRequestId(message: string, response: Response): string {
  const requestId = readServerRequestId(response);
  return requestId ? `${message} - ${requestId}` : message;
}

/** Request path without query; the query may carry user content, so drop it. */
function safePath(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return "(unparsable)";
  }
}

function byteLength(body: unknown): number | undefined {
  if (typeof body === "string") return Buffer.byteLength(body, "utf8");
  if (body instanceof Uint8Array) return body.byteLength;
  return undefined;
}

function numericHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Pull only structural fields from the JSON-RPC request body for correlation logs: method / id / tools_call tool name /
 * trace_id from _meta.
 * Deliberately not params.arguments: that is user input (search terms), beyond not-so-sensitive.
 *
 * trace_id exists only on tools/call: initialize/tools-list are sent by the SDK during connect without _meta,
 * so those carry a request id but no trace id. By design, not a defect.
 */
function describeJsonRpc(body: unknown): {
  id?: number | string;
  method?: string;
  spanId?: string;
  toolName?: string;
  traceId?: string;
} {
  if (typeof body !== "string" || body.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record = parsed as Record<string, unknown>;
    const method = typeof record.method === "string" ? record.method : undefined;
    const id =
      typeof record.id === "number" || typeof record.id === "string" ? record.id : undefined;
    const params = isPlainRecord(record.params) ? record.params : undefined;
    const toolName = params && typeof params.name === "string" ? params.name : undefined;
    // mcpRequestMeta writes trace under params._meta (flat keys plus the com.zcode/ namespace).
    const meta = params && isPlainRecord(params._meta) ? params._meta : undefined;
    const traceId = meta && typeof meta.trace_id === "string" ? meta.trace_id : undefined;
    // The span is the one-tool-call grain: traceId spans the whole top-level session and is shared by
    // every call in it; joining on it cross-wires calls.
    const spanId = meta && typeof meta.span_id === "string" ? meta.span_id : undefined;
    return {
      ...(id !== undefined ? { id } : {}),
      ...(method ? { method } : {}),
      ...(spanId ? { spanId } : {}),
      ...(toolName ? { toolName } : {}),
      ...(traceId ? { traceId } : {}),
    };
  } catch {
    return {};
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Non-sensitive digest of the identity headers: names, pairedness, and the targetType enum only.
 * Never emit Authorization or api-key values, not even truncated: log retention is uncontrolled.
 */
function describeAbortSignal(signal: AbortSignal | null | undefined): string {
  if (!signal) return "none";
  return signal.aborted ? "already-aborted" : "armed";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Body-read failure never changes the classification.
  }
}
