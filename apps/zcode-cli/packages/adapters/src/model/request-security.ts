import type { Logger, ModelRequestObservation } from "@zcode/contracts";
import type { RegistryProviderConfig } from "@zcode/provider";

export interface ModelRequestObservationSource {
  take(requestId: string): ModelRequestObservation[];
}

export interface ModelRequestSecurityPort extends ModelRequestObservationSource {
  protectTransport(input: {
    providerId: string;
    providerConfig: {
      access: RegistryProviderConfig["access"];
      baseURL: string;
      apiKey?: string;
      headers?: Record<string, string>;
    };
    transport: typeof globalThis.fetch;
  }): typeof globalThis.fetch;
}

/** The process shares reusable resources only; each model executor keeps its own request state. */
export interface ModelRequestSecurityState {
  createExecution(options: { logger?: Logger }): ModelRequestSecurityPort;
}
