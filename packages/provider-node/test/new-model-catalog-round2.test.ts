import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { compileModelOptionMaps } from "@zcode/model-option-map";
import {
  ModelConfig,
  ModelOptionSpecsConfig,
  parseZCodeBuiltinModelConfigRules,
} from "@zcode/provider";

type Release = {
  config: {
    providerConfigRules: {
      templateRules: { templateId: string; config: { builtinModelIds: string[] } }[];
    };
    modelConfigRules: {
      modelRules: unknown[];
      modelApiRules: unknown[];
      providerSiteRules: unknown[];
      templateModelRules: { templateId: string; modelId: string; config: { enabled: boolean } }[];
      builtinProviderModelRules: unknown[];
    };
  };
};
let release: Release;
let rules: ReturnType<typeof parseZCodeBuiltinModelConfigRules>;
beforeAll(async () => {
  release = JSON.parse(
    await readFile(new URL("../../../config/provider/zcode-builtin.json", import.meta.url), "utf8"),
  );
  rules = parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules);
});
const resolve = (
  modelId: string,
  apiType = "openai-chat-completions",
  baseUrl = "https://fixture.invalid/v1",
  templateId?: string,
) => rules.resolve({ providerId: "fixture", modelId, apiType, baseUrl, templateId });
const patch = (modelId: string, apiType: string, baseUrl: string, reasoningLevel: string) => {
  const config = resolve(modelId, apiType, baseUrl);
  expect(config.optionSpecs?.reasoningLevel?.values).toContain(reasoningLevel);
  return compileModelOptionMaps({
    reasoningLevel: { map: config.optionSpecs!.reasoningLevel!.map! },
    maxOutputTokens: { map: config.optionSpecs!.maxOutputTokens!.map! },
  }).apply({}, { reasoningLevel, maxOutputTokens: 4096 });
};

