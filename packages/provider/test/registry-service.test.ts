import { describe, expect, it, vi } from "vitest";
import {
  ModelConfig,
  ModelConfigRules,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderConfigMap,
  ProviderRegistryService,
  MutableAccountProviderConfigSource,
  type AccountProviderConfigSnapshot,
  type ProviderConfigSnapshot,
  type ProviderSource,
} from "../src/index.js";
import {
  createAccountProviderConfig,
  createApiKeyProviderConfig,
} from "./provider-config-fixtures.js";

class MutableSource<TSnapshot> implements ProviderSource<TSnapshot> {
  current: TSnapshot;
  nextRead: (() => Promise<TSnapshot>) | null = null;
  readonly read = vi.fn(async (): Promise<TSnapshot> => {
    const nextRead = this.nextRead;
    this.nextRead = null;
    return nextRead ? nextRead() : this.current;
  });
  readonly #listeners = new Set<(reason: string) => void>();

  constructor(initial: TSnapshot) {
    this.current = initial;
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(reason: string): void {
    for (const listener of this.#listeners) listener(reason);
  }
}

function modelConfig(contextWindow = 200_000): ModelConfig {
  return new ModelConfig({
    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      reasoningLevel: { values: ["disabled"], map: "{}" },
      maxOutputTokens: {
        max: 32_000,
        map: "{'max_tokens': maxOutputTokens}",
      },
    }),
    enabled: true,
  });
}

function configSnapshot(revision: string, modelId: string): ProviderConfigSnapshot {
  return {
    revision,
    zcodeBuiltinRevision: revision,
    personalRevision: "personal-1",
    zcodeBuiltinProviders: new ProviderConfigMap([
      [
        "local",
        createApiKeyProviderConfig({
          apiFormat: "anthropic-messages",
          baseURL: "https://api.example.com",
          apiKey: "test-key",
          models: [modelId],
        }),
      ],
    ]),
    personalProviders: ProviderConfigMap.empty(),
    zcodeBuiltinModelRules: new ModelConfigRules([
      { type: "model", modelMatch: modelId, config: modelConfig() },
    ]),
    personalModels: ModelConfigRules.empty(),
  };
}

