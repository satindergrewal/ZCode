/**
 * Replay settlement order (docs/execution-engine.md, Replaying the settle order).
 *
 * Reproduces the production incident: fan-out branches report after await, so report ordinals record in
 * completion order; if resume released cached settlements in admission order the same ordinal would land on
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryJournalStore,
  WorkflowEngine,
  refToString,
  type AskSpec,
  type InstanceRef,
  type WorkflowDriver,
} from "../../src/engine/index.js";
import { ReplaySettleOrder, recoverSettleOrder } from "../../src/engine/replay-order.js";
import { FakeDriver, flush } from "./fake-driver.js";

const RUN = "run";
const DIMS = ["alpha", "beta", "gamma"] as const;

function inst(siteId: string, ordinal = 1): InstanceRef {
  return { siteId, ordinal };
}

const untypedSpecs = (...siteIds: string[]): Map<string, AskSpec> =>
  new Map(siteIds.map((id) => [id, { typed: false } as AskSpec]));

function engineOver(journal: InMemoryJournalStore, driver: WorkflowDriver): WorkflowEngine {
  return new WorkflowEngine({
    runId: RUN,
    driver,
    caps: { maxConcurrency: 16 },
    askSpecs: untypedSpecs("ask#1", "ask#2"),
    validate: () => [],
  });
}

/**
 * The test plays the sandbox script. One fan-out branch: create an actor, ask once, report when the answer lands --
 */
async function branch(engine: WorkflowEngine, dim: string): Promise<unknown> {
  const actor = engine.createActor("actor#1", `researcher-${dim}`);
  engine.report("report#1", { dim, status: "researching" });
  const answer = await engine.ask("ask#1", actor, `research ${dim}`);
  engine.report("report#2", { dim, status: "done" });
  return answer;
}

const fanOut = (engine: WorkflowEngine): Promise<unknown[]> =>
  Promise.all(DIMS.map((dim) => branch(engine, dim)));

/** A site's journal rows, results in ascending ordinal order. */
function rowsAt(journal: InMemoryJournalStore, siteId: string): unknown[] {
  return journal
    .listNodes(RUN, { kinds: "all", withResult: true })
    .filter((n) => n.siteId === siteId)
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((n) => n.result);
}

