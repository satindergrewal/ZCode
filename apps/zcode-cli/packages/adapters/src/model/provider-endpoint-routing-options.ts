import type { HttpClientPort, Logger } from "@zcode/contracts";

/** The runtime environment, injected by bootstrap; implementations never mutate the provider's persisted config. */
export interface ProviderEndpointRoutingFactoryOptions {
  endpointOrigin: string;
  appVersion?: string;
  httpClient: HttpClientPort;
  logger?: Logger;
  sourceHeaders?: () =>
    | Promise<Readonly<Record<string, string>>>
    | Readonly<Record<string, string>>;
}
