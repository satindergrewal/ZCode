import {
  ProviderConfig,
  ProviderConfigMap,
  ProviderTemplateMap,
  ZhipuAccountAccessConfig,
  type ModelConfigRules,
} from "./config/index.js";
import type { AccountProviderStates } from "./account-provider-state.js";

export interface ProviderSource<TSnapshot> {
  read(): Promise<TSnapshot>;
  onDidChange(listener: (reason: string) => void): () => void;
}

export interface ProviderConfigSnapshot {
  readonly revision: string;
  readonly zcodeBuiltinRevision: string;
  readonly personalRevision: string;
  readonly zcodeBuiltinProviders: ProviderConfigMap;
  readonly zcodeBuiltinProviderTemplates: ProviderTemplateMap;
  readonly personalProviders: ProviderConfigMap;
  readonly zcodeBuiltinModelRules: ModelConfigRules;
  readonly personalModels: ModelConfigRules;
  readonly personalProviderOrder?: readonly string[];
}

export interface AccountProviderConfigSnapshot {
  readonly revision: string;
  readonly basedOnZCodeBuiltinRevision: string;
  readonly providers: ProviderConfigMap;
  readonly states?: AccountProviderStates;
}

/** Before the first account fact lands, builds a publishable fail-closed Overlay from current Built-in entries. */
export function createFailClosedAccountProviderConfigSnapshot(
  config: ProviderConfigSnapshot,
): AccountProviderConfigSnapshot {
  const unentitledProviders = new ProviderConfigMap(
    config.zcodeBuiltinProviders.entries().flatMap(([providerId, provider]) =>
      provider.access?.type === "zhipu-account"
        ? ([
            [
              providerId,
              new ProviderConfig({
                access: new ZhipuAccountAccessConfig({ entitled: false }),
              }),
            ],
          ] as const)
        : [],
    ),
  );
  return createAccountProviderConfigSnapshot(config.zcodeBuiltinRevision, unentitledProviders);
}

export function createAccountProviderConfigSnapshot(
  basedOnZCodeBuiltinRevision: string,
  providers: ProviderConfigMap,
  states?: AccountProviderStates,
): AccountProviderConfigSnapshot {
  return Object.freeze({
    revision: `account:${JSON.stringify([basedOnZCodeBuiltinRevision, providers.toJSON(), states])}`,
    basedOnZCodeBuiltinRevision,
    providers,
    ...(states ? { states } : {}),
  });
}

const EMPTY_ACCOUNT_PROVIDER_CONFIG_SNAPSHOT: AccountProviderConfigSnapshot = Object.freeze({
  revision: "empty-account-config-v1",
  basedOnZCodeBuiltinRevision: "uninitialized",
  providers: ProviderConfigMap.empty(),
});

/**
 * Account provider availability, updated by the process-edge adapter.
 *
 * The source stores only the layer-3 Provider Config Overlay projected from account state.
 * models carries entitlement constraints; tokens, API keys, headers, and account identity
 * never enter the Config.
 */
export class MutableAccountProviderConfigSource implements ProviderSource<AccountProviderConfigSnapshot> {
  readonly #listeners = new Set<(reason: string) => void>();
  #snapshot: AccountProviderConfigSnapshot = EMPTY_ACCOUNT_PROVIDER_CONFIG_SNAPSHOT;

  async read(): Promise<AccountProviderConfigSnapshot> {
    return this.#snapshot;
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  replace(snapshot: AccountProviderConfigSnapshot, reason = "replace"): boolean {
    if (snapshot.revision === this.#snapshot.revision) return false;
    this.#snapshot = freezeAccountProviderConfigSnapshot(snapshot);
    for (const listener of this.#listeners) listener(reason);
    return true;
  }
}

function freezeAccountProviderConfigSnapshot(
  snapshot: AccountProviderConfigSnapshot,
): AccountProviderConfigSnapshot {
  return Object.freeze({
    revision: snapshot.revision,
    basedOnZCodeBuiltinRevision: snapshot.basedOnZCodeBuiltinRevision,
    providers: snapshot.providers,
    ...(snapshot.states ? { states: snapshot.states } : {}),
  });
}
