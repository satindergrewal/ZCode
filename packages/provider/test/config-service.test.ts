import { describe, expect, it, vi } from "vitest";
import {
  ModelConfig,
  ModelConfigRules,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigService,
  ProviderRegistryService,
  ProviderSettingsFacade,
  ProviderTemplate,
  ProviderTemplateMap,
  extractManualModelConfig,
  type AccountProviderConfigSnapshot,
  type PersonalProviderConfigRepository,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigLayerUpdate,
  type ProviderSource,
} from "../src/index.js";
import {
  createAccountProviderConfig,
  createApiKeyProviderConfig,
} from "./provider-config-fixtures.js";

class MutableSource<TSnapshot> implements ProviderSource<TSnapshot> {
  readonly #listeners = new Set<(reason: string) => void>();

  constructor(public current: TSnapshot) {}

  async read(): Promise<TSnapshot> {
    return this.current;
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(reason: string): void {
    for (const listener of this.#listeners) listener(reason);
  }
}

class MemoryPersonalRepository
  extends MutableSource<ProviderConfigLayerSnapshot>
  implements PersonalProviderConfigRepository
{
  revision = 1;

  async update(
    transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate,
  ): Promise<ProviderConfigLayerSnapshot> {
    const next = transform(this.current);
    this.revision += 1;
    this.current = {
      revision: `personal-${this.revision}`,
      providers: next.providers,
      models: next.models,
      providerOrder: next.providerOrder,
    };
    this.emit("updated");
    return this.current;
  }
}

function layerSnapshot(
  revision: string,
  providers = ProviderConfigMap.empty(),
  models = ModelConfigRules.empty(),
  providerOrder: readonly string[] = [],
): ProviderConfigLayerSnapshot {
  return { revision, providers, models, providerOrder };
}

function localProvider(modelIds: readonly string[]): ProviderConfig {
  return createApiKeyProviderConfig({
    apiFormat: "anthropic-messages",
    baseURL: "https://api.example.com",
    apiKey: "test-key",
    models: modelIds,
  });
}

function personalProvider(modelIds: readonly string[]): ProviderConfig {
  return createApiKeyProviderConfig({
    group: "standard-personal",
    apiFormat: "anthropic-messages",
    baseURL: "https://api.example.com",
    apiKey: "test-key",
    personalModels: modelIds,
  });
}

function completeModelConfig(): ModelConfig {
  return new ModelConfig({
    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: 200_000,
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

function manualModelConfig(): ModelConfig {
  return ModelConfig.fromData(extractManualModelConfig(completeModelConfig().toJSON()));
}

describe("ProviderConfigService", () => {
  it.each(["zai", "bigmodel"] as const)(
    "%s account modes reject new disables while stale disables never block plain saves",
    async (accountType) => {
      for (const mode of [
        "start-plan",
        "individual-coding-plan",
        "team-coding-plan",
        "off-peak",
      ] as const) {
        const personal = new MemoryPersonalRepository(
          layerSnapshot(
            "personal-1",
            new ProviderConfigMap([
              { providerId: "account", enabled: false, config: new ProviderConfig({}) },
            ]),
          ),
        );
        const service = new ProviderConfigService({
          zcodeBuiltinSource: new MutableSource(
            layerSnapshot(
              "builtin-1",
              new ProviderConfigMap([
                ["account", createAccountProviderConfig({ accountType, mode })],
              ]),
            ),
          ),
          personalRepository: personal,
        });
        try {
          const before = personal.current;
          await expect(
            service.savePersonalProviderOverlay("account", new ProviderConfig({}), undefined, {
              enabled: false,
            }),
          ).rejects.toThrow(/Account provider cannot be disabled/);
          expect(personal.current).toBe(before);
          await service.savePersonalProviderOverlay("account", new ProviderConfig({}), undefined, {
            providerName: "renamed",
          });
          expect(personal.current.providers.getRule("account")?.providerName).toBe("renamed");
        } finally {
          service.dispose();
        }
      }
    },
  );
  it("keeps the outer provider enabled flag across saves and member ops without touching config content", async () => {
    const original = personalProvider(["A"]);
    const personal = new MemoryPersonalRepository(
      layerSnapshot("personal-1", new ProviderConfigMap([["p", original]])),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("builtin-1")),
      personalRepository: personal,
    });
    try {
      await service.savePersonalProviderOverlay("p", original, undefined, { enabled: false });
      expect(personal.current.providers.getRule("p")?.enabled).toBe(false);
      expect(personal.current.providers.get("p")?.toJSON()).toEqual(original.toJSON());
      await service.addPersonalModel("p", "B", completeModelConfig());
      await service.reorderPersonalModels("p", ["B", "A"]);
      await service.savePersonalProviderOverlay(
        "p",
        personal.current.providers.get("p")!,
        undefined,
        { providerName: "renamed" },
      );
      expect(personal.current.providers.getRule("p")?.enabled).toBe(false);
      await service.savePersonalProviderOverlay(
        "p",
        personal.current.providers.get("p")!,
        undefined,
        { enabled: true },
      );
      expect(personal.current.providers.getRule("p")?.enabled).toBe(true);
    } finally {
      service.dispose();
    }
  });
  it("Todo90: saving a pinned config persists its mode too and leaves no members when incomplete", async () => {
    const builtin = new MutableSource(layerSnapshot("builtin-1"));
    const personal = new MemoryPersonalRepository(
      layerSnapshot("personal-1", new ProviderConfigMap([["p", personalProvider([])]])),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: builtin,
      personalRepository: personal,
    });
    try {
      await expect(
        service.addPersonalModel("p", "bad", new ModelConfig({}), undefined, false),
      ).rejects.toThrow(/properties|optionSpecs|contextWindow/);
      expect(personal.current.providers.get("p")?.personalModelIds).toEqual([]);
      await service.addPersonalModel("p", "good", manualModelConfig(), undefined, false);
      expect(personal.current.models.getExactRule("p", "good")?.type).toBe("manual-provider-model");
      expect(personal.current.providers.get("p")?.personalModelIds).toEqual(["good"]);
    } finally {
      service.dispose();
    }
  });
  it("Todo89: direct writes protect inherited members and put new ones before the existing order", async () => {
    const builtin = new MutableSource(
      layerSnapshot("builtin-1", new ProviderConfigMap([["p", localProvider(["NEW", "A"])]])),
    );
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([
          ["p", new ProviderConfig({ personalModelIds: ["A", "B"], modelOrder: ["B", "A"] })],
        ]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: builtin,
      personalRepository: personal,
    });
    try {
      await expect(service.renamePersonalModel("p", "A", "renamed")).rejects.toThrow(
        "Built-in model",
      );
      await expect(service.deletePersonalModel("p", "A")).rejects.toThrow("Built-in model");
      await service.addPersonalModel("p", "C", new ModelConfig({}));
      expect(personal.current.providers.get("p")?.modelOrder).toEqual(["NEW", "B", "A", "C"]);
    } finally {
      service.dispose();
    }
  });
  it("Todo89: first add needs no Personal root record, keeps ordering and never copies inherited members", async () => {
    const builtin = new MutableSource(
      layerSnapshot("builtin-1", new ProviderConfigMap([["account", localProvider(["A", "B"])]])),
    );
    const personal = new MemoryPersonalRepository(layerSnapshot("personal-1"));
    const service = new ProviderConfigService({
      zcodeBuiltinSource: builtin,
      personalRepository: personal,
    });
    try {
      await service.addPersonalModel("account", "C", new ModelConfig({}));
      expect(personal.current.providers.get("account")?.toJSON()).toEqual({
        personalModelIds: ["C"],
        modelOrder: ["A", "B", "C"],
      });
      await service.reorderPersonalModels("account", ["B", "C", "A"]);
      await service.addPersonalModel("account", "D", new ModelConfig({}));
      expect(personal.current.providers.get("account")?.modelOrder).toEqual(["B", "C", "A", "D"]);
      expect(personal.current.models.getExact("account", "D")?.enabled).toBe(true);
      const before = personal.current;
      await expect(service.addPersonalModel("account", "A", new ModelConfig({}))).rejects.toThrow(
        "Model already exists",
      );
      await expect(service.addPersonalModel("deleted", "A", new ModelConfig({}))).rejects.toThrow(
        "Provider",
      );
      expect(personal.current).toBe(before);
    } finally {
      service.dispose();
    }
  });

  it("Todo89: custom-provider adds keep order; toggles update only the latest enabled and preserve the pinned mode", async () => {
    const builtin = new MutableSource(layerSnapshot("builtin-1"));
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([
          ["custom", personalProvider(["A", "B"]).withModelOrder(["B", "A"])],
        ]),
        ModelConfigRules.empty().setExact(
          "custom",
          "A",
          manualModelConfig().overlay(
            new ModelConfig({
              properties: new ModelPropertiesConfig({ supportsNativeWebSearch: true }),
            }),
          ),
          false,
        ),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: builtin,
      personalRepository: personal,
    });
    try {
      await service.addPersonalModel("custom", "C", new ModelConfig({}));
      expect(personal.current.providers.get("custom")?.modelOrder).toEqual(["B", "A", "C"]);
      await service.setPersonalModelEnabled("custom", "A", false);
      expect(personal.current.models.getExact("custom", "A")?.toJSON()).toEqual(
        manualModelConfig()
          .overlay(
            new ModelConfig({
              enabled: false,
              properties: new ModelPropertiesConfig({ supportsNativeWebSearch: true }),
            }),
          )
          .toJSON(),
      );
      expect(personal.current.models.getExactRule("custom", "A")?.type).toBe(
        "manual-provider-model",
      );
      await expect(service.setPersonalModelEnabled("custom", "missing", true)).rejects.toThrow(
        "Model not found",
      );
    } finally {
      service.dispose();
    }
  });

