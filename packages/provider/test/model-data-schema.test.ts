import { describe, expect, it } from "vitest";
import { parseModelConfig, createRegistryModelConfig } from "../src/index.js";
import { completeModelConfigDataSchema, modelConfigDataSchema } from "@zcode/shared/model-config";

const complete = {
  enabled: true,
  properties: {
    requiresMfjsToolSchema: false,
    contextWindow: 131_072,
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
    supportsMidConversationSystem: true,
  },
  optionSpecs: {
    reasoningLevel: {
      values: ["disabled", "high"],
      map: "{'reasoning_effort': reasoningLevel}",
    },
    maxOutputTokens: { max: 32_768, map: "{'max_tokens': maxOutputTokens}" },
  },
};

function fieldPaths(value: Record<string, unknown>, prefix: string[] = []): string[][] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = [...prefix, key];
    return [
      path,
      ...(child && typeof child === "object" && !Array.isArray(child)
        ? fieldPaths(child as Record<string, unknown>, path)
        : []),
    ];
  });
}

describe("Model schema complete/sparse derivation contract", () => {
  it("keeps MFJS inside properties; explicit false/null never falls back or vanishes", () => {
    for (const value of [true, false, null]) {
      const overlay = parseModelConfig({ properties: { requiresMfjsToolSchema: value } });
      const merged = parseModelConfig(complete).overlay(overlay);
      expect(merged.toJSON().properties?.requiresMfjsToolSchema).toBe(value);
      expect(merged.toJSON()).not.toHaveProperty("requiresMfjsToolSchema");
      expect(createRegistryModelConfig(merged).ok).toBe(value !== null);
      expect(() => parseModelConfig({ requiresMfjsToolSchema: value })).toThrow();
    }
  });
  it.each([
    { key: "reasoningLevel", type: "enum" },
    { key: "maxOutputTokens", type: "limit" },
  ])("rejectes the unpublished $key.type field instead of silently compat-ing", ({ key, type }) => {
    expect(() => parseModelConfig({ optionSpecs: { [key]: { type } } })).toThrow();
  });
  it.each(fieldPaths(complete).map((path) => ({ path, label: path.join(".") })))(
    "$label absent/null is legal only in sparse overlays, never in the Registry",
    ({ path }) => {
      for (const replacement of [undefined, null]) {
        const value: Record<string, unknown> = structuredClone(complete);
        let parent = value;
        for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
        if (replacement === undefined) delete parent[path.at(-1)!];
        else parent[path.at(-1)!] = replacement;
        expect(modelConfigDataSchema.safeParse(value).success).toBe(true);
        expect(completeModelConfigDataSchema.safeParse(value).success).toBe(false);
        const result = createRegistryModelConfig(parseModelConfig(value), ["test-model"]);
        expect(result.ok).toBe(false);
        if (!result.ok)
          expect(result.issues).toContainEqual({
            code: "required-field-missing",
            path: ["test-model", ...path],
            message: `Missing required config test-model.${path.join(".")}`,
          });
      }
    },
  );

  it("keeps parse/class/JSON round-trips identical for valid complete configs, freezing and overlay behavior intact", () => {
    const parsed = parseModelConfig(complete);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(complete);
    expect(completeModelConfigDataSchema.parse(parsed.toJSON())).toEqual(complete);
    expect(createRegistryModelConfig(parsed).ok).toBe(true);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.optionSpecs?.reasoningLevel?.values)).toBe(true);
    const cleared = parsed.overlay(
      parseModelConfig({ properties: { inputFormat: { supportsImage: null } } }),
    );
    expect(cleared.properties?.inputFormat?.supportsImage).toBeNull();
    expect(cleared.properties?.inputFormat?.supportsText).toBe(true);
    expect(parsed.properties?.inputFormat?.supportsImage).toBe(false);
    expect(createRegistryModelConfig(cleared).ok).toBe(false);
  });
});
