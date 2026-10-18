import { chmod, readFile, rm } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { stageBuiltinProviderConfig } from "../../../../../scripts/builtin-provider-config.mjs";
import { stageThirdPartyNotices } from "../../../../../scripts/third-party-notices.mjs";

const cliRoot = resolve(import.meta.dirname, "..");
const projectRoot = resolve(cliRoot, "../..");
const executableFileMode = 0o755;
const packageJsonFile = "package.json";
const rootPackageVersionError = "Root package.json must define a non-empty string version.";
const desktopAgentBuildFlag = "--desktop-agent";
export const resolveBuildExternal = () => ["@zcode/tui", "playwright-core", "koffi"];

export const readZodBuildVersion = async () => {
  const sharedPackage = JSON.parse(
    await readFile(resolve(projectRoot, "../../packages/shared/package.json"), "utf8"),
  );
  const version = sharedPackage.dependencies?.zod;
  if (typeof version !== "string" || !/^4\.\d+\.\d+$/.test(version)) {
    throw new Error("packages/shared must pin one exact Zod v4 version.");
  }
  return version;
};

async function readZodPackage(file, cache) {
  for (
    let directory = dirname(file);
    directory !== dirname(directory);
    directory = dirname(directory)
  ) {
    if (basename(directory) !== "zod") continue;
    if (!cache.has(directory)) {
      cache.set(
        directory,
        readFile(resolve(directory, "package.json"), "utf8").then((text) => {
          const manifest = JSON.parse(text);
          if (manifest.name !== "zod" || typeof manifest.version !== "string") {
            throw new Error(`Invalid Zod package metadata: ${directory}`);
          }
          return { root: directory, version: manifest.version };
        }),
      );
    }
    return cache.get(directory);
  }
  return undefined;
}

function assertZodVersion(pkg, expectedV4Version) {
  if (pkg.version.startsWith("4.") && pkg.version !== expectedV4Version) {
    throw new Error(`Expected Zod v4 ${expectedV4Version}, found ${pkg.version}: ${pkg.root}`);
  }
}

export async function assertZodBundleIdentity(metafile, { workingDirectory, expectedV4Version }) {
  if (!metafile) throw new Error("Zod bundle validation requires an esbuild metafile.");
  const packages = new Map();
  const cache = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    if (!/(?:^|[/\\])zod[/\\]/.test(input)) continue;
    const pkg = await readZodPackage(resolve(workingDirectory, input), cache);
    if (!pkg) continue;
    assertZodVersion(pkg, expectedV4Version);
    const previous = packages.get(pkg.version);
    if (previous && previous !== pkg.root) {
      throw new Error(`Duplicate Zod ${pkg.version} in bundle: ${previous}, ${pkg.root}`);
    }
    packages.set(pkg.version, pkg.root);
  }
}

export function createZodDedupePlugin({ expectedV4Version }) {
  return {
    name: "zcode-zod-dedupe",
    setup(builder) {
      const packages = new Map();
      const cache = new Map();
      // A hoisted install can leave several consumers with byte-identical Zods at different paths.
      // Resolve version and exports per original consumer first, then merge install roots; never alias v3 to v4.
      builder.onResolve({ filter: /^zod(?:\/|$)/ }, async (args) => {
        if (args.pluginData?.zcodeZodResolving) return;
        const resolved = await builder.resolve(args.path, {
          importer: args.importer,
          resolveDir: args.resolveDir,
          kind: args.kind,
          pluginData: { zcodeZodResolving: true },
        });
        if (resolved.errors.length || resolved.external) return resolved;
        const pkg = await readZodPackage(resolved.path, cache);
        if (!pkg) throw new Error(`Cannot identify resolved Zod package: ${resolved.path}`);
        assertZodVersion(pkg, expectedV4Version);
        if (!packages.has(pkg.version)) packages.set(pkg.version, pkg.root);
        return {
          ...resolved,
          // Keep the subentry selected by exports and its .js/.cjs; do not rewrite conditions via require.resolve.
          path: resolve(packages.get(pkg.version), relative(pkg.root, resolved.path)),
          pluginData: args.pluginData,
        };
      });
      builder.onEnd(async (result) => {
        if (result.errors.length) return;
        await assertZodBundleIdentity(result.metafile, {
          workingDirectory: builder.initialOptions.absWorkingDir ?? process.cwd(),
          expectedV4Version,
        });
      });
    },
  };
}