  it("shares one snapshot across dynamic account member display, edit and reorder; no member copies, no renames", async () => {
    const builtin = new MutableSource(
      layerSnapshot(
        "builtin-1",
        new ProviderConfigMap([
          [
            "account",
            createAccountProviderConfig({
              apiFormat: "anthropic-messages",
              baseURL: "https://example.com",
              models: ["STATIC"],
            }),
          ],
        ]),
        new ModelConfigRules([{ type: "model", modelMatch: ".*", config: completeModelConfig() }]),
      ),
    );
    const personal = new MemoryPersonalRepository(layerSnapshot("personal-1"));
    const service = new ProviderConfigService({
      zcodeBuiltinSource: builtin,
      personalRepository: personal,
    });
    const account = new MutableSource<AccountProviderConfigSnapshot>({
      revision: "account-1",
      basedOnZCodeBuiltinRevision: "builtin-1",
      providers: new ProviderConfigMap([
        [
          "account",
          createAccountProviderConfig({ models: ["glm-new", "glm-next"], entitled: true }),
        ],
      ]),
    });
    const registry = new ProviderRegistryService({ configSource: service, accountSource: account });
    await registry.start();
    const facade = new ProviderSettingsFacade(registry, {
      createPersonalProvider: service.createPersonalProvider.bind(service),
      savePersonalProviderOverlay: service.savePersonalProviderOverlay.bind(service),
      deletePersonalProvider: service.deletePersonalProvider.bind(service),
      reorderPersonalProviders: service.reorderPersonalProviders.bind(service),
      reorderPersonalModels: service.reorderPersonalModels.bind(service),
      addPersonalModel: service.addPersonalModel.bind(service),
      renamePersonalModel: service.renamePersonalModel.bind(service),
      deletePersonalModel: service.deletePersonalModel.bind(service),
      savePersonalModelDraft: service.savePersonalModelDraft.bind(service),
      setPersonalModelEnabled: service.setPersonalModelEnabled.bind(service),
      refresh: registry.refresh.bind(registry),
    });
    try {
      // Toggling/editing dynamic members creates no root override; a first personal-model add must still work after.
      await facade.setPersonalModelEnabled("account", "glm-new", false);
      expect(personal.current.providers.has("account")).toBe(false);
      await facade.addPersonalModel("account", "personal-first", {});
      expect(personal.current.providers.get("account")?.personalModelIds).toEqual([
        "personal-first",
      ]);
      await facade.deletePersonalModel("account", "personal-first");
      await facade.savePersonalModelDraft({
        providerId: "account",
        originalModelId: "glm-new",
        nextModelId: "glm-new",
        personalConfig: { enabled: false },
        basedOnRevision: facade.getView().revision,
      });
      await facade.reorderPersonalModels("account", ["glm-next", "glm-new"]);
      // Simulate a stale on-disk account disable: the Settings projection and the real Registry must read one shared result.
      await personal.update((current) => ({
        ...current,
        providers: current.providers.setRule({
          ...current.providers.getRule("account")!,
          enabled: false,
        }),
      }));
      await registry.refresh();
      const view = facade
        .getView()
        .providers.find((provider) => provider.providerId === "account")!;
      expect(view.models.map((model) => model.modelId)).toEqual(["glm-next", "glm-new"]);
      expect(view.enabled).toBe(true);
      expect(view.executable).toBe(true);
      expect(view.models.find((model) => model.modelId === "glm-new")?.enabled).toBe(false);
      expect(personal.current.providers.get("account")?.personalModelIds).toEqual([]);
      expect(personal.current.providers.get("account")?.builtinModelIds).toBeUndefined();
      await facade.savePersonalProviderOverlay("account", {}, { providerName: "Account label" });
      expect(
        facade
          .getView()
          .providers.find((provider) => provider.providerId === "account")
          ?.models.map((model) => model.modelId),
      ).toEqual(["glm-next", "glm-new"]);
      expect(personal.current.providers.get("account")?.modelOrder).toEqual([
        "glm-next",
        "glm-new",
      ]);
      await expect(
        facade.savePersonalModelDraft({
          providerId: "account",
          originalModelId: "glm-new",
          nextModelId: "renamed",
          personalConfig: {},
          basedOnRevision: facade.getView().revision,
        }),
      ).rejects.toThrow("cannot be renamed");
      await expect(facade.addPersonalModel("account", "glm-next", {})).rejects.toThrow(
        "Model already exists",
      );
      await Promise.all([
        facade.savePersonalModelDraft({
          providerId: "account",
          originalModelId: "glm-new",
          nextModelId: "glm-new",
          personalConfig: { properties: { requiresMfjsToolSchema: true }, enabled: false },
          basedOnRevision: facade.getView().revision,
        }),
        facade.setPersonalModelEnabled("account", "glm-new", true),
      ]);
      expect(personal.current.models.getExact("account", "glm-new")?.toJSON()).toEqual({
        properties: { requiresMfjsToolSchema: true },
        enabled: true,
      });
      const beforeToggleRevision = facade.getView().revision;
      const toggled = facade.setPersonalModelEnabled("account", "glm-new", false);
      const staleDraft = facade.savePersonalModelDraft({
        providerId: "account",
        originalModelId: "glm-new",
        nextModelId: "glm-new",
        personalConfig: {},
        basedOnRevision: beforeToggleRevision,
      });
      await Promise.all([toggled, expect(staleDraft).rejects.toThrow("revision conflict")]);
      expect(personal.current.models.getExact("account", "glm-new")?.toJSON()).toEqual({
        properties: { requiresMfjsToolSchema: true },
        enabled: false,
      });
      const oldRevision = facade.getView().revision;
      const beforeWrite = personal.current;
      let entered!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const update = personal.update.bind(personal);
      vi.spyOn(personal, "update").mockImplementationOnce(async (transform) => {
        entered();
        await gate;
        return update(transform);
      });
      const queuedSave = facade.reorderPersonalModels("account", ["glm-new", "glm-next"]);
      const rejectedSave = expect(queuedSave).rejects.toThrow("revision conflict");
      await waiting;
      account.current = {
        ...account.current,
        revision: "account-2",
        providers: new ProviderConfigMap([
          ["account", createAccountProviderConfig({ models: [], entitled: true })],
        ]),
      };
      await registry.refresh("removed-members");
      release();
      await rejectedSave;
      expect(personal.current).toBe(beforeWrite);
      await expect(
        facade.savePersonalModelDraft({
          providerId: "account",
          originalModelId: "glm-new",
          nextModelId: "glm-new",
          personalConfig: {},
          basedOnRevision: oldRevision,
        }),
      ).rejects.toThrow("revision conflict");
      await expect(
        facade.savePersonalModelDraft({
          providerId: "account",
          originalModelId: "glm-new",
          nextModelId: "glm-new",
          personalConfig: {},
          basedOnRevision: facade.getView().revision,
        }),
      ).rejects.toThrow("Model not found");
    } finally {
      registry.dispose();
      service.dispose();
    }
  });

