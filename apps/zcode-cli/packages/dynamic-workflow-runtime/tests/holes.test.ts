/**
 * Holes evaluate in the cell, at the site (the Holes section of "The vm cell" and "## Holes" in docs/execution-engine.md).
 * These lowered bodies are handwritten (same justification as security.test.ts): under test are the __host.hole shim,
 * the wire protocol's hole request, harness routing, and the control plane's fillHole binding -- not the compiler.
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryJournalStore,
  type AskSpec,
  type FillHoleResult,
  type HoleFill,
  type RunEvent,
  type RunSettlement,
  type WorkflowEngine,
} from "@zcode/dynamic-workflow";
import { runWorkflowScript, type RunControlBinding } from "../src/index.js";
import { AutoDriver, type AutoDriverConfig } from "./auto-driver.js";
import { TEST_CWD } from "./helpers.js";

type BoundEngine = Pick<
  WorkflowEngine,
  "setMaxConcurrency" | "fillHole" | "openHoles" | "filledHoles"
>;
type HoleReached = Extract<RunEvent, { type: "hole-reached" }>;

interface RunLoweredOptions {
  asks?: AutoDriverConfig["asks"];
  askSpecs?: Map<string, AskSpec>;
  signal?: AbortSignal;
  /**
   * Every engine event passes here (synchronously, inside driver.emit); engine() returns the incarnation bound via the control plane.
   * Lazy on purpose: the first run-started fires in the engine constructor, before the harness binds the control plane.
   */
  onEvent?: (event: RunEvent, engine: () => BoundEngine) => void;
}

interface RunLoweredResult {
  settlement: RunSettlement;
  driver: AutoDriver;
  journal: InMemoryJournalStore;
}

const untyped = (...ids: string[]): Map<string, AskSpec> =>
  new Map(ids.map((id) => [id, { typed: false } as AskSpec]));

let runSeq = 0;

/** Feeds a handwritten lowered body (free identifier: __host only), wiring the control-plane handle and event hook to the test. */
async function runLowered(
  lowered: string,
  opts: RunLoweredOptions = {},
): Promise<RunLoweredResult> {
  const journal = new InMemoryJournalStore();
  const driver = new AutoDriver(journal, { asks: opts.asks });
  let engine: BoundEngine | undefined;
  const control: RunControlBinding = {
    bind(bound) {
      engine = bound;
    },
  };
  const requireEngine = (): BoundEngine => {
    if (engine === undefined) throw new Error("control was never bound to an engine");
    return engine;
  };
  const emit = driver.emit.bind(driver);
  driver.emit = (event: RunEvent): void => {
    emit(event);
    opts.onEvent?.(event, requireEngine);
  };
  const settlement = await runWorkflowScript({
    cwd: TEST_CWD,
    runId: `holes-${++runSeq}`,
    lowered,
    caps: { maxConcurrency: 4 },
    askSpecs: opts.askSpecs ?? new Map(),
    validate: () => [],
    makeDriver: (sink) => {
      driver.attach(sink);
      return driver;
    },
    control,
    timeoutMs: 15000,
    ...(opts.signal === undefined ? {} : { signal: opts.signal }),
  });
  return { settlement, driver, journal };
}

/** One fill: the spec table is a superset of the original, new sites carrying the hole#1/ prefix. */
function fillFor(code: string, overrides: Partial<HoleFill> = {}): HoleFill {
  return {
    siteId: "hole#1",
    code,
    script: { text: "effective", hash: "h1" },
    askSpecs: untyped("ask#1", "hole#1/ask#1"),
    sitePhases: new Map(),
    phaseNames: [],
    ...overrides,
  };
}

/** Fills on the first hole-reached (exactly once), keeping the fill result and arrival event for assertions. */
function fillOnReach(code: string, overrides: Partial<HoleFill> = {}) {
  const reached: HoleReached[] = [];
  const results: FillHoleResult[] = [];
  const onEvent = (event: RunEvent, engine: () => BoundEngine): void => {
    if (event.type !== "hole-reached") return;
    reached.push(event);
    if (reached.length === 1) results.push(engine().fillHole(fillFor(code, overrides)));
  };
  return { onEvent, reached, results };
}

function artifactOf(settlement: RunSettlement): unknown {
  expect(settlement.status).toBe("completed");
  return (settlement as { status: "completed"; artifact: unknown }).artifact;
}

