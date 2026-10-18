/**
 * Resume e2e: run the script to completion and journal it; then re-run on a brand-new child with the same journal and a
 * every-startAsk-fails driver -- pure replay, zero dispatches (journal hits short-circuit).
 * See "Resume" and "Journal-write timing" in docs/execution-engine.md.
 */

import { describe, expect, it } from "vitest";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";
import { runScript } from "./helpers.js";

const RUN = "run";

const SCRIPT = [
  "interface Verdict { approved: boolean; reason: string; }",
  'const paths = await files.glob("src/**/*.ts");',
  "const verdicts = await Promise.all(",
  // Per-element names: each fan-out element is a new actor; a shared static name hits the runtime
  // DuplicateActorName (the compiler has its own 9005 fan-out clause; see analysis/actor-names.ts).
  "  paths.map((p) => agent(`reviewer-${p}`).ask<Verdict>(`Review ${p}`)),",
  ");",
  'const lead = agent("lead");',
  "const summary = await lead.ask(`Reviewed ${paths.length} files`);",
  "return { reviewed: paths.length, summary, rejected: verdicts.filter((v) => !v.approved).length };",
].join("\n");

describe("e2e — resume by pure replay", () => {
  it("re-runs over a populated journal with a fresh child and zero driver dispatches", async () => {
    const paths = ["src/a.ts", "src/b.ts"];
    const journal = new InMemoryJournalStore();

    // First pass: live execution, journal recorded.
    const first = await runScript(SCRIPT, {
      journal,
      worldReads: () => paths,
      asks: {
        "ask#1": ({ message }) => ({
          type: "submit",
          payload: { approved: !message.instructions.includes("src/b.ts"), reason: "r" },
        }),
        "ask#2": () => ({ type: "text", finalText: "all reviewed" }),
      },
    });
    expect(first.settlement).toEqual({
      status: "completed",
      artifact: { reviewed: 2, summary: "all reviewed", rejected: 1 },
    });
    expect(first.driver.startAskCount()).toBe(3); // 2 review + 1 summary

    // Second pass: brand-new child, same journal; any driver live effect counts as failure (pure replay expected).
    const second = await runScript(SCRIPT, {
      journal,
      worldReads: () => {
        throw new Error("resume must not hit world-read (journal should serve it)");
      },
      onStartAsk: (instance) => {
        throw new Error(`resume must not startAsk: ${instance.siteId}@${instance.ordinal}`);
      },
    });

    // Byte-identical artifact, zero dispatches.
    expect(second.settlement).toEqual(first.settlement);
    expect(second.driver.startAskCount()).toBe(0);
    expect(second.driver.sessionCreations).toHaveLength(0);
    // Replay hits surface as cached settlements.
    const cached = second.driver.eventsOfType("node-settled").filter((e) => e.cached === true);
    expect(cached.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps the first run's journaled node results intact on resume", async () => {
    const journal = new InMemoryJournalStore();
    await runScript(SCRIPT, {
      journal,
      worldReads: () => ["only.ts"],
      asks: {
        "ask#1": () => ({ type: "submit", payload: { approved: true, reason: "clean" } }),
        "ask#2": () => ({ type: "text", finalText: "done" }),
      },
    });
    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.result).toEqual({ approved: true, reason: "clean" });

    await runScript(SCRIPT, {
      journal,
      worldReads: () => {
        throw new Error("no world-read on resume");
      },
      onStartAsk: () => {
        throw new Error("no dispatch on resume");
      },
    });
    // Node results unchanged after resume.
    expect(journal.getNode(RUN, "ask#1", 1)?.result).toEqual({ approved: true, reason: "clean" });
  });

  it("re-dispatches the interrupted ask on a re-created actor session after a cancel", async () => {
    // The cancel-and-resume feature, end to end: pass one is cancelled mid-ask#2 (journal keeps the running row
    // and the actor keeps its sessionId); pass two must (a) short-circuit ask#1, (b) rebuild the actor session via the driver,
    // and (c) re-dispatch ask#2 to completion. Asserting (b) is the point: if registerActor short-circuits sessions from the
    // journal, the production driver's sessions map is empty and re-dispatch fails as unknown-session on a real driver.
    const TWO_ASKS = [
      'const worker = agent("worker");',
      'const first = await worker.ask("first task");',
      "const second = await worker.ask(`second after ${first}`);",
      "return { first, second };",
    ].join("\n");

    const journal = new InMemoryJournalStore();
    const controller = new AbortController();

    // Pass one: ask#1 completes; ask#2 cancels the whole run on dispatch.
    const first = await runScript(TWO_ASKS, {
      journal,
      signal: controller.signal,
      asks: { "ask#1": () => ({ type: "text", finalText: "R1" }) },
      onStartAsk: (instance) => {
        if (instance.siteId === "ask#2") controller.abort();
      },
    });
    expect(first.settlement).toEqual({ status: "stopped", reason: "user" });
    expect(journal.getNode(RUN, "ask#1", 1)?.status).toBe("completed");
    expect(journal.getNode(RUN, "ask#2", 1)?.status).toBe("running"); // admission row kept
    expect(journal.getActor(RUN, "actor#1", 1)?.sessionId).toBeDefined();

    // Pass two: resume on the same journal.
    const second = await runScript(TWO_ASKS, {
      journal,
      asks: { "ask#2": () => ({ type: "text", finalText: "R2" }) },
      onStartAsk: (instance) => {
        if (instance.siteId !== "ask#2") {
          throw new Error(
            `only ask#2 may be re-dispatched, got ${instance.siteId}@${instance.ordinal}`,
          );
        }
      },
    });
    expect(second.settlement).toEqual({
      status: "completed",
      artifact: { first: "R1", second: "R2" },
    });
    // ask#1 short-circuits (zero dispatch); ask#2 re-dispatches exactly once.
    expect(second.driver.startAskCount()).toBe(1);
    // The session is rebuilt via the driver -- not a bare reference short-circuited from the journal.
    expect(second.driver.sessionCreations).toEqual([{ siteId: "actor#1", ordinal: 1 }]);
  });
});

