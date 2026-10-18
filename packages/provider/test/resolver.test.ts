import { describe, expect, it } from "vitest";
import {
  ModelConfig,
  ModelConfigRules,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
  ProviderTemplateMap,
  createRegistryModelConfig,
  createRegistryProviderConfig,
  parsePersonalProviderConfigMap,
  parseProviderConfigMap,
  ZhipuAccountAccessConfig,
  resolveAccountProviderConfigs,
} from "../src/index.js";
import {
  createAccountProviderConfig,
  createApiKeyProviderConfig,
} from "./provider-config-fixtures.js";

function completeModelConfig(
  patch: Partial<ConstructorParameters<typeof ModelPropertiesConfig>[0]> = {},
): ModelConfig {
  return new ModelConfig({
    enabled: true,

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
      ...patch,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      reasoningLevel: { values: ["disabled"], map: "{}" },
      maxOutputTokens: {
        max: 32_000,
        map: "{'max_tokens': maxOutputTokens}",
      },
    }),
  });
}

describe("ProviderConfigResolver", () => {
  it.each([
    [true, true, true, true],
    [false, true, true, true],
    [false, false, true, false],
    [false, true, false, false],
    [true, false, true, false],
    [true, true, false, false],
  ])(
    "legacy account enabled=%s no longer disables, while entitled=%s current=%s still gate execution",
    (enabled, entitled, current, executable) => {
      const providers = new ProviderConfigMap([
        [
          "account",
          createAccountProviderConfig({
            apiFormat: "anthropic-messages",
            baseURL: "https://example.com",
            models: ["m"],
          }),
        ],
      ]);
      const personal = new ProviderConfigMap([
        { providerId: "account", enabled, config: new ProviderConfig({}) },
      ]);
      const result = new ProviderConfigResolver().resolve({
        zcodeBuiltinProviders: providers,
        personalProviders: parseProviderConfigMap(personal.toJSON()),
        accountProviders: new ProviderConfigMap([
          ["account", new ProviderConfig({ access: new ZhipuAccountAccessConfig({ entitled }) })],
        ]),
        accountStates: {
          account: { availability: entitled ? "available" : "unavailable", entitled, current },
        },
        personalModels: ModelConfigRules.empty(),
        zcodeBuiltinModelRules: new ModelConfigRules([
          { type: "model", modelMatch: ".*", config: completeModelConfig() },
        ]),
      });
      expect(result.resolvedProviders[0]).toMatchObject({
        enabled: true,
        models: [{ enabled: true, executable }],
      });
      expect(result.registryProviders.map((p) => p.providerId)).toEqual(
        executable ? ["account"] : [],
      );
    },
  );
  it.each(["zai", "bigmodel"] as const)(
    "%s account modes ignore the legacy global disable but honor model disables",
    (accountType) => {
      for (const mode of [
        "start-plan",
        "individual-coding-plan",
        "team-coding-plan",
        "off-peak",
      ] as const) {
        const account = createAccountProviderConfig({
          accountType,
          mode,
          entitled: true,
          apiFormat: "anthropic-messages",
          baseURL: "https://example.com",
          models: ["m"],
        });
        const result = new ProviderConfigResolver().resolve({
          zcodeBuiltinProviders: new ProviderConfigMap([["account", account]]),
          personalProviders: new ProviderConfigMap([
            { providerId: "account", enabled: false, config: new ProviderConfig({}) },
          ]),
          accountProviders: ProviderConfigMap.empty(),
          personalModels: ModelConfigRules.empty(),
          zcodeBuiltinModelRules: new ModelConfigRules([
            {
              type: "model",
              modelMatch: ".*",
              config: completeModelConfig().overlay(new ModelConfig({ enabled: false })),
            },
          ]),
        });
        expect(result.resolvedProviders[0]).toMatchObject({
          enabled: true,
          models: [{ enabled: false, executable: false }],
        });
        expect(result.registryProviders).toEqual([]);
      }
    },
  );
  it.each([
    [undefined, true, true, true],
    [false, true, true, false],
    [true, false, true, false],
    [true, true, false, false],
  ] as const)(
    "centralized admission for Provider enabled=%s, key=%s, model=%s",
    (enabled, key, modelEnabled, executable) => {
      const config = createApiKeyProviderConfig({
        apiFormat: "anthropic-messages",
        baseURL: "https://example.com",
        apiKey: key ? "fixture" : "",
        models: ["m"],
      });
      const result = new ProviderConfigResolver().resolve({
        zcodeBuiltinProviders: ProviderConfigMap.empty(),
        accountProviders: ProviderConfigMap.empty(),
        personalProviders: new ProviderConfigMap([{ providerId: "p", enabled, config }]),
        personalModels: ModelConfigRules.empty(),
        zcodeBuiltinModelRules: new ModelConfigRules([
          {
            type: "model",
            modelMatch: ".*",
            config: completeModelConfig().overlay(new ModelConfig({ enabled: modelEnabled })),
          },
        ]),
      });
      expect(result.resolvedProviders[0]?.enabled).toBe(enabled ?? true);
      expect(result.resolvedProviders[0]?.models).toHaveLength(1);
      expect(result.resolvedProviders[0]?.models[0]?.enabled).toBe(modelEnabled);
      expect(result.registryProviders.length > 0).toBe(executable);
    },
  );
  it("keeps Start dynamic members out of Individual/API on the same endpoint and isolates same-name members per provider", () => {
    const api = { apiFormat: "anthropic-messages" as const, baseURL: "https://same.example/v1" };
    const providers = new ProviderConfigMap([
      ["start", createAccountProviderConfig({ ...api, mode: "start-plan", models: ["stale"] })],
      [
        "individual",
        createAccountProviderConfig({ ...api, models: ["shared", "individual-only"] }),
      ],
      [
        "api",
        createApiKeyProviderConfig({ ...api, apiKey: "fixture", models: ["shared", "api-only"] }),
      ],
    ]);
    const result = new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: providers,
      personalProviders: ProviderConfigMap.empty(),
      personalModels: ModelConfigRules.empty(),
      zcodeBuiltinModelRules: new ModelConfigRules([
        { type: "model", modelMatch: ".*", config: completeModelConfig() },
      ]),
      accountProviders: resolveAccountProviderConfigs({
        configuredProviders: providers,
        previousProviders: ProviderConfigMap.empty(),
        connections: [
          { providerId: "start", status: "available", models: ["shared", "start-only"] },
          { providerId: "individual", status: "available" },
        ],
      }),
      accountStates: {
        start: { availability: "available", entitled: true, current: true },
        individual: { availability: "available", entitled: true, current: false },
      },
    });
    const members = (id: string) =>
      result.resolvedProviders.find((p) => p.providerId === id)?.models.map((m) => m.modelId);
    expect(members("start")).toEqual(["shared", "start-only"]);
    expect(members("individual")).toEqual(["shared", "individual-only"]);
    expect(members("api")).toEqual(["shared", "api-only"]);
    expect(result.registryProviders.map((p) => p.providerId)).toEqual(["start", "api"]);
  });

  it("keeps unselected accounts Settings-only outside the Registry; API and hidden off-peak never use current", () => {
    const base = {
      group: "bigmodel-family" as const,
      builtinModelIds: ["m"],
      api: new ProviderApiConfig({ type: "anthropic-messages", baseUrl: "https://example.com" }),
    };
    const result = new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: new ProviderConfigMap([
        [
          "account",
          new ProviderConfig({
            ...base,
            access: new ZhipuAccountAccessConfig({
              accountType: "bigmodel",
              mode: "individual-coding-plan",
            }),
          }),
        ],
        [
          "idle",
          new ProviderConfig({
            ...base,
            visibility: "hidden",
            access: new ZhipuAccountAccessConfig({ accountType: "bigmodel", mode: "off-peak" }),
          }),
        ],
        [
          "api",
          new ProviderConfig({
            ...base,
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey: "key" }),
          }),
        ],
      ]),
      personalProviders: ProviderConfigMap.empty(),
      personalModels: ModelConfigRules.empty(),
      zcodeBuiltinModelRules: new ModelConfigRules([
        { type: "model", modelMatch: ".*", config: completeModelConfig() },
      ]),
      accountProviders: new ProviderConfigMap(
        ["account", "idle"].map((id) => [
          id,
          new ProviderConfig({ access: new ZhipuAccountAccessConfig({ entitled: true }) }),
        ]),
      ),
      accountStates: {
        account: { availability: "available", entitled: true, current: false },
        idle: { availability: "available", entitled: true },
      },
    });
    expect(
      result.resolvedProviders.find((provider) => provider.providerId === "account")?.config.access
        ?.entitled,
    ).toBe(true);
    expect(result.registryProviders.map((provider) => provider.providerId)).toEqual([
      "idle",
      "api",
    ]);
    expect(
      result.resolvedProviders.find((provider) => provider.providerId === "idle")?.models[0],
    ).toMatchObject({ executable: true, selectable: false });
  });
  it("lets only validated entrypoints construct the complete Registry type", () => {
    const provider = createRegistryProviderConfig(new ProviderConfig({}), ["providers", "bad"]);
    const model = createRegistryModelConfig(new ModelConfig({}), [
      "providers",
      "bad",
      "models",
      "bad",
    ]);

    expect(provider).toMatchObject({ ok: false, issues: expect.any(Array) });
    expect(model).toMatchObject({ ok: false, issues: expect.any(Array) });
  });

  it("prefers Built-in on name collisions across member sets while Personal-exclusive rules still override later", () => {
    const builtin = completeModelConfig({ contextWindow: 100_000 });
    const result = new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: new ProviderConfigMap([
        [
          "provider-a",
          new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey: "test-key" }),
            api: new ProviderApiConfig({
              type: "openai-responses",
              baseUrl: "https://api.example.com/v1",
            }),
            builtinModelIds: ["model-a"],
          }),
        ],
      ]),
      personalProviders: new ProviderConfigMap([
        ["provider-a", new ProviderConfig({ personalModelIds: ["model-a"] })],
      ]),
      zcodeBuiltinModelRules: new ModelConfigRules([
        { type: "provider-model", providerId: "provider-a", modelId: "model-a", config: builtin },
      ]),
      personalModels: new ModelConfigRules([
        {
          type: "provider-model",
          providerId: "provider-a",
          modelId: "model-a",
          config: new ModelConfig({
            // Personal supports exact overrides only; do not build tests from the already-removed global match.
            properties: new ModelPropertiesConfig({
              contextWindow: 999_999,
              supportsToolCall: false,
            }),
          }),
        },
      ]),
      accountProviders: ProviderConfigMap.empty(),
    });

    const candidate = result.resolvedProviders[0]?.models[0];
    expect(candidate).toMatchObject({
      kind: "candidate",
      source: "builtin",
      executable: true,
      selectable: true,
    });
    expect(candidate?.kind === "candidate" && candidate.config.properties).toMatchObject({
      contextWindow: 999_999,
      supportsToolCall: false,
    });
    expect(result.registryProviders[0]?.models[0]?.config.properties.contextWindow).toBe(999_999);
  });

  it("lets an unrelated invalid Personal endpoint block nothing else in the same file", () => {
    const personalProviders = parsePersonalProviderConfigMap({
      providerRules: [
        {
          providerId: "broken",
          config: {
            group: "standard-personal",
            access: { type: "api-key", apiKey: "broken-key" },
            api: { type: "openai-chat-completions", baseUrl: "testtest" },
            personalModelIds: ["broken-model"],
          },
        },
        {
          providerId: "valid",
          config: {
            group: "standard-personal",
            access: { type: "api-key", apiKey: "valid-key" },
            api: { type: "openai-chat-completions", baseUrl: "https://api.example.com/v1" },
            personalModelIds: ["valid-model"],
          },
        },
      ],
    });
    const result = new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: ProviderConfigMap.empty(),
      personalProviders,
      zcodeBuiltinModelRules: new ModelConfigRules([
        { type: "model", modelMatch: ".*", config: completeModelConfig() },
      ]),
      personalModels: ModelConfigRules.empty(),
      accountProviders: ProviderConfigMap.empty(),
    });

    expect(result.registryProviders.map((provider) => provider.providerId)).toEqual(["valid"]);
    const brokenProvider = result.resolvedProviders.find(
      (provider) => provider.providerId === "broken",
    );
    expect(brokenProvider?.providerIssues.some((issue) => issue.code === "invalid-url")).toBe(true);
  });

  it("keeps providers with missing Templates out of the Registry and surfaces the issue in global diagnostics", () => {
    const result = new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: ProviderConfigMap.empty(),
      zcodeBuiltinProviderTemplates: ProviderTemplateMap.empty(),
      personalProviders: new ProviderConfigMap([
        {
          providerId: "missing-template-provider",
          templateId: "missing-template",
          config: new ProviderConfig({ group: "standard-personal", personalModelIds: ["model-a"] }),
        },
      ]),
      zcodeBuiltinModelRules: new ModelConfigRules([
        { type: "model", modelMatch: ".*", config: completeModelConfig() },
      ]),
      personalModels: ModelConfigRules.empty(),
      accountProviders: ProviderConfigMap.empty(),
    });

    expect(result.registryProviders).toEqual([]);
    expect(result.resolvedProviders[0]?.providerIssues).toContainEqual({
      code: "missing-template",
      path: ["providers", "missing-template-provider", "templateId"],
      message: "Provider template not found: missing-template",
    });
    expect(result.issues).toContainEqual({
      code: "missing-template",
      path: ["providers", "missing-template-provider", "templateId"],
      message: "Provider template not found: missing-template",
    });
  });

  it("publishes hidden providers' enabled models to the Registry and keeps disabled ones in Settings Resolution only", () => {
    const result = new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: new ProviderConfigMap([
        [
          "provider-a",
          new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey: "test-key" }),
            api: new ProviderApiConfig({
              type: "openai-responses",
              baseUrl: "https://api.example.com/v1",
            }),
            builtinModelIds: ["enabled", "disabled"],
            visibility: "hidden",
          }),
        ],
      ]),
      personalProviders: ProviderConfigMap.empty(),
      zcodeBuiltinModelRules: new ModelConfigRules([
        { type: "model", modelMatch: ".*", config: completeModelConfig() },
        { type: "model", modelMatch: "disabled", config: new ModelConfig({ enabled: false }) },
      ]),
      personalModels: ModelConfigRules.empty(),
      accountProviders: ProviderConfigMap.empty(),
    });

    expect(result.registryProviders[0]?.models.map((model) => model.modelId)).toEqual(["enabled"]);
    expect(result.resolvedProviders[0]?.models).toMatchObject([
      { modelId: "enabled", executable: true, selectable: false },
      { modelId: "disabled", executable: false, selectable: false },
    ]);
  });

  it("narrows Config at the single completeness boundary and has the Registry retain the same object reference", () => {
    const providerConfig = new ProviderConfig({
      group: "standard-personal",
      access: new ApiKeyAccessConfig({ apiKey: "test-key" }),
      api: new ProviderApiConfig({
        type: "openai-responses",
        baseUrl: "https://api.example.com/v1",
      }),
      builtinModelIds: ["model-a"],
    });
    const modelConfig = completeModelConfig();
    const result = new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: new ProviderConfigMap([["provider-a", providerConfig]]),
      personalProviders: ProviderConfigMap.empty(),
      zcodeBuiltinModelRules: new ModelConfigRules([
        { type: "model", modelMatch: "model-a", config: modelConfig },
      ]),
      personalModels: ModelConfigRules.empty(),
      accountProviders: ProviderConfigMap.empty(),
    });

    expect(result.registryProviders[0]?.config).toBe(providerConfig);
    expect(result.effectiveBuiltinProviders.get("provider-a")).toBe(providerConfig);
    const resolvedModel = result.resolvedProviders[0]?.models[0];
    expect(result.registryProviders[0]?.models[0]?.config).toBe(
      resolvedModel?.kind === "candidate" ? resolvedModel.config : undefined,
    );
    expect(
      resolvedModel?.kind === "candidate" ? resolvedModel.effectiveBuiltinConfig : undefined,
    ).toEqual(modelConfig);
    expect(result.registryProviders[0]?.models[0]?.config.properties.requiresMfjsToolSchema).toBe(
      false,
    );
  });

  it("matches Built-in rules on full strings and lets later hits override earlier fields", () => {
    const resolver = new ProviderConfigResolver();
    const result = resolver.resolve({
      zcodeBuiltinProviders: new ProviderConfigMap([
        [
          "zai",
          new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey: "test-key" }),
            api: new ProviderApiConfig({
              type: "anthropic-messages",
              baseUrl: "https://api.example.com",
            }),
            builtinModelIds: ["glm-5", "glm-50"],
          }),
        ],
      ]),
      personalProviders: ProviderConfigMap.empty(),
      zcodeBuiltinModelRules: new ModelConfigRules([
        { type: "model", modelMatch: ".*", config: completeModelConfig() },
        {
          type: "model",
          modelMatch: "glm-5",
          config: new ModelConfig({
            properties: new ModelPropertiesConfig({ inputFormat: { supportsImage: true } }),
          }),
        },
        {
          type: "model",
          modelMatch: "glm-5",
          config: new ModelConfig({
            properties: new ModelPropertiesConfig({ contextWindow: 1_000_000 }),
          }),
        },
      ]),
      personalModels: ModelConfigRules.empty(),
      accountProviders: ProviderConfigMap.empty(),
    });

    expect(result.registryProviders[0]?.models[0]?.modelId).toBe("glm-5");
    expect(result.registryProviders[0]?.models[0]?.config.properties).toMatchObject({
      contextWindow: 1_000_000,
      inputFormat: expect.objectContaining({ supportsImage: true }),
    });
    expect(
      result.registryProviders[0]?.models[1]?.config.properties?.inputFormat?.supportsImage,
    ).toBe(false);
  });

  it("resolves endpoint-specialized rules via the Effective Provider baseURL", () => {
    const result = new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: new ProviderConfigMap([
        [
          "provider-a",
          new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey: "test-key" }),
            api: new ProviderApiConfig({
              type: "openai-responses",
              baseUrl: "https://api.example.com/v1",
            }),
            builtinModelIds: ["model-a"],
          }),
        ],
      ]),
      accountProviders: ProviderConfigMap.empty(),
      personalProviders: ProviderConfigMap.empty(),
      zcodeBuiltinModelRules: new ModelConfigRules([
        { type: "model", modelMatch: ".*", config: completeModelConfig() },
        {
          type: "provider-site",
          modelMatch: "model-a",
          baseUrlMatch: "https://api\\.example\\.com/v1",
          config: new ModelConfig({
            properties: new ModelPropertiesConfig({ contextWindow: 1_000_000 }),
          }),
        },
      ]),
      personalModels: ModelConfigRules.empty(),
    });

    expect(result.registryProviders[0]?.models[0]?.config.properties.contextWindow).toBe(1_000_000);
  });

  it("applies model-common options first, then overrides the raw request map per provider apiFormat", () => {
    const resolver = new ProviderConfigResolver();
    const result = resolver.resolve({
      zcodeBuiltinProviders: new ProviderConfigMap([
        [
          "anthropic-provider",
          new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey: "test-key" }),
            api: new ProviderApiConfig({
              type: "anthropic-messages",
              baseUrl: "https://anthropic.example.com",
            }),
            builtinModelIds: ["kimi-k3"],
          }),
        ],
        [
          "openai-provider",
          new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey: "test-key" }),
            api: new ProviderApiConfig({
              type: "openai-chat-completions",
              baseUrl: "https://openai.example.com",
            }),
            builtinModelIds: ["kimi-k3"],
          }),
        ],
      ]),
      personalProviders: ProviderConfigMap.empty(),
      zcodeBuiltinModelRules: new ModelConfigRules([
        {
          type: "model",
          modelMatch: "kimi-k3",
          config: completeModelConfig().overlay(
            new ModelConfig({
              optionSpecs: new ModelOptionSpecsConfig({
                reasoningLevel: {
                  values: ["low", "high"],
                },
              }),
            }),
          ),
        },
        {
          type: "model-api",
          modelMatch: "kimi-k3",
          apiTypeMatch: "anthropic-messages",
          config: new ModelConfig({
            optionSpecs: new ModelOptionSpecsConfig({
              reasoningLevel: {
                map: "{'thinking': {'type': reasoningLevel == 'high' ? 'enabled' : 'disabled'}}",
              },
            }),
          }),
        },
        {
          type: "model-api",
          modelMatch: "kimi-k3",
          apiTypeMatch: "openai-chat-completions",
          config: new ModelConfig({
            optionSpecs: new ModelOptionSpecsConfig({
              reasoningLevel: { map: "{'reasoning_effort': reasoningLevel}" },
            }),
          }),
        },
      ]),
      personalModels: ModelConfigRules.empty(),
      accountProviders: ProviderConfigMap.empty(),
    });

    expect(result.registryProviders[0]?.models[0]?.config.optionSpecs.reasoningLevel?.map).toBe(
      "{'thinking': {'type': reasoningLevel == 'high' ? 'enabled' : 'disabled'}}",
    );
    expect(result.registryProviders[1]?.models[0]?.config.optionSpecs.reasoningLevel?.map).toBe(
      "{'reasoning_effort': reasoningLevel}",
    );
  });

  it("layers providers Built-in -> Account -> Personal with Personal overriding account model membership last", () => {
    const resolver = new ProviderConfigResolver();
    const providerApi = new ProviderApiConfig({
      type: "anthropic-messages",
      baseUrl: "https://api.example.com",
    });
    const providerBase = {
      group: "zai-family" as const,
      access: new ZhipuAccountAccessConfig({
        accountType: "zai",
        mode: "individual-coding-plan",
      }),
      api: providerApi,
      builtinModelIds: ["m1", "m2"],
    };
    const result = resolver.resolve({
      zcodeBuiltinProviders: new ProviderConfigMap([
        ["account", new ProviderConfig(providerBase)],
        [
          "api",
          new ProviderConfig({
            ...providerBase,
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey: "test-key" }),
          }),
        ],
      ]),
      personalProviders: new ProviderConfigMap([
        [
          "account",
          new ProviderConfig({
            personalModelIds: ["m1"],
          }),
        ],
      ]),
      zcodeBuiltinModelRules: new ModelConfigRules([
        { type: "model", modelMatch: ".*", config: completeModelConfig() },
      ]),
      personalModels: ModelConfigRules.empty(),
      accountProviders: new ProviderConfigMap([
        [
          "account",
          new ProviderConfig({
            access: new ZhipuAccountAccessConfig({
              entitled: true,
            }),
            builtinModelIds: ["m2"],
          }),
        ],
      ]),
    });

    expect(result.registryProviders.map((provider) => provider.providerId)).toEqual([
      "account",
      "api",
    ]);
    expect(result.registryProviders[0]?.models.map((model) => model.modelId)).toEqual(["m2", "m1"]);
    expect(result.registryProviders[0]?.config).toMatchObject({
      access: { type: "zhipu-account" },
      builtinModelIds: ["m2"],
      personalModelIds: ["m1"],
    });
    expect(result.registryProviders[1]?.models.map((model) => model.modelId)).toEqual(["m1", "m2"]);
  });

  it("requires a Personal API key for API providers and keeps AccountProvider auth out of static config", () => {
    const resolver = new ProviderConfigResolver();
    const providerBase = {
      group: "standard-personal" as const,
      api: new ProviderApiConfig({
        type: "anthropic-messages",
        baseUrl: "https://api.example.com",
      }),
      builtinModelIds: ["m1"],
    };
    const result = resolver.resolve({
      zcodeBuiltinProviders: new ProviderConfigMap([
        ["missing-key", new ProviderConfig(providerBase)],
        ["configured", new ProviderConfig(providerBase)],
        ["account", new ProviderConfig(providerBase)],
      ]),
      personalProviders: new ProviderConfigMap([
        [
          "configured",
          new ProviderConfig({
            access: new ApiKeyAccessConfig({ apiKey: "personal-key" }),
          }),
        ],
      ]),
      zcodeBuiltinModelRules: new ModelConfigRules([
        { type: "model", modelMatch: ".*", config: completeModelConfig() },
      ]),
      personalModels: ModelConfigRules.empty(),
      accountProviders: new ProviderConfigMap([
        [
          "account",
          new ProviderConfig({
            group: "standard-personal",
            access: new ZhipuAccountAccessConfig({
              accountType: "zai",
              mode: "individual-coding-plan",
              entitled: true,
            }),
            builtinModelIds: ["m1"],
          }),
        ],
      ]),
    });

    expect(result.registryProviders.map((provider) => provider.providerId)).toEqual([
      "configured",
      "account",
    ]);
    expect(result.issues).toContainEqual({
      code: "required-field-missing",
      path: ["providers", "missing-key", "access"],
      message: "Missing required config providers.missing-key.access",
    });
  });

  it("publishes only complete providers with enabled models and retains resolution issues", () => {
    const resolver = new ProviderConfigResolver();
    const result = resolver.resolve({
      zcodeBuiltinProviders: new ProviderConfigMap([
        [
          "valid",
          new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey: "test-key" }),
            api: new ProviderApiConfig({
              type: "openai-responses",
              baseUrl: "https://api.example.com",
            }),
            builtinModelIds: ["ok", "missing-config"],
          }),
        ],
        ["incomplete", new ProviderConfig({ group: "standard-personal", builtinModelIds: ["ok"] })],
      ]),
      personalProviders: ProviderConfigMap.empty(),
      zcodeBuiltinModelRules: new ModelConfigRules([
        { type: "model", modelMatch: "ok", config: completeModelConfig() },
      ]),
      personalModels: ModelConfigRules.empty(),
      accountProviders: ProviderConfigMap.empty(),
    });

    expect(result.registryProviders.map((provider) => provider.providerId)).toEqual(["valid"]);
    expect(result.registryProviders[0]?.models.map((model) => model.modelId)).toEqual(["ok"]);
    expect(result.issues.map((issue) => issue.path.join("."))).toEqual(
      expect.arrayContaining([
        "providers.incomplete.access",
        "providers.incomplete.api",
        "providers.valid.models.missing-config.properties",
      ]),
    );
  });
});
