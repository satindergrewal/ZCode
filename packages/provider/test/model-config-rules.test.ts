import { describe, expect, it } from "vitest";
import {
  ModelConfig,
  ModelConfigRules,
  ModelPropertiesConfig,
  parseZCodeBuiltinModelConfigRules,
  parseModelConfig,
  parsePersonalModelConfigRules,
  extractManualModelConfig,
} from "../src/index.js";

const emptyBuiltin = {
  modelRules: [],
  modelApiRules: [],
  providerSiteRules: [],
  templateModelRules: [],
  builtinProviderModelRules: [],
};
const complete = {
  properties: {
    requiresMfjsToolSchema: false,
    contextWindow: 128000,
    inputFormat: {
      supportsText: true,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
    supportsToolCall: true,
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: false,
  },
  optionSpecs: {
    reasoningLevel: { values: ["disabled"], map: "{}" },
    maxOutputTokens: { max: 8192, map: '{"max_tokens":maxOutputTokens}' },
  },
};

describe("ModelConfigRules", () => {
  it("Todo90: pinned configs never backfill from recommendations; enabled still inherits independently", () => {
    const rules = new ModelConfigRules([
      {
        type: "model",
        modelMatch: ".*",
        config: new ModelConfig({
          enabled: false,

          properties: new ModelPropertiesConfig({
            requiresMfjsToolSchema: true,
            contextWindow: 100000,
          }),
        }),
      },
      {
        type: "manual-provider-model",
        providerId: "p",
        modelId: "m",
        config: new ModelConfig({
          properties: new ModelPropertiesConfig({ requiresMfjsToolSchema: false }),
        }),
      },
    ]);
    const fixed = rules.resolve({ providerId: "p", modelId: "m" });
    expect(fixed.properties?.contextWindow).toBeUndefined();
    expect(fixed.properties?.requiresMfjsToolSchema).toBe(false);
    expect(fixed.enabled).toBe(false);
    expect(fixed.validateComplete().length).toBeGreaterThan(0);
  });
  it("matches whole model ids case-insensitively in modelMatch without implicit contains widening", () => {
    const rules = new ModelConfigRules([
      {
        type: "model",
        modelMatch: "GLM-5",
        config: new ModelConfig({ enabled: false }),
      },
    ]);

    expect(rules.resolve({ providerId: "custom", modelId: "glm-5" }).enabled).toBe(false);
    expect(rules.resolve({ providerId: "custom", modelId: "glm-5-turbo" }).enabled).toBeUndefined();
    expect(
      rules.resolve({ providerId: "custom", modelId: "vendor/glm-5" }).enabled,
    ).toBeUndefined();
  });

  it("normalizes scheme, host, default port and trailing slash in baseUrlMatch while keeping path case", () => {
    const rules = new ModelConfigRules([
      {
        type: "model",
        modelMatch: ".*",
        config: new ModelConfig({ enabled: true }),
      },
      {
        type: "provider-site",
        modelMatch: "model-a",
        baseUrlMatch: "https://api\\.example\\.com/v1",
        config: new ModelConfig({ enabled: false }),
      },
    ]);

    expect(
      rules.resolve({
        providerId: "custom",
        modelId: "model-a",
        baseUrl: "HTTPS://API.EXAMPLE.COM:443/v1/",
      }).enabled,
    ).toBe(false);
    expect(
      rules.resolve({
        providerId: "custom",
        modelId: "model-a",
        baseUrl: "https://api.example.com/V1/",
      }).enabled,
    ).toBe(true);
  });

  it("applies optional endpoint-specialized rules by the Effective Provider baseURL", () => {
    const rules = new ModelConfigRules([
      {
        type: "model",
        modelMatch: ".*",
        config: new ModelConfig({ enabled: true }),
      },
      {
        type: "provider-site",
        modelMatch: "model-a",
        baseUrlMatch: "https://api\\.example\\.com/v1",
        config: new ModelConfig({ enabled: false }),
      },
    ]);

    expect(
      rules.resolve({
        providerId: "custom",
        modelId: "model-a",
        apiType: "openai-responses",
        baseUrl: "https://api.example.com/v1",
      }).enabled,
    ).toBe(false);
    expect(
      rules.resolve({
        providerId: "custom",
        modelId: "model-a",
        apiType: "openai-responses",
        baseUrl: "https://proxy.example.com/v1",
      }).enabled,
    ).toBe(true);
  });

  it("parses baseUrlMatch strictly and serializes it verbatim", () => {
    const source = {
      ...emptyBuiltin,
      providerSiteRules: [
        {
          modelMatch: "model-a",
          apiTypeMatch: "openai-responses",
          baseUrlMatch: "https://api\\\\.example\\\\.com/v1",
          config: { enabled: true },
        },
      ],
    };
    const rules = parseZCodeBuiltinModelConfigRules(source);
    expect(rules.toZCodeBuiltinJSON()).toEqual(source);
  });

  it("encodes Personal manual modes via their owning collection, never mixing back into the smart group", () => {
    const source = {
      providerModelRules: [],
      manualProviderModelRules: [
        {
          providerId: "provider-a",
          modelId: "model-a",
          config: extractManualModelConfig(complete),
        },
      ],
    };
    const rules = parsePersonalModelConfigRules(source);
    expect(rules.toPersonalJSON()).toEqual(source);
    expect(rules.getExactRule("provider-a", "model-a")?.type).toBe("manual-provider-model");
  });

  it("keeps the explicit recommendation mode when replacing an exact Personal rule", () => {
    const rules = ModelConfigRules.empty().setExact(
      "provider-a",
      "model-a",
      parseModelConfig(extractManualModelConfig({ ...complete, enabled: true })),
      false,
    );

    const replaced = rules.setExact(
      "provider-a",
      "model-a",
      parseModelConfig(extractManualModelConfig({ ...complete, enabled: false })),
      false,
    );

    expect(replaced.getExactRule("provider-a", "model-a")).toEqual({
      type: "manual-provider-model",
      providerId: "provider-a",
      modelId: "model-a",
      config: parseModelConfig(extractManualModelConfig({ ...complete, enabled: false })),
    });
  });

  it("uses structured exact identity for provider-model and composes across source layers", () => {
    const builtin = parseZCodeBuiltinModelConfigRules({
      ...emptyBuiltin,
      modelRules: [{ modelMatch: "model-a", config: { enabled: false } }],
    });
    const personal = parsePersonalModelConfigRules({
      providerModelRules: [
        { providerId: "provider-a", modelId: "model-a", config: { enabled: true } },
      ],
      manualProviderModelRules: [],
    });
    const rules = ModelConfigRules.composeEffective(builtin, personal);
    expect(rules.resolve({ providerId: "provider-a", modelId: "model-a" }).enabled).toBe(true);
    expect(rules.resolve({ providerId: "provider-b", modelId: "model-a" }).enabled).toBe(false);
    expect(rules.resolve({ providerId: "provider-a", modelId: "MODEL-A" }).enabled).toBe(false);
    expect(rules.rules().map((rule) => rule.type)).toEqual(["model", "provider-model"]);
  });

  it("limits Effective composition to Built-in and Personal exact overrides", () => {
    const builtin = new ModelConfigRules([
      { type: "model", modelMatch: ".*", config: new ModelConfig({ enabled: true }) },
    ]);
    const personal = new ModelConfigRules([
      {
        type: "provider-model",
        providerId: "provider-a",
        modelId: "model-a",
        config: new ModelConfig({ enabled: false }),
      },
    ]);

    const effective = ModelConfigRules.composeEffective(builtin, personal);

    expect(effective.resolve({ providerId: "provider-a", modelId: "model-a" }).enabled).toBe(false);
    expect(effective.rules().map((rule) => rule.type)).toEqual(["model", "provider-model"]);
    expect(personal.rules().map((rule) => rule.type)).toEqual(["provider-model"]);
  });

  it("confines lifecycle ops to exact rules, never guessing look-alike match rules", () => {
    const match = {
      type: "model" as const,
      modelMatch: "model-a",
      config: new ModelConfig({ enabled: false }),
    };
    const rules = new ModelConfigRules([match]).setExact(
      "provider-a",
      "model-a",
      new ModelConfig({ enabled: true }),
    );
    const renamed = rules.renameExactModel("provider-a", "model-a", "model-b");
    expect(renamed.rules()[0]).toEqual(match);
    expect(renamed.getExact("provider-a", "model-a")).toBeUndefined();
    expect(renamed.getExact("provider-a", "model-b")?.enabled).toBe(true);
    expect(renamed.deleteExact("provider-a", "model-b").rules()).toEqual([match]);
  });

  it("persists neither a type discriminator nor mixed rule fields", () => {
    expect(() =>
      parseZCodeBuiltinModelConfigRules({
        ...emptyBuiltin,
        modelRules: [{ type: "model", modelMatch: "model-a", config: { enabled: true } }],
      }),
    ).toThrow();
    expect(() =>
      parsePersonalModelConfigRules({
        providerModelRules: [
          {
            providerId: "provider-a",
            modelId: "model-a",
            modelMatch: "model-a",
            config: { enabled: true },
          },
        ],
        manualProviderModelRules: [],
      }),
    ).toThrow();
  });
});
