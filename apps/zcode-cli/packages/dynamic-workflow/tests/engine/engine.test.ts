import { describe, expect, it } from "vitest";
import {
  InMemoryJournalStore,
  WorkflowEngine,
  WorkflowError,
  inputHash,
  refToString,
  type AskSpec,
  type Caps,
  type InstanceRef,
  type NodeKind,
  type NodeRecord,
  type PersonaSpec,
  type RunEvent,
  type StoredEvent,
  type ValidateFn,
} from "../../src/engine/index.js";
import { FakeDriver, flush } from "./fake-driver.js";
import { REPORT_CAPS } from "../../src/facade/report-caps.js";
import { validate } from "../../src/schema/validate.js";
import type { JsonSchema } from "../../src/schema/types.js";

const RUN = "run";

function inst(siteId: string, ordinal = 1): InstanceRef {
  return { siteId, ordinal };
}

/** A minimal schema.required-only validator (mimicking the real validator's violation output). */
const requireFields: ValidateFn = (schema, value) => {
  const required = (schema as { required?: string[] } | undefined)?.required ?? [];
  const obj = (value ?? {}) as Record<string, unknown>;
  return required
    .filter((k) => obj[k] === undefined)
    .map((k) => ({ path: k, expected: "present", got: "undefined" }));
};

interface SetupOpts {
  journal?: InMemoryJournalStore;
  caps?: Caps;
  askSpecs?: Map<string, AskSpec>;
  validate?: ValidateFn;
  deferSessions?: boolean;
  name?: string;
  scriptText?: string;
  scriptHash?: string;
  parentSessionId?: string;
  cwd?: string;
  toolCallId?: string;
  resumedFrom?: string;
  /** Mimics driver-side model tier resolution (writes the result into the actor record at session creation). */
  resolveModel?: (persona: { model?: string }) => string;
}

function setup(opts: SetupOpts = {}) {
  const journal = opts.journal ?? new InMemoryJournalStore();
  const driver = new FakeDriver(journal, {
    deferSessions: opts.deferSessions,
    ...(opts.resolveModel === undefined ? {} : { resolveModel: opts.resolveModel, runId: RUN }),
  });
  const engine = new WorkflowEngine({
    runId: RUN,
    driver,
    caps: opts.caps ?? { maxConcurrency: 16 },
    // askSpecs must cover every ask site in the script (a miss is a hard error); the fixture records
    // this file's two sites explicitly as untyped.
    askSpecs: opts.askSpecs ?? untypedSpecs("ask#1", "ask#2"),
    validate: opts.validate ?? (() => []),
    ...(opts.name === undefined ? {} : { name: opts.name }),
    ...(opts.scriptText === undefined ? {} : { scriptText: opts.scriptText }),
    ...(opts.scriptHash === undefined ? {} : { scriptHash: opts.scriptHash }),
    ...(opts.parentSessionId === undefined ? {} : { parentSessionId: opts.parentSessionId }),
    ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    ...(opts.toolCallId === undefined ? {} : { toolCallId: opts.toolCallId }),
    ...(opts.resumedFrom === undefined ? {} : { resumedFrom: opts.resumedFrom }),
  });
  return { journal, driver, engine };
}

/** Records the given ask sites explicitly as untyped (the engine no longer treats absence as untyped). */
const untypedSpecs = (...siteIds: string[]): Map<string, AskSpec> =>
  new Map(siteIds.map((id) => [id, { typed: false } as AskSpec]));

const typedSpecs = () =>
  new Map<string, AskSpec>([["ask#1", { typed: true, schema: { required: ["x"] } }]]);

describe("WorkflowEngine — happy path", () => {
  it("dispatches, accepts a valid submit, and journals the node", async () => {
    const { engine, driver, journal } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1", "planner");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    expect(driver.startAskCount()).toBe(1);
    expect(driver.startAsks[0]?.message.typed).toBe(true);
    expect(driver.startAsks[0]?.message.schema).toEqual({ required: ["x"] });

    engine.askStats(inst("ask#1"), { tokens: 10, toolCalls: 1, turns: 1 });
    engine.askSubmitAttempted(inst("ask#1"), { x: 1 });

    expect(driver.submitResponses.at(-1)?.verdict.kind).toBe("accept");
    await expect(p).resolves.toEqual({ x: 1 });

    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.status).toBe("completed");
    expect(node?.actorSeq).toBe(0);
    expect(node?.inputHash).toBe(inputHash("do it"));
    expect(node?.result).toEqual({ x: 1 });
    expect(node?.stats?.tokens).toBe(10);
    expect(node?.actorSiteId).toBe("actor#1");

    engine.complete("final artifact");
    await expect(engine.settled).resolves.toEqual({
      status: "completed",
      artifact: "final artifact",
    });
    expect(engine.status()).toBe("completed");
  });
});

describe("WorkflowEngine — validation + repair", () => {
  it("rejects invalid submits and fails after the 3 repair attempts are exhausted", async () => {
    const { engine, driver, journal } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    // Four invalid submits: the first three rejected (repair), the fourth exhausting the budget -> failure.
    for (let i = 0; i < 4; i++) engine.askSubmitAttempted(inst("ask#1"), {});

    const rejects = driver.submitResponses.filter((r) => r.verdict.kind === "reject");
    expect(rejects).toHaveLength(3);
    expect(driver.cancels).toContainEqual(inst("ask#1"));

    await expect(p).rejects.toMatchObject({ code: "ValidationFailed" });
    const err = await p.catch((e: unknown) => e as { violations?: unknown[] });
    expect(err.violations?.length).toBeGreaterThan(0);

    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.status).toBe("failed");
    expect(node?.error?.code).toBe("ValidationFailed");
  });

  it("repairs successfully within the attempt limit", async () => {
    const { engine, driver } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();
    engine.askSubmitAttempted(inst("ask#1"), {}); // reject
    engine.askSubmitAttempted(inst("ask#1"), { x: 7 }); // accept
    await expect(p).resolves.toEqual({ x: 7 });
    expect(driver.submitResponses.map((r) => r.verdict.kind)).toEqual(["reject", "accept"]);
  });
});

describe("WorkflowEngine — nudge policy", () => {
  it("nudges once when the turn ends without a submit, then accepts", async () => {
    const { engine, driver } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();
    engine.askTurnEnded(inst("ask#1"), "not yet");
    expect(driver.submitResponses.at(-1)?.verdict.kind).toBe("nudge");
    engine.askSubmitAttempted(inst("ask#1"), { x: 1 });
    await expect(p).resolves.toEqual({ x: 1 });
  });

  it("fails with ResultNotSubmitted + final text when nudge is exhausted", async () => {
    const { engine, driver } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();
    engine.askTurnEnded(inst("ask#1"), "text one"); // nudge
    engine.askTurnEnded(inst("ask#1"), "final words"); // exhausted → fail
    await expect(p).rejects.toMatchObject({ code: "ResultNotSubmitted", finalText: "final words" });
    expect(driver.cancels).toContainEqual(inst("ask#1"));
  });
});

describe("WorkflowEngine — untyped ask", () => {
  it("settles on turn end with the final text and offers no submit tool", async () => {
    const { engine, driver, journal } = setup(); // sites recorded untyped explicitly
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "summarize");
    await flush();
    expect(driver.startAsks[0]?.message.typed).toBe(false);
    engine.askTurnEnded(inst("ask#1"), "the answer");
    await expect(p).resolves.toBe("the answer");
    expect(journal.getNode(RUN, "ask#1", 1)?.result).toBe("the answer");
  });
});

describe("WorkflowEngine — per-actor FIFO", () => {
  it("serializes concurrent asks on one actor and journals actorSeq in admission order", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1");
    const p1 = engine.ask("ask#1", actor, "A");
    const p2 = engine.ask("ask#2", actor, "B");
    await flush();

    // Only the head dispatches; the second ask waits for the first to settle.
    expect(driver.startAskCount()).toBe(1);
    expect(driver.startAsks[0]?.instance).toEqual(inst("ask#1"));

    engine.askTurnEnded(inst("ask#1"), "ra");
    await flush();
    expect(driver.startAskCount()).toBe(2);
    expect(driver.startAsks[1]?.instance).toEqual(inst("ask#2"));

    engine.askTurnEnded(inst("ask#2"), "rb");
    await expect(Promise.all([p1, p2])).resolves.toEqual(["ra", "rb"]);

    expect(journal.getNode(RUN, "ask#1", 1)?.actorSeq).toBe(0);
    expect(journal.getNode(RUN, "ask#2", 1)?.actorSeq).toBe(1);
  });
});

describe("WorkflowEngine — replay", () => {
  it("short-circuits journaled nodes with zero startAsk calls", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("do it"),
      status: "completed",
      result: { x: 42 },
    });

    const { engine, driver } = setup({ journal });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    expect(driver.startAskCount()).toBe(0);
    await expect(p).resolves.toEqual({ x: 42 });
  });

  it("fails the run loudly on an inputHash mismatch", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: "deadbeef", // mismatched against the replay-time hash
      status: "completed",
      result: { x: 1 },
    });

    const { engine } = setup({ journal });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await expect(p).rejects.toMatchObject({ code: "InputHashMismatch" });
    await expect(engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "InputHashMismatch" },
    });

    // Both hashes ride the error structurally (the same mismatch field as ScriptHashMismatch): a structured
    // field present on only one of the two hash-mismatch errors is a trap for readers.
    const err = await p.catch((e: unknown) => e as WorkflowError);
    expect(err.mismatch).toEqual({ expected: "deadbeef", got: inputHash("do it") });
    // The serialized journal form carries it too (failure_json is the app-side persistent record).
    expect(err.toJSON()).toMatchObject({
      code: "InputHashMismatch",
      mismatch: { expected: "deadbeef", got: inputHash("do it") },
    });
    expect(journal.getRun(RUN)?.failure?.mismatch).toEqual({
      expected: "deadbeef",
      got: inputHash("do it"),
    });
  });

  it("enforces the recorded actorSeq via the hold rule when arrivals are scrambled", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    // Record order: ask#1@1 = seq0, ask#2@1 = seq1.
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("A"),
      status: "completed",
      result: "r1",
    });
    journal.putNode({
      runId: RUN,
      siteId: "ask#2",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 1,
      inputHash: inputHash("B"),
      status: "completed",
      result: "r2",
    });

    const { engine, driver } = setup({ journal });
    const actor = engine.createActor("actor#1");
    // Arrival is the reverse of the record: ask#2 first (seq1, held), then ask#1 (seq0, triggers the release).
    const pB = engine.ask("ask#2", actor, "B");
    const pA = engine.ask("ask#1", actor, "A");
    await expect(Promise.all([pA, pB])).resolves.toEqual(["r1", "r2"]);

    // Release order follows the recorded actorSeq, not arrival order.
    expect(driver.cachedSettleOrder()).toEqual(["ask#1@1", "ask#2@1"]);
    expect(driver.startAskCount()).toBe(0);
  });

  it("turns the same-site nondeterministic-ordinal gap into a loud inputHash failure (not wrong results)", async () => {
    // Backing for a known v1 limitation: for same-site asks gated by a nondeterministic predecessor the ordinal is
    // arrival-order, not deterministic. The journal has ask#1@1=plan A, ask#1@2=plan B; if replay swaps them,
    // the first arrival takes ordinal 1 carrying plan B -> hash mismatch -> the run fails loudly, never returning wrong results.
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("plan A"),
      status: "completed",
      result: "A",
    });
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 2,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 1,
      inputHash: inputHash("plan B"),
      status: "completed",
      result: "B",
    });

    const { engine } = setup({ journal });
    const actor = engine.createActor("actor#1");
    const pB = engine.ask("ask#1", actor, "plan B"); // takes ordinal 1 while plan A is recorded -> mismatch
    await expect(pB).rejects.toMatchObject({ code: "InputHashMismatch" });
    await expect(engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "InputHashMismatch" },
    });
  });
});

