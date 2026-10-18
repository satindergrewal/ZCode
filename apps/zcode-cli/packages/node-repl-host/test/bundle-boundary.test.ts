import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

// This dependency-boundary guard used to live in browser-use-plugin/test/bundle-boundary.test.ts (entry:
// browser-use src/mcp/server.ts). Once the node_repl host became this package, the entry moved and the guard had to
// move with it: left behind, it would point at the deleted src/mcp/, while this package is what the plugin host actually imports.
// Relative depth is unchanged (both packages live under apps/zcode-cli/packages/*), so the ../contracts and
// ../../../../packages/shared prefixes below remain valid as-is.
describe("node_repl MCP bundle boundary", () => {
  it("depends only on the core REPL engine, with no agents, tools, or workflow compiler", async () => {
    const result = await build({
      absWorkingDir: packageRoot,
      bundle: true,
      entryPoints: ["src/server.ts"],
      format: "esm",
      legalComments: "none",
      metafile: true,
      platform: "node",
      target: "node24",
      write: false,
    });
    const inputs = Object.keys(result.metafile.inputs).map((path) =>
      normalizePath(resolve(packageRoot, path)),
    );
    const coreRoot = `${normalizePath(resolve(packageRoot, "../core/dist"))}/`;
    const coreInputs = inputs.filter((path) => path.startsWith(coreRoot));
    expect(coreInputs.length).toBeGreaterThan(0);
    // Root cause: importing NodeReplSession from the root barrel pulls the whole business graph in via top-level side effects.
    // The check pins the dependency boundary, not a byte size, so the REPL may add implementation files freely.
    expect(coreInputs.find((path) => !path.startsWith(`${coreRoot}repl/`))).toBeUndefined();
    expect(
      inputs.find((path) => /(?:^|\/)(?:dynamic-workflow|typescript)\//u.test(path)),
    ).toBeUndefined();

    const contractRoot = `${normalizePath(resolve(packageRoot, "../contracts/dist"))}/`;
    const contractInputs = inputs
      .filter((path) => path.startsWith(contractRoot))
      .map((path) => path.slice(contractRoot.length));
    expect(contractInputs.sort()).toEqual([
      "interfaces/mcp.port.js",
      "tools/json-schema.js",
      "tools/node-repl.js",
    ]);

    const sharedRoot = `${normalizePath(resolve(packageRoot, "../../../../packages/shared/src"))}/`;
    const sharedInputs = inputs.filter((path) => path.startsWith(sharedRoot));
    expect(sharedInputs.length).toBeGreaterThan(0);
    // Even a constant-only import from the root entry initializes other domains' schemas; each Worker would pay that cost again.
    expect(
      sharedInputs.find((path) => !path.startsWith(`${sharedRoot}browser-use/`)),
    ).toBeUndefined();
  });
});
