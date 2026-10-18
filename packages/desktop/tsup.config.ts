import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "tsup";
import { getBuildMetadata } from "./scripts/build-metadata.mjs";
import { resolveDesktopProductFlavor } from "./scripts/desktop-product-identity.mjs";
const { copyGenUiRuntimeAssets } = await import(
  pathToFileURL(resolve(import.meta.dirname, "scripts/gen-ui-runtime-assets.mjs")).href
);
// tsup bundles this config file first; load build tooling dynamically so its import.meta.dirname is not re-anchored to desktop.
const { loadBuiltinProviderConfig } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/builtin-provider-config.mjs")).href
);
const { resolveBuildTimeConfig, createBuildTimeConfigDefines } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/build-time-config.mjs")).href
);
// Build-time optional capabilities (ARMS, event reporting, auto-update); see
// docs/desktop/build-time-optional-capabilities.md.
const buildTimeConfigDefines = createBuildTimeConfigDefines(
  await resolveBuildTimeConfig(process.env),
);

const buildMetadata = getBuildMetadata();

function resolveZCodeEnv(value: string | undefined): "test" | "production" {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

// Load .env files manually; unlike Vite, tsup does not read .env.*. They only provide link-time constants.
function loadEnvFiles(): Record<string, string> {
  const vars: Record<string, string> = {};
  const files = ["../../.env"];
  if (process.env.NODE_ENV === "production") {
    files.push("../../.env.production");
  } else {
    files.push("../../.env.development", "../../.env.development.local");
  }
  for (const file of files) {
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf-8").split("\n")) {
        const match = line.match(/^(\w+)=(.*)$/);
        if (match) vars[match[1]] = match[2];
      }
    }
  }
  // Real environment variables take priority.
  if (process.env.ZCODE_ENV) vars.ZCODE_ENV = process.env.ZCODE_ENV;
  if (process.env.ZCODE_BASE_URL) vars.ZCODE_BASE_URL = process.env.ZCODE_BASE_URL;
  if (process.env.VITE_ZCODE_BASE_URL) vars.VITE_ZCODE_BASE_URL = process.env.VITE_ZCODE_BASE_URL;
  // OAuth origin/client_id are read by the host runtime; keep override hooks here to observe the unified env source in dev builds.
  if (process.env.ZAI_OAUTH_CLIENT_ID) vars.ZAI_OAUTH_CLIENT_ID = process.env.ZAI_OAUTH_CLIENT_ID;
  if (process.env.ZAI_OAUTH_ORIGIN) vars.ZAI_OAUTH_ORIGIN = process.env.ZAI_OAUTH_ORIGIN;
  if (process.env.ZAI_BUSINESS_BASE_URL) {
    vars.ZAI_BUSINESS_BASE_URL = process.env.ZAI_BUSINESS_BASE_URL;
  }
  if (process.env.ZAI_BUSINESS_LOGIN_URL) {
    vars.ZAI_BUSINESS_LOGIN_URL = process.env.ZAI_BUSINESS_LOGIN_URL;
  }
  if (process.env.CDN_DOMAIN) vars.CDN_DOMAIN = process.env.CDN_DOMAIN;
  if (process.env.OSS_PATH_PREFIX) vars.OSS_PATH_PREFIX = process.env.OSS_PATH_PREFIX;
  if (process.env.VITE_ZAI_OAUTH_CLIENT_ID) {
    vars.VITE_ZAI_OAUTH_CLIENT_ID = process.env.VITE_ZAI_OAUTH_CLIENT_ID;
  }
  if (process.env.VITE_ZAI_OAUTH_ORIGIN) {
    vars.VITE_ZAI_OAUTH_ORIGIN = process.env.VITE_ZAI_OAUTH_ORIGIN;
  }
  return vars;
}

const env = loadEnvFiles();
const { environment: zcodeEnv } = await loadBuiltinProviderConfig();
// Installer identity and backend environment are independent axes: ZCODE_PREVIEW_IDENTITY=1 keeps a production-backend build packaged as ZCode Preview.
const zcodeProductFlavor = resolveDesktopProductFlavor({ ...process.env, ZCODE_ENV: zcodeEnv });
console.log(`[tsup] ZCODE_ENV=${zcodeEnv} ZCODE_PRODUCT_FLAVOR=${zcodeProductFlavor}`);

function parseCsvEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function resolveBuildRemoteCdnReleaseRoots(runtimeEnv: Record<string, string | undefined>) {
  const domains = parseCsvEnv(runtimeEnv.CDN_DOMAIN);
  const pathPrefixes = parseCsvEnv(runtimeEnv.OSS_PATH_PREFIX || "zcode/electron/releases");
  if (domains.length === 0) {
    return [];
  }
  if (pathPrefixes.length !== 1 && pathPrefixes.length !== domains.length) {
    throw new Error(
      `OSS_PATH_PREFIX must contain one value or match CDN_DOMAIN count (${domains.length}), got ${pathPrefixes.length}`,
    );
  }

  return domains.map((domain, index) => {
    const pathPrefix = pathPrefixes.length === 1 ? pathPrefixes[0] : pathPrefixes[index];
    return `https://${domain}/${pathPrefix}`.replace(/\/+$/, "");
  });
}

export function resolveBuildPackagedAgentTelemetryEnv(
  runtimeEnv: Record<string, string | undefined>,
): Record<string, string> {
  const endpoint = runtimeEnv.ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT?.trim();
  const headers = runtimeEnv.ZCODE_PACKAGED_AGENT_OTEL_HEADERS?.trim();
  const serviceName =
    runtimeEnv.ZCODE_PACKAGED_AGENT_OTEL_SERVICE_NAME?.trim() || "zcode-cli-agent";

  if (!endpoint && !headers) {
    if (
      runtimeEnv.CI &&
      (runtimeEnv.CI_COMMIT_TAG || runtimeEnv.CI_COMMIT_BRANCH === "release/current")
    ) {
      throw new Error("Packaged Agent OTLP configuration is required for release builds");
    }
    return {};
  }
  if (!endpoint || !headers) {
    throw new Error(
      "ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT and ZCODE_PACKAGED_AGENT_OTEL_HEADERS must be configured together",
    );
  }
  if (endpoint.length > 2_048) {
    throw new Error("ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT exceeds 2048 characters");
  }
  if (headers.length > 8_192 || /[\r\n]/u.test(headers)) {
    throw new Error("ZCODE_PACKAGED_AGENT_OTEL_HEADERS is invalid");
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(serviceName)) {
    throw new Error("ZCODE_PACKAGED_AGENT_OTEL_SERVICE_NAME is invalid");
  }

  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new Error("ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT must be a valid HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(parsedEndpoint.protocol) ||
    parsedEndpoint.username ||
    parsedEndpoint.password
  ) {
    throw new Error("ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT must be a valid HTTP(S) URL");
  }
  if (
    resolveZCodeEnv(runtimeEnv.ZCODE_ENV) === "production" &&
    parsedEndpoint.protocol !== "https:"
  ) {
    throw new Error("ZCODE_PACKAGED_AGENT_OTEL_ENDPOINT must use HTTPS in production");
  }

  return {
    OTEL_EXPORTER_OTLP_ENDPOINT: parsedEndpoint.toString(),
    OTEL_EXPORTER_OTLP_HEADERS: headers,
    OTEL_SERVICE_NAME: serviceName,
    // Only the Agent baked into a real Desktop installer can be trusted as packaged by the build
    // chain; source/development_bundle is never guessed at runtime and stays unknown unless
    // injected explicitly.
    ZCODE_TELEMETRY_RUNTIME_DISTRIBUTION: "packaged",
  };
}

export function resolveDesktopTsupBundleSecurityOptions(
  runtimeEnv: Record<string, string | undefined> = process.env,
) {
  const isProduction = runtimeEnv.NODE_ENV === "production";
  const isE2ECoverageBuild = runtimeEnv.ZCODE_E2E_COVERAGE === "1";
  return {
    // Released main/host/preload bundles were previously left uncompressed despite NODE_ENV=production,
    // keeping source comments and formatted newlines, which aids reverse engineering and leaks internals.
    keepNames: isProduction && !isE2ECoverageBuild,
    minify: isProduction && !isE2ECoverageBuild,
    // Production packages ship no sourcemaps; a leftover sourceMappingURL would expose invalid mapping paths.
    // E2E coverage builds only run from the isolated app cache and need maps to project V8 bundle ranges
    // back to TypeScript source; normal release builds stay sourcemap-free.
    sourcemap: isE2ECoverageBuild || !isProduction,
  };
}

type DesktopTsupEsbuildOptions = {
  chunkNames?: string;
  legalComments?: "none" | "inline" | "eof" | "linked" | "external";
};

export function applyDesktopTsupEsbuildSecurityOptions(options: DesktopTsupEsbuildOptions) {
  // During production minification esbuild may keep license/legal comments by default;
  // release main/host/preload bundles must not contain source comments or sourcemap entry comments.
  options.legalComments = "none";
}

const desktopTsupBundleSecurityOptions = resolveDesktopTsupBundleSecurityOptions();

