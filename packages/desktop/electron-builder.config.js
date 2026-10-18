/* eslint-disable max-lines -- Electron Builder config keeps related packaging hooks together so build order stays explicit. */
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { runCommand, runCommandAndReadStdout } from "../../scripts/spawn-command.mjs";
import { loadBuiltinProviderConfig } from "../../scripts/builtin-provider-config.mjs";
import { noticesFileName, stageElectronNotices } from "../../scripts/third-party-notices.mjs";
import { resolveNativeSearchReleasePlan } from "../../scripts/native-search-tools-config.mjs";
import { getBuildMetadata } from "./scripts/build-metadata.mjs";
import { collectRuntimeModuleClosureEntries } from "./scripts/runtime-dependency-closure.mjs";
import {
  resolvePackagedNodePtyPrebuildPath,
  restoreTargetNodePtyPrebuild,
} from "./scripts/node-pty-package-assets.mjs";
import { cleanupPackagedSourcemaps } from "./scripts/packaged-sourcemap-cleanup.mjs";
import { getTargetPlatform } from "./scripts/target-platform.mjs";
import {
  resolveDesktopArtifactSuffix,
  resolveDesktopProductIdentity,
} from "./scripts/desktop-product-identity.mjs";
import { verifyStagedKoffi } from "./scripts/koffi-package-assets.mjs";
const ELECTRON_BUILDER_ARCH = {
  1: "x64",
  3: "arm64",
};
function resolveElectronBuilderWindowsTarget({
  electronPlatformName,
  arch,
  configuredTargetPlatform,
}) {
  if (electronPlatformName !== "win32") {
    throw new Error(
      `[electron-builder.config] context platform is not win32: ${String(electronPlatformName)}`,
    );
  }
  const actualArch = ELECTRON_BUILDER_ARCH[arch];
  if (!actualArch) {
    throw new Error(
      `[electron-builder.config] unsupported electron-builder Windows architecture: ${String(arch)}`,
    );
  }
  const actualTarget = {
    os: "win32",
    arch: actualArch,
    key: `win32-${actualArch}`,
  };
  if (
    configuredTargetPlatform?.os !== actualTarget.os ||
    configuredTargetPlatform?.arch !== actualTarget.arch ||
    configuredTargetPlatform?.key !== actualTarget.key
  ) {
    throw new Error(
      `[electron-builder.config] configured target ${String(configuredTargetPlatform?.key)} does not match electron-builder target ${actualTarget.key}`,
    );
  }
  return actualTarget;
}
import {
  findDesktopNativePackageViolations,
  createDesktopNativePackagePrunePatterns,
  parseAsarListWithPackState,
} from "./scripts/desktop-native-package-policy.mjs";
import { replaceAppAsarFromStaging } from "./scripts/app-asar-repack.mjs";
import {
  patchNsisInstallSectionFile,
  restoreNsisInstallSectionFileSync,
} from "./scripts/patch-nsis-install-section.mjs";

const buildMetadata = getBuildMetadata();
const targetPlatform = getTargetPlatform();
const builtinProviderConfig = await loadBuiltinProviderConfig();
const desktopProductIdentity = resolveDesktopProductIdentity({
  ...process.env,
  ZCODE_ENV: builtinProviderConfig.environment,
});
const nativeSearchReleasePlan = resolveNativeSearchReleasePlan({
  platform: targetPlatform.os,
  arch: targetPlatform.arch,
});
const rawMacSigningIdentity = process.env.APPLE_SIGNING_IDENTITY || process.env.CSC_NAME;
const macSigningIdentity =
  rawMacSigningIdentity?.replace(/^Developer ID Application:\s*/, "") ?? null;
const shouldEnableMacSigning =
  process.env.ZCODE_ENABLE_MAC_SIGN === "1" && Boolean(macSigningIdentity);