  it("folds the ZCode built-in Source and Personal Repository into one Registry Config Source", async () => {
    const zcodeBuiltin = new MutableSource(
      layerSnapshot(
        "zcodeBuiltin-1",
        new ProviderConfigMap([["zcodeBuiltin", localProvider(["model-a"])]]),
      ),
    );
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([["personal", personalProvider(["model-b"])]]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: zcodeBuiltin,
      personalRepository: personal,
    });

    const snapshot = await service.read();

    expect(snapshot.revision).toBe('["zcodeBuiltin-1","personal-1"]');
    expect(snapshot.zcodeBuiltinRevision).toBe("zcodeBuiltin-1");
    expect(snapshot.personalRevision).toBe("personal-1");
    expect(snapshot.zcodeBuiltinProviders.keys()).toEqual(["zcodeBuiltin"]);
    expect(snapshot.personalProviders.keys()).toEqual(["personal"]);
  });

  it("routes Personal save, delete and reorder through the Repository's atomic update", async () => {
    const zcodeBuiltin = new MutableSource(layerSnapshot("zcodeBuiltin-1"));
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([
          ["Y", personalProvider(["m1", "m2"])],
          ["A", createApiKeyProviderConfig({ group: "standard-personal" })],
          ["X", personalProvider(["m3"])],
          ["Z", personalProvider(["m4"])],
        ]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: zcodeBuiltin,
      personalRepository: personal,
    });

    await service.savePersonalProviderOverlay("Z", personalProvider(["m4"]));
    await service.reorderPersonalProviders(["A", "X", "Y", "Z"]);
    await service.reorderPersonalModels("Y", ["m2", "m1"]);
    await service.deletePersonalProvider("X");

    expect(personal.current.providers.keys()).toEqual(["Y", "A", "Z"]);
    expect(personal.current.providerOrder).toEqual(["A", "Y", "Z"]);
    expect(personal.current.providers.get("Y")?.personalModelIds).toEqual(["m1", "m2"]);
    expect(personal.current.providers.get("Y")?.modelOrder).toEqual(["m2", "m1"]);
  });

  it("creates a modelOrder-only Personal Overlay on first Built-in reorder", async () => {
    const zcodeBuiltin = new MutableSource(
      layerSnapshot(
        "zcodeBuiltin-1",
        new ProviderConfigMap([["builtin", localProvider(["model-a", "model-b"])]]),
      ),
    );
    const personal = new MemoryPersonalRepository(layerSnapshot("personal-1"));
    const service = new ProviderConfigService({
      zcodeBuiltinSource: zcodeBuiltin,
      personalRepository: personal,
    });

    await service.reorderPersonalModels("builtin", ["model-b", "model-a"]);

    expect(personal.current.providers.get("builtin")?.toJSON()).toEqual({
      modelOrder: ["model-b", "model-a"],
    });
  });

  it("ignores stale member fields on plain saves and keeps the Repository's current members", async () => {
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([["personal", personalProvider(["current-model"])]]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });

    await service.savePersonalProviderOverlay(
      "personal",
      createApiKeyProviderConfig({
        group: "standard-personal",
        apiKey: "new-key",
        personalModels: ["stale-model"],
      }),
    );

    expect(personal.current.providers.get("personal")?.personalModelIds).toEqual(["current-model"]);
    expect(personal.current.providers.get("personal")?.access?.toJSON()).toMatchObject({
      type: "api-key",
      apiKey: "new-key",
    });
  });

  it("dedupes Personal members and preserves the Built-in identity when saving the Overlay", async () => {
    const zcodeBuiltinProvider = localProvider(["builtin-model"]);
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([
          [
            "builtin",
            createApiKeyProviderConfig({
              group: null,
              personalModels: ["builtin-model", "personal-model", "personal-model"],
            }),
          ],
        ]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(
        layerSnapshot("zcodeBuiltin-1", new ProviderConfigMap([["builtin", zcodeBuiltinProvider]])),
      ),
      personalRepository: personal,
    });

    await service.savePersonalProviderOverlay(
      "builtin",
      createApiKeyProviderConfig({ group: null, apiKey: "new-key" }),
    );

    expect(personal.current.providers.get("builtin")?.personalModelIds).toEqual(["personal-model"]);
  });

  it("requires explicit creation for Personal-only providers; plain saves never conjure one", async () => {
    const personal = new MemoryPersonalRepository(layerSnapshot("personal-1"));
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });

    await expect(
      service.savePersonalProviderOverlay(
        "personal",
        createApiKeyProviderConfig({ group: "standard-personal", apiKey: "late-key" }),
      ),
    ).rejects.toThrow("not created yet");
    expect(personal.current.providers.has("personal")).toBe(false);
  });

  it("stops Personal Overlays of pinned Account Providers from rewriting Access", async () => {
    const zcodeBuiltin = new MutableSource(
      layerSnapshot(
        "zcodeBuiltin-1",
        new ProviderConfigMap([
          {
            providerId: "account:bigmodel-individual-coding-plan",
            providerName: "BigModel",
            config: createAccountProviderConfig({
              accountType: "bigmodel",
              mode: "individual-coding-plan",
            }),
          },
        ]),
      ),
    );
    const personal = new MemoryPersonalRepository(layerSnapshot("personal-1"));
    const service = new ProviderConfigService({
      zcodeBuiltinSource: zcodeBuiltin,
      personalRepository: personal,
    });

    await expect(
      service.savePersonalProviderOverlay(
        "account:bigmodel-individual-coding-plan",
        createApiKeyProviderConfig({ group: null, apiKey: "family-key" }),
      ),
    ).rejects.toThrow("Pinned-account access");
    expect(personal.current.providers.has("account:bigmodel-individual-coding-plan")).toBe(false);
  });

  it("keeps provider labels unique case-insensitively after trim", async () => {
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([
          {
            providerId: "one",
            providerName: "Demo",
            config: createApiKeyProviderConfig({ group: "standard-personal" }),
          },
          {
            providerId: "two",
            providerName: "Other",
            config: createApiKeyProviderConfig({ group: "standard-personal" }),
          },
        ]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });

    await expect(
      service.savePersonalProviderOverlay(
        "two",
        createApiKeyProviderConfig({ group: "standard-personal" }),
        undefined,
        { providerName: "  dEMo  " },
      ),
    ).rejects.toThrow("Provider name already exists");
  });

  it("lets legacy duplicate names save when no new collision is introduced", async () => {
    const zcodeBuiltin = new MutableSource(
      layerSnapshot(
        "zcodeBuiltin-1",
        new ProviderConfigMap([
          {
            providerId: "deepseek",
            providerName: "DeepSeek",
            config: createApiKeyProviderConfig({ group: "standard-personal", apiKey: "" }),
          },
        ]),
      ),
    );
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([
          {
            providerId: "legacy-one",
            providerName: "Legacy",
            config: createApiKeyProviderConfig({ group: "standard-personal" }),
          },
          {
            providerId: "legacy-two",
            providerName: "Legacy",
            config: createApiKeyProviderConfig({ group: "standard-personal" }),
          },
          ["deepseek", new ProviderConfig()],
        ]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: zcodeBuiltin,
      personalRepository: personal,
    });

    await expect(
      service.savePersonalProviderOverlay(
        "deepseek",
        createApiKeyProviderConfig({
          group: "standard-personal",
          label: "DeepSeek",
          apiKey: "new-key",
        }),
      ),
    ).resolves.toBeDefined();
    expect(personal.current.providers.get("deepseek")?.access?.toJSON()).toMatchObject({
      apiKey: "new-key",
    });
  });

  it("atomically creates the next unclaimed Personal Provider identity", async () => {
    const zcodeBuiltin = new MutableSource(
      layerSnapshot(
        "zcodeBuiltin-1",
        new ProviderConfigMap([["new-provider-2", localProvider(["zcodeBuiltin-model"])]]),
      ),
    );
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([["new-provider", personalProvider(["personal-model"])]]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: zcodeBuiltin,
      personalRepository: personal,
    });

    const created = await service.createPersonalProvider();

    expect(created.providerId).toBe("new-provider-3");
    expect(personal.current.providers.getRule(created.providerId)?.providerName).toBe(
      "new-provider",
    );
    expect(personal.current.providers.keys()).toEqual(["new-provider", "new-provider-3"]);
    expect(personal.current.providers.get("new-provider-3")?.toJSON()).toEqual({
      group: "standard-personal",
      access: { type: "api-key" },
      personalModelIds: [],
      modelOrder: [],
    });
    expect(personal.current.providerOrder).toEqual(["new-provider", "new-provider-3"]);
  });

  it("seeds names from the caller's Template and dedupes during atomic creation", async () => {
    const template = new ProviderTemplate({
      templateId: "deepseek",
      templateNameMap: { "zh-CN": "深度求索", "en-US": "DeepSeek" },
      config: createApiKeyProviderConfig({
        label: "DeepSeek",
        apiFormat: "anthropic-messages",
        baseURL: "https://api.example.com",
        models: ["model-a"],
      }),
    });
    const zcodeBuiltin = new MutableSource({
      ...layerSnapshot("zcodeBuiltin-1"),
      providerTemplates: new ProviderTemplateMap([["deepseek", template]]),
    });
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([
          {
            providerId: "existing",
            providerName: "深度求索",
            config: new ProviderConfig({ group: "standard-personal" }),
          },
        ]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: zcodeBuiltin,
      personalRepository: personal,
    });

    const created = await service.createPersonalProvider({
      templateId: "deepseek",
      locale: "zh-CN",
    });

    expect(personal.current.providers.getRule(created.providerId)).toMatchObject({
      templateId: "deepseek",
      providerName: "深度求索 2",
    });
    await expect(
      service.createPersonalProvider({
        templateId: "deepseek",
        providerName: "DeepSeek",
        initialConfig: new ProviderConfig({ group: "zai-family" }),
      }),
    ).rejects.toThrow();
  });

  it("still yields unique names when the same Template is created concurrently", async () => {
    const template = new ProviderTemplate({
      templateId: "deepseek",
      templateNameMap: { "zh-CN": "深度求索", "en-US": "DeepSeek" },
      config: createApiKeyProviderConfig({
        label: "DeepSeek",
        apiFormat: "anthropic-messages",
        baseURL: "https://api.example.com",
        models: ["model-a"],
      }),
    });
    const personal = new MemoryPersonalRepository(layerSnapshot("personal-1"));
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource({
        ...layerSnapshot("zcodeBuiltin-1"),
        providerTemplates: new ProviderTemplateMap([["deepseek", template]]),
      }),
      personalRepository: personal,
    });

    await Promise.all([
      service.createPersonalProvider({ templateId: "deepseek", locale: "zh-CN" }),
      service.createPersonalProvider({ templateId: "deepseek", locale: "zh-CN" }),
    ]);

    expect(
      personal.current.providers
        .rules()
        .map((rule) => rule.providerName)
        .sort(),
    ).toEqual(["深度求索", "深度求索 2"]);
  });

  it("persists provider order as unsorted-Built-in, requested, unsorted-Personal segments", async () => {
    const zcodeBuiltin = new MutableSource(
      layerSnapshot(
        "zcodeBuiltin-1",
        new ProviderConfigMap([
          ["builtin-a", localProvider(["model-a"])],
          ["builtin-b", localProvider(["model-b"])],
        ]),
      ),
    );
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([
          ["personal-p", personalProvider(["model-p"])],
          ["personal-q", personalProvider(["model-q"])],
        ]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: zcodeBuiltin,
      personalRepository: personal,
    });

    await service.reorderPersonalProviders(["personal-p", "builtin-b", "stale", "personal-p"]);

    expect(personal.current.providerOrder).toEqual(["personal-p", "personal-q"]);
  });

  it("prunes exact model rules when deleting a Personal-only provider", async () => {
    const exact = completeModelConfig();
    const pattern = new ModelConfig({
      properties: new ModelPropertiesConfig({ inputFormat: { supportsImage: true } }),
    });
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([["personal", personalProvider(["model-a"])]]),
        new ModelConfigRules([
          {
            type: "provider-model",
            providerId: "personal",
            modelId: "model-a",
            config: exact,
          },
          {
            type: "model",
            modelMatch: "model-.*",
            config: pattern,
          },
        ]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });

    await service.deletePersonalProvider("personal", true);

    expect(personal.current.providers.get("personal")).toBeUndefined();
    expect(personal.current.models.rules()).toEqual([
      {
        type: "model",
        modelMatch: "model-.*",
        config: pattern,
      },
    ]);
  });

  it("renames a Personal Model atomically, keeping list position and exact config", async () => {
    const modelConfig = completeModelConfig();
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([["personal", personalProvider(["before", "old-model", "after"])]]),
        ModelConfigRules.empty().setExact("personal", "old-model", modelConfig),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });

    await service.renamePersonalModel("personal", "old-model", "new-model");

    expect(personal.current.providers.get("personal")?.personalModelIds).toEqual([
      "before",
      "new-model",
      "after",
    ]);
    expect(personal.current.models.getExact("personal", "old-model")).toBeUndefined();
    expect(personal.current.models.getExact("personal", "new-model")).toEqual(modelConfig);
    expect(personal.current.providers.get("personal")?.modelOrder).toEqual([
      "before",
      "new-model",
      "after",
    ]);
  });

  it("renames a Personal Model and swaps its exact config in one transaction", async () => {
    const oldConfig = new ModelConfig({ enabled: false });
    const nextConfig = manualModelConfig().overlay(
      new ModelConfig({
        properties: new ModelPropertiesConfig({ contextWindow: 256_000 }),
      }),
    );
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([["personal", personalProvider(["before", "old", "after"])]]),
        ModelConfigRules.empty().setExact("personal", "old", oldConfig),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });
    const update = vi.spyOn(personal, "update");

    await service.savePersonalModelDraft(
      "personal",
      "old",
      "next",
      nextConfig,
      "personal-1",
      false,
    );

    expect(update).toHaveBeenCalledTimes(1);
    expect(personal.current.providers.get("personal")?.personalModelIds).toEqual([
      "before",
      "next",
      "after",
    ]);
    expect(personal.current.providers.get("personal")?.modelOrder).toEqual([
      "before",
      "next",
      "after",
    ]);
    expect(personal.current.models.getExact("personal", "old")).toBeUndefined();
    expect(personal.current.models.getExact("personal", "next")).toEqual(nextConfig);
    expect(personal.current.models.getExactRule("personal", "next")?.type).toBe(
      "manual-provider-model",
    );
  });

  it("rejects stale Personal revisions inside the file-locked atomic Model Draft", async () => {
    const personal = new MemoryPersonalRepository(
      layerSnapshot("personal-2", new ProviderConfigMap([["personal", personalProvider(["old"])]])),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });

    await expect(
      service.savePersonalModelDraft(
        "personal",
        "old",
        "next",
        new ModelConfig({ enabled: false }),
        "personal-1",
      ),
    ).rejects.toThrow("Personal Provider Config revision conflict");
    expect(personal.current.providers.get("personal")?.personalModelIds).toEqual(["old"]);
  });

  it("requires pinned modes to be complete on their own and forbids renaming members on rejected commits", async () => {
    const personal = new MemoryPersonalRepository(
      layerSnapshot("personal-1", new ProviderConfigMap([["personal", personalProvider(["old"])]])),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });
    await expect(
      service.savePersonalModelDraft(
        "personal",
        "old",
        "next",
        new ModelConfig({ enabled: false }),
        "personal-1",
        false,
      ),
    ).rejects.toThrow(/properties|optionSpecs|contextWindow/);
    expect(personal.current.revision).toBe("personal-1");
    expect(personal.current.providers.get("personal")?.personalModelIds).toEqual(["old"]);
    expect(personal.current.models.getExact("personal", "next")).toBeUndefined();
  });

  it("cannot bypass completeness checks on existing pinned modes by omitting the mode argument", async () => {
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([["personal", personalProvider(["old"])]]),
        ModelConfigRules.empty().setExact("personal", "old", manualModelConfig(), false),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });
    await expect(
      service.savePersonalModelDraft(
        "personal",
        "old",
        "old",
        new ModelConfig({ enabled: false }),
        "personal-1",
      ),
    ).rejects.toThrow(/properties|optionSpecs|contextWindow/);
    expect(personal.current.revision).toBe("personal-1");
    expect(personal.current.models.getExactRule("personal", "old")?.type).toBe(
      "manual-provider-model",
    );
  });

  it("adds a Personal Model atomically, writing membership and initial exact config together", async () => {
    const modelConfig = completeModelConfig();
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([["personal", personalProvider(["before"])]]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });

    await service.addPersonalModel("personal", "new-model", modelConfig);

    expect(personal.current.providers.get("personal")?.personalModelIds).toEqual([
      "before",
      "new-model",
    ]);
    expect(personal.current.models.getExact("personal", "new-model")).toEqual(modelConfig);
  });

  it("rejects Personal Model adds that would shadow Built-in or existing Personal members", async () => {
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(
        layerSnapshot(
          "zcodeBuiltin-1",
          new ProviderConfigMap([["personal", localProvider(["builtin-model"])]]),
        ),
      ),
      personalRepository: new MemoryPersonalRepository(
        layerSnapshot(
          "personal-1",
          new ProviderConfigMap([["personal", personalProvider(["personal-model"])]]),
        ),
      ),
    });

    await expect(
      service.addPersonalModel("personal", "builtin-model", completeModelConfig()),
    ).rejects.toThrow("Model already exists: personal/builtin-model");
    await expect(
      service.addPersonalModel("personal", "personal-model", completeModelConfig()),
    ).rejects.toThrow("Model already exists: personal/personal-model");
  });

  it("rejectes model renames that would shadow Built-in or existing Personal members", async () => {
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(
        layerSnapshot(
          "zcodeBuiltin-1",
          new ProviderConfigMap([["zcodeBuiltin", localProvider(["managed-model"])]]),
        ),
      ),
      personalRepository: new MemoryPersonalRepository(
        layerSnapshot(
          "personal-1",
          new ProviderConfigMap([
            ["personal", personalProvider(["model-a", "model-b"])],
            ["occupied", personalProvider([])],
          ]),
        ),
      ),
    });

    await expect(service.renamePersonalModel("personal", "model-a", "model-b")).rejects.toThrow(
      "Model already exists: personal/model-b",
    );
  });

  it("lets the migration boundary atomically replace a complete Personal Overlay", async () => {
    const personal = new MemoryPersonalRepository(layerSnapshot("personal-1"));
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });
    const providers = new ProviderConfigMap([["personal", personalProvider(["model-a"])]]);
    const models = new ModelConfigRules([
      {
        type: "model",
        modelMatch: "model-a",
        config: completeModelConfig(),
      },
    ]);

    await service.replacePersonalConfig({ providers, models });

    expect(personal.current.providers).toBe(providers);
    expect(personal.current.models).toBe(models);
  });

  it("deletes membership and exact rules atomically with the Personal Model", async () => {
    const exact = completeModelConfig();
    const pattern = new ModelConfig({
      properties: new ModelPropertiesConfig({ contextWindow: 64_000 }),
    });
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([["personal", personalProvider(["keep", "remove"])]]),
        new ModelConfigRules([
          { type: "provider-model", providerId: "personal", modelId: "remove", config: exact },
          { type: "model", modelMatch: ".*", config: pattern },
        ]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });

    await service.deletePersonalModel("personal", "remove");

    expect(personal.current.providers.get("personal")?.personalModelIds).toEqual(["keep"]);
    expect(personal.current.models.getExact("personal", "remove")).toBeUndefined();
    expect(personal.current.models.rules()).toContainEqual({
      type: "model",
      modelMatch: ".*",
      config: pattern,
    });
  });

  it("never touches Model Rules when saving a Personal Provider", async () => {
    const pattern = new ModelConfig({
      properties: new ModelPropertiesConfig({ inputFormat: { supportsImage: true } }),
    });
    const stale = new ModelConfig({
      properties: new ModelPropertiesConfig({ contextWindow: 100_000 }),
    });
    const other = new ModelConfig({
      properties: new ModelPropertiesConfig({ contextWindow: 300_000 }),
    });
    const providerPattern = new ModelConfig({
      properties: new ModelPropertiesConfig({ inputFormat: { supportsPdf: true } }),
    });
    const personal = new MemoryPersonalRepository(
      layerSnapshot(
        "personal-1",
        new ProviderConfigMap([
          ["personal", personalProvider(["stale-model"])],
          ["other", personalProvider(["other-model"])],
        ]),
        new ModelConfigRules([
          { type: "model", modelMatch: ".*", config: pattern },
          {
            type: "model",
            modelMatch: "model-.*",
            config: providerPattern,
          },
          {
            type: "model",
            modelMatch: "stale-model",
            config: stale,
          },
          {
            type: "model",
            modelMatch: "other-model",
            config: other,
          },
        ]),
      ),
    );
    const service = new ProviderConfigService({
      zcodeBuiltinSource: new MutableSource(layerSnapshot("zcodeBuiltin-1")),
      personalRepository: personal,
    });

    await service.savePersonalProviderOverlay("personal", personalProvider(["model-a"]));

    expect(personal.current.providers.get("personal")?.personalModelIds).toEqual(["stale-model"]);
    expect(personal.current.models.rules()).toEqual([
      { type: "model", modelMatch: ".*", config: pattern },
      {
        type: "model",
        modelMatch: "model-.*",
        config: providerPattern,
      },
      { type: "model", modelMatch: "stale-model", config: stale },
      { type: "model", modelMatch: "other-model", config: other },
    ]);
  });

  it("drives a Registry refresh of the injected Service on upstream-change notifications", async () => {
    const zcodeBuiltin = new MutableSource(
      layerSnapshot(
        "zcodeBuiltin-1",
        new ProviderConfigMap([["local", localProvider(["model-a"])]]),
        new ModelConfigRules([{ type: "model", modelMatch: ".*", config: completeModelConfig() }]),
      ),
    );
    const personal = new MemoryPersonalRepository(layerSnapshot("personal-1"));
    const configService = new ProviderConfigService({
      zcodeBuiltinSource: zcodeBuiltin,
      personalRepository: personal,
    });
    const accountSource = new MutableSource<AccountProviderConfigSnapshot>({
      revision: "account-1",
      basedOnZCodeBuiltinRevision: "zcodeBuiltin-1",
      providers: ProviderConfigMap.empty(),
    });
    const registry = new ProviderRegistryService({
      configSource: configService,
      accountSource,
    });
    const changed = vi.fn();
    registry.onDidChange(changed);
    await registry.start();

    zcodeBuiltin.current = layerSnapshot(
      "zcodeBuiltin-2",
      new ProviderConfigMap([["local", localProvider(["model-b"])]]),
      new ModelConfigRules([{ type: "model", modelMatch: ".*", config: completeModelConfig() }]),
    );
    zcodeBuiltin.emit("catalog-updated");
    accountSource.current = {
      revision: "account-2",
      basedOnZCodeBuiltinRevision: "zcodeBuiltin-2",
      providers: ProviderConfigMap.empty(),
    };
    accountSource.emit("builtin-recomputed");

    await vi.waitFor(() => expect(registry.getModel("local", "model-b")).toBeDefined());
    expect(changed).toHaveBeenCalledTimes(2);
  });
});