describe("WorkflowEngine — mid-run crash + resume", () => {
  it("resumes over the same journal, short-circuiting finished nodes and finishing the rest", async () => {
    const journal = new InMemoryJournalStore();

    // Pass one: settle ask#1, then "crash" (ask#2 never runs).
    {
      const driver1 = new FakeDriver(journal);
      const e1 = new WorkflowEngine({
        runId: RUN,
        driver: driver1,
        caps: { maxConcurrency: 16 },
        askSpecs: untypedSpecs("ask#1", "ask#2"),
        validate: () => [],
      });
      const a = e1.createActor("actor#1");
      const p1 = e1.ask("ask#1", a, "A");
      await flush();
      e1.askTurnEnded(inst("ask#1"), "RA");
      await expect(p1).resolves.toBe("RA");
    }

    // Pass two: replay on the same journal.
    const driver2 = new FakeDriver(journal);
    const e2 = new WorkflowEngine({
      runId: RUN,
      driver: driver2,
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1", "ask#2"),
      validate: () => [],
    });
    const a2 = e2.createActor("actor#1");

    const r1 = await e2.ask("ask#1", a2, "A"); // journal hit
    expect(r1).toBe("RA");
    expect(driver2.startAskCount(inst("ask#1"))).toBe(0); // not re-executed

    const p2 = e2.ask("ask#2", a2, "B"); // new node, actually dispatched
    await flush();
    expect(driver2.startAskCount(inst("ask#2"))).toBe(1);
    e2.askTurnEnded(inst("ask#2"), "RB");
    await expect(p2).resolves.toBe("RB");

    e2.complete("done");
    await expect(e2.settled).resolves.toMatchObject({ status: "completed", artifact: "done" });
  });

  it("re-dispatches a crash-mid-flight node (status running) live, enforcing its recorded actorSeq", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    // ask#1 completed (seq0); ask#2 crashed mid-flight (seq1, status running).
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("A"),
      status: "completed",
      result: "RA",
    });
    journal.putNode({
      runId: RUN,
      siteId: "ask#2",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 1,
      inputHash: inputHash("B"),
      status: "running",
    });

    const { engine, journal: j, driver } = setup({ journal });
    const actor = engine.createActor("actor#1");
    const p1 = engine.ask("ask#1", actor, "A"); // completed hit, short-circuits
    const p2 = engine.ask("ask#2", actor, "B"); // running -> re-dispatched live
    await flush();

    expect(await p1).toBe("RA");
    expect(driver.startAskCount(inst("ask#1"))).toBe(0); // completed node not re-run
    expect(driver.startAskCount(inst("ask#2"))).toBe(1); // running node re-executed live

    engine.askTurnEnded(inst("ask#2"), "RB");
    expect(await p2).toBe("RB");
    // The running row updates to completed, keeping the recorded actorSeq.
    expect(j.getNode(RUN, "ask#2", 1)?.status).toBe("completed");
    expect(j.getNode(RUN, "ask#2", 1)?.actorSeq).toBe(1);
  });

  it("re-creates the actor session via the driver even when the journal records a sessionId", async () => {
    // Bug root cause (resume re-dispatch exploded on production drivers): registerActor used to pre-resolve the
    // journal's sessionId into actor.sessionPromise, letting ensureSession skip driver.createActorSession;
    // but a production driver's sessions map is filled only in createActorSession, and startAsk looks up by map
    // -> every re-dispatched ask failed instantly with DriverError unknown-session. Pure replay (zero dispatches)
    // and fake drivers (startAsk not consulting the map) hide it, so this pins the createActorSession call count.
    // Session identity is the driver's (the production minter is a pure function of runId+actorRef); the journal value is a record only.
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1, sessionId: "session:actor#1@1" });
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("A"),
      status: "running",
    });

    const { engine, journal: j, driver } = setup({ journal });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    await flush();

    // Key assertions: the session is rebuilt via the driver exactly once, and dispatch uses the driver-made session.
    expect(driver.sessionCreations).toEqual([{ siteId: "actor#1", ordinal: 1 }]);
    expect(driver.startAskCount(inst("ask#1"))).toBe(1);
    expect(driver.startAsks[0]?.session.id).toBe("session:actor#1@1");

    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");
    // ensureSession's putActor records the (necessarily identical) sessionId back.
    expect(j.getActor(RUN, "actor#1", 1)?.sessionId).toBe("session:actor#1@1");
  });

  it("restores the tokens already spent by the crashed run instead of starting from zero", async () => {
    // Regression: usage used to be written once at createRun(0) with askStats accumulations never written back,
    // so resumed engines counted from zero and run-level usage broke across lifecycles.
    const caps: Caps = { maxConcurrency: 16 };
    const journal = new InMemoryJournalStore();

    {
      const e1 = new WorkflowEngine({
        runId: RUN,
        driver: new FakeDriver(journal),
        caps,
        askSpecs: untypedSpecs("ask#1", "ask#2"),
        validate: () => [],
      });
      const a = e1.createActor("actor#1");
      const p = e1.ask("ask#1", a, "A");
      await flush();
      e1.askStats(inst("ask#1"), { tokens: 300, toolCalls: 1, turns: 1 });
      e1.askTurnEnded(inst("ask#1"), "RA");
      await expect(p).resolves.toBe("RA");
    }

    expect(journal.getRun(RUN)?.spentTokens).toBe(300);

    const driver2 = new FakeDriver(journal);
    const e2 = new WorkflowEngine({
      runId: RUN,
      driver: driver2,
      caps,
      askSpecs: untypedSpecs("ask#1", "ask#2"),
      validate: () => [],
    });
    const b = e2.createActor("actor#2");
    void e2.ask("ask#2", b, "B").catch(() => {});
    await flush();
    e2.askStats(inst("ask#2"), { tokens: 100, toolCalls: 0, turns: 1 });
    // Event payload and column value update in the same synchronous step: accumulation continues after resume instead of restarting at 0.
    expect(driver2.events.at(-1)).toEqual({ type: "usage-updated", spentTokens: 400 });
    expect(journal.getRun(RUN)?.spentTokens).toBe(400);
  });
});

describe("WorkflowEngine — cancellation", () => {
  it("cancels in-flight asks, settles cancelled, and keeps finished journal entries", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1");

    const pDone = engine.ask("ask#1", actor, "A");
    await flush();
    engine.askTurnEnded(inst("ask#1"), "RA"); // settle complete, journalled
    await expect(pDone).resolves.toBe("RA");

    const pInFlight = engine.ask("ask#2", actor, "B");
    await flush();
    expect(driver.startAskCount(inst("ask#2"))).toBe(1);

    engine.stop("user");
    expect(driver.cancels).toContainEqual(inst("ask#2"));
    await expect(pInFlight).rejects.toMatchObject({ code: "Cancelled" });
    await expect(engine.settled).resolves.toEqual({ status: "stopped", reason: "user" });
    expect(journal.getRun(RUN)).toMatchObject({ status: "stopped", stopReason: "user" });
    expect(driver.events.at(-1)).toEqual({
      type: "run-settled",
      status: "stopped",
      stopReason: "user",
    });

    // Completed nodes stay completed; in-flight nodes keep their admission-time running row (not a completed result) so resume can retry.
    expect(journal.getNode(RUN, "ask#1", 1)?.status).toBe("completed");
    expect(journal.getNode(RUN, "ask#2", 1)?.status).toBe("running");
  });
});

describe("WorkflowEngine — complete() with in-flight asks", () => {
  // A script may return while asks are in flight (Promise.race losers, unawaited asks). complete must handle them
  // byte-identically to cancel, or the scheduler holds nodes forever, driver turns keep burning tokens, and a
  // node-dispatched never sees its node-settled. See docs/execution-engine.md.
  it("aborts the in-flight ask like stop() does, then settles completed with the artifact", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1");

    const pDone = engine.ask("ask#1", actor, "A");
    await flush();
    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(pDone).resolves.toBe("RA");

    const pInFlight = engine.ask("ask#2", actor, "B");
    await flush();
    expect(driver.startAskCount(inst("ask#2"))).toBe(1);

    engine.complete("done");
    expect(driver.cancels).toContainEqual(inst("ask#2"));
    await expect(pInFlight).rejects.toMatchObject({ code: "Cancelled" });
    await expect(engine.settled).resolves.toEqual({ status: "completed", artifact: "done" });
    expect(engine.status()).toBe("completed");

    // Event sequence: in-flight nodes cancelled first, then run-settled(completed).
    const types = driver.events.map((e) => e.type);
    const settledIdx = types.lastIndexOf("node-settled");
    const runIdx = types.lastIndexOf("run-settled");
    expect(driver.events[settledIdx]).toMatchObject({
      instance: inst("ask#2"),
      outcome: "cancelled",
    });
    expect(driver.events[runIdx]).toMatchObject({ status: "completed" });
    expect(settledIdx).toBeLessThan(runIdx);

    // Journal matches the cancel path: completed nodes completed, in-flight stuck at running; the run completes with its artifact.
    expect(journal.getNode(RUN, "ask#1", 1)?.status).toBe("completed");
    expect(journal.getNode(RUN, "ask#2", 1)?.status).toBe("running");
    expect(journal.getRun(RUN)?.status).toBe("completed");
    expect(journal.getRun(RUN)?.result).toBe("done");
  });

  it("does nothing extra when no ask is in flight (byte-for-byte the plain complete)", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    await flush();
    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");

    engine.complete("done");
    expect(driver.cancels).toEqual([]);
    expect(driver.eventsOfType("node-settled").map((e) => e.outcome)).toEqual(["ok"]);
    await expect(engine.settled).resolves.toEqual({ status: "completed", artifact: "done" });
  });

  it("persists straggler stats after complete() to the usage row without emitting events", async () => {
    const { engine, driver, journal } = setup();
    const winner = engine.createActor("actor#1");
    const loser = engine.createActor("actor#2");
    const pWin = engine.ask("ask#1", winner, "fast");
    void engine.ask("ask#2", loser, "slow").catch(() => {});
    await flush();
    engine.askTurnEnded(inst("ask#1"), "won");
    await expect(pWin).resolves.toBe("won");
    engine.complete("won");

    const eventCount = driver.events.length;
    // A real actor's usage is known only after its turn resolves: final stats often arrive after complete.
    // Keep the accounting (usage row and node backfill are journal-row updates) but append no more events -- run-settled is last.
    engine.askStats(inst("ask#2"), { tokens: 7, toolCalls: 0, turns: 1 });
    expect(driver.events.length).toBe(eventCount);
    expect(journal.getRun(RUN)?.spentTokens).toBe(7);
    expect(journal.getNode(RUN, "ask#2", 1)?.stats).toEqual({ tokens: 7, toolCalls: 0, turns: 1 });
  });
});

describe("WorkflowEngine — driver dispose at settlement", () => {
  // Engine contract: each of the three terminal paths calls driver.dispose exactly once, after run-settled; first-wins, no duplicates.
  async function withInFlightAsk() {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    void p.catch(() => {});
    await flush();
    expect(driver.disposeCalls).toBe(0);
    return { engine, driver };
  }

  function expectDisposedOnceAfterRunSettled(driver: FakeDriver): void {
    expect(driver.disposeCalls).toBe(1);
    const runSettledIdx = driver.events.findIndex((e) => e.type === "run-settled");
    expect(runSettledIdx).toBeGreaterThanOrEqual(0);
    expect(driver.eventsAtDispose).toBe(runSettledIdx + 1);
  }

  it("complete(): once, after run-settled, and not again on a later stop()/fail()", async () => {
    const { engine, driver } = await withInFlightAsk();
    engine.complete("done");
    expectDisposedOnceAfterRunSettled(driver);
    engine.stop("user");
    engine.fail(new WorkflowError("DriverError", "late"));
    expect(driver.disposeCalls).toBe(1);
  });

  it("stop(): once, after run-settled", async () => {
    const { engine, driver } = await withInFlightAsk();
    engine.stop("user");
    expectDisposedOnceAfterRunSettled(driver);
    engine.complete("late");
    expect(driver.disposeCalls).toBe(1);
  });

  it("fail(): once, after run-settled", async () => {
    const { engine, driver } = await withInFlightAsk();
    engine.fail(new WorkflowError("DriverError", "boom"));
    expectDisposedOnceAfterRunSettled(driver);
    expect(driver.disposeCalls).toBe(1);
  });

  it("a driver without dispose is fine (the hook is optional)", async () => {
    const journal = new InMemoryJournalStore();
    const driver = new FakeDriver(journal);
    (driver as { dispose?: () => void }).dispose = undefined;
    const engine = new WorkflowEngine({
      runId: RUN,
      driver,
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1"),
      validate: () => [],
    });
    engine.complete("done");
    await expect(engine.settled).resolves.toEqual({ status: "completed", artifact: "done" });
  });
});

