import { describe, expect, it } from "vitest";
import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  ZhipuAccountAccessConfig,
  createRegistryProviderConfig,
  parseProviderConfig,
  serializeRegistryProviderConfig,
  type ProviderApiType,
  type ProviderGroup,
} from "../src/index.js";
import { completeProviderConfigDataSchema } from "../src/config/provider-data-schema.js";

const api = new ProviderApiConfig({
  type: "anthropic-messages",
  baseUrl: "https://api.example/v1",
});
const access = new ApiKeyAccessConfig({ apiKey: "test-key" });
const cases = [
  { name: "key", access: access.toJSON(), paths: [["access", "apiKey"]] },
  {
    name: "account",
    access: { type: "zhipu-account", accountType: "zai", mode: "off-peak", entitled: false },
    paths: [
      ["access", "accountType"],
      ["access", "mode"],
      ["access", "entitled"],
    ],
  },
];

describe("Provider data validation and completeness share one contract", () => {
  it("Todo104: member/endpoint fields stay unique, null-clears persist, legacy unrepublished spellings rejected", () => {
    const config = parseProviderConfig({
      group: "standard-personal",
      access: access.toJSON(),
      api: {
        type: "anthropic-messages",
        baseUrl: "https://example.test/anthropic",
        headers: { "X-Client": "test" },
      },
      builtinModelIds: ["builtin"],
      personalModelIds: ["custom"],
      modelOrder: ["custom", "builtin"],
    });
    expect(createRegistryProviderConfig(config).ok).toBe(true);
    expect(config.toJSON()).toMatchObject({
      api: { baseUrl: "https://example.test/anthropic", headers: { "X-Client": "test" } },
      personalModelIds: ["custom"],
    });
    const cleared = config.overlay(
      parseProviderConfig({ api: { baseUrl: null }, personalModelIds: null }),
    );
    expect(cleared.toJSON()).toMatchObject({
      api: { baseUrl: null },
      personalModelIds: null,
      builtinModelIds: ["builtin"],
    });
    expect(createRegistryProviderConfig(cleared).ok).toBe(false);
    expect(parseProviderConfig(cleared.toJSON()).toJSON()).toEqual(cleared.toJSON());
    expect(() => parseProviderConfig({ api: { baseURL: "https://old.invalid" } })).toThrow();
    expect(() => parseProviderConfig({ modelIds: ["old"] })).toThrow();
  });
  for (const scenario of cases) {
    const complete = { group: "zai-family", access: scenario.access, api: api.toJSON() };
    it.each(
      [...scenario.paths, ["group"], ["access"], ["api"], ["api", "type"], ["api", "baseUrl"]].map(
        (path) => ({ path, label: path.join(".") }),
      ),
    )(`$label absent/null is saveable but incomplete for ${scenario.name}`, ({ path }) => {
      for (const replacement of [undefined, null]) {
        const value: Record<string, unknown> = structuredClone(complete);
        let parent = value;
        for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
        if (replacement === undefined) delete parent[path.at(-1)!];
        else parent[path.at(-1)!] = replacement;
        const result = createRegistryProviderConfig(parseProviderConfig(value));
        expect(result.ok).toBe(false);
        if (!result.ok)
          expect(result.issues).toContainEqual(
            expect.objectContaining({
              code: "required-field-missing",
              path: ["provider", ...path],
            }),
          );
      }
    });
    it(`Registry serialization keeps the full contract for ${scenario.name}`, () => {
      const result = createRegistryProviderConfig(parseProviderConfig(complete));
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("fixture must be a complete config");
      const serialized = serializeRegistryProviderConfig(result.config);
      expect(completeProviderConfigDataSchema.parse(serialized)).toEqual(complete);
      expect(Object.isFrozen(result.config)).toBe(true);
    });
  }
  it("lets no unknown API type bypass Registry admission by being non-empty", () => {
    // Simulate an untrusted JS caller; TS static types are never runtime validation.
    const config = new ProviderConfig({
      group: "standard-personal",
      access,
      api: new ProviderApiConfig({ type: "unknown" as ProviderApiType, baseUrl: api.baseUrl }),
    });
    expect(() => parseProviderConfig(config.toJSON())).toThrow();
    expect(createRegistryProviderConfig(config).ok).toBe(false);
  });

  it("lets no unknown group bypass Registry admission by being non-empty", () => {
    const config = new ProviderConfig({ group: "unknown" as ProviderGroup, access, api });
    expect(() => parseProviderConfig(config.toJSON())).toThrow();
    expect(createRegistryProviderConfig(config).ok).toBe(false);
  });

  it("holds the optional admin URL to the schema's URL constraint once filled", () => {
    const config = new ProviderConfig({
      group: "standard-personal",
      api,
      access: new ApiKeyAccessConfig({ apiKey: "test-key", apiKeyManagementUrl: "not-url" }),
    });
    expect(() => parseProviderConfig(config.toJSON())).toThrow();
    expect(createRegistryProviderConfig(config).ok).toBe(false);
  });

  it("keeps optional display/member fields and explicit nulls out of completeness", () => {
    const config = parseProviderConfig({
      group: "standard-personal",
      api: { ...api.toJSON(), headers: null },
      access: { ...access.toJSON(), apiKeyManagementUrl: null },
      logo: null,
      visibility: null,
      personalModelIds: null,
      builtinModelIds: null,
      modelOrder: null,
    });
    expect(createRegistryProviderConfig(config).ok).toBe(true);
    expect(parseProviderConfig(config.toJSON()).toJSON()).toEqual(config.toJSON());
  });

  it("treats false Account entitlements as complete, cleared required values as incomplete, and drops old keys on Access switches", () => {
    const original = new ProviderConfig({ group: "zai-family", access, api });
    const replaced = original.overlay(
      new ProviderConfig({
        access: new ZhipuAccountAccessConfig({
          accountType: "zai",
          mode: "off-peak",
          entitled: false,
        }),
      }),
    );
    expect(createRegistryProviderConfig(replaced).ok).toBe(true);
    expect(replaced.access?.toJSON()).toEqual({
      type: "zhipu-account",
      accountType: "zai",
      mode: "off-peak",
      entitled: false,
    });
    const cleared = replaced.overlay(
      new ProviderConfig({ access: new ZhipuAccountAccessConfig({ mode: null }) }),
    );
    expect(createRegistryProviderConfig(cleared).ok).toBe(false);
    expect(original.access?.toJSON()).toEqual(access.toJSON());
  });
});