export const readRootPackageVersion = async ({ root = projectRoot } = {}) => {
  const packageJson = JSON.parse(await readFile(resolve(root, packageJsonFile), "utf8"));

  if (typeof packageJson.version !== "string" || packageJson.version.trim() === "") {
    throw new Error(rootPackageVersionError);
  }

  return packageJson.version;
};

export const resolveBuildOptions = (args = [], env = process.env) => {
  const desktopAgent = args.includes(desktopAgentBuildFlag);
  const e2eCoverage = env.ZCODE_E2E_COVERAGE === "1";

  return {
    // The normal desktop-agent release stays minified without maps; the E2E coverage
    // build must keep original symbols and source maps so c8 can map back to each package's TS sources.
    minify: desktopAgent && !e2eCoverage,
    sourcemap: e2eCoverage || !desktopAgent,
  };
};

export const resolveBuildAliases = ({
  cliDirectory = cliRoot,
  rootDirectory = projectRoot,
} = {}) => ({
  "@zcode/shared-types": resolve(cliDirectory, "../shared-types/dist/index.js"),
  // plugin-host startup needs only these isolated entries; the shared root entry must not be re-evaluated via the generic alias.
  "@zcode/shared/runtime-env": resolve(rootDirectory, "../../packages/shared/src/runtimeEnv.ts"),
  "@zcode/shared/mcp": resolve(rootDirectory, "../../packages/shared/src/mcp.ts"),
  "@zcode/shared/runtime-tool-runtime": resolve(
    rootDirectory,
    "../../packages/shared/src/runtime-tool-runtime.ts",
  ),
  // esbuild aliases rewrite import paths by prefix. Every shared subpath must be declared exactly, before the generic entry,
  // otherwise it resolves wrongly to `src/index.ts/<subpath>` and breaks the Desktop agent/SEA bundle.
  "@zcode/shared/zcode-protocol-v4": resolve(
    rootDirectory,
    "../../packages/shared/src/zcode-protocol-v4/index.ts",
  ),
  // Added when the ModelSelection schema moved to shared as the single source of truth.
  // esbuild aliases rewrite by prefix; without an exact declaration before the generic entry, this gets wrongly appended to
  // `src/index.ts/model-selection` and breaks the Desktop agent bundle.
  "@zcode/shared/model-selection": resolve(
    rootDirectory,
    "../../packages/shared/src/model-selection.ts",
  ),
  // The shared model-schema subpath must not be appended to index.ts by the generic alias.
  "@zcode/shared/model-config": resolve(rootDirectory, "../../packages/shared/src/model-config.ts"),
  // The process crash boundary uses this lightweight contract before bootstrap; it must not fall under shared's generic prefix alias.
  "@zcode/shared/process-diagnostic": resolve(
    rootDirectory,
    "../../packages/shared/src/process-diagnostic.ts",
  ),
  "@zcode/shared/config-schema": resolve(
    rootDirectory,
    "../../packages/shared/src/config-schema.ts",
  ),
  "@zcode/shared/workspace-hook-discovery": resolve(
    rootDirectory,
    "../../packages/shared/src/workspace-hook-discovery.ts",
  ),
  // The review controller imports WorkspaceHookMutationError directly and needs this exact
  // alias (same esbuild prefix-rewrite rule as above; a missing declaration breaks the Desktop agent/SEA bundle).
  "@zcode/shared/workspace-hook-mutation": resolve(
    rootDirectory,
    "../../packages/shared/src/workspace-hook-mutation.ts",
  ),
  // The verdict direct import needs this exact alias; a missing declaration lets the generic
  // "@zcode/shared" prefix rewrite append `src/index.ts/workspace-hook-review-monotonicity`,
  // and the Desktop agent/SEA bundle fails outright.
  "@zcode/shared/workspace-hook-review-monotonicity": resolve(
    rootDirectory,
    "../../packages/shared/src/workspace-hook-review-monotonicity.ts",
  ),
  // New subpath after the trust-store file schema moved to its single source; a missing declaration lets the generic
  // "@zcode/shared" prefix rewrite append `src/index.ts/workspace-hook-trust-store-file`,
  // and the Desktop agent/SEA bundle fails (same as the two rules above).
  "@zcode/shared/workspace-hook-trust-store-file": resolve(
    rootDirectory,
    "../../packages/shared/src/workspace-hook-trust-store-file.ts",
  ),
  "@zcode/shared/zcodeEndpoint": resolve(
    rootDirectory,
    "../../packages/shared/src/zcodeEndpoint.ts",
  ),
  // Plugin UI (MCP Apps) protocol subpath: referenced by the dist of adapters/core/contracts; declare it before the generic entry too.
  "@zcode/shared/mcp-apps": resolve(rootDirectory, "../../packages/shared/src/mcp-apps/index.ts"),
  "@zcode/shared/node": resolve(rootDirectory, "../../packages/shared/src/node.ts"),
  // The generic alias would append the subentry to index.ts; the published implementation must resolve independently.
  "@zcode/shared/request-security": resolve(
    rootDirectory,
    "../../packages/shared/src/request-security-edition/index.ts",
  ),
  "@zcode/shared": resolve(rootDirectory, "../../packages/shared/src/index.ts"),
  "@zcode/core": resolve(cliDirectory, "../core/dist/index.js"),
});