describe("WorkflowEngine — usage (no caps)", () => {
  it("never caps the node count: well past the old limit of 100 the run is still running", async () => {
    // docs/dynamic-workflow/authoring.md: node caps were removed wholesale; cancellation is the only stop.
    const { engine, driver, journal } = setup({ caps: { maxConcurrency: 200 } });
    for (let i = 1; i <= 120; i++) {
      const actor = engine.createActor(`actor#${i}`);
      void engine.ask("ask#1", actor, `job ${i}`).catch(() => {});
    }
    await flush();

    expect(journal.getRun(RUN)?.status).toBe("running");
    expect(driver.events.filter((e) => e.type === "node-dispatched")).toHaveLength(120);
    engine.stop("user");
  });

  it("emits usage-updated with the accumulated spentTokens and never fails the run on usage", async () => {
    const { engine, driver, journal } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1");
    void engine.ask("ask#1", actor, "do it").catch(() => {});
    await flush();

    engine.askStats(inst("ask#1"), { tokens: 30, toolCalls: 0, turns: 1 });
    expect(driver.events.at(-1)).toEqual({ type: "usage-updated", spentTokens: 30 });
    expect(journal.getRun(RUN)?.spentTokens).toBe(30);

    engine.askStats(inst("ask#1"), { tokens: 80, toolCalls: 0, turns: 1 });
    expect(driver.events.at(-1)).toEqual({ type: "usage-updated", spentTokens: 110 });
    expect(journal.getRun(RUN)?.spentTokens).toBe(110);
    expect(journal.getRun(RUN)?.status).toBe("running");
    engine.stop("user");
  });
});

describe("WorkflowEngine — fail() (harness-driven run failure)", () => {
  it("settles failed, cancels in-flight asks, records failure_json, and is first-wins", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    void p.catch(() => {}); // a failed run rejects the ask
    await flush();
    expect(driver.startAskCount(inst("ask#1"))).toBe(1);

    // The harness maps child throws/crashes/timeouts to run failure.
    const boom = new WorkflowError("DriverError", "child crashed");
    engine.fail(boom);

    expect(driver.cancels).toContainEqual(inst("ask#1")); // in-flight ask cancelled driver-side
    await expect(p).rejects.toBe(boom); // in-flight ask rejects with the run error
    await expect(engine.settled).resolves.toEqual({ status: "errored", error: boom });
    expect(engine.status()).toBe("errored");

    const run = journal.getRun(RUN);
    expect(run?.status).toBe("errored");
    expect(run?.failure).toEqual({ code: "DriverError", message: "child crashed" });
    expect(run?.stopReason).toBeUndefined();

    // First-wins: later complete(), repeated fail(), and stop() are no-ops.
    engine.complete("late");
    engine.fail(new WorkflowError("Cancelled", "ignored"));
    engine.stop("interrupted", new WorkflowError("Interrupted", "late"));
    await expect(engine.settled).resolves.toEqual({ status: "errored", error: boom });
  });

  it("createActorSession rejection surfaces the cause text in the DriverError (journal + reject)", async () => {
    // 2026-09-03, production: the directly-launched first actor hit a FOREIGN KEY creating session_task_link,
    // leaving the run only create-actor-session-failed -- cause absent from toJSON, nobody logging it, undiagnosable.
    // This pins that the message must carry the cause's text.
    const { engine, journal, driver } = setup({ deferSessions: true });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "A");
    driver.sessionDeferrals[0]!.reject(new Error("FOREIGN KEY constraint failed"));
    // Pins the presence of the cause text (the varying part), not the whole wording.
    await expect(p).rejects.toMatchObject({
      code: "DriverError",
      message: expect.stringContaining("FOREIGN KEY constraint failed"),
    });
    expect(journal.getNode(RUN, "ask#1", 1)?.error).toMatchObject({
      code: "DriverError",
      message: expect.stringContaining("FOREIGN KEY constraint failed"),
    });
  });

  it("complete() first wins over a later fail()", async () => {
    const { engine } = setup();
    engine.complete("ok");
    engine.fail(new WorkflowError("DriverError", "too late"));
    await expect(engine.settled).resolves.toEqual({ status: "completed", artifact: "ok" });
  });

  it("createActor throws synchronously once the run has failed (harness can catch → fail())", async () => {
    const { engine } = setup();
    engine.fail(new WorkflowError("DriverError", "boom"));
    // Throws synchronously (no async leak) so the harness try/catch catches it and converts to fail().
    expect(() => engine.createActor("actor#1")).toThrow();
  });
});

describe("WorkflowEngine — stats backfill after settle", () => {
  it("backfills stats onto a typed ask journaled at settle when askStats arrives after the submit", async () => {
    // The typed-accept path (the dominant one): submit stops the turn and records at settle; a real actor's usage is
    // known only after the turn resolves (post-submit), so askStats arrives once the node left liveNodes. The engine backfills.
    const { engine, journal } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1", "planner");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    engine.askSubmitAttempted(inst("ask#1"), { x: 1 });
    await expect(p).resolves.toEqual({ x: 1 });

    const settled = journal.getNode(RUN, "ask#1", 1);
    expect(settled?.status).toBe("completed");
    expect(settled?.stats).toBeUndefined(); // stats not yet arrived at settle time

    engine.askStats(inst("ask#1"), { tokens: 42, toolCalls: 2, turns: 1 });

    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.stats).toEqual({ tokens: 42, toolCalls: 2, turns: 1 });
    // Only stats are added; every other field is untouched (status/result/actorSeq/inputHash/actor identity).
    expect(node?.status).toBe("completed");
    expect(node?.result).toEqual({ x: 1 });
    expect(node?.actorSeq).toBe(0);
    expect(node?.inputHash).toBe(inputHash("do it"));
    expect(node?.actorSiteId).toBe("actor#1");
    expect(node?.actorOrdinal).toBe(1);
    expect(node?.kind).toBe("ask");
  });

  it("preserves the pre-settle path: stats reported before submit are present at settle without a backfill", async () => {
    const { engine, journal } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    engine.askStats(inst("ask#1"), { tokens: 10, toolCalls: 1, turns: 1 });
    engine.askSubmitAttempted(inst("ask#1"), { x: 1 });
    await expect(p).resolves.toEqual({ x: 1 });

    expect(journal.getNode(RUN, "ask#1", 1)?.stats).toEqual({ tokens: 10, toolCalls: 1, turns: 1 });
  });

  it("is a no-op when the node was never journaled (defensive, best-effort)", async () => {
    // Stats for a never-admitted instance: no live node, no journal row -- the backfill skips silently (no throw, no record).
    const { engine, journal } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    engine.createActor("actor#1");
    engine.askStats(inst("ask#404"), { tokens: 5, toolCalls: 0, turns: 1 });
    expect(journal.getNode(RUN, "ask#404", 1)).toBeUndefined();
  });
});

describe("WorkflowEngine — run metadata", () => {
  it("persists scriptText / scriptHash / parentSessionId / cwd / toolCallId through createRun", async () => {
    // RunRecord declared the first four fields long ago, but createRun never filled them -- leaving resume's script_hash
    // check without a comparison basis. Persisting is that check's only precondition. toolCallId is the fifth, added by
    // cancel-and-resume: the only persisted anchor for post-restart tool-card join and resume notifications.
    const { journal } = setup({
      scriptText: 'await agent("a").ask("hi");',
      scriptHash: "hash-a",
      parentSessionId: "sess_parent",
      cwd: "/tmp/project",
      toolCallId: "call-abc",
    });
    expect(journal.getRun(RUN)).toMatchObject({
      runId: RUN,
      status: "running",
      scriptText: 'await agent("a").ask("hi");',
      scriptHash: "hash-a",
      parentSessionId: "sess_parent",
      cwd: "/tmp/project",
      toolCallId: "call-abc",
    });
  });

  // name rides exactly the same metadata path as the four fields above (EngineConfig -> createRun,
  // no later writer). Purely display: the engine never reads it; host enumeration uses it as a label -- without
  // this, cross-session run lists degenerate to bare runIds (docs/dynamic-workflow/launch.md).
  it("persists the run name through createRun", async () => {
    const { journal } = setup({ name: "nightly triage" });
    expect(journal.getRun(RUN)).toMatchObject({ runId: RUN, name: "nightly triage" });
  });

  it("omits the metadata fields entirely when the config carries none", async () => {
    // The default must not become an undefined key: stores distinguish absent fields from null (see the contract tests).
    const { journal } = setup();
    const run = journal.getRun(RUN)!;
    expect("scriptText" in run).toBe(false);
    expect("scriptHash" in run).toBe(false);
    expect("parentSessionId" in run).toBe(false);
    expect("cwd" in run).toBe(false);
    // An unnamed run is an absent key, not null/undefined: readers fall back to the script's first line on that basis.
    expect("name" in run).toBe(false);
    expect("toolCallId" in run).toBe(false);
    // Most runs are not amendments: the lineage pointer must be absent too, not an empty value
    // （docs/execution-engine.md）。
    expect("resumedFrom" in run).toBe(false);
  });

  // resumedFrom rides the same write-once metadata path. The engine never reads it: imported-cache assembly lives in the run service.
  // It is recorded for the post-crash case -- an amended run's plain resume rebuilds the ImportedCache from this pointer.
  it("persists the amend-resume lineage pointer through createRun", async () => {
    const { journal } = setup({ resumedFrom: "run-predecessor" });
    expect(journal.getRun(RUN)).toMatchObject({ runId: RUN, resumedFrom: "run-predecessor" });
  });
});

// Named actors are the identity key for amend-resume cache imports, and any run may become a
// future amendment's predecessor -- so this uniqueness rule covers all runs, not just amended ones.
// （docs/execution-engine.md「Amend-resume」）。
describe("WorkflowEngine — actor name uniqueness", () => {
  it("fails the run when a non-empty name repeats (both sites via the name argument)", async () => {
    const { engine, journal } = setup();
    engine.createActor("actor#1", "planner");
    // createActor is a synchronous surface (no promise to reject), so like assertRunning it throws.
    expect(() => engine.createActor("actor#2", "planner")).toThrow(
      expect.objectContaining({ code: "DuplicateActorName" }),
    );
    await expect(engine.settled).resolves.toMatchObject({
      status: "errored",
      error: expect.objectContaining({ code: "DuplicateActorName" }),
    });
    expect(journal.getRun(RUN)?.failure?.code).toBe("DuplicateActorName");
  });

  it("compares the effective name, so persona.name collides with a plain name argument", async () => {
    // Effective name = spec.name after normalizePersona; persona.name overrides the name argument. Dedup must check
    // that value, or name=b with persona.name=a bypasses the rule and mints two a's in the predecessor.
    const { engine } = setup();
    engine.createActor("actor#1", "reviewer");
    expect(() => engine.createActor("actor#2", "second", { name: "reviewer" })).toThrow(
      expect.objectContaining({ code: "DuplicateActorName" }),
    );
  });

  it("does not collide when persona.name renames one of two identical name arguments", async () => {
    // The rule's other side: identical name arguments with one persona.name override give different effective names.
    const { engine, journal } = setup();
    engine.createActor("actor#1", "worker");
    engine.createActor("actor#2", "worker", { name: "worker-2" });
    expect(journal.getRun(RUN)?.status).toBe("running");
    expect(
      journal
        .listActors(RUN, { withPersona: true })
        .map((a) => a.persona?.name)
        .sort(),
    ).toEqual(["worker", "worker-2"]);
  });

  it("allows any number of anonymous actors (absent or empty names)", async () => {
    // Anonymous is legal and unchecked -- the traded cost, already ruled: no cache eligibility. Empty string counts as anonymous, as does absence.
    const { engine, journal } = setup();
    engine.createActor("actor#1");
    engine.createActor("actor#2");
    engine.createActor("actor#3", "");
    engine.createActor("actor#4", "", { name: "" });
    expect(journal.getRun(RUN)?.status).toBe("running");
    expect(journal.listActors(RUN, { withPersona: true })).toHaveLength(4);
  });

  it("allows distinct names", async () => {
    const { engine, journal } = setup();
    engine.createActor("actor#1", "planner");
    engine.createActor("actor#2", "reviewer");
    expect(journal.getRun(RUN)?.status).toBe("running");
  });

  it("does not false-positive on a byte-identical resume (fresh engine, names re-registered once)", async () => {
    // Replay safety: the dedup table is purely in-memory, per engine instance. Resume re-runs the same
    // createActor sequence on a fresh engine, so each name registers exactly once -- also why it cannot be journalled.
    const journal = new InMemoryJournalStore();
    {
      const e1 = setup({ journal }).engine;
      e1.createActor("actor#1", "planner");
      e1.createActor("actor#2", "reviewer");
      e1.stop("user");
    }
    const { engine, journal: same } = setup({ journal });
    expect(() => {
      engine.createActor("actor#1", "planner");
      engine.createActor("actor#2", "reviewer");
    }).not.toThrow();
    expect(same.getRun(RUN)?.status).toBe("running");
  });
});

