/**
 * The engine side of the three adaptive-concurrency observations (docs/dynamic-workflow/concurrency.md,
 * The engine only records them, deciding nothing; the fixture posture matches engine.test.ts, in its own file
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryJournalStore,
  WorkflowEngine,
  WorkflowError,
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

const eventTypes = (driver: FakeDriver): string[] => driver.events.map((e) => e.type);

describe("WorkflowEngine -- dispatch through no slots", () => {
  it("has no acquireSlot on WorkflowDriver; node-dispatched plus startAsk right after the session", async () => {
    const { engine, driver } = setup();
    expect((driver as { acquireSlot?: unknown }).acquireSlot).toBeUndefined();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    await flush();
    expect(eventTypes(driver)).toEqual([
      "run-started",
      "actor-created",
      "node-queued",
      "node-dispatched",
    ]);
    expect(driver.startAskCount()).toBe(1);
    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");
  });

  it("records driver-side failures as node-settled with DriverError (model-layer attribution fields are gone)", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    await flush();
    engine.askFailed(inst("ask#1"), new WorkflowError("DriverError", "boom"));
    await expect(p).rejects.toMatchObject({ code: "DriverError" });
    const settled = driver.eventsOfType("node-settled");
    expect(settled[0]?.error).toEqual({ code: "DriverError", message: "boom" });
  });

  // Deterministic model-side error (docs/execution-engine.md): no node settlement; the run stops
  it("stops the whole run on stopRun(ProviderStop): in-flight asks abort, run-settled carries stopReason and error", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    await flush();
    const stop = new WorkflowError("ProviderStop", "Sign-in to BigModel expired.", {
      providerStop: {
        kind: "auth",
        reason: "auth_failed",
        providerCode: "1006",
        subagent: "ask#1@1",
      },
    });
    engine.stopRun(stop);
    expect(driver.cancels).toContainEqual(inst("ask#1"));
    await expect(p).rejects.toMatchObject({ code: "Cancelled" });
    await expect(engine.settled).resolves.toEqual({
      status: "stopped",
      reason: "provider",
      error: stop,
    });
    expect(driver.eventsOfType("node-settled")[0]).toMatchObject({ outcome: "cancelled" });
    expect(driver.eventsOfType("run-settled")[0]).toEqual({
      type: "run-settled",
      status: "stopped",
      stopReason: "provider",
      error: stop.toJSON(),
    });
    const run = journal.getRun(RUN);
    expect(run?.status).toBe("stopped");
    expect(run?.stopReason).toBe("provider");
    expect(run?.failure).toEqual(stop.toJSON());
    // First-wins: a second stopRun or fail after settlement is a no-op.
    engine.stopRun(stop);
    engine.fail(new WorkflowError("DriverError", "late"));
    expect(driver.eventsOfType("run-settled")).toHaveLength(1);
  });

  // The engine backfills the triggering subagent's birth phase onto ProviderStop: the driver knows only the actor ref.
  it("fills providerStop phase from instancePhases, passing through when absent or already set", async () => {
    const { engine, driver } = setup();
    engine.enterPhase("Verify");
    const actor = engine.createActor("actor#1");
    void engine.ask("ask#1", actor, "A").catch(() => {});
    await flush();
    engine.stopRun(
      new WorkflowError("ProviderStop", "Model GLM-5.3 is not available.", {
        providerStop: {
          kind: "model_unavailable",
          reason: "invalid_request",
          subagent: "actor#1@1",
        },
      }),
    );
    const settled = driver.eventsOfType("run-settled")[0];
    expect(settled).toMatchObject({
      status: "stopped",
      stopReason: "provider",
      error: { providerStop: { subagent: "actor#1@1", phase: "Verify" } },
    });

    const bare = setup();
    const bareActor = bare.engine.createActor("actor#1");
    void bare.engine.ask("ask#1", bareActor, "A").catch(() => {});
    await flush();
    bare.engine.stopRun(
      new WorkflowError("ProviderStop", "boom", {
        providerStop: { kind: "auth", reason: "auth_failed", subagent: "actor#1@1" },
      }),
    );
    const bareError = bare.driver.eventsOfType("run-settled")[0]?.error;
    expect(bareError?.providerStop).toEqual({
      kind: "auth",
      reason: "auth_failed",
      subagent: "actor#1@1",
    });
  });

  it("records run-stalled once and ignores it after settlement", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1");
    void engine.ask("ask#1", actor, "A").catch(() => {});
    await flush();
    engine.runStalled({ sinceMs: 1_200_000, reason: "rate_limited", cap: 2 });
    expect(driver.events.at(-1)).toEqual({
      type: "run-stalled",
      sinceMs: 1_200_000,
      reason: "rate_limited",
      cap: 2,
    });
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" }).at(-1)?.event.type).toBe(
      "run-stalled",
    );
    engine.stop("user");
    engine.runStalled({ sinceMs: 1 });
    expect(driver.events.at(-1)?.type).toBe("run-settled");
  });
});

describe("WorkflowEngine -- concurrency observation events", () => {
  it("records one event each for askWaiting(slot), askWaiting(backoff), askExecuting, concurrencyChanged", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    await flush();

    engine.askWaiting(inst("ask#1"), { cause: "slot" });
    engine.askExecuting(inst("ask#1"));
    engine.askWaiting(inst("ask#1"), {
      cause: "backoff",
      reason: "rate_limited",
      attempt: 2,
      delayMs: 20_000,
      retryAfterMs: 20_000,
    });
    engine.concurrencyChanged({
      key: "p/m",
      previous: 8,
      next: 4,
      reason: "rate_limited",
      lastGood: 4,
      cooldownMs: 20_000,
    });
    engine.askExecuting(inst("ask#1"));

    expect(driver.eventsOfType("node-waiting")).toEqual([
      { type: "node-waiting", instance: inst("ask#1"), cause: "slot" },
      {
        type: "node-waiting",
        instance: inst("ask#1"),
        cause: "backoff",
        reason: "rate_limited",
        attempt: 2,
        delayMs: 20_000,
        retryAfterMs: 20_000,
      },
    ]);
    expect(driver.eventsOfType("node-executing")).toEqual([
      { type: "node-executing", instance: inst("ask#1") },
      { type: "node-executing", instance: inst("ask#1") },
    ]);
    expect(driver.eventsOfType("concurrency-changed")).toEqual([
      {
        type: "concurrency-changed",
        key: "p/m",
        previous: 8,
        next: 4,
        reason: "rate_limited",
        lastGood: 4,
        cooldownMs: 20_000,
      },
    ]);
    // Observation events write no dwf_node: the node keeps its admission-time running row.
    expect(journal.getNode(RUN, "ask#1", 1)?.status).toBe("running");
    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");
  });

  it("ignores observations for unknown instances, settled instances, and settled runs", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    await flush();
    engine.askWaiting(inst("nope"), { cause: "slot" });
    engine.askExecuting(inst("nope"));
    engine.askTurnEnded(inst("ask#1"), "RA");
    await p;
    engine.askWaiting(inst("ask#1"), {
      cause: "backoff",
      reason: "timeout",
      attempt: 1,
      delayMs: 1,
    });
    engine.askExecuting(inst("ask#1"));
    engine.complete("done");
    await engine.settled;
    engine.concurrencyChanged({ key: "p/m", previous: 4, next: 5, reason: "recovered" });
    expect(driver.eventsOfType("node-waiting")).toEqual([]);
    expect(driver.eventsOfType("node-executing")).toEqual([]);
    expect(driver.eventsOfType("concurrency-changed")).toEqual([]);
  });
});
