import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { compileModelOptionMaps } from "@zcode/model-option-map";
import {
  ModelConfig,
  ModelOptionSpecsConfig,
  validateModelSelectionOptions,
} from "@zcode/provider";
import { NodeZCodeBuiltinProviderConfigSource } from "../src/index.js";
import baseline from "./fixtures/reasoning-map-before-todo95.json";

const source = new NodeZCodeBuiltinProviderConfigSource({
  bundledFilePath: fileURLToPath(
    new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
  ),
  watch: false,
});
let snapshot: Awaited<ReturnType<typeof source.read>>;
type Rule = {
  modelMatch: string;
  apiTypeMatch: string;
  baseUrlMatch?: string;
  config: { optionSpecs?: { reasoningLevel?: { map?: string } } };
};
let rules: Record<string, Rule[]>;
beforeAll(async () => {
  snapshot = await source.read();
  rules = JSON.parse(
    await readFile(new URL("../../../config/provider/zcode-builtin.json", import.meta.url), "utf8"),
  ).config.modelConfigRules;
});
afterAll(() => source.dispose());

// Baseline expressions from a56dc32c26, grouped identically but asserted rule by rule; prettifying must never move expectations.
const levels = [
  ["low", "high", "max"],
  ["low", "high", "max"],
  ["off", "nothink", "disabled", "enabled"],
  ["nothink", "high", "max"],
  ["low", "high", "max"],
  ["none", "low", "medium", "high", "xhigh", "max"],
  ["low", "medium", "high", "xhigh"],
  ["low", "medium", "high", "xhigh", "max"],
  ["low", "high", "max"],
  ["off", "enabled"],
  ["off", "enabled"],
  ["off", "low", "high", "max"],
  ["off", "low", "high", "max"],
  ["low", "medium", "xhigh"],
  ["low", "medium", "xhigh"],
  ["low", "medium", "xhigh"],
  ["disabled", "off", "enabled"],
  ["none", "low", "medium", "high", "xhigh", "max"],
  ["off", "low", "high", "max"],
];
const outputMaps: Record<string, string> = {
  "anthropic-messages": '{"max_tokens":maxOutputTokens}',
  "openai-chat-completions": '{"max_completion_tokens":maxOutputTokens}',
  "openai-responses": '{"max_output_tokens":maxOutputTokens}',
};
const bases = [
  { model: "unchanged", messages: [] },
  {
    model: "unchanged",
    messages: [],
    thinking: { type: "before", budget_tokens: 777 },
    output_config: { effort: "before", extra: true },
    reasoning: { effort: "before", summary: "auto" },
    reasoning_effort: "before",
    enable_thinking: null,
  },
];

describe("Todo95 dedicated-map valid-request equivalence", () => {
  for (const [group, entry] of baseline.entries()) {
    for (const reference of entry.rules) {
      it(`${reference.scope}[${reference.index}] ${reference.modelMatch} ${reference.apiMatch}`, () => {
        // Reordering rules shifts indices; locate by full match conditions, keeping baseline expressions and request asserts.
        const matches = rules[reference.scope]!.filter(
          (rule) =>
            rule.modelMatch === reference.modelMatch &&
            rule.apiTypeMatch === reference.apiMatch &&
            rule.baseUrlMatch === reference.baseURLMatch,
        );
        expect(matches).toHaveLength(1);
        const rule = matches[0]!;
        expect(rule.modelMatch).toBe(reference.modelMatch);
        expect(rule.apiTypeMatch).toBe(reference.apiMatch);
        expect(rule.baseUrlMatch).toBe(reference.baseURLMatch);
        const compile = (map: string) =>
          compileModelOptionMaps({
            reasoningLevel: { map },
            maxOutputTokens: { map: outputMaps[reference.apiMatch]! },
          });
        const before = compile(entry.map);
        const after = compile(rule.config.optionSpecs!.reasoningLevel!.map!);
        for (const reasoningLevel of levels[group]!) {
          for (const base of bases) {
            const options = { reasoningLevel, maxOutputTokens: 32000 };
            // C renames compare old input/old map against new input/new map; A/B request baselines stay frozen.
            const renamed =
              reasoningLevel === "off" || reasoningLevel === "nothink"
                ? "disabled"
                : reasoningLevel;
            expect(
              after.apply(base, { ...options, reasoningLevel: renamed }),
              reasoningLevel,
            ).toEqual(before.apply(base, options));
          }
        }
      });
    }
  }
  it("misses none of the legacy dedicated maps; new models and the Go site are covered by dedicated config and wire tests", () => {
    const newModelMatchers = new Set([
      // The OpenRouter budget-less enabled fix is accepted separately in openrouter-reasoning-contract.test.ts.
      ".*(?:glm-|deepseek-|kimi-k2|qwen|mimo-).*",
      ".*gpt-6-astra(?:[.\\-:/\\[].*)?",
      ".*claude-(?:fable|mythos)-5[.-]1(?:[.\\-:/\\[].*)?",
      ".*deepseek-flash(?:[.\\-:/\\[].*)?",
      "deepseek-flash",
      ".*gpt-5\\.4(?:-(?:pro|mini|nano))?(?:-20\\d{2}(?:-?\\d{2}){2})?(?:[:/\\[].*)?",
      ".*deepseek-v4[.-]1-flash(?:[.\\-:/\\[].*)?",
      ".*qwen3\\.(?:7-(?:max|plus|flash)|6-(?:plus|flash))(?:-20\\d{2}(?:-?\\d{2}){2})?(?:[:/\\[].*)?",
      ".*qwen3\\.8-omni-flash(?:-20\\d{2}(?:-?\\d{2}){2})?(?:[:/\\[].*)?",
    ]);
    const current = ["modelApiRules", "providerSiteRules"].flatMap((scope) =>
      rules[scope]!.flatMap((rule) =>
        rule.modelMatch !== ".*" &&
        !newModelMatchers.has(rule.modelMatch) &&
        // The new Go site is outside the Todo95 baseline; members/tiers/requests are covered in opencode-go.
        !(
          scope === "providerSiteRules" && rule.baseUrlMatch === "https://opencode\\.ai/zen/go/v1/?"
        ) &&
        rule.config.optionSpecs?.reasoningLevel?.map
          ? [JSON.stringify([scope, rule.modelMatch, rule.apiTypeMatch, rule.baseUrlMatch])]
          : [],
      ),
    );
    expect(current.sort()).toEqual(
      baseline
        .flatMap((group) =>
          group.rules.map((rule) =>
            JSON.stringify([rule.scope, rule.modelMatch, rule.apiMatch, rule.baseURLMatch]),
          ),
        )
        .sort(),
    );
  });
});