function createSharedDefines() {
  return {
    __ZCODE_VERSION__: JSON.stringify(buildMetadata.appVersion),
    __ZCODE_COMMIT__: JSON.stringify(buildMetadata.buildCommitId),
    __ZCODE_BUILD_TIME__: JSON.stringify(buildMetadata.buildTime),
    __ZCODE_ENV__: JSON.stringify(zcodeEnv),
    __ZCODE_PRODUCT_FLAVOR__: JSON.stringify(zcodeProductFlavor),
    ...buildTimeConfigDefines,
    // Computer Use Helper build identity — helperInstaller reads it to pick the Helper bundle to download.
    // When missing, installer throws "Packaged ZCode is missing its embedded Computer Use Helper build identity".
    // CI injects it via the ZCODE_CUA_HELPER_BUILD_ID env var; dev falls back to an empty string (dev helper skips download).
    __ZCODE_CUA_HELPER_BUILD_ID__: JSON.stringify(
      process.env.ZCODE_CUA_HELPER_BUILD_ID?.trim() ?? "",
    ),
    // Bugfix: the remote-runtime CDN root used to be hardcoded in the main bundle, making
    // OSS/CDN switches a code change. It is now injected at build time from CI's
    // CDN_DOMAIN/OSS_PATH_PREFIX; the old default applies when unset.
    __ZCODE_REMOTE_CDN_RELEASE_ROOTS__: JSON.stringify(resolveBuildRemoteCdnReleaseRoots(env)),
  };
}

function createMainDefines() {
  return {
    ...createSharedDefines(),
    // Installed apps cannot inherit GitLab Runner or dev-terminal env. Only the low-privilege
    // connection config provided by CI is compiled into Desktop Main, then delivered through the
    // existing Main -> Host -> Agent trust boundary.
    __ZCODE_PACKAGED_AGENT_TELEMETRY_ENV__: JSON.stringify(
      resolveBuildPackagedAgentTelemetryEnv(process.env),
    ),
  };
}

const desktopNodeRuntimeExternals = [
  "electron",
  "node-pty",
  "ssh2",
  "undici",
  "@larksuiteoapi/node-sdk",
  "yaml",
  // node-forge uses a dynamic require("crypto") internally; inlining it into the ESM main/host bundle makes Electron throw
  // Dynamic require of "crypto" is not supported. Like undici, keep it external at runtime.
  "node-forge",
  // The ZIP unpacker depends on CommonJS require("fs") internally; it cannot be inlined into ESM main/host output.
  "yauzl",
];

function createDevReadyMarkerHook(target: "main" | "host" | "preload"): string {
  // The CLI-level --onSuccess hook fires once per sub-build in multi-config watch mode.
  // Previously the ready marker was written as soon as preload succeeded, so Electron could still start before main/host finished.
  // Each config now writes its own marker on success, letting the dev startup script wait for all builds precisely.
  return `node scripts/write-dev-ready-marker.mjs ${target}`;
}