const workspaceRoot = resolve(import.meta.dirname, "../..");
const desktopPackageRoot = import.meta.dirname;
const runtimeModuleLookupRoots = [
  desktopPackageRoot,
  workspaceRoot,
  resolve(desktopPackageRoot, "node_modules", ".pnpm", "node_modules"),
  resolve(workspaceRoot, "node_modules", ".pnpm", "node_modules"),
];
const desktopDistDir = process.env.ZCODE_DESKTOP_DIST_DIR || "dist";
const DEFAULT_ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/";
// `pnpm exec asar` relies on `.bin/asar`, but when @electron/asar is only a transitive dep of electron-builder,
// Linux CI (pnpm hoisted) often cannot resolve that binary and `asar list` exits 1 before running.
// Depend on @electron/asar explicitly and run its CLI via Node directly to avoid missing shims across platforms.
const requireFromConfig = createRequire(import.meta.url);
let nsisInstallSectionPatched = false;
let nsisInstallSectionOriginalSource = null;
let nsisInstallSectionPath = null;
const desktopElectronVersion = requireFromConfig("./package.json").devDependencies.electron;
const asarCliPath = resolve(
  dirname(requireFromConfig.resolve("@electron/asar/package.json")),
  "bin",
  "asar.js",
);
const REQUIRED_ASAR_RUNTIME_MODULES = [
  "module-details-from-path",
  "@opentelemetry/api-logs",
  // Bugfix: the telemetry OTLP exporter loads sdk-metrics during startup. In pnpm dev mode it resolves from
  // the workspace root, but electron-builder does not reliably copy this hoisted dep, crashing the installed app at startup.
  // Inject sdk-metrics as a closure root, recursively pulling its OpenTelemetry runtime deps.
  "@opentelemetry/sdk-metrics",
  // OTLP proto export-chain closure root: recursively pull otlp-transformer/protobufjs and its subdeps;
  // otherwise a hoisted layout missing protobufjs makes the installed app report Cannot find module 'protobufjs/minimal' at startup.
  "@opentelemetry/exporter-trace-otlp-proto",
  "@opentelemetry/exporter-metrics-otlp-proto",
  "pngjs",
  // @zcode/services proxy connectivity probes dynamically require("undici") for ProxyAgent.
  // tsup merges services code into the main/host bundles but does not inline this runtime require's package,
  // and electron-builder output can also miss hoisted undici, so the mac installer reports Cannot find module "undici" at startup.
  // Force-inject undici into app.asar like the other safety-net deps to avoid a main-process crash in installed apps.
  "undici",
  // node-forge was only listed in bundle.mjs's verification list, relying on electron-builder to pack it into app.asar;
  // same hazard class as yauzl missing pend — modules required by verification must have an owner. node-forge has no subdeps,
  // and the afterPack scan skips it when already present, so packaged output is unchanged.
  "node-forge",
  // Since 2.7.0 services added the feedback-log compression path and yazl; 2.6.0 lacks this startup dep.
  // Under pnpm hoisted, yazl may reach app.asar while its subdep buffer-crc32 does not reliably ship;
  // inject yazl as a closure root so recursive dependency collection completes the ZIP packing chain.
  "yazl",
  // After yauzl became a direct production dep of desktop/services, pnpm list --prod dedupes the top-level yauzl
  // node into an empty node without subdeps; electron-builder's pnpm collector trusts the first registered empty node
  // and skips the later one with the full subtree, so app.asar gets yauzl without its runtime dep pend,
  // only failing at bundle verification with "missing runtime dep pend". Inject yauzl as a closure root,
  // matching bundle.mjs's verification list so recursive collection ships pend too.
  "yauzl",
  // Bugfix: with the Lark SDK externalized from desktop main/host, the packaged runtime must resolve it from app.asar.
  // Inject the scoped package explicitly; otherwise dev works but the production package crashes with Cannot find module at startup.
  "@larksuiteoapi/node-sdk",
  // In production ssh2 is packed into app.asar, but electron-builder sporadically misses its dependency chain.
  // Seen in the field as Cannot find module 'asn1' (Require stack: ssh2 keyParser).
  // Inject the critical ssh2 dependency chain so remote SSH connections do not fail from missing packages in installed apps.
  "asn1",
  "bcrypt-pbkdf",
  "tweetnacl",
  // electron-updater → builder-util-runtime → debug require("ms") at runtime.
  // Under pnpm hoisted, electron-builder sporadically misses this leaf dep; 3.4.0 (built for ci/cua-v0.3.17)
  // already hit Cannot find module 'ms' at installer startup (Require stack: debug/src/common.js),
  // breaking the auto-update path. ms is a leaf package; explicit injection lets debug resolve inside app.asar.
  "ms",
];
// pacman deps must use package names from the official Arch repos. electron-builder's legacy default set includes
// removed libappindicator-gtk3/http-parser and misses runtime libs Electron actually needs; maintaining an explicit
// minimal runtime closure avoids unresolvable pacman -U deps or missing libs surfacing only at startup.
const PACMAN_RUNTIME_DEPENDENCIES = [
  "gtk3",
  "nss",
  "libxss",
  "libxtst",
  "libnotify",
  "alsa-lib",
  "mesa",
  "xdg-utils",
];

const WINDOWS_INSTALL_MANIFEST_NAME = ".zcode-install-manifest";