describe("WorkflowEngine — actor persona and resolved model", () => {
  // To the engine, persona is pure pass-through data: never interpreted, but forwarded verbatim to driver, events, and journal --
  // frozen identity, rebuilt from the same copy on resume. Model is not in persona (no tiers since 2026-09-11):
  // which model a subagent runs on is host fact, written by the driver into resolvedModel.
  it("carries the persona through to the driver, the actor-created event and the journal", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1", "judge", {
      system: "You judge.",
    });
    const p = engine.ask("ask#1", actor, "judge it");
    await flush();

    expect(driver.sessionPersonas[0]).toEqual({
      name: "judge",
      system: "You judge.",
    });
    const created = driver.events.find((e) => e.type === "actor-created");
    expect(created).toMatchObject({
      persona: { name: "judge", system: "You judge." },
    });
    expect(journal.getActor(RUN, "actor#1", 1)?.persona).toEqual({
      name: "judge",
      system: "You judge.",
    });

    engine.askTurnEnded(inst("ask#1"), "ok");
    await expect(p).resolves.toBe("ok");
  });

  // docs/dynamic-workflow/authoring.md, "Choosing a model per subagent": persona may name a model.
  // The engine records the name and hands it to the driver verbatim -- table lookups and session creation are host business.
  it("carries a persona model name verbatim to the driver, the event and the journal", async () => {
    const { engine, driver, journal } = setup();
    const actor = engine.createActor("actor#1", "judge", {
      system: "You judge.",
      model: "GLM-5.3-Flash$high",
    });
    const p = engine.ask("ask#1", actor, "judge it");
    await flush();

    const expected = { name: "judge", system: "You judge.", model: "GLM-5.3-Flash$high" };
    expect(driver.sessionPersonas[0]).toEqual(expected);
    expect(driver.events.find((e) => e.type === "actor-created")).toMatchObject({
      persona: expected,
    });
    expect(journal.getActor(RUN, "actor#1", 1)?.persona).toEqual(expected);
    // Birth facts repeat on dispatch, persona model name included (readers need it to re-attribute the subagent).
    expect(driver.events.find((e) => e.type === "node-dispatched")).toMatchObject({
      actorName: "judge",
      actorPersonaModel: "GLM-5.3-Flash$high",
    });

    engine.askTurnEnded(inst("ask#1"), "ok");
    await expect(p).resolves.toBe("ok");
  });

  it("a dispatch of a persona without a model carries no actorPersonaModel", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1", "judge", { system: "You judge." });
    const p = engine.ask("ask#1", actor, "judge it");
    await flush();
    const dispatched = driver.events.find((e) => e.type === "node-dispatched");
    expect(dispatched).toBeDefined();
    expect("actorPersonaModel" in dispatched!).toBe(false);
    engine.askTurnEnded(inst("ask#1"), "ok");
    await expect(p).resolves.toBe("ok");
  });

  it("keeps only the known string fields of an object persona off the wire", async () => {
    // Odd values smuggled via type assertions must not ride into the journal or the host's session creation.
    const { engine, journal } = setup();
    engine.createActor("actor#1", "judge", {
      system: "You judge.",
      model: 42,
      tools: "none",
    } as unknown as PersonaSpec);
    expect(journal.getActor(RUN, "actor#1", 1)?.persona).toEqual({
      name: "judge",
      system: "You judge.",
    });
  });

  it("carries a string persona through unchanged (nothing invented)", async () => {
    const { engine, journal } = setup();
    engine.createActor("actor#1", "planner", "You plan.");
    const persona = journal.getActor(RUN, "actor#1", 1)?.persona;
    expect(persona).toEqual({ name: "planner", system: "You plan." });
  });

  it("does not clobber the driver-written resolvedModel when journaling the session", async () => {
    // resolvedModel is driver-owned: only the host knows the model, so it is written inside createActorSession.
    // putActor replaces the whole record, though, and the engine writes once more after the session returns
    // (filling sessionId) -- that pass must carry resolvedModel, or cost auditing and resume pinning lose their basis
    // on the happy path.
    const { engine, journal } = setup({
      resolveModel: (persona) =>
        persona.name === "judge" ? "anthropic/haiku" : "anthropic/sonnet",
    });
    const actor = engine.createActor("actor#1", "judge", { system: "You judge." });
    const p = engine.ask("ask#1", actor, "judge it");
    await flush();

    const record = journal.getActor(RUN, "actor#1", 1);
    expect(record?.resolvedModel).toBe("anthropic/haiku");
    // On the same record, the engine's own fields remain intact.
    expect(record?.sessionId).toBe("session:actor#1@1");
    expect(record?.persona).toEqual({ name: "judge", system: "You judge." });

    engine.askTurnEnded(inst("ask#1"), "ok");
    await expect(p).resolves.toBe("ok");
  });

  it("preserves a journaled resolvedModel across a replayed createActor", async () => {
    // Resume path: on a second createActor for the same (siteId, ordinal), putActor must not wipe the model the
    // previous run resolved -- it is the very basis for re-attaching resume to the same model.
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({
      runId: RUN,
      siteId: "actor#1",
      ordinal: 1,
      sessionId: "session:actor#1@1",
      resolvedModel: "anthropic/haiku",
    });

    const { engine } = setup({ journal });
    engine.createActor("actor#1", "judge", { system: "You judge." });

    expect(journal.getActor(RUN, "actor#1", 1)).toMatchObject({
      sessionId: "session:actor#1@1",
      resolvedModel: "anthropic/haiku",
      persona: { name: "judge", system: "You judge." },
    });
  });
});

describe("WorkflowEngine — resume script identity", () => {
  /** Mints an existing run row (simulating a journal left by a previous run). */
  function seedRun(journal: InMemoryJournalStore, scriptHash?: string): void {
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 7,
      status: "stopped",
      stopReason: "user",
      ...(scriptHash === undefined ? {} : { scriptHash }),
    });
  }

  it("refuses to resume when the journaled scriptHash differs from the config's", () => {
    // The v1 resume rule is byte-identical script text. A hash mismatch means the caller reused the runId with a
    // different script: reject the resume up front rather than accept and fail later.
    const journal = new InMemoryJournalStore();
    seedRun(journal, "hash-old");
    const driver = new FakeDriver(journal);

    const construct = () =>
      new WorkflowEngine({
        runId: RUN,
        driver,
        caps: { maxConcurrency: 16 },
        askSpecs: new Map(),
        validate: () => [],
        scriptHash: "hash-new",
      });
    expect(construct).toThrowError(expect.objectContaining({ code: "ScriptHashMismatch" }));

    // Both hashes must ride the error structurally: whoever debugges the rejection sees which side changed
    // without regexing the message (control flow never depends on error text).
    let thrown: WorkflowError | undefined;
    try {
      construct();
    } catch (error) {
      thrown = error as WorkflowError;
    }
    expect(thrown?.mismatch).toEqual({ expected: "hash-old", got: "hash-new" });
    // The serialized journal form carries it too (failure_json is the app-side persistent record).
    expect(thrown?.toJSON()).toMatchObject({
      code: "ScriptHashMismatch",
      mismatch: { expected: "hash-old", got: "hash-new" },
    });
    expect(WorkflowError.fromJSON(thrown!.toJSON()).mismatch).toEqual({
      expected: "hash-old",
      got: "hash-new",
    });

    // The existing journal row must survive the rejection untouched -- the right script still resumes.
    expect(journal.getRun(RUN)).toMatchObject({
      status: "stopped",
      scriptHash: "hash-old",
      spentTokens: 7,
    });
    // The rejection precedes every event: no run-started, no run-settled.
    expect(driver.events).toEqual([]);
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })).toEqual([]);
  });

  it("resumes when the two hashes match", () => {
    const journal = new InMemoryJournalStore();
    seedRun(journal, "hash-same");
    const driver = new FakeDriver(journal);
    const engine = new WorkflowEngine({
      runId: RUN,
      driver,
      caps: { maxConcurrency: 16 },
      askSpecs: new Map(),
      validate: () => [],
      scriptHash: "hash-same",
    });
    expect(engine.status()).toBe("running");
    expect(journal.getRun(RUN)?.spentTokens).toBe(7); // budget still restored from the record
  });

  it("resumes when either side has no hash (records predating run metadata)", () => {
    // Reject only when both sides exist and differ: with one side missing there is nothing to compare, and no mismatch may be invented.
    const withoutRecordHash = new InMemoryJournalStore();
    seedRun(withoutRecordHash);
    expect(
      new WorkflowEngine({
        runId: RUN,
        driver: new FakeDriver(withoutRecordHash),
        caps: { maxConcurrency: 16 },
        askSpecs: new Map(),
        validate: () => [],
        scriptHash: "hash-new",
      }).status(),
    ).toBe("running");

    const withoutConfigHash = new InMemoryJournalStore();
    seedRun(withoutConfigHash, "hash-old");
    expect(
      new WorkflowEngine({
        runId: RUN,
        driver: new FakeDriver(withoutConfigHash),
        caps: { maxConcurrency: 16 },
        askSpecs: new Map(),
        validate: () => [],
      }).status(),
    ).toBe("running");
  });
});

describe("WorkflowEngine — askSpecs completeness", () => {
  it("fails the run loudly instead of degrading an unlisted ask site to untyped", async () => {
    // Site table and schema synthesis come from one compilation, so a miss is surely a wiring error. The old
    // `?? { typed: false }` fallback silently downgraded typed asks: no submit_result registration,
    // last-turn text as result, schema validation gone entirely -- a results-always-valid type system is worse than none.
    const { engine, driver } = setup({ askSpecs: typedSpecs(), validate: requireFields });
    const actor = engine.createActor("actor#1");

    const p = engine.ask("ask#2", actor, "unlisted site"); // askSpecs knows only ask#1
    await expect(p).rejects.toMatchObject({ code: "MissingAskSpec" });
    await flush();

    // Key assertion: it was never dispatched as untyped.
    expect(driver.startAsks).toEqual([]);
    await expect(engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "MissingAskSpec" },
    });
  });

  it("still honours an explicit untyped entry", async () => {
    // Untyped asks remain first-class -- they must simply be recorded as { typed: false } explicitly.
    const { engine, driver } = setup({ askSpecs: new Map([["ask#1", { typed: false }]]) });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "summarize");
    await flush();
    expect(driver.startAsks[0]?.message.typed).toBe(false);
    engine.askTurnEnded(inst("ask#1"), "the answer");
    await expect(p).resolves.toBe("the answer");
  });
});

