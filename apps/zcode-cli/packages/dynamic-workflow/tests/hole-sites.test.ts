import { describe, expect, it } from "vitest";
import { createWorkflowProgram } from "../src/compiler/compile.js";
import { collectSites } from "../src/analysis/sites.js";
import { collectHoleDiagnostics, HOLE_CODE } from "../src/analysis/hole-sites.js";
import { holePrefixOf, holeSiteId, isHoleSiteId } from "../src/analysis/hole-id.js";
import { FACADE_SITING_CODE } from "../src/analysis/facade-misuse.js";
import {
  analyzeWorkflowScript,
  checkSiteStability,
  collectPhaseNames,
  collectSitePhases,
  lowerWorkflow,
  lowerWorkflowScript,
  MAIN_LANE,
  spliceHoleBody,
} from "../src/index.js";

// The compile side of holes (docs/dynamic-workflow/authoring.md Holes; docs/analysis.md Sites): site

// collection (name-keyed ids, one-level prefix counters, tail, three overloads), rule 9012, graph projections
const GROUP = holeSiteId("decide grouping");
const ORDER = holeSiteId("decide order");
const VERDICT = holeSiteId("verdict");
const DECIDE = holeSiteId("decide");
const OUTER = holeSiteId("outer");
const INNER = holeSiteId("inner");

