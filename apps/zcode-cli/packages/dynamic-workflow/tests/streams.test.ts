import { describe, expect, it } from "vitest";
import {
  analyzeWorkflowScript,
  collectSitePhases,
  collectSites,
  createWorkflowProgram,
  interpret,
  lowerWorkflowScript,
  SNIPPET_FACADE_DTS,
} from "../src/index.js";
import { FACADE_SITING_CODE } from "../src/analysis/facade-misuse.js";
import { corpusDiagnostics } from "./helpers/analysis-corpus.js";

/**
 * Compile-time behavior of the channel/future primitives (docs/dynamic-workflow/authoring.md, Streams;
 * docs/analysis.md「Phases」）：
 *   - neither sites, both still facade-callables -- alias escapes ride 9001;
 *   - channel is a container the analyzer sees through: send writes, for await reads, a producer-to-consumer data edge;
 *   - the future body inlines at the call site as an entered strand;
 *   - collectSitePhases: solely-named phases tabulate; twice-called helpers and pre-first-marker sites do not.
 */

const PIPELINE = `
interface Fact { id: string; claim: string }
interface Verdict { holds: boolean }
const facts = channel<Fact>("facts");
const verified: Fact[] = [];
const research = future(async () => {
  phase("gather");
  try {
    const found = await agent("researcher").ask<Fact[]>("find facts");
    for (const fact of found) facts.send(fact);
  } finally {
    facts.close();
  }
});
const verify = future(async () => {
  phase("verify");
  for await (const fact of facts) {
    const v = await agent(\`verifier-\${fact.id}\`).ask<Verdict>(\`verify \${fact.claim}\`);
    if (v.holds) verified.push(fact);
  }
});
await Promise.all([research, verify]);
phase("write");
return agent("writer").ask<string>(\`write \${JSON.stringify(verified)}\`);
`;

function analyzeClean(source: string) {
  const result = analyzeWorkflowScript(source);
  expect(corpusDiagnostics(result.diagnostics)).toEqual([]);
  expect(result.ok).toBe(true);
  return result;
}

describe("streams — compile and lower", () => {
  it("compiles, analyzes and lowers a channel pipeline", () => {
    analyzeClean(PIPELINE);
    const lowered = lowerWorkflowScript(PIPELINE);
    expect(lowered.ok).toBe(true);
    const code = lowered.lowered?.code ?? "";
    expect(code).toContain('__host.channel("facts")');
    expect(code).toContain("__host.future(async () =>");
    // No sites: channel/future appear in no site-id list.)
    expect(
      lowered.lowered?.siteIds.some((id) => id.startsWith("channel") || id.startsWith("future")),
    ).toBe(false);
  });

  it("is present in the snippet facade too", () => {
    const snippet = [
      'const ch = channel<number>("n");',
      "const producer = future(async () => { for (const n of [1, 2, 3]) ch.send(n); ch.close(); });",
      "let sum = 0;",
      "for await (const n of ch) sum += n;",
      "await producer;",
      "return sum;",
    ].join("\n");
    const workflow = createWorkflowProgram(snippet, { facadeDts: SNIPPET_FACADE_DTS });
    expect(workflow.program.getSemanticDiagnostics().map((d) => d.messageText)).toEqual([]);
  });
});

describe("streams — facade siting (9001)", () => {
  it("rejects aliasing Channel.send and future", () => {
    const source = [
      'const ch = channel<string>("c");',
      "const send = ch.send;",
      "const spawn = future;",
      'send("x");',
      'await spawn(async () => { log("hi"); });',
      "return 1;",
    ].join("\n");
    const result = analyzeWorkflowScript(source);
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes.filter((code) => code === FACADE_SITING_CODE).length).toBeGreaterThanOrEqual(2);
    expect(result.ok).toBe(false);
  });

  it("lets a channel value travel: stored, passed to a helper, retyped", () => {
    const source = [
      'const ch = channel<number>("c");',
      "interface Sink { send(item: number): void }",
      "function feed(target: Channel<number>, n: number): void { target.send(n); }",
      "const sink: Sink = ch;",
      "feed(ch, 1);",
      "sink.send(2);",
      "ch.close();",
      "let total = 0;",
      "for await (const n of ch) total += n;",
      "return total;",
    ].join("\n");
    analyzeClean(source);
  });
});

describe("streams — the analyzer sees through the channel", () => {
  const result = analyzeClean(PIPELINE);
  const graph = result.graph!;

  it("draws a data edge from the producer ask to the consumer ask", () => {
    const edge = graph.edges.find(
      (e) => e.from === "ask#1" && e.to === "ask#2" && e.kind === "data",
    );
    expect(edge).toBeDefined();
  });

  it("inlines each future body as an entered strand region", () => {
    const strands = result.core!.trace.regions.filter(
      (region) => region.kind === "call" && region.strand === true && region.label === "future",
    );
    expect(strands.length).toBe(2);
    for (const strand of strands) expect(strand.entered).toBe(true);
  });

  it("places the consumer ask in the verify phase although the marker sits inside a future", () => {
    const steps = result.causality!.steps;
    const phases = new Map((result.causality!.phases ?? []).map((phase) => [phase.id, phase.name]));
    const phaseOf = (id: string) => phases.get(steps.find((step) => step.id === id)?.phase ?? "");
    expect(phaseOf("ask#1")).toBe("gather");
    expect(phaseOf("ask#2")).toBe("verify");
    expect(phaseOf("ask#3")).toBe("write");
  });
});

describe("collectSitePhases", () => {
  function sitePhasesOf(source: string): ReadonlyMap<string, string> {
    const workflow = createWorkflowProgram(source);
    const table = collectSites(workflow);
    return collectSitePhases(interpret(workflow, table));
  }

  it("lists every site with one named phase, actors included", () => {
    const phases = sitePhasesOf(PIPELINE);
    expect(Object.fromEntries(phases)).toEqual({
      "actor#1": "gather",
      "ask#1": "gather",
      "actor#2": "verify",
      "ask#2": "verify",
      "actor#3": "write",
      "ask#3": "write",
    });
  });

  it("leaves out a helper called from two phases and a call before the first marker", () => {
    const source = [
      'const early = agent("early");',
      'void early.ask("before any marker");',
      "async function check(what: string): Promise<string> {",
      "  return agent(`checker-${what}`).ask(`check ${what}`);",
      "}",
      'phase("first");',
      'const a = await check("a");',
      'phase("second");',
      'const b = await check("b");',
      'const late = await agent("late").ask(`${a} ${b}`);',
      "return late;",
    ].join("\n");
    const phases = sitePhasesOf(source);
    // Before the first marker: unphased, not tabulated.)
    expect(phases.has("actor#1")).toBe(false);
    expect(phases.has("ask#1")).toBe(false);
    // The helper's site is called under two phases: not unique, not tabulated -- the engine falls back dynamic.)
    expect(phases.has("actor#2")).toBe(false);
    expect(phases.has("ask#2")).toBe(false);
    // The second phase's own site tabulates.)
    expect(phases.get("actor#3")).toBe("second");
    expect(phases.get("ask#3")).toBe("second");
  });

  it("is empty for a script without markers", () => {
    expect(sitePhasesOf('return agent("a").ask("x");').size).toBe(0);
  });
});
