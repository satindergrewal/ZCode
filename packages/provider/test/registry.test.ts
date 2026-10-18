import { describe, expect, it, vi } from "vitest";
import {
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderRegistry,
  type ModelSelection,
  type Provider,
} from "../src/index.js";
import { createApiKeyProviderConfig } from "./provider-config-fixtures.js";
import { resolveEffectiveModelSelection } from "../src/effective-model-selection.js";

function provider(
  providerId: string,
  modelId: string,
  reasoningValues: readonly string[] = ["low", "high"],
): Provider {
  return {
    providerId,
    config: createApiKeyProviderConfig({
      apiFormat: "anthropic-messages",
      baseURL: "https://api.example.com",
      apiKey: "test-key",
      models: [modelId],
    }),
    models: [
      {
        modelId,
        config: new ModelConfig({
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
              values: reasoningValues,
              map:
                reasoningValues.length === 1 && reasoningValues[0] === "disabled"
                  ? "{}"
                  : "{'thinking': {'effort': value}}",
            },
            maxOutputTokens: {
              max: 32_000,
              map: "{'max_tokens': maxOutputTokens}",
            },
          }),
        }),
      },
    ],
  };
}

describe("read-only resolution of the current effective selection", () => {
  const classifyProvider = (id: string) =>
    ["old-account", "new-account"].includes(id)
      ? ("account-plan" as const)
      : id === "idle"
        ? ("account-offpeak" as const)
        : ("ordinary" as const);
  const original = Object.freeze({
    providerId: "old-account",
    modelId: "same",
    options: Object.freeze({ reasoningLevel: "high" }),
  });
  const resolve = (
    providers: Provider[],
    selection: ModelSelection = original,
    current = "new-account",
  ) =>
    resolveEffectiveModelSelection({
      registry: { revision: 1, providers },
      selection,
      classifyProvider,
      accountStates: { [current]: { availability: "available", entitled: true, current: true } },
    });

  it("keeps the same model and tier per current account even when the old account is still candidates; intent untouched", () => {
    const result = resolve([provider("old-account", "same"), provider("new-account", "same")]);
    expect(result).toEqual({ effectiveSelection: { ...original, providerId: "new-account" } });
    expect(original.providerId).toBe("old-account");
    expect(result.effectiveSelection?.options).not.toBe(original.options);
  });

  it("keeps the model when only the tier is missing, never substituting by position or top tier", () => {
    expect(resolve([provider("new-account", "same", ["low", "max"])])).toEqual({
      effectiveSelection: { providerId: "new-account", modelId: "same" },
      selectionIssue: "reasoning-level-not-supported",
    });
  });

  it("leaves it empty when the same model is gone: no first-model fallback, no case folding", () => {
    expect(resolve([provider("new-account", "SAME")])).toEqual({
      effectiveSelection: null,
      selectionIssue: "model-not-found",
    });
  });

  it("never swaps plain providers on account switches", () => {
    const selection = { ...original, providerId: "personal" };
    expect(
      resolve([provider("personal", "same"), provider("new-account", "same")], selection),
    ).toEqual({ effectiveSelection: selection });
  });

  it("always recomputes from the original intent once a temporarily missing model returns", () => {
    expect(resolve([]).effectiveSelection).toBeNull();
    expect(resolve([provider("new-account", "same")]).effectiveSelection?.options).toEqual(
      original.options,
    );
  });

  it("adopts no other model on empty intent and never guesses unknown account ids into real accounts", () => {
    const registry = { revision: 1, providers: [provider("new-account", "same")] };
    expect(resolveEffectiveModelSelection({ registry, selection: null, classifyProvider })).toEqual(
      { effectiveSelection: null, selectionIssue: "selection-missing" },
    );
    expect(resolve(registry.providers, { ...original, providerId: "account:not-formal" })).toEqual({
      effectiveSelection: null,
      selectionIssue: "provider-not-found",
    });
  });

  it("picks nothing arbitrary when the current account is ambiguous", () => {
    expect(
      resolveEffectiveModelSelection({
        registry: {
          revision: 1,
          providers: [provider("old-account", "same"), provider("new-account", "same")],
        },
        selection: original,
        classifyProvider,
        accountStates: {
          "old-account": { availability: "available", entitled: true, current: true },
          "new-account": { availability: "available", entitled: true, current: true },
        },
      }),
    ).toEqual({ effectiveSelection: null, selectionIssue: "account-connection-unavailable" });
  });

  it("resolves off-peak only from the original hidden identity, never the current plain account; plain hidden stays unselectable", () => {
    const hidden = {
      ...provider("idle", "same"),
      config: createApiKeyProviderConfig({ visibility: "hidden" }),
    };
    const selection = { ...original, providerId: "idle" };
    expect(
      resolve([hidden, provider("new-account", "same")], selection).effectiveSelection,
    ).toEqual(selection);
    expect(resolve([provider("new-account", "same")], selection).effectiveSelection).toBeNull();
    expect(
      resolve([{ ...hidden, providerId: "personal" }], { ...original, providerId: "personal" })
        .effectiveSelection,
    ).toBeNull();
  });
});