describe("hole ids (name key)", () => {
  it("is hole# plus eight hex digits of the trimmed name, the same at any depth", () => {
    expect(GROUP).toMatch(/^hole#[0-9a-f]{8}$/u);
    expect(holeSiteId(" decide grouping ")).toBe(GROUP);
    expect(holeSiteId("decide grouping ")).toBe(GROUP);
    expect(ORDER).not.toBe(GROUP);
    expect(isHoleSiteId(GROUP)).toBe(true);
    expect(isHoleSiteId("hole#1")).toBe(false);
    expect(isHoleSiteId(`${GROUP}/ask#1`)).toBe(false);
    expect(holePrefixOf(`${GROUP}/ask#1`)).toBe(GROUP);
    expect(holePrefixOf(GROUP)).toBeUndefined();
    expect(holePrefixOf("ask#1")).toBeUndefined();
  });

  it("reports two different names that hash to one id as 9012 instead of guessing", () => {
    // (steps/phases/fill/holes), lowering (holeBodies plus the at-site evaluator), and the fill service's two
    expect(holeSiteId("k32728")).toBe(holeSiteId("k261234"));
    const { diagnostics } = sitesOf(
      `const a = await hole<string>("k32728");
const b = await hole<string>("k261234");
return a + b;`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe(HOLE_CODE);
    expect(diagnostics[0]?.line).toBe(2);
    expect(diagnostics[0]?.message).toContain("same site id");
  });
});

const sitesOf = (scriptText: string) => {
  const workflow = createWorkflowProgram(scriptText);
  const table = collectSites(workflow);
  return { diagnostics: collectHoleDiagnostics(workflow, table), table, workflow };
};

const OPEN = [
  `interface Plan { groups: string[][] }`,
  `const survey = await agent("surveyor").ask<string>("Recon");`,
  `const plan = await hole<Plan>("decide grouping", \`slowest is \${survey}\`);`,
  `return agent("executor").ask<string>(\`run in \${plan.groups.length} groups\`);`,
].join("\n");

const FILLED = [
  `interface Plan { groups: string[][] }`,
  `const survey = await agent("surveyor").ask<string>("Recon");`,
  `const plan = await hole<Plan>("decide grouping", \`slowest is \${survey}\`, async () => {`,
  `  phase("grouping");`,
  `  return await agent("grouper").ask<Plan>(\`grouping \${survey}\`);`,
  `});`,
  `return agent("executor").ask<string>(\`run in \${plan.groups.length} groups\`);`,
].join("\n");

describe("hole site collection", () => {
  it("collects an open hole keyed by its name, consuming the global order", () => {
    const { diagnostics, table } = sitesOf(OPEN);
    expect(diagnostics).toEqual([]);
    expect(table.holes).toHaveLength(1);
    const [site] = table.holes;
    expect(site?.id).toBe(GROUP);
    expect(site?.fill).toBeUndefined();
    expect(site?.name).toBe("decide grouping");
    expect(site?.typeText).toBe("Plan");
    expect(site?.prompt).toBeDefined();
    expect(site?.body).toBeUndefined();
    expect(site?.tail).toBe(false);
    expect(site?.order).toBe(2);
    // Sites after a hole number normally: a hole is not another counter's zero.
    expect(table.asks.map((s) => s.id)).toEqual(["ask#1", "ask#2"]);
    expect(table.actors.map((s) => s.id)).toEqual(["actor#1", "actor#2"]);
  });

  it("prefixes every id minted inside a body and leaves the outer ids untouched", () => {
    const outer = sitesOf(OPEN).table;
    const { diagnostics, table } = sitesOf(FILLED);
    expect(diagnostics).toEqual([]);
    expect(table.holes[0]?.body).toBeDefined();
    expect(table.asks.map((s) => s.id)).toEqual(["ask#1", `${GROUP}/ask#1`, "ask#2"]);
    expect(table.actors.map((s) => s.id)).toEqual(["actor#1", `${GROUP}/actor#1`, "actor#2"]);
    // Site-id stability extends to adding bodies: every outside id stays verbatim.
    const ids = (t: typeof table) =>
      [...t.asks, ...t.actors, ...t.holes].map((s) => s.id).filter((id) => !id.includes("/"));
    expect(ids(table)).toEqual(ids(outer));
    // A return inside the body is not a top-level return.
    expect(table.topLevelReturns).toHaveLength(1);
    // Markers in the body collect as usual (they have no id).
    expect(table.phases.map((m) => m.name)).toEqual(["grouping"]);
  });

  it("nests: a hole inside a body keeps a flat name-key id, records its enclosing hole in fill, and its body opens a third counter set", () => {
    const { diagnostics, table } = sitesOf(
      [
        `const plan = await hole<string>("outer", "p", async () => {`,
        `  const inner = await hole<string>("inner", "q", async () => {`,
        `    return await agent("a").ask<string>("x");`,
        `  });`,
        `  return inner;`,
        `});`,
        `return plan;`,
      ].join("\n"),
    );
    expect(diagnostics).toEqual([]);
    expect(table.holes.map((s) => [s.id, s.fill])).toEqual([
      [OUTER, undefined],
      [INNER, OUTER],
    ]);
    // One prefix level only: sites in the inner body carry the inner id, never the outer.
    expect(table.asks.map((s) => s.id)).toEqual([`${INNER}/ask#1`]);
  });

  it("marks the tail form and distinguishes the three overloads", () => {
    const tail = sitesOf(`return await hole<string>("verdict", "p");`).table.holes[0];
    expect(tail?.tail).toBe(true);
    expect(tail?.prompt).toBeDefined();
    const bodyOnly = sitesOf(`return await hole<string>("verdict", async () => "x");`).table
      .holes[0];
    expect(bodyOnly?.prompt).toBeUndefined();
    expect(bodyOnly?.body).toBeDefined();
    const inHelper = sitesOf(
      `async function f(): Promise<string> { return await hole<string>("verdict"); }\nreturn await f();`,
    ).table.holes[0];
    expect(inHelper?.tail).toBe(false);
    expect(inHelper?.prompt).toBeUndefined();
  });

  it("ignores a script-local function named hole (identity by declaration)", () => {
    const { table } = sitesOf(
      `async function hole(n: string): Promise<string> { return n; }\nreturn await hole("x");`,
    );
    expect(table.holes).toEqual([]);
  });
});

describe("hole diagnostics (9012)", () => {
  const codes = (scriptText: string) => sitesOf(scriptText).diagnostics.map((d) => d.code);
  const messages = (scriptText: string) => sitesOf(scriptText).diagnostics.map((d) => d.message);

  it("requires an explicit type argument", () => {
    const { diagnostics } = sitesOf(`const x = await hole("decide", "p");\nreturn x;`);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe(HOLE_CODE);
    expect(diagnostics[0]?.message).toContain("explicit type argument");
    expect(diagnostics[0]?.line).toBe(1);
  });

  it("requires a non-empty literal name of at most 128 characters", () => {
    expect(messages(`const n = "x";\nconst v = await hole<string>(n);\nreturn v;`)[0]).toContain(
      "string literal",
    );
    expect(messages(`const v = await hole<string>("");\nreturn v;`)[0]).toContain("no name");
    expect(messages(`const v = await hole<string>("${"n".repeat(129)}");\nreturn v;`)[0]).toContain(
      "128",
    );
    expect(codes(`const v = await hole<string>("${"n".repeat(128)}");\nreturn v;`)).toEqual([]);
  });

  it("rejects a name shared by two holes, and a name shared with a phase marker", () => {
    const twice = sitesOf(
      `const a = await hole<string>("decide");\nconst b = await hole<string>("decide");\nreturn a + b;`,
    ).diagnostics;
    expect(twice).toHaveLength(1);
    expect(twice[0]?.line).toBe(2); // reported on the latter
    expect(twice[0]?.message).toContain("two holes are named");
    const marker = sitesOf(
      `phase("decide");\nconst a = await hole<string>("decide");\nreturn a;`,
    ).diagnostics;
    expect(marker).toHaveLength(1);
    expect(marker[0]?.line).toBe(2);
    expect(marker[0]?.message).toContain("phase(");
    // Names inside nested fills count too: the body's marker collides with the outer hole.
    const nested = sitesOf(
      `const a = await hole<string>("decide", async () => {\n  phase("decide");\n  return "x";\n});\nreturn a;`,
    ).diagnostics;
    expect(nested).toHaveLength(1);
  });

  it("requires the call to be awaited where it is called", () => {
    expect(messages(`const p = hole<string>("decide");\nreturn await p;`)[0]).toContain(
      "must be awaited",
    );
    expect(messages(`return hole<string>("decide");`)[0]).toContain("must be awaited");
    expect(codes(`return await hole<string>("decide");`)).toEqual([]);
  });

  it("rejects a hole inside an array-method callback, allows for...of and plain loops", () => {
    expect(
      messages(
        `const xs = [1, 2];\nconst ys = await Promise.all(xs.map(async (x) => await hole<string>(\`h\${x}\`)));\nreturn ys;`,
      ),
    ).toEqual([expect.stringContaining("string literal"), expect.stringContaining("fan-out")]);
    // Unlifted candidates count: no other site in the forEach callback, so the hole is the first it reaches.
    expect(
      messages(`[1, 2].forEach(async () => {\n  await hole<string>("decide");\n});\nreturn 1;`)[0],
    ).toContain("fan-out");
    // for...of with await is sequential: lap one parks at the hole, later laps run the body (authoring.md, Holes).
    expect(
      codes(`for (const x of [1, 2]) {\n  await hole<string>("decide");\n}\nreturn 1;`),
    ).toEqual([]);
    expect(
      codes(`for (let i = 0; i < 2; i += 1) {\n  await hole<string>("decide");\n}\nreturn 1;`),
    ).toEqual([]);
  });

  it("rejects a body that reads a binding declared after the hole, allows hoisted and body-local ones", () => {
    const late = sitesOf(
      [
        `const v = await hole<string>("decide", async () => {`,
        `  return later + fn();`,
        `});`,
        `const later = "x";`,
        `function fn(): string { return "y"; }`,
        `return v;`,
      ].join("\n"),
    ).diagnostics;
    expect(late).toHaveLength(1);
    expect(late[0]?.message).toContain('"later"');
    expect(late[0]?.line).toBe(2);
    expect(
      codes(
        [
          `const before = "b";`,
          `const v = await hole<string>("decide", async () => {`,
          `  const local = before;`,
          `  return local;`,
          `});`,
          `return v;`,
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("requires the body to be an inline function literal", () => {
    expect(
      messages(
        `const body = async () => "x";\nconst v = await hole<string>("decide", body);\nreturn v;`,
      )[0],
    ).toContain("inline");
    expect(
      messages(
        `const body = async () => "x";\nconst v = await hole<string>("decide", "p", body);\nreturn v;`,
      )[0],
    ).toContain("inline");
  });

  it("is wired into analyze and lower (ok: false, graphs withheld, nothing lowered)", () => {
    const script = `const v = await hole<string>("decide");\nconst w = await hole<string>("decide");\nreturn v + w;`;
    const analyzed = analyzeWorkflowScript(script);
    expect(analyzed.ok).toBe(false);
    expect(analyzed.diagnostics.map((d) => d.code)).toEqual([HOLE_CODE]);
    expect(analyzed.graph).toBeUndefined();
    const lowered = lowerWorkflowScript(script);
    expect(lowered.ok).toBe(false);
    expect(lowered.lowered).toBeUndefined();
  });

  it("leaves aliasing the facade function to facade-siting (9001)", () => {
    const analyzed = analyzeWorkflowScript(`const h = hole;\nreturn await h<string>("decide");`);
    expect(analyzed.diagnostics.map((d) => d.code)).toContain(FACADE_SITING_CODE);
  });
});

describe("holes in the graphs", () => {
  it("draws an open hole as a step in the main lane with its prompt as a sink and a memberless phase", () => {
    const analyzed = analyzeWorkflowScript(OPEN);
    expect(analyzed.ok).toBe(true);
    const node = analyzed.graph?.nodes.find((n) => n.id === GROUP);
    expect(node?.kind).toBe("hole");
    expect(node?.label).toBe("decide grouping");
    expect(node?.artifactType).toBe("Plan");
    expect(analyzed.graph?.edges).toContainEqual({
      exact: true,
      from: "ask#1",
      kind: "data",
      to: GROUP,
      type: "string",
    });
    expect(analyzed.graph?.edges).toContainEqual({
      exact: true,
      from: GROUP,
      kind: "data",
      to: "ask#2",
      type: "Plan",
    });
    const step = analyzed.causality?.steps.find((s) => s.id === GROUP);
    expect(step?.kind).toBe("hole");
    expect(step?.lane).toBe(MAIN_LANE);
    expect(step?.fill).toBeUndefined();
    expect(analyzed.causality?.lanes[0]?.id).toBe(MAIN_LANE);
    // A hole is a phase: present in the control-flow phase table without members; absent from causality's
    expect(analyzed.flow?.phases?.map((p) => p.id)).toEqual(["unphased", GROUP]);
    expect(analyzed.flow?.nodes.filter((n) => n.kind === "issue" && n.phase === GROUP)).toEqual([]);
    expect(analyzed.causality?.phases?.map((p) => p.id)).toEqual(["unphased"]);
    expect(analyzed.flow?.holes).toEqual([
      { name: "decide grouping", phase: "unphased", siteId: GROUP, type: "Plan" },
    ]);
  });

  it("marks the tail form on the display's holes", () => {
    const analyzed = analyzeWorkflowScript(`return await hole<string>("verdict");`);
    expect(analyzed.flow?.holes).toEqual([
      { name: "verdict", phase: "unphased", siteId: VERDICT, tail: true, type: "string" },
    ]);
    expect(analyzed.causality?.sink?.fedBy).toEqual([VERDICT]);
  });

  it("gives a filled hole no step, a phase that claims the body up to its first marker, and fill on what the fill wrote", () => {
    const analyzed = analyzeWorkflowScript(FILLED);
    expect(analyzed.ok).toBe(true);
    expect(analyzed.graph?.nodes.some((n) => n.id === GROUP)).toBe(false);
    expect(analyzed.flow?.holes).toBeUndefined();
    // Body opens with a marker: the hole's own phase has no member but has the mark node, so it stays
    expect(analyzed.flow?.phases).toEqual([
      { id: "unphased" },
      { id: GROUP, loc: { column: 20, line: 3 }, name: "decide grouping" },
      { fill: GROUP, id: "phase#1", loc: { column: 3, line: 4 }, name: "grouping" },
    ]);
    // Causality's phase table is by-member: the empty hole phase is out.
    expect(analyzed.causality?.phases?.map((p) => p.id)).toEqual(["unphased", "phase#1"]);
    const bodyAsk = analyzed.causality?.steps.find((s) => s.id === `${GROUP}/ask#1`);
    expect(bodyAsk?.fill).toBe(GROUP);
    expect(bodyAsk?.phase).toBe("phase#1");
    expect(bodyAsk?.lane).toBe(`${GROUP}/actor#1`);
    expect(analyzed.causality?.steps.find((s) => s.id === "ask#2")?.fill).toBeUndefined();
    // Body without markers: the hole's own phase claims the inner ask under its name.
    const noMarker = analyzeWorkflowScript(FILLED.replace(`  phase("grouping");\n`, ""));
    expect(noMarker.flow?.phases).toEqual([
      { id: "unphased" },
      { id: GROUP, loc: { column: 20, line: 3 }, name: "decide grouping" },
    ]);
    expect(noMarker.causality?.steps.find((s) => s.id === `${GROUP}/ask#1`)?.phase).toBe(GROUP);
  });

  it("stamps body sites with the hole's name in the site-phase table, and lists phases with the open-hole index", () => {
    const script = [
      `phase("Recon");`,
      `const survey = await agent("surveyor").ask<string>("Recon");`,
      `const plan = await hole<string>("decide grouping", \`\${survey}\`, async () => {`,
      `  return await agent("grouper").ask<string>("grouping");`,
      `});`,
      `const order = await hole<string>("decide order");`,
      `phase("execute");`,
      `return agent("executor").ask<string>(\`\${plan}\${order}\`);`,
    ].join("\n");
    const analyzed = analyzeWorkflowScript(script);
    expect(analyzed.ok).toBe(true);
    const phases = collectSitePhases(analyzed.core!);
    expect(phases.get(`${GROUP}/ask#1`)).toBe("decide grouping");
    expect(phases.get(ORDER)).toBe("Recon"); // the open hole sits in the Recon phase
    expect(collectPhaseNames(analyzed.flow)).toEqual({
      holes: [2],
      phaseNames: ["Recon", "decide grouping", "decide order", "execute"],
    });
    expect(collectPhaseNames(undefined)).toEqual({ holes: [], phaseNames: [] });
  });
});

describe("hole lowering", () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
    ...args: string[]
  ) => (...args: unknown[]) => Promise<unknown>;

  it("emits the evaluator at the site and the body as text in holeBodies", () => {
    const result = lowerWorkflowScript(FILLED);
    expect(result.ok).toBe(true);
    const lowered = result.lowered!;
    expect(lowered.siteIds).toEqual([
      "ask#1",
      "actor#1",
      GROUP,
      `${GROUP}/ask#1`,
      `${GROUP}/actor#1`,
      "ask#2",
      "actor#2",
    ]);
    expect(lowered.code).toContain(
      `__host.hole("${GROUP}", "decide grouping", \`slowest is \${survey}\`, __src => eval(__src), async () => {`,
    );
    const body = lowered.holeBodies[GROUP];
    expect(body?.startsWith("(async () => {\n")).toBe(true);
    expect(body?.endsWith("\n})")).toBe(true);
    expect(body).toContain(
      `__host.ask("${GROUP}/ask#1", __host.createActor("${GROUP}/actor#1", "grouper")`,
    );
    expect(body).not.toContain("<Plan>");
    // An open hole: absent prompt falls back to void 0, no body and no holeBodies entry.
    const open = lowerWorkflowScript(`const v = await hole<string>("decide");\nreturn v;`).lowered!;
    expect(open.code).toContain(`__host.hole("${DECIDE}", "decide", void 0, __src => eval(__src))`);
    expect(open.holeBodies).toEqual({});
  });

  it("evaluates a fill's text at the site: the body closes over the bindings there", async () => {
    // Cell simulation: __host.hole gets the site's evaluator, builds the function from holeBodies text and
    // The referenced survey is a const from before the hole -- only the at-site direct eval sees it.
    const lowered = lowerWorkflowScript(FILLED).lowered!;
    const calls: string[] = [];
    const host = {
      ask: async (id: string, actor: string, text: string) => {
        calls.push(`${id}:${actor}:${text}`);
        return id === "ask#1" ? "S" : { groups: [["a"]] };
      },
      createActor: (id: string) => id,
      enterPhase: () => undefined,
      hole: async (
        id: string,
        _n: string,
        _p: unknown,
        evaluate: (src: string) => () => Promise<unknown>,
      ) => {
        return evaluate(lowered.holeBodies[id] as string)();
      },
    };
    // Rewrites the filled call to open form (dropping the fifth arg) so the text path really runs.
    const unfilledCode = lowered.code.replace(/, async \(\) => \{[\s\S]*?\n\}\);/, ");");
    const result = await new AsyncFunction("__host", unfilledCode)(host);
    expect(result).toEqual({ groups: [["a"]] });
    expect(calls).toEqual([
      "ask#1:actor#1:Recon",
      `${GROUP}/ask#1:${GROUP}/actor#1:grouping S`,
      "ask#2:actor#2:run in 1 groups",
    ]);
  });
});

describe("spliceHoleBody / checkSiteStability", () => {
  const BODY = `phase("grouping");\nreturn await agent("grouper").ask<Plan>(\`grouping \${survey}\`);`;

  it("splices the body after the last argument, indented under the call", () => {
    const { table } = sitesOf(OPEN);
    const spliced = spliceHoleBody(OPEN, table, GROUP, BODY);
    expect(spliced).toBeDefined();
    expect(spliced?.text).toBe(FILLED);
    expect(spliced?.insertedAtLine).toBe(4);
    expect(spliced?.insertedLines).toBe(3);
    // The spliced script typechecks; body sites carry the prefix.
    const after = sitesOf(spliced!.text);
    expect(after.diagnostics).toEqual([]);
    expect(after.table.asks.map((s) => s.id)).toEqual(["ask#1", `${GROUP}/ask#1`, "ask#2"]);
  });

  it("indents by the call's own indentation plus two", () => {
    const script = `if (true) {\n  const v = await hole<string>("decide");\n  log(v);\n}\nreturn 1;`;
    const { table } = sitesOf(script);
    const spliced = spliceHoleBody(script, table, DECIDE, `return "x";`);
    expect(spliced?.text).toBe(
      `if (true) {\n  const v = await hole<string>("decide", async () => {\n    return "x";\n  });\n  log(v);\n}\nreturn 1;`,
    );
    expect(spliced?.insertedAtLine).toBe(3);
    expect(spliced?.insertedLines).toBe(2);
  });

  it("keeps a trailing comma and a multi-line call intact (prettier-style call site)", () => {
    // 2026-09-28, first field incident: the main agent wrote a multi-line call with a trailing comma; the old
    const script = [
      `const v = await hole<string>(`,
      `  "decide",`,
      `  \`prompt\`,`,
      `);`,
      `log(v);`,
      `return 1;`,
    ].join("\n");
    const { table, diagnostics } = sitesOf(script);
    expect(diagnostics).toEqual([]);
    const spliced = spliceHoleBody(script, table, DECIDE, `return "x";`);
    expect(spliced?.text).toBe(
      [
        `const v = await hole<string>(`,
        `  "decide",`,
        `  \`prompt\`, async () => {`,
        `  return "x";`,
        `},`,
        `);`,
        `log(v);`,
        `return 1;`,
      ].join("\n"),
    );
    expect(spliced?.insertedAtLine).toBe(4);
    expect(spliced?.insertedLines).toBe(2);
    const after = sitesOf(spliced!.text);
    expect(after.diagnostics).toEqual([]);
    expect(
      checkSiteStability(
        table,
        after.table,
        DECIDE,
        spliced!.insertedAtLine,
        spliced!.insertedLines,
      ),
    ).toEqual({ ok: true });
  });

  it("refuses an unknown hole and an already filled one", () => {
    expect(spliceHoleBody(OPEN, sitesOf(OPEN).table, holeSiteId("nope"), BODY)).toBeUndefined();
    expect(spliceHoleBody(FILLED, sitesOf(FILLED).table, GROUP, BODY)).toBeUndefined();
  });

  it("accepts a fill that shifts every later site by the inserted lines and adds only prefixed ids", () => {
    const before = sitesOf(OPEN).table;
    const spliced = spliceHoleBody(OPEN, before, GROUP, BODY)!;
    const after = sitesOf(spliced.text).table;
    expect(
      checkSiteStability(before, after, GROUP, spliced.insertedAtLine, spliced.insertedLines),
    ).toEqual({ ok: true });
  });

  it("rejects a vanished id, a moved id and an unprefixed new id", () => {
    const before = sitesOf(OPEN).table;
    const vanished = sitesOf(
      OPEN.replace(
        `return agent("executor").ask<string>(\`run in \${plan.groups.length} groups\`);`,
        `return 1;`,
      ),
    ).table;
    expect(checkSiteStability(before, vanished, GROUP, 4, 3)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("ask#2 vanished"),
    });
    const moved = sitesOf(`\n${OPEN}`).table;
    expect(checkSiteStability(before, moved, GROUP, 4, 3)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("ask#1 moved"),
    });
    const extra = sitesOf(`${OPEN}\nawait agent("x").ask<string>("y");`).table;
    expect(checkSiteStability(before, extra, GROUP, 99, 0)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("ask#3 appeared"),
    });
    // A hole newly appearing outside the body is also beyond the fill: its chain never reaches the filled one.
    const strayHole = sitesOf(`${OPEN}\nawait hole<string>("elsewhere");`).table;
    expect(checkSiteStability(before, strayHole, GROUP, 99, 0)).toMatchObject({
      ok: false,
      detail: expect.stringContaining("appeared outside"),
    });
  });

  it("lowers the spliced script with the fill's body text byte-identical to a direct compile", () => {
    const spliced = spliceHoleBody(OPEN, sitesOf(OPEN).table, GROUP, BODY)!;
    const workflow = createWorkflowProgram(spliced.text);
    const lowered = lowerWorkflow(workflow, collectSites(workflow));
    expect(lowered.holeBodies).toEqual(lowerWorkflowScript(FILLED).lowered?.holeBodies);
  });
});

// Recursive holes (docs/analysis.md, Sites): a fill body containing another hole; filling it splices the
describe("recursive holes", () => {
  const OUTER_OPEN = [
    `interface Plan { groups: string[][] }`,
    `interface Order { first: string }`,
    `const survey = await agent("surveyor").ask<string>("Recon");`,
    `const plan = await hole<Plan>("decide grouping", \`\${survey}\`);`,
    `return agent("executor").ask<string>(\`\${plan.groups.length}\`);`,
  ].join("\n");
  const OUTER_BODY = [
    `const draft = await agent("grouper").ask<Plan>(\`grouping \${survey}\`);`,
    `const order = await hole<Order>("decide order", \`\${draft.groups.length} groups\`);`,
    `return { groups: [[order.first], ...draft.groups] };`,
  ].join("\n");
  const INNER_BODY = `return await agent("sequencer").ask<Order>(\`order \${draft.groups.length} groups\`);`;

  const outerFilled = () => {
    const spliced = spliceHoleBody(OUTER_OPEN, sitesOf(OUTER_OPEN).table, GROUP, OUTER_BODY)!;
    return { ...spliced, table: sitesOf(spliced.text).table };
  };
  const bothFilled = () => {
    const first = outerFilled();
    const spliced = spliceHoleBody(first.text, first.table, ORDER, INNER_BODY)!;
    return { ...spliced, before: first.table, table: sitesOf(spliced.text).table };
  };

  it("(1) lists the inner hole with its own flat id and its enclosing hole, open, and splices into the inner call", () => {
    const first = outerFilled();
    expect(sitesOf(first.text).diagnostics).toEqual([]);
    expect(first.table.holes.map((h) => [h.id, h.fill, h.body === undefined])).toEqual([
      [GROUP, undefined, false],
      [ORDER, GROUP, true],
    ]);
    const second = bothFilled();
    expect(sitesOf(second.text).diagnostics).toEqual([]);
    // Spliced into the inner call: it now has a body whose sites carry the inner hole's own prefix level.
    expect(second.text).toContain(
      `const order = await hole<Order>("decide order", \`\${draft.groups.length} groups\`, async () => {`,
    );
    expect(second.text).toContain(`\n    return await agent("sequencer")`);
    expect(second.table.holes.map((h) => [h.id, h.fill, h.body === undefined])).toEqual([
      [GROUP, undefined, false],
      [ORDER, GROUP, false],
    ]);
    expect(second.table.asks.map((s) => s.id)).toEqual([
      "ask#1",
      `${GROUP}/ask#1`,
      `${ORDER}/ask#1`,
      "ask#2",
    ]);
    expect(second.table.actors.map((s) => s.id)).toEqual([
      "actor#1",
      `${GROUP}/actor#1`,
      `${ORDER}/actor#1`,
      "actor#2",
    ]);
    // Inner call indent (outer body 2) + 2: inner body at 4, closing paren back at 2.
    expect(second.text).toContain(`\n  });\n  return { groups`);
  });

  it("(2) checkSiteStability accepts the inner fill and rejects a renumbering", () => {
    const second = bothFilled();
    expect(
      checkSiteStability(
        second.before,
        second.table,
        ORDER,
        second.insertedAtLine,
        second.insertedLines,
      ),
    ).toEqual({ ok: true });
    // Renumbering: one more ask prepended shifts every outer and outer-body id.
    const renumbered = sitesOf(`await agent("x").ask<string>("y");\n${second.text}`).table;
    const verdict = checkSiteStability(
      second.before,
      renumbered,
      ORDER,
      second.insertedAtLine,
      second.insertedLines,
    );
    expect(verdict.ok).toBe(false);
    // The outer body's ids (<GROUP>/...) must survive verbatim; altered ids are rejected too.
    const dropped = sitesOf(
      second.text.replace(
        `const draft = await agent("grouper").ask<Plan>(\`grouping \${survey}\`);`,
        `const draft = { groups: [["a"]] } as Plan;`,
      ),
    ).table;
    expect(
      checkSiteStability(
        second.before,
        dropped,
        ORDER,
        second.insertedAtLine,
        second.insertedLines,
      ),
    ).toMatchObject({
      detail: expect.stringContaining(`${GROUP}/ask#1 vanished`),
      ok: false,
    });
  });

  it("(3) lowers the inner open hole inside the outer body's text, then both bodies once both are filled", () => {
    const first = lowerWorkflowScript(outerFilled().text).lowered!;
    expect(Object.keys(first.holeBodies)).toEqual([GROUP]);
    expect(first.holeBodies[GROUP]).toContain(
      `__host.hole("${ORDER}", "decide order", \`\${draft.groups.length} groups\`, __src => eval(__src))`,
    );
    expect(first.siteIds).toEqual([
      "ask#1",
      "actor#1",
      GROUP,
      `${GROUP}/ask#1`,
      `${GROUP}/actor#1`,
      ORDER,
      "ask#2",
      "actor#2",
    ]);
    const second = lowerWorkflowScript(bothFilled().text).lowered!;
    expect(Object.keys(second.holeBodies).sort()).toEqual([GROUP, ORDER].sort());
    const inner = second.holeBodies[ORDER]!;
    expect(inner.startsWith("(async () => {\n")).toBe(true);
    expect(inner).toContain(
      `__host.ask("${ORDER}/ask#1", __host.createActor("${ORDER}/actor#1", "sequencer")`,
    );
    // The outer text now inlines the inner body as the fifth arg, the same rewrite as the standalone inner text.
    const outer = second.holeBodies[GROUP]!;
    expect(outer).toContain(
      `__host.hole("${ORDER}", "decide order", \`\${draft.groups.length} groups\`, __src => eval(__src), async () => {`,
    );
    expect(outer).toContain(
      `__host.ask("${ORDER}/ask#1", __host.createActor("${ORDER}/actor#1", "sequencer")`,
    );
    expect(second.siteIds).toContain(`${ORDER}/ask#1`);
  });

  it("(4) projects the three states: outer open, inner open, both filled", () => {
    const open = analyzeWorkflowScript(OUTER_OPEN);
    expect(open.flow?.holes).toEqual([
      { name: "decide grouping", phase: "unphased", siteId: GROUP, type: "Plan" },
    ]);
    const innerOpen = analyzeWorkflowScript(outerFilled().text);
    expect(innerOpen.ok).toBe(true);
    expect(innerOpen.flow?.holes).toEqual([
      { name: "decide order", phase: GROUP, siteId: ORDER, type: "Order" },
    ]);
    // The top-level hole's phase has no fill; the inner hole's phase carries the outer id -- nesting lives only here.
    expect(innerOpen.flow?.phases?.map((p) => [p.id, p.fill])).toEqual([
      ["unphased", undefined],
      [GROUP, undefined],
      [ORDER, GROUP],
    ]);
    expect(innerOpen.causality?.steps.find((s) => s.id === ORDER)).toMatchObject({
      fill: GROUP,
      kind: "hole",
      lane: MAIN_LANE,
      phase: GROUP,
    });
    const filled = analyzeWorkflowScript(bothFilled().text);
    expect(filled.ok).toBe(true);
    expect(filled.flow?.holes).toBeUndefined();
    expect(filled.causality?.steps.find((s) => s.id === ORDER)).toBeUndefined();
    expect(filled.causality?.steps.find((s) => s.id === `${ORDER}/ask#1`)).toMatchObject({
      fill: ORDER,
      phase: ORDER,
    });
    expect(filled.causality?.steps.find((s) => s.id === `${GROUP}/ask#1`)).toMatchObject({
      fill: GROUP,
      phase: GROUP,
    });
    expect(filled.causality?.phases?.map((p) => [p.id, p.fill])).toEqual([
      ["unphased", undefined],
      [GROUP, undefined],
      [ORDER, GROUP],
    ]);
    expect(collectSitePhases(filled.core!).get(`${ORDER}/ask#1`)).toBe("decide order");
  });

  it("(5) collectPhaseNames places the inner hole by name with its index", () => {
    expect(collectPhaseNames(analyzeWorkflowScript(outerFilled().text).flow)).toEqual({
      holes: [1],
      phaseNames: ["decide grouping", "decide order"],
    });
    expect(collectPhaseNames(analyzeWorkflowScript(bothFilled().text).flow)).toEqual({
      holes: [],
      phaseNames: ["decide grouping", "decide order"],
    });
  });
});

// Root cause: ids used to concat per level (hole#1/hole#1/..., 7 chars a layer), hitting the protocol's
// id bounds. Past the name key, depth never enters the id: grow a tail-hole chain to 20 links,
describe("a tail chain twenty fills deep", () => {
  const STEPS = 20;
  const stepName = (k: number) => `step ${k}`;
  const SEED = [
    `phase("inventory");`,
    `const s0 = await agent("surveyor").ask<string>("peek");`,
    `return await hole<string>("${stepName(1)}", \`start \${s0}\`);`,
  ].join("\n");
  const body = (k: number) =>
    k === STEPS
      ? `return s${k - 1};`
      : [
          `phase("do ${stepName(k)}");`,
          `const s${k} = await agent("writer${k}").ask<string>(\`next \${s${k - 1}}\`);`,
          `return await hole<string>("${stepName(k + 1)}", \`progress ${k}\`);`,
        ].join("\n");

  const grow = () => {
    let text = SEED;
    const lengths: number[] = [];
    for (let k = 1; k <= STEPS; k += 1) {
      const before = sitesOf(text);
      const id = holeSiteId(stepName(k));
      const spliced = spliceHoleBody(text, before.table, id, body(k));
      expect(spliced, `step ${k}`).toBeDefined();
      const after = sitesOf(spliced!.text);
      expect(after.diagnostics, `step ${k}`).toEqual([]);
      expect(
        checkSiteStability(
          before.table,
          after.table,
          id,
          spliced!.insertedAtLine,
          spliced!.insertedLines,
        ),
        `step ${k}`,
      ).toEqual({ ok: true });
      const all = [...after.table.asks, ...after.table.actors, ...after.table.holes].map(
        (s) => s.id,
      );
      lengths.push(Math.max(...all.map((sid) => sid.length)));
      text = spliced!.text;
    }
    return { lengths, text };
  };

  it("keeps every fill stable and every id as short at step 20 as at step 1", () => {
    const { lengths, text } = grow();
    // The longest ids look like hole#xxxxxxxx/actor#1: 21 chars, depth-independent.
    expect(new Set(lengths)).toEqual(new Set([lengths[0]]));
    expect(lengths[0]).toBeLessThanOrEqual(24);
    const analyzed = analyzeWorkflowScript(text);
    expect(analyzed.ok).toBe(true);
    // Every lap's name stays in the phase table: chain steps never vanish from the sidebar.
    const names = collectPhaseNames(analyzed.flow).phaseNames;
    for (let k = 1; k <= STEPS; k += 1) expect(names).toContain(stepName(k));
    expect(collectPhaseNames(analyzed.flow).holes).toEqual([]);
  });

  it("records each step's enclosing step in fill, so nesting survives without being spelled in the id", () => {
    const { text } = grow();
    const { table } = sitesOf(text);
    for (let k = 2; k <= STEPS; k += 1) {
      const hole = table.holes.find((h) => h.id === holeSiteId(stepName(k)));
      expect(hole?.fill, `step ${k}`).toBe(holeSiteId(stepName(k - 1)));
    }
    expect(table.holes.find((h) => h.id === holeSiteId(stepName(1)))?.fill).toBeUndefined();
    // The innermost body's sites carry only the innermost hole's single prefix level.
    const lowered = lowerWorkflowScript(text).lowered!;
    expect(lowered.siteIds).toContain(`${holeSiteId(stepName(19))}/ask#1`);
    expect(Object.keys(lowered.holeBodies)).toHaveLength(STEPS);
  });
});
