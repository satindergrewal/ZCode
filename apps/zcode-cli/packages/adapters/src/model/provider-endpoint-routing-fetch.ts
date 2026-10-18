import type { ProviderEndpointRoutingPort, TraceContext } from "@zcode/contracts";

const TRACE_HEADER = "x-zcode-trace-id";

export type ProviderEndpointRoutingFetch = typeof globalThis.fetch;

export function createProviderEndpointRoutingFetch(options: {
  fetch: ProviderEndpointRoutingFetch;
  routingPort: ProviderEndpointRoutingPort;
  apiKeyId?: string;
}): ProviderEndpointRoutingFetch {
  return async (input, init) => {
    const requestUrl = readRequestUrl(input);
    if (!requestUrl) {
      return await options.fetch(input, init);
    }

    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    // The config endpoint accepts only IDs returned by the account owner; never derive from a model PAT or manual key.
    const apiKeyId = options.apiKeyId;
    const decision = await options.routingPort.resolve(requestUrl, {
      ...(apiKeyId ? { apiKeyId } : {}),
      signal: signal ?? undefined,
      trace: readTraceContext(input, init),
    });
    if (!decision.routed) {
      return await options.fetch(input, init);
    }

    const rewrittenInput = rewriteInput(input, decision.url);
    if (rewrittenInput instanceof Request) {
      rewrittenInput.headers.delete("host");
    }
    return await options.fetch(rewrittenInput, withoutHostHeader(init));
  };
}

function withoutHostHeader(
  init: Parameters<ProviderEndpointRoutingFetch>[1],
): Parameters<ProviderEndpointRoutingFetch>[1] {
  if (!init?.headers) {
    return init;
  }
  const headers = new Headers(init.headers);
  if (!headers.has("host")) {
    return init;
  }
  headers.delete("host");
  return { ...init, headers };
}

function readRequestUrl(input: Parameters<ProviderEndpointRoutingFetch>[0]): string | undefined {
  try {
    if (input instanceof Request) {
      return input.url;
    }
    if (input instanceof URL) {
      return input.href;
    }
    return new URL(String(input)).href;
  } catch {
    return undefined;
  }
}

function rewriteInput(
  input: Parameters<ProviderEndpointRoutingFetch>[0],
  targetUrl: string,
): Parameters<ProviderEndpointRoutingFetch>[0] {
  if (input instanceof Request) {
    return new Request(targetUrl, input);
  }
  if (input instanceof URL) {
    return new URL(targetUrl);
  }
  return targetUrl;
}

function readTraceContext(
  input: Parameters<ProviderEndpointRoutingFetch>[0],
  init: Parameters<ProviderEndpointRoutingFetch>[1],
): TraceContext | undefined {
  const traceId = readRequestHeaders(input, init).get(TRACE_HEADER)?.trim();
  return traceId ? { traceId: traceId as TraceContext["traceId"] } : undefined;
}

function readRequestHeaders(
  input: Parameters<ProviderEndpointRoutingFetch>[0],
  init: Parameters<ProviderEndpointRoutingFetch>[1],
): Headers {
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
}
