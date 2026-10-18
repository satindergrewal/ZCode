import { describe, expect, it } from "vitest";
import {
  normalizeModelSelection,
  completeNewModelSelection,
  resolveInitialModelSelection,
  type ProviderRegistryView,
} from "../src/index.js";
import { ModelConfig, ModelOptionSpecsConfig, ModelPropertiesConfig } from "../src/config/index.js";
import { createApiKeyProviderConfig } from "./provider-config-fixtures.js";

describe("resolveInitialModelSelection", () => {
  const registry = registryView();

  it("accepts only persisted configured defaults with valid reasoning", () => {
    expect(
      resolveInitialModelSelection({
        configuredDefault: {
          providerId: "provider-b",
          modelId: "model-b",
          options: { reasoningLevel: "high" },
        },
        registry,
      }),
    ).toEqual({
      selection: {
        providerId: "provider-b",
        modelId: "model-b",
        options: { reasoningLevel: "high" },
      },
      source: "configured-default",
    });
  });

  it("falls back to the Registry recommendation for unavailable configured defaults and never writes the preference back", () => {
    expect(
      resolveInitialModelSelection({
        configuredDefault: { providerId: "removed", modelId: "removed" },
        registry,
      }),
    ).toEqual({
      source: "registry-fallback",
      selection: {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "high" },
      },
    });
  });

  it("seeds the top tier by visible-provider order when a fresh selection has no configured default", () => {
    expect(
      resolveInitialModelSelection({
        registry,
      }),
    ).toEqual({
      source: "registry-fallback",
      selection: {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "high" },
      },
    });
  });

  it("invalidates the whole default preference when its tier dies; fresh drafts take the Registry recommendation again", () => {
    expect(
      resolveInitialModelSelection({
        configuredDefault: {
          providerId: "provider-b",
          modelId: "model-b",
          options: { reasoningLevel: "removed" },
        },
        registry,
      }),
    ).toEqual({
      source: "registry-fallback",
      selection: {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "high" },
      },
    });
  });

  it("reports an empty registry without inventing a model", () => {
    expect(
      resolveInitialModelSelection({
        registry: { revision: 0, providers: [] },
      }),
    ).toEqual({ source: "none" });
  });
});

describe("normalizeModelSelection", () => {
  it("takes the target model's top tier on explicit selection instead of inheriting the source tier", () => {
    expect(
      completeNewModelSelection(registryView(), {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "low" },
      }),
    ).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
      options: { reasoningLevel: "high" },
    });
  });
  it("keeps the model and clears reasoning when a new selection lacks it", () => {
    expect(
      normalizeModelSelection(registryView(), {
        providerId: "provider-a",
        modelId: "model-a",
      }),
    ).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
    });
  });

  it("clears explicit-but-invalid reasoning instead of silently swapping tiers", () => {
    expect(
      normalizeModelSelection(registryView(), {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "removed" },
      }),
    ).toEqual({
      providerId: "provider-a",
      modelId: "model-a",
    });
  });
});

function registryView(): ProviderRegistryView {
  return {
    revision: 1,
    providers: ["provider-a", "provider-b"].map((providerId) => ({
      providerId,
      config: createApiKeyProviderConfig({
        apiFormat: "anthropic-messages",
        apiKey: "test-key",
        baseURL: "https://example.com",
        models: [`model-${providerId.at(-1)}`],
      }),
      models: [
        {
          modelId: `model-${providerId.at(-1)}`,
          config: new ModelConfig({
            properties: new ModelPropertiesConfig({
              requiresMfjsToolSchema: false,
              contextWindow: 100_000,
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
                map: "{'reasoning': {'effort': reasoningLevel}}",
              },
              maxOutputTokens: {
                max: 8_000,
                map: "{'max_tokens': maxOutputTokens}",
              },
            }),
          }),
        },
      ],
    })),
  };
}
