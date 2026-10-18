import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ModelConfigRules,
  ModelConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderConfigService,
  ProviderTemplateMap,
  parseProviderTemplateMap,
} from "@zcode/provider";
import { NodePersonalProviderConfigRepository } from "../src/personal-provider-config-repository.js";
import { encodeProviderConfigFile } from "../src/provider-config-file-codec.js";
import { NodeModelSelectionConfigRepository } from "../src/model-selection-config-repository.js";

let directory: string;
const defaults = { providerId: "p", modelId: "m", options: { reasoningLevel: "high" } };
const repositories: NodePersonalProviderConfigRepository[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "todo104-personal-rules-"));
});
afterEach(async () => {
  repositories.splice(0).forEach((repo) => repo.dispose());
  await rm(directory, { recursive: true, force: true });
});
function repository() {
  const repo = new NodePersonalProviderConfigRepository({
    filePath: join(directory, "provider_config.json"),
    pollingIntervalMs: false,
  });
  repositories.push(repo);
  return repo;
}
function service(
  repo: NodePersonalProviderConfigRepository,
  templates = ProviderTemplateMap.empty(),
) {
  return new ProviderConfigService({
    personalRepository: repo,
    zcodeBuiltinSource: {
      read: async () => ({
        revision: "builtin",
        providers: ProviderConfigMap.empty(),
        models: ModelConfigRules.empty(),
        providerTemplates: templates,
      }),
      onDidChange: () => () => undefined,
    },
  });
}