async function writeWindowsInstallManifest(context) {
  if (context.electronPlatformName !== "win32") return;

  const root = context.appOutDir;
  const files = [];
  const visit = async (directory, relativeDirectory = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(relativePath.replaceAll("/", "\\"));
      }
    }
  };

  await visit(root);
  files.sort();
  await writeFile(join(root, WINDOWS_INSTALL_MANIFEST_NAME), `${files.join("\r\n")}\r\n`, "utf8");
}

function resolveElectronDownloadMirror(env = process.env) {
  const existingMirror =
    env.ZCODE_ELECTRON_RUNTIME_MIRROR ||
    env.NPM_CONFIG_ELECTRON_MIRROR ||
    env.npm_config_electron_mirror ||
    env.npm_package_config_electron_mirror ||
    env.ELECTRON_MIRROR;
  if (existingMirror?.trim()) {
    return existingMirror.trim();
  }

  return DEFAULT_ELECTRON_MIRROR;
}

const commandStdoutMaxBuffer = 64 * 1024 * 1024;
// The artifact suffix only marks the backend env (_TEST); identity is distinguished by productName, so production-backend Preview packages have no suffix.
const desktopArtifactEnvSuffix = resolveDesktopArtifactSuffix(process.env);

// Preview is an internally signed test package. If CI enables macOS signing explicitly without an identity, fail before producing unsigned artifacts
// so a present artifact is not mistaken for having gone through the same signing pipeline as production.
if (
  desktopProductIdentity.flavor === "preview" &&
  process.env.ZCODE_ENABLE_MAC_SIGN === "1" &&
  !macSigningIdentity
) {
  throw new Error(
    "ZCode Preview macOS packaging requires APPLE_SIGNING_IDENTITY or CSC_NAME when ZCODE_ENABLE_MAC_SIGN=1",
  );
}

const PACKAGING_PRUNE_PATTERNS = [
  "!**/*.map",
  "!**/*.pdb",
  "!**/__tests__/**",
  "!**/test/**",
  "!**/tests/**",
  "!**/example/**",
  "!**/examples/**",
  "!**/README*",
  "!**/CHANGELOG*",
  "!**/CONTRIBUTING*",
  "!**/CODE_OF_CONDUCT*",
  "!**/SECURITY*",
];

function buildDesktopArtifactName(platformName, extension = "${ext}") {
  // Test-env artifacts must be distinguishable from release installer filenames to avoid mix-ups during upload, download, or manual acceptance.
  return `\${productName}-\${version}-${platformName}-\${arch}${desktopArtifactEnvSuffix}.${extension}`;
}

function runAsarCommand(args) {
  runCommand(process.execPath, [asarCliPath, ...args], {
    cwd: import.meta.dirname,
    env: process.env,
  });
}

