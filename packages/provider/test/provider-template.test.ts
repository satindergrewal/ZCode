import { describe, expect, it } from "vitest";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelConfigRules,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigResolver,
  ProviderTemplate,
  ProviderTemplateMap,
  parseProviderTemplateMap,
  parseZCodeBuiltinModelConfigRules,
  resolveProviderTemplateName,
} from "../src/index.js";

describe("Provider Template", () => {
  it("accepts only reusable baseline fields, rejecting credentials, identity and runtime state", () => {
    expect(
      parseProviderTemplateMap([
        {
          templateId: "deepseek",
          templateNameMap: { "zh-CN": "深度求索", "en-US": "DeepSeek" },
          config: {
            logo: { type: "builtin", key: "deepseek" },
            access: { type: "api-key", apiKeyManagementUrl: "https://example.com/keys" },
            api: { type: "anthropic-messages", baseUrl: "https://api.example.com" },
            builtinModelIds: ["model-a"],
          },
        },
      ])
        .get("deepseek")
        ?.toJSON(),
    ).toEqual({
      templateId: "deepseek",
      templateNameMap: { "zh-CN": "深度求索", "en-US": "DeepSeek" },
      config: {
        logo: { type: "builtin", key: "deepseek" },
        access: { type: "api-key", apiKeyManagementUrl: "https://example.com/keys" },
        api: { type: "anthropic-messages", baseUrl: "https://api.example.com" },
        builtinModelIds: ["model-a"],
      },
    });

    for (const forbidden of [
      { templateNameMap: { "en-US": "DeepSeek" }, group: "standard-personal" },
      { templateNameMap: { "en-US": "DeepSeek" }, config: { templateId: "nested" } },
      { templateNameMap: { "en-US": "DeepSeek" }, config: { enabled: true } },
      { templateNameMap: { "en-US": "DeepSeek" }, config: { visibility: "hidden" } },
      { templateNameMap: { "en-US": "DeepSeek" }, config: { personalModelIds: ["personal"] } },
      { templateNameMap: { "en-US": "DeepSeek" }, config: { modelOrder: ["model-a"] } },
      {
        templateNameMap: { "en-US": "DeepSeek" },
        config: { access: { type: "api-key", apiKey: "secret" } },
      },
    ]) {
      expect(() => parseProviderTemplateMap([{ templateId: "deepseek", ...forbidden }])).toThrow();
    }
  });

  it("resolves names by current language, then English, then the Template ID", () => {
    const localized = new ProviderTemplate({
      templateId: "deepseek",
      templateNameMap: { "zh-CN": "深度求索", "en-US": "DeepSeek" },
      config: new ProviderConfig(),
    });
    const englishOnly = new ProviderTemplate({
      templateId: "deepseek",
      templateNameMap: { "en-US": "DeepSeek" },
      config: new ProviderConfig(),
    });
    const unnamed = new ProviderTemplate({
      templateId: "deepseek",
      templateNameMap: {},
      config: new ProviderConfig(),
    });

    expect(resolveProviderTemplateName("deepseek", localized, "zh-CN")).toBe("深度求索");
    expect(resolveProviderTemplateName("deepseek", englishOnly, "zh-CN")).toBe("DeepSeek");
    expect(resolveProviderTemplateName("deepseek", unnamed, "zh-CN")).toBe("deepseek");
  });

  it("instantiates one Template into many independent Providers while the Template never enters the Registry", () => {
    const template = new ProviderTemplate({
      templateId: "deepseek",
      templateNameMap: { "en-US": "DeepSeek" },
      config: new ProviderConfig({
        access: new ApiKeyAccessConfig(),
        api: new ProviderApiConfig({
          type: "anthropic-messages",
          baseUrl: "https://api.example.com",
        }),
        builtinModelIds: ["model-a"],
      }),
    });
    const personalProviders = new ProviderConfigMap([
      {
        providerId: "deepseek",
        templateId: "deepseek",
        config: new ProviderConfig({
          group: "standard-personal",
          access: new ApiKeyAccessConfig({ apiKey: "first" }),
        }),
      },
      {
        providerId: "deepseek-2",
        templateId: "deepseek",
        providerName: "DeepSeek 2",
        config: new ProviderConfig({
          group: "standard-personal",
          access: new ApiKeyAccessConfig({ apiKey: "second" }),
        }),
      },
    ]);
    const rules = new ModelConfigRules([
      {
        type: "model",
        modelMatch: ".*",
        config: completeModelConfig(),
      },
    ]);
    const resolution = new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: ProviderConfigMap.empty(),
      zcodeBuiltinProviderTemplates: new ProviderTemplateMap([["deepseek", template]]),
      accountProviders: ProviderConfigMap.empty(),
      personalProviders,
      zcodeBuiltinModelRules: rules,
      personalModels: ModelConfigRules.empty(),
    });

    expect(resolution.registryProviders.map(({ providerId }) => providerId)).toEqual([
      "deepseek",
      "deepseek-2",
    ]);
    expect(resolution.resolvedProviders.map(({ providerId }) => providerId)).not.toContain(
      "template:deepseek",
    );
    expect(resolution.registryProviders[0]?.config.api?.baseUrl).toBe("https://api.example.com");
  });

  it("orders Built-in rules by match, template-model, then provider-model", () => {
    const rules = parseZCodeBuiltinModelConfigRules({
      modelRules: [{ modelMatch: ".*", config: { enabled: false } }],
      modelApiRules: [],
      providerSiteRules: [],
      templateModelRules: [
        { templateId: "deepseek", modelId: "model-a", config: { enabled: true } },
      ],
      builtinProviderModelRules: [
        { providerId: "deepseek-special", modelId: "model-a", config: { enabled: false } },
      ],
    });

    expect(
      rules.resolve({
        providerId: "deepseek",
        templateId: "deepseek",
        modelId: "model-a",
      }).enabled,
    ).toBe(true);
    expect(
      rules.resolve({
        providerId: "deepseek-special",
        templateId: "deepseek",
        modelId: "model-a",
      }).enabled,
    ).toBe(false);
  });

  it("layers Built-in groups in model, model+api, site, template, provider order", () => {
    const rules = parseZCodeBuiltinModelConfigRules({
      modelRules: [
        { modelMatch: ".*", config: { enabled: false } },
        { modelMatch: ".*GLM-5\\.3.*", config: { enabled: true } },
      ],
      modelApiRules: [
        {
          modelMatch: ".*GLM-5\\.3.*",
          apiTypeMatch: "anthropic-messages",
          config: { properties: { requiresMfjsToolSchema: true } },
        },
      ],
      providerSiteRules: [
        {
          modelMatch: ".*GLM-5\\.3.*",
          apiTypeMatch: "anthropic-messages",
          baseUrlMatch: "https://api.example.com/anthropic/?",
          config: { enabled: false },
        },
      ],
      templateModelRules: [{ templateId: "glm", modelId: "GLM-5.3", config: { enabled: true } }],
      builtinProviderModelRules: [
        { providerId: "provider-a", modelId: "GLM-5.3", config: { enabled: false } },
      ],
    });

    const resolved = rules.resolve({
      providerId: "provider-a",
      templateId: "glm",
      modelId: "GLM-5.3",
      apiType: "anthropic-messages",
      baseUrl: "https://api.example.com/anthropic",
    });
    expect(resolved.enabled).toBe(false);
    expect(resolved.properties?.requiresMfjsToolSchema).toBe(true);
  });
});

function completeModelConfig(): ModelConfig {
  return new ModelConfig({
    enabled: true,

    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: 128_000,
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
  });
}