describe("replay settle order — the fan-out report bug", () => {
  it("replays the journaled settle order, so ordinals after a join land where the journal has them", async () => {
    const journal = new InMemoryJournalStore();

    // --- Incarnation one: three branches in parallel, answers landing 3 then 1, the process dying mid-second. ---
    const driver1 = new FakeDriver(journal);
    const e1 = engineOver(journal, driver1);
    void fanOut(e1).catch(() => {}); // stop() rejects this incarnation's fan-out with Cancelled
    await flush();
    expect(driver1.startAskCount()).toBe(3);

    e1.askTurnEnded(inst("ask#1", 3), "r3");
    await flush();
    e1.askTurnEnded(inst("ask#1", 1), "r1");
    await flush();
    e1.stop("interrupted");
    await flush();

    // Completion order 3 then 1, so report#2's ordinal is not array order.
    expect(rowsAt(journal, "report#2")).toEqual([
      { dim: "gamma", status: "done" },
      { dim: "alpha", status: "done" },
    ]);
    // report#1 precedes the await, hence always array order.
    expect(rowsAt(journal, "report#1")).toEqual([
      { dim: "alpha", status: "researching" },
      { dim: "beta", status: "researching" },
      { dim: "gamma", status: "researching" },
    ]);

    // --- Incarnation two: same script, same journal. ---
    const driver2 = new FakeDriver(journal);
    const e2 = engineOver(journal, driver2);
    const replayed = fanOut(e2);
    await flush();

    // Cached settlements release in recorded completion order, not admission order.
    expect(driver2.cachedSettleOrder()).toEqual(["ask#1@3", "ask#1@1"]);
    // The in-flight one re-dispatches live; zero others.
    expect(driver2.startedInstanceKeys()).toEqual(new Set(["ask#1@2"]));

    e2.askTurnEnded(inst("ask#1", 2), "r2");
    await expect(replayed).resolves.toEqual(["r1", "r2", "r3"]);

    // No InputHashMismatch death; not one journal report row touched.
    expect(journal.getRun(RUN)?.failure).toBeUndefined();
    expect(rowsAt(journal, "report#2")).toEqual([
      { dim: "gamma", status: "done" },
      { dim: "alpha", status: "done" },
      { dim: "beta", status: "done" },
    ]);
    // Replay-hit reports skip silently; only this incarnation's newly-run one emits.
    expect(driver2.eventsOfType("report").map((e) => e.item)).toEqual([
      { dim: "beta", status: "done" },
    ]);

    e2.complete("done");
    await expect(e2.settled).resolves.toMatchObject({ status: "completed" });
  });

  it("keeps the same schedule on a third life", async () => {
    const journal = new InMemoryJournalStore();

    const driver1 = new FakeDriver(journal);
    const e1 = engineOver(journal, driver1);
    void fanOut(e1).catch(() => {}); // stop() rejects this incarnation's fan-out with Cancelled
    await flush();
    e1.askTurnEnded(inst("ask#1", 2), "r2");
    await flush();
    e1.askTurnEnded(inst("ask#1", 3), "r3");
    await flush();
    e1.stop("interrupted");
    await flush();

    // Incarnation two: two hits, one re-run settling, interrupted again.
    const driver2 = new FakeDriver(journal);
    const e2 = engineOver(journal, driver2);
    void fanOut(e2).catch(() => {});
    await flush();
    expect(driver2.cachedSettleOrder()).toEqual(["ask#1@2", "ask#1@3"]);
    e2.askTurnEnded(inst("ask#1", 1), "r1");
    await flush();
    e2.stop("interrupted");
    await flush();

    // Incarnation three: all three hit. Birth order (2, 3) leads; 1, finished only in incarnation two, follows.
    const driver3 = new FakeDriver(journal);
    const e3 = engineOver(journal, driver3);
    const replayed = fanOut(e3);
    await flush();
    expect(driver3.cachedSettleOrder()).toEqual(["ask#1@2", "ask#1@3", "ask#1@1"]);
    expect(driver3.startAskCount()).toBe(0);
    await expect(replayed).resolves.toEqual(["r1", "r2", "r3"]);
    expect(journal.getRun(RUN)?.failure).toBeUndefined();
    expect(driver3.eventsOfType("report")).toEqual([]);
  });

  it("never leaves a parked hit hanging when the run settles mid-replay", async () => {
    // The gate's safety net: the run stopped while the head claim was pending -- the parked hit must still
    const journal = new InMemoryJournalStore();

    const driver1 = new FakeDriver(journal);
    const e1 = engineOver(journal, driver1);
    const one = e1.createActor("actor#1", "one");
    const two = e1.createActor("actor#1", "two");
    const p1 = e1.ask("ask#1", one, "A");
    const p2 = e1.ask("ask#1", two, "B");
    await flush();
    // The second settles first, recording [ask#1@2, ask#1@1].
    e1.askTurnEnded(inst("ask#1", 2), "rB");
    await flush();
    e1.askTurnEnded(inst("ask#1", 1), "rA");
    await expect(Promise.all([p1, p2])).resolves.toEqual(["rA", "rB"]);
    e1.stop("interrupted");
    await flush();

    // Incarnation two stops at the first: still waiting on ask#1@2 to yield, and no one ever claims it.
    const driver2 = new FakeDriver(journal);
    const e2 = engineOver(journal, driver2);
    const actor = e2.createActor("actor#1", "one");
    const replayed = e2.ask("ask#1", actor, "A");
    await flush();
    expect(driver2.cachedSettleOrder()).toEqual([]);

    e2.stop("user");
    await expect(replayed).resolves.toBe("rA");
    const types = driver2.events.map((e) => e.type);
    expect(types.indexOf("node-settled")).toBeLessThan(types.indexOf("run-settled"));
  });

  it("still fails loudly when the script really is nondeterministic", async () => {
    const journal = new InMemoryJournalStore();

    const driver1 = new FakeDriver(journal);
    const e1 = engineOver(journal, driver1);
    const actor1 = e1.createActor("actor#1", "one");
    const p1 = e1.ask("ask#1", actor1, "first instructions");
    await flush();
    e1.askTurnEnded(inst("ask#1"), "r1");
    await p1;
    e1.stop("interrupted");
    await flush();

    // Same site, same ordinal, different instruction -- the pre-release defensive check still fails loudly.
    const driver2 = new FakeDriver(journal);
    const e2 = engineOver(journal, driver2);
    const actor2 = e2.createActor("actor#1", "one");
    await expect(e2.ask("ask#1", actor2, "other instructions")).rejects.toMatchObject({
      code: "InputHashMismatch",
    });
    await expect(e2.settled).resolves.toMatchObject({ status: "errored" });
  });
});

