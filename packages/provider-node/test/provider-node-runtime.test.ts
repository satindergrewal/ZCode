import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileModelOptionMap } from "@zcode/model-option-map";
import {
  ApiKeyAccessConfig,
  ModelConfigRules,
  ProviderConfig,
  ProviderConfigMap,
  type ProviderConfigLayerUpdate,
} from "@zcode/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NodeZCodeBuiltinProviderConfigSource,
  NodePersonalProviderConfigRepository,
  NodeProviderConfigRuntime,
  NodeProviderRegistryRuntime,
  createNodeProviderRuntimePathEnv,
  materializeZCodeBuiltinProviderConfig,
  encodeProviderConfigFile,
  resolveZCodeBuiltinCachePaths,
  resolveNodeProviderRuntimePaths,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "../src/index.js";

const temporaryDirectories: string[] = [];
const zcodeBuiltinProviderConfigFilePath = fileURLToPath(
  new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      // Windows closes runtime handles asynchronously and an immediate rm hits EBUSY; retry to absorb handle-release lag
      .map((directory) =>
        rm(directory, { force: true, recursive: true, maxRetries: 10, retryDelay: 200 }),
      ),
  );
});

describe("@zcode/provider-node", () => {
  it("resolves ox-alpha same-policy aliases and API-specific reasoning from Built-in Model Config Rules", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: zcodeBuiltinProviderConfigFilePath,
      watch: false,
    });
    const snapshot = await source.read();

    for (const modelId of [
      "ox-alpha",
      "OPENROUTER/OX-ALPHA",
      "GLM-x-preview-f",
      "x-preview-f-free",
    ]) {
      const anthropic = snapshot.models.resolve({
        providerId: "custom",
        modelId,
        apiType: "anthropic-messages",
      });
      expect(anthropic.optionSpecs?.reasoningLevel).toMatchObject({
        values: ["low", "high", "max"],
      });
      expect(anthropic.optionSpecs?.reasoningLevel?.map).toContain("reasoningLevel");
      expect(
        compileModelOptionMap(
          anthropic.optionSpecs!.reasoningLevel!.map!,
          "reasoningLevel",
        ).evaluate("max"),
      ).toEqual({ thinking: { type: "adaptive" }, output_config: { effort: "max" } });

      const openAiCompatible = snapshot.models.resolve({
        providerId: "custom",
        modelId,
        apiType: "openai-chat-completions",
      });
      expect(
        compileModelOptionMap(
          openAiCompatible.optionSpecs!.reasoningLevel!.map!,
          "reasoningLevel",
        ).evaluate("high"),
      ).toEqual({ reasoning_effort: "high" });

      const responses = snapshot.models.resolve({
        providerId: "custom",
        modelId,
        apiType: "openai-responses",
      });
      // Todo138 reduced the generic fallback to two tiers; Responses has no ox-specific range and must inherit that result.
      expect(responses.optionSpecs?.reasoningLevel?.toJSON()).toMatchObject({
        values: ["disabled", "enabled"],
      });
      expect(
        compileModelOptionMap(
          responses.optionSpecs!.reasoningLevel!.map!,
          "reasoningLevel",
        ).evaluate("disabled"),
      ).toEqual({ reasoning: { effort: "none" } });
      expect(
        compileModelOptionMap(
          responses.optionSpecs!.reasoningLevel!.map!,
          "reasoningLevel",
        ).evaluate("enabled"),
      ).toEqual({ reasoning: { effort: "high" } });
    }
    source.dispose();
  });

  it("resolves model capabilities, Access protocol and Tool Schema compatibility from the Built-in Config", async () => {
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: zcodeBuiltinProviderConfigFilePath,
      watch: false,
    });
    const snapshot = await source.read();

    expect(
      snapshot.models.resolve({
        providerId: "personal-zai-api",
        templateId: "zai-api",
        modelId: "glm-5.3",
        apiType: "anthropic-messages",
        baseUrl: "https://api.z.ai/api/anthropic",
      }).properties,
    ).toMatchObject({
      supportsMidConversationSystem: true,
      supportsNativeWebSearch: true,
    });
    expect(
      snapshot.models.resolve({
        providerId: "moonshot-kimi",
        modelId: "kimi-k3",
        apiType: "anthropic-messages",
        baseUrl: "https://api.moonshot.cn/anthropic",
      }),
    ).toMatchObject({ properties: { requiresMfjsToolSchema: true } });
    expect(
      snapshot.models.resolve({
        providerId: "moonshot-kimi",
        modelId: "kimi-k2.6",
        apiType: "anthropic-messages",
      }),
    ).toMatchObject({ properties: { requiresMfjsToolSchema: false } });
    expect(
      snapshot.models.resolve({
        providerId: "personal",
        modelId: "claude-opus-4-8",
        apiType: "anthropic-messages",
      }).properties,
    ).toMatchObject({
      supportsMidConversationSystem: true,
      supportsNativeWebSearch: false,
    });
    expect(snapshot.providers.get("account:zai-start-plan")?.access).toMatchObject({
      type: "zhipu-account",
      accountType: "zai",
      mode: "start-plan",
    });
    expect(snapshot.providers.get("account:zai-offpeak-idle-plan")?.access).toMatchObject({
      type: "zhipu-account",
      accountType: "zai",
      mode: "off-peak",
    });
    expect(snapshot.providerTemplates?.get("deepseek")?.config.access).toMatchObject({
      type: "api-key",
    });
    source.dispose();
  });

  it("reuses identical content at the bundled-config path and atomically overwrites on upgrade without history copies", async () => {
    const root = await temporaryDirectory();
    const firstContent = JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      config: {
        providerConfigRules: { providerRules: [], templateRules: [] },
        modelConfigRules: {
          modelRules: [],
          modelApiRules: [],
          providerSiteRules: [],
          templateModelRules: [],
          builtinProviderModelRules: [],
        },
      },
    });
    const secondContent = JSON.stringify({
      schemaVersion: 1,
      revision: 2,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "zcodeBuiltin",
              config: {
                group: "zai-family",
                access: {
                  type: "zhipu-account",
                  accountType: "zai",
                  mode: "start-plan",
                },
                builtinModelIds: [],
              },
            },
          ],
          templateRules: [],
        },
        modelConfigRules: {
          modelRules: [],
          modelApiRules: [],
          providerSiteRules: [],
          templateModelRules: [],
          builtinProviderModelRules: [],
        },
      },
    });

    const firstPath = await materializeZCodeBuiltinProviderConfig({
      environmentConfigRoot: root,
      content: firstContent,
    });
    const repeatedPath = await materializeZCodeBuiltinProviderConfig({
      environmentConfigRoot: root,
      content: firstContent,
    });
    const secondPath = await materializeZCodeBuiltinProviderConfig({
      environmentConfigRoot: root,
      content: secondContent,
    });

    expect(repeatedPath).toBe(firstPath);
    expect(firstPath).toBe(join(root, "runtime", "provider", "bundled", "zcode-builtin.json"));
    expect(secondPath).toBe(firstPath);
    expect(JSON.parse(await readFile(secondPath, "utf8"))).toEqual(JSON.parse(secondContent));
    expect(await readdir(join(root, "runtime", "provider", "bundled"))).toEqual([
      "zcode-builtin.json",
    ]);
  });

  it("enables the process Registry only when both ZCode Built-in and Personal paths exist", () => {
    expect(resolveNodeProviderRuntimePaths({})).toBeNull();
    expect(() =>
      resolveNodeProviderRuntimePaths({
        [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: "/zcodeBuiltin.json",
      }),
    ).toThrow("must be provided together");
    expect(
      resolveNodeProviderRuntimePaths({
        [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: " /zcodeBuiltin.json ",
        [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: " /personal.json ",
      }),
    ).toEqual({
      zcodeBuiltinFilePath: "/zcodeBuiltin.json",
      personalFilePath: "/personal.json",
    });
    expect(
      createNodeProviderRuntimePathEnv({
        zcodeBuiltinFilePath: "/zcodeBuiltin.json",
        personalFilePath: "/personal.json",
      }),
    ).toEqual({
      [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: "/zcodeBuiltin.json",
      [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: "/personal.json",
    });
  });

  it("reads the current versioned file on every ZCode Built-in Source read with content-driven revisions", async () => {
    const root = await temporaryDirectory();
    const filePath = join(root, "zcodeBuiltin.json");
    await writeZCodeBuiltin(filePath, "model-a");
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath: filePath,
      watch: false,
    });

    const first = await source.read();
    await writeZCodeBuiltin(filePath, "model-b");
    const second = await source.read();

    expect(first.providers.get("zcodeBuiltin")?.builtinModelIds).toEqual(["model-a"]);
    expect(second.providers.get("zcodeBuiltin")?.builtinModelIds).toEqual(["model-b"]);
    expect(second.revision).not.toBe(first.revision);
    source.dispose();
  });

  it("notifies once per new content revision on the ZCode Built-in Source", async () => {
    const root = await temporaryDirectory();
    const filePath = join(root, "zcodeBuiltin.json");
    await writeZCodeBuiltin(filePath, "model-a");
    const source = new NodeZCodeBuiltinProviderConfigSource({ bundledFilePath: filePath });
    const reasons: string[] = [];
    source.onDidChange((reason) => reasons.push(reason));
    await source.read();

    await writeZCodeBuiltin(filePath, "model-a");
    await settleFileWatcher();
    expect(reasons).toEqual([]);

    await writeZCodeBuiltin(filePath, "model-b");
    await vi.waitFor(() => expect(reasons).toContain("file-changed"));
    await settleFileWatcher();

    expect(reasons).toEqual(["file-changed"]);
    expect((await source.read()).providers.get("zcodeBuiltin")?.builtinModelIds).toEqual([
      "model-b",
    ]);
    source.dispose();
  });

  it("runs read-modify-write inside a cross-call file lock in the Personal Repository", async () => {
    const root = await temporaryDirectory();
    const filePath = join(root, "provider-config.json");
    await writeFile(filePath, JSON.stringify(storedConfig(emptyUpdate())), "utf8");
    const first = new NodePersonalProviderConfigRepository({ filePath, watch: false });
    const second = new NodePersonalProviderConfigRepository({ filePath, watch: false });

    await Promise.all([
      first.update((current) => ({
        providers: current.providers.set("A", personalProviderConfig(false)),
        models: current.models,
      })),
      second.update((current) => ({
        providers: current.providers.set("B", personalProviderConfig(false)),
        models: current.models,
      })),
    ]);

    expect((await first.read()).providers.keys().toSorted()).toEqual(["A", "B"]);
    first.dispose();
    second.dispose();
  });

  it("never double-notifies explicit Personal Repository updates from the poller", async () => {
    const root = await temporaryDirectory();
    const filePath = join(root, "provider-config.json");
    await writeFile(filePath, JSON.stringify(storedConfig(emptyUpdate())), "utf8");
    const repository = new NodePersonalProviderConfigRepository({
      filePath,
      pollingIntervalMs: 10,
    });
    const reasons: string[] = [];
    repository.onDidChange((reason) => reasons.push(reason));
    await repository.read();

    await repository.update((current) => ({
      providers: current.providers.set("personal", personalProviderConfig(false)),
      models: current.models,
    }));
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(reasons).toEqual(["updated"]);
    repository.dispose();
  });

  it("still notices new revisions from proper atomic writes with no file events in the Personal Repository", async () => {
    const root = await temporaryDirectory();
    const filePath = join(root, "provider-config.json");
    await writeFile(filePath, JSON.stringify(storedConfig(emptyUpdate())), "utf8");
    const writer = new NodePersonalProviderConfigRepository({
      filePath,
      pollingIntervalMs: false,
    });
    const repository = new NodePersonalProviderConfigRepository({
      filePath,
      pollingIntervalMs: 10,
    });
    const reasons: string[] = [];
    repository.onDidChange((reason) => reasons.push(reason));
    await repository.read();

    await writer.update(() => ({
      providers: new ProviderConfigMap([["external", personalProviderConfig(false)]]),
      models: ModelConfigRules.empty(),
    }));
    await vi.waitFor(() => expect(reasons).toContain("poll-changed"));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(reasons).toEqual(["poll-changed"]);
    expect((await repository.read()).providers.keys()).toEqual(["external"]);
    writer.dispose();
    repository.dispose();
  });

  it("keeps retrying and recovers after transient Personal Repository poll failures", async () => {
    const root = await temporaryDirectory();
    const filePath = join(root, "provider-config.json");
    // Windows EPERMs symlinks without developer mode; making the config path a plain directory triggers the same
    // read failure (readFile on a dir throws) while staying cross-platform; recovery removes the dir before writing
    await mkdir(filePath);
    const pollingErrors: unknown[] = [];
    const reasons: string[] = [];
    const repository = new NodePersonalProviderConfigRepository({
      filePath,
      onPollingError: (error) => pollingErrors.push(error),
      pollingIntervalMs: 10,
    });
    repository.onDidChange((reason) => reasons.push(reason));
    await repository.read();

    await vi.waitFor(() => expect(pollingErrors).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(pollingErrors).toHaveLength(1);

    await rm(filePath, { force: true, recursive: true });
    await writeFile(
      filePath,
      JSON.stringify(
        storedConfig({
          providers: new ProviderConfigMap([["recovered", personalProviderConfig(false)]]),
          models: ModelConfigRules.empty(),
        }),
      ),
      "utf8",
    );
    await vi.waitFor(() => expect(reasons).toContain("poll-changed"));
    expect((await repository.read()).providers.keys()).toEqual(["recovered"]);
    repository.dispose();
  });

  it("never re-runs the legacy importer or rewrites migration files from Personal Repository polls", async () => {
    const root = await temporaryDirectory();
    const filePath = join(root, "provider-config.json");
    const importLegacy = vi.fn(async () => null);
    const repository = new NodePersonalProviderConfigRepository({
      filePath,
      importLegacy,
      pollingIntervalMs: 10,
    });

    await repository.read();
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(importLegacy).toHaveBeenCalledOnce();
    repository.dispose();
  });

  it("calls the external Legacy Importer on missing new targets and leaves no backups", async () => {
    const root = await temporaryDirectory();
    const zcodeBuiltinFilePath = join(root, "zcodeBuiltin.json");
    const personalFilePath = join(root, "provider_config.json");
    await writeZCodeBuiltin(zcodeBuiltinFilePath, "zcodeBuiltin-model");
    const importLegacy = vi.fn(async () => {
      return Object.freeze({
        providers: new ProviderConfigMap([["legacy", personalProviderConfig(false)]]),
        models: ModelConfigRules.empty(),
      });
    });
    const runtime = new NodeProviderConfigRuntime({
      zcodeBuiltinFilePath,
      personalFilePath,
      importLegacy,
      watch: false,
    });

    expect(await runtime.start()).toBeUndefined();
    const snapshot = await runtime.configService.read();

    expect(importLegacy).toHaveBeenCalledOnce();
    expect(snapshot.personalProviders.keys()).toEqual(["legacy"]);
    expect(JSON.parse(await readFile(personalFilePath, "utf8"))).toMatchObject({
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [{ providerId: "legacy", config: { group: "standard-personal" } }],
        },
      },
    });
    expect((await readdir(root)).some((name) => name.endsWith(".bak"))).toBe(false);
    runtime.dispose();

    const repeatedImport = vi.fn(async () => {
      throw new Error("must not re-import the legacy provider store once a Personal config exists");
    });
    const restartedRuntime = new NodeProviderConfigRuntime({
      zcodeBuiltinFilePath,
      personalFilePath,
      importLegacy: repeatedImport,
      watch: false,
    });

    expect(await restartedRuntime.start()).toBeUndefined();
    const restartedSnapshot = await restartedRuntime.configService.read();

    expect(repeatedImport).not.toHaveBeenCalled();
    expect(restartedSnapshot.personalProviders.keys()).toEqual(["legacy"]);
    restartedRuntime.dispose();
  });

  it("imports exactly once under the target file lock when processes race the first read", async () => {
    const root = await temporaryDirectory();
    const personalFilePath = join(root, "provider_config.json");
    const importLegacy = vi.fn(async () =>
      Object.freeze({
        providers: new ProviderConfigMap([["legacy", personalProviderConfig(false)]]),
        models: ModelConfigRules.empty(),
      }),
    );
    const first = new NodePersonalProviderConfigRepository({
      filePath: personalFilePath,
      importLegacy,
      pollingIntervalMs: false,
    });
    const second = new NodePersonalProviderConfigRepository({
      filePath: personalFilePath,
      importLegacy,
      pollingIntervalMs: false,
    });

    const snapshots = await Promise.all([first.read(), second.read()]);

    expect(importLegacy).toHaveBeenCalledOnce();
    expect(snapshots.map((snapshot) => snapshot.providers.keys())).toEqual([
      ["legacy"],
      ["legacy"],
    ]);
    first.dispose();
    second.dispose();
  });

  it("exposes only the current endpoint's Active path to the agent in endpoint-scoped Config Runtime", async () => {
    const root = await temporaryDirectory();
    const zcodeBuiltinFilePath = join(root, "zcodeBuiltin.json");
    const environmentConfigRoot = join(root, "environment");
    const personalFilePath = join(root, "config.json");
    const endpointOrigin = "https://api.example.com";
    await writeZCodeBuiltin(zcodeBuiltinFilePath, "zcodeBuiltin-model");
    const runtime = new NodeProviderConfigRuntime({
      zcodeBuiltinFilePath,
      personalFilePath,
      zcodeBuiltinEnvironment: {
        environmentConfigRoot,
        platform: "darwin-aarch64",
        appVersion: "3.9.2",
        resolveEndpointOrigin: () => endpointOrigin,
        fetchRelease: async () => null,
        watch: false,
      },
      watch: false,
    });

    await runtime.start();

    await expect(runtime.resolveZCodeBuiltinActiveFilePath()).resolves.toBe(
      resolveZCodeBuiltinCachePaths({
        environmentConfigRoot,
        platform: "darwin-aarch64",
        appVersion: "3.9.2",
        zcodeEndpointOrigin: endpointOrigin,
      }).activeFilePath,
    );
    // start never awaits the background download; before removing the temp dir, wait out the first control-file lease, never racing rm.
    await runtime.refreshZCodeBuiltin();
    runtime.dispose();
  });

  it("keeps the original file on corrupt official Personal configs without mis-firing the Legacy Importer", async () => {
    const root = await temporaryDirectory();
    const zcodeBuiltinFilePath = join(root, "zcodeBuiltin.json");
    const personalFilePath = join(root, "provider_config.json");
    const invalidText = JSON.stringify({ provider: { unsupported: {} } }, null, 2);
    await writeZCodeBuiltin(zcodeBuiltinFilePath, "zcodeBuiltin-model");
    await writeFile(personalFilePath, invalidText, "utf8");
    const importLegacy = vi.fn(async () => emptyUpdate());
    const runtime = new NodeProviderConfigRuntime({
      zcodeBuiltinFilePath,
      personalFilePath,
      importLegacy,
      watch: false,
    });

    await expect(runtime.start()).resolves.toBeUndefined();
    await expect(runtime.start()).resolves.toBeUndefined();
    expect((await runtime.configService.read()).personalProviders.keys()).toEqual([]);
    expect(importLegacy).not.toHaveBeenCalled();
    expect(await readFile(personalFilePath, "utf8")).toBe(invalidText);
    expect((await readdir(root)).some((name) => name.endsWith(".bak"))).toBe(false);
    runtime.dispose();
  });

  it("aggregates config per process in the Node Registry Runtime and publishes complete API providers only", async () => {
    const root = await temporaryDirectory();
    const zcodeBuiltinFilePath = join(root, "zcodeBuiltin.json");
    const personalFilePath = join(root, "personal.json");
    await writeCompleteZCodeBuiltin(zcodeBuiltinFilePath);
    await writeFile(
      personalFilePath,
      JSON.stringify(
        storedConfig({
          providers: new ProviderConfigMap([
            {
              providerId: "zcodeBuiltin",
              templateId: "test-api",
              config: new ProviderConfig({
                group: "standard-personal",
                access: new ApiKeyAccessConfig({ apiKey: "secret" }),
              }),
            },
          ]),
          models: ModelConfigRules.empty(),
        }),
      ),
      "utf8",
    );
    const runtime = new NodeProviderRegistryRuntime({
      zcodeBuiltinFilePath,
      personalFilePath,
      watch: false,
    });

    expect(await runtime.start()).toBeUndefined();
    const snapshot = runtime.registryService.getSnapshot()!;

    expect(snapshot.registry.providers).toHaveLength(1);
    expect(
      runtime.registryService.getModel("zcodeBuiltin", "model-a")?.config.properties,
    ).toMatchObject({
      contextWindow: 200_000,
      inputFormat: expect.objectContaining({ supportsVideo: false }),
    });
    runtime.dispose();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-provider-node-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function settleFileWatcher(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

function emptyUpdate(): ProviderConfigLayerUpdate {
  return Object.freeze({
    providers: ProviderConfigMap.empty(),
    models: ModelConfigRules.empty(),
  });
}

function personalProviderConfig(_enabled: boolean): ProviderConfig {
  return new ProviderConfig({
    group: "standard-personal",
    access: new ApiKeyAccessConfig(),
  });
}

function storedConfig(update: ProviderConfigLayerUpdate): object {
  return encodeProviderConfigFile(update);
}

async function writeZCodeBuiltin(filePath: string, modelId: string): Promise<void> {
  await writeFile(
    filePath,
    JSON.stringify({
      schemaVersion: 1,
      revision: modelId === "model-a" ? 1 : 2,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "zcodeBuiltin",
              config: {
                group: "zai-family",
                access: {
                  type: "zhipu-account",
                  accountType: "zai",
                  mode: "start-plan",
                },
                builtinModelIds: [modelId],
              },
            },
          ],
          templateRules: [],
        },
        modelConfigRules: {
          modelRules: [],
          modelApiRules: [],
          providerSiteRules: [],
          templateModelRules: [],
          builtinProviderModelRules: [],
        },
      },
    }),
    "utf8",
  );
}

async function writeCompleteZCodeBuiltin(filePath: string): Promise<void> {
  await writeFile(
    filePath,
    JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      config: {
        providerConfigRules: {
          providerRules: [],
          templateRules: [
            {
              templateId: "test-api",
              templateNameMap: { "en-US": "Test API" },
              config: {
                access: { type: "api-key" },
                api: {
                  type: "anthropic-messages",
                  baseUrl: "https://api.example.com",
                },
                builtinModelIds: ["model-a"],
              },
            },
          ],
        },
        modelConfigRules: {
          modelRules: [],
          modelApiRules: [],
          providerSiteRules: [],
          templateModelRules: [
            {
              templateId: "test-api",
              modelId: "model-a",
              config: {
                enabled: true,

                properties: {
                  requiresMfjsToolSchema: false,
                  contextWindow: 200000,
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
                },
                optionSpecs: {
                  reasoningLevel: {
                    values: ["disabled"],
                    map: "{}",
                  },
                  maxOutputTokens: {
                    max: 32000,
                    map: "{'max_tokens': maxOutputTokens}",
                  },
                },
              },
            },
          ],
          builtinProviderModelRules: [],
        },
      },
    }),
    "utf8",
  );
}