export const buildCli = async ({
  cliDirectory = cliRoot,
  rootDirectory = projectRoot,
  minify = false,
  sourcemap = true,
  env = process.env,
  version = readRootPackageVersion({
    root: rootDirectory,
  }),
} = {}) => {
  const cliVersion = await version;
  const outfile = resolve(cliDirectory, "dist/zcode.cjs");
  const sourcemapFile = `${outfile}.map`;

  await stageBuiltinProviderConfig({
    root: resolve(rootDirectory, "../.."),
    directory: resolve(cliDirectory, "dist/provider"),
    env,
  });

  await build({
    banner: {
      js: "#!/usr/bin/env node",
    },
    bundle: true,
    define: {
      __CLI_VERSION__: JSON.stringify(cliVersion),
    },
    entryPoints: [resolve(cliDirectory, "src/main.ts")],
    // Ink 7 and yoga-layout use top-level await, so the CJS CLI bundle loads the TUI
    // through Node's native dynamic import path instead of forcing esbuild to lower it.
    // playwright-core depends on runtime package assets and require.resolve, so it must stay external instead of being inlined.
    // The managed headless adapter lazy-loads only with explicit --browser-use=headless; app-server and the plain CLI are unaffected.
    // koffi dynamically requires native `.node` files per platform; inlining makes esbuild walk every
    // platform artifact and fail with "No loader is configured for .node". At runtime it still loads from the dependency package,
    // and SEA assets are handled separately by build-sea's native asset collection.
    external: resolveBuildExternal(),
    format: "cjs",
    // Desktop app integration embeds only zcode.cjs; the legacy desktop-agent build reuses the CLI debug artifact,
    // which is unminified and leaves sourcemap references that are not shipped. Desktop agent mode minifies the JS but keeps
    // function/class names so diagnostics and registration that rely on names survive esbuild identifier mangling.
    keepNames: minify,
    legalComments: "none",
    logLevel: "info",
    minify,
    metafile: true,
    plugins: [createZodDedupePlugin({ expectedV4Version: await readZodBuildVersion() })],
    outfile,
    platform: "node",
    sourcemap,
    // target is the lowest Node across all host runtimes: desktop uses Electron's bundled Node 24,
    // remote SSH reuses a deployed standalone Node v22.16 to run the same zcode.cjs. node22 guarantees the artifact
    // uses no syntax/features unsupported by either host runtime.
    target: "node22",
    alias: resolveBuildAliases({ cliDirectory, rootDirectory }),
  });

  if (!sourcemap) {
    await rm(sourcemapFile, { force: true });
  }

  await chmod(outfile, executableFileMode);
  // zcode.cjs inlines third-party code; the sidecar declaration next to dist is copied by the release CLI and the unified distribution package (build-zcode).
  await stageThirdPartyNotices(resolve(cliDirectory, "dist"), resolve(rootDirectory, "../.."));
};

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  await buildCli(resolveBuildOptions(process.argv.slice(2)));
}
