import { readFile } from "node:fs/promises";
import { compileModelOptionMaps } from "@zcode/model-option-map";
import { fileURLToPath } from "node:url";
import {
  ApiKeyAccessConfig,
  ModelConfigRules,
  ProviderConfig,
  ProviderApiConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
  ZhipuAccountAccessConfig,
} from "@zcode/provider";
import { describe, expect, it } from "vitest";
import { NodeZCodeBuiltinProviderConfigSource } from "../src/index.js";

// Release verification must target the final uploaded file, never quietly check repo sources by default.
const zcodeBuiltinProviderConfigFilePath =
  process.env.ZCODE_BUILTIN_RELEASE_TEST_FILE?.trim() ||
  fileURLToPath(new URL("../../../config/provider/zcode-builtin.json", import.meta.url));

function reasoningPatch(map: string, reasoningLevel: string) {
  return compileModelOptionMaps({ reasoningLevel: { map }, maxOutputTokens: { map: "{}" } }).apply(
    {},
    { reasoningLevel, maxOutputTokens: 32000 },
  );
}

describe("ZCode Built-in Provider Config integrity", () => {
  it.each(["anthropic-messages", "openai-chat-completions", "openai-responses"] as const)(
    "unknown models keep the full two-tier fallback under %s and stay Registry-eligible",
    async (apiType) => {
      const source = new NodeZCodeBuiltinProviderConfigSource({
        bundledFilePath: zcodeBuiltinProviderConfigFilePath,
        watch: false,
      });
      try {
        const snapshot = await source.read();
        const model = snapshot.models.resolve({
          providerId: "unknown-provider",
          modelId: "future-unknown-model",
          apiType,
          baseUrl: "https://unknown.example/v1",
        });
        expect(model.validateComplete()).toEqual([]);
        expect(model.optionSpecs?.maxOutputTokens?.max).toBe(32_000);
        expect(model.optionSpecs?.reasoningLevel?.values).toEqual(["disabled", "enabled"]);
        expect(model.properties?.inputFormat.supportsImage).toBe(false);
        const result = new ProviderConfigResolver().resolve({
          zcodeBuiltinProviders: snapshot.providers,
          zcodeBuiltinProviderTemplates: snapshot.providerTemplates,
          accountProviders: ProviderConfigMap.empty(),
          zcodeBuiltinModelRules: snapshot.models,
          personalModels: ModelConfigRules.empty(),
          personalProviders: new ProviderConfigMap([
            [
              "unknown-provider",
              new ProviderConfig({
                group: "standard-personal",
                api: new ProviderApiConfig({
                  type: apiType,
                  baseUrl: "https://unknown.example/v1",
                }),
                access: new ApiKeyAccessConfig({ apiKey: "test-only" }),
                personalModelIds: ["future-unknown-model"],
              }),
            ],
          ]),
        });
        expect(
          result.registryProviders
            .find((entry) => entry.providerId === "unknown-provider")
            ?.models.map((entry) => entry.modelId),
        ).toContain("future-unknown-model");
      } finally {
        source.dispose();
      }
    },
  );
  it("keeps GLM-5.3-Flash media inputs and the GLM-5.3 plan bridge explicit", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: zcodeBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const snapshot = await source.read();
      const rawRelease = JSON.parse(await readFile(zcodeBuiltinProviderConfigFilePath, "utf8")) as {
        revision: number;
        config: { modelConfigRules: Record<string, unknown> };
      };
      expect(rawRelease.config.modelConfigRules).toMatchObject({
        modelRules: expect.any(Array),
        modelApiRules: expect.any(Array),
        providerSiteRules: expect.any(Array),
        templateModelRules: expect.any(Array),
        builtinProviderModelRules: expect.any(Array),
      });
      expect(rawRelease.config.modelConfigRules).not.toHaveProperty("matchRules");
      expect(snapshot.revision).toMatch(
        new RegExp(`^zcode-builtin:${rawRelease.revision}:[a-f0-9]{64}$`, "u"),
      );
      const apiTemplateIds = [
        "zai-api",
        "bigmodel-api",
        "zai-standard-api",
        "bigmodel-standard-api",
      ] as const;
      const accountProviderIds = [
        "account:zai-individual-coding-plan",
        "account:zai-team-coding-plan",
        "account:zai-start-plan",
        "account:bigmodel-individual-coding-plan",
        "account:bigmodel-team-coding-plan",
        "account:bigmodel-start-plan",
        "account:zai-offpeak-idle-plan",
        "account:bigmodel-offpeak-idle-plan",
      ] as const;
      for (const templateId of apiTemplateIds) {
        const modelIds = snapshot.providerTemplates?.get(templateId)?.config.builtinModelIds ?? [];
        expect(modelIds, `${templateId} must provide the GLM-5.3 family as well`).toEqual(
          expect.arrayContaining(["GLM-5.3", "GLM-5.3-Flash"]),
        );
      }
      for (const providerId of accountProviderIds) {
        const modelIds = snapshot.providers.get(providerId)?.builtinModelIds ?? [];
        expect(modelIds, `${providerId} must provide GLM-5.3-Flash`).toContain("GLM-5.3-Flash");
      }

      for (const providerId of [
        "account:zai-individual-coding-plan",
        "account:zai-team-coding-plan",
        "account:bigmodel-individual-coding-plan",
        "account:bigmodel-team-coding-plan",
      ]) {
        expect(snapshot.providers.get(providerId)?.builtinModelIds).toEqual([
          "GLM-5.3",
          "GLM-5.3-Flash",
        ]);
        const planModel = snapshot.models.resolve({
          providerId,
          modelId: "GLM-5.3",
          apiType: "anthropic-messages",
          baseUrl: snapshot.providers.get(providerId)?.api?.baseUrl,
        });
        expect(planModel.properties?.inputFormat.toJSON()).toMatchObject({
          supportsImage: true,
          supportsVideo: true,
          supportsAudio: false,
          supportsPdf: false,
        });
      }

      // The high-speed tier swaps endpoints, not models: capability facts must match the same-family Coding Plan site item by item;
      // otherwise plain and high-speed turns in one session would disagree on system folding, WebSearch exposure and attachment validity.
      for (const [highspeedProviderId, planProviderId] of [
        ["account:zai-highspeed-card", "account:zai-individual-coding-plan"],
        ["account:bigmodel-highspeed-card", "account:bigmodel-individual-coding-plan"],
      ] as const) {
        const resolveAt = (providerId: string, modelId: string) =>
          snapshot.models.resolve({
            providerId,
            modelId,
            apiType: "anthropic-messages",
            baseUrl: snapshot.providers.get(providerId)?.api?.baseUrl,
          });
        expect(snapshot.providers.get(highspeedProviderId)?.builtinModelIds).toEqual(
          snapshot.providers.get(planProviderId)?.builtinModelIds,
        );
        for (const modelId of snapshot.providers.get(highspeedProviderId)?.builtinModelIds ?? []) {
          const highspeedModel = resolveAt(highspeedProviderId, modelId);
          const planModel = resolveAt(planProviderId, modelId);
          expect(
            highspeedModel.properties?.inputFormat.toJSON(),
            `${highspeedProviderId}/${modelId} input shape drifts from the Coding Plan site`,
          ).toEqual(planModel.properties?.inputFormat.toJSON());
          expect(
            highspeedModel.properties?.supportsMidConversationSystem,
            `${highspeedProviderId}/${modelId} MCS drifts from the Coding Plan site`,
          ).toBe(planModel.properties?.supportsMidConversationSystem);
          expect(
            highspeedModel.properties?.supportsNativeWebSearch,
            `${highspeedProviderId}/${modelId} native search drifts from the Coding Plan site`,
          ).toBe(planModel.properties?.supportsNativeWebSearch);
        }
      }

      const resolve = (modelId: string) =>
        snapshot.models.resolve({
          providerId: "personal-zai",
          templateId: "zai-api",
          modelId,
          apiType: "anthropic-messages",
          // Model-level capabilities are verified separately from the §6.3.1-approved site overrides.
          baseUrl: "https://other.example.com/anthropic",
        });
      const glm53 = resolve("glm-5.3").toJSON();
      const glm53Flash = resolve("glm-5.3-flash").toJSON();

      expect(glm53.optionSpecs?.reasoningLevel).toMatchObject({
        values: ["low", "high", "max"],
      });
      expect(glm53.optionSpecs?.reasoningLevel?.map).toContain("reasoningLevel");
      expect(reasoningPatch(glm53.optionSpecs!.reasoningLevel!.map!, "low")).toMatchObject({
        output_config: { effort: "low" },
      });
      expect(glm53.properties?.inputFormat).toMatchObject({
        supportsImage: false,
        supportsVideo: false,
      });

      expect(glm53Flash).toEqual({
        ...glm53,
        properties: {
          ...glm53.properties,
          inputFormat: {
            ...glm53.properties?.inputFormat,
            supportsImage: true,
            supportsVideo: true,
            supportsPdf: true,
          },
        },
      });
      const glm53FlashChat = snapshot.models.resolve({
        providerId: "personal-zai",
        templateId: "zai-api",
        modelId: "glm-5.3-flash",
        apiType: "openai-chat-completions",
        baseUrl: "https://api.z.ai/api/anthropic",
      });
      expect(glm53FlashChat.properties?.inputFormat.supportsPdf).toBe(true);
    } finally {
      source.dispose();
    }
  });

  it("declares each vendor's flagship models and key static facts per current official evidence", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: zcodeBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const snapshot = await source.read();
      expect(
        snapshot.providerTemplates?.get("moonshot-kimi")?.config.builtinModelIds.slice(0, 3),
      ).toEqual(["kimi-k3", "kimi-k2.7-code", "kimi-k2.6"]);
      expect(
        snapshot.providerTemplates?.get("minimax")?.config.builtinModelIds.slice(0, 3),
      ).toEqual(["MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.7-highspeed"]);
      for (const providerId of ["qwen-alibaba-model-studio-cn", "qwen-alibaba-model-studio-intl"]) {
        expect(
          snapshot.providerTemplates?.get(providerId)?.config.builtinModelIds.slice(0, 2),
        ).toEqual(["qwen3.8-max", "qwen3.8-flash"]);
      }
      expect(snapshot.providerTemplates?.get("openai")?.config.builtinModelIds.slice(0, 4)).toEqual(
        ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
      );

      const resolve = (
        providerId: string,
        modelId: string,
        apiType: "anthropic-messages" | "openai-chat-completions" | "openai-responses",
        baseUrl: string,
      ) => snapshot.models.resolve({ providerId, modelId, apiType, baseUrl });

      const qwen38 = resolve(
        "qwen-alibaba-model-studio-intl",
        "qwen3.8-flash",
        "openai-chat-completions",
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
      );
      expect(qwen38.properties?.toJSON()).toMatchObject({
        contextWindow: 1_000_000,
        inputFormat: {
          supportsText: true,
          supportsImage: true,
          supportsVideo: true,
          supportsAudio: false,
          supportsPdf: false,
        },
        supportsToolCall: true,
        supportsJsonSchemaOutput: true,
      });
      expect(qwen38.optionSpecs?.maxOutputTokens).toMatchObject({
        max: 131_072,
      });

      const mimo = resolve(
        "xiaomi-mimo",
        "mimo-v2.5",
        "anthropic-messages",
        "https://api.xiaomimimo.com/anthropic",
      );
      expect(mimo.properties?.inputFormat.toJSON()).toMatchObject({
        supportsImage: true,
        supportsVideo: true,
        supportsAudio: true,
      });

      const kimiCode = resolve(
        "moonshot-kimi",
        "kimi-k2.7-code",
        "anthropic-messages",
        "https://api.moonshot.cn/anthropic",
      );
      expect(kimiCode.properties?.contextWindow).toBe(262_144);
      expect(kimiCode.properties?.inputFormat.toJSON()).toMatchObject({
        supportsText: true,
        supportsImage: true,
        supportsVideo: true,
      });

      const kimiK3 = resolve(
        "moonshot-kimi",
        "kimi-k3",
        "anthropic-messages",
        "https://api.moonshot.cn/anthropic",
      );
      expect(kimiK3.properties?.toJSON()).toMatchObject({
        contextWindow: 1_048_576,
        inputFormat: {
          supportsText: true,
          supportsImage: true,
          supportsVideo: true,
        },
      });

      const kimiK3Compact = resolve(
        "moonshot-kimi",
        "k3-256k",
        "anthropic-messages",
        "https://api.kimi.com/coding/",
      );
      expect(kimiK3Compact.properties?.toJSON()).toMatchObject({
        contextWindow: 262_144,
        inputFormat: {
          supportsText: true,
          supportsImage: true,
          supportsVideo: false,
        },
      });

      const minimax = resolve(
        "minimax",
        "MiniMax-M2.7",
        "anthropic-messages",
        "https://api.minimaxi.com/anthropic",
      );
      expect(minimax.properties?.toJSON()).toMatchObject({
        contextWindow: 204_800,
        inputFormat: {
          supportsText: true,
          supportsImage: false,
          supportsVideo: false,
        },
      });

      const minimaxM3 = resolve(
        "minimax",
        "MiniMax-M3",
        "anthropic-messages",
        "https://api.minimaxi.com/anthropic",
      );
      expect(minimaxM3.properties?.toJSON()).toMatchObject({
        contextWindow: 1_000_000,
        inputFormat: {
          supportsText: true,
          supportsImage: true,
          supportsVideo: true,
        },
      });
    } finally {
      source.dispose();
    }
  });

  it("gives aggregated vendors their own templates per the maintenance list, never reusing upstream provider configs", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: zcodeBuiltinProviderConfigFilePath,
      watch: false,
    });
    try {
      const snapshot = await source.read();
      const openrouter = snapshot.providerTemplates?.get("openrouter")?.config;
      expect(openrouter?.api?.type).toBe("anthropic-messages");
      expect(openrouter?.api?.baseUrl).toBe("https://openrouter.ai/api");
      expect(openrouter?.builtinModelIds).toEqual(
        expect.arrayContaining(["openai/gpt-5.6-sol", "anthropic/claude-opus-5", "z-ai/glm-5.3"]),
      );
      for (const templateId of [
        "opencode-zen-responses",
        "opencode-zen-messages",
        "opencode-zen-chat",
      ]) {
        expect(snapshot.providerTemplates?.has(templateId)).toBe(true);
      }
    } finally {
      source.dispose();
    }
  });

  it("matches aggregated vendors' shared models via rules and API maps, keeps full ids, and enables one rep model per vendor", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: zcodeBuiltinProviderConfigFilePath,
      watch: false,
    });
    try {
      const snapshot = await source.read();
      const pairs = [
        ["openai/gpt-5.6-sol", "gpt-5.6-sol"],
        ["anthropic/claude-opus-5", "claude-opus-5"],
        ["anthropic/claude-haiku-4.5", "claude-haiku-4-5-20251001"],
        ["deepseek/deepseek-v4-pro", "deepseek-v4-pro"],
        ["moonshotai/kimi-k3", "kimi-k3"],
        ["z-ai/glm-5.3", "glm-5.3"],
        ["qwen/qwen3.8-max", "qwen3.8-max"],
        ["minimax/minimax-m3", "MiniMax-M3"],
        ["xiaomi/mimo-v2.5-pro", "mimo-v2.5-pro"],
        ["x-ai/grok-4.6", "grok-4.6"],
      ];
      for (const [aggregateId, directId] of pairs) {
        const resolve = (modelId: string, templateId?: string) =>
          snapshot.models.resolve({
            providerId: "aggregate-instance",
            templateId,
            modelId,
            apiType: "anthropic-messages",
            baseUrl: "https://openrouter.ai/api",
          });
        const aggregate = resolve(aggregateId!, "openrouter");
        const direct = resolve(directId!);
        expect(aggregate.properties?.toJSON(), aggregateId).toEqual(direct.properties?.toJSON());
        expect(aggregate.optionSpecs?.toJSON(), aggregateId).toEqual(direct.optionSpecs?.toJSON());
      }
      for (const templateId of ["openrouter", "opencode-zen-messages", "opencode-zen-chat"]) {
        const template = snapshot.providerTemplates!.get(templateId)!.config;
        const enabledByVendor = new Map<string, boolean>();
        for (const modelId of template.builtinModelIds!) {
          const vendor =
            templateId === "openrouter" ? modelId.split("/")[0]! : modelId.split("-")[0]!;
          const model = snapshot.models.resolve({
            providerId: "aggregate-instance",
            templateId,
            modelId,
            apiType: template.api!.type,
            baseUrl: template.api!.baseUrl,
          });
          enabledByVendor.set(
            vendor,
            (enabledByVendor.get(vendor) ?? false) || model.enabled === true,
          );
        }
        for (const [vendor, enabled] of enabledByVendor)
          expect(enabled, `${templateId}/${vendor}`).toBe(true);
      }
      const haiku = snapshot.models.resolve({
        providerId: "zen",
        templateId: "opencode-zen-messages",
        modelId: "claude-haiku-4-5",
        apiType: "anthropic-messages",
        baseUrl: "https://opencode.ai/zen/v1",
      });
      expect(haiku.properties?.inputFormat.supportsImage).toBe(true);
      expect(haiku.properties?.contextWindow).toBe(200_000);
    } finally {
      source.dispose();
    }
  });

  it("makes every provider's default-enabled models a membership prefix with legacy/alias models off by default", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: zcodeBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const snapshot = await source.read();
      const exactEnabled = new Map(
        snapshot.models
          .rules()
          .flatMap((rule) =>
            rule.config.enabled === undefined ||
            (rule.type !== "provider-model" && rule.type !== "template-model")
              ? []
              : [
                  [
                    `${rule.type === "provider-model" ? rule.providerId : rule.templateId}\0${rule.modelId}`,
                    rule.config.enabled,
                  ] as const,
                ],
          ),
      );

      const memberships = [
        ...snapshot.providers.entries(),
        ...(snapshot.providerTemplates
          ?.entries()
          .map(([id, template]) => [id, template.config] as const) ?? []),
      ];
      for (const [ownerId, owner] of memberships) {
        const states = (owner.builtinModelIds ?? []).map((modelId) => {
          const enabled = exactEnabled.get(`${ownerId}\0${modelId}`);
          expect(
            enabled,
            `${ownerId}/${modelId} must declare the Built-in default enabled explicitly`,
          ).toBeTypeOf("boolean");
          return enabled!;
        });
        const firstDisabled = states.indexOf(false);
        if (firstDisabled >= 0) {
          expect(
            states.slice(firstDisabled).every((enabled) => !enabled),
            `${ownerId} enabled members must precede disabled members`,
          ).toBe(true);
        }
      }

      expect(exactEnabled.get("openai\0gpt-5.6")).toBe(false);
      expect(exactEnabled.get("openai\0gpt-5.6-sol")).toBe(true);
      expect(exactEnabled.get("minimax\0MiniMax-M3")).toBe(true);
      expect(exactEnabled.get("xai\0grok-4.3")).toBe(false);
    } finally {
      source.dispose();
    }
  });

  it("declares Zhipu system providers and external major providers by product group", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: zcodeBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const snapshot = await source.read();
      expect(snapshot.providers.keys()).toEqual([
        "account:zai-individual-coding-plan",
        "account:zai-team-coding-plan",
        "account:zai-start-plan",
        "account:bigmodel-individual-coding-plan",
        "account:bigmodel-team-coding-plan",
        "account:bigmodel-start-plan",
        "account:zai-offpeak-idle-plan",
        "account:bigmodel-offpeak-idle-plan",
        "account:zai-highspeed-card",
        "account:bigmodel-highspeed-card",
      ]);
      expect(snapshot.providerTemplates?.keys()).toEqual([
        "zai-api",
        "zai-standard-api",
        "bigmodel-api",
        "bigmodel-standard-api",
        "moonshot-kimi",
        "minimax",
        "deepseek",
        "qwen-alibaba-model-studio-cn",
        "qwen-alibaba-model-studio-intl",
        "xiaomi-mimo",
        "openai",
        "anthropic",
        "xai",
        "openrouter",
        "opencode-go-chat",
        "opencode-go-messages",
        "opencode-go-responses",
        "opencode-zen-responses",
        "opencode-zen-messages",
        "opencode-zen-chat",
      ]);
      for (const [templateId, template] of snapshot.providerTemplates?.entries() ?? []) {
        expect(
          template.templateNameMap["zh-CN"]?.trim(),
          `${templateId} missing the Chinese template name`,
        ).toBeTruthy();
        expect(
          template.templateNameMap["en-US"]?.trim(),
          `${templateId} missing the English template name`,
        ).toBeTruthy();
        expect(
          template.config.logo,
          `${templateId} missing the Built-in logo reference`,
        ).toMatchObject({
          type: "builtin",
        });
      }
      for (const [providerId, provider] of snapshot.providers.entries()) {
        expect(provider.logo, `${providerId} missing the Built-in logo reference`).toMatchObject({
          type: "builtin",
        });
      }
      expect(snapshot.providerTemplates?.get("moonshot-kimi")?.templateNameMap).toEqual({
        "zh-CN": "Kimi",
        "en-US": "Kimi",
      });
      expect(
        snapshot.providerTemplates?.get("qwen-alibaba-model-studio-cn")?.templateNameMap,
      ).toEqual({
        "zh-CN": "阿里云百炼（中国）",
        "en-US": "Alibaba Cloud (China)",
      });
      expect(
        snapshot.providerTemplates?.get("qwen-alibaba-model-studio-intl")?.templateNameMap,
      ).toEqual({
        "zh-CN": "阿里云百炼（国际）",
        "en-US": "Alibaba Cloud (Global)",
      });

      expect(snapshot.providerTemplates?.get("openai")?.config.toJSON()).toMatchObject({
        builtinModelIds: [
          "gpt-6-astra",
          "gpt-5.6-sol",
          "gpt-5.6-terra",
          "gpt-5.6-luna",
          "gpt-5.6",
          "gpt-5.4",
          "gpt-5.4-pro",
          "gpt-5.4-mini",
          "gpt-5.4-nano",
          "gpt-5.3-codex",
        ],
        access: {
          type: "api-key",
          apiKeyManagementUrl: "https://platform.openai.com/api-keys",
        },
        api: { type: "openai-responses", baseUrl: "https://api.openai.com/v1" },
      });
      expect(snapshot.providerTemplates?.get("anthropic")?.config.toJSON()).toMatchObject({
        builtinModelIds: [
          "claude-fable-5-1",
          "claude-fable-5",
          "claude-opus-5",
          "claude-sonnet-5",
          "claude-haiku-4-5-20251001",
        ],
        access: {
          type: "api-key",
          apiKeyManagementUrl: "https://console.anthropic.com/settings/keys",
        },
        api: { type: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1" },
      });
      expect(snapshot.providerTemplates?.get("xai")?.config.toJSON()).toMatchObject({
        builtinModelIds: ["grok-4.6", "grok-build-0.1", "grok-4.3"],
        access: {
          type: "api-key",
          apiKeyManagementUrl: "https://console.x.ai",
        },
        api: { type: "openai-responses", baseUrl: "https://api.x.ai/v1" },
      });
      expect(snapshot.providerTemplates?.get("zai-api")?.config.toJSON()).toMatchObject({
        access: { type: "zhipu-coding-plan-api-key" },
      });
      expect(snapshot.providerTemplates?.get("bigmodel-api")?.config.toJSON()).toMatchObject({
        access: { type: "zhipu-coding-plan-api-key" },
      });
    } finally {
      source.dispose();
    }
  });

  it("orders rules contiguously per model family and keeps no semantically-equal duplicate matchers", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: zcodeBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const rules = (await source.read()).models.rules().filter((rule) => rule.type === "match");
      const selectorKeys = rules.map((rule) =>
        JSON.stringify([
          rule.providerMatch ?? "",
          rule.modelMatch.toLowerCase(),
          rule.apiMatch ?? "",
          rule.baseUrlMatch ?? "",
        ]),
      );
      expect(new Set(selectorKeys).size).toBe(selectorKeys.length);

      // After grouping, family-contiguity constrains only the Model Rule group; concatenating Model/API/Site
      // manufactures duplicate families and destroys the authoring order under test.
      const rawRelease = JSON.parse(await readFile(zcodeBuiltinProviderConfigFilePath, "utf8")) as {
        config: { modelConfigRules: { modelRules: readonly { modelMatch: string }[] } };
      };
      const modelRules = rawRelease.config.modelConfigRules.modelRules;
      const familySequence = modelRules
        .map((rule) => builtinRuleFamily(rule))
        .filter((family, index, families) => family !== families[index - 1]);
      expect(familySequence).toEqual([
        "fallback",
        "glm",
        "gpt",
        "claude",
        "grok",
        "kimi",
        "minimax",
        "deepseek",
        "qwen",
        "mimo",
      ]);
    } finally {
      source.dispose();
    }
  });

  it("orders public reasoning tiers low-to-high by semantic strength", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: zcodeBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const levelRank: Readonly<Record<string, number>> = {
        disabled: 0,
        none: 0,
        nothink: 0,
        off: 0,
        enabled: 1,
        minimal: 0.5,
        low: 1,
        medium: 2,
        high: 3,
        xhigh: 4,
        max: 5,
      };

      for (const rule of (await source.read()).models.rules()) {
        const values = rule.config.optionSpecs?.reasoningLevel?.values;
        if (!values) continue;
        const ranks = values.map((value) => levelRank[value]);
        expect(
          ranks.every((rank) => rank !== undefined),
          `${rule.modelMatch} has an unknown reasoning tier; declare its order semantics first`,
        ).toBe(true);
        expect(
          ranks.every((rank, index) => index === 0 || rank! >= ranks[index - 1]!),
          `${rule.modelMatch} reasoning tiers must be ordered low to high`,
        ).toBe(true);
      }
    } finally {
      source.dispose();
    }
  });

  it("resolves model facts and reasoning maps for OpenAI Responses and Anthropic Messages", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: zcodeBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const snapshot = await source.read();
      const openAi = snapshot.models.resolve({
        providerId: "openai",
        modelId: "gpt-5.6-sol",
        apiType: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      });
      expect(openAi.properties?.toJSON()).toMatchObject({
        requiresMfjsToolSchema: false,
        contextWindow: 1_050_000,
        inputFormat: {
          supportsText: true,
          supportsImage: true,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: true,
        },
        outputFormat: { supportsText: true },
        supportsToolCall: true,
        supportsJsonSchemaOutput: true,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
      });
      expect(openAi.optionSpecs?.reasoningLevel).toMatchObject({
        values: ["none", "low", "medium", "high", "xhigh", "max"],
      });
      for (const effort of ["xhigh", "max"]) {
        expect(reasoningPatch(openAi.optionSpecs!.reasoningLevel!.map!, effort)).toEqual({
          reasoning: { effort },
        });
      }

      const grok46 = snapshot.models.resolve({
        providerId: "xai",
        modelId: "grok-4.6",
        apiType: "openai-responses",
        baseUrl: "https://api.x.ai/v1",
      });
      expect(grok46.properties?.toJSON()).toMatchObject({
        requiresMfjsToolSchema: false,
        contextWindow: 500_000,
        inputFormat: {
          supportsText: true,
          supportsImage: true,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        },
        outputFormat: { supportsText: true },
        supportsToolCall: true,
        supportsJsonSchemaOutput: true,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
      });
      expect(grok46.optionSpecs?.reasoningLevel).toMatchObject({
        values: ["low", "medium", "high", "xhigh"],
      });
      expect(reasoningPatch(grok46.optionSpecs!.reasoningLevel!.map!, "xhigh")).toEqual({
        reasoning: { effort: "xhigh" },
      });

      const grokBuild = snapshot.models.resolve({
        providerId: "xai",
        modelId: "grok-build-0.1",
        apiType: "openai-responses",
        baseUrl: "https://api.x.ai/v1",
      });
      expect(grokBuild.properties?.toJSON()).toMatchObject({
        requiresMfjsToolSchema: false,
        contextWindow: 256_000,
        inputFormat: { supportsText: true, supportsImage: true },
        outputFormat: { supportsText: true },
        supportsToolCall: true,
        supportsJsonSchemaOutput: true,
      });

      const grok43 = snapshot.models.resolve({
        providerId: "xai",
        modelId: "grok-4.3",
        apiType: "openai-responses",
        baseUrl: "https://api.x.ai/v1",
      });
      expect(grok43.properties?.contextWindow).toBe(1_000_000);
      expect(grok43.optionSpecs?.reasoningLevel?.toJSON()).toMatchObject({
        // This model declares no dedicated tiers and keeps inheriting the model-level generic fallback.
        values: ["disabled", "enabled"],
      });
      expect(reasoningPatch(grok43.optionSpecs!.reasoningLevel!.map!, "disabled")).toEqual({
        reasoning: { effort: "none" },
      });

      const anthropic = snapshot.models.resolve({
        providerId: "anthropic",
        modelId: "claude-opus-5",
        apiType: "anthropic-messages",
        baseUrl: "https://api.anthropic.com/v1",
      });
      expect(anthropic.properties?.toJSON()).toMatchObject({
        requiresMfjsToolSchema: false,
        contextWindow: 1_000_000,
        inputFormat: {
          supportsText: true,
          supportsImage: true,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: true,
        },
        outputFormat: { supportsText: true },
        supportsToolCall: true,
        supportsJsonSchemaOutput: true,
        supportsNativeWebSearch: true,
        supportsMidConversationSystem: true,
      });
      expect(anthropic.optionSpecs?.reasoningLevel).toMatchObject({
        values: ["low", "medium", "high", "xhigh", "max"],
      });
      expect(anthropic.optionSpecs?.reasoningLevel?.map).toContain("reasoningLevel");
      expect(reasoningPatch(anthropic.optionSpecs!.reasoningLevel!.map!, "max")).toMatchObject({
        output_config: { effort: "max" },
      });

      const deepSeek = snapshot.models.resolve({
        providerId: "deepseek",
        modelId: "deepseek-v4-flash",
        apiType: "anthropic-messages",
        baseUrl: "https://api.deepseek.com/anthropic",
      });
      expect(deepSeek.properties?.supportsJsonSchemaOutput).toBe(false);
      expect(deepSeek.optionSpecs?.reasoningLevel).toMatchObject({
        values: ["disabled", "low", "high", "max"],
      });
      expect(deepSeek.optionSpecs?.reasoningLevel?.map).toContain("reasoningLevel");
      expect(reasoningPatch(deepSeek.optionSpecs!.reasoningLevel!.map!, "low")).toMatchObject({
        output_config: { effort: "low" },
      });

      for (const modelId of ["qwen3.5-plus", "qwen3.5-flash", "qwen3-vl-plus"]) {
        expect(
          snapshot.models.resolve({
            providerId: "qwen-alibaba-model-studio-cn",
            modelId,
            apiType: "anthropic-messages",
            baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic",
          }).properties?.supportsJsonSchemaOutput,
        ).toBe(false);
      }

      const deepSeekResponses = snapshot.models.resolve({
        providerId: "deepseek",
        modelId: "deepseek-v4-pro",
        apiType: "openai-responses",
        baseUrl: "https://api.deepseek.com",
      });
      expect(deepSeekResponses.properties?.supportsJsonSchemaOutput).toBe(true);
      expect(reasoningPatch(deepSeekResponses.optionSpecs!.reasoningLevel!.map!, "max")).toEqual({
        reasoning: { effort: "max" },
      });
    } finally {
      source.dispose();
    }
  });

  it("keeps every Built-in provider and model member complete, with enabled members Registry-ready once access material lands", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: zcodeBuiltinProviderConfigFilePath,
      watch: false,
    });

    try {
      const snapshot = await source.read();
      const accountProviders: [string, ProviderConfig][] = [];
      const personalProviders: Array<{
        providerId: string;
        templateId: string;
        config: ProviderConfig;
      }> = [];
      const expectedModelIds = new Map<string, readonly string[]>();

      for (const [providerId, provider] of snapshot.providers.entries()) {
        const builtinModelIds = provider.builtinModelIds ?? [];
        expect(
          new Set(builtinModelIds).size,
          `${providerId} has duplicate Built-in model members`,
        ).toBe(builtinModelIds.length);
        const enabledModelIds = builtinModelIds.filter((modelId) => {
          const model = snapshot.models.resolve({
            providerId,
            modelId,
            apiType: provider.api?.type,
            baseUrl: provider.api?.baseUrl,
          });
          expect(model.validateComplete(["providers", providerId, "models", modelId])).toEqual([]);
          return model.enabled !== false;
        });
        expectedModelIds.set(providerId, enabledModelIds);

        if (provider.access?.type === "zhipu-account") {
          accountProviders.push([
            providerId,
            new ProviderConfig({
              access: new ZhipuAccountAccessConfig({ entitled: true }),
            }),
          ]);
        }
      }

      for (const [templateId, template] of snapshot.providerTemplates?.entries() ?? []) {
        const providerId = `template:${templateId}`;
        const builtinModelIds = template.config.builtinModelIds ?? [];
        expect(
          new Set(builtinModelIds).size,
          `${templateId} has duplicate Template model members`,
        ).toBe(builtinModelIds.length);
        const enabledModelIds = builtinModelIds.filter((modelId) => {
          const model = snapshot.models.resolve({
            providerId,
            templateId,
            modelId,
            apiType: template.config.api?.type,
            baseUrl: template.config.api?.baseUrl,
          });
          expect(model.validateComplete(["templates", templateId, "models", modelId])).toEqual([]);
          return model.enabled !== false;
        });
        expectedModelIds.set(providerId, enabledModelIds);
        expect(["api-key", "zhipu-coding-plan-api-key"]).toContain(template.config.access?.type);
        if (template.config.access?.type !== "zhipu-account") {
          expect(
            template.config.access.apiKey,
            `${templateId} must not persist an API key`,
          ).toBeUndefined();
        }
        personalProviders.push({
          providerId,
          templateId,
          config: new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({
              type: template.config.access?.type,
              apiKey: `test-key-for-${templateId}`,
            }),
          }),
        });
      }

      const resolution = new ProviderConfigResolver().resolve({
        zcodeBuiltinProviders: snapshot.providers,
        zcodeBuiltinProviderTemplates: snapshot.providerTemplates,
        accountProviders: new ProviderConfigMap(accountProviders),
        personalProviders: new ProviderConfigMap(personalProviders),
        zcodeBuiltinModelRules: snapshot.models,
        personalModels: ModelConfigRules.empty(),
      });

      expect(resolution.issues).toEqual([]);
      expect(resolution.registryProviders.map(({ providerId }) => providerId)).toEqual([
        "account:zai-individual-coding-plan",
        "account:zai-team-coding-plan",
        "account:zai-start-plan",
        "account:bigmodel-individual-coding-plan",
        "account:bigmodel-team-coding-plan",
        "account:bigmodel-start-plan",
        "account:zai-offpeak-idle-plan",
        "account:bigmodel-offpeak-idle-plan",
        "account:zai-highspeed-card",
        "account:bigmodel-highspeed-card",
        "template:zai-api",
        "template:zai-standard-api",
        "template:bigmodel-api",
        "template:bigmodel-standard-api",
        "template:moonshot-kimi",
        "template:minimax",
        "template:deepseek",
        "template:qwen-alibaba-model-studio-cn",
        "template:qwen-alibaba-model-studio-intl",
        "template:xiaomi-mimo",
        "template:openai",
        "template:anthropic",
        "template:xai",
        "template:openrouter",
        "template:opencode-go-chat",
        "template:opencode-go-messages",
        "template:opencode-go-responses",
        "template:opencode-zen-responses",
        "template:opencode-zen-messages",
        "template:opencode-zen-chat",
      ]);

      for (const provider of resolution.registryProviders) {
        expect(
          provider.models.map(({ modelId }) => modelId),
          `${provider.providerId} Registry model members must match the Built-in Config`,
        ).toEqual(expectedModelIds.get(provider.providerId));
        for (const model of provider.models) {
          expect(
            model.config.validateComplete([
              "providers",
              provider.providerId,
              "models",
              model.modelId,
            ]),
          ).toEqual([]);
        }
      }

      for (const providerId of [
        "account:zai-offpeak-idle-plan",
        "account:bigmodel-offpeak-idle-plan",
      ]) {
        const offPeak = resolution.resolvedProviders.find(
          (provider) => provider.providerId === providerId,
        );
        expect(offPeak?.models).not.toHaveLength(0);
        for (const model of offPeak?.models ?? []) {
          expect(model).toMatchObject({ executable: true, selectable: false });
        }
      }
    } finally {
      source.dispose();
    }
  });

  it("keeps legacy model-capability fields out of the official Built-in JSON", async () => {
    const document = JSON.parse(
      await readFile(zcodeBuiltinProviderConfigFilePath, "utf8"),
    ) as unknown;
    const keys = collectObjectKeys(document);

    expect(keys).not.toContain("apiKey");
    expect(keys).not.toContain("modalities");
    expect(keys).not.toContain("magic_name");
    expect(keys).not.toContain("supportsImages");
    // Todo104: supportsPdf/Video are official fields inside inputFormat; the name overlap must not read as legacy flat capabilities.
    for (const key of [
      "input_format",
      "output_format",
      "support_text",
      "support_image",
      "support_pdf",
      "support_video",
      "support_audio",
    ]) {
      expect(keys).not.toContain(key);
    }
    expect(keys).not.toContain("budget_tokens");
    expect(keys).not.toContain("budgetTokens");
  });
});

