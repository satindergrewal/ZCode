/**
 * Retuning this run's own concurrency bound in place (engine.setMaxConcurrency; docs/dynamic-workflow/
 *
 * Same fixture posture as engine-concurrency-observations.test.ts, separate file: that one covers the three
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryJournalStore,
  WorkflowEngine,
  type AskSpec,
  type Caps,
  type InstanceRef,
  type RunEvent,
} from "../../src/engine/index.js";
import { FakeDriver, flush } from "./fake-driver.js";

const RUN = "run";
const inst = (siteId: string, ordinal = 1): InstanceRef => ({ siteId, ordinal });
const untypedSpecs = (...siteIds: string[]): Map<string, AskSpec> =>
  new Map(siteIds.map((id) => [id, { typed: false } as AskSpec]));

const SITES = ["ask#1", "ask#2", "ask#3"] as const;

function setup(caps: Caps, journal = new InMemoryJournalStore()) {
  const driver = new FakeDriver(journal);
  const engine = new WorkflowEngine({
    runId: RUN,
    driver,
    caps,
    askSpecs: untypedSpecs(...SITES),
    validate: () => [],
  });
  return { journal, driver, engine };
}

/**
 * One ask per actor: the scheduler serializes per actor, so can-one-more-dispatch is the bound alone.
 */
function askEachOnItsOwnActor(engine: WorkflowEngine, count: number): Array<Promise<unknown>> {
  return SITES.slice(0, count).map((siteId, i) => {
    const actor = engine.createActor(`actor#${i + 1}`);
    return engine.ask(siteId, actor, `A${i + 1}`);
  });
}

const capsEvents = (driver: FakeDriver): Array<Extract<RunEvent, { type: "run-caps-changed" }>> =>
  driver.eventsOfType("run-caps-changed");

describe("WorkflowEngine -- setMaxConcurrency (in-place bound retune)", () => {
  it("lowering stops new dispatches while in-flight asks finish", async () => {
    const { engine, driver } = setup({ maxConcurrency: 2 });
    const [p1, p2, p3] = askEachOnItsOwnActor(engine, 3);
    await flush();
    expect(driver.startAskCount()).toBe(2);

    expect(engine.setMaxConcurrency(1)).toBe(true);
    await flush();
    // Lowering recalls nothing dispatched and conjures no extra dispatch.
    expect(driver.startAskCount()).toBe(2);
    expect(driver.cancels).toEqual([]);

    // One ask still in flight after another settles -> the queued third may not be released.
    engine.askTurnEnded(inst("ask#1"), "R1");
    await expect(p1).resolves.toBe("R1");
    await flush();
    expect(driver.startAskCount()).toBe(2);

    // It waits for zero in flight.
    engine.askTurnEnded(inst("ask#2"), "R2");
    await expect(p2).resolves.toBe("R2");
    await flush();
    expect(driver.startAskCount()).toBe(3);
    engine.askTurnEnded(inst("ask#3"), "R3");
    await expect(p3).resolves.toBe("R3");
  });

  it("raising dispatches queued asks immediately, no settlement needed", async () => {
    const { engine, driver } = setup({ maxConcurrency: 1 });
    const asks = askEachOnItsOwnActor(engine, 3);
    await flush();
    expect(driver.startAskCount()).toBe(1);

    expect(engine.setMaxConcurrency(3)).toBe(true);
    await flush();
    expect(driver.startAskCount()).toBe(3);

    for (const [i, site] of SITES.entries()) engine.askTurnEnded(inst(site), `R${i + 1}`);
    await expect(Promise.all(asks)).resolves.toEqual(["R1", "R2", "R3"]);
  });

  it("emits one event with before/after caps and writes the new value into the journal row", () => {
    const { engine, driver, journal } = setup({ maxConcurrency: 8 });
    expect(engine.setMaxConcurrency(2)).toBe(true);

    expect(capsEvents(driver)).toEqual([
      {
        type: "run-caps-changed",
        runId: RUN,
        caps: { maxConcurrency: 2 },
        previous: { maxConcurrency: 8 },
      },
    ]);
    expect(journal.getRun(RUN)?.caps).toEqual({ maxConcurrency: 2 });
    // Only that column: status and usage are outside this write's scope.
    expect(journal.getRun(RUN)?.status).toBe("running");

    // The event journals too (both tracks get the same object).
    const stored = journal
      .listEvents(RUN, { types: "all", reportItems: "all" })
      .filter((e) => e.event.type === "run-caps-changed");
    expect(stored).toHaveLength(1);
  });

  it("returns false on same-value with no write or event", () => {
    const { engine, driver, journal } = setup({ maxConcurrency: 4 });
    const eventsBefore = driver.events.length;
    expect(engine.setMaxConcurrency(4)).toBe(false);
    expect(driver.events.length).toBe(eventsBefore);
    expect(capsEvents(driver)).toEqual([]);
    expect(journal.getRun(RUN)?.caps).toEqual({ maxConcurrency: 4 });
  });

  it("returns false once settled, no write or event (callers fall back to a real amend on races)", () => {
    const { engine, driver, journal } = setup({ maxConcurrency: 4 });
    engine.complete("done");
    const eventsBefore = driver.events.length;

    expect(engine.setMaxConcurrency(1)).toBe(false);
    expect(driver.events.length).toBe(eventsBefore);
    expect(capsEvents(driver)).toEqual([]);
    expect(journal.getRun(RUN)?.caps).toEqual({ maxConcurrency: 4 });
  });

  it("rejects non-finite values per the record normalization, never poisoning caps_max_concurrency", () => {
    const { engine, driver, journal } = setup({ maxConcurrency: 4 });
    expect(engine.setMaxConcurrency(Number.NaN)).toBe(false);
    // Clamping into [1, ...] equaling the current value is a no-op too (real ceiling clamps live caller-side).
    expect(engine.setMaxConcurrency(0)).toBe(true);
    expect(journal.getRun(RUN)?.caps).toEqual({ maxConcurrency: 1 });
    expect(capsEvents(driver)).toHaveLength(1);
  });

  it("reads the retuned value on resume with replay still deterministic, hit asks undispatched", async () => {
    const journal = new InMemoryJournalStore();
    const first = setup({ maxConcurrency: 8 }, journal);
    const actor = first.engine.createActor("actor#1");
    const p = first.engine.ask("ask#1", actor, "A1");
    await flush();
    expect(first.engine.setMaxConcurrency(2)).toBe(true);
    first.engine.askTurnEnded(inst("ask#1"), "R1");
    await expect(p).resolves.toBe("R1");
    first.engine.stop("user");

    // Resume caps come from the journal row (the host reads the same: dynamic-workflow-run-submit's record.caps).
    const resumedCaps = journal.getRun(RUN)!.caps;
    expect(resumedCaps).toEqual({ maxConcurrency: 2 });

    const second = setup(resumedCaps, journal);
    const actor2 = second.engine.createActor("actor#1");
    await expect(second.engine.ask("ask#1", actor2, "A1")).resolves.toBe("R1");
    await flush();
    // Hits short-circuit: the extra run-caps-changed row never enters replay decisions.
    expect(second.driver.startAskCount()).toBe(0);
    expect(second.driver.cachedSettleOrder()).toEqual(["ask#1@1"]);
    expect(second.driver.eventsOfType("run-started")[0]?.caps).toEqual({ maxConcurrency: 2 });
    expect(capsEvents(second.driver)).toEqual([]);
  });
});
