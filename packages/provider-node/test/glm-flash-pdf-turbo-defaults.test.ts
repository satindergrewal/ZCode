import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ModelConfig, ModelConfigRules } from "@zcode/provider";
import { NodeZCodeBuiltinProviderConfigSource } from "../src/index.js";

describe("Todo126 released Flash PDF and template Turbo defaults", () => {
  it.each(["zai-standard-api", "bigmodel-standard-api"])(
    "plain API %s ships both Turbo defaults off, personal can enable",
    async (templateId) => {
      const source = new NodeZCodeBuiltinProviderConfigSource({
        bundledFilePath: fileURLToPath(
          new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
        ),
        watch: false,
      });
      try {
        const snapshot = await source.read();
        for (const modelId of ["GLM-5-Turbo", "GLM-5V-Turbo"]) {
          const input = {
            providerId: "personal",
            templateId,
            modelId,
            apiType: "openai-chat-completions",
          };
          expect(snapshot.models.resolve(input).enabled, modelId).toBe(false);
          const personal = new ModelConfigRules([
            {
              type: "provider-model",
              providerId: "personal",
              modelId,
              config: new ModelConfig({ enabled: true }),
            },
          ]);
          expect(
            ModelConfigRules.composeEffective(snapshot.models, personal).resolve(input).enabled,
          ).toBe(true);
          expect(snapshot.models.resolve({ ...input, templateId: undefined }).enabled).toBe(true);
        }
        for (const modelId of ["GLM-5.3", "GLM-5.3-Flash"]) {
          expect(
            snapshot.models.resolve({
              providerId: "personal",
              templateId,
              modelId,
              apiType: "openai-chat-completions",
            }).enabled,
          ).toBe(true);
        }
      } finally {
        source.dispose();
      }
    },
  );
  it("keeps PDF support across all Flash formats/sites/aliases while other models and personal overrides stay put", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: fileURLToPath(
        new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
      ),
      watch: false,
    });
    try {
      const snapshot = await source.read();
      for (const type of ["provider-model", "manual-provider-model"] as const) {
        const personal = new ModelConfigRules([
          {
            type,
            providerId: "personal",
            modelId: "GLM-5.3-Flash",
            config: new ModelConfig({ properties: { inputFormat: { supportsPdf: false } } }),
          },
        ]);
        const composed = ModelConfigRules.composeEffective(snapshot.models, personal);
        const effective = composed.resolve({
          providerId: "personal",
          modelId: "GLM-5.3-Flash",
          apiType: "openai-responses",
        });
        expect(effective.properties?.inputFormat?.supportsPdf).toBe(false);
        if (type === "manual-provider-model")
          expect(effective.properties?.inputFormat?.supportsImage).toBeUndefined();
      }
      for (const apiType of [
        "anthropic-messages",
        "openai-chat-completions",
        "openai-responses",
      ] as const) {
        for (const baseUrl of [
          "https://api.z.ai/api/anthropic",
          "https://open.bigmodel.cn/api/anthropic",
          "https://proxy.example/v1",
        ]) {
          for (const modelId of ["GLM-5.3-Flash", "glm-5.3-flash", "vendor/GLM-5.3-Flash:free"]) {
            const config = snapshot.models.resolve({
              providerId: "custom",
              modelId,
              apiType,
              baseUrl,
            });
            expect(
              config.properties?.inputFormat?.supportsPdf,
              `${apiType}/${baseUrl}/${modelId}`,
            ).toBe(true);
            expect(
              config.overlay(
                new ModelConfig({ properties: { inputFormat: { supportsPdf: false } } }),
              ).properties?.inputFormat?.supportsPdf,
            ).toBe(false);
          }
          for (const modelId of ["GLM-5.3", "GLM-4.7"]) {
            const config = snapshot.models.resolve({
              providerId: "custom",
              modelId,
              apiType,
              baseUrl,
            });
            expect(config.properties?.inputFormat?.supportsPdf).toBe(false);
          }
        }
      }
    } finally {
      source.dispose();
    }
  });

  it("defaults Turbo off only on the two plan-key templates, personal still able to enable", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: fileURLToPath(
        new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
      ),
      watch: false,
    });
    try {
      const snapshot = await source.read();
      for (const templateId of [
        "zai-api",
        "bigmodel-api",
        "zai-standard-api",
        "bigmodel-standard-api",
        "custom",
      ]) {
        const config = snapshot.models.resolve({
          providerId: "personal",
          templateId,
          modelId: "GLM-5-Turbo",
          apiType: "anthropic-messages",
          baseUrl: "https://example.test",
        });
        // Plain API already defaults Turbo off; keep it. Template-less third parties keep the generic on default.
        expect(config.enabled, templateId).toBe(templateId === "custom");
        expect(config.overlay(new ModelConfig({ enabled: true })).enabled).toBe(true);
        expect(config.overlay(new ModelConfig({ enabled: false })).enabled).toBe(false);
      }
    } finally {
      source.dispose();
    }
  });
});
