import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const MAX_BROWSER_CLIENT_BUNDLE_BYTES = 150_000;

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

describe("browser-client bundle boundary", () => {
  it("bundles only the Browser runtime, with no Agent Core pulled in", async () => {
    const result = await build({
      absWorkingDir: packageRoot,
      bundle: true,
      entryPoints: ["src/browser-client.ts"],
      format: "esm",
      legalComments: "none",
      metafile: true,
      platform: "node",
      target: "node24",
      write: false,
    });
    const output = result.outputFiles[0];
    expect(output).toBeDefined();
    expect(output!.contents.byteLength).toBeLessThanOrEqual(MAX_BROWSER_CLIENT_BUNDLE_BYTES);

    const inputs = Object.keys(result.metafile.inputs).map(normalizePath);
    const coreInputs = inputs.filter((path) => /(?:^|\/)core\/dist\//u.test(path));
    expect(coreInputs.length).toBeGreaterThan(0);
    expect(coreInputs.every((path) => /(?:^|\/)core\/dist\/browser-client\//u.test(path))).toBe(
      true,
    );

    const contractInputs = inputs.filter((path) => /(?:^|\/)contracts\/dist\//u.test(path));
    expect(contractInputs).toEqual([
      expect.stringMatching(/contracts\/dist\/interfaces\/browser-control\.port\.js$/u),
    ]);

    // Root cause: top-level registration in the root barrel has side effects, so tree-shaking
    // cannot drop those business modules.
    expect(inputs).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/(?:^|\/)core\/dist\/(?:agent|runtime|subagent|tool|workflow)\//u),
      ]),
    );
  });
});