describe("WorkflowEngine — world reads", () => {
  it("journals a world.run dispatch under kind world-run (effects are not reads)", async () => {
    // docs/dynamic-workflow/authoring.md, "Running commands: world.run": the run op is isomorphic to the other
    // world-read mechanics but journals kind world-run -- audit never disguises effects as reads.
    const { engine, driver, journal } = setup();
    const p = engine.worldRead("world-read#1", "run", ["lean", ["a.lean"], { timeoutMs: 60000 }]);
    expect(driver.worldReads[0]?.op).toBe("run");
    driver.worldReads[0]?.deferred.resolve({ exitCode: 1, stdout: "", stderr: "boom" });
    await expect(p).resolves.toEqual({ exitCode: 1, stdout: "", stderr: "boom" });

    const node = journal.getNode(RUN, "world-read#1", 1);
    expect(node?.kind).toBe("world-run");
    expect(node?.inputHash).toBe(
      inputHash({ op: "run", args: ["lean", ["a.lean"], { timeoutMs: 60000 }] }),
    );
    // The stream's node-queued carries world-run too.
    const queued = driver.events.find(
      (event) => event.type === "node-queued" && event.instance.siteId === "world-read#1",
    );
    expect(queued !== undefined && queued.type === "node-queued" ? queued.kind : undefined).toBe(
      "world-run",
    );
  });

  it("dispatches a live world read, journals it, and resolves", async () => {
    const { engine, driver, journal } = setup();
    const p = engine.worldRead("world-read#1", "glob", ["src/**"]);
    expect(driver.worldReads).toHaveLength(1);
    // Args reach the driver positionally verbatim (the engine reads no op, checks no arity).
    expect(driver.worldReads[0]?.args).toEqual(["src/**"]);
    driver.worldReads[0]?.deferred.resolve(["a.ts", "b.ts"]);
    await expect(p).resolves.toEqual(["a.ts", "b.ts"]);

    const node = journal.getNode(RUN, "world-read#1", 1);
    expect(node?.kind).toBe("world-read");
    expect(node?.result).toEqual(["a.ts", "b.ts"]);
    // inputHash covers {op, args} (formerly {op, arg}): the payload reshape is intentional, and older journals
    expect(node?.inputHash).toBe(inputHash({ op: "glob", args: ["src/**"] }));
    expect(node?.actorSeq).toBeUndefined();
  });

  it("hashes multi-argument world reads positionally (arg order is part of identity)", async () => {
    const { engine, driver, journal } = setup();
    // A glob carrying a multi-arg call: the engine never interprets args, so this pins positional-arrays-enter-the-hash,
    const p = engine.worldRead("world-read#1", "glob", ["a", "b"]);
    expect(driver.worldReads[0]?.args).toEqual(["a", "b"]);
    driver.worldReads[0]?.deferred.resolve(["hit"]);
    await expect(p).resolves.toEqual(["hit"]);
    expect(journal.getNode(RUN, "world-read#1", 1)?.inputHash).toBe(
      inputHash({ op: "glob", args: ["a", "b"] }),
    );
    // Order-sensitive: swapped args are a different read.
    expect(inputHash({ op: "glob", args: ["a", "b"] })).not.toBe(
      inputHash({ op: "glob", args: ["b", "a"] }),
    );
  });

  it("short-circuits a journaled world read with zero driver calls", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putNode({
      runId: RUN,
      siteId: "world-read#1",
      ordinal: 1,
      kind: "world-read",
      inputHash: inputHash({ op: "glob", args: ["src/**"] }),
      status: "completed",
      result: ["x.ts"],
    });
    const { engine, driver } = setup({ journal });
    const p = engine.worldRead("world-read#1", "glob", ["src/**"]);
    expect(driver.worldReads).toHaveLength(0);
    await expect(p).resolves.toEqual(["x.ts"]);
  });

  it("fails the run loudly when a journaled world read's args differ (arity/value change)", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putNode({
      runId: RUN,
      siteId: "world-read#1",
      ordinal: 1,
      kind: "world-read",
      inputHash: inputHash({ op: "glob", args: ["src/**"] }),
      status: "completed",
      result: ["x.ts"],
    });
    const { engine } = setup({ journal });
    // Same op, different args: the purity contract is broken -- fail the run loudly rather than return the old result.
    await expect(
      engine.worldRead("world-read#1", "glob", ["src/**", "extra"]),
    ).rejects.toMatchObject({
      code: "InputHashMismatch",
    });
    expect(journal.getRun(RUN)?.status).toBe("errored");
  });

  it("journals a multi-arg op's inputHash over {op, args} and short-circuits its replay", async () => {
    // Full round trip of a multi-arg op: files.grep(pattern, glob?) carries positional args and the key is
    // {op, args}. The second half proves replay hits make zero driver calls -- journalled world reads are exactly
    const hits = [{ path: "src/a.ts", line: 12, text: "// TODO" }];
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    const live = setup({ journal });
    const p = live.engine.worldRead("world-read#1", "grep", ["TODO", "*.ts"]);
    expect(live.driver.worldReads[0]?.op).toBe("grep");
    expect(live.driver.worldReads[0]?.args).toEqual(["TODO", "*.ts"]);
    live.driver.worldReads[0]?.deferred.resolve(hits);
    await expect(p).resolves.toEqual(hits);
    expect(journal.getNode(RUN, "world-read#1", 1)?.inputHash).toBe(
      inputHash({ op: "grep", args: ["TODO", "*.ts"] }),
    );

    // Replay over the same journal: hit, no dispatch.
    const replay = setup({ journal });
    const replayed = replay.engine.worldRead("world-read#1", "grep", ["TODO", "*.ts"]);
    expect(replay.driver.worldReads).toHaveLength(0);
    await expect(replayed).resolves.toEqual(hits);
  });

  it("distinguishes an omitted trailing optional from a present one (shorter args array)", async () => {
    // grep("TODO") and grep("TODO", "*.ts") must be distinct journal keys. Lowering packs the shorter
    expect(inputHash({ op: "grep", args: ["TODO"] })).not.toBe(
      inputHash({ op: "grep", args: ["TODO", "*.ts"] }),
    );
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putNode({
      runId: RUN,
      siteId: "world-read#1",
      ordinal: 1,
      kind: "world-read",
      inputHash: inputHash({ op: "grep", args: ["TODO"] }),
      status: "completed",
      result: [],
    });
    const { engine } = setup({ journal });
    await expect(engine.worldRead("world-read#1", "grep", ["TODO", "*.ts"])).rejects.toMatchObject({
      code: "InputHashMismatch",
    });
  });

  it("settles the node failed on a driver WorldReadCapExceeded, keeping the run alive", async () => {
    // Cap overflow is node-level: the script can catch it and narrow the pattern, so the run must survive,
    const { engine, driver, journal } = setup();
    const p = engine.worldRead("world-read#1", "grep", [".", undefined]);
    driver.worldReads[0]?.deferred.reject(
      new WorkflowError(
        "WorldReadCapExceeded",
        "grep matched over 2000 entries; narrow the pattern or add a glob",
      ),
    );
    await expect(p).rejects.toMatchObject({ code: "WorldReadCapExceeded" });
    const node = journal.getNode(RUN, "world-read#1", 1);
    expect(node?.status).toBe("failed");
    expect(node?.error?.code).toBe("WorldReadCapExceeded");
    // The run survives the rejection; the script continues -- that is what node-level means.
    expect(journal.getRun(RUN)?.status).toBe("running");
  });

  it("replays a journaled cap failure as the same structured rejection", async () => {
    // Failed nodes journal too (replay reliability: the script may have observed the rejection and branched on it).
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putNode({
      runId: RUN,
      siteId: "world-read#1",
      ordinal: 1,
      kind: "world-read",
      inputHash: inputHash({ op: "git-diff", args: [] }),
      status: "failed",
      error: { code: "WorldReadCapExceeded", message: "git.diff exceeded 512KB" },
    });
    const { engine, driver } = setup({ journal });
    await expect(engine.worldRead("world-read#1", "git-diff", [])).rejects.toMatchObject({
      code: "WorldReadCapExceeded",
    });
    expect(driver.worldReads).toHaveLength(0);
  });
});

describe("WorkflowEngine — lenient submit decode (real-model stringifies tool args)", () => {
  // A real subset validator: these scenarios need actual type decisions (object/number/anyOf) beyond the fake
  // required-only checker. Real models (GLM-5.3 in production) often pass submit_result's result as a JSON string
  // instead of an object; the engine must parse leniently, schema-aware -- see scheduler.normalizeSubmit.
  const realValidate: ValidateFn = (schema, value) => validate(schema as JsonSchema, value);

  const objectSchema: JsonSchema = {
    type: "object",
    required: ["title", "bullet_points"],
    properties: {
      title: { type: "string" },
      bullet_points: { type: "array", items: { type: "string" } },
    },
  };
  const specs = (schema: JsonSchema) =>
    new Map<string, AskSpec>([["ask#1", { typed: true, schema }]]);

  it("parses a stringified JSON object submit and journals the parsed OBJECT, not the string", async () => {
    const { engine, driver, journal } = setup({
      askSpecs: specs(objectSchema),
      validate: realValidate,
    });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    engine.askSubmitAttempted(inst("ask#1"), '{"title":"x","bullet_points":["a"]}');

    expect(driver.submitResponses.at(-1)?.verdict.kind).toBe("accept");
    await expect(p).resolves.toEqual({ title: "x", bullet_points: ["a"] });

    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.status).toBe("completed");
    // The parsed object is recorded, not the raw string.
    expect(node?.result).toEqual({ title: "x", bullet_points: ["a"] });
    expect(typeof node?.result).toBe("object");
  });

  it("repairs when a stringified submit parses to JSON of the wrong shape (not accepted)", async () => {
    const { engine, driver, journal } = setup({
      askSpecs: specs(objectSchema),
      validate: realValidate,
    });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    void p.catch(() => {}); // eventually rejects once repair is exhausted
    await flush();

    engine.askSubmitAttempted(inst("ask#1"), '{"unexpected":1}'); // parses to an object, missing required keys

    const last = driver.submitResponses.at(-1)?.verdict;
    expect(last?.kind).toBe("reject");
    expect(last?.kind === "reject" && last.violations.length).toBeGreaterThan(0);
    // Not yet settled: still the admission-time running row.
    expect(journal.getNode(RUN, "ask#1", 1)?.status).toBe("running");
  });

  it("reports POST-parse violations when a stringified object misses a required field", async () => {
    // Bug: when JSON.parse succeeded but the value still failed, repair used to report pre-parse violations
    const { engine, driver } = setup({ askSpecs: specs(objectSchema), validate: realValidate });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    void p.catch(() => {});
    await flush();

    engine.askSubmitAttempted(inst("ask#1"), '{"title":"x"}'); // parses to an object, missing bullet_points

    const last = driver.submitResponses.at(-1)?.verdict;
    expect(last?.kind).toBe("reject");
    // Violations must point into the parsed object's paths, not a root-level expected-object-got-string.
    expect(last?.kind === "reject" && last.violations).toContainEqual({
      path: "$.bullet_points",
      expected: "present",
      got: "missing",
    });
    expect(
      last?.kind === "reject" &&
        last.violations.some((v) => v.path === "$" && v.expected === "object"),
    ).toBe(false);
  });

  it("reports POST-parse violations on the nested path when a stringified array field has wrong item shape", async () => {
    // Mirrors the production Critique/gaps failure (dwfrun-bc01726f): schema wants string[], the model submits
    const { engine, driver } = setup({ askSpecs: specs(objectSchema), validate: realValidate });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    void p.catch(() => {});
    await flush();

    engine.askSubmitAttempted(inst("ask#1"), '{"title":"x","bullet_points":[["a"]]}');

    const last = driver.submitResponses.at(-1)?.verdict;
    expect(last?.kind).toBe("reject");
    expect(last?.kind === "reject" && last.violations).toContainEqual({
      path: "$.bullet_points[0]",
      expected: "string",
      got: "array(1)",
    });
    expect(
      last?.kind === "reject" &&
        last.violations.some((v) => v.path === "$" && v.expected === "object"),
    ).toBe(false);
  });

  it("repairs on a non-JSON string submit (JSON.parse throws → original violations)", async () => {
    const { engine, driver, journal } = setup({
      askSpecs: specs(objectSchema),
      validate: realValidate,
    });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    void p.catch(() => {});
    await flush();

    engine.askSubmitAttempted(inst("ask#1"), "hello"); // JSON.parse throws

    const last = driver.submitResponses.at(-1)?.verdict;
    expect(last?.kind).toBe("reject");
    // Reports the raw raw-value violation (object expected, string got).
    expect(last?.kind === "reject" && last.violations.some((v) => v.expected === "object")).toBe(
      true,
    );
    expect(journal.getNode(RUN, "ask#1", 1)?.status).toBe("running");
  });

  it("preserves a legitimately-string result: raw string that validates is NOT parsed", async () => {
    // anyOf string|null accepts the bare string -> straight pass, no parsing. "42" stays "42", never 42.
    const stringSchema: JsonSchema = { anyOf: [{ type: "string" }, { type: "null" }] };
    const { engine, driver, journal } = setup({
      askSpecs: specs(stringSchema),
      validate: realValidate,
    });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    engine.askSubmitAttempted(inst("ask#1"), "42");

    expect(driver.submitResponses.at(-1)?.verdict.kind).toBe("accept");
    await expect(p).resolves.toBe("42");
    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.result).toBe("42");
    expect(typeof node?.result).toBe("string");
  });

  it("parses a number-string when the schema expects a number", async () => {
    const numberSchema: JsonSchema = { type: "number" };
    const { engine, driver, journal } = setup({
      askSpecs: specs(numberSchema),
      validate: realValidate,
    });
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    engine.askSubmitAttempted(inst("ask#1"), "42");

    expect(driver.submitResponses.at(-1)?.verdict.kind).toBe("accept");
    await expect(p).resolves.toBe(42);
    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.result).toBe(42);
    expect(typeof node?.result).toBe("number");
  });
});