function runAsarCommandAndReadStdout(args) {
  return runCommandAndReadStdout(process.execPath, [asarCliPath, ...args], {
    cwd: import.meta.dirname,
    env: process.env,
    // app.asar is large in the current desktop package; asar list output can exceed the default buffer and trigger ENOBUFS.
    // Enlarge the buffer explicitly so the needs-injection check does not misreport the packaging run as failed.
    maxBuffer: commandStdoutMaxBuffer,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function runTimedSync(label, fn) {
  const startMs = Date.now();
  console.log(`[ci][timer] ${label} start`);
  try {
    return fn();
  } finally {
    console.log(`[ci][timer] ${label} end duration_ms=${Date.now() - startMs}`);
  }
}

async function runTimedAsync(label, fn) {
  const startMs = Date.now();
  console.log(`[ci][timer] ${label} start`);
  try {
    return await fn();
  } finally {
    console.log(`[ci][timer] ${label} end duration_ms=${Date.now() - startMs}`);
  }
}

function resolveAppAsarPath(context) {
  if (context.electronPlatformName === "darwin") {
    const appName = `${context.packager?.appInfo?.productFilename ?? "ZCode"}.app`;
    return resolve(context.appOutDir, appName, "Contents", "Resources", "app.asar");
  }

  return resolve(context.appOutDir, "resources", "app.asar");
}

function resolvePackagedResourcesDir(context) {
  if (context.electronPlatformName === "darwin") {
    const appName = `${context.packager?.appInfo?.productFilename ?? "ZCode"}.app`;
    return resolve(context.appOutDir, appName, "Contents", "Resources");
  }

  return resolve(context.appOutDir, "resources");
}

function normalizeAsarEntry(entry) {
  return entry.trim().replaceAll("\\", "/");
}

function resolveMissingRuntimeModules(appAsarPath) {
  const asarEntries = runAsarCommandAndReadStdout(["list", appAsarPath])
    .split("\n")
    .map(normalizeAsarEntry)
    .filter(Boolean);
  const asarEntrySet = new Set(asarEntries);

  const runtimeModules = collectRuntimeModuleClosureEntries(
    REQUIRED_ASAR_RUNTIME_MODULES,
    runtimeModuleLookupRoots,
  );
  const resolvableRuntimeModules = runtimeModules.filter((entry) => {
    if (!entry.sourceModulePath) {
      // Depending on platform/install layout, some runtime deps may be pruned or absent from this packaging workspace.
      // Throwing during the copy phase used to abort the whole platform build; now log a warning and skip the module
      // so afterPack only handles deps resolvable in the current environment, avoiding full CI failure over one optional dep.
      console.warn(
        `[afterPack] runtime module not found, skip injection: ${entry.moduleName}; searched=${runtimeModuleLookupRoots
          .map((lookupRoot) => resolve(lookupRoot, "node_modules", entry.moduleName))
          .join(", ")}`,
      );
      return false;
    }
    return true;
  });
  return resolvableRuntimeModules.filter((entry) => {
    const { moduleName } = entry;
    const moduleRoot = `/node_modules/${moduleName}`;
    if (asarEntrySet.has(moduleRoot)) {
      return false;
    }
    for (const entry of asarEntrySet) {
      if (entry.startsWith(`${moduleRoot}/`)) {
        return false;
      }
    }
    return true;
  });
}

async function injectHoistedRuntimeModulesIntoAsar(context) {
  const appAsarPath = resolveAppAsarPath(context);
  if (!existsSync(appAsarPath)) {
    throw new Error(`Packaged artifact is missing app.asar: ${appAsarPath}`);
  }

  const missingRuntimeModules = runTimedSync("afterPack:scan-missing-runtime-modules", () =>
    resolveMissingRuntimeModules(appAsarPath),
  );
  if (missingRuntimeModules.length === 0) {
    // Previously afterPack fully extracted/repaked app.asar every run even when runtime deps were complete.
    // That added tens of seconds to every package run. Scan for missing modules first and rewrite only when something is actually absent.
    console.log("[afterPack] runtime modules already complete, skip app.asar rewrite");
    return;
  }
  console.log(`[afterPack] missing runtime modules count=${missingRuntimeModules.length}`);

  // CI points TMPDIR at the in-repo .tmp; GitLab get_sources/clean may wipe it before the script starts.
  // Rewriting app.asar in afterPack also relies on mkdtempSync, so create the parent dir as a fallback, or the signing stage sees the .app vanish.
  mkdirSync(tmpdir(), { recursive: true });
  const stagingDir = mkdtempSync(resolve(tmpdir(), "zcode-app-asar-"));
  try {
    runTimedSync("afterPack:asar-extract", () =>
      runAsarCommand(["extract", appAsarPath, stagingDir]),
    );

    const stagingNodeModulesDir = resolve(stagingDir, "node_modules");
    mkdirSync(stagingNodeModulesDir, { recursive: true });

    runTimedSync("afterPack:copy-runtime-modules", () => {
      for (const runtimeModule of missingRuntimeModules) {
        const { moduleName, sourceModulePath } = runtimeModule;
        const targetModulePath = resolve(stagingNodeModulesDir, moduleName);

        if (!sourceModulePath) {
          throw new Error(
            `Runtime dependency not found: ${moduleName}; searched: ${runtimeModuleLookupRoots
              .map((lookupRoot) => resolve(lookupRoot, "node_modules", moduleName))
              .join(", ")}`,
          );
        }

        // Under pnpm hoisted, electron-builder can pack the main package into app.asar
        // while missing runtime deps that resolution expects to find in the root node_modules.
        // require-in-the-middle once missed module-details-from-path, then @fiahfy/icns missed pngjs;
        // both surfaced as Cannot find module in installed apps, crashing main-process startup.
        // Complete the dependency closure recursively via package.json instead of patching one missing package per release.
        // Explicit package.json deps, the local node_modules mirror, and files include all failed to ship it reliably,
        // so rewrite app.asar during afterPack, adding these runtime packages before signing and publishing.
        mkdirSync(dirname(targetModulePath), { recursive: true });
        rmSync(targetModulePath, { force: true, recursive: true });
        cpSync(sourceModulePath, targetModulePath, { recursive: true });
      }
    });

    await runTimedAsync("afterPack:asar-pack", () =>
      replaceAppAsarFromStaging({
        sourceDir: stagingDir,
        appAsarPath,
        targetPlatformKey: targetPlatform.key,
        runAsarCommand,
      }),
    );
  } finally {
    rmSync(stagingDir, { force: true, recursive: true });
  }
}

async function stripPackagedSourcemapReferences(context) {
  // electron-builder files rules can exclude .map files but cannot strip trailing sourcemap comments in JS/CSS;
  // the afterPack runtime-dep injection can also reintroduce third-party sourceMappingURL comments.
  // Clean both app.asar and unpacked/extraResources so the final release never exposes sourcemap path entries.
  await cleanupPackagedSourcemaps({
    appAsarPath: resolveAppAsarPath(context),
    resourcesDir: resolvePackagedResourcesDir(context),
    runAsarCommand,
    runTimedSync,
    runTimedAsync,
    replaceAppAsarFromStaging: ({ sourceDir, appAsarPath }) =>
      replaceAppAsarFromStaging({
        sourceDir,
        appAsarPath,
        targetPlatformKey: targetPlatform.key,
        runAsarCommand,
      }),
  });
}

function assertPackagedNativeResourcePolicy(context) {
  const appAsarPath = resolveAppAsarPath(context);
  const entries = parseAsarListWithPackState(
    runAsarCommandAndReadStdout(["list", "--is-pack", appAsarPath]),
  );
  const violations = findDesktopNativePackageViolations(entries, targetPlatform.key);
  if (violations.length > 0) {
    // supportedArchitectures allows preparing multi-platform deps in the workspace, but installers may only carry target-platform natives.
    // Canvas and node-pty natives for other platforms used to be written into asar/unpacked together, bloating packages by hundreds of MiB.
    throw new Error(`Desktop native resource boundary check failed:\n- ${violations.join("\n- ")}`);
  }
}

function assertPackagedNodePtyPrebuild(context) {
  const targetBinaryPath = resolvePackagedNodePtyPrebuildPath({
    resourcesDir: resolvePackagedResourcesDir(context),
    platformKey: targetPlatform.key,
  });
  if (!existsSync(targetBinaryPath))
    throw new Error(`node-pty prebuild missing: ${targetBinaryPath}`);
}

/** @type {import("electron-builder").Configuration} */
export default {
  appId: desktopProductIdentity.appId,
  // Linux deb packaging (fpm) validates homepage, author.email, and maintainer from package metadata.
  // Missing fields fail the artifact stage in CI. Fill them in the build config here instead of relying on external injection.
  extraMetadata: {
    version: buildMetadata.appVersion,
    zcodeProductFlavor: desktopProductIdentity.flavor,
    homepage: "https://zcode.z.ai",
    author: {
      name: "ZCode",
      email: "dev@zcode.z.ai",
    },
  },
  // macOS signing codesigns every language pack under the Electron Framework individually.
  // The default full language set means many locale.pak signing calls and much longer packaging times.
  // Keep only the languages this product needs to cut signed-file count and total CI duration.
  electronLanguages: ["en-US", "zh-CN"],
  // With pnpm workspace + semver ranges (e.g. ^41.0.3), electron-builder
  // sometimes cannot derive the Electron version from the dep tree and aborts the bundle.
  // Pin the Electron version used by desktop explicitly instead of guessing at packaging time.
  electronVersion: "41.0.3",
  electronDownload: {
    // ELECTRON_MIRROR is a global @electron/get env var; it overrides mirrorOptions passed by
    // dmg-builder and other generic artifacts, misplacing builder helper packages under the Electron runtime mirror dir.
    // Use electron-builder's dedicated option so only the Electron runtime zip download is affected.
    mirror: resolveElectronDownloadMirror(),
  },
  productName: desktopProductIdentity.productName,
  directories: {
    // macOS arm64/x64 CI may share one checkout and package in parallel.
    // Allow the output root to be isolated per arch so one job cleaning dist cannot delete a .app another job is signing.
    output: desktopDistDir,
    buildResources: "build",
  },
  files: [
    "out/**/*",
    "package.json",
    // app.asar packs the desktop runtime node_modules, and dependency-bundled .map / README
    // files would ship by default. Prune once at the main-package level, removing only non-runtime files; LICENSE is kept.
    ...PACKAGING_PRUNE_PATTERNS,
    ...createDesktopNativePackagePrunePatterns(targetPlatform.key),
    "!node_modules/@zcode/**",
    "!node_modules/react/**",
    "!node_modules/react-dom/**",
  ],
  asarUnpack: [
    // node-pty's target prebuild also carries helper executables such as spawn-helper / winpty-agent.exe,
    // so the whole target dir must be unpacked; other platform dirs are already pruned by files rules.
    `node_modules/node-pty/prebuilds/${targetPlatform.key}/**`,
  ],
  beforePack: async (context) => {
    runTimedSync("beforePack:restoreTargetNodePtyPrebuild", () =>
      restoreTargetNodePtyPrebuild({ desktopPackageRoot, targetPlatform }),
    );
    if (context.electronPlatformName !== "win32" || nsisInstallSectionPatched) {
      return;
    }

    nsisInstallSectionPath = resolve(
      dirname(requireFromConfig.resolve("app-builder-lib/package.json")),
      "templates",
      "nsis",
      "installSection.nsh",
    );
    const patchResult = await runTimedAsync("beforePack:patchNsisInstallSection", () =>
      patchNsisInstallSectionFile(nsisInstallSectionPath),
    );
    nsisInstallSectionPatched = true;
    nsisInstallSectionOriginalSource = patchResult.originalSource;
    if (patchResult.changed) {
      // electron-builder compiles NSIS later in this process; restore the upstream template in node_modules
      // after the whole build process exits so one packaging run's customization is not baked into dev deps permanently.
      process.once("exit", () => {
        restoreNsisInstallSectionFileSync({
          filePath: nsisInstallSectionPath,
          originalSource: nsisInstallSectionOriginalSource,
        });
      });
    }
  },
  afterExtract: async (context) => {
    // Fix: the macOS rename stage deletes the archive-top-level license; afterExtract must preserve the target platform's original.
    const framework = context.packager.info.framework;
    const resources =
      context.electronPlatformName === "darwin"
        ? resolve(context.appOutDir, framework.distMacOsAppName, "Contents", "Resources")
        : resolve(context.appOutDir, "resources");
    await stageElectronNotices(context.appOutDir, resources, framework.version);
  },
  afterPack: async (context) => {
    const actualWindowsTarget =
      context.electronPlatformName === "win32"
        ? resolveElectronBuilderWindowsTarget({
            electronPlatformName: context.electronPlatformName,
            arch: context.arch,
            configuredTargetPlatform: targetPlatform,
          })
        : null;
    await runTimedAsync("afterPack:injectHoistedRuntimeModulesIntoAsar", () =>
      injectHoistedRuntimeModulesIntoAsar(context),
    );
    await runTimedAsync("afterPack:stripPackagedSourcemapReferences", () =>
      stripPackagedSourcemapReferences(context),
    );
    runTimedSync("afterPack:assertPackagedNativeResourcePolicy", () =>
      assertPackagedNativeResourcePolicy(context),
    );
    runTimedSync("afterPack:assertPackagedNodePtyPrebuild", () =>
      assertPackagedNodePtyPrebuild(context),
    );
    if (actualWindowsTarget) {
      await runTimedAsync("afterPack:writeWindowsInstallManifest", () =>
        writeWindowsInstallManifest(context),
      );
    }
  },
  extraResources: [
    { from: resolve(workspaceRoot, noticesFileName), to: noticesFileName },
    ...(targetPlatform.os === "darwin"
      ? [
          {
            // Snap-anchor data source for the CUA permission panel (CGWindowListCopyWindowInfo, no TCC permission needed).
            // The main process resolves it via process.resourcesPath; on absence the watcher fails open and the panel
            // still works, just without snapping, so no existence assertion here.
            from: "resources/macos-window-bounds/zcode-window-bounds",
            to: "macos-window-bounds/zcode-window-bounds",
          },
        ]
      : []),
    {
      // Release packages must not depend on the repo checkout for community/feedback built-in fallback config.
      // Ship it explicitly under resources/config, matching the main process's process.resourcesPath resolution.
      from: resolve(workspaceRoot, "config/default.json"),
      to: "config/default.json",
    },
    {
      // The Provider Registry's ZCode Built-in Config is the only built-in source of truth for Provider/Model facts.
      // Ship it with the package so release Hosts never fall back to legacy Catalog/Preset hardcode.
      from: builtinProviderConfig.sourcePath,
      to: "config/provider/zcode-builtin.json",
    },
    {
      // App icon: placed in resources at package time, loaded by the main process via process.resourcesPath.
      from: "build/icon.png",
      to: "icon.png",
    },
    ...(targetPlatform.os === "linux"
      ? [
          {
            // AppImage per-user hicolor icon install uses the real 512x512 asset so the claimed dir size matches the PNG IHDR.
            from: "build/icons/512x512.png",
            to: "icon_512x512.png",
          },
        ]
      : []),
    {
      // Windows-specific icon: dev and packaged builds share the same taskbar/window icon asset.
      from: "build/icon_windows.png",
      to: "icon_windows.png",
    },
    ...(targetPlatform.os === "win32"
      ? [
          {
            // Windows tray icon: Tray can only reliably read a dedicated resource under resources when packaged.
            // Do not reuse the window PNG, or the notification area degrades into a blurry scaled image on high DPI.
            from: "build/icon.ico",
            to: "tray_icon.ico",
          },
        ]
      : []),
    {
      // Agent runtime assets, packaged under resources/glm.
      // The desktop bundles the agent's JS build (glm/zcode.cjs, generated by prepare:agent-bundle);
      // the Host process runs it with the app's own Electron Node runtime (ELECTRON_RUN_AS_NODE) as `zcode.cjs app-server --stdio`;
      // no separate Node binary ships in the package. Remote SSH/WSL still uses native binaries (without Electron).
      from: `bundled-agents/${targetPlatform.key}/glm`,
      to: "glm",
      filter: ["**/*", "!**/*.map"],
    },
    {
      // The agent shell previously relied entirely on the host system PATH; GUI launches often missed a user-installed rg.
      // Bundle ripgrep as a desktop runtime tool under resources/tools;
      // host/server append that dir to PATH: the user's version wins, the bundled rg is the fallback.
      from: `bundled-tools/${targetPlatform.key}/ripgrep`,
      to: "tools/ripgrep",
      filter: ["**/*"],
    },
    ...nativeSearchReleasePlan.extraResourceToolIds.map((toolId) => ({
      from: `bundled-tools/${targetPlatform.key}/${toolId}`,
      to: `tools/${toolId}`,
      filter: ["**/*"],
    })),
  ],
  // postinstall reuses node-pty's bundled Windows prebuild first, rebuilding via electron-rebuild for other platforms as needed.
  // Packaging reuses the native artifacts prepared at install time so electron-builder does not trigger another uncontrolled local build.
  npmRebuild: false,
  // OAuth deep link protocol registration (macOS packaged builds need CFBundleURLTypes declared in Info.plist)
  protocols: [
    {
      // The protocol handler display name used to be the lowercase scheme, hiding the product name in packaged protocol descriptions.
      // Display name follows the installer identity; the scheme stays zcode, so the last registrant of two apps becomes the default handler.
      name: desktopProductIdentity.productName,
      schemes: ["zcode"],
    },
  ],
  mac: {
    target: ["dmg", "zip"],
    category: "public.app-category.developer-tools",
    artifactName: buildDesktopArtifactName("mac"),
    extendInfo: {
      NSAppleEventsUsageDescription: `${desktopProductIdentity.productName} needs Apple Events access to coordinate local automation workflows with user-approved desktop apps.`,
    },
    // The pre-sign script uses native codesign and needs the full "Developer ID Application: ..." identity string;
    // electron-builder's mac.identity on 26.x rejects names with that prefix.
    // Normalize the prefix on the electron-builder side only, so local pre-signing and final .app signing do not fight.
    // z-code previously had only local unsigned packaging config; even with certificate env injected in CI,
    // electron-builder would not switch to hardened runtime / entitlement release parameters by itself.
    // Gate it behind an env flag explicitly so local dev is not bound to signing config and CI releases opt in.
    // Local stable signing: CSC_NAME=<identity> (e.g. the self-signed ZCodeLocalDev) makes
    // every build carry the same identity, so macOS TCC grants (Local Network etc.) persist
    // across updates. Unset keeps ad-hoc/unsigned.
    identity: shouldEnableMacSigning ? macSigningIdentity : process.env.CSC_NAME || null,
    // macOS artifacts use a two-stage pipeline: sign during build + separate notarization stage.
    // Leaving electron-builder's built-in notarize on would read Apple credentials during build and attempt notarization,
    // forcing APPLE_APP_SPECIFIC_PASSWORD and failing the build before any DMG is produced.
    notarize: false,
    hardenedRuntime: shouldEnableMacSigning,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.inherit.plist",
    // Runtime executables are signed in a separate pre-sign stage before packaging; if electron-builder deep-scans
    // those directories while signing the main app, macOS codesign time grows significantly.
    // Match absolute paths via "any prefix + Contents/Resources" since ^Contents/... misses in CI.
    // Matches skip re-signing/traversal of already pre-signed dirs while keeping the main app and framework signatures.
    // The CUA Helper is Developer ID signed and notarization-stapled in a separate job;
    // re-signing the nested Helper would change its CDHash and invalidate the staple in the final user package.
    signIgnore: [
      "[/\\\\]Contents[/\\\\]Resources[/\\\\]glm([/\\\\]|$)",
      "[/\\\\]Contents[/\\\\]Resources[/\\\\]tools([/\\\\]|$)",
    ],
  },
  win: {
    target: ["nsis"],
    artifactName: buildDesktopArtifactName("win"),
  },
  linux: {
    target: ["AppImage", "deb", "rpm", "pacman"],
    artifactName: buildDesktopArtifactName("linux"),
    // The desktop package name is scoped (@zcode/desktop); electron-builder by default pushes the Linux
    // executable/Icon to @zcodedesktop. Some desktop environments cannot match that icon name in hicolor
    // and fall back to the system gear. Pin a stable lowercase name so Icon=zcode
    // matches /usr/share/icons/hicolor/*/apps/zcode.png.
    executableName: desktopProductIdentity.linuxExecutableName,
    category: "Development",
    maintainer: "ZCode <dev@zcode.z.ai>",
  },
  deb: {
    // Production and Preview must be two dpkg packages; changing only the executable name still makes the installer treat one as an upgrade of the other.
    packageName: desktopProductIdentity.linuxPackageName,
  },
  pacman: {
    // Same flavor isolation as deb/rpm so pacman does not treat Preview/Production as one package and overwrite.
    packageName: desktopProductIdentity.linuxPackageName,
    // Explicitly list Electron runtime deps resolvable from official Arch repos, replacing electron-builder's
    // stale default set so installation does not fail on removed package names.
    depends: PACMAN_RUNTIME_DEPENDENCIES,
    // electron-builder names pacman targets .pacman; the Arch-native standard extension is .pkg.tar.zst.
    artifactName: buildDesktopArtifactName("linux", "pkg.tar.zst"),
  },
  rpm: {
    // Same constraint as deb: production and Preview must be separate rpm packages, or dnf treats the other flavor as an upgrade.
    // rpm targets RHEL 8+ (glibc 2.28); the package-wide glibc floor is raised to 2.28 by the node-pty prebuild and bfs/ugrep,
    // while the Electron 41 main binary only references up to 2.25. fpm rpm builds need rpmbuild and xz on the build host.
    packageName: desktopProductIdentity.linuxPackageName,
    // electron-builder's default rpm Requires (gtk3/nss/libXtst etc.) omits mesa-libgbm and alsa-lib that the Electron
    // ELF actually DT_NEEDEDs; a minimal rockylinux:8 container fails at startup with missing libgbm.so.1 in testing.
    // Append via fpm -d (accumulates after default Requires); depends cannot be used because it replaces the whole default set.
    fpm: ["-d", "mesa-libgbm", "-d", "alsa-lib"],
  },
  dmg: {
    // Runtime resources in the package (agent node_modules in particular) already exceed the default DMG size estimate.
    // With auto sizing, the mounted volume was about 1.9Gi and copying the .app ran out of space,
    // dropping the Electron Framework main binary so launch failed with DYLD Library missing.
    // Enlarge DMG capacity explicitly to avoid truncated copies leaving a Framework dir with missing core files.
    size: "3200m",
    // Custom install background image.
    background: "build/dmg_background.png",
    // The install volume icon uses dedicated install artwork; reusing the app icon weakens install recognition.
    icon: "build/icon_installer.icns",
    contents: [
      // Experimental: pin icon coordinates for hidden resource files, pushing them toward the corners.
      { x: 640, y: 56, type: "file", path: ".background.tiff" },
      { x: 640, y: 56, type: "file", path: ".VolumeIcon.icns" },
      { x: 130, y: 220 },
      { x: 410, y: 220, type: "link", path: "/Applications" },
    ],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    // The Windows install flow uses dedicated installer icons, decoupled from the runtime app icons.
    installerIcon: "build/icon_installer.ico",
    uninstallerIcon: "build/icon_installer.ico",
    installerHeaderIcon: "build/icon_installer.ico",
  },
  detectUpdateChannel: false,
  publish: {
    provider: "generic",
    // The current OSS/CDN returns 206 for multi-range requests with Content-Type application/x-msdownload;
    // electron-updater falls back to full-package download without multipart/byteranges. Disabling multiple ranges keeps
    // delta updates, fetching diff chunks sequentially per single range, instead of degrading a Windows update from ~15MB to 300MB+.
    useMultipleRangeRequest: false,
    // New clients use the server-side manifest provider at runtime; keep only the generic publish placeholder
    // electron-builder requires so packaged artifacts stop carrying the configurable legacy stable feed.
    url: "http://localhost:8081",
  },
};
