import type http from "node:http";
import { Readable } from "node:stream";

/**
 // The sole inlet handing Node's `IncomingMessage` upward when the adapter itself requests
 // (docs/design/v2/model/http-proxy.md, behavior).
 *
 // Why (observed 2026-09-29): both adapters built `new Response(stream, { status })` directly in the
 // `http.request` callback. A WHATWG `Response` takes 200-599 only, and 204 / 205 / 304 allow no body;
 * LinkedIn answers crawlers with 999; the constructor would throw RangeError in the callback, no catcher exists, and the agent process dies via
 // uncaughtException, taking the workspace's sessions and runs along. So: read the status verbatim, no stream for bodyless statuses, and whether it becomes
 * a `Response` is judged separately by {@link toWebResponse}, failing as a plain reject.
 */

/** Fetch-spec null body statuses: no body, and a `Response` may not carry one either. */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 103, 204, 205, 304]);
/** The status range a `Response` can express (both ends included). */
const MIN_WEB_RESPONSE_STATUS = 200;
const MAX_WEB_RESPONSE_STATUS = 599;
/** With no status from Node (theoretically impossible), treat as a gateway error, matching the earlier fallback. */
const MISSING_STATUS = 502;

export const UNSUPPORTED_HTTP_STATUS_CODE = "ZCODE_UNSUPPORTED_HTTP_STATUS";

/** The verbatim response: status untrimmed, body a stream (`null` for bodyless statuses). */
export interface IncomingResponse {
  status: number;
  statusText: string;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
}

/**
 * Statuses a `Response` cannot express. Shaped like native fetch's network failure (`TypeError`); callers distinguish by code, not text.
 */
export class UnsupportedHttpStatusError extends TypeError {
  readonly code = UNSUPPORTED_HTTP_STATUS_CODE;

  constructor(readonly status: number) {
    super(
      `HTTP response status ${status} is outside ${MIN_WEB_RESPONSE_STATUS}-${MAX_WEB_RESPONSE_STATUS} and cannot be returned as a fetch Response`,
    );
  }
}

export function readIncomingResponse(message: http.IncomingMessage): IncomingResponse {
  const status = message.statusCode ?? MISSING_STATUS;
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.append(name, String(value));
    }
  }
  const nullBody = NULL_BODY_STATUSES.has(status);
  // Bodyless statuses still drain the message so the socket returns to the pool.
  if (nullBody) message.resume();
  return {
    body: nullBody ? null : (Readable.toWeb(message) as ReadableStream<Uint8Array>),
    headers,
    status,
    statusText: message.statusMessage ?? "",
  };
}

/** For callers accepting only `Response` (proxy-aware fetch); unrepresentable statuses throw {@link UnsupportedHttpStatusError}. */
export function toWebResponse(incoming: IncomingResponse): Response {
  if (incoming.status < MIN_WEB_RESPONSE_STATUS || incoming.status > MAX_WEB_RESPONSE_STATUS) {
    throw new UnsupportedHttpStatusError(incoming.status);
  }
  return new Response(incoming.body, {
    headers: incoming.headers,
    status: incoming.status,
    statusText: incoming.statusText,
  });
}
