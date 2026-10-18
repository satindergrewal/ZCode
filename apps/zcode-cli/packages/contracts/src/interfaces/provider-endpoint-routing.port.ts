import type { TraceContext } from "../tracing/tracer.js";

export interface ProviderEndpointRoutingDecision {
  routed: boolean;
  url: string;
}

export interface ProviderEndpointRoutingResolveOptions {
  apiKeyId?: string;
  signal?: AbortSignal;
  trace?: TraceContext;
}

/**
 * Dynamic endpoint decision boundary for model provider transports.
 *
 * Implementations may refresh remote configuration on demand, but must not modify or persist provider base URLs.
 */
export interface ProviderEndpointRoutingPort {
  resolve(
    requestUrl: string,
    options?: ProviderEndpointRoutingResolveOptions,
  ): Promise<ProviderEndpointRoutingDecision>;
}