// report (execution-engine.md, "Progressive results"): fire-and-forget, no driver round trip, but journalled.
// This group pins three things: the write-once node shape, replay dedupe, and the two caps.
describe("WorkflowEngine — report", () => {
  it("journals one already-settled node and emits one event", () => {
    const { engine, journal, driver } = setup();
    engine.report("report#1", { finding: "dup impl", paths: ["a.ts", "b.ts"] });

    const node = journal.getNode(RUN, "report#1", 1);
    // Written once, settled, no actor fields, result is the item -- the sole exception to the two-write rule.
    expect(node).toMatchObject({
      kind: "report",
      status: "completed",
      result: { finding: "dup impl", paths: ["a.ts", "b.ts"] },
    });
    expect(node?.inputHash).toBe(inputHash({ finding: "dup impl", paths: ["a.ts", "b.ts"] }));
    expect(node !== undefined && "actorSeq" in node).toBe(false);
    expect(driver.eventsOfType("report")).toEqual([
      {
        type: "report",
        instance: inst("report#1"),
        item: { finding: "dup impl", paths: ["a.ts", "b.ts"] },
      },
    ]);
  });

  it("assigns per-site ordinals so one site reported twice is two nodes", () => {
    const { engine, journal, driver } = setup();
    engine.report("report#1", "first");
    engine.report("report#1", "second");
    engine.report("report#2", "other-site");

    expect(journal.getNode(RUN, "report#1", 1)?.result).toBe("first");
    expect(journal.getNode(RUN, "report#1", 2)?.result).toBe("second");
    expect(journal.getNode(RUN, "report#2", 1)?.result).toBe("other-site");
    expect(driver.eventsOfType("report")).toHaveLength(3);
  });

  it("ignores reports after the run settles (like log)", () => {
    const { engine, journal, driver } = setup();
    engine.complete("done");
    engine.report("report#1", "too late");

    expect(journal.getNode(RUN, "report#1", 1)).toBeUndefined();
    expect(driver.eventsOfType("report")).toEqual([]);
  });

  it("skips a journaled report on replay: no event, no re-append", () => {
    // The script re-runs, so every report call executes again; already-journalled (siteId, ordinal) pairs skip silently --
    // else the Results panel would show one finding twice after resume, defeating journaling's purpose.
    const journal = new InMemoryJournalStore();
    const first = setup({ journal });
    first.engine.report("report#1", { n: 1 });
    first.engine.report("report#1", { n: 2 });
    first.engine.complete("ok");

    const before = journal.listEvents(RUN, { types: "all", reportItems: "all" }).length;
    const resumed = setup({ journal });
    resumed.engine.report("report#1", { n: 1 });
    resumed.engine.report("report#1", { n: 2 });

    expect(resumed.driver.eventsOfType("report")).toEqual([]);
    expect(
      journal.listNodes(RUN, { kinds: "all", withResult: true }).filter((n) => n.kind === "report"),
    ).toHaveLength(2);
    // Resume adds one run-started and appends zero report events.
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" }).length).toBe(before + 1);
  });

  it("fails the run with InputHashMismatch when a replayed item differs", () => {
    // This comparison is defensive (the report derives from journal-pinned values), but a drift here means replay
    const journal = new InMemoryJournalStore();
    setup({ journal }).engine.report("report#1", { n: 1 });

    const resumed = setup({ journal });
    resumed.engine.report("report#1", { n: 999 });

    return expect(resumed.engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "InputHashMismatch" },
    });
  });

  it("hashes canonically, so key order in the item is not a mismatch", () => {
    // inputHash uses canonicalJson (keys sorted by code point), so literal key-order changes are not purity violations --
    const journal = new InMemoryJournalStore();
    setup({ journal }).engine.report("report#1", { a: 1, b: 2 });

    const resumed = setup({ journal });
    resumed.engine.report("report#1", { b: 2, a: 1 });

    expect(resumed.driver.eventsOfType("report")).toEqual([]);
    expect(journal.getRun(RUN)?.status).toBe("running");
  });

  it("fails the run with ReportCapExceeded on the item past the cap (65,537th)", () => {
    const { engine, journal } = setup();
    expect(REPORT_CAPS.maxItemsPerRun).toBe(65_536);
    for (let i = 0; i < REPORT_CAPS.maxItemsPerRun; i += 1) engine.report("report#1", i);
    expect(journal.getRun(RUN)?.status).toBe("running");

    engine.report("report#1", "one too many");

    expect(journal.countNodes(RUN, "report")).toBe(REPORT_CAPS.maxItemsPerRun);
    return expect(engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "ReportCapExceeded" },
    });
  });

  it("fails the run with ReportCapExceeded on an oversized item, journaling nothing", () => {
    const { engine, journal } = setup();
    engine.report("report#1", "x".repeat(REPORT_CAPS.maxItemSerializedBytes));

    // The cap precedes journaling: an overflowing item enters the journal byte-free.
    expect(journal.getNode(RUN, "report#1", 1)).toBeUndefined();
    return expect(engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "ReportCapExceeded" },
    });
  });

  it("accepts an item of exactly the per-item limit", () => {
    const { engine, journal } = setup();
    expect(REPORT_CAPS.maxItemSerializedBytes).toBe(1024 * 1024);
    // JSON's two quotes count toward the bytes: two fewer in the body lands exactly at the cap once serialized.
    engine.report("report#1", "x".repeat(REPORT_CAPS.maxItemSerializedBytes - 2));

    expect(journal.getNode(RUN, "report#1", 1)?.status).toBe("completed");
    expect(journal.getRun(RUN)?.status).toBe("running");
  });

  it("fails the run with ReportCapExceeded when its reports would pass the per-run byte limit, counted across resume", () => {
    // A true 1GiB run is unbuildable in a unit test, so the journal reports a near-cap byte sum on resume:
    const nearlyFull = REPORT_CAPS.maxBytesPerRun - 50;
    class NearlyFullJournal extends InMemoryJournalStore {
      override sumResultBytes(runId: string, kind: NodeKind): number {
        return super.sumResultBytes(runId, kind) + nearlyFull;
      }
    }
    const journal = new NearlyFullJournal();
    const first = setup({ journal });
    first.engine.report("report#1", "a"); // 3 bytes; the first incarnation never reads sumResultBytes
    first.engine.stop("user");

    const resumed = setup({ journal });
    resumed.engine.report("report#1", "a"); // hit, skipped
    // 3 + nearlyFull + 42 = cap - 5: fits.
    resumed.engine.report("report#1", "x".repeat(40));
    expect(journal.getRun(RUN)?.status).toBe("running");
    // Ten more bytes overshoot: the whole run fails and this one is not journalled.
    resumed.engine.report("report#1", "y".repeat(8));

    expect(journal.countNodes(RUN, "report")).toBe(2);
    return expect(resumed.engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "ReportCapExceeded", message: expect.stringContaining("limit per run") },
    });
  });

  it("measures the cap in UTF-8 bytes, not characters", () => {
    // A Chinese findings string has a third as many chars as bytes; counting chars would gut the cap.
    const { engine, journal } = setup();
    // Three bytes per char plus JSON's two quotes: one past the cap.
    const chars = Math.ceil(REPORT_CAPS.maxItemSerializedBytes / 3);
    engine.report("report#1", "\u7ed3".repeat(chars));

    expect(journal.getNode(RUN, "report#1", 1)).toBeUndefined();
    return expect(engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "ReportCapExceeded" },
    });
  });

  it("restores the report count across resume so the cap is run-level", () => {
    // The cap is run-level, so the count must survive resume -- else a repeatedly-resumed run reports forever.
    const journal = new InMemoryJournalStore();
    const first = setup({ journal });
    for (let i = 0; i < REPORT_CAPS.maxItemsPerRun; i += 1) first.engine.report("report#1", i);
    first.engine.stop("user");

    // On resume the script re-runs: the first 65,536 hit and skip, the next is new -- the cap must still stop it.
    const resumed = setup({ journal });
    for (let i = 0; i < REPORT_CAPS.maxItemsPerRun; i += 1) resumed.engine.report("report#1", i);
    expect(resumed.driver.eventsOfType("report")).toEqual([]);
    resumed.engine.report("report#1", "one past the cap");

    return expect(resumed.engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "ReportCapExceeded" },
    });
  });

  it("fails the run loudly when the item is not a JSON value", () => {
    // A runtime guard (compile-time serializability checks are the suspenders). canonicalJson is total -- it folds
    const { engine, journal } = setup();
    engine.report("report#1", undefined);

    expect(journal.getNode(RUN, "report#1", 1)).toBeUndefined();
    return expect(engine.settled).resolves.toMatchObject({ status: "errored" });
  });

  it("fails the run loudly on a cyclic item instead of blowing the stack", () => {
    // canonicalJson blow the stack on cycles -- a crash, not a readable failure -- so the probe must run first.
    const { engine, journal } = setup();
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(() => engine.report("report#1", cyclic)).not.toThrow();

    expect(journal.getNode(RUN, "report#1", 1)).toBeUndefined();
    return expect(engine.settled).resolves.toMatchObject({
      status: "errored",
      error: { code: "DriverError" },
    });
  });
});

// enterPhase (docs/dynamic-workflow/presentation.md): control flow crossed a
// phase marker. Same posture as log -- synchronous, no driver round trip, no-op after settlement -- but counted by name.
describe("WorkflowEngine — enterPhase", () => {
  it("emits phase-entered with a per-name ordinal and writes no journal row", () => {
    const { engine, journal, driver } = setup();
    engine.enterPhase("plan");
    engine.enterPhase("verify");
    engine.enterPhase("plan");
    expect(driver.eventsOfType("phase-entered")).toEqual([
      { type: "phase-entered", name: "plan", ordinal: 1 },
      { type: "phase-entered", name: "verify", ordinal: 1 },
      // Same-name reentry is another lap: the analyzer reads the second same-name marker as a back edge too.
      { type: "phase-entered", name: "plan", ordinal: 2 },
    ]);
    // Markers are not sites: no dwf_node row and no site ordinal consumed.
    expect(journal.listNodes(RUN, { kinds: "all", withResult: true })).toEqual([]);
  });

  it("trims the name, drops an empty one, and does not share ordinals with sites", () => {
    const { engine, driver } = setup();
    engine.enterPhase("  plan  ");
    engine.enterPhase("   ");
    engine.report("report#1", "x");
    engine.enterPhase("report#1");
    expect(driver.eventsOfType("phase-entered")).toEqual([
      { type: "phase-entered", name: "plan", ordinal: 1 },
      // A phase name that looks exactly like a site id: its count starts at 1 and report#1's node ordinal is untouched.
      { type: "phase-entered", name: "report#1", ordinal: 1 },
    ]);
  });

  it("is a no-op after the run settled", () => {
    const { engine, driver } = setup();
    engine.complete("done");
    engine.enterPhase("late");
    expect(driver.eventsOfType("phase-entered")).toEqual([]);
  });
});

/**
 * A thin wrapper that keeps a reference to the raw object given to appendEvent (the memory journal clones,
 * so the stored copy is no longer the one the engine passed). Pins journal-and-emit-see-the-same-object --
 * bootstrap's createJournalSequenceCapture checks sequence numbers by reference equality.
 */
class CapturingJournal extends InMemoryJournalStore {
  readonly appended: RunEvent[] = [];