/**
 * Fan-out branches report after await: ordinals record in completion order. This end-to-end
 * case runs the accident on a real sandbox child -- the first review takes a repair lap and thus settles later than the second,
 * so journal report#1@1 is the second file. Resume must release hits in the recorded settlement order, or the first
 * branch's continuation runs first, report#1@1 gets another branch's item, and the run dies with InputHashMismatch.
 * See "Replaying the settle order" in docs/execution-engine.md.
 */
describe("e2e — resume of a fan-out that reports after the join", () => {
  const FAN_OUT = [
    "interface Verdict { approved: boolean; reason: string; }",
    'const paths = await files.glob("src/**/*.ts");',
    "const verdicts = await Promise.all(",
    "  paths.map(async (p) => {",
    "    const v = await agent(`reviewer-${p}`).ask<Verdict>(`Review ${p}`);",
    "    report({ path: p, approved: v.approved });",
    "    return v;",
    "  }),",
    ");",
    "return { reviewed: verdicts.length };",
  ].join("\n");

  const PATHS = ["src/a.ts", "src/b.ts"];

  it("resumes without an InputHashMismatch and never re-reports an item", async () => {
    const journal = new InMemoryJournalStore();

    // Pass one: src/a.ts first submits a schema-invalid answer; the repair costs a lap, so it settles later.
    // The repair step waits on a real timer (delayMs), not just one more microtask: the two ask request lines can land in
    // two stdout chunks admitted in two ticks (measured admission gaps jumping from 0.03ms to
    // 0.15ms); then a's whole repair chain finishes before b's request arrives and extra-lap no longer means later-settlement.
    // Only a real time gap keeps completion-order != array-order true under any chunk split.
    const first = await runScript(FAN_OUT, {
      journal,
      worldReads: () => PATHS,
      asks: {
        "ask#1": ({ message }) =>
          message.instructions.includes("src/a.ts")
            ? [
                { type: "submit", payload: { approved: true } }, // no reason -> violation, repair required
                { type: "submit", payload: { approved: true, reason: "fixed" }, delayMs: 30 },
              ]
            : { type: "submit", payload: { approved: false, reason: "nit" } },
      },
    });
    expect(first.settlement).toEqual({ status: "completed", artifact: { reviewed: 2 } });

    const reportRows = journal
      .listNodes(RUN, { kinds: "all", withResult: true })
      .filter((n) => n.kind === "report")
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((n) => n.result);
    // Completion order != array order: the later-settling src/a.ts sits second.
    expect(reportRows).toEqual([
      { path: "src/b.ts", approved: false },
      { path: "src/a.ts", approved: true },
    ]);

    // Pass two: brand-new child, same journal, zero driver effects.
    const second = await runScript(FAN_OUT, {
      journal,
      worldReads: () => {
        throw new Error("resume must not hit world-read (journal should serve it)");
      },
      onStartAsk: (instance) => {
        throw new Error(`resume must not startAsk: ${instance.siteId}@${instance.ordinal}`);
      },
    });

    expect(second.settlement).toEqual(first.settlement);
    expect(journal.getRun(RUN)?.failure).toBeUndefined();
    expect(second.driver.startAskCount()).toBe(0);
    // Hits release in the recorded settlement order.
    expect(
      second.driver
        .eventsOfType("node-settled")
        .filter((e) => e.cached === true)
        .map((e) => `${e.instance.siteId}@${e.instance.ordinal}`),
    ).toEqual(["world-read#1@1", "ask#1@2", "ask#1@1"]);
    // report hits skip silently: nothing re-emitted, no row touched.
    expect(second.driver.eventsOfType("report")).toEqual([]);
    expect(
      journal
        .listNodes(RUN, { kinds: "all", withResult: true })
        .filter((n) => n.kind === "report")
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((n) => n.result),
    ).toEqual(reportRows);
  });
});