describe("replay settle order — world reads and artifacts", () => {
  it("releases cached world reads in the journaled order", async () => {
    const journal = new InMemoryJournalStore();
    const seen: string[] = [];

    const script = async (engine: WorkflowEngine): Promise<void> => {
      await Promise.all(
        ["a", "b"].map(async (name) => {
          const files = await engine.worldRead("world#1", "glob", [name]);
          seen.push(String(files));
          engine.report("report#1", { name, files });
        }),
      );
    };

    const driver1 = new FakeDriver(journal);
    const e1 = engineOver(journal, driver1);
    void script(e1).catch(() => {});
    await flush();
    // The second glob returns first.
    driver1.worldReads[1]?.deferred.resolve("files-b");
    await flush();
    driver1.worldReads[0]?.deferred.resolve("files-a");
    await flush();
    expect(rowsAt(journal, "report#1")).toEqual([
      { name: "b", files: "files-b" },
      { name: "a", files: "files-a" },
    ]);
    e1.stop("interrupted");

    seen.length = 0;
    const driver2 = new FakeDriver(journal);
    const e2 = engineOver(journal, driver2);
    await script(e2);
    expect(driver2.worldReads).toEqual([]);
    expect(seen).toEqual(["files-b", "files-a"]);
    expect(journal.getRun(RUN)?.failure).toBeUndefined();
    expect(driver2.eventsOfType("report")).toEqual([]);
  });

  it("gates content artifacts and never waits on a preset declaration", async () => {
    const journal = new InMemoryJournalStore();

    const script = async (engine: WorkflowEngine): Promise<void> => {
      // A predeclaration is synchronous void: journal row plus artifact-published, never claiming the gate.
      engine.declareArtifact("artifact#0", "board", [
        "board-1",
        { key: "dim", status: "status", columns: ["doing", "done"] },
      ]);
      await Promise.all(
        ["a", "b"].map(async (name) => {
          await engine.publishArtifact("artifact#1", "markdown", [`doc-${name}`, `# ${name}`]);
          engine.report("report#1", { name });
        }),
      );
    };

    const driver1 = new FakeDriver(journal, { deferArtifactPublishes: true });
    const e1 = engineOver(journal, driver1);
    void script(e1).catch(() => {});
    await flush();
    const [first, second] = driver1.artifactDeferrals;
    // The second publish finishes first.
    second?.resolve(driver1.artifactStore.get("doc-b@1")!);
    await flush();
    first?.resolve(driver1.artifactStore.get("doc-a@1")!);
    await flush();
    expect(rowsAt(journal, "report#1")).toEqual([{ name: "b" }, { name: "a" }]);
    e1.stop("interrupted");

    const driver2 = new FakeDriver(journal, { deferArtifactPublishes: true });
    const e2 = engineOver(journal, driver2);
    await script(e2);
    expect(driver2.artifactPublishes).toEqual([]);
    expect(journal.getRun(RUN)?.failure).toBeUndefined();
    expect(driver2.eventsOfType("report")).toEqual([]);
  });
});

