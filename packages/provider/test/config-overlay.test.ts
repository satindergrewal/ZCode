import { describe, expect, it } from "vitest";
import {
  EnumOptionSpecConfig,
  LimitOptionSpecConfig,
  ModelConfig,
  ModelInputFormatConfig,
  ModelOptionSpecsConfig,
  ModelOutputFormatConfig,
  ModelPropertiesConfig,
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  parseModelConfig,
  parseProviderConfigMap,
} from "../src/index.js";

describe("ProviderConfigMap overlay", () => {
  it("keeps provider enabled outer; overlays, round-trips and later writes preserve false", () => {
    const base = parseProviderConfigMap([{ providerId: "p", enabled: true, config: {} }]);
    const off = parseProviderConfigMap([{ providerId: "p", enabled: false, config: {} }]);
    const updated = base
      .overlay(off)
      .overlay(parseProviderConfigMap([{ providerId: "p", providerName: "renamed", config: {} }]));
    expect(updated.getRule("p")?.enabled).toBe(false);
    expect(parseProviderConfigMap(updated.toJSON()).getRule("p")?.enabled).toBe(false);
    expect(() =>
      parseProviderConfigMap([{ providerId: "p", config: { enabled: false } }]),
    ).toThrow();
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "complete and save schemas reject invalid contextWindow alike: %s",
    (contextWindow) => {
      const properties = new ModelPropertiesConfig({
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
      });
      expect(() => parseModelConfig({ properties: properties.toJSON() })).toThrow();
      expect(properties.validateComplete()).toContainEqual(
        expect.objectContaining({ path: ["contextWindow"] }),
      );
    },
  );

  it.each([{ values: [" "] }, { values: ["low", "low"] }])(
    "the sparse schema rejects invalid tiers too: $values",
    ({ values }) => {
      expect(() => parseModelConfig({ optionSpecs: { reasoningLevel: { values } } })).toThrow();
    },
  );

  it("rejects non-safe-integer output limits in the complete schema", () => {
    const spec = new LimitOptionSpecConfig({
      max: Number.MAX_SAFE_INTEGER + 1,
      map: "{'max_tokens': maxOutputTokens}",
    });
    expect(spec.validateComplete()).toContainEqual(expect.objectContaining({ path: ["max"] }));
  });
  it("keeps ZCodeBuiltin key positions and appends new keys in Personal order", () => {
    const zcodeBuiltin = new ProviderConfigMap([
      {
        providerId: "A",
        providerName: "ZCodeBuiltin A",
        config: new ProviderConfig({
          logo: { type: "builtin", key: "provider-a" },
          builtinModelIds: ["m1", "m2"],
        }),
      },
      ["B", new ProviderConfig({ api: new ProviderApiConfig({ baseUrl: "https://b.example" }) })],
      ["C", new ProviderConfig({ api: new ProviderApiConfig({ baseUrl: "https://c.example" }) })],
    ]);
    const personal = new ProviderConfigMap([
      ["Y", new ProviderConfig()],
      { providerId: "C", providerName: "Personal C", config: new ProviderConfig({}) },
      ["X", new ProviderConfig()],
      {
        providerId: "A",
        providerName: "Personal A",
        config: new ProviderConfig({
          access: new ApiKeyAccessConfig({
            apiKeyManagementUrl: "https://personal.example/api-keys",
          }),
          personalModelIds: ["m1"],
        }),
      },
    ]);

    const effective = zcodeBuiltin.overlay(personal);

    expect(effective.keys()).toEqual(["A", "B", "C", "Y", "X"]);
    expect(effective.get("A")?.builtinModelIds).toEqual(["m1", "m2"]);
    expect(effective.get("A")?.personalModelIds).toEqual(["m1"]);
    expect(effective.getRule("A")?.providerName).toBe("Personal A");
    expect(effective.get("A")?.logo).toEqual({ type: "builtin", key: "provider-a" });
    expect(
      effective.get("A")?.access?.type === "api-key"
        ? effective.get("A")?.access.apiKeyManagementUrl
        : undefined,
    ).toBe("https://personal.example/api-keys");
    expect(effective.get("C")?.api?.baseUrl).toBe("https://c.example");
    expect(effective.getRule("C")?.providerName).toBe("Personal C");
    expect(zcodeBuiltin.get("A")?.builtinModelIds).toEqual(["m1", "m2"]);
    expect(personal.keys()).toEqual(["Y", "C", "X", "A"]);
  });

  it("reorders mentioned keys as given and keeps the rest", () => {
    const personal = new ProviderConfigMap([
      ["Y", new ProviderConfig()],
      { providerId: "C", providerName: "Personal C", config: new ProviderConfig({}) },
      ["X", new ProviderConfig()],
      ["A", new ProviderConfig({ personalModelIds: ["m1"] })],
      ["unmentioned", new ProviderConfig()],
    ]);

    const reordered = personal.reorder(["A", "B", "C", "X", "Y"]);

    expect(reordered.keys()).toEqual(["A", "C", "X", "Y", "unmentioned"]);
    expect(personal.keys()).toEqual(["Y", "C", "X", "A", "unmentioned"]);
  });

  it("overlays config fields recursively and replaces plain fields wholesale", () => {
    const base = new ModelConfig({
      properties: new ModelPropertiesConfig({
        requiresMfjsToolSchema: false,
        contextWindow: 200_000,
        inputFormat: new ModelInputFormatConfig({
          supportsText: true,
          supportsImage: false,
          supportsPdf: false,
        }),
        outputFormat: new ModelOutputFormatConfig({ supportsText: true }),
      }),
      optionSpecs: new ModelOptionSpecsConfig({
        reasoningLevel: {
          values: ["low", "high"],
          map: "{'reasoning': {'effort': reasoningLevel}}",
        },
        maxOutputTokens: {
          max: 32_000,
          map: "{'max_output_tokens': maxOutputTokens}",
        },
      }),
    });
    const patch = new ModelConfig({
      properties: new ModelPropertiesConfig({
        requiresMfjsToolSchema: true,
        inputFormat: new ModelInputFormatConfig({ supportsImage: true }),
      }),
      optionSpecs: new ModelOptionSpecsConfig({
        reasoningLevel: { values: ["off", "on"] },
      }),
    });

    const effective = base.overlay(patch);

    expect(effective.properties?.contextWindow).toBe(200_000);
    expect(effective.properties?.inputFormat?.supportsText).toBe(true);
    expect(effective.properties?.inputFormat?.supportsImage).toBe(true);
    expect(effective.properties?.inputFormat?.supportsPdf).toBe(false);
    expect(effective.properties?.outputFormat?.supportsText).toBe(true);
    expect(effective.optionSpecs?.reasoningLevel).toEqual({
      values: ["off", "on"],
      map: "{'reasoning': {'effort': reasoningLevel}}",
    });
    expect(effective.optionSpecs?.maxOutputTokens).toEqual({
      max: 32_000,
      map: "{'max_output_tokens': maxOutputTokens}",
    });
    expect(effective.properties?.requiresMfjsToolSchema).toBe(true);
  });

  it("requires the final Option Spec map to compile and return an Object", () => {
    const model = new ModelConfig({
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
        reasoningLevel: {
          values: ["low", "high"],
          map: "reasoningLevel.field",
        },
        maxOutputTokens: {
          max: 32_000,
          map: "{'max_tokens': maxOutputTokens}",
        },
      }),
    });

    expect(model.validateComplete(["models", "example"])).toContainEqual({
      code: "invalid-option-spec",
      path: ["models", "example", "optionSpecs", "reasoningLevel", "map"],
      message: expect.stringContaining("member access"),
    });
  });

  it("lets an Option Spec reference only its own same-name inputs", () => {
    expect(() =>
      parseModelConfig({
        optionSpecs: {
          reasoningLevel: {
            map: "{'reasoning_effort': maxOutputTokens}",
          },
        },
      }),
    ).toThrow(/maxOutputTokens/);

    expect(() =>
      parseModelConfig({
        optionSpecs: {
          maxOutputTokens: {
            map: "{'max_tokens': reasoningLevel}",
          },
        },
      }),
    ).toThrow(/reasoningLevel/);
  });

  it("expresses strict JSON Schema capability via supportsJsonSchemaOutput", () => {
    expect(
      parseModelConfig({
        properties: { supportsJsonSchemaOutput: true },
      }).properties?.supportsJsonSchemaOutput,
    ).toBe(true);
    expect(() =>
      parseModelConfig({
        properties: { supportsStructuredOutput: true },
      }),
    ).toThrow();
  });

  it("requires a complete Reasoning Option Spec in the final Model Config", () => {
    const model = new ModelConfig({
      optionSpecs: new ModelOptionSpecsConfig({
        maxOutputTokens: {
          max: 32_000,
          map: "{'max_tokens': maxOutputTokens}",
        },
      }),
    });

    expect(
      model.optionSpecs?.validateComplete(["models", "example", "optionSpecs"]),
    ).toContainEqual(
      expect.objectContaining({
        code: "required-field-missing",
        path: ["models", "example", "optionSpecs", "reasoningLevel"],
      }),
    );
  });

  it("accepts a disabled single tier and empty Request Body Patch as the no-reasoning baseline", () => {
    const optionSpecs = new ModelOptionSpecsConfig({
      reasoningLevel: {
        values: ["disabled"],
        map: "{}",
      },
      maxOutputTokens: {
        max: 32_000,
        map: "{'max_tokens': maxOutputTokens}",
      },
    });

    expect(optionSpecs.validateComplete(["models", "example", "optionSpecs"])).toEqual([]);
  });

  it.each([
    { values: [], message: "reasoningLevel.values must not be empty" },
    { values: ["low", ""], message: "reasoningLevel.values must be non-empty strings" },
    { values: ["low", "low"], message: "reasoningLevel.values must not repeat" },
  ])("rejectes incomplete Reasoning tiers: $message", ({ values, message }) => {
    const spec = new EnumOptionSpecConfig({ values, map: "{}" });

    expect(spec.validateComplete(["optionSpecs", "reasoningLevel"])).toContainEqual(
      expect.objectContaining({ code: "invalid-option-spec", message }),
    );
  });

  it("rejectes non-Object Option maps at the write boundary in the schema", () => {
    expect(() =>
      parseModelConfig({
        optionSpecs: {
          reasoningLevel: {
            values: ["low", "high"],
            map: "reasoningLevel",
          },
        },
      }),
    ).toThrow(/object/i);
  });

  it("rejectes the retired Option Spec default in the schema", () => {
    expect(() =>
      parseModelConfig({
        optionSpecs: {
          reasoningLevel: {
            values: ["low", "high"],
            default: "high",
            map: "{'reasoning': {'effort': reasoningLevel}}",
          },
        },
      }),
    ).toThrow(/unrecognized|default/i);
  });

  it("clears fields with null and reports missing required values at final completeness", () => {
    const base = new ModelConfig({
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
        maxOutputTokens: {
          max: 32_000,
          map: "{'max_tokens': maxOutputTokens}",
        },
      }),
    });

    const effective = base.overlay(
      new ModelConfig({
        properties: new ModelPropertiesConfig({
          requiresMfjsToolSchema: null,
          contextWindow: null,
        }),
      }),
    );

    expect(effective.properties?.contextWindow).toBeNull();
    expect(effective.validateComplete(["models", "example"])).toContainEqual({
      code: "required-field-missing",
      path: ["models", "example", "properties", "contextWindow"],
      message: "Missing required config models.example.properties.contextWindow",
    });
    expect(effective.validateComplete(["models", "example"])).toContainEqual({
      code: "required-field-missing",
      path: ["models", "example", "properties", "requiresMfjsToolSchema"],
      message: "Missing required config models.example.properties.requiresMfjsToolSchema",
    });
  });

  it("parses from plain objects and rejects unknown fields", () => {
    const parsed = parseProviderConfigMap([
      {
        providerId: "local",
        config: {
          access: { type: "api-key", apiKey: "test-key" },
          api: {
            type: "anthropic-messages",
            baseUrl: "https://api.example.com",
          },
          builtinModelIds: ["model-a"],
        },
      },
    ]);

    expect(parsed.keys()).toEqual(["local"]);
    expect(parsed.get("local")?.api?.baseUrl).toBe("https://api.example.com");
    expect(() =>
      parseProviderConfigMap([{ providerId: "invalid", config: { unknownField: true } }]),
    ).toThrow();
  });
});