describe("holes — evaluated at the site", () => {
  it("the fill reads a const declared before the hole, and the request carries name and prompt", async () => {
    const hook = fillOnReach("(async () => { return base + 2; })", { filledBy: "main" });
    const { settlement, driver } = await runLowered(
      [
        "const base = 40;",
        'const v = await __host.hole("hole#1", "Verdict", "Decide on base.", (__src) => eval(__src));',
        "return v;",
      ].join("\n"),
      { onEvent: hook.onEvent },
    );
    expect(artifactOf(settlement)).toBe(42);
    expect(hook.results).toEqual([{ ok: true }]);
    expect(hook.reached).toEqual([
      {
        type: "hole-reached",
        instance: { siteId: "hole#1", ordinal: 1 },
        name: "Verdict",
        prompt: "Decide on base.",
      },
    ]);
    expect(driver.eventsOfType("hole-filled")).toEqual([
      {
        type: "hole-filled",
        siteId: "hole#1",
        filledAt: expect.any(Number),
        filledBy: "main",
        phaseNames: [],
      },
    ]);
  });

  it("the fill's own lowered sites run through __host (an ask inside the body)", async () => {
    const hook = fillOnReach(
      [
        "(async () => {",
        '  const judge = __host.createActor("hole#1/actor#1", "judge");',
        '  return await __host.ask("hole#1/ask#1", judge, "judge " + subject);',
        "})",
      ].join("\n"),
    );
    const { settlement, driver } = await runLowered(
      [
        'const subject = "the patch";',
        'const verdict = await __host.hole("hole#1", "Verdict", undefined, (__src) => eval(__src));',
        "return verdict;",
      ].join("\n"),
      {
        onEvent: hook.onEvent,
        asks: {
          "hole#1/ask#1": ({ message }) => ({
            type: "text",
            finalText: `verdict on: ${message.instructions}`,
          }),
        },
      },
    );
    expect(artifactOf(settlement)).toBe("verdict on: judge the patch");
    expect(driver.eventsOfType("node-settled").map((e) => e.instance.siteId)).toEqual([
      "hole#1/ask#1",
    ]);
  });

  it("a hole in a loop is filled once and its body runs per iteration with that iteration's binding", async () => {
    const hook = fillOnReach("(async () => { return i * 10; })");
    const { settlement, driver } = await runLowered(
      [
        "const out = [];",
        "for (const i of [1, 2, 3]) {",
        '  out.push(await __host.hole("hole#1", "Scale", undefined, (__src) => eval(__src)));',
        "}",
        "return out;",
      ].join("\n"),
      { onEvent: hook.onEvent },
    );
    expect(artifactOf(settlement)).toEqual([10, 20, 30]);
    // One arrival, one fill: the last two rounds answer from the cell's fill table, never crossing the wire.
    expect(hook.reached).toHaveLength(1);
    expect(driver.eventsOfType("hole-reached")).toHaveLength(1);
    expect(driver.eventsOfType("hole-filled")).toHaveLength(1);
  });

  it("a thrown fill rejects at the site and the script can catch it", async () => {
    const hook = fillOnReach('(async () => { throw new Error("boom"); })');
    const { settlement } = await runLowered(
      [
        "try {",
        '  await __host.hole("hole#1", "Verdict", undefined, (__src) => eval(__src));',
        '  return "NO-THROW";',
        "} catch (e) {",
        "  return e.message;",
        "}",
      ].join("\n"),
      { onEvent: hook.onEvent },
    );
    expect(artifactOf(settlement)).toBe("boom");
  });

  it("a fill that does not parse rejects at the site too, as a SyntaxError", async () => {
    const hook = fillOnReach("(async () => { return ; ; )");
    const { settlement } = await runLowered(
      [
        "try {",
        '  await __host.hole("hole#1", "Verdict", undefined, (__src) => eval(__src));',
        '  return "NO-THROW";',
        "} catch (e) {",
        "  return e.name;",
        "}",
      ].join("\n"),
      { onEvent: hook.onEvent },
    );
    expect(artifactOf(settlement)).toBe("SyntaxError");
  });

  it("a filled hole (body present) sends no wire message", async () => {
    const seen: string[] = [];
    const { settlement, driver } = await runLowered(
      [
        "const base = 5;",
        'const v = await __host.hole("hole#1", "Verdict", "p", (__src) => eval(__src), async () => { return base + 2; });',
        "return v;",
      ].join("\n"),
      {
        onEvent: (event) => {
          seen.push(event.type);
        },
      },
    );
    expect(artifactOf(settlement)).toBe(7);
    expect(seen).not.toContain("hole-reached");
    expect(driver.eventsOfType("hole-reached")).toEqual([]);
  });

  it("a body that throws synchronously rejects at the site rather than escaping the call", async () => {
    const { settlement } = await runLowered(
      [
        "try {",
        '  await __host.hole("hole#1", "Verdict", undefined, (__src) => eval(__src), () => { throw new Error("sync"); });',
        '  return "NO-THROW";',
        "} catch (e) {",
        "  return e.message;",
        "}",
      ].join("\n"),
    );
    expect(artifactOf(settlement)).toBe("sync");
  });
});

