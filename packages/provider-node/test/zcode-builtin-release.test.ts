import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProviderConfigService,
  ProviderRegistryService,
  createFailClosedAccountProviderConfigSnapshot,
} from "@zcode/provider";
import {
  NodeZCodeBuiltinProviderConfigSource,
  EndpointScopedZCodeBuiltinSource,
  ZCodeBuiltinRemoteSynchronizer,
  decodeZCodeBuiltinRelease,
  encodeZCodeBuiltinRelease,
  resolveZCodeBuiltinCachePaths,
  NodePersonalProviderConfigRepository,
} from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ZCode Built-in Release", () => {
  it("backs off 1/2/4 minutes capped at one hour; logs distinguish not-yet-due from lease holds", async () => {
    const root = await temporaryRoot();
    const bundledFilePath = join(root, "bundled.json");
    const controlFilePath = join(root, "control.json");
    await writeRelease(bundledFilePath, 1, "model-a");
    const source = new NodeZCodeBuiltinProviderConfigSource({ bundledFilePath, watch: false });
    let now = 1000;
    const events = vi.fn();
    const fetchRelease = vi.fn(async () => {
      throw new Error("offline");
    });
    const sync = new ZCodeBuiltinRemoteSynchronizer({
      source,
      controlFilePath,
      resolveEndpointKey: () => "https://example.com",
      fetchRelease,
      now: () => now,
      onRefreshResult: events,
    });
    try {
      for (const minutes of [1, 2, 4, 8, 16, 32, 60, 60]) {
        await expect(sync.refresh()).rejects.toThrow("offline");
        expect(JSON.parse(await readFile(controlFilePath, "utf8")).nextEligibleAt).toBe(
          now + minutes * 60_000,
        );
        now += minutes * 60_000 - 1;
        await expect(sync.refresh()).resolves.toBe("skipped");
        expect(events).toHaveBeenLastCalledWith({ result: "skipped", reason: "not-due" });
        now += 1;
      }
      await writeFile(
        controlFilePath,
        JSON.stringify({
          schemaVersion: 1,
          endpointKey: "https://example.com",
          leaseUntil: now + 30_000,
          nextEligibleAt: 0,
          failureCount: 0,
        }),
      );
      await expect(sync.refresh({ force: true })).resolves.toBe("skipped");
      expect(events).toHaveBeenLastCalledWith({ result: "skipped", reason: "lease-held" });
      expect(fetchRelease).toHaveBeenCalledTimes(8);
    } finally {
      sync.dispose();
      source.dispose();
    }
  });
  it("parses the two-layer release strictly, rejecting missing fields and the legacy single-layer shape", () => {
    const release = decodeZCodeBuiltinRelease(releaseObject(2, "model-b"));

    expect(release.revision).toBe(2);
    expect(release.config.providers.get("builtin")?.builtinModelIds).toEqual(["model-b"]);
    expect(encodeZCodeBuiltinRelease(release)).toEqual(releaseObject(2, "model-b"));
    expect(() =>
      decodeZCodeBuiltinRelease({ schemaVersion: 1, providers: {}, models: [] }),
    ).toThrow();
    expect(() =>
      decodeZCodeBuiltinRelease({
        schemaVersion: 1,
        revision: 1,
        config: { providers: {} },
      }),
    ).toThrow();
  });

  it("rejects ZAPI republishes of retired products from remote or cache", () => {
    const release = releaseObject(2, "model-b");

    expect(() =>
      decodeZCodeBuiltinRelease({
        ...release,
        config: {
          ...release.config,
          providerConfigRules: {
            ...release.config.providerConfigRules,
            providerRules: [
              ...release.config.providerConfigRules.providerRules,
              {
                providerId: "builtin:zapi",
                config: {
                  group: "zai-family",
                  access: {
                    type: "zhipu-account",
                    accountType: "zai",
                    mode: "start-plan",
                  },
                  builtinModelIds: ["retired-model"],
                },
              },
            ],
          },
        },
      }),
    ).toThrow("builtin:zapi");
  });

  it("isolates cache paths by platform, App version and normalized endpoint", () => {
    const first = resolveZCodeBuiltinCachePaths({
      environmentConfigRoot: "/environment",
      platform: "darwin-aarch64",
      appVersion: "3.0.0",
      zcodeEndpointOrigin: "https://EXAMPLE.com/",
    });
    const equivalent = resolveZCodeBuiltinCachePaths({
      environmentConfigRoot: "/environment",
      platform: "darwin-aarch64",
      appVersion: "3.0.0",
      zcodeEndpointOrigin: "https://example.com",
    });
    const second = resolveZCodeBuiltinCachePaths({
      environmentConfigRoot: "/environment",
      platform: "darwin-aarch64",
      appVersion: "3.0.0",
      zcodeEndpointOrigin: "https://staging.example.com",
    });
    expect(first).toEqual(equivalent);
    // Path assertions keep every isolation layer; never fold separators so a correct Windows impl false-fails.
    expect(dirname(dirname(first.activeFilePath))).toBe(
      join("/environment", "runtime", "provider", "darwin-aarch64", "3.0.0"),
    );
    expect(basename(dirname(first.activeFilePath))).toMatch(/^endpoint-[a-f0-9]{32}$/u);
    expect(basename(first.activeFilePath)).toBe("zcode-builtin.json");
    expect(first.controlFilePath).toBe(
      join(dirname(first.activeFilePath), "zcode-builtin-refresh.json"),
    );
    expect(second.activeFilePath).not.toBe(first.activeFilePath);
    expect(() =>
      resolveZCodeBuiltinCachePaths({
        environmentConfigRoot: "/environment",
        platform: "../other",
        appVersion: "3.0.0",
        zcodeEndpointOrigin: "https://example.com",
      }),
    ).toThrow("platform");
  });

  it("starts from the compatible highest-revision candidate and materializes it as the active file", async () => {
    const root = await temporaryRoot();
    const bundledFilePath = join(root, "bundled.json");
    const activeFilePath = join(root, "cache", "active.json");
    await writeRelease(bundledFilePath, 2, "bundled-model");
    await writeRelease(activeFilePath, 3, "active-model");
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath,
      activeFilePath,
      watch: false,
    });

    expect((await source.read()).providers.get("builtin")?.builtinModelIds).toEqual([
      "active-model",
    ]);
    expect(JSON.parse(await readFile(activeFilePath, "utf8"))).toEqual(
      releaseObject(3, "active-model"),
    );
    source.dispose();
  });

  it("never lets a corrupt, stale or incompatible Active overwrite Bundled", async () => {
    const root = await temporaryRoot();
    const bundledFilePath = join(root, "bundled.json");
    const activeFilePath = join(root, "cache", "active.json");
    await writeRelease(bundledFilePath, 4, "bundled-model");
    await writeRelease(activeFilePath, 3, "old-model");
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath,
      activeFilePath,
      watch: false,
    });

    expect((await source.read()).providers.get("builtin")?.builtinModelIds).toEqual([
      "bundled-model",
    ]);
    expect(JSON.parse(await readFile(activeFilePath, "utf8"))).toEqual(
      releaseObject(4, "bundled-model"),
    );
    source.dispose();
  });

  it("drops a conflicting same-revision Active and boots from Bundled", async () => {
    const root = await temporaryRoot();
    const bundledFilePath = join(root, "bundled.json");
    const activeFilePath = join(root, "cache", "active.json");
    await writeRelease(bundledFilePath, 4, "bundled-model");
    await writeRelease(activeFilePath, 4, "other-model");
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath,
      activeFilePath,
      watch: false,
    });

    expect((await source.read()).providers.get("builtin")?.builtinModelIds).toEqual([
      "bundled-model",
    ]);
    expect(JSON.parse(await readFile(activeFilePath, "utf8"))).toEqual(
      releaseObject(4, "bundled-model"),
    );
    source.dispose();
  });

  it("still boots straight from Bundled when the Active cache cannot materialize", async () => {
    const root = await temporaryRoot();
    const bundledFilePath = join(root, "bundled.json");
    const activeFilePath = join(root, "cache", "active.json");
    await writeRelease(bundledFilePath, 4, "bundled-model");
    await mkdir(activeFilePath, { recursive: true });
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath,
      activeFilePath,
      watch: false,
    });

    expect((await source.read()).providers.get("builtin")?.builtinModelIds).toEqual([
      "bundled-model",
    ]);
    source.dispose();
  });

  it("applies higher remote revisions atomically; dedupes same-revision-same-content and rejects content drift", async () => {
    const root = await temporaryRoot();
    const bundledFilePath = join(root, "bundled.json");
    const activeFilePath = join(root, "cache", "active.json");
    await writeRelease(bundledFilePath, 1, "model-a");
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath,
      activeFilePath,
      watch: false,
    });
    const reasons: string[] = [];
    source.onDidChange((reason) => reasons.push(reason));
    await source.read();

    await expect(
      source.applyRemoteRelease(decodeZCodeBuiltinRelease(releaseObject(2, "model-b"))),
    ).resolves.toBe("updated");
    await expect(
      source.applyRemoteRelease(decodeZCodeBuiltinRelease(releaseObject(2, "model-b"))),
    ).resolves.toBe("unchanged");
    await expect(
      source.applyRemoteRelease(decodeZCodeBuiltinRelease(releaseObject(2, "different"))),
    ).rejects.toThrow("maps to different content");
    await expect(
      source.applyRemoteRelease(decodeZCodeBuiltinRelease(releaseObject(1, "old"))),
    ).resolves.toBe("stale");

    expect(reasons).toEqual(["remote-updated"]);
    expect((await source.read()).providers.get("builtin")?.builtinModelIds).toEqual(["model-b"]);
    source.dispose();
  });

  it("coalesces syncers through an on-disk lease with per-endpoint TTL isolation", async () => {
    const root = await temporaryRoot();
    const bundledFilePath = join(root, "bundled.json");
    const activeFilePath = join(root, "cache", "active.json");
    const controlFilePath = join(root, "cache", "refresh-control.json");
    await writeRelease(bundledFilePath, 1, "model-a");
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath,
      activeFilePath,
      watch: false,
    });
    await source.read();
    let releaseFetch!: () => void;
    const fetchRelease = vi.fn(
      () =>
        new Promise<ReturnType<typeof decodeZCodeBuiltinRelease>>((resolve) => {
          releaseFetch = () => resolve(decodeZCodeBuiltinRelease(releaseObject(2, "model-b")));
        }),
    );
    const first = new ZCodeBuiltinRemoteSynchronizer({
      source,
      controlFilePath,
      resolveEndpointKey: () => "https://first.example.com",
      fetchRelease,
      now: () => 1_000,
    });
    const second = new ZCodeBuiltinRemoteSynchronizer({
      source,
      controlFilePath,
      resolveEndpointKey: () => "https://first.example.com",
      fetchRelease,
      now: () => 1_000,
    });

    const firstRefresh = first.refresh();
    await vi.waitFor(() => expect(fetchRelease).toHaveBeenCalledTimes(1));
    await expect(second.refresh()).resolves.toBe("skipped");
    releaseFetch();
    await expect(firstRefresh).resolves.toBe("updated");

    const endpointChangedFetch = vi.fn(async () => null);
    const endpointChanged = new ZCodeBuiltinRemoteSynchronizer({
      source,
      controlFilePath,
      resolveEndpointKey: () => "https://second.example.com",
      fetchRelease: endpointChangedFetch,
      now: () => 1_001,
    });
    await expect(endpointChanged.refresh()).resolves.toBe("missing");
    expect(endpointChangedFetch).toHaveBeenCalledOnce();
    first.dispose();
    second.dispose();
    endpointChanged.dispose();
    source.dispose();
  });

  it("drops late responses from the previous endpoint after a switch", async () => {
    const root = await temporaryRoot();
    const bundledFilePath = join(root, "bundled.json");
    const activeFilePath = join(root, "cache", "active.json");
    await writeRelease(bundledFilePath, 1, "model-a");
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath,
      activeFilePath,
      watch: false,
    });
    await source.read();
    let endpointKey = "https://old.example.com";
    let completeFetch!: () => void;
    const synchronizer = new ZCodeBuiltinRemoteSynchronizer({
      source,
      controlFilePath: join(root, "cache", "refresh-control.json"),
      resolveEndpointKey: () => endpointKey,
      fetchRelease: () =>
        new Promise((resolve) => {
          completeFetch = () =>
            resolve(decodeZCodeBuiltinRelease(releaseObject(2, "old-endpoint-model")));
        }),
    });

    const refresh = synchronizer.refresh();
    await vi.waitFor(() => expect(completeFetch).toBeTypeOf("function"));
    endpointKey = "https://new.example.com";
    completeFetch();

    await expect(refresh).resolves.toBe("skipped");
    expect(JSON.parse(await readFile(activeFilePath, "utf8"))).toEqual(releaseObject(1, "model-a"));
    synchronizer.dispose();
    source.dispose();
  });

  it("keeps per-endpoint Active/LKG and never compares revisions across endpoints", async () => {
    const root = await temporaryRoot();
    const bundledFilePath = join(root, "bundled.json");
    await writeRelease(bundledFilePath, 1, "bundled-model");
    let endpointOrigin = "https://a.example.com";
    const source = new EndpointScopedZCodeBuiltinSource({
      bundledFilePath,
      environmentConfigRoot: join(root, "environment"),
      platform: "darwin-aarch64",
      appVersion: "3.0.0",
      resolveEndpointOrigin: () => endpointOrigin,
      fetchRelease: async (origin) =>
        decodeZCodeBuiltinRelease(
          origin === "https://a.example.com"
            ? releaseObject(20, "endpoint-a-model")
            : releaseObject(10, "endpoint-b-model"),
        ),
      watch: false,
    });

    await expect(source.refresh({ force: true })).resolves.toBe("updated");
    expect((await source.read()).providers.get("builtin")?.builtinModelIds).toEqual([
      "endpoint-a-model",
    ]);

    endpointOrigin = "https://b.example.com";
    expect((await source.read()).providers.get("builtin")?.builtinModelIds).toEqual([
      "bundled-model",
    ]);
    await expect(source.refresh({ force: true })).resolves.toBe("updated");
    expect((await source.read()).providers.get("builtin")?.builtinModelIds).toEqual([
      "endpoint-b-model",
    ]);

    endpointOrigin = "https://a.example.com";
    expect((await source.read()).providers.get("builtin")?.builtinModelIds).toEqual([
      "endpoint-a-model",
    ]);
    source.dispose();
  });

  it("still refreshes the full Registry on equal publish sequence across endpoints, with Host and Worker sharing one source id", async () => {
    const root = await temporaryRoot();
    const bundledFilePath = join(root, "bundled.json");
    await writeRelease(bundledFilePath, 1, "bundled");
    let endpoint = "https://a.example.com";
    const source = new EndpointScopedZCodeBuiltinSource({
      bundledFilePath,
      environmentConfigRoot: root,
      platform: "darwin-aarch64",
      appVersion: "3.12.0",
      resolveEndpointOrigin: () => endpoint,
      fetchRelease: async (origin) =>
        decodeZCodeBuiltinRelease(
          releaseObject(20, origin.includes("a.example") ? "model-a" : "model-b"),
        ),
      watch: false,
    });
    const personal = new NodePersonalProviderConfigRepository({
      filePath: join(root, "personal.json"),
      pollingIntervalMs: false,
    });
    const config = new ProviderConfigService({
      zcodeBuiltinSource: source,
      personalRepository: personal,
    });
    const registry = new ProviderRegistryService({
      configSource: config,
      accountSource: {
        read: async () => createFailClosedAccountProviderConfigSnapshot(await config.read()),
        onDidChange: () => () => {},
      },
    });
    try {
      await source.refresh({ force: true });
      await registry.start();
      const first = registry.getSnapshot()!;
      endpoint = "https://b.example.com";
      await source.refresh({ force: true });
      const second = await registry.refresh("endpoint-switch");
      expect(second.sourceRevisions.config).not.toBe(first.sourceRevisions.config);
      expect(second.account.basedOnZCodeBuiltinRevision).toBe(second.config.zcodeBuiltinRevision);
      expect(second.resolution.resolvedProviders[0]?.models.map((model) => model.modelId)).toEqual([
        "model-b",
      ]);
      const activeFilePath = await source.resolveActiveFilePath();
      const worker = new NodeZCodeBuiltinProviderConfigSource({
        bundledFilePath: activeFilePath,
        watch: false,
      });
      try {
        expect((await worker.read()).revision).toBe(second.config.zcodeBuiltinRevision);
      } finally {
        worker.dispose();
      }
      endpoint = "https://A.example.com/";
      expect((await source.read()).revision).toBe(first.config.zcodeBuiltinRevision);
      // Tear the temp dir down only after the source-notification refresh settles, never racing the background file lock.
      await registry.refresh("endpoint-back");
    } finally {
      registry.dispose();
      config.dispose();
      personal.dispose();
      source.dispose();
    }
  });

  it("makes a live lease block even explicit refreshes until it expires", async () => {
    const root = await temporaryRoot();
    const bundledFilePath = join(root, "bundled.json");
    const activeFilePath = join(root, "cache", "active.json");
    const controlFilePath = join(root, "cache", "refresh-control.json");
    await writeRelease(bundledFilePath, 1, "model-a");
    await mkdir(dirname(controlFilePath), { recursive: true });
    await writeFile(
      controlFilePath,
      JSON.stringify({
        schemaVersion: 1,
        endpointKey: "https://example.com",
        leaseId: "crashed-owner",
        leaseUntil: 2_000,
        nextEligibleAt: 0,
        failureCount: 0,
      }),
    );
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath,
      activeFilePath,
      watch: false,
    });
    await source.read();
    let now = 1_000;
    const fetchRelease = vi.fn(async () => null);
    const synchronizer = new ZCodeBuiltinRemoteSynchronizer({
      source,
      controlFilePath,
      resolveEndpointKey: () => "https://example.com",
      fetchRelease,
      now: () => now,
    });

    await expect(synchronizer.refresh({ force: true })).resolves.toBe("skipped");
    now = 2_001;
    await expect(synchronizer.refresh()).resolves.toBe("missing");
    expect(fetchRelease).toHaveBeenCalledOnce();
    synchronizer.dispose();
    source.dispose();
  });

  it("escalates backoff on failures while explicit refresh only bypasses nextEligibleAt", async () => {
    const root = await temporaryRoot();
    const bundledFilePath = join(root, "bundled.json");
    const activeFilePath = join(root, "cache", "active.json");
    const controlFilePath = join(root, "cache", "refresh-control.json");
    await writeRelease(bundledFilePath, 1, "model-a");
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath,
      activeFilePath,
      watch: false,
    });
    await source.read();
    let now = 1_000;
    const fetchRelease = vi
      .fn<() => Promise<ReturnType<typeof decodeZCodeBuiltinRelease> | null>>()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValue(null);
    const synchronizer = new ZCodeBuiltinRemoteSynchronizer({
      source,
      controlFilePath,
      resolveEndpointKey: () => "https://example.com",
      fetchRelease,
      now: () => now,
      failureBaseDelayMs: 100,
    });

    await expect(synchronizer.refresh()).rejects.toThrow("temporary");
    now = 1_050;
    await expect(synchronizer.refresh()).resolves.toBe("skipped");
    await expect(synchronizer.refresh({ force: true })).resolves.toBe("missing");
    expect(fetchRelease).toHaveBeenCalledTimes(2);
    synchronizer.dispose();
    source.dispose();
  });

  it("never writes post-dispose remote responses into Active", async () => {
    const root = await temporaryRoot();
    const bundledFilePath = join(root, "bundled.json");
    const activeFilePath = join(root, "cache", "active.json");
    await writeRelease(bundledFilePath, 1, "model-a");
    const source = new NodeZCodeBuiltinProviderConfigSource({
      bundledFilePath,
      activeFilePath,
      watch: false,
    });
    await source.read();
    let completeFetch!: () => void;
    const synchronizer = new ZCodeBuiltinRemoteSynchronizer({
      source,
      controlFilePath: join(root, "cache", "refresh-control.json"),
      resolveEndpointKey: () => "https://example.com",
      fetchRelease: () =>
        new Promise((resolve) => {
          completeFetch = () => resolve(decodeZCodeBuiltinRelease(releaseObject(2, "model-b")));
        }),
    });

    const refresh = synchronizer.refresh();
    await vi.waitFor(() => expect(completeFetch).toBeTypeOf("function"));
    synchronizer.dispose();
    completeFetch();

    await expect(refresh).resolves.toBe("disposed");
    expect(JSON.parse(await readFile(activeFilePath, "utf8"))).toEqual(releaseObject(1, "model-a"));
    source.dispose();
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-builtin-release-"));
  roots.push(root);
  return root;
}

async function writeRelease(filePath: string, revision: number, modelId: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(releaseObject(revision, modelId)), "utf8");
}

function releaseObject(revision: number, modelId: string) {
  return {
    schemaVersion: 1,
    revision,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: "builtin",
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
  };
}
