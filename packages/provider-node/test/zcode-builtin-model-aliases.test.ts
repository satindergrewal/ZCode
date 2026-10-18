import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeZCodeBuiltinProviderConfigSource } from "../src/index.js";
import { compileModelOptionMaps } from "@zcode/model-option-map";

describe("released model-rule prefix/suffix and override order", () => {
  it("makes OpenRouter Messages GPT selections emit the matching effort and keeps full request model ids", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: fileURLToPath(
        new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
      ),
      watch: false,
    });
    try {
      const snapshot = await source.read();
      for (const modelId of ["openai/gpt-5.6-sol", "openai/gpt-5.3-codex"]) {
        const config = snapshot.models.resolve({
          providerId: "router-instance",
          templateId: "openrouter",
          modelId,
          apiType: "anthropic-messages",
          baseUrl: "https://openrouter.ai/api",
        });
        const maps = compileModelOptionMaps({
          reasoningLevel: { map: config.optionSpecs!.reasoningLevel!.map! },
          maxOutputTokens: { map: config.optionSpecs!.maxOutputTokens!.map! },
        });
        for (const reasoningLevel of config.optionSpecs!.reasoningLevel!.values!) {
          const request = maps.apply(
            { model: modelId, messages: [] },
            { reasoningLevel, maxOutputTokens: 1000 },
          );
          expect(request).toEqual({
            model: modelId,
            messages: [],
            max_tokens: 1000,
            output_config: { effort: reasoningLevel },
          });
        }
      }
    } finally {
      source.dispose();
    }
  });
  it.each(["anthropic-messages", "openai-chat-completions", "openai-responses"] as const)(
    "%s: equivalent prefixes/suffixes reuse capabilities and maps with no aggregated-site allowlist",
    async (apiType) => {
      const source = new NodeZCodeBuiltinProviderConfigSource({
        bundledFilePath: fileURLToPath(
          new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
        ),
        watch: false,
      });
      try {
        const snapshot = await source.read();
        const modelIds = [
          "GLM-5.3",
          "GLM-5.3-Flash",
          "GLM-5.2",
          "GLM-4.6v",
          "GLM-4.7-FlashX",
          "gpt-5.6-sol",
          "claude-haiku-4-5-20251001",
          "claude-opus-5",
          "MiniMax-M2.7-highspeed",
          "MiniMax-M3",
          "kimi-k3",
          "k3-256k",
          "mimo-v2.5-pro",
          "qwen3.8-flash",
          "deepseek-v4-pro",
          "grok-4.6",
        ];
        const get = (modelId: string) =>
          snapshot.models
            .resolve({
              providerId: "custom-alias-check",
              modelId,
              apiType,
              baseUrl: "https://example.test/v1",
            })
            .toJSON();
        for (const modelId of modelIds) {
          const expected = get(modelId);
          for (const alias of [
            `vendor/${modelId}`,
            `gateway/vendor/${modelId}`,
            `${modelId}-20250901`,
            `gateway/${modelId}-20250901`,
            `gateway/${modelId}:free`,
          ]) {
            expect(get(alias), alias).toEqual(expected);
          }
        }
        // Family baseline first, specific variant after: widening match scope must not let family rules re-cover specifics.
        expect(get("gateway/GLM-5.3-Flash-20250901").properties?.inputFormat?.supportsImage).toBe(
          true,
        );
        expect(get("gateway/GLM-5.3-20250901").properties?.inputFormat?.supportsImage).toBe(false);
        expect(get("gateway/k3-256k-20250901").properties?.contextWindow).toBe(262_144);
        expect(get("gateway/mimo-v2.5-pro-20250901").properties?.inputFormat?.supportsVideo).toBe(
          false,
        );
        for (const modelId of [
          "GLM-5-Turbo",
          "GLM-4.7-Flash",
          "GLM-4.7-FlashX",
          "MiniMax-M2.5-highspeed",
          "GLM-4.1V-Thinking-Flash",
        ]) {
          expect(get(`vendor/${modelId}:free`), modelId).toEqual(get(modelId));
        }
      } finally {
        source.dispose();
      }
    },
  );

  it("gives every maintained vendor on aggregated templates a default-enabled rep while all members build full config and request maps", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: fileURLToPath(
        new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
      ),
      watch: false,
    });
    try {
      const snapshot = await source.read();
      const enabledVendors = new Set<string>();
      for (const templateId of [
        "openrouter",
        "opencode-zen-responses",
        "opencode-zen-messages",
        "opencode-zen-chat",
      ]) {
        const template = snapshot.providerTemplates!.get(templateId)!;
        const api = template.config.api!;
        for (const modelId of template.config.builtinModelIds!) {
          const config = snapshot.models.resolve({
            providerId: "aggregate-instance",
            templateId,
            modelId,
            apiType: api.type!,
            baseUrl: api.baseUrl!,
          });
          expect(config.validateComplete(), `${templateId}/${modelId}`).toEqual([]);
          if (templateId === "openrouter" && config.enabled)
            enabledVendors.add(modelId.split("/")[0]!);
          const maps = compileModelOptionMaps({
            reasoningLevel: { map: config.optionSpecs!.reasoningLevel!.map! },
            maxOutputTokens: { map: config.optionSpecs!.maxOutputTokens!.map! },
          });
          for (const reasoningLevel of config.optionSpecs!.reasoningLevel!.values!) {
            const request = maps.apply(
              { model: modelId, messages: [] },
              { reasoningLevel, maxOutputTokens: 1000 },
            );
            expect(request.model).toBe(modelId);
            expect(
              request[
                api.type === "openai-responses"
                  ? "max_output_tokens"
                  : api.type === "openai-chat-completions"
                    ? "max_completion_tokens"
                    : "max_tokens"
              ],
            ).toBe(1000);
          }
        }
      }
      expect([...enabledVendors].sort()).toEqual(
        [
          "anthropic",
          "deepseek",
          "minimax",
          "moonshotai",
          "openai",
          "qwen",
          "x-ai",
          "xiaomi",
          "z-ai",
        ].sort(),
      );
    } finally {
      source.dispose();
    }
  });
});
