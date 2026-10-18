import { describe, expect, it } from "vitest";
import {
  parseAccountProviderConfigMap,
  parsePersonalModelConfigRules,
  parsePersonalProviderConfigMap,
  parseZCodeBuiltinProviderConfigMap,
} from "../src/index.js";

describe("Todo 21 source contracts", () => {
  it("lets the ZCode built-in provider accept only account-family providers", () => {
    const providers = parseZCodeBuiltinProviderConfigMap([
      {
        providerId: "builtin",
        config: {
          group: "zai-family",
          visibility: "visible",
          access: {
            type: "zhipu-account",
            accountType: "zai",
            mode: "individual-coding-plan",
          },
          api: { type: "anthropic-messages", baseUrl: "https://example.com" },
          builtinModelIds: ["model-a"],
        },
      },
    ]);

    expect(providers.get("builtin")?.group).toBe("zai-family");
    expect(() =>
      parseZCodeBuiltinProviderConfigMap([
        {
          providerId: "invalid",
          config: { group: "standard-personal", personalModelIds: ["model-a"] },
        },
      ]),
    ).toThrow();
    expect(() =>
      parseZCodeBuiltinProviderConfigMap([
        { providerId: "invalid", config: { access: { type: "api-key" } } },
      ]),
    ).toThrow();
  });

  it("lets Account Providers project account-constraint fields only", () => {
    const providers = parseAccountProviderConfigMap({
      account: {
        access: { type: "zhipu-account", entitled: true },
        builtinModelIds: ["model-a"],
      },
    });
    expect(providers.get("account")?.access).toMatchObject({
      type: "zhipu-account",
      entitled: true,
    });
    expect(() =>
      parseAccountProviderConfigMap({
        account: {
          access: {
            type: "zhipu-account",
            accountType: "zai",
            mode: "start-plan",
          },
        },
      }),
    ).toThrow();
    expect(() => parseAccountProviderConfigMap({ account: { label: "Account" } })).toThrow();
    expect(() => parseAccountProviderConfigMap({ account: { group: "zai-family" } })).toThrow();
  });

  it("forbids builtinModelIds on Personal Providers and pins the root group to standard-personal", () => {
    const providers = parsePersonalProviderConfigMap({
      providerRules: [
        {
          providerId: "personal",
          config: {
            group: "standard-personal",
            personalModelIds: ["model-a"],
            modelOrder: ["model-a"],
          },
        },
        { providerId: "overlay", providerName: "Overlay", config: {} },
      ],
    });
    expect(providers.get("personal")?.modelOrder).toEqual(["model-a"]);
    expect(() =>
      parsePersonalProviderConfigMap({
        providerRules: [{ providerId: "personal", config: { builtinModelIds: ["model-a"] } }],
      }),
    ).toThrow();
    expect(() =>
      parsePersonalProviderConfigMap({
        providerRules: [{ providerId: "personal", config: { group: "standard-builtin" } }],
      }),
    ).toThrow();
    expect(() =>
      parsePersonalProviderConfigMap({
        providerRules: [
          {
            providerId: "account:zai-start-plan",
            config: { access: { type: "zhipu-account", accountType: "zai", mode: "start-plan" } },
          },
        ],
      }),
    ).toThrow("Pinned-account access");
  });

  it("keeps Personal Providers incomplete without access and never infers it from the group", () => {
    const providers = parsePersonalProviderConfigMap({
      providerRules: [
        { providerId: "personal", config: { group: "standard-personal" } },
        { providerId: "overlay", providerName: "Overlay", config: {} },
      ],
    });

    expect(providers.get("personal")?.access).toBeUndefined();
    expect(providers.get("overlay")?.access).toBeUndefined();
  });

  it("treats the Zhipu product mode as Provider Access", () => {
    const providers = parseZCodeBuiltinProviderConfigMap([
      {
        providerId: "offpeak",
        config: {
          group: "zai-family",
          visibility: "hidden",
          access: {
            type: "zhipu-account",
            accountType: "zai",
            mode: "off-peak",
          },
          api: { type: "anthropic-messages", baseUrl: "https://example.com" },
          builtinModelIds: ["model-a"],
        },
      },
    ]);
    expect(providers.get("offpeak")?.access?.toJSON()).toEqual({
      type: "zhipu-account",
      accountType: "zai",
      mode: "off-peak",
    });
  });

  it("gives models no visibility field", () => {
    expect(() =>
      parsePersonalModelConfigRules([
        {
          type: "provider-model",
          providerId: "provider-a",
          modelId: "model-a",
          config: { visibility: "hidden" },
        },
      ]),
    ).toThrow();
  });
});