describe("ReplaySettleOrder", () => {
  const key = (siteId: string, ordinal: number): string => refToString({ siteId, ordinal });

  it("releases parked entries in the recorded order, never inside the call that parked one", async () => {
    const gate = new ReplaySettleOrder([key("ask#1", 2), key("ask#1", 1)]);
    const released: string[] = [];
    gate.hold(inst("ask#1", 1), () => released.push("1"));
    expect(released).toEqual([]);
    // Even when its turn comes, no delivery inside this call: the caller's await is not attached yet
    gate.hold(inst("ask#1", 2), () => released.push("2"));
    expect(released).toEqual([]);
    await flush();
    expect(released).toEqual(["2", "1"]);
  });

  it("passes through instances it has no entry for", () => {
    const gate = new ReplaySettleOrder([key("ask#1", 1)]);
    const released: string[] = [];
    gate.hold(inst("ask#9", 7), () => released.push("unknown"));
    expect(released).toEqual(["unknown"]);
  });

  it("opens for good on settlement, draining what is parked in recorded order", () => {
    const gate = new ReplaySettleOrder([key("ask#1", 1), key("ask#1", 2), key("ask#1", 3)]);
    const released: string[] = [];
    gate.hold(inst("ask#1", 3), () => released.push("3"));
    gate.hold(inst("ask#1", 2), () => released.push("2"));
    expect(released).toEqual([]);
    gate.open();
    expect(released).toEqual(["2", "3"]);
    gate.hold(inst("ask#1", 1), () => released.push("1"));
    expect(released).toEqual(["2", "3", "1"]);
  });
});

describe("recoverSettleOrder", () => {
  function seed(): InMemoryJournalStore {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 4 },
      spentTokens: 0,
      status: "running",
    });
    return journal;
  }

  it("takes the first settle of each instance and keeps only terminal, promise-returning rows", () => {
    const journal = seed();
    const put = (
      siteId: string,
      ordinal: number,
      kind: "ask" | "report",
      status: "completed" | "running",
      result?: unknown,
    ): void => {
      journal.putNode({
        runId: RUN,
        siteId,
        ordinal,
        kind,
        inputHash: "h",
        status,
        ...(result === undefined ? {} : { result }),
      });
    };
    put("ask#1", 1, "ask", "completed");
    put("ask#1", 2, "ask", "completed");
    put("ask#1", 3, "ask", "running"); // interrupted: re-run, not released
    put("report#1", 1, "report", "completed"); // void: never enters the order table

    journal.appendEvent(RUN, { type: "node-settled", instance: inst("ask#1", 2), outcome: "ok" });
    journal.appendEvent(RUN, { type: "report", instance: inst("report#1", 1), item: {} });
    journal.appendEvent(RUN, { type: "node-settled", instance: inst("ask#1", 1), outcome: "ok" });
    journal.appendEvent(RUN, {
      type: "node-settled",
      instance: inst("ask#1", 3),
      outcome: "cancelled",
    });
    // The incarnation-two replay emits too: birth order first, duplicates stay out of the table.
    journal.appendEvent(RUN, {
      type: "node-settled",
      instance: inst("ask#1", 1),
      outcome: "ok",
      cached: true,
    });

    expect(recoverSettleOrder(journal, RUN).recorded()).toEqual(["ask#1@2", "ask#1@1"]);
  });

  it("keeps content artifacts and drops preset declarations", () => {
    const journal = seed();
    journal.putNode({
      runId: RUN,
      siteId: "artifact#1",
      ordinal: 1,
      kind: "artifact",
      inputHash: "h",
      status: "completed",
      artifactId: "doc",
      result: { id: "doc", kind: "markdown", version: 1 },
    });
    journal.putNode({
      runId: RUN,
      siteId: "artifact#0",
      ordinal: 1,
      kind: "artifact",
      inputHash: "h",
      status: "completed",
      artifactId: "board",
      result: { id: "board", kind: "board", version: 1 },
    });
    journal.appendEvent(RUN, {
      type: "artifact-published",
      instance: inst("artifact#0", 1),
      artifact: { id: "board", kind: "board", version: 1 },
    });
    journal.appendEvent(RUN, {
      type: "artifact-published",
      instance: inst("artifact#1", 1),
      artifact: { id: "doc", kind: "markdown", version: 1 },
    });

    expect(recoverSettleOrder(journal, RUN).recorded()).toEqual(["artifact#1@1"]);
  });

  it("is empty for a journal whose events predate the rule", () => {
    const journal = seed();
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      inputHash: "h",
      status: "completed",
      result: "r",
    });
    expect(recoverSettleOrder(journal, RUN).recorded()).toEqual([]);
  });
});
