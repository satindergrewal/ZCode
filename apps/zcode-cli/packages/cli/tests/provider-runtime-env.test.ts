import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import {
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import {
  SEA_ZCODE_BUILTIN_PROVIDER_CONFIG_ASSET_KEY,
  prepareCliProviderRuntimeEnv,
} from "../src/provider-runtime-env.js";

const temporaryDirectories: string[] = [];

test.afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

test("preserves explicitly injected provider runtime paths", async () => {
  const prepared = await prepareCliProviderRuntimeEnv({
    argv: ["--prompt", "hello"],
    env: {
      [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: "/injected/zcode-builtin.json",
      [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: "/injected/personal.json",
    },
  });

  assert.deepEqual(prepared, {
    [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: "/injected/zcode-builtin.json",
    [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: "/injected/personal.json",
  });
});

test("resolves the development ZCode Built-in Config and shared Personal Config", async () => {
  const root = await temporaryDirectory();
  const entrypoint = join(root, "apps/zcode-cli/packages/cli/src/main.ts");
  const zcodeBuiltinFilePath = join(root, "config/provider/zcode-builtin.json");
  await mkdir(dirname(entrypoint), { recursive: true });
  await mkdir(dirname(zcodeBuiltinFilePath), { recursive: true });
  // The bundled config is located by the entry's real path (symlinks resolved); the entry file must exist.
  await writeFile(entrypoint, "");
  await writeFile(zcodeBuiltinFilePath, EMPTY_RELEASE);

  const prepared = await prepareCliProviderRuntimeEnv({
    argv: ["tui"],
    dataBaseDir: join(root, "home"),
    entrypoint,
    env: {},
    appVersion: "test-version",
    platform: "test-platform",
  });

  assertActiveConfigPath(prepared[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV], join(root, "home"));
  assert.equal(
    prepared[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV],
    join(root, "home/.zcode/v2/provider_config.json"),
  );
  const activeFilePath = prepared[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV];

  const loginPrepared = await prepareCliProviderRuntimeEnv({
    argv: ["login"],
    dataBaseDir: join(root, "home"),
    entrypoint,
    env: {},
    appVersion: "test-version",
    platform: "test-platform",
  });
  assert.equal(loginPrepared[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV], activeFilePath);
  const logoutPrepared = await prepareCliProviderRuntimeEnv({
    argv: ["logout"],
    dataBaseDir: join(root, "home"),
    entrypoint,
    env: {},
    appVersion: "test-version",
    platform: "test-platform",
  });
  assert.equal(logoutPrepared[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV], activeFilePath);
  // The temp dir itself may be behind a symlink (macOS /tmp, /var); the bundled config reports the real path.
  assert.equal(
    prepared.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE,
    await realpath(zcodeBuiltinFilePath),
  );
  await assert.rejects(access(join(dirname(activeFilePath!), "zcode-builtin-refresh.json")));
});

test("materializes the SEA config in the fixed environment resource path, separate from downloads", async () => {
  const root = await temporaryDirectory();
  const zcodeBuiltinContent = EMPTY_RELEASE;
  let reads = 0;
  const prepared = await prepareCliProviderRuntimeEnv({
    argv: ["--prompt", "hello"],
    dataBaseDir: root,
    env: {},
    sea: {
      getAsset(key, encoding) {
        assert.equal(key, SEA_ZCODE_BUILTIN_PROVIDER_CONFIG_ASSET_KEY);
        assert.equal(encoding, "utf8");
        reads += 1;
        return zcodeBuiltinContent;
      },
      isSea: () => true,
    },
    appVersion: "test-version",
    platform: "test-platform",
  });

  const zcodeBuiltinFilePath = prepared[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV];
  assert.ok(zcodeBuiltinFilePath);
  assertActiveConfigPath(zcodeBuiltinFilePath, root);
  assert.deepEqual(
    JSON.parse(await readFile(zcodeBuiltinFilePath, "utf8")),
    JSON.parse(zcodeBuiltinContent),
  );
  assert.equal(reads, 1);
  const resource = join(
    root,
    ".zcode",
    "v2",
    "runtime",
    "provider",
    "bundled",
    "zcode-builtin.json",
  );
  assert.notEqual(resource, zcodeBuiltinFilePath);
  assert.deepEqual(JSON.parse(await readFile(resource, "utf8")), JSON.parse(zcodeBuiltinContent));
  assert.equal(prepared.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE, resource);
  await assert.rejects(access(join(dirname(zcodeBuiltinFilePath), "zcode-builtin-refresh.json")));
});

test("does not resolve provider assets for commands that do not run Core", async () => {
  assert.deepEqual(
    await prepareCliProviderRuntimeEnv({
      argv: ["doctor", "--json"],
      env: {},
    }),
    {},
  );
  for (const flag of ["--help", "-h", "--version", "-v"]) {
    assert.deepEqual(
      await prepareCliProviderRuntimeEnv({
        argv: [flag],
        env: {},
      }),
      {},
    );
  }
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-cli-provider-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

function assertActiveConfigPath(filePath: string | undefined, dataBaseDir: string): void {
  assert.ok(filePath);
  // A slash regex must not misreject Windows; the layer checks still cover env, platform, version, and endpoint.
  assert.equal(
    dirname(dirname(filePath)),
    join(dataBaseDir, ".zcode", "v2", "runtime", "provider", "test-platform", "test-version"),
  );
  assert.match(basename(dirname(filePath)), /^endpoint-[a-f0-9]{32}$/u);
  assert.equal(basename(filePath), "zcode-builtin.json");
}

const EMPTY_RELEASE =
  '{"schemaVersion":1,"revision":1,"config":{"providerConfigRules":{"templateRules":[],"providerRules":[]},"modelConfigRules":{"modelRules":[],"modelApiRules":[],"providerSiteRules":[],"templateModelRules":[],"builtinProviderModelRules":[]}}}';
