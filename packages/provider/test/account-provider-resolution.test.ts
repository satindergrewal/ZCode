import { describe, expect, it } from "vitest";
import {
  createAccountProviderConfigResolver,
  ApiKeyAccessConfig,
  ProviderConfig,
  ProviderConfigMap,
  ZhipuAccountAccessConfig,
  resolveAccountProviderConfigs,
} from "../src/index.js";
import {
  createAccountProviderConfig,
  createApiKeyProviderConfig,
} from "./provider-config-fixtures.js";

function configuredProviders(): ProviderConfigMap {
  return new ProviderConfigMap([
    [
      "start-plan",
      createAccountProviderConfig({
        apiFormat: "anthropic-messages",
        baseURL: "https://start.example.com",
        models: ["model-a", "model-b"],
        mode: "start-plan",
      }),
    ],
    [
      "coding-plan",
      createAccountProviderConfig({
        apiFormat: "anthropic-messages",
        baseURL: "https://coding.example.com",
        models: ["model-a", "model-c"],
      }),
    ],
    [
      "api-provider",
      createApiKeyProviderConfig({
        apiFormat: "anthropic-messages",
        baseURL: "https://api.example.com",
        apiKey: "secret",
        models: ["api-model"],
      }),
    ],
  ]);
}

describe("resolveAccountProviderConfigs", () => {
  it("keeps connection identity runtime-only and never projects it into Provider Config", async () => {
    const resolve = createAccountProviderConfigResolver(async () => [
      {
        providerId: "start-plan",
        status: "available",
        current: true,
        connectionKey: "opaque-scope",
      },
    ]);
    const result = await resolve({
      configRevision: "config",
      configuredProviders: configuredProviders(),
      previousProviders: new ProviderConfigMap(),
    });
    expect(result.states["start-plan"]?.connectionKey).toBe("opaque-scope");
    expect(JSON.stringify(result.providers.get("start-plan"))).not.toContain("opaque-scope");
  });
  it("stops unknown from borrowing stale entitlements or display facts once the account/team identity changes", async () => {
    const resolve = createAccountProviderConfigResolver(async () => [
      {
        providerId: "start-plan",
        status: "unknown",
        current: true,
        resetPrevious: true,
      },
    ]);
    const result = await resolve({
      configRevision: "config",
      configuredProviders: configuredProviders(),
      previousProviders: new ProviderConfigMap([
        [
          "start-plan",
          new ProviderConfig({
            access: new ZhipuAccountAccessConfig({ entitled: true }),
            builtinModelIds: ["old"],
          }),
        ],
      ]),
      previousStates: { "start-plan": { availability: "available", entitled: true } },
    });
    expect(result.providers.get("start-plan")?.access?.entitled).toBe(false);
    expect(result.states["start-plan"]).toEqual({
      availability: "unknown",
      entitled: false,
      current: true,
    });
  });
  it("returns state and Overlay in one round; unknown keeps entitlements but never restores the old current", async () => {
    const resolve = createAccountProviderConfigResolver(async () => [
      {
        providerId: "start-plan",
        status: "pending",
        current: false,
        models: [],
        effectiveAt: 2000,
      },
      { providerId: "coding-plan", status: "unknown", current: false },
    ]);
    const result = await resolve({
      configRevision: "config",
      configuredProviders: configuredProviders(),
      previousProviders: new ProviderConfigMap([
        [
          "coding-plan",
          new ProviderConfig({ access: new ZhipuAccountAccessConfig({ entitled: true }) }),
        ],
      ]),
      previousStates: {
        "coding-plan": { availability: "available", entitled: true, current: true },
      },
    });
    expect(result.states).toEqual({
      "start-plan": { availability: "pending", current: false, entitled: false, effectiveAt: 2000 },
      "coding-plan": { availability: "available", current: false, entitled: true },
    });
  });
  it("keeps entitlements and clears the old allowlist when effective but empty; pending borrows nothing", () => {
    const previousProviders = new ProviderConfigMap([
      [
        "start-plan",
        new ProviderConfig({
          access: new ZhipuAccountAccessConfig({ entitled: true }),
          builtinModelIds: ["old-model"],
        }),
      ],
    ]);
    const resolve = (status: "available" | "pending") =>
      resolveAccountProviderConfigs({
        configuredProviders: configuredProviders(),
        previousProviders,
        connections: [{ providerId: "start-plan", status, models: [], effectiveAt: 2000 }],
      })
        .get("start-plan")
        ?.toJSON();
    expect(resolve("available")).toEqual({
      access: { type: "zhipu-account", entitled: true },
      builtinModelIds: [],
    });
    expect(resolve("pending")).toEqual({
      access: { type: "zhipu-account", entitled: false },
      builtinModelIds: [],
    });
  });
  it("wires the Connection Resolver into the AccountProviderService config resolver", async () => {
    expect(configuredProviders().get("coding-plan")?.builtinModelIds).toEqual([
      "model-a",
      "model-c",
    ]);
    const resolve = createAccountProviderConfigResolver(async () => [
      {
        providerId: "coding-plan",
        status: "available",
      },
      { providerId: "start-plan", status: "unavailable" },
    ]);

    const result = await resolve({
      configRevision: "config-1",
      configuredProviders: configuredProviders(),
      previousProviders: ProviderConfigMap.empty(),
    });

    expect(
      Object.fromEntries(result.providers.entries().map(([id, config]) => [id, config.toJSON()])),
    ).toEqual({
      "coding-plan": {
        access: { type: "zhipu-account", entitled: true },
      },
      "start-plan": { access: { type: "zhipu-account", entitled: false } },
    });
  });

  it("emits only an entitlement/models Overlay for available connections, keeping the Config model order", () => {
    const result = resolveAccountProviderConfigs({
      configuredProviders: configuredProviders(),
      previousProviders: ProviderConfigMap.empty(),
      connections: [
        {
          providerId: "start-plan",
          status: "available",
          models: ["model-b"],
        },
        {
          providerId: "coding-plan",
          status: "available",
        },
      ],
    });

    expect(
      Object.fromEntries(result.entries().map(([id, config]) => [id, config.toJSON()])),
    ).toEqual({
      "start-plan": {
        access: { type: "zhipu-account", entitled: true },
        builtinModelIds: ["model-b"],
      },
      "coding-plan": {
        access: { type: "zhipu-account", entitled: true },
      },
    });
  });

  it("sets only the Account Access entitlement for available and never copies provider static facts", () => {
    const result = resolveAccountProviderConfigs({
      configuredProviders: new ProviderConfigMap([
        [
          "coding-plan",
          createAccountProviderConfig({
            models: ["model-a"],
          }),
        ],
      ]),
      previousProviders: ProviderConfigMap.empty(),
      connections: [
        {
          providerId: "coding-plan",
          status: "available",
        },
      ],
    });

    expect(
      Object.fromEntries(result.entries().map(([id, config]) => [id, config.toJSON()])),
    ).toEqual({
      "coding-plan": {
        access: { type: "zhipu-account", entitled: true },
      },
    });
  });

  it("keeps the last good result for unknown and explicitly revokes entitlements for unavailable", () => {
    const previousProviders = new ProviderConfigMap([
      [
        "start-plan",
        new ProviderConfig({
          access: new ZhipuAccountAccessConfig({ entitled: true }),
          builtinModelIds: ["model-a"],
        }),
      ],
      [
        "coding-plan",
        new ProviderConfig({ access: new ZhipuAccountAccessConfig({ entitled: true }) }),
      ],
    ]);

    const result = resolveAccountProviderConfigs({
      configuredProviders: configuredProviders(),
      previousProviders,
      connections: [
        { providerId: "start-plan", status: "unknown" },
        { providerId: "coding-plan", status: "unavailable" },
      ],
    });

    expect(
      Object.fromEntries(result.entries().map(([id, config]) => [id, config.toJSON()])),
    ).toEqual({
      "start-plan": {
        access: { type: "zhipu-account", entitled: true },
        builtinModelIds: ["model-a"],
      },
      "coding-plan": { access: { type: "zhipu-account", entitled: false } },
    });
  });

  it("fails closed with entitled=false on first unknown", () => {
    expect(
      Object.fromEntries(
        resolveAccountProviderConfigs({
          configuredProviders: configuredProviders(),
          previousProviders: ProviderConfigMap.empty(),
          connections: [],
        })
          .entries()
          .map(([id, config]) => [id, config.toJSON()]),
      ),
    ).toEqual({
      "start-plan": { access: { type: "zhipu-account", entitled: false } },
      "coding-plan": { access: { type: "zhipu-account", entitled: false } },
    });
  });

  it("applies Start Plan's explicit empty allowlist to both first resolve and refresh, never restoring old models", () => {
    const connection = {
      providerId: "start-plan",
      status: "available" as const,
      models: [],
    };
    const previous = new ProviderConfigMap([
      [
        "start-plan",
        new ProviderConfig({
          access: new ZhipuAccountAccessConfig({ entitled: true }),
          builtinModelIds: ["model-a"],
        }),
      ],
    ]);

    expect(
      resolveAccountProviderConfigs({
        configuredProviders: configuredProviders(),
        previousProviders: previous,
        connections: [connection, { providerId: "coding-plan", status: "unavailable" }],
      })
        .get("start-plan")
        ?.toJSON(),
    ).toEqual({ access: { type: "zhipu-account", entitled: true }, builtinModelIds: [] });
    expect(
      Object.fromEntries(
        resolveAccountProviderConfigs({
          configuredProviders: configuredProviders(),
          previousProviders: ProviderConfigMap.empty(),
          connections: [connection, { providerId: "coding-plan", status: "unavailable" }],
        })
          .entries()
          .map(([id, config]) => [id, config.toJSON()]),
      ),
    ).toEqual({
      "start-plan": { access: { type: "zhipu-account", entitled: true }, builtinModelIds: [] },
      "coding-plan": { access: { type: "zhipu-account", entitled: false } },
    });
  });

  it("rejects connection results referencing unconfigured or non-account providers", () => {
    expect(() =>
      resolveAccountProviderConfigs({
        configuredProviders: configuredProviders(),
        previousProviders: ProviderConfigMap.empty(),
        connections: [
          {
            providerId: "api-provider",
            status: "available",
          },
        ],
      }),
    ).toThrow("Account connection references a non-account provider: api-provider");
  });

  it("excludes plain api-key providers from the Account Overlay", () => {
    const configured = new ProviderConfigMap([
      [
        "generic-api",
        new ProviderConfig({
          access: new ApiKeyAccessConfig({ apiKey: "secret" }),
        }),
      ],
    ]);

    expect(
      Object.fromEntries(
        resolveAccountProviderConfigs({
          configuredProviders: configured,
          previousProviders: ProviderConfigMap.empty(),
          connections: [],
        })
          .entries()
          .map(([id, config]) => [id, config.toJSON()]),
      ),
    ).toEqual({});
    expect(() =>
      resolveAccountProviderConfigs({
        configuredProviders: configured,
        previousProviders: ProviderConfigMap.empty(),
        connections: [{ providerId: "generic-api", status: "available" }],
      }),
    ).toThrow("Account connection references a non-account provider: generic-api");
  });
});
