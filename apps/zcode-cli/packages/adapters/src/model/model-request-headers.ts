const MODEL_AUTH_HEADER_NAMES = new Set(["authorization", "x-api-key"]);
export const MODEL_QUERY_SOURCE_HEADER = "x-zcode-query-source";

/** The request purpose belongs to the calling context; never inherited from provider static config or SDK default headers. */
export function withoutModelQuerySourceHeader(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(
      ([name]) => name.toLowerCase() !== MODEL_QUERY_SOURCE_HEADER,
    ),
  );
}

/** Account auth is the request-time owner's call; static defaults and Personal config never override newer credentials. */
export function withoutModelAuthHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(
      ([name]) => !MODEL_AUTH_HEADER_NAMES.has(name.toLowerCase()),
    ),
  );
}

/** Header names are case-insensitive; later values replace earlier so the SDK never joins duplicates. */
export function mergeModelRequestHeaders(
  ...sources: (Readonly<Record<string, string>> | undefined)[]
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const source of sources) {
    for (const [name, value] of Object.entries(source ?? {})) {
      for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
      }
      headers[name] = value;
    }
  }
  return headers;
}
