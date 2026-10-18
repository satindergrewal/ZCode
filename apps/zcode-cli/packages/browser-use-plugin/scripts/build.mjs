import { chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const defaultPackageRoot = resolve(import.meta.dirname, "..");
const executableFileMode = 0o755;

// When esbuild bundles with format: "esm", it rewrites require() inside CJS deps into a __require shim:
//   typeof require !== "undefined" ? require : (name) => { throw Error('Dynamic require of "' + name + '" is not supported') }
// ESM module scope has no require, so the shim always takes the throw branch.
// @zcode/core eager-imports the CJS yaml via tool/handlers/write.js -> memory/origin-session.js, and yaml's
// internal require("process") hits the shim, so dist/mcp/server.js throws `Dynamic require of "process" is not
// supported` during **module evaluation**; the plugin host's await import() fails outright, showing up as
// mcp.server.closed / mcp.server.failed with 0 tools registered -- the model never sees mcp__node_repl__js.
// Inject a real createRequire so the shim lands on a working require (output stays ESM). Apply it to both
// bundles: browser-client has no CJS deps today, but it is also ESM output and would blow up the same way
// at load time once pulled in by a CJS dependency.
const nodeRequireBanner = `import { createRequire as __zcodeCreateRequire } from "node:module";
const require = __zcodeCreateRequire(import.meta.url);`;

const createBundleOptions = ({ entryPoint, outfile }) => ({
  banner: {
    js: nodeRequireBanner,
  },
  bundle: true,
  entryPoints: [entryPoint],
  format: "esm",
  legalComments: "none",
  outfile,
  platform: "node",
  target: "node24",
});

/**
 * Reusable build entry for direct script runs and smoke tests, so tests validate the same esbuild options as the release artifacts.
 */
export const buildBrowserUsePluginBundles = async ({
  packageRoot = defaultPackageRoot,
  browserClientOutfile = resolve(packageRoot, "scripts", "browser-client.mjs"),
} = {}) => {
  // The node_repl host bundle is built and shipped by @zcode/node-repl-host; this package only emits browser-client.
  await mkdir(dirname(browserClientOutfile), { recursive: true });
  await build(
    createBundleOptions({
      entryPoint: resolve(packageRoot, "src", "browser-client.ts"),
      outfile: browserClientOutfile,
    }),
  );
  await chmod(browserClientOutfile, executableFileMode);
  return { browserClientOutfile };
};

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  await buildBrowserUsePluginBundles();
}
