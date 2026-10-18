import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOST_BINDING, lowerWorkflowScript } from "../src/lowering/index.js";

// Lowering snapshots plus semantic assertions. The snapshot is the contract: human-readable lowered JS in
// expected/<base>.js. Assertions go beyond it: site ids exactly once, types fully erased (proven by parsing the
// output as JS), facade-less scripts lowering to plain JS, and determinism (two passes byte-identical).
const here = dirname(fileURLToPath(import.meta.url));
const loweringDir = join(here, "lowering");
const graphsDir = join(here, "graphs");

// The AsyncFunction constructor: parsing the output as JS proves no TS syntax survives
// (top-level await/return are both legal in an async function body).
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => unknown;

/** Invariants every lowered body must satisfy. */
function assertLowered(source: string): { code: string; siteIds: string[] } {
  const result = lowerWorkflowScript(source);
  expect(result.diagnostics).toEqual([]);
  expect(result.ok).toBe(true);
  const lowered = result.lowered;
  if (lowered === undefined) throw new Error("expected lowered output for a clean script");
  return lowered;
}

/** site id -> the __host.* call prefix it must stub to (quote-free, agnostic to quoting style). */
function hostCallFor(siteId: string): string {
  // Sites inside hole bodies carry the hole#N/ prefix (docs/analysis.md, Sites): classify by the last segment.
  const kindStart = siteId.lastIndexOf("/") + 1;
  if (kindStart > 0) return hostCallFor(siteId.slice(kindStart));
  if (siteId.startsWith("ask#")) return "__host.ask(";
  if (siteId.startsWith("actor#")) return "__host.createActor(";
  if (siteId.startsWith("world-read#")) return "__host.worldRead(";
  if (siteId.startsWith("report#")) return "__host.report(";
  if (siteId.startsWith("hole#")) return "__host.hole(";
  throw new Error(`unexpected site id kind: ${siteId}`);
}

const SNAPSHOT_FIXTURES: { base: string; dir: string }[] = [
  { base: "log-only", dir: loweringDir },
  { base: "no-facade", dir: loweringDir },
  { base: "chained-inline-ask", dir: loweringDir },
  { base: "helper-asks", dir: loweringDir },
  { base: "files-read-glob", dir: loweringDir },
  { base: "git-and-grep", dir: loweringDir },
  { base: "report-and-log", dir: loweringDir },
  { base: "phase-markers", dir: loweringDir },
  { base: "channel-future", dir: loweringDir },
  { base: "holes", dir: loweringDir },
  // Reuses three graph fixtures: planner-reviewer covers log/ask/for-loops/Promise.all,
  { base: "planner-reviewer", dir: graphsDir },
  { base: "glob-fanout", dir: graphsDir },
  { base: "user-defined-ask", dir: graphsDir },
];

describe("lowering snapshots", () => {
  for (const { base, dir } of SNAPSHOT_FIXTURES) {
    it(base, async () => {
      const source = readFileSync(join(dir, `${base}.ts`), "utf8");
      const { code } = assertLowered(source);
      await expect(code).toMatchFileSnapshot(join(loweringDir, "expected", `${base}.js`));
    });
  }
});

// Breadth assertions: every graph and lowering fixture, each invariant checked one by one.
const semanticFixtures = [
  ...readdirSync(loweringDir)
    .filter((n) => n.endsWith(".ts"))
    .map((n) => ({ dir: loweringDir, name: n })),
  ...readdirSync(graphsDir)
    .filter((n) => n.endsWith(".ts"))
    .map((n) => ({ dir: graphsDir, name: n })),
].sort((a, b) => a.name.localeCompare(b.name));

