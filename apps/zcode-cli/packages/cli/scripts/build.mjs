import { chmod, readFile, rm } from "node:fs/promises";
import {
  readThirdPartyNotices,
  stageThirdPartyNotices,
} from "../../../../../scripts/third-party-notices.mjs";
import { basename, dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { stageBuiltinProviderConfig } from "../../../../../scripts/builtin-provider-config.mjs";

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
      // Hoisted installs can leave byte-identical Zod copies at different paths for multiple consumers.
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
          // Keep the subpath entry and .js/.cjs already chosen by exports; do not rewrite conditions via require.resolve.
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
    // Normal desktop-agent releases stay minified without maps; the E2E coverage build must keep original
    // symbols and source maps so c8 can map back to each package's TS sources.
    minify: desktopAgent && !e2eCoverage,
    sourcemap: e2eCoverage || !desktopAgent,
  };
};

export const resolveBuildAliases = ({
  cliDirectory = cliRoot,
  rootDirectory = projectRoot,
} = {}) => ({
  "@zcode/shared-types": resolve(cliDirectory, "../shared-types/dist/index.js"),
  // plugin-host startup needs only these standalone entries; never re-evaluate the shared barrel via the generic alias.
  "@zcode/shared/runtime-env": resolve(rootDirectory, "../../packages/shared/src/runtimeEnv.ts"),
  "@zcode/shared/mcp": resolve(rootDirectory, "../../packages/shared/src/mcp.ts"),
  "@zcode/shared/runtime-tool-runtime": resolve(
    rootDirectory,
    "../../packages/shared/src/runtime-tool-runtime.ts",
  ),
  // esbuild aliases rewrite import paths by prefix. Every shared subpath must be declared exactly before the
  // generic entry, or it misresolves to `src/index.ts/<subpath>` and breaks the Desktop agent/SEA bundles.
  "@zcode/shared/zcode-protocol-v4": resolve(
    rootDirectory,
    "../../packages/shared/src/zcode-protocol-v4/index.ts",
  ),
  // Subpath added when the ModelSelection schema moved to a shared single source of truth.
  // esbuild rewrites by prefix; without an exact entry before the generic one it misjoins to
  // `src/index.ts/model-selection` and breaks the Desktop agent bundle.
  "@zcode/shared/model-selection": resolve(
    rootDirectory,
    "../../packages/shared/src/model-selection.ts",
  ),
  // The shared model schema's new subpath must not be prefix-aliased onto index.ts.
  "@zcode/shared/model-config": resolve(rootDirectory, "../../packages/shared/src/model-config.ts"),
  // The process error boundary uses this lightweight contract before bootstrap; keep it out of the shared generic prefix alias.
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
  // The review controller's direct WorkspaceHookMutationError import needs this exact alias
  // (same esbuild prefix-rewrite rule; a missing entry breaks the Desktop agent/SEA bundles).
  "@zcode/shared/workspace-hook-mutation": resolve(
    rootDirectory,
    "../../packages/shared/src/workspace-hook-mutation.ts",
  ),
  // The verdict's direct import needs this exact alias; otherwise the generic
  // "@zcode/shared" prefix rewrite produces `src/index.ts/workspace-hook-review-monotonicity`
  // and the Desktop agent/SEA bundles fail outright.
  "@zcode/shared/workspace-hook-review-monotonicity": resolve(
    rootDirectory,
    "../../packages/shared/src/workspace-hook-review-monotonicity.ts",
  ),
  // New subpath after the trust store file schema moved to a single source; a missing entry lets the generic
  // "@zcode/shared" prefix rewrite produce `src/index.ts/workspace-hook-trust-store-file` and
  // breaks the Desktop agent/SEA bundles (same as the two existing rules above).
  "@zcode/shared/workspace-hook-trust-store-file": resolve(
    rootDirectory,
    "../../packages/shared/src/workspace-hook-trust-store-file.ts",
  ),
  "@zcode/shared/zcodeEndpoint": resolve(
    rootDirectory,
    "../../packages/shared/src/zcodeEndpoint.ts",
  ),
  "@zcode/shared/node": resolve(rootDirectory, "../../packages/shared/src/node.ts"),
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
  const notices = await readThirdPartyNotices(resolve(rootDirectory, "../.."));

  await stageBuiltinProviderConfig({
    root: resolve(rootDirectory, "../.."),
    directory: resolve(cliDirectory, "dist/provider"),
    env,
  });

  await build({
    banner: {
      // Shared entry for SEA and the normal CLI; the banner must be readable before Agent init and native asset unpack.
      js: `#!/usr/bin/env node\n"use strict";\nif (process.argv.length === 3 && process.argv[2] === "--licenses") { const sea = require("node:sea"); const nodeNotice = sea.isSea() ? "\\n\\n## Bundled Node.js runtime\\n\\n" + sea.getAsset("zcode-node-license", "utf8") : ""; process.stdout.write(${JSON.stringify(notices.toString("utf8"))} + nodeNotice, () => process.exit(0)); } else {`,
    },
    footer: { js: "}" },
    bundle: true,
    define: {
      __CLI_VERSION__: JSON.stringify(cliVersion),
    },
    entryPoints: [resolve(cliDirectory, "src/main.ts")],
    // Ink 7 and yoga-layout use top-level await, so the CJS CLI bundle loads the TUI
    // through Node's native dynamic import path instead of forcing esbuild to lower it.
    // playwright-core needs runtime package assets and require.resolve; keep it external instead of inlined.
    // The managed headless adapter lazy-loads only with explicit --browser-use=headless; app-server/normal CLI unaffected.
    // koffi dynamic-requires native `.node` files per platform; inlining makes esbuild walk every
    // platform artifact and fail with "No loader is configured for .node". Runtime still loads from the dependency,
    // and SEA assets are handled by build-sea's native asset collection phase.
    external: resolveBuildExternal(),
    format: "cjs",
    // Desktop integration embeds only zcode.cjs; the legacy desktop-agent build reused CLI debug artifacts,
    // uncompressed with sourcemap pointers to files never shipped. Desktop agent mode minifies JS while
    // keeping function/class names so name-dependent diagnostics and registration survive esbuild mangling.
    keepNames: minify,
    legalComments: "none",
    logLevel: "info",
    minify,
    metafile: true,
    plugins: [createZodDedupePlugin({ expectedV4Version: await readZodBuildVersion() })],
    outfile,
    platform: "node",
    sourcemap,
    // Target the lowest Node version across all carrying runtimes: desktop uses Electron's bundled Node 24,
    // remote SSH reuses a deployed standalone Node v22.16 for the same zcode.cjs. node22 guarantees this
    // artifact never uses syntax/features unsupported by either target runtime.

    target: "node22",
    alias: resolveBuildAliases({ cliDirectory, rootDirectory }),
  });

  if (!sourcemap) {
    await rm(sourcemapFile, { force: true });
  }

  await chmod(outfile, executableFileMode);
  await stageThirdPartyNotices(resolve(cliDirectory, "dist"), resolve(rootDirectory, "../.."));
};

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  await buildCli(resolveBuildOptions(process.argv.slice(2)));
}