describe("Todo95 API Schema fallback", () => {
  for (const apiType of [
    "anthropic-messages",
    "openai-chat-completions",
    "openai-responses",
  ] as const) {
    it(`${apiType} unknown models inherit the map by adding a tier only, Personal maps stay authoritative`, () => {
      const original = snapshot.models.resolve({
        providerId: "unknown",
        modelId: "future-unknown-model",
        apiType,
        baseUrl: "https://example.test/v1",
      });
      expect(original.optionSpecs!.reasoningLevel!.values).toEqual(["disabled", "enabled"]);
      const configured = original.overlay(
        new ModelConfig({
          optionSpecs: new ModelOptionSpecsConfig({
            reasoningLevel: {
              values: [
                "disabled",
                "enabled",
                "low",
                "high",
                "max",
                ...(apiType === "anthropic-messages" ? [] : ["none"]),
              ],
            },
          }),
        }),
      );
      expect(configured.validateComplete()).toEqual([]);
      const selectionModel = {
        config: {
          optionSpecs: {
            reasoningLevel: { values: configured.optionSpecs!.reasoningLevel!.values! },
          },
        },
      };
      expect(
        validateModelSelectionOptions(selectionModel, {
          providerId: "unknown",
          modelId: "future-unknown-model",
          options: { reasoningLevel: "not-declared" },
        }),
      ).toMatchObject({ ok: false, code: "reasoning-level-not-supported" });
      const apply = (config: ModelConfig, reasoningLevel: string) =>
        compileModelOptionMaps({
          reasoningLevel: { map: config.optionSpecs!.reasoningLevel!.map! },
          maxOutputTokens: { map: config.optionSpecs!.maxOutputTokens!.map! },
        }).apply(
          { model: "future-unknown-model", messages: [] },
          { reasoningLevel, maxOutputTokens: 32000 },
        );
      for (const level of configured.optionSpecs!.reasoningLevel!.values!) {
        const effort = level === "disabled" ? "none" : level === "enabled" ? "high" : level;
        const disabled = level === "disabled" || level === "none";
        const expected =
          apiType === "anthropic-messages"
            ? level === "disabled"
              ? { thinking: { type: "disabled" } }
              : { thinking: { type: "adaptive" }, output_config: { effort } }
            : apiType === "openai-responses"
              ? { reasoning: { effort } }
              : {
                  thinking: { type: disabled ? "disabled" : "enabled" },
                  enable_thinking: !disabled,
                  reasoning_effort: effort,
                  reasoning: { effort },
                };
        const outputField =
          apiType === "anthropic-messages"
            ? "max_tokens"
            : apiType === "openai-responses"
              ? "max_output_tokens"
              : "max_completion_tokens";
        expect(apply(configured, level)).toEqual({
          model: "future-unknown-model",
          messages: [],
          ...expected,
          [outputField]: 32000,
        });
      }
      const custom = configured.overlay(
        new ModelConfig({
          optionSpecs: new ModelOptionSpecsConfig({
            reasoningLevel: { map: '{"custom_effort":reasoningLevel}' },
          }),
        }),
      );
      const request = apply(custom, "high");
      expect(request.custom_effort).toBe("high");
      expect(request).not.toHaveProperty("thinking");
      expect(request).not.toHaveProperty("reasoning");
      expect(original.optionSpecs!.reasoningLevel!.values).toEqual(["disabled", "enabled"]);
    });
  }
});

describe("Todo138 model-level fallback and dedicated tiers", () => {
  it("keeps two model-level tiers with no API info; API-generic rules declare no tiers", () => {
    const result = snapshot.models.resolve({
      providerId: "unknown",
      modelId: "future-unknown-model",
    });
    expect(result.optionSpecs!.reasoningLevel!.values).toEqual(["disabled", "enabled"]);
    expect(result.optionSpecs!.reasoningLevel!.map).toBe("{}");
    for (const rule of rules.modelApiRules!.filter((rule) => rule.modelMatch === ".*")) {
      expect(rule.config.optionSpecs?.reasoningLevel).not.toHaveProperty("values");
    }
  });
  it.each([
    ["gpt-5.4", ["none", "low", "medium", "high", "xhigh"]],
    ["GLM-5.3", ["low", "high", "max"]],
  ])("%s keeps its dedicated tiers across all three APIs", (modelId, values) => {
    for (const apiType of [
      "anthropic-messages",
      "openai-chat-completions",
      "openai-responses",
    ] as const) {
      expect(
        snapshot.models.resolve({
          providerId: "unknown",
          modelId,
          apiType,
          baseUrl: "https://example.test/v1",
        }).optionSpecs!.reasoningLevel!.values,
      ).toEqual(values);
    }
  });
});