describe("lowering semantics", () => {
  it("finds fixtures", () => {
    expect(semanticFixtures.length).toBeGreaterThan(0);
  });

  for (const { dir, name } of semanticFixtures) {
    it(`${name}: every site id appears exactly once in the right __host.* call`, () => {
      const source = readFileSync(join(dir, name), "utf8");
      const { code, siteIds } = assertLowered(source);
      // siteIds dedup equals the original list (every site unique).
      expect(new Set(siteIds).size).toBe(siteIds.length);
      for (const id of siteIds) {
        const quoted = new RegExp(`["']${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`, "g");
        const hits = code.match(quoted) ?? [];
        expect(hits.length, `site id ${id} must appear exactly once`).toBe(1);
        expect(code, `site id ${id} must sit in ${hostCallFor(id)}`).toContain(
          `${hostCallFor(id)}"${id}"`,
        );
      }
    });

    it(`${name}: lowers to type-stripped JS (parses as JS, no facade globals)`, () => {
      const source = readFileSync(join(dir, name), "utf8");
      const { code } = assertLowered(source);
      // Parsing output as JS: TS syntax (interfaces, annotations, <T> args) would throw in AsyncFunction.
      expect(() => new AsyncFunction(HOST_BINDING, code)).not.toThrow();
      expect(code).not.toContain("interface ");
      expect(code).not.toContain("__host.ask<");
      // No facade global may survive as a free identifier -- all rewritten to __host.* (phase to enterPhase).
      expect(code).not.toMatch(/(^|[^.\w])files\.(glob|read|grep)\s*\(/);
      expect(code).not.toMatch(/(^|[^.\w])git\.(changedFiles|diff|status|log)\s*\(/);
      expect(code).not.toMatch(/(^|[^.\w])phase\s*\(/);
      // channel/future rewrite to __host.* too (docs/dynamic-workflow/authoring.md, Streams).
      expect(code).not.toMatch(/(^|[^.\w])(channel|future)\s*\(/);
      // holes rewrite to __host.hole (docs/dynamic-workflow/authoring.md, Holes).
      expect(code).not.toMatch(/(^|[^.\w])hole\s*[(<]/);
    });

    it(`${name}: is deterministic (lowering twice yields identical bytes)`, () => {
      const source = readFileSync(join(dir, name), "utf8");
      const a = assertLowered(source);
      const b = assertLowered(source);
      expect(a.code).toBe(b.code);
      expect(a.siteIds).toEqual(b.siteIds);
    });
  }
});

describe("lowering edge cases", () => {
  it("packs world-read arguments positionally into an array literal", () => {
    // Boundary A's worldRead(siteId, op, args): args land in an array literal, positional, uninterpreted
    // (the spec lowering-never-switches-on-op). That is the add-a-primitive-with-zero-lowering-changes
    // contract -- multi-arg ops like files.grep/git.diff ride the very same path.
    const source = readFileSync(join(loweringDir, "files-read-glob.ts"), "utf8");
    const { code } = assertLowered(source);
    expect(code).toContain(`__host.worldRead("world-read#1", "glob", ["src/**/*.ts"])`);
    expect(code).toContain(`__host.worldRead("world-read#2", "read", [first])`);
  });

  it("packs multi-argument and optional world-read arguments positionally", () => {
    // A missing optional is a shorter array, not an undefined hole: inputHash({op, args}) is the journal key and
    const source = readFileSync(join(loweringDir, "git-and-grep.ts"), "utf8");
    const { code } = assertLowered(source);
    expect(code).toContain(`__host.worldRead("world-read#1", "grep", ["TODO"])`);
    expect(code).toContain(`__host.worldRead("world-read#2", "grep", ["TODO", "*.ts"])`);
    expect(code).toContain(`__host.worldRead("world-read#3", "git-changed-files", [])`);
    expect(code).toContain(`__host.worldRead("world-read#4", "git-changed-files", ["main"])`);
    expect(code).toContain(`__host.worldRead("world-read#5", "git-diff", [])`);
    expect(code).toContain(`__host.worldRead("world-read#6", "git-diff", ["main", "src/a.ts"])`);
    expect(code).toContain(`__host.worldRead("world-read#7", "git-status", [])`);
    expect(code).toContain(`__host.worldRead("world-read#8", "git-log", [])`);
    expect(code).toContain(`__host.worldRead("world-read#9", "git-log", [5])`);
  });

  it("lowers report(item) to __host.report(siteId, item) and log to __host.log", () => {
    // The report/log divide is the easiest to get wrong: both are container-less top-level facade functions,
    const { code, siteIds } = assertLowered(
      `log("start");\nreport({ a: 1 });\nreport("plain");\nlog("done");\nreturn 1;\n`,
    );
    expect(siteIds).toEqual(["report#1", "report#2"]);
    expect(code).toContain(`__host.report("report#1", { a: 1 })`);
    expect(code).toContain(`__host.report("report#2", "plain")`);
    expect(code).toContain(`__host.log("start")`);
    expect(code).toContain(`__host.log("done")`);
    // Converse: log must never be minted as a report site.
    expect(code).not.toContain(`"report#3"`);
  });

  it("interleaves report site ids into the global discovery order", () => {
    // siteIds sort by the global order (the serialized merge key) while per-kind counters run independently:
    const { siteIds } = assertLowered(
      `const a = agent("a");\nreport("before");\nconst x = await a.ask<string>("1");\nreport(x);\nconst y = await a.ask<string>("2");\nreturn x + y;\n`,
    );
    expect(siteIds).toEqual(["actor#1", "report#1", "ask#1", "report#2", "ask#2"]);
  });

  it("routes git.log to a world read and the top-level log to __host.log", () => {
    // Both same-name sides land correctly in one lowered output -- the executable proof of container-keyed
    const { code, siteIds } = assertLowered(
      `log("start");\nconst c = await git.log(3);\nlog("done");\nreturn c.length;\n`,
    );
    expect(siteIds).toEqual(["world-read#1"]);
    expect(code).toContain(`__host.worldRead("world-read#1", "git-log", [3])`);
    expect(code).toContain(`__host.log("start")`);
    expect(code).toContain(`__host.log("done")`);
    // Converse: no second world-read site; neither log was minted as one.
    expect(code).not.toContain(`"world-read#2"`);
  });

  it("keeps a multi-argument facade call's arguments in source order", () => {
    // An ask whose receiver plus args create several accessed expressions: pins visitExpr traversing argument
    const { code } = assertLowered(
      `const p = agent("p");\nconst paths = await files.glob("a");\n` +
        `const out = await p.ask<string>(paths.join(","));\nreturn out;\n`,
    );
    expect(code).toContain(`__host.worldRead("world-read#1", "glob", ["a"])`);
    expect(code).toContain(`__host.ask("ask#1", p, paths.join(","))`);
  });

  it("preserves the optional-chain short-circuit on ?.ask (identifier receiver)", () => {
    // Bug regression: p?.ask(x) used to lower unconditionally to __host.ask(siteId, p, x), dropping the
    const { code } = assertLowered(
      `const flag = "x".length > 1;\nconst p = flag ? agent("a") : undefined;\n` +
        `const r = await p?.ask<string>("q");\nreturn r ?? "skipped";\n`,
    );
    expect(code).toContain(
      `p === null || p === undefined ? undefined : __host.ask("ask#1", p, "q")`,
    );
  });

  it("evaluates a non-identifier optional receiver exactly once via a hoisted temp", () => {
    const { code } = assertLowered(
      `const box = { p: "x".length > 1 ? agent("a") : undefined };\n` +
        `const r = await box.p?.ask<string>("q");\nreturn r ?? "skipped";\n`,
    );
    expect(code).toContain(`var _a`);
    expect(code).toContain(
      `(_a = box.p) === null || _a === undefined ? undefined : __host.ask("ask#1", _a, "q")`,
    );
  });

  it("optional-chain ask runtime semantics: nullish receiver skips the host call, args unevaluated", async () => {
    // Running the lowered output itself (AsyncFunction + stub host) pins runtime semantics: nullish receiver,
    const { code } = assertLowered(
      `let argEvaluated = false;\nfunction instr(): string { argEvaluated = true; return "q"; }\n` +
        `const p = "x".length > 1 ? agent("a") : undefined;\n` +
        `const wrap: { p?: Agent } = {};\n` +
        `const r1 = await p?.ask<string>(instr());\n` +
        `const r2 = await wrap.p?.ask<string>(instr());\n` +
        `return { argEvaluated, r1: r1 ?? "skipped", r2: r2 ?? "skipped" };\n`,
    );
    const askCalls: unknown[][] = [];
    const host = {
      createActor: () => "actor-handle",
      ask: (...args: unknown[]) => {
        askCalls.push(args);
        return Promise.resolve("answered");
      },
    };
    const run = new AsyncFunction(HOST_BINDING, code) as (h: unknown) => Promise<unknown>;
    // "x".length > 1 is false with p undefined and wrap.p undefined -- both asks must short-circuit.
    await expect(run(host)).resolves.toEqual({ argEvaluated: false, r1: "skipped", r2: "skipped" });
    expect(askCalls).toEqual([]);
  });

  it("optional-chain ask runtime semantics: a present receiver still reaches __host.ask", async () => {
    const { code } = assertLowered(
      `const p = "xy".length > 1 ? agent("a") : undefined;\n` +
        `const r = await p?.ask<string>("q");\nreturn r ?? "skipped";\n`,
    );
    const askCalls: unknown[][] = [];
    const host = {
      createActor: () => "actor-handle",
      ask: (...args: unknown[]) => {
        askCalls.push(args);
        return Promise.resolve("answered");
      },
    };
    const run = new AsyncFunction(HOST_BINDING, code) as (h: unknown) => Promise<unknown>;
    await expect(run(host)).resolves.toBe("answered");
    expect(askCalls).toEqual([["ask#1", "actor-handle", "q"]]);
  });

  it("a script with no facade calls lowers to plain stripped JS (no __host)", () => {
    const source = readFileSync(join(loweringDir, "no-facade.ts"), "utf8");
    const { code, siteIds } = assertLowered(source);
    expect(siteIds).toEqual([]);
    expect(code).not.toContain(HOST_BINDING);
  });

  it("lowers phase() markers to __host.enterPhase(name) and keeps them out of siteIds", async () => {
    // Markers have no site and no journal row, but the engine must see the crossing
    const { code, siteIds } = assertLowered(
      `phase("start");\nlog("hi");\nphase("  end  ");\nreturn 1;\n`,
    );
    expect(siteIds).toEqual([]);
    expect(code).not.toContain("void 0;");
    expect(code).not.toMatch(/(^|[^.\w])phase\s*\(/);
    const logged: string[] = [];
    const entered: string[] = [];
    const run = new AsyncFunction(HOST_BINDING, code) as (host: unknown) => Promise<unknown>;
    await expect(
      run({ log: (m: string) => logged.push(m), enterPhase: (n: string) => entered.push(n) }),
    ).resolves.toBe(1);
    expect(logged).toEqual(["hi"]);
    expect(entered).toEqual(["start", "end"]);
  });

  it("leaves siteIds byte-identical with and without markers (site-id stability)", () => {
    // site-id stability (docs/analysis.md, Sites) as an executable assertion: markers occupy no counter, so after
    const sites =
      `const a = agent("a");\n` +
      `const paths = await files.glob("*.ts");\n` +
      `const x = await a.ask<string>("go");\n` +
      `report(x);\n` +
      `return paths.length;\n`;
    const marked =
      `phase("preflight");\n` +
      `const a = agent("a");\n` +
      `const paths = await files.glob("*.ts");\n` +
      `phase("work");\n` +
      `const x = await a.ask<string>("go");\n` +
      `report(x);\n` +
      `phase("wrap-up");\n` +
      `return paths.length;\n`;
    const bare = assertLowered(sites);
    expect(bare.siteIds).toEqual(["actor#1", "world-read#1", "ask#1", "report#1"]);
    expect(assertLowered(marked).siteIds).toEqual(bare.siteIds);
  });

  it("does not lower a dirty script (typecheck error) — no output", () => {
    // agent expects a string name; a number is a type error. Lowering only runs on clean programs.
    const result = lowerWorkflowScript(`const a = agent(123);\nawait a.ask("x");\n`);
    expect(result.ok).toBe(false);
    expect(result.lowered).toBeUndefined();
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("does not lower a facade-siting violation — no output", () => {
    // Taking a reference to ask (method extraction) breaks site identity; facade-siting rejects it.
    const result = lowerWorkflowScript(`const p = agent("p");\nconst f = p.ask;\nawait f("x");\n`);
    expect(result.ok).toBe(false);
    expect(result.lowered).toBeUndefined();
  });
});