function accountSnapshot(
  revision = "account-1",
  basedOnZCodeBuiltinRevision = "config-1",
): AccountProviderConfigSnapshot {
  return { revision, basedOnZCodeBuiltinRevision, providers: ProviderConfigMap.empty() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("ProviderRegistryService", () => {
  it("resolves start with ready only; read the current snapshot explicitly after Account updates instead of restarting refreshes", async () => {
    const configSource = new MutableSource(configSnapshot("config-1", "model-a"));
    const accountSource = new MutableSource(accountSnapshot());
    const service = new ProviderRegistryService({ configSource, accountSource });
    try {
      expect(await service.start()).toBeUndefined();
      accountSource.current = accountSnapshot("account-2");
      await service.refresh("account-change");
      const reads = configSource.read.mock.calls.length;
      expect(await service.start()).toBeUndefined();
      expect(service.getSnapshot()?.sourceRevisions.account).toBe("account-2");
      expect(configSource.read).toHaveBeenCalledTimes(reads);
    } finally {
      service.dispose();
    }
  });
  it("drives a Registry refresh when the mutable Account Config Source swaps the third-layer Overlay", async () => {
    const configSource = new MutableSource(configSnapshot("config-1", "model-a"));
    const accountSource = new MutableAccountProviderConfigSource();
    accountSource.replace({
      revision: "account-1",
      basedOnZCodeBuiltinRevision: "config-1",
      providers: ProviderConfigMap.empty(),
    });
    const service = new ProviderRegistryService({ configSource, accountSource });
    await service.start();

    accountSource.replace(
      {
        revision: "account-2",
        basedOnZCodeBuiltinRevision: "config-1",
        providers: new ProviderConfigMap([
          [
            "account-provider",
            createAccountProviderConfig({
              models: ["model-a"],
            }),
          ],
        ]),
      },
      "workspace-registry",
    );

    await service.refresh("wait-for-account-source");
    await expect(accountSource.read()).resolves.toMatchObject({ revision: "account-2" });
  });

  it("boots from the injected Config and Account Sources and publishes a full snapshot", async () => {
    const configSource = new MutableSource(configSnapshot("config-1", "model-a"));
    const accountSource = new MutableSource(accountSnapshot());
    const service = new ProviderRegistryService({ configSource, accountSource });
    const listener = vi.fn();
    service.onDidChange(listener);

    await service.start();
    const snapshot = service.getSnapshot()!;

    expect(snapshot.sourceRevisions).toEqual({ config: "config-1", account: "account-1" });
    expect(service.listProviders()[0]?.models[0]?.modelId).toBe("model-a");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].reasons).toEqual(["start"]);
  });

  it("drops stale generations on mid-read invalidation and publishes only the latest Sources", async () => {
    const configV1 = configSnapshot("config-1", "model-a");
    const configV2 = configSnapshot("config-2", "model-b");
    const firstRead = deferred<ProviderConfigSnapshot>();
    const configSource = new MutableSource(configV1);
    configSource.nextRead = () => firstRead.promise;
    const accountSource = new MutableSource(accountSnapshot("account-2", "config-2"));
    const service = new ProviderRegistryService({ configSource, accountSource });
    const listener = vi.fn();
    service.onDidChange(listener);

    const start = service.start();
    await vi.waitFor(() => expect(configSource.read).toHaveBeenCalledTimes(1));
    configSource.current = configV2;
    configSource.emit("config-file-changed");
    firstRead.resolve(configV1);
    await start;

    expect(configSource.read).toHaveBeenCalledTimes(2);
    expect(service.listProviders()[0]?.models[0]?.modelId).toBe("model-b");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0].reasons).toEqual(
      expect.arrayContaining(["start", "config:config-file-changed"]),
    );
  });

  it("skips republish when Source revisions are unchanged", async () => {
    const configSource = new MutableSource(configSnapshot("config-1", "model-a"));
    const accountSource = new MutableSource(accountSnapshot());
    const service = new ProviderRegistryService({ configSource, accountSource });
    const listener = vi.fn();
    service.onDidChange(listener);
    await service.start();
    const initial = service.getSnapshot()!;

    const duplicate = await service.refresh("explicit-refresh");

    expect(duplicate).toBe(initial);
    expect(service.getView().revision).toBe(initial.registry.revision);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("lets a refresh requested inside the publish callback survive the finishing old one", async () => {
    const configSource = new MutableSource(configSnapshot("config-1", "model-a"));
    const accountSource = new MutableSource(accountSnapshot());
    const service = new ProviderRegistryService({ configSource, accountSource });
    let followUp: Promise<unknown> | null = null;
    service.onDidChange(() => {
      if (followUp) return;
      configSource.current = configSnapshot("config-2", "model-b");
      accountSource.current = accountSnapshot("account-2", "config-2");
      followUp = service.refresh("listener-refresh");
    });

    await service.start();
    await followUp;

    expect(service.getSnapshot()?.sourceRevisions.config).toBe("config-2");
    expect(service.listProviders()[0]?.models[0]?.modelId).toBe("model-b");
  });

  it("keeps the last good View on refresh failure and lets later refreshes recover", async () => {
    const configSource = new MutableSource(configSnapshot("config-1", "model-a"));
    const accountSource = new MutableSource(accountSnapshot());
    const service = new ProviderRegistryService({ configSource, accountSource });
    const errorListener = vi.fn();
    service.onDidRefreshError(errorListener);
    await service.start();
    const initial = service.getSnapshot()!;

    configSource.nextRead = async () => {
      throw new Error("config unavailable");
    };
    await expect(service.refresh("broken-config")).rejects.toThrow("config unavailable");

    expect(service.getSnapshot()).toBe(initial);
    expect(service.listProviders()[0]?.models[0]?.modelId).toBe("model-a");
    expect(errorListener).toHaveBeenCalledTimes(1);

    configSource.current = configSnapshot("config-2", "model-b");
    accountSource.current = accountSnapshot("account-2", "config-2");
    const recovered = await service.refresh("config-recovered");
    expect(recovered.sourceRevisions.config).toBe("config-2");
    expect(service.listProviders()[0]?.models[0]?.modelId).toBe("model-b");
  });

  it("holds the old Registry on Built-in/Account revision mismatch and publishes only the final combination once matched", async () => {
    const configSource = new MutableSource(configSnapshot("config-1", "model-a"));
    const accountSource = new MutableSource(accountSnapshot("account-1", "config-1"));
    const service = new ProviderRegistryService({ configSource, accountSource });
    const listener = vi.fn();
    service.onDidChange(listener);
    await service.start();
    const initial = service.getSnapshot()!;

    configSource.current = configSnapshot("config-2", "model-b");
    const held = service.refresh("builtin-updated");
    await expect(held).resolves.toBe(initial);

    expect(service.getSnapshot()).toBe(initial);
    expect(service.listProviders()[0]?.models[0]?.modelId).toBe("model-a");
    expect(listener).toHaveBeenCalledTimes(1);

    accountSource.current = accountSnapshot("account-2", "config-2");
    accountSource.emit("account-recomputed");
    await vi.waitFor(() => expect(service.listProviders()[0]?.models[0]?.modelId).toBe("model-b"));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("never waits on a new Account Snapshot for Personal-only revision changes", async () => {
    const configSource = new MutableSource(configSnapshot("config-1", "model-a"));
    const accountSource = new MutableSource(accountSnapshot("account-1", "config-1"));
    const service = new ProviderRegistryService({ configSource, accountSource });
    await service.start();

    configSource.current = {
      ...configSnapshot("combined-2", "model-a"),
      zcodeBuiltinRevision: "config-1",
      personalRevision: "personal-2",
    };
    const next = await service.refresh("personal-updated");

    expect(next.config.personalRevision).toBe("personal-2");
    expect(next.account).toBeDefined();
  });
});
