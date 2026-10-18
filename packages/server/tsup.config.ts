import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "tsup";
// The tsup config itself gets bundled; the build must keep it at its original location instead of relocating it after inlining.
const { loadBuiltinProviderConfig } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/builtin-provider-config.mjs")).href
);
const { stageThirdPartyNotices } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/third-party-notices.mjs")).href
);

// The tsup config may load from any cwd; resolve the repo root package.json relative to the config file's own directory.
const rootPackageJsonPath = resolve(import.meta.dirname, "../../package.json");
const { version } = JSON.parse(readFileSync(rootPackageJsonPath, "utf-8"));

const { environment: zcodeEnv, content: zcodeBuiltinProviderConfigJson } =
  await loadBuiltinProviderConfig();

export const SERVER_HTTP_DEFINES = {
  __ZCODE_VERSION__: JSON.stringify(version),
  __ZCODE_ENV__: JSON.stringify(zcodeEnv),
  __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: JSON.stringify(zcodeBuiltinProviderConfigJson),
};

function createSharedDefines() {
  return SERVER_HTTP_DEFINES;
}

export const SERVER_HTTP_EXTERNAL_DEPENDENCIES = [
  "ssh2",
  "node-pty",
  "undici",
  "axios",
  "form-data",
  "combined-stream",
  "proxy-from-env",
  "follow-redirects",
  "yazl",
  // Bugfix: node-forge internally uses a dynamic require("crypto"); once inlined into the server ESM bundle Node reports
  // Dynamic require of "crypto" is not supported; keep the same externalization policy as the desktop main/host builds.
  "node-forge",
  "yaml",
  // The services feedback-log compression path pulls in the CJS package yazl; once inlined into the ESM bundle it
  // hits a runtime require("fs") dynamic require and crashes entry-http at startup; keep it external for Node to load natively.
  "yazl",
  // Bugfix: node-forge (the appCaCert self-signed CA path) internally uses a dynamic require("crypto"),
  // matching the desktop tsup.config handling; it must stay external for Node to load natively.
  "node-forge",
  // Fix: the cloud-content ZIP unpacking path (services/cloud-content) pulls in the CJS package yauzl; inlined into the ESM bundle,
  // entry-http.js fails at load with Dynamic require of "fs" is not supported; as on desktop, keep it external for Node to load natively.
  "yauzl",
];

export default defineConfig({
  // The HTTP server artifact externalizes deps and inlines third-party code, so full notices must ship next to dist (web/unified packages copy dist verbatim).
  onSuccess: async () => {
    await stageThirdPartyNotices(resolve(import.meta.dirname, "dist"));
  },
  entry: { "entry-http": "src/entry-http.ts" },
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node22",
  // Workspace package exports point at .ts sources that the Node runtime cannot load directly; they must be bundled in.
  noExternal: [
    "@zcode/shared",
    "@zcode/rpc",
    "@zcode/services",
    "@zcode/services/node",
    "@zcode/client",
  ],
  // ssh2 / node-pty ship .node native addons that esbuild cannot process.
  // CJS dependencies such as undici / axios, once inlined into the ESM bundle, hit runtime
  // dynamic requires like require("assert") / require("util") / require("url"), which fail outright under Node's ESM wrapper with Dynamic require not supported.
  // Keep them external for the HTTP server so Node loads them natively; the remote single-file bundle still inlines them via build-remote.ts.
  external: SERVER_HTTP_EXTERNAL_DEPENDENCIES,
  define: createSharedDefines(),
  // esbuild does not know the es2025 target in tsconfig.json; use a dedicated tsconfig.build.json to silence the warning.
  tsconfig: "tsconfig.build.json",
});
