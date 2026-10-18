/**
 * The ask's two what-is-it-doing facts (docs/execution-engine.md, Events / Progress within an ask):
 *   - the ask node-queued carries the instruction head (instructionsHead, <= 240 chars, no ellipsis);
 *   - driver askProgress is recorded verbatim as node-progress -- no scheduling changes, no dwf_node write,
 *     and, like usage, observations after run settlement are dropped.
 * Fixture posture follows engine-concurrency-observations.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
  INSTRUCTIONS_HEAD_MAX_CHARS,
  InMemoryJournalStore,
  WorkflowEngine,
  type AskSpec,
  type InstanceRef,
} from "../../src/engine/index.js";
import { FakeDriver, flush } from "./fake-driver.js";

const RUN = "run";
const inst = (siteId: string, ordinal = 1): InstanceRef => ({ siteId, ordinal });
const untypedSpecs = (...siteIds: string[]): Map<string, AskSpec> =>
  new Map(siteIds.map((id) => [id, { typed: false } as AskSpec]));

function setup() {
  const journal = new InMemoryJournalStore();
  const driver = new FakeDriver(journal);
  const engine = new WorkflowEngine({
    runId: RUN,
    driver,
    caps: { maxConcurrency: 16 },
    askSpecs: untypedSpecs("ask#1", "ask#2"),
    validate: () => [],
  });
  return { journal, driver, engine };
}

describe("instructionsHead on node-queued", () => {
  it("carries short instructions verbatim, trimmed", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "  Review the auth module error paths  ");
    await flush();
    expect(driver.eventsOfType("node-queued")[0]?.instructionsHead).toBe(
      "Review the auth module error paths",
    );
    engine.askTurnEnded(inst("ask#1"), "done");
    await expect(p).resolves.toBe("done");
  });

  it("truncates long instructions at the cap with no ellipsis (ellipsis is rendering, not payload)", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    const long = "x".repeat(INSTRUCTIONS_HEAD_MAX_CHARS + 50);
    void engine.ask("ask#1", actor, long);
    await flush();
    const head = driver.eventsOfType("node-queued")[0]?.instructionsHead;
    expect(head).toBe("x".repeat(INSTRUCTIONS_HEAD_MAX_CHARS));
    expect(head?.endsWith("…")).toBe(false);
  });

  it("omits the key for empty instructions rather than writing an empty string", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    void engine.ask("ask#1", actor, "   \n  ");
    await flush();
    expect(driver.eventsOfType("node-queued")[0]).not.toHaveProperty("instructionsHead");
  });

  it("leaves it off world-read node-queued (there is no author instruction there)", async () => {
    const { engine, driver } = setup();
    void engine.worldRead("world#1", "files.glob", ["**/*.ts"]);
    await flush();
    const queued = driver.eventsOfType("node-queued").find((e) => e.kind !== "ask");
    expect(queued).toBeDefined();
    expect(queued).not.toHaveProperty("instructionsHead");
  });
});

describe("askProgress to node-progress (pure passthrough)", () => {
  it("records the event verbatim, before that turn's usage-updated", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    await flush();
    driver.events.length = 0;

    engine.askProgress(inst("ask#1"), {
      turn: 2,
      toolCalls: 7,
      lastTool: { name: "Read", target: "src/auth/session.ts" },
    });
    engine.askStats(inst("ask#1"), { tokens: 20, toolCalls: 7, turns: 2 });

    expect(driver.events.map((e) => e.type)).toEqual(["node-progress", "usage-updated"]);
    expect(driver.eventsOfType("node-progress")[0]).toEqual({
      type: "node-progress",
      instance: { siteId: "ask#1", ordinal: 1 },
      turn: 2,
      toolCalls: 7,
      lastTool: { name: "Read", target: "src/auth/session.ts" },
    });
    engine.askTurnEnded(inst("ask#1"), "R");
    await expect(p).resolves.toBe("R");
  });

  it("omits lastTool from the event when absent", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    void engine.ask("ask#1", actor, "A");
    await flush();
    engine.askProgress(inst("ask#1"), { turn: 1, toolCalls: 0 });
    expect(driver.eventsOfType("node-progress")[0]).not.toHaveProperty("lastTool");
  });

  it("touches no scheduling: no dwf_node row, ask settlement untouched", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    await flush();
    const before = journal.getNode(RUN, "ask#1", 1);
    engine.askProgress(inst("ask#1"), { turn: 1, toolCalls: 3 });
    expect(journal.getNode(RUN, "ask#1", 1)).toEqual(before);
    expect(driver.startAskCount()).toBe(1);
    engine.askTurnEnded(inst("ask#1"), "R");
    await expect(p).resolves.toBe("R");
    expect(journal.getNode(RUN, "ask#1", 1)?.status).toBe("completed");
  });

  it("journal rows match the live track object-for-object", async () => {
    const { engine, journal } = setup();
    const actor = engine.createActor("actor#1");
    void engine.ask("ask#1", actor, "A");
    await flush();
    engine.askProgress(inst("ask#1"), { turn: 1, toolCalls: 1, lastTool: { name: "Bash" } });
    const stored = journal
      .listEvents(RUN, { types: "all", reportItems: "all" })
      .filter((e) => e.event.type === "node-progress");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.event).toMatchObject({ turn: 1, toolCalls: 1, lastTool: { name: "Bash" } });
  });

  it("drops observations after run settlement, same as usage (no long tail on finished runs)", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    await flush();
    engine.askTurnEnded(inst("ask#1"), "R");
    await expect(p).resolves.toBe("R");
    engine.complete(undefined);
    driver.events.length = 0;
    engine.askProgress(inst("ask#1"), { turn: 9, toolCalls: 9 });
    expect(driver.eventsOfType("node-progress")).toHaveLength(0);
  });
});