describe("Todo113 round two: first-party, aggregated and snapshot configs must be independently correct", () => {
  it.each([
    ["gpt-5.4", 1050000, ["none", "low", "medium", "high", "xhigh"]],
    ["gpt-5.4-pro", 1050000, ["medium", "high", "xhigh"]],
    ["gpt-5.4-mini", 400000, ["none", "low", "medium", "high", "xhigh"]],
    ["gpt-5.4-nano", 400000, ["none", "low", "medium", "high", "xhigh"]],
  ])(
    "%s keeps first-party, Zen and OR prefixes consistent with the snapshot",
    (id, context, levels) => {
      for (const [api, url, template, name] of [
        ["openai-responses", "https://api.openai.com/v1", "openai", id],
        ["openai-responses", "https://opencode.ai/zen/v1", "opencode-zen-responses", id],
        ["anthropic-messages", "https://openrouter.ai/api", "openrouter", `openai/${id}`],
      ]) {
        const config = resolve(String(name), String(api), String(url), String(template));
        expect(config.validateComplete()).toEqual([]);
        expect(config.properties?.contextWindow).toBe(context);
        expect(config.optionSpecs?.maxOutputTokens?.max).toBe(128000);
        expect(config.optionSpecs?.reasoningLevel?.values).toEqual(levels);
        expect(config.properties?.inputFormat.toJSON()).toMatchObject({
          supportsImage: true,
          supportsPdf: true,
          supportsVideo: false,
          supportsAudio: false,
        });
        expect(config.properties?.supportsJsonSchemaOutput).toBe(true);
        expect(config.enabled).toBe(false);
      }
      expect(resolve(`vendor/${id}-2026-03-05`).properties?.contextWindow).toBe(context);
    },
  );
  it.each([
    ["qwen3.7-max", 131072, false, false, true],
    ["qwen3.7-max-2026-06-08", 131072, true, true, true],
    ["qwen3.7-plus", 131072, true, true, true],
    ["qwen3.7-flash", 131072, true, true, false],
    ["qwen3.6-plus", 65536, true, true, false],
    ["qwen3.6-flash", 65536, true, true, false],
  ] as const)(
    "%s keeps default aliases, vision snapshot, JSON and Schema apart",
    (id, max, image, video, schema) => {
      for (const name of [id, `vendor/${id}`]) {
        const config = resolve(name);
        expect(config.properties?.contextWindow).toBe(1000000);
        expect(config.optionSpecs?.maxOutputTokens?.max).toBe(max);
        expect(config.optionSpecs?.reasoningLevel?.values).toEqual(["disabled", "enabled"]);
        expect(config.properties?.inputFormat.toJSON()).toMatchObject({
          supportsImage: image,
          supportsVideo: video,
          supportsAudio: false,
          supportsPdf: false,
        });
        expect(config.properties?.supportsJsonSchemaOutput).toBe(schema);
      }
    },
  );
  it("gives Omni its own capacity, modalities and ranges instead of inheriting plain Flash", () => {
    const c = resolve("qwen3.8-omni-flash");
    expect(c.properties?.contextWindow).toBe(65536);
    expect(c.optionSpecs?.maxOutputTokens?.max).toBe(16384);
    expect(c.optionSpecs?.reasoningLevel?.values).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(c.properties?.inputFormat.toJSON()).toMatchObject({
      supportsImage: true,
      supportsVideo: true,
      supportsAudio: true,
      supportsPdf: false,
    });
    expect(c.properties?.supportsJsonSchemaOutput).toBe(false);
    expect(c.properties?.supportsNativeWebSearch).toBe(false);
  });
  it("omits the officially-rejected disabled tier from high-speed Code and leaves K2.6 untouched", () => {
    for (const id of [
      "kimi-k2.7-code",
      "kimi-k2.7-code-highspeed",
      "vendor/kimi-k2.7-code-highspeed",
    ]) {
      const c = resolve(id);
      expect(c.optionSpecs?.reasoningLevel?.values).toEqual(["enabled"]);
      expect(c.properties?.contextWindow).toBe(262144);
      expect(c.optionSpecs?.maxOutputTokens?.max).toBe(98304);
    }
    expect(resolve("kimi-k2.6").optionSpecs?.reasoningLevel?.values).toEqual([
      "disabled",
      "enabled",
    ]);
  });
  it("scopes gateway capabilities to real sites only, never first-party or lookalike domains", () => {
    const router = (id: string) => resolve(id, "anthropic-messages", "https://openrouter.ai/api");
    expect(router("deepseek/deepseek-v4.1-flash").properties?.contextWindow).toBe(1048576);
    expect(router("deepseek/deepseek-v4.1-flash").properties?.supportsJsonSchemaOutput).toBe(true);
    expect(resolve("deepseek-v4.1-flash").properties?.contextWindow).toBe(1000000);
    expect(router("qwen/qwen3.7-flash").optionSpecs?.maxOutputTokens?.max).toBe(65536);
    expect(router("qwen/qwen3.7-plus").properties?.inputFormat.supportsVideo).toBe(false);
    expect(router("qwen/qwen3.8-max-0902").optionSpecs?.reasoningLevel?.values).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(resolve("qwen3.8-max-0902").optionSpecs?.reasoningLevel?.values).toEqual([
      "low",
      "medium",
      "xhigh",
    ]);
    for (const id of ["qwen3.6-plus", "qwen3.6-flash"]) {
      expect(router(`qwen/${id}`).properties?.supportsJsonSchemaOutput).toBe(true);
      expect(resolve(id).properties?.supportsJsonSchemaOutput).toBe(false);
    }
    expect(
      resolve(
        "qwen/qwen3.7-plus",
        "anthropic-messages",
        "https://openrouter.ai.attacker.invalid/api",
      ).properties?.inputFormat.supportsVideo,
    ).toBe(true);
    expect(resolve("deepseek-v4-flash").properties?.inputFormat.supportsImage).toBe(false);
    expect(resolve("deepseek-v4-pro").properties?.inputFormat.supportsImage).toBe(false);
  });
  it("keeps vendor-specific map fields out of official endpoints", () => {
    expect(
      patch("gpt-5.4", "openai-chat-completions", "https://api.openai.com/v1", "none"),
    ).toEqual({ reasoning_effort: "none", max_completion_tokens: 4096 });
    expect(patch("gpt-5.4-pro", "openai-responses", "https://api.openai.com/v1", "xhigh")).toEqual({
      reasoning: { effort: "xhigh" },
      max_output_tokens: 4096,
    });
    expect(
      patch("openai/gpt-5.4-mini", "anthropic-messages", "https://openrouter.ai/api", "none"),
    ).toEqual({ thinking: { type: "disabled" }, max_tokens: 4096 });
    expect(
      patch("openai/gpt-5.4-mini", "anthropic-messages", "https://openrouter.ai/api", "low"),
    ).toEqual({ output_config: { effort: "low" }, max_tokens: 4096 });
    expect(
      patch(
        "qwen3.7-plus",
        "openai-chat-completions",
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        "disabled",
      ),
    ).toEqual({ enable_thinking: false, max_completion_tokens: 4096 });
    expect(
      patch(
        "qwen/qwen3.7-plus",
        "openai-chat-completions",
        "https://openrouter.ai/api/v1",
        "enabled",
      ),
    ).toEqual({ reasoning: { enabled: true }, max_completion_tokens: 4096 });
    expect(
      patch(
        "deepseek/deepseek-v4.1-flash",
        "openai-chat-completions",
        "https://openrouter.ai/api/v1",
        "disabled",
      ),
    ).toEqual({ reasoning: { enabled: false }, max_completion_tokens: 4096 });
    expect(
      patch(
        "qwen3.8-omni-flash",
        "openai-chat-completions",
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        "max",
      ),
    ).toEqual({ reasoning_effort: "max", max_completion_tokens: 4096 });
  });
  it.each([
    "gpt-5.4-image-2",
    "gpt-5.40",
    "gpt-5.4-future",
    "qwen3.7-omni-flash",
    "qwen3.6-max-preview",
    "deepseek-v4.1-pro",
  ])("keeps neighbor model %s unswallowed by the new rules", (id) => {
    expect(resolve(id).properties?.contextWindow).toBe(200000);
  });
  it("still lets personal settings override new Built-ins without ghost-writing saved choices", () => {
    const c = resolve("gpt-5.4").overlay(
      new ModelConfig({
        optionSpecs: new ModelOptionSpecsConfig({
          reasoningLevel: { values: ["personal"], map: '{"custom": true}' },
        }),
      }),
    );
    expect(c.optionSpecs?.reasoningLevel?.values).toEqual(["personal"]);
    expect(c.optionSpecs?.reasoningLevel?.map).toBe('{"custom": true}');
  });
  it("keeps catalog and exact defaults paired; first-party retirements never touch third-party or model rules", () => {
    const ids = (id: string) =>
      release.config.providerConfigRules.templateRules.find((t) => t.templateId === id)!.config
        .builtinModelIds;
    for (const t of release.config.providerConfigRules.templateRules) {
      for (const id of t.config.builtinModelIds)
        expect(
          release.config.modelConfigRules.templateModelRules.filter(
            (r) => r.templateId === t.templateId && r.modelId === id,
          ),
          `${t.templateId}/${id}`,
        ).toHaveLength(1);
    }
    for (const t of ["openai", "openrouter"])
      for (const id of ["gpt-5.4", "gpt-5.4-pro", "gpt-5.4-mini", "gpt-5.4-nano"])
        expect(ids(t)).toContain(t === "openrouter" ? `openai/${id}` : id);
    for (const t of ["qwen-alibaba-model-studio-cn", "qwen-alibaba-model-studio-intl"])
      for (const id of [
        "qwen3.7-max",
        "qwen3.7-plus",
        "qwen3.7-flash",
        "qwen3.6-plus",
        "qwen3.6-flash",
      ])
        expect(ids(t)).toContain(id);
    expect(ids("qwen-alibaba-model-studio-intl")).toContain("qwen3.8-omni-flash");
    expect(ids("moonshot-kimi")).toContain("kimi-k2.7-code-highspeed");
    expect(ids("openrouter")).toContain("deepseek/deepseek-v4.1-flash");
    expect(ids("openrouter")).toContain("qwen/qwen3.8-max-0902");
    for (const [t, removed] of [
      ["deepseek", ["deepseek-v4-flash"]],
      ["xiaomi-mimo", ["mimo-v2-pro", "mimo-v2-omni", "mimo-v2-flash"]],
      [
        "moonshot-kimi",
        [
          "kimi-k2.5",
          "moonshot-v1-8k",
          "moonshot-v1-32k",
          "moonshot-v1-128k",
          "moonshot-v1-8k-vision-preview",
          "moonshot-v1-32k-vision-preview",
          "moonshot-v1-128k-vision-preview",
        ],
      ],
    ] as const) {
      for (const id of removed) {
        expect(ids(t)).not.toContain(id);
        expect(
          release.config.modelConfigRules.templateModelRules.filter(
            (r) => r.templateId === t && r.modelId === id,
          ),
        ).toEqual([]);
      }
    }
    expect(ids("deepseek")).toContain("deepseek-v4-pro");
    expect(ids("openrouter")).toContain("moonshotai/kimi-k2.5");
    expect(ids("openrouter")).toContain("deepseek/deepseek-v4-flash");
    expect(resolve("mimo-v2-flash").properties?.contextWindow).toBe(262144);
  });
});