describe("holes — a parked hole is a request in flight", () => {
  it("siblings keep running while the hole waits, and the stall detector stays quiet", async () => {
    let reachedCount = 0;
    let siblingSettled = false;
    let filled = false;
    let openWhileSiblingSettled: number | undefined;
    const results: FillHoleResult[] = [];
    const { settlement } = await runLowered(
      [
        'const worker = __host.createActor("actor#1", "w");',
        'const side = __host.future(async () => __host.ask("ask#1", worker, "hi"));',
        'const v = await __host.hole("hole#1", "Verdict", undefined, (__src) => eval(__src));',
        "return [await side, v];",
      ].join("\n"),
      {
        askSpecs: untyped("ask#1"),
        asks: { "ask#1": () => ({ type: "text", finalText: "sibling done" }) },
        onEvent: (event, engine) => {
          if (event.type === "hole-reached") reachedCount += 1;
          if (event.type === "node-settled" && event.instance.siteId === "ask#1") {
            openWhileSiblingSettled = reachedCount;
            siblingSettled = true;
          }
          // Fill only after both happen, whichever lands first. Root cause of the fix: filling the moment the sibling settled
          // rejected the fill (hole_not_waiting) when the sibling settled before the hole was reached, leaving the run stuck and the case
          // timing out at 5s -- roughly one run in three. Had stall detection fired, the run would have errored sooner; same conclusion.
          // Raise the flag before filling: fillHole emits hole-filled synchronously and reenters this callback.
          if (reachedCount > 0 && siblingSettled && !filled) {
            filled = true;
            results.push(engine().fillHole(fillFor("(async () => { return 1; })")));
          }
        },
      },
    );
    expect(artifactOf(settlement)).toEqual(["sibling done", 1]);
    // The sibling may settle before or after the hole is reached; in both orders the hole is reached once and filled once.
    expect([0, 1]).toContain(openWhileSiblingSettled);
    expect(reachedCount).toBe(1);
    expect(results).toEqual([{ ok: true }]);
  });

  it("a cancel while parked stops the run and the sandbox goes down with it", async () => {
    const controller = new AbortController();
    const { settlement, driver } = await runLowered(
      'await __host.hole("hole#1", "Verdict", undefined, (__src) => eval(__src)); return "NO";',
      {
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === "hole-reached") controller.abort("user");
        },
      },
    );
    expect(settlement).toEqual({ status: "stopped", reason: "user" });
    expect(driver.eventsOfType("hole-filled")).toEqual([]);
  });

  it("the control binding hands out fillHole, openHoles and filledHoles beside setMaxConcurrency", async () => {
    let bound: BoundEngine | undefined;
    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal);
    await runWorkflowScript({
      cwd: TEST_CWD,
      runId: `holes-${++runSeq}`,
      lowered: "return 1;",
      caps: { maxConcurrency: 4 },
      askSpecs: new Map(),
      validate: () => [],
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
      control: {
        bind(engine) {
          bound = engine;
        },
      },
      timeoutMs: 15000,
    });
    expect(typeof bound?.fillHole).toBe("function");
    // The snapshot projection's two read-only surfaces ride the same binding (run settled: empty parked table, no fills this incarnation).
    expect(bound?.openHoles()).toEqual([]);
    expect(bound?.filledHoles()).toEqual([]);
    // After settlement it is a no-op: settled, no writes, no sends.
    expect(bound?.fillHole(fillFor("(async () => 1)"))).toEqual({ ok: false, reason: "settled" });
  });
});

/** Inner-hole site ids carry the outer prefix (docs/analysis.md, "Sites"): the outer body is part of a valid script, its sites all hole#1/.... */
const INNER = "hole#1/hole#1";

/** The outer fill body: declare a const, reach an inner hole, return the inner value verbatim. */
const OUTER_WITH_INNER = [
  "(async () => {",
  '  const inside = "I" + (typeof i === "undefined" ? "" : i);',
  `  return await __host.hole("${INNER}", "inner", "q", (__src) => eval(__src));`,
  "})",
].join("\n");