export default defineConfig([
  {
    name: "main",
    entry: {
      "main/index": "src/main/index.ts",
      "main/browserWebmRecorder": "src/main/browserView/electronBrowserWebmRecorder.ts",
      "main/zcodeDataSizeWorker": "src/main/zcodeDataSizeWorker.ts",
      // Storage tab scan worker in the resource manager: main owns StorageService and offloads scans to a worker thread; resolved via new Worker(new URL()).
      "main/storageScanWorker": "src/main/storageScanWorker.ts",
    },
    outDir: "out",
    format: "esm",
    platform: "node",
    target: "node22",
    // If undici is inlined into the main ESM bundle, it falls back to its internal CommonJS require("assert") at runtime,
    // and Electron reports Dynamic require of "assert" is not supported while loading the main bundle.
    // desktop keeps undici external; the remote single-file bundle inlines it separately.
    external: desktopNodeRuntimeExternals,
    noExternal: [
      "@zcode/server",
      "@zcode/shared",
      "@zcode/rpc",
      "@zcode/services",
      "@zcode/client",
      // Provider Refactor workspace packages export TypeScript source; the Electron production runtime has
      // no TS loader, so they must be inlined into the desktop bundle instead of leaving bare references to src/index.ts.
      "@zcode/provider",
      "@zcode/provider-node",
      // services is inlined into main, but its producer import used to remain a bare package reference;
      // electron-builder also excludes node_modules/@zcode, causing ERR_MODULE_NOT_FOUND at installer startup.
      // The producer JS broker must be inlined along with services; native addons stay in the separate Helper.
      "@zcode/zcode-cua",
    ],
    define: createMainDefines(),
    // Fix: when main and host watch concurrently over the shared out root, default chunk names
    // overwrite each other,
    // possibly pointing main imports at a chunk host just rewrote and causing sporadic "missing named export" startup errors.
    // Chunk output is split per target directory to isolate artifacts under concurrent builds.
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
      options.chunkNames = "main/chunk-[hash]";
    },
    onSuccess: createDevReadyMarkerHook("main"),
    ...desktopTsupBundleSecurityOptions,
  },
  {
    name: "preload",
    entry: {
      "preload/embeddedBrowserJavaScriptDialog": "src/preload/embeddedBrowserJavaScriptDialog.ts",
      "preload/codingPlanWebview": "src/preload/codingPlanWebview.ts",
      "preload/rewardsWebview": "src/preload/rewardsWebview.ts",
      "preload/browserVideoRecorder": "src/preload/browserVideoRecorder.ts",
      "preload/index": "src/preload/index.ts",
      "preload/resourceManager": "src/preload/resourceManager.ts",
      "preload/cuaPermissionPanel": "src/preload/cuaPermissionPanel.ts",
      "preload/pluginSandbox": "src/preload/pluginSandbox/index.ts",
    },
    outDir: "out",
    format: "cjs",
    platform: "node",
    target: "node22",
    external: ["electron"],
    noExternal: ["@zcode/shared"],
    outExtension: () => ({ js: ".cjs" }),
    define: createSharedDefines(),
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
    },
    onSuccess: createDevReadyMarkerHook("preload"),
    ...desktopTsupBundleSecurityOptions,
  },
  {
    // The in-iframe window.zcode / window.openai alias script (thin wrapper over the official
    // ext-apps `App`): IIFE, browser platform, served same-origin by the zcode-sandbox:// handler.
    name: "plugin-sandbox-alias",
    loader: { ".css": "text" },
    entry: {
      "plugin-sandbox-alias": "src/renderer/src/plugin-sandbox/alias.ts",
      "gen-ui": "src/renderer/src/plugin-sandbox/genUi.ts",
    },
    // It cannot live in out/renderer: the vite renderer build's emptyOutDir wipes the
    // earlier-written alias script.
    outDir: "out/plugin-sandbox",
    onSuccess: () => copyGenUiRuntimeAssets(resolve("out/plugin-sandbox")),
    format: "iife",
    platform: "browser",
    target: "es2022",
    // Sandbox pages have no node_modules: the SDK (ext-apps/client/core/zod) must be fully
    // inlined into the IIFE.
    noExternal: [/.*/],
    outExtension: () => ({ js: ".js" }),
    define: createSharedDefines(),
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
    },
    ...desktopTsupBundleSecurityOptions,
  },
  {
    name: "host",
    entry: {
      "host/index": "src/host/index.ts",
      "host/tasksStorageWorker": "src/host/tasksStorageWorker.ts",
    },
    outDir: "out",
    format: "esm",
    platform: "node",
    target: "node22",
    // host shares the same services graph as main; inlining undici would trigger the same dynamic require crash in the Electron ESM runtime.
    // Keep it external here too so the desktop host process starts in both dev and packaged modes.
    external: desktopNodeRuntimeExternals,
    noExternal: [
      "@zcode/server",
      "@zcode/shared",
      "@zcode/rpc",
      "@zcode/services",
      "@zcode/client",
      "@zcode/provider",
      "@zcode/provider-node",
      "@zcode/zcode-cua",
    ],
    define: createSharedDefines(),
    // Same chunk isolation policy as main, preventing host/main artifacts from overwriting each other.
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
      options.chunkNames = "host/chunk-[hash]";
    },
    onSuccess: createDevReadyMarkerHook("host"),
    ...desktopTsupBundleSecurityOptions,
  },
  {
    name: "scheduler",
    entry: { "scheduler/index": "src/scheduler/index.ts" },
    outDir: "out",
    format: "esm",
    platform: "node",
    target: "node22",
    // Mirrors host: the resident cron scheduler process reuses @zcode/services (tasks-index + cron),
    // likewise keeping undici etc. external to avoid dynamic require crashes in the Electron ESM runtime.
    external: desktopNodeRuntimeExternals,
    noExternal: [
      "@zcode/server",
      "@zcode/shared",
      "@zcode/rpc",
      "@zcode/services",
      "@zcode/client",
      "@zcode/provider",
      "@zcode/provider-node",
      "@zcode/zcode-cua",
    ],
    define: createSharedDefines(),
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
      options.chunkNames = "scheduler/chunk-[hash]";
    },
    onSuccess: createDevReadyMarkerHook("scheduler"),
    ...desktopTsupBundleSecurityOptions,
  },
]);