describe("ProviderRegistry", () => {
  it("keeps provider metadata in initial and replaced snapshots; later renames or clears never pollute them", () => {
    const original = { ...provider("A", "a"), providerName: "Original", templateId: "template-a" };
    const registry = new ProviderRegistry([original]);
    const oldView = registry.getView();
    expect(registry.getProvider("A")).toMatchObject({
      providerName: "Original",
      templateId: "template-a",
    });
    registry.replace(
      [{ ...original, providerName: "Renamed", templateId: "template-b" }],
      "rename",
    );
    expect(registry.getView().providers[0]).toMatchObject({
      providerName: "Renamed",
      templateId: "template-b",
    });
    expect(oldView.providers[0]).toMatchObject({
      providerName: "Original",
      templateId: "template-a",
    });
    expect(Object.isFrozen(oldView.providers[0])).toBe(true);
    registry.replace([provider("A", "a")], "clear-metadata");
    expect(registry.getProvider("A")?.providerName).toBeUndefined();
    expect(registry.getProvider("A")?.templateId).toBeUndefined();
    expect(
      registry.validateSelection({
        providerId: "A",
        modelId: "a",
        options: { reasoningLevel: "high" },
      }),
    ).toEqual({ ok: true });
  });

  it("migrates legacy disabled values only in intent parsing; exact execution validation accepts no aliases", () => {
    const registry = new ProviderRegistry([provider("A", "a", ["disabled", "enabled"])]);
    const original = { providerId: "A", modelId: "a", options: { reasoningLevel: "off" } };
    const resolved = resolveEffectiveModelSelection({
      selection: original,
      registry: registry.getView(),
      classifyProvider: () => "ordinary",
      resolveLegacyReasoningLevel: () => "disabled",
    });
    expect(resolved.effectiveSelection?.options?.reasoningLevel).toBe("disabled");
    expect(registry.validateSelection(original).ok).toBe(false);
    expect(registry.validateSelection(resolved.effectiveSelection!).ok).toBe(true);
    const unsupported = resolveEffectiveModelSelection({
      selection: original,
      registry: registry.getView(),
      classifyProvider: () => "ordinary",
      resolveLegacyReasoningLevel: () => "unsupported",
    });
    expect(unsupported.selectionIssue).toBe("reasoning-level-not-supported");
  });
  it("atomically swaps the ordered View, indexes and revision while old snapshots stay frozen", () => {
    const registry = new ProviderRegistry([provider("A", "a")]);
    const oldView = registry.getView();
    const listener = vi.fn();
    const dispose = registry.onDidChange(listener);

    registry.replace([provider("B", "b"), provider("A", "a2")], "config-updated");

    expect(oldView.providers.map((item) => item.providerId)).toEqual(["A"]);
    expect(registry.getView().providers.map((item) => item.providerId)).toEqual(["B", "A"]);
    expect(registry.getProvider("B")?.models[0]?.modelId).toBe("b");
    expect(registry.getModel("A", "a2")?.modelId).toBe("a2");
    expect(registry.getView().revision).toBe(oldView.revision + 1);
    expect(listener).toHaveBeenCalledWith({
      revision: oldView.revision + 1,
      reason: "config-updated",
    });

    dispose();
  });

  it("returns a stable ModelSelection validation result", () => {
    const registry = new ProviderRegistry([provider("A", "a")]);

    expect(registry.validateSelection({ providerId: "A", modelId: "a" })).toEqual({
      ok: false,
      code: "reasoning-level-missing",
      providerId: "A",
      modelId: "a",
    });
    expect(registry.validateSelection({ providerId: "missing", modelId: "a" })).toEqual({
      ok: false,
      code: "provider-not-found",
      providerId: "missing",
    });
    expect(registry.validateSelection({ providerId: "A", modelId: "missing" })).toEqual({
      ok: false,
      code: "model-not-found",
      providerId: "A",
      modelId: "missing",
    });
    expect(
      registry.validateSelection({
        providerId: "A",
        modelId: "a",
        options: { reasoningLevel: "low" },
      }),
    ).toEqual({ ok: true });
    expect(
      registry.validateSelection({
        providerId: "A",
        modelId: "a",
        options: { reasoningLevel: "max" },
      }),
    ).toEqual({
      ok: false,
      code: "reasoning-level-not-supported",
      providerId: "A",
      modelId: "a",
      reasoningLevel: "max",
      supportedLevels: ["low", "high"],
    });
    expect(
      new ProviderRegistry([provider("B", "b", ["disabled"])]).validateSelection({
        providerId: "B",
        modelId: "b",
        options: { reasoningLevel: "high" },
      }),
    ).toEqual({
      ok: false,
      code: "reasoning-level-not-supported",
      providerId: "B",
      modelId: "b",
      reasoningLevel: "high",
      supportedLevels: ["disabled"],
    });
  });
});
