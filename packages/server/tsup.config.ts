import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "tsup";
// The tsup config itself gets bundled; the build must keep the original file
// location, so it cannot be inlined and relocated.
const { loadBuiltinProviderConfig } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/builtin-provider-config.mjs")).href
);
const { stageThirdPartyNotices } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/third-party-notices.mjs")).href
);

// The tsup config may load from any cwd; resolve the repo-root package.json
// relative to the config file's own directory.
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
  // node-forge uses a dynamic require("crypto") internally; once inlined into the
  // server ESM bundle Node raises Dynamic require of "crypto" is not supported.
  // Keep the same externalization policy as the desktop main/host builds.
  "node-forge",
  "yaml",
  // services pulls in the CJS package yazl for feedback-log compression; inlined
  // into the ESM bundle it hits a dynamic require("fs") at runtime and crashes
  // entry-http at startup. Keep it external for Node's native loader.
  "yazl",
  // The cloud-content ZIP unpacking path pulls in yauzl, whose CommonJS
  // require("fs") crashes when loaded from an ESM bundle; like desktop, keep it
  // external for Node's native loader.
  "yauzl",
];

export default defineConfig({
  onSuccess: async () => {
    await stageThirdPartyNotices(resolve(import.meta.dirname, "dist"));
  },
  entry: { "entry-http": "src/entry-http.ts" },
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node22",
  // Workspace package exports point at .ts sources, which node cannot load
  // directly at runtime; they must be bundled in.
  noExternal: [
    "@zcode/shared",
    "@zcode/rpc",
    "@zcode/services",
    "@zcode/services/node",
    "@zcode/client",
  ],
  // ssh2 / node-pty ship .node native addons that esbuild cannot process.
  // CJS deps such as undici / axios, once inlined into the ESM bundle, hit
  // dynamic requires (require("assert") / require("util") / require("url")) that
  // fail under Node's ESM wrapper with Dynamic require not supported.
  // Keep them external for the HTTP server and let Node load them natively; the
  // remote single-file bundle is still inlined by build-remote.ts.
  external: SERVER_HTTP_EXTERNAL_DEPENDENCIES,
  define: createSharedDefines(),
  // esbuild does not know the es2025 target in tsconfig.json; the dedicated
  // tsconfig.build.json silences that warning.
  tsconfig: "tsconfig.build.json",
});