  override appendEvent(runId: string, event: RunEvent): StoredEvent {
    this.appended.push(event);
    return super.appendEvent(runId, event);
  }
}

// Birth-phase coordinates (docs/dynamic-workflow/presentation.md): an instance records the phase
// at the moment its ordinal is minted, and the birth event carries phaseName. Minting and emission can be
// separated (the hold rule), so the stamp must come from the minting instant.
describe("WorkflowEngine -- birth-phase coordinates (phaseName)", () => {
  it("stamps the actor and the nodes minted after a phase marker", async () => {
    const { engine, driver } = setup();
    engine.enterPhase("Plan");
    const actor = engine.createActor("actor#1", "planner");
    void engine.ask("ask#1", actor, "do it");
    void engine.worldRead("world-read#1", "glob", ["src/**"]);
    await flush();

    expect(driver.eventsOfType("actor-created")[0]).toMatchObject({ phaseName: "Plan" });
    // ask and world-read take different admission paths (scheduler vs engine); both stamps come from the same minting point.
    expect(
      driver.eventsOfType("node-queued").map((e) => [refToString(e.instance), e.phaseName]),
    ).toEqual([
      ["ask#1@1", "Plan"],
      ["world-read#1@1", "Plan"],
    ]);
  });

  it("leaves instances born before any marker unstamped", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    void engine.ask("ask#1", actor, "do it");
    engine.enterPhase("Plan");
    await flush();

    // No-stamp means the key is absent, not undefined: readers (schema/reducer) distinguish the two.
    expect(driver.eventsOfType("actor-created")[0]).not.toHaveProperty("phaseName");
    expect(driver.eventsOfType("node-queued")[0]).not.toHaveProperty("phaseName");
  });

  it("carries the birth phase even when the queue event lands after a later marker", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    // The previous incarnation recorded only seq0 = ask#2@1. On this pass the earlier-firing ask#1 is fresh and
    journal.putNode({
      runId: RUN,
      siteId: "ask#2",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("B"),
      status: "completed",
      result: "r2",
    });

    const { engine, driver } = setup({ journal });
    const actor = engine.createActor("actor#1");
    engine.enterPhase("A");
    const pA = engine.ask("ask#1", actor, "A"); // ordinal minted at A, not yet queued
    expect(driver.eventsOfType("node-queued")).toEqual([]);
    engine.enterPhase("B");
    const pB = engine.ask("ask#2", actor, "B"); // hits seq0 -> releases it; ask#1 follows
    await flush();

    const queued = driver.eventsOfType("node-queued");
    expect(queued).toHaveLength(1);
    expect(refToString(queued[0]!.instance)).toBe("ask#1@1");
    // The event fires after B's marker yet stamps A: stamps come from the minting point, not emission.
    expect(driver.events.indexOf(queued[0]!)).toBeGreaterThan(
      driver.events.findIndex((e) => e.type === "phase-entered" && e.name === "B"),
    );
    expect(queued[0]!.phaseName).toBe("A");
    // A hit born at B during the same re-run stamps B.
    expect(driver.eventsOfType("node-settled")[0]).toMatchObject({
      cached: true,
      phaseName: "B",
    });

    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(Promise.all([pA, pB])).resolves.toEqual(["RA", "r2"]);
  });

  it("stamps a replay-cached node-settled with the phase current at that point of the re-run", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("A"),
      status: "completed",
      result: "r1",
    });

    const { engine, driver } = setup({ journal });
    // The re-run walks the same markers, so hit nodes get the predecessor's stamp in this incarnation.
    engine.enterPhase("Plan");
    const actor = engine.createActor("actor#1");
    await expect(engine.ask("ask#1", actor, "A")).resolves.toBe("r1");

    expect(driver.startAskCount()).toBe(0);
    expect(driver.eventsOfType("actor-created")[0]).toMatchObject({ phaseName: "Plan" });
    // Hit nodes skip node-queued; this cached settle is their birth event.
    expect(driver.eventsOfType("node-queued")).toEqual([]);
    expect(driver.eventsOfType("node-settled")[0]).toMatchObject({
      cached: true,
      phaseName: "Plan",
    });
  });

  it("a replayed ask's cached node-settled repeats its birth facts and names no predecessor session", async () => {
    // A plain resume (no imported cache): hit rows were produced by this run and their exchanges live in this
    // run's session, so no sourceSessionId; birth facts still ride along -- readers use them to attribute nodes
    // (docs/execution-engine.md, "Events"). Failed rows replay-short-circuit the same way, flags included.
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    const row = (siteId: string, seq: number, instructions: string): NodeRecord => ({
      runId: RUN,
      siteId,
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: seq,
      inputHash: inputHash(instructions),
      status: "completed",
      result: `r-${siteId}`,
    });
    journal.putNode(row("ask#1", 0, "first task"));
    journal.putNode({
      ...row("ask#2", 1, "second task"),
      status: "failed",
      error: new WorkflowError("DriverError", "boom").toJSON(),
    });

    const { engine, driver } = setup({ journal });
    const actor = engine.createActor("actor#1");
    await expect(engine.ask("ask#1", actor, "first task")).resolves.toBe("r-ask#1");
    await expect(engine.ask("ask#2", actor, "second task")).rejects.toMatchObject({
      code: "DriverError",
    });

    expect(driver.startAskCount()).toBe(0);
    const facts = { kind: "ask", actor: { siteId: "actor#1", ordinal: 1 } };
    expect(driver.eventsOfType("node-settled")).toEqual([
      {
        type: "node-settled",
        instance: { siteId: "ask#1", ordinal: 1 },
        outcome: "ok",
        cached: true,
        ...facts,
        actorSeq: 0,
        instructionsHead: "first task",
      },
      {
        type: "node-settled",
        instance: { siteId: "ask#2", ordinal: 1 },
        outcome: "failed",
        cached: true,
        error: expect.objectContaining({ code: "DriverError" }),
        ...facts,
        actorSeq: 1,
        instructionsHead: "second task",
      },
    ]);
  });

  it("stamps an ask's node-dispatched with its own birth phases, not a live node-settled", async () => {
    const { engine, driver } = setup();
    engine.enterPhase("Plan");
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();
    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");

    // Birth facts repeat on dispatch, both phase names present (each from its own minting point).
    expect(driver.eventsOfType("node-dispatched")[0]).toMatchObject({
      phaseName: "Plan",
      actorPhaseName: "Plan",
    });
    // Other node-* events still omit it (the reducer carries it forward, per the actorSiteId precedent).
    expect(driver.eventsOfType("node-settled")[0]).not.toHaveProperty("phaseName");
  });

  it("dispatches with the birth phases even after the script walked into later phases", async () => {
    // Dispatch is parked on session creation while the script crosses two markers: the stamp must stay the birth one, not the current phase.
    const { engine, driver } = setup({ deferSessions: true });
    engine.enterPhase("A");
    const actor = engine.createActor("actor#1", "planner");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();
    expect(driver.eventsOfType("node-dispatched")).toEqual([]);

    engine.enterPhase("B");
    engine.enterPhase("C");
    driver.sessionDeferrals[0]!.resolve({ id: "session:actor#1@1" });
    await flush();

    const dispatched = driver.eventsOfType("node-dispatched");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ phaseName: "A", actorPhaseName: "A" });
    // Dispatch really does land after C's marker (else the assertion above holds by accident).
    expect(driver.events.indexOf(dispatched[0]!)).toBeGreaterThan(
      driver.events.findIndex((e) => e.type === "phase-entered" && e.name === "C"),
    );

    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");
  });

  it("leaves the dispatch of an unstamped instance and of a world read bare", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    void engine.worldRead("world-read#1", "glob", ["src/**"]);
    // Both markers postdate the two instances: absent from the birth table, neither dispatch may grow a phase name.
    engine.enterPhase("Plan");
    await flush();

    // world-read dispatches synchronously while ask waits a microtask for session creation, so the read lands first.
    const dispatched = driver.eventsOfType("node-dispatched");
    expect(dispatched.map((e) => refToString(e.instance))).toEqual(["world-read#1@1", "ask#1@1"]);
    for (const event of dispatched) {
      expect(event).not.toHaveProperty("phaseName");
      expect(event).not.toHaveProperty("actorPhaseName");
    }

    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");
  });

  it("hands the journal and the driver the same stamped object", async () => {
    const journal = new CapturingJournal();
    const { engine, driver } = setup({ journal });
    engine.enterPhase("Plan");
    const actor = engine.createActor("actor#1");
    void engine.ask("ask#1", actor, "do it");
    await flush();

    expect(journal.appended).toHaveLength(driver.events.length);
    journal.appended.forEach((event, i) => {
      expect(event).toBe(driver.events[i]);
    });
    // The stamped one must be the same object especially: stamping builds a new object both paths must share.
    // Three events: actor-created, node-queued, and the birth-fact-repeating node-dispatched.
    expect(journal.appended.filter((e) => "phaseName" in e && e.phaseName === "Plan")).toHaveLength(
      3,
    );
  });
});

/**
 * Birth facts repeat on dispatch (the node-dispatched row of docs/execution-engine.md, "Events"): bounded readers
 */
describe("WorkflowEngine -- node-dispatched repeats birth facts", () => {
  it("repeats exactly what the instance's node-queued and its actor-created carried", async () => {
    const { engine, driver } = setup();
    engine.enterPhase("Plan");
    const actor = engine.createActor("actor#1", "planner");
    const p = engine.ask("ask#1", actor, "  Draft a research outline  ");
    await flush();

    const created = driver.eventsOfType("actor-created")[0]!;
    const queued = driver.eventsOfType("node-queued")[0]!;
    const dispatched = driver.eventsOfType("node-dispatched")[0]!;
    expect(dispatched).toEqual({
      type: "node-dispatched",
      instance: queued.instance,
      kind: queued.kind,
      actor: queued.actor,
      actorName: created.name,
      actorPhaseName: created.phaseName,
      phaseName: queued.phaseName,
      instructionsHead: queued.instructionsHead,
    });
    // Identical verbatim, not merely in shape: instructionsHead is the admission-time copy (trimmed, no ellipsis).
    expect(dispatched.instructionsHead).toBe("Draft a research outline");
    expect(dispatched.actorName).toBe("planner");

    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");
  });

  it("omits the name of an anonymous subagent and keeps a world read's dispatch bare", async () => {
    const { engine, driver } = setup();
    const actor = engine.createActor("actor#1");
    const p = engine.ask("ask#1", actor, "do it");
    void engine.worldRead("world-read#1", "glob", ["src/**"]);
    await flush();

    // Anonymous actor: actor-created's name is empty (the key absent once serialized); dispatch may not invent one either.
    expect(driver.eventsOfType("actor-created")[0]!.name).toBeUndefined();
    const [world, ask] = driver.eventsOfType("node-dispatched");
    expect(ask).toEqual({
      type: "node-dispatched",
      instance: inst("ask#1"),
      kind: "ask",
      actor: { siteId: "actor#1", ordinal: 1 },
      instructionsHead: "do it",
    });
    // world-read dispatch carries no birth facts: it follows its own node-queued and has no subagent.
    expect(world).toEqual({ type: "node-dispatched", instance: inst("world-read#1") });

    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");
  });

  it("carries the facts of the new life when a running row is re-queued on resume", async () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
    });
    journal.putActor({ runId: RUN, siteId: "actor#1", ordinal: 1 });
    // The previous incarnation crashed mid-flight: this row is running, and the re-run must re-dispatch by the recorded actorSeq.
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("do it"),
      status: "running",
    });

    const { engine, driver } = setup({ journal });
    engine.enterPhase("Rerun");
    const actor = engine.createActor("actor#1", "planner");
    const p = engine.ask("ask#1", actor, "do it");
    await flush();

    // The new incarnation is born once more; dispatch carries exactly what this incarnation's node-queued carried.
    const queued = driver.eventsOfType("node-queued")[0]!;
    const dispatched = driver.eventsOfType("node-dispatched")[0]!;
    expect(queued.phaseName).toBe("Rerun");
    expect(dispatched).toMatchObject({
      kind: queued.kind,
      actor: queued.actor,
      actorName: "planner",
      actorPhaseName: "Rerun",
      phaseName: "Rerun",
      instructionsHead: queued.instructionsHead,
    });

    engine.askTurnEnded(inst("ask#1"), "RA");
    await expect(p).resolves.toBe("RA");
  });
});

