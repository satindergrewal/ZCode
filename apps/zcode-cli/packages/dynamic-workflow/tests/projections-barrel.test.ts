import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// @zcode/dynamic-workflow/projections is the pure-projection barrel for the portfolio browser bundle
// (docs/chat/workflow-portfolio.md): the site recomputes projections over frozen core.json, so the chain
// must not drag typescript (the compiler used only to mint the core) into the frontend bundle. Rather than
// trusting bundler errors, walk dist/projections.js's ESM import closure statically (tsc erases type-only
// imports, so every remaining from-quote in dist is a runtime dep) and assert no reachable file imports the
// bare specifier typescript. Any change wiring a projection module to a compiler-toting module such as
// causality-order.ts explodes here first, leaking file list included.
//
// Depends on dist: turbo's test task dependsOn build; run pnpm run build before a bare pnpm test in this
// package dir, or this inspects the previous build's output.
const distDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const ENTRY = join(distDir, "projections.js");

/** Specifier of every static import or re-export (export-from included); side-effect imports too. */
const SPECIFIER =
  /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

function specifiersOf(file: string): string[] {
  const source = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const match of source.matchAll(SPECIFIER)) out.push((match[1] ?? match[2]) as string);
  return out;
}

/** Reachable dist files keyed by importer, with their bare (non-relative) specifiers. */
function walk(entry: string): { files: string[]; bare: Map<string, string[]> } {
  const files: string[] = [];
  const bare = new Map<string, string[]>();
  const queue = [entry];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);
    for (const spec of specifiersOf(file)) {
      if (spec.startsWith(".") || spec.startsWith("/")) {
        queue.push(resolve(dirname(file), spec));
      } else {
        const list = bare.get(spec) ?? [];
        list.push(file);
        bare.set(spec, list);
      }
    }
  }
  return { bare, files };
}

describe("projections barrel is browser-safe", () => {
  it("dist/projections.js exists (run `pnpm run build` first)", () => {
    expect(existsSync(ENTRY)).toBe(true);
  });

  it("no reachable dist file imports typescript (or any other bare specifier)", () => {
    const { bare, files } = walk(ENTRY);
    // The barrel itself plus its re-exported projections -- the closure must not collapse to the entry alone.
    expect(files.length).toBeGreaterThan(5);
    const leaks = [...bare.entries()].map(
      ([spec, importers]) => `${spec} <- ${importers.join(", ")}`,
    );
    expect(leaks, "bare imports reachable from the browser barrel").toEqual([]);
    expect(bare.has("typescript")).toBe(false);
    // Cross-check: the same walk over the root export must reach typescript, else the walk itself is broken.
    expect(walk(join(distDir, "index.js")).bare.has("typescript")).toBe(true);
  });

  it("does not reach the analyzer front-end modules", () => {
    const { files } = walk(ENTRY);
    const names = files.map((file) => file.slice(distDir.length + 1));
    for (const forbidden of [
      "analysis/causality-order.js",
      "analysis/analyze.js",
      "compiler/compile.js",
      "analysis/domain.js",
    ]) {
      expect(names, `${forbidden} must not be reachable`).not.toContain(forbidden);
    }
  });
});
