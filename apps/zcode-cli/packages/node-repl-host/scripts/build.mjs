import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const packageRoot = resolve(import.meta.dirname, "..");

// Same fix as browser-use-plugin/scripts/build.mjs: in esbuild's ESM output the __require
// shim has no require in ESM scope, so CJS deps dragged in by @zcode/core (yaml -> require("process"))
// throw during **module evaluation**, the plugin host's await import() fails outright, and the result is
// 0 registered tools with mcp__node_repl__js invisible to the model. Inject a real createRequire.
const nodeRequireBanner = `import { createRequire as __zcodeCreateRequire } from "node:module";
const require = __zcodeCreateRequire(import.meta.url);`;

// Computer Use used to be entirely broken in production builds: every CUA call either waited for the
// MCP client timeout (measured 60/110/120s) or returned after ~64s with
// 「permission broker socket is not accepting connections yet」。
//
// Chain: lazy start (see the lazy-start comment in services/src/node.ts) moved Helper install/launch on
// darwin from the host to "self-launch on first SDK CUA call", and that path lives in **this package**,
// so `helperInstaller` ships inside this bundle in production. But `__ZCODE_CUA_HELPER_BUILD_ID__` was
// previously injected **only** by packages/desktop/tsup.config.ts (Electron main / app.asar); the esbuild
// call in this file had no define at all. So in production the producer's `ZCODE_CUA_HELPER_BUILD_ID`
// folded to an empty string (see the fallback in zcode-cua/src/broker/shared/cua-version.ts),
// `resolveExpectedCuaHelperBuildId()` returned null, and helperInstaller hit the fail-closed guard:
//
//   "Packaged ZCode is missing its embedded Computer Use Helper build identity;
//    refusing an unpinned Helper install"
//
// Result: the Helper was neither installed nor started, without a single log line, and the MCP layer
// turned that throw into a timeout with no landing point -- invisible by construction. Evidence:
// `[cua-product-helper]` had 5 host-log lines on 09-11 (host path, define present) and 0 on 09-14;
// `~/.zcode/computer-use/logs/` was never created; renaming the installed Helper did not trigger a
// reinstall. Dev was unaffected (ALLOW_UNSIGNED_LOCAL + non-production runtime bypass the guard), so only production broke -- untestable locally.
//
// Keep the value sourced exactly like desktop: CI injects ZCODE_CUA_HELPER_BUILD_ID; dev leaves it empty
// and takes the fallback (the dev Helper skips download/pin checks). See the same-named define in packages/desktop/tsup.config.ts.
const resolveCuaHelperBuildId = (env = process.env) => env.ZCODE_CUA_HELPER_BUILD_ID?.trim() ?? "";

export const buildNodeReplHostBundle = async ({
  outfile = resolve(packageRoot, "dist", "mcp", "server.js"),
  cuaHelperBuildId = resolveCuaHelperBuildId(),
} = {}) => {
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    banner: { js: nodeRequireBanner },
    bundle: true,
    define: {
      __ZCODE_CUA_HELPER_BUILD_ID__: JSON.stringify(cuaHelperBuildId),
    },
    entryPoints: [resolve(packageRoot, "src", "server.ts")],
    format: "esm",
    legalComments: "none",
    outfile,
    platform: "node",
    target: "node24",
  });
  // Build-time guard: if the define name drifts (renamed, or swallowed by a createSharedDefines-style
  // refactor), the bundle silently falls back to an empty string and the symptom only shows in production
  // as timeouts. Fail here instead of letting it reach users.
  if (cuaHelperBuildId) {
    const bundled = await readFile(outfile, "utf8");
    if (!bundled.includes(cuaHelperBuildId)) {
      throw new Error(
        `[node-repl-host] ZCODE_CUA_HELPER_BUILD_ID=${cuaHelperBuildId} was not folded into ${outfile}: ` +
          "__ZCODE_CUA_HELPER_BUILD_ID__ define had no effect; production Helper installs would be rejected fail-closed.",
      );
    }
  }
  return { outfile, cuaHelperBuildId };
};

// This used to be written as `file://${process.argv[1]}`.
// On Windows argv[1] is `C:\\...\\build.mjs` while import.meta.url is `file:///C:/.../build.mjs`;
// the two never compare equal, so the script was treated as a plain import and exited with no artifact,
// and the build "succeeded" silently until the dev guard reported
// "build succeeded without required MCP runtime". The browser-use sibling and every other repo entry
// use pathToFileURL; this one was missed during the package split.
const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  const { outfile } = await buildNodeReplHostBundle();
  console.log(`[node-repl-host] ${outfile}`);
}