describe("holes — recursive: a fill that contains an open hole", () => {
  it("the inner request goes out with the nested siteId, parks only that branch, and its fill reads both scopes", async () => {
    const reached: HoleReached[] = [];
    const results: FillHoleResult[] = [];
    let openWhileInnerParked: unknown;
    const { settlement, driver } = await runLowered(
      [
        'const before = "B";',
        'const worker = __host.createActor("actor#1", "w");',
        'const side = __host.future(async () => __host.ask("ask#1", worker, "hi"));',
        'const v = await __host.hole("hole#1", "outer", "p", (__src) => eval(__src));',
        "return [await side, v];",
      ].join("\n"),
      {
        askSpecs: untyped("ask#1"),
        asks: { "ask#1": () => ({ type: "text", finalText: "sibling done" }) },
        onEvent: (event, engine) => {
          if (event.type !== "hole-reached") return;
          reached.push(event);
          if (event.instance.siteId === "hole#1") {
            results.push(engine().fillHole(fillFor(OUTER_WITH_INNER)));
            return;
          }
          // While the inner hole is parked it is the only in-flight request: delay a real interval before filling. If stall detection counted
          // the parked hole as no-in-flight, the run would error during that window.
          openWhileInnerParked = engine().openHoles();
          setTimeout(() => {
            results.push(
              engine().fillHole(
                fillFor("(async () => { return before + inside; })", {
                  siteId: INNER,
                  askSpecs: untyped("ask#1", "hole#1/ask#1", `${INNER}/ask#1`),
                }),
              ),
            );
          }, 30);
        },
      },
    );
    expect(artifactOf(settlement)).toEqual(["sibling done", "BI"]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(reached.map((e) => [e.instance.siteId, e.instance.ordinal, e.name, e.prompt])).toEqual([
      ["hole#1", 1, "outer", "p"],
      [INNER, 1, "inner", "q"],
    ]);
    expect(openWhileInnerParked).toEqual([
      { siteId: INNER, ordinal: 1, name: "inner", since: expect.any(Number) },
    ]);
    expect(driver.eventsOfType("hole-filled").map((e) => e.siteId)).toEqual(["hole#1", INNER]);
  });

  it("reached again in a loop, both are answered from the cell's fill table and the inner sees the iteration's binding", async () => {
    const results: FillHoleResult[] = [];
    const { settlement, driver } = await runLowered(
      [
        'const before = "B";',
        "const out = [];",
        "for (const i of [1, 2, 3]) {",
        '  out.push(await __host.hole("hole#1", "outer", undefined, (__src) => eval(__src)));',
        "}",
        "return out;",
      ].join("\n"),
      {
        onEvent: (event, engine) => {
          if (event.type !== "hole-reached") return;
          if (event.instance.siteId === "hole#1") {
            results.push(engine().fillHole(fillFor(OUTER_WITH_INNER)));
          } else {
            results.push(
              engine().fillHole(
                fillFor("(async () => { return before + inside; })", { siteId: INNER }),
              ),
            );
          }
        },
      },
    );
    expect(artifactOf(settlement)).toEqual(["BI1", "BI2", "BI3"]);
    // Each site reached once, filled once; the last two rounds cross no wire, outer or inner.
    expect(driver.eventsOfType("hole-reached").map((e) => e.instance.siteId)).toEqual([
      "hole#1",
      INNER,
    ]);
    expect(driver.eventsOfType("hole-filled").map((e) => e.siteId)).toEqual(["hole#1", INNER]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
  });

  it("an inner fill that throws rejects the inner site; uncaught, it propagates out of the outer body to the outer awaiter", async () => {
    const fillBoth = (event: RunEvent, engine: () => BoundEngine): void => {
      if (event.type !== "hole-reached") return;
      if (event.instance.siteId === "hole#1")
        return void engine().fillHole(fillFor(OUTER_WITH_INNER));
      engine().fillHole(
        fillFor('(async () => { throw new Error("inner boom"); })', { siteId: INNER }),
      );
    };
    const uncaught = await runLowered(
      [
        "try {",
        '  await __host.hole("hole#1", "outer", undefined, (__src) => eval(__src));',
        '  return "NO-THROW";',
        "} catch (e) {",
        '  return "outer caught: " + e.message;',
        "}",
      ].join("\n"),
      { onEvent: fillBoth },
    );
    expect(artifactOf(uncaught.settlement)).toBe("outer caught: inner boom");
  });

  it("an inner rejection caught inside the outer body stays inside it", async () => {
    const outerCatching = [
      "(async () => {",
      "  try {",
      `    return await __host.hole("${INNER}", "inner", undefined, (__src) => eval(__src));`,
      "  } catch (e) {",
      '    return "inner caught: " + e.message;',
      "  }",
      "})",
    ].join("\n");
    const { settlement } = await runLowered(
      'return await __host.hole("hole#1", "outer", undefined, (__src) => eval(__src));',
      {
        onEvent: (event, engine) => {
          if (event.type !== "hole-reached") return;
          if (event.instance.siteId === "hole#1")
            return void engine().fillHole(fillFor(outerCatching));
          engine().fillHole(
            fillFor('(async () => { throw new Error("inner boom"); })', { siteId: INNER }),
          );
        },
      },
    );
    expect(artifactOf(settlement)).toBe("inner caught: inner boom");
  });
});