describe("Todo104 personal rule atomic persistence", () => {
  it("Todo130: fresh manual rules survive write/reopen/independent toggles without hidden system leaves added", async () => {
    const manual = {
      properties: {
        contextWindow: 1234,
        supportsJsonSchemaOutput: false,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
        inputFormat: { supportsImage: false, supportsVideo: false, supportsPdf: false },
      },
      optionSpecs: {
        reasoningLevel: { values: ["high"], map: "{}" },
        maxOutputTokens: { max: 128 },
      },
    };
    const repo = repository();
    await repo.update(() => ({
      providers: new ProviderConfigMap([
        ["p", new ProviderConfig({ personalModelIds: ["m"], modelOrder: ["m"] })],
      ]),
      models: ModelConfigRules.empty().setExact("p", "m", ModelConfig.fromData(manual), false),
      defaultModelSelection: defaults,
      providerOrder: ["p"],
    }));
    const reopened = repository();
    const configService = service(reopened);
    try {
      expect((await reopened.read()).models.getExact("p", "m")?.toJSON()).toEqual(manual);
      await configService.setPersonalModelEnabled("p", "m", false);
      const raw = JSON.parse(await readFile(join(directory, "provider_config.json"), "utf8"));
      expect(raw.config.modelConfigRules.manualProviderModelRules[0].config).toEqual({
        ...manual,
        enabled: false,
      });
      expect(raw.config.defaultModelSelection).toEqual(defaults);
      expect(raw.config.providerOrder).toEqual(["p"]);
      expect((await repository().read()).models.getExact("p", "m")?.toJSON()).toEqual({
        ...manual,
        enabled: false,
      });
    } finally {
      configService.dispose();
    }
  });
  it("returns a snapshot whose later reads match version-for-version; outer key order never counts as a second change", async () => {
    const personal = repository();
    const saved = await personal.update(() => ({
      providers: new ProviderConfigMap([
        {
          config: new ProviderConfig({ personalModelIds: ["m"] }),
          providerName: "Provider",
          providerId: "p",
        },
      ]),
      models: ModelConfigRules.empty(),
      defaultModelSelection: defaults,
    }));
    const path = join(directory, "provider_config.json");
    const raw = await readFile(path, "utf8");
    expect((await personal.read()).revision).toBe(saved.revision);
    expect(await readFile(path, "utf8")).toBe(raw);
  });
  it("keeps both processes' updates when two real Node processes write provider and default selection concurrently", async () => {
    const personal = repository();
    await personal.read();
    const script = fileURLToPath(new URL("./fixtures/personal-config-writer.ts", import.meta.url));
    const children = ["provider", "default"].map((role) =>
      fork(script, [join(directory, "provider_config.json"), role], {
        execArgv: ["--import", import.meta.resolve("tsx")],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      }),
    );
    const outcomes = children.map((child) => {
      let stderr = "";
      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });
      return new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) =>
          code === 0
            ? resolve()
            : reject(new Error(`fixture child failed: ${code}/${signal}: ${stderr}`)),
        );
      });
    });
    // Observe failures from creation on; a child start crash must never become an unhandled rejection.
    const completed = Promise.all(outcomes);
    void completed.catch(() => undefined);
    try {
      const ready = Promise.all(
        children.map(
          (child) =>
            new Promise<void>((resolve, reject) => {
              child.once("message", () => resolve());
              child.once("error", reject);
              child.once("exit", () => reject(new Error("fixture exited before ready")));
            }),
        ),
      );
      await ready;
      children.forEach((child) => child.send("start"));
      await completed;
      const current = await personal.read();
      expect(current.providers.keys()).toEqual(
        Array.from({ length: 20 }, (_, index) => `provider-${index}`),
      );
      expect(current.defaultModelSelection).toEqual({ providerId: "fixture", modelId: "model-19" });
      expect(
        JSON.parse(await readFile(join(directory, "provider_config.json"), "utf8")).config
          .providerConfigRules.providerRules,
      ).toHaveLength(20);
    } finally {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill();
      await Promise.allSettled(outcomes);
    }
  }, 20_000);
  it("reuses one Personal Repository for default-selection reads, writes and notifications with no second file or watcher", async () => {
    const personal = repository();
    const source = new NodeModelSelectionConfigRepository({ personalRepository: personal });
    const changed = vi.fn();
    source.onDidChange(changed);
    await source.saveConfiguredDefault(defaults);
    expect(await source.read()).toEqual(defaults);
    expect((await personal.read()).defaultModelSelection).toEqual(defaults);
    expect(changed).toHaveBeenCalledTimes(1);
    await personal.update((current) => ({
      ...current,
      providers: current.providers.set("p", new ProviderConfig({ personalModelIds: ["m"] })),
    }));
    expect(changed).toHaveBeenCalledTimes(2);
    await source.saveConfiguredDefault(undefined);
    expect(await source.read()).toBeUndefined();
    expect((await personal.read()).providers.keys()).toEqual(["p"]);
    source.dispose();
    const count = changed.mock.calls.length;
    await personal.update((current) => ({ ...current, defaultModelSelection: defaults }));
    expect(changed).toHaveBeenCalledTimes(count);
    expect((await personal.read()).defaultModelSelection).toEqual(defaults);
  });
  it("preserves defaults across envelope bumps while provider edits and another Repository's default set never clobber each other", async () => {
    const a = repository(),
      b = repository();
    await a.update((current) => ({ ...current, defaultModelSelection: defaults }));
    expect((await b.read()).defaultModelSelection).toEqual(defaults);
    const before = (await b.read()).revision;
    const config = service(a);
    const nextDefault = { ...defaults, modelId: "next" };
    await Promise.all([
      config.createPersonalProvider({ providerName: "Custom" }),
      b.update((current) => ({ ...current, defaultModelSelection: nextDefault })),
    ]);
    const saved = await a.read();
    expect(saved.defaultModelSelection).toEqual(nextDefault);
    expect(saved.providers.rules().map((rule) => rule.providerName)).toEqual(["Custom"]);
    expect(saved.revision).not.toBe(before);
    const raw = JSON.parse(await readFile(join(directory, "provider_config.json"), "utf8"));
    expect(raw.config.defaultModelSelection).toEqual(nextDefault);
    expect(raw.config.providerConfigRules.providerRules).toHaveLength(1);
    await b.update((current) => ({ ...current, defaultModelSelection: undefined }));
    expect((await a.read()).defaultModelSelection).toBeUndefined();
    expect((await a.read()).providers.keys()).toHaveLength(1);
    config.dispose();
  });

  it("dedupes created names by current locale under the file lock; rereads never follow template renames", async () => {
    const templates = parseProviderTemplateMap([
      { templateId: "t", templateNameMap: { "zh-CN": "模板", "en-US": "Template" }, config: {} },
    ]);
    const a = service(repository(), templates),
      b = service(repository(), templates);
    await Promise.all([
      a.createPersonalProvider({ templateId: "t", locale: "zh-CN" }),
      b.createPersonalProvider({ templateId: "t", locale: "zh-CN" }),
    ]);
    const repo = repository();
    expect(
      (await repo.read()).providers
        .rules()
        .map((rule) => rule.providerName)
        .sort(),
    ).toEqual(["模板", "模板 2"]);
    await a.createPersonalProvider({ providerName: " TEMPLATE " });
    await a.createPersonalProvider({ templateId: "t", locale: "en-US" });
    expect((await repo.read()).providers.rules().map((rule) => rule.providerName)).toContain(
      "Template 2",
    );
    const fresh = service(
      repo,
      parseProviderTemplateMap([
        { templateId: "t", templateNameMap: { "zh-CN": "新名称" }, config: {} },
      ]),
    );
    expect((await repo.read()).providers.rules().map((rule) => rule.providerName)).toContain(
      "模板",
    );
    a.dispose();
    b.dispose();
    fresh.dispose();
  });

  it("keeps the original file when an incomplete manual rule fails to parse, minting no smart rules and clobbering no valid default", async () => {
    const filePath = join(directory, "provider_config.json");
    const bad = JSON.stringify({
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: [] },
        modelConfigRules: {
          providerModelRules: [],
          manualProviderModelRules: [{ providerId: "p", modelId: "m", config: { enabled: true } }],
        },
        defaultModelSelection: defaults,
      },
    });
    await writeFile(filePath, bad);
    const recovery = vi.fn();
    const repo = new NodePersonalProviderConfigRepository({
      filePath,
      pollingIntervalMs: false,
      onRecovery: recovery,
    });
    repositories.push(repo);
    expect((await repo.read()).providers.keys()).toEqual([]);
    expect(recovery).toHaveBeenCalled();
    await expect(
      repo.update((current) => ({ ...current, defaultModelSelection: undefined })),
    ).rejects.toThrow();
    expect(await readFile(filePath, "utf8")).toBe(bad);
  });

  it("treats a missing default in the final file as cleared, never re-running legacy import; full replaces may clear it", async () => {
    const filePath = join(directory, "provider_config.json");
    const empty = { providers: ProviderConfigMap.empty(), models: ModelConfigRules.empty() };
    await writeFile(filePath, JSON.stringify(encodeProviderConfigFile(empty)));
    const importer = vi.fn(async () => ({ ...empty, defaultModelSelection: defaults }));
    const repo = new NodePersonalProviderConfigRepository({
      filePath,
      importLegacy: importer,
      pollingIntervalMs: false,
    });
    repositories.push(repo);
    expect((await repo.read()).defaultModelSelection).toBeUndefined();
    expect(importer).not.toHaveBeenCalled();
    await repo.update((current) => ({ ...current, defaultModelSelection: defaults }));
    const config = service(repo);
    await config.replacePersonalConfig({
      ...empty,
      providers: new ProviderConfigMap([["p", new ProviderConfig({ personalModelIds: ["m"] })]]),
    });
    expect((await repo.read()).defaultModelSelection).toBeUndefined();
    config.dispose();
  });
});