describe("run-launched: the launching turn's anchor (docs/execution-engine.md, Token telemetry for subagents)", () => {
  const make = (journal: InMemoryJournalStore) =>
    new WorkflowEngine({
      runId: RUN,
      driver: new FakeDriver(journal),
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1"),
      validate: () => [],
      toolCallId: "tool-1",
      parentSessionId: "parent-1",
      launch: { inputId: "launch-input-1" },
    });

  it("records run-launched right after the first run-started in the creating incarnation, with inputId/toolCallId/parentSessionId", () => {
    const journal = new InMemoryJournalStore();
    make(journal);
    expect(
      journal
        .listEvents(RUN, { types: "all", reportItems: "all" })
        .map((stored) => stored.event.type),
    ).toEqual(["run-started", "run-launched"]);
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]?.event).toEqual({
      type: "run-launched",
      inputId: "launch-input-1",
      toolCallId: "tool-1",
      parentSessionId: "parent-1",
    });
  });

  it("replays on the same journal emitting only run-started, never a second run-launched", () => {
    const journal = new InMemoryJournalStore();
    make(journal);
    make(journal);
    expect(
      journal
        .listEvents(RUN, { types: "all", reportItems: "all" })
        .map((stored) => stored.event.type),
    ).toEqual(["run-started", "run-launched", "run-started"]);
  });

  it("records no anchor without a launch payload (CLI and legacy host assemblies)", () => {
    const journal = new InMemoryJournalStore();
    new WorkflowEngine({
      runId: RUN,
      driver: new FakeDriver(journal),
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1"),
      validate: () => [],
    });
    expect(
      journal
        .listEvents(RUN, { types: "all", reportItems: "all" })
        .map((stored) => stored.event.type),
    ).toEqual(["run-started"]);
  });

  it("forwards launch phaseNames verbatim (the sidebar mini-track's site source)", () => {
    const journal = new InMemoryJournalStore();
    new WorkflowEngine({
      runId: RUN,
      driver: new FakeDriver(journal),
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1"),
      validate: () => [],
      launch: { inputId: "launch-input-2", phaseNames: ["Research", "Write"] },
    });
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]?.event).toEqual({
      type: "run-launched",
      inputId: "launch-input-2",
      phaseNames: ["Research", "Write"],
    });
  });

  // This run's subagent model (docs/dynamic-workflow/launch.md) rides with the anchor and phase table: zero SQL,
  // recorded once in this event by the creating incarnation. The engine never reads it -- the model surface for
  // subagent sessions is host-side (bootstrap's workflow-actor-model.ts); the host reads the same canonical string
  it("forwards launch subagentModel verbatim, level segment included, without a second record on resume", () => {
    const journal = new InMemoryJournalStore();
    const withModel = () =>
      new WorkflowEngine({
        runId: RUN,
        driver: new FakeDriver(journal),
        caps: { maxConcurrency: 16 },
        askSpecs: untypedSpecs("ask#1"),
        validate: () => [],
        launch: { inputId: "launch-input-3", subagentModel: "zhipu/glm-5.3-flash$high" },
      });
    withModel();
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]?.event).toEqual({
      type: "run-launched",
      inputId: "launch-input-3",
      // The level segment rides verbatim: $high is the user's spoken half, transcribed not parsed.
      subagentModel: "zhipu/glm-5.3-flash$high",
    });

    // Continuation incarnations never re-record it (same gate as the anchor): one subagent model per run across lifecycles.
    withModel();
    expect(
      journal
        .listEvents(RUN, { types: "all", reportItems: "all" })
        .filter((stored) => stored.event.type === "run-launched"),
    ).toHaveLength(1);
  });

  // The script-named model binding table (docs/dynamic-workflow/launch.md, Models the script names) rides under
  it("forwards launch modelBindings verbatim, without a second record on resume", () => {
    const journal = new InMemoryJournalStore();
    const bindings = {
      "GLM-5.3-Flash": "zhipu/GLM-5.3-Flash$high",
      "GLM-5.3$high": "zhipu/GLM-5.3$high",
    };
    const withBindings = () =>
      new WorkflowEngine({
        runId: RUN,
        driver: new FakeDriver(journal),
        caps: { maxConcurrency: 16 },
        askSpecs: untypedSpecs("ask#1"),
        validate: () => [],
        launch: { inputId: "launch-input-4", modelBindings: bindings },
      });
    withBindings();
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]?.event).toEqual({
      type: "run-launched",
      inputId: "launch-input-4",
      modelBindings: bindings,
    });
    withBindings();
    expect(
      journal
        .listEvents(RUN, { types: "all", reportItems: "all" })
        .filter((stored) => stored.event.type === "run-launched"),
    ).toHaveLength(1);
  });

  it("omits the whole key when launch carries no modelBindings", () => {
    const journal = new InMemoryJournalStore();
    make(journal);
    expect(
      "modelBindings" in journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]!.event,
    ).toBe(false);
  });

  it("omits the whole key without launch subagentModel (absent means the session model)", () => {
    const journal = new InMemoryJournalStore();
    make(journal);
    // An undefined-valued key would read unset as set-to-empty -- different meanings in AmendWorkflow's three states.
    expect(
      "subagentModel" in journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]!.event,
    ).toBe(false);
  });

  // This run's script file (the Provenance of docs/dynamic-workflow/launch.md, Script files) follows the same
  // per-item rules as the subagent model: zero SQL, unread by the engine, recorded once at creation. The host
  it("forwards launch scriptPath verbatim as an absolute path, without a second record on resume", () => {
    const journal = new InMemoryJournalStore();
    const withPath = () =>
      new WorkflowEngine({
        runId: RUN,
        driver: new FakeDriver(journal),
        caps: { maxConcurrency: 16 },
        askSpecs: untypedSpecs("ask#1"),
        validate: () => [],
        launch: {
          inputId: "launch-input-4",
          scriptPath: "/repo/.zcode/workflow-drafts/audit.dwf.ts",
        },
      });
    withPath();
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]?.event).toEqual({
      type: "run-launched",
      inputId: "launch-input-4",
      scriptPath: "/repo/.zcode/workflow-drafts/audit.dwf.ts",
    });

    // Continuations never re-record it (same gate as anchor and subagent model): one script file per run across lifecycles.
    withPath();
    expect(
      journal
        .listEvents(RUN, { types: "all", reportItems: "all" })
        .filter((stored) => stored.event.type === "run-launched"),
    ).toHaveLength(1);
  });

  it("omits the whole key without launch scriptPath (absent means no editable script file)", () => {
    const journal = new InMemoryJournalStore();
    make(journal);
    // Same argument as subagentModel: an undefined-valued key would read no-file as file-with-empty-path,
    expect(
      "scriptPath" in journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]!.event,
    ).toBe(false);
  });

  it("co-locates scriptPath, subagent model, and phase table in one run-launched", () => {
    const journal = new InMemoryJournalStore();
    new WorkflowEngine({
      runId: RUN,
      driver: new FakeDriver(journal),
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1"),
      validate: () => [],
      launch: {
        inputId: "launch-input-5",
        phaseNames: ["Research"],
        subagentModel: "zhipu/glm-5.3-flash$high",
        scriptPath: "/repo/.zcode/workflow-drafts/audit.dwf.ts",
      },
    });
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]?.event).toEqual({
      type: "run-launched",
      inputId: "launch-input-5",
      phaseNames: ["Research"],
      subagentModel: "zhipu/glm-5.3-flash$high",
      scriptPath: "/repo/.zcode/workflow-drafts/audit.dwf.ts",
    });
  });

  it("journals phaseAlongside with the phase table, omitting absent keys (the engine reads neither)", () => {
    const journal = new InMemoryJournalStore();
    new WorkflowEngine({
      runId: RUN,
      driver: new FakeDriver(journal),
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1"),
      validate: () => [],
      launch: {
        inputId: "launch-input-3",
        phaseNames: ["A", "B", "C"],
        phaseAlongside: [[], [0], []],
      },
    });
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]?.event).toEqual({
      type: "run-launched",
      inputId: "launch-input-3",
      phaseNames: ["A", "B", "C"],
      phaseAlongside: [[], [0], []],
    });

    const straight = new InMemoryJournalStore();
    new WorkflowEngine({
      runId: RUN,
      driver: new FakeDriver(straight),
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1"),
      validate: () => [],
      launch: { inputId: "launch-input-4", phaseNames: ["A"] },
    });
    expect(
      Object.hasOwn(
        straight.listEvents(RUN, { types: "all", reportItems: "all" })[1]!.event,
        "phaseAlongside",
      ),
    ).toBe(false);
  });
});

describe("usage accumulates along the lineage (docs/execution-engine.md, Usage across the lineage)", () => {
  const eventTypes = (journal: InMemoryJournalStore) =>
    journal
      .listEvents(RUN, { types: "all", reportItems: "all" })
      .map((stored) => stored.event.type);
  const make = (
    journal: InMemoryJournalStore,
    opts: { inheritedTokens?: number; launch?: { inputId: string } } = {},
  ) => {
    const driver = new FakeDriver(journal);
    const engine = new WorkflowEngine({
      runId: RUN,
      driver,
      caps: { maxConcurrency: 16 },
      askSpecs: untypedSpecs("ask#1"),
      validate: () => [],
      resumedFrom: "run-a",
      ...(opts.inheritedTokens === undefined ? {} : { inheritedTokens: opts.inheritedTokens }),
      ...(opts.launch === undefined ? {} : { launch: opts.launch }),
    });
    return { driver, engine };
  };

  it("makes inheritedTokens the new run's baseline: row equals the predecessor total, with a matching usage-updated right after run-started", () => {
    const journal = new InMemoryJournalStore();
    const { driver } = make(journal, { inheritedTokens: 300 });
    expect(journal.getRun(RUN)?.spentTokens).toBe(300);
    expect(eventTypes(journal)).toEqual(["run-started", "usage-updated"]);
    expect(journal.listEvents(RUN, { types: "all", reportItems: "all" })[1]?.event).toEqual({
      type: "usage-updated",
      spentTokens: 300,
    });
    // Projections see the same event via driver.emit: run-started zeroes usage and this restores the inherited value.
    expect(driver.events.at(-1)).toEqual({ type: "usage-updated", spentTokens: 300 });
  });

  it("orders run-started -> run-launched -> usage-updated with launch present (the anchor still follows run-started)", () => {
    const journal = new InMemoryJournalStore();
    make(journal, { inheritedTokens: 300, launch: { inputId: "launch-1" } });
    expect(eventTypes(journal)).toEqual(["run-started", "run-launched", "usage-updated"]);
  });

  it("accumulates live turns on top of the inherited value, event payload always equal to the row", async () => {
    const journal = new InMemoryJournalStore();
    const { driver, engine } = make(journal, { inheritedTokens: 300 });
    const actor = engine.createActor("actor#1");
    void engine.ask("ask#1", actor, "do it").catch(() => {});
    await flush();
    engine.askStats(inst("ask#1"), { tokens: 50, toolCalls: 0, turns: 1 });
    expect(driver.events.at(-1)).toEqual({ type: "usage-updated", spentTokens: 350 });
    expect(journal.getRun(RUN)?.spentTokens).toBe(350);
    engine.stop("user");
  });

  it("emits no post-start usage-updated when inherited is zero or absent (reset already said zero)", () => {
    const zero = new InMemoryJournalStore();
    make(zero, { inheritedTokens: 0 });
    expect(eventTypes(zero)).toEqual(["run-started"]);
    const absent = new InMemoryJournalStore();
    make(absent);
    expect(absent.getRun(RUN)?.spentTokens).toBe(0);
    expect(eventTypes(absent)).toEqual(["run-started"]);
  });

  it("follows a restored row with usage-updated on resume too, so the new incarnation's projection never starts at zero", () => {
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 7,
      status: "stopped",
      stopReason: "user",
    });
    const { driver } = make(journal);
    expect(eventTypes(journal)).toEqual(["run-started", "usage-updated"]);
    expect(driver.events).toEqual([
      { type: "run-started", runId: RUN, caps: { maxConcurrency: 16 } },
      { type: "usage-updated", spentTokens: 7 },
    ]);
    expect(journal.getRun(RUN)?.spentTokens).toBe(7);
  });
});
