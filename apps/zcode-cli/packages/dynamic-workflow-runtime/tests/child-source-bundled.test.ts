/**
 * renderChildEntry still renders a runnable self-contained entry file after esbuild bundling/minification.
 *
 * Why this test exists: the entry's child logic is assembled from childMain.toString(), and real release artifacts
 * bundle it first (the CLI is a single-file bundle) and the desktop-agent build minifies. Any module-scope
 * reference in childMain (constant, helper, import) gets renamed or relocated by the bundle, turning the embedded
 * text into a program citing undefined identifiers -- broken only in release artifacts,
 * with source tests green. So this tests the bundled form, and not merely --check syntax: it spawns once and runs to complete,
 * since a syntactically valid broken program (say, missing bootstrap) passes a syntax check.
 *
 * esbuild resolves from the workspace root (a dependency of apps/zcode-cli/package.json, the same one
 * the CLI's scripts/build.mjs uses).
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import type { renderChildEntry as renderChildEntryType } from "../src/child-source.js";

const ENTRY = new URL("../src/child-source.ts", import.meta.url);

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Bundles child-source.ts and extracts the bundled renderChildEntry (not the source-form one). */
async function bundledRenderChildEntry(minify: boolean): Promise<typeof renderChildEntryType> {
  const root = await tempRoot("dwf-child-bundle-");
  const outfile = join(root, "child-source.mjs");
  await build({
    bundle: true,
    entryPoints: [new URL(ENTRY).pathname],
    format: "esm",
    // Same options as the CLI release build: desktop-agent is minify+keepNames; plain/SEA builds do not minify.
    keepNames: minify,
    minify,
    outfile,
    platform: "node",
    target: "node22",
  });
  const module = (await import(pathToFileURL(outfile).href)) as {
    renderChildEntry: typeof renderChildEntryType;
  };
  return module.renderChildEntry;
}

/** Writes the entry per harness defaults, runs the child for real, and returns the NDJSON lines it writes back. */
async function runChild(
  render: typeof renderChildEntryType,
  payload: { lowered: string; args?: Record<string, unknown> },
): Promise<unknown[]> {
  const root = await tempRoot("dwf-child-entry-");
  const entryPath = join(root, "run.mjs");
  await writeFile(
    entryPath,
    render({ ...payload, maxOldSpaceSizeMb: 256 }, { runId: "run" }),
    "utf8",
  );
  const result = spawnSync(process.execPath, ["--max-old-space-size=256", entryPath], {
    encoding: "utf8",
    input: "",
    timeout: 30_000,
  });
  // The child's stderr is this test's only attribution surface -- ReferenceErrors surface here.
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

describe.each([
  { label: "bundled", minify: false },
  { label: "bundled + minified", minify: true },
])("renderChildEntry ($label)", ({ minify }) => {
  it("runs the sandbox to completion", async () => {
    const render = await bundledRenderChildEntry(minify);

    const lines = await runChild(render, {
      lowered: '__host.log("from the sandbox");\nreturn { ok: 42 };',
    });

    expect(lines).toEqual([
      { kind: "event", type: "log", message: "from the sandbox" },
      { kind: "complete", ok: true, value: { ok: 42 } },
    ]);
  });

  it("keeps the sandbox bans and the curated realm intact", async () => {
    const render = await bundledRenderChildEntry(minify);

    // If bundling dropped the bootstrap, the script would get a bare context with no bans -- and this would return ok:true.
    const lines = await runChild(render, {
      lowered: [
        "let bans = [];",
        'try { Date.now(); } catch (e) { bans.push("Date.now"); }',
        'try { Math.random(); } catch (e) { bans.push("Math.random"); }',
        'return { bans, hasProcess: typeof process !== "undefined", hostKeys: Object.keys(__host).sort() };',
      ].join("\n"),
    });

    expect(lines).toEqual([
      {
        kind: "complete",
        ok: true,
        value: {
          bans: ["Date.now", "Math.random"],
          hasProcess: false,
          // Every Boundary A member. The two artifact families separate here: publishArtifact is an effect
          // (request/response) while declareArtifact is a declaration (event channel).
          hostKeys: [
            "args",
            "ask",
            "channel",
            "createActor",
            "declareArtifact",
            "enterPhase",
            "future",
            "hole",
            "log",
            "publishArtifact",
            "report",
            "worldRead",
          ],
        },
      },
    ]);
  });
});
