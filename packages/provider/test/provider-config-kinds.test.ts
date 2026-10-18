import { describe, expect, it } from "vitest";
import {
  ApiKeyAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  parsePersonalProviderConfigMap,
  ZhipuAccountAccessConfig,
  parseProviderConfig,
  parseProviderConfigMap,
} from "../src/index.js";

describe("ProviderConfig access / api boundaries", () => {
  it("resolves access entitlement and API protocol into two independent Config Overlays", () => {
    const config = parseProviderConfig({
      access: { type: "api-key", apiKey: "secret" },
      api: {
        type: "anthropic-messages",
        baseUrl: "https://api.example.com",
      },
      builtinModelIds: ["model-a"],
    });

    expect(config.access).toBeInstanceOf(ApiKeyAccessConfig);
    expect(config.api).toBeInstanceOf(ProviderApiConfig);
    expect(config.toJSON()).toEqual({
      access: { type: "api-key", apiKey: "secret" },
      api: {
        type: "anthropic-messages",
        baseUrl: "https://api.example.com",
      },
      builtinModelIds: ["model-a"],
    });
  });

  it("overlays provider, Access and API fields recursively", () => {
    const zcodeBuiltin = new ProviderConfig({
      group: "standard-personal",
      logo: { type: "builtin", key: "deepseek" },
      access: new ApiKeyAccessConfig({
        apiKeyManagementUrl: "https://platform.deepseek.com/api_keys",
      }),
      api: new ProviderApiConfig({
        type: "anthropic-messages",
        baseUrl: "https://api.deepseek.com/anthropic",
      }),
      builtinModelIds: ["deepseek-v4"],
    });
    const personal = new ProviderConfig({
      access: new ApiKeyAccessConfig({ apiKey: "sk-personal" }),
      api: new ProviderApiConfig({ headers: { "X-Team": "agent" } }),
    });

    const effective = zcodeBuiltin.overlay(personal);

    // Name behavior is covered by the rule-outer overlay tests; here only execution config is asserted.
    expect(effective.logo).toEqual({ type: "builtin", key: "deepseek" });

    expect(zcodeBuiltin.overlay(new ProviderConfig({ logo: null })).logo).toBeNull();
    expect(effective.access).toMatchObject({
      type: "api-key",
      apiKey: "sk-personal",
      apiKeyManagementUrl: "https://platform.deepseek.com/api_keys",
    });
    expect(effective.api).toMatchObject({
      type: "anthropic-messages",
      baseUrl: "https://api.deepseek.com/anthropic",
      headers: { "X-Team": "agent" },
    });
    expect(effective.validateComplete()).toEqual([]);
  });

  it("accepts open Built-in logo keys and rejects unknown logo types", () => {
    expect(
      parseProviderConfig({ logo: { type: "builtin", key: "future-provider-logo" } }).toJSON(),
    ).toEqual({ logo: { type: "builtin", key: "future-provider-logo" } });
    expect(() =>
      parseProviderConfig({ logo: { type: "url", url: "https://example.com/logo.svg" } }),
    ).toThrow();
  });

  it("gives Zhipu account Access its own schema with no API key", () => {
    const providers = parseProviderConfigMap([
      {
        providerId: "plan",
        providerName: "Coding Plan",
        config: {
          access: {
            type: "zhipu-account",
          },
          api: {
            type: "anthropic-messages",
            baseUrl: "https://plan.example.com/anthropic",
            headers: { "X-Static": "zcodeBuiltin" },
          },
          builtinModelIds: ["glm-5"],
        },
      },
    ]);

    expect(providers.get("plan")?.access).toBeInstanceOf(ZhipuAccountAccessConfig);
    expect(() =>
      parseProviderConfigMap([
        {
          providerId: "plan",
          config: {
            access: {
              type: "zhipu-account",
              apiKey: "must-not-be-here",
            },
          },
        },
      ]),
    ).toThrow();
  });

  it("lets no Provider Config toggle usage off at the execution layer", () => {
    expect(() =>
      parseProviderConfig({
        access: { type: "api-key", apiKey: "test-key" },
        includeUsage: false,
      }),
    ).toThrow();
  });

  it("resolves hiddenness and the Zhipu off-peak mode into the official Provider config", () => {
    const config = parseProviderConfig({
      group: "zai-family",
      visibility: "hidden",
      access: { type: "zhipu-account", accountType: "zai", mode: "off-peak", entitled: true },
      api: {
        type: "anthropic-messages",
        baseUrl: "https://zcode.z.ai/api/v1/off-peak/anthropic",
      },
      builtinModelIds: ["GLM-5.2"],
    });

    expect(config.visibility).toBe("hidden");
    expect(config.access).toBeInstanceOf(ZhipuAccountAccessConfig);
    expect(config.validateComplete()).toEqual([]);
    expect(JSON.parse(JSON.stringify(config))).toEqual({
      group: "zai-family",
      visibility: "hidden",
      access: { type: "zhipu-account", accountType: "zai", mode: "off-peak", entitled: true },
      api: {
        type: "anthropic-messages",
        baseUrl: "https://zcode.z.ai/api/v1/off-peak/anthropic",
      },
      builtinModelIds: ["GLM-5.2"],
    });
  });

  it("keeps hidden from relaxing provider completeness and drops the legacy executionOnly shape", () => {
    const hidden = new ProviderConfig({
      group: "zai-family",
      visibility: "hidden",
      access: new ZhipuAccountAccessConfig({ accountType: "zai", mode: "off-peak" }),
      api: new ProviderApiConfig({ type: "anthropic-messages" }),
      builtinModelIds: ["GLM-5.2"],
    });

    expect(hidden.validateComplete(["providers", "account:zai-offpeak-idle-plan"])).toContainEqual({
      code: "required-field-missing",
      path: ["providers", "account:zai-offpeak-idle-plan", "api", "baseUrl"],
      message: "Missing required config providers.account:zai-offpeak-idle-plan.api.baseUrl",
    });
    expect(() =>
      parseProviderConfig({
        executionOnly: true,
        api: { type: "anthropic-messages" },
        models: ["GLM-5.2"],
      }),
    ).toThrow();
  });

  it("follows Provider Overlay order for visibility and defaults to visible", () => {
    const builtIn = new ProviderConfig({ visibility: "hidden" });

    expect(new ProviderConfig().visibility).toBeUndefined();
    expect(builtIn.overlay(new ProviderConfig()).visibility).toBe("hidden");
    expect(builtIn.overlay(new ProviderConfig({ visibility: "visible" })).visibility).toBe(
      "visible",
    );
  });

  it("lets the Account layer append account constraints and model membership last", () => {
    const zcodeBuiltin = new ProviderConfig({
      group: "zai-family",
      access: new ZhipuAccountAccessConfig({
        accountType: "zai",
        mode: "individual-coding-plan",
      }),
      api: new ProviderApiConfig({
        type: "anthropic-messages",
        baseUrl: "https://plan.example.com/anthropic",
      }),
    });
    const account = new ProviderConfig({
      access: new ZhipuAccountAccessConfig({
        entitled: true,
      }),
      builtinModelIds: ["glm-5"],
    });

    expect(zcodeBuiltin.validateComplete(["providers", "plan"])).toContainEqual({
      code: "required-field-missing",
      path: ["providers", "plan", "access", "entitled"],
      message: "Missing required config providers.plan.access.entitled",
    });
    expect(zcodeBuiltin.overlay(account).validateComplete()).toEqual([]);
  });

  it("requires API-key Access to hold a key after the final Overlay", () => {
    const incomplete = new ProviderConfig({
      group: "standard-personal",
      access: new ApiKeyAccessConfig(),
      api: new ProviderApiConfig({
        type: "openai-chat-completions",
        baseUrl: "https://api.example.com/v1",
      }),
      builtinModelIds: ["model-a"],
    });

    expect(incomplete.validateComplete(["providers", "api"])).toContainEqual({
      code: "required-field-missing",
      path: ["providers", "api", "access", "apiKey"],
      message: "Missing required config providers.api.access.apiKey",
    });
  });

  it("lets Personal Providers stage invalid endpoints and fail closed at completeness checks", () => {
    const providers = parsePersonalProviderConfigMap({
      providerRules: [
        {
          providerId: "broken",
          config: {
            group: "standard-personal",
            access: { type: "api-key", apiKey: "test-key" },
            api: { type: "openai-chat-completions", baseUrl: "testtest" },
            personalModelIds: ["model-a"],
          },
        },
      ],
    });

    expect(providers.get("broken")?.api?.baseUrl).toBe("testtest");
    expect(providers.get("broken")?.validateComplete(["providers", "broken"])).toContainEqual({
      code: "invalid-url",
      path: ["providers", "broken", "api", "baseUrl"],
      message: "Config providers.broken.api.baseUrl must be a valid URL",
    });
  });

  it("switches the whole access kind when a later layer changes the Access type explicitly", () => {
    const zcodeBuiltin = new ProviderConfigMap([
      [
        "provider",
        new ProviderConfig({
          access: new ApiKeyAccessConfig({ apiKey: "old-key" }),
          builtinModelIds: ["model-a"],
        }),
      ],
    ]);
    const account = new ProviderConfigMap([
      [
        "provider",
        new ProviderConfig({
          access: new ZhipuAccountAccessConfig({
            accountType: "zai",
            mode: "individual-coding-plan",
          }),
        }),
      ],
    ]);

    expect(zcodeBuiltin.overlay(account).get("provider")?.access).toMatchObject({
      type: "zhipu-account",
    });
  });

  it("stores only static family and mode on Team Account Access", () => {
    const access = new ZhipuAccountAccessConfig({
      accountType: "bigmodel",
      mode: "team-coding-plan",
      entitled: true,
    });

    expect(access.validateComplete(["access"])).toEqual([]);
    expect(access.toJSON()).toEqual({
      type: "zhipu-account",
      accountType: "bigmodel",
      mode: "team-coding-plan",
      entitled: true,
    });
  });

  it("rejectes execution-provided and fake-generic protocol fields in the official Access schema", () => {
    expect(() => parseProviderConfig({ access: { type: "execution-provided" } })).toThrow();
    for (const field of ["planKind", "challenge", "requestSigning", "executionProtocol"]) {
      expect(() =>
        parseProviderConfig({
          access: {
            type: "zhipu-account",
            accountType: "zai",
            mode: "start-plan",
            [field]: "legacy",
          },
        }),
      ).toThrow();
    }
    expect(() =>
      parseProviderConfig({
        access: { type: "api-key", apiKey: "secret", requestSigning: "zcode-v4" },
      }),
    ).toThrow();
  });
});