function builtinRuleFamily(rule: {
  readonly providerMatch?: string;
  readonly modelMatch: string;
  readonly apiMatch?: string;
  readonly baseUrlMatch?: string;
}): string {
  const provider = rule.providerMatch?.toLowerCase() ?? "";
  const baseUrl = rule.baseUrlMatch?.toLowerCase() ?? "";
  const model = rule.modelMatch.toLowerCase();
  if (!provider && !baseUrl && (model === ".*" || (!rule.apiMatch && model === ".*\\[1m\\]"))) {
    return "fallback";
  }
  if (provider.includes("github-copilot") || model.includes("gpt")) return "gpt";
  if (provider === "anthropic" || model.includes("claude")) return "claude";
  if (model.includes("grok")) return "grok";
  if (provider === "moonshot-kimi" || /(?:kimi|moonshot|k3)/.test(model)) return "kimi";
  if (model.includes("minimax")) return "minimax";
  if (provider === "deepseek" || model.includes("deepseek")) return "deepseek";
  if (model.includes("qwen")) return "qwen";
  if (model.includes("mimo")) return "mimo";
  if (
    model.includes("glm") ||
    model.includes("ox-alpha") ||
    model.includes("codegeex") ||
    model.includes("emohaa") ||
    provider.includes("zai") ||
    provider.includes("bigmodel") ||
    provider.includes("offpeak-idle-plan") ||
    baseUrl.includes("z\\.ai") ||
    baseUrl.includes("bigmodel\\.cn")
  ) {
    return "glm";
  }
  return "cross-model";
}

function collectObjectKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectObjectKeys);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...collectObjectKeys(child)]);
}
