import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ModelConfigRules, ProviderConfigMap } from "@zcode/provider";
import {
  decodeProviderConfigFile,
  encodeProviderConfigFile,
} from "../src/provider-config-file-codec.js";
import {
  decodeZCodeBuiltinRelease,
  encodeZCodeBuiltinRelease,
} from "../src/zcode-builtin-release.js";

describe("Todo104 final file envelope", () => {
  it("requires three empty arrays in personal configs, keeps default selection in config, and round-trips losslessly", () => {
    const config = {
      providerOrder: ["p"],
      providerConfigRules: { providerRules: [{ providerId: "p", providerName: "P", config: {} }] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      defaultModelSelection: { providerId: "p", modelId: "m", options: { reasoningLevel: "high" } },
    };
    const file = { schemaVersion: 1, config };
    const decoded = decodeProviderConfigFile(file);
    expect(decoded.defaultModelSelection).toEqual(config.defaultModelSelection);
    expect(encodeProviderConfigFile(decoded)).toEqual(file);
    expect(
      encodeProviderConfigFile({
        providers: ProviderConfigMap.empty(),
        models: ModelConfigRules.empty(),
      }),
    ).toEqual({
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      },
    });
  });

  it("rejectes pre-launch envelopes/fields and never fabricates an optional default selection from null", () => {
    expect(() =>
      decodeProviderConfigFile({
        schemaVersion: 1,
        providers: {},
        modelConfigRules: { providerModelRules: [] },
      }),
    ).toThrow();
    const config = {
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    };
    expect(() =>
      decodeProviderConfigFile({
        schemaVersion: 1,
        config: { ...config, defaultModelSelection: null },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderConfigFile({
        schemaVersion: 1,
        config: { ...config, configuredDefault: { providerId: "p", modelId: "m" } },
      }),
    ).toThrow();
    expect(() =>
      decodeProviderConfigFile({
        schemaVersion: 1,
        config: { ...config, providerConfigRules: undefined },
      }),
    ).toThrow();
  });

  it("wraps the real Builtin in the final envelope, round-trips fully, and never regresses the published revision", async () => {
    const raw = JSON.parse(
      await readFile(
        new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
        "utf8",
      ),
    );
    expect(raw.schemaVersion).toBe(1);
    expect(raw.revision).toBeGreaterThanOrEqual(18);
    const parsed = decodeZCodeBuiltinRelease(raw);
    expect(encodeZCodeBuiltinRelease(parsed)).toEqual(raw);
    expect(parsed.config.providers.keys().length).toBeGreaterThan(0);
    expect(parsed.config.providerTemplates.keys().length).toBeGreaterThan(0);
    for (const rule of parsed.config.providers.toJSON()) {
      expect(rule.config).not.toHaveProperty("templateId");
      expect(rule.config).not.toHaveProperty("label");
    }
  });
});
