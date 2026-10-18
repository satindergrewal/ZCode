/**
 * The engine side of amend-resume: imported-cache hits, divergence, session seeds, and world content matching.
 * （docs/execution-engine.md「Amend-resume」）。
 *
 * Fake drivers throughout: the cache is pure data injection, so the engine side need only prove what hit, what was passed, and what rows recorded.
 * How the driver copies the transcript after the seed is bootstrap's business (idempotency tested there).
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryJournalStore,
  WorkflowEngine,
  inputHash,
  type AskSpec,
  type AskStats,
  type Caps,
  type ImportedActorCandidate,
  type ImportedAskEntry,
  type ImportedRunCache,
  type ImportedWorldEntry,
  type NodeRecord,
  type PersonaSpec,
  type WorldReadOp,
} from "../../src/engine/index.js";
import { FakeDriver, flush } from "./fake-driver.js";

const RUN = "run-b";

/** Records the given ask sites explicitly as untyped (absence no longer implies untyped). */
const untypedSpecs = (...siteIds: string[]): Map<string, AskSpec> =>
  new Map(siteIds.map((id) => [id, { typed: false } as AskSpec]));

const ASK_SITES = untypedSpecs("ask#1", "ask#2", "ask#3", "ask#4", "ask#5", "ask#6", "ask#7");

interface SetupOpts {
  journal?: InMemoryJournalStore;
  caps?: Caps;
  importedCache?: ImportedRunCache;
  inheritedTokens?: number;
}

function setup(opts: SetupOpts = {}) {
  const journal = opts.journal ?? new InMemoryJournalStore();
  const driver = new FakeDriver(journal);
  const engine = new WorkflowEngine({
    runId: RUN,
    driver,
    caps: opts.caps ?? { maxConcurrency: 16 },
    askSpecs: ASK_SITES,
    validate: () => [],
    resumedFrom: "run-a",
    ...(opts.importedCache === undefined ? {} : { importedCache: opts.importedCache }),
    ...(opts.inheritedTokens === undefined ? {} : { inheritedTokens: opts.inheritedTokens }),
  });
  return { journal, driver, engine };
}

/** One imported ask entry: hash derived from the instruction text (same source as the engine's inputHash). */
function entry(
  instructions: string,
  result: unknown,
  messageBoundary: number,
  stats?: AskStats,
): ImportedAskEntry {
  return {
    inputHash: inputHash(instructions),
    result,
    messageBoundary,
    ...(stats === undefined ? {} : { stats }),
  };
}

function candidate(
  entries: ImportedAskEntry[],
  overrides: Partial<ImportedActorCandidate> = {},
): ImportedActorCandidate {
  return {
    persona: { name: "planner" },
    entries,
    transcriptSourceSessionId: "sess-a",
    resolvedModel: "zhipu/glm-5.3",
    ...overrides,
  };
}

/** A world node's content key: same source as the engine's inputHash({op, args}). */
const worldKey = (op: WorldReadOp, args: unknown[]): string => inputHash({ op, args });

function worldEntry(op: WorldReadOp, args: unknown[], result: unknown): ImportedWorldEntry {
  return {
    inputHash: worldKey(op, args),
    kind: op === "run" ? "world-run" : "world-read",
    result,
  };
}

function cacheOf(
  actors: Array<[string, ImportedActorCandidate]>,
  world: Array<[string, ImportedWorldEntry[]]> = [],
): ImportedRunCache {
  return { actors: new Map(actors), world: new Map(world) };
}

describe("imported cache -- full hit", () => {
  it("makes zero driver round trips; the node row copies result/stats/boundary and the only event is node-settled(cached)", async () => {
    const cache = cacheOf(
      [
        [
          "planner",
          candidate([
            entry("step 1", "r1", 4, { tokens: 10, toolCalls: 1, turns: 2 }),
            entry("step 2", "r2", 9),
          ]),
        ],
      ],
      [[worldKey("grep", ["todo"]), [worldEntry("grep", ["todo"], ["a.ts"])]]],
    );
    const { engine, driver, journal } = setup({ importedCache: cache });

    const planner = engine.createActor("actor#1", "planner");
    const p1 = engine.ask("ask#1", planner, "step 1");
    const p2 = engine.ask("ask#2", planner, "step 2");
    const w = engine.worldRead("world#1", "grep", ["todo"]);
    await flush();

    await expect(p1).resolves.toBe("r1");
    await expect(p2).resolves.toBe("r2");
    await expect(w).resolves.toEqual(["a.ts"]);

    // Zero tokens, zero side effects: no session was ever created.
    expect(driver.sessionCreations).toHaveLength(0);
    expect(driver.startAskCount()).toBe(0);
    expect(driver.worldReads).toHaveLength(0);

    const settled = driver.eventsOfType("node-settled");
    expect(settled).toHaveLength(3);
    expect(settled.every((e) => e.cached === true)).toBe(true);
    // Cached settle and replay hits share one posture: no queueing, no dispatch.
    expect(driver.eventsOfType("node-queued")).toHaveLength(0);
    expect(driver.eventsOfType("node-dispatched")).toHaveLength(0);

    expect(journal.getNode(RUN, "ask#1", 1)).toMatchObject({
      kind: "ask",
      status: "completed",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("step 1"),
      result: "r1",
      messageBoundary: 4,
      stats: { tokens: 10, toolCalls: 1, turns: 2 },
    });
    const second = journal.getNode(RUN, "ask#2", 1);
    expect(second).toMatchObject({ actorSeq: 1, result: "r2", messageBoundary: 9 });
    expect(second?.stats).toBeUndefined();
    expect(journal.getNode(RUN, "world#1", 1)).toMatchObject({
      kind: "world-read",
      status: "completed",
      result: ["a.ts"],
    });

    engine.complete("done");
    await expect(engine.settled).resolves.toEqual({ status: "completed", artifact: "done" });
  });
});

describe("imported cache -- hits re-emit birth facts (docs/execution-engine.md, Events)", () => {
  it("stamps ask hits with kind/actor/actorSeq/task summary plus predecessor session; world hits stay bare", async () => {
    const cache = cacheOf(
      [["planner", candidate([entry("  step 1  ", "r1", 4), entry("step 2", "r2", 9)])]],
      [[worldKey("grep", ["todo"]), [worldEntry("grep", ["todo"], ["a.ts"])]]],
    );
    const { engine, driver } = setup({ importedCache: cache });

    const planner = engine.createActor("actor#1", "planner");
    const p1 = engine.ask("ask#1", planner, "  step 1  ");
    const p2 = engine.ask("ask#2", planner, "step 2");
    const w = engine.worldRead("world#1", "grep", ["todo"]);
    await flush();
    await Promise.all([p1, p2, w]);

    // Hits skip node-queued, so this settlement is the birth event: readers attribute the node to the subagent with it;
    // the answer lives in the predecessor's session (this run created none) -- read the transcript there.
    expect(driver.eventsOfType("node-settled")).toEqual([
      {
        type: "node-settled",
        instance: { siteId: "ask#1", ordinal: 1 },
        outcome: "ok",
        cached: true,
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
        actorSeq: 0,
        // Same summary rule as node-queued: trimmed, no ellipsis.
        instructionsHead: "step 1",
        sourceSessionId: "sess-a",
      },
      {
        type: "node-settled",
        instance: { siteId: "ask#2", ordinal: 1 },
        outcome: "ok",
        cached: true,
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
        actorSeq: 1,
        instructionsHead: "step 2",
        sourceSessionId: "sess-a",
      },
      {
        type: "node-settled",
        instance: { siteId: "world#1", ordinal: 1 },
        outcome: "ok",
        cached: true,
      },
    ]);
  });

  it("sends post-hit diverging live asks through node-queued while earlier hits keep the predecessor session", async () => {
    const cache = cacheOf([
      ["planner", candidate([entry("s0", "r0", 4), entry("stale instruction", "r1", 9)])],
    ]);
    const { engine, driver } = setup({ importedCache: cache });
    const planner = engine.createActor("actor#1", "planner");
    const p0 = engine.ask("ask#1", planner, "s0");
    const p1 = engine.ask("ask#2", planner, "fresh instruction");
    await flush();
    await expect(p0).resolves.toBe("r0");

    const cachedSettles = driver.eventsOfType("node-settled").filter((e) => e.cached === true);
    expect(cachedSettles).toHaveLength(1);
    expect(cachedSettles[0]).toMatchObject({ actorSeq: 0, sourceSessionId: "sess-a" });
    expect(driver.eventsOfType("node-queued")).toMatchObject([
      { instance: { siteId: "ask#2", ordinal: 1 }, actorSeq: 1 },
    ]);
    engine.askTurnEnded({ siteId: "ask#2", ordinal: 1 }, "live-1");
    await expect(p1).resolves.toBe("live-1");
    // Live settlements carry no birth facts and no predecessor session: the answer lives in this run's own session.
    const liveSettle = driver
      .eventsOfType("node-settled")
      .find((e) => e.instance.siteId === "ask#2");
    expect(liveSettle).toEqual({
      type: "node-settled",
      instance: { siteId: "ask#2", ordinal: 1 },
      outcome: "ok",
    });
  });
});

describe("imported cache -- divergence", () => {
  it("keeps the hit prefix on mid-flight divergence, going fully live after it -- later hash matches go unchecked", async () => {
    // entries[1]'s instruction differs from the new script (stale vs s1) -> divergence at seq 1;
    // entries[2] deliberately hashes the same as the new script's seq 2 to prove post-divergence checks stop.
    const cache = cacheOf([
      [
        "planner",
        candidate([
          entry("s0", "r0", 4),
          entry("stale instruction", "r1", 9),
          entry("s2", "r2", 14),
        ]),
      ],
    ]);
    const { engine, driver, journal } = setup({ importedCache: cache });

    const planner = engine.createActor("actor#1", "planner");
    const p0 = engine.ask("ask#1", planner, "s0");
    const p1 = engine.ask("ask#2", planner, "s1");
    const p2 = engine.ask("ask#3", planner, "s2");
    await flush();

    await expect(p0).resolves.toBe("r0");
    expect(journal.getNode(RUN, "ask#1", 1)).toMatchObject({ status: "completed", result: "r0" });

    // The session truncates at the last consumed entry: divergence at seq 1 means the copied transcript is seq 0's full exchange.
    expect(driver.sessionCreations).toHaveLength(1);
    expect(driver.sessionSeeds[0]).toEqual({
      sourceSessionId: "sess-a",
      messageCount: 4,
      resolvedModel: "zhipu/glm-5.3",
    });

    // Actors run serially: after divergence both asks dispatch live in turn, the second never consuming entries[2].
    expect(driver.startAskCount()).toBe(1);
    expect(driver.startAsks[0]?.instance.siteId).toBe("ask#2");
    engine.askTurnEnded({ siteId: "ask#2", ordinal: 1 }, "live-1");
    await flush();
    await expect(p1).resolves.toBe("live-1");

    expect(driver.startAskCount()).toBe(2);
    expect(driver.startAsks[1]?.instance.siteId).toBe("ask#3");
    engine.askTurnEnded({ siteId: "ask#3", ordinal: 1 }, "live-2");
    await expect(p2).resolves.toBe("live-2");
    expect(journal.getNode(RUN, "ask#3", 1)?.result).toBe("live-2");
    // Only seq 0 is a cache hit.
    expect(driver.eventsOfType("node-settled").filter((e) => e.cached === true)).toHaveLength(1);
  });

  it("extends past the end: asks beyond the imported entries go live, the seed boundary at the last entry", async () => {
    const cache = cacheOf([["planner", candidate([entry("s0", "r0", 7)])]]);
    const { engine, driver } = setup({ importedCache: cache });

    const planner = engine.createActor("actor#1", "planner");
    const p0 = engine.ask("ask#1", planner, "s0");
    const p1 = engine.ask("ask#2", planner, "s1");
    await flush();

    await expect(p0).resolves.toBe("r0");
    expect(driver.startAskCount()).toBe(1);
    expect(driver.startAsks[0]?.instance.siteId).toBe("ask#2");
    expect(driver.sessionSeeds[0]).toEqual({
      sourceSessionId: "sess-a",
      messageCount: 7,
      resolvedModel: "zhipu/glm-5.3",
    });

    engine.askTurnEnded({ siteId: "ask#2", ordinal: 1 }, "live");
    await expect(p1).resolves.toBe("live");
  });
});

describe("imported cache -- actor attachment", () => {
  it("treats a persona mismatch as a brand-new actor: no attachment, all live, session without seed", async () => {
    const cache = cacheOf([
      [
        "planner",
        candidate([entry("s0", "r0", 4)], { persona: { name: "planner", system: "old prompt" } }),
      ],
    ]);
    const { engine, driver } = setup({ importedCache: cache });

    const planner = engine.createActor("actor#1", "planner", "new prompt");
    const p0 = engine.ask("ask#1", planner, "s0");
    await flush();

    expect(driver.startAskCount()).toBe(1);
    expect(driver.sessionCreations).toHaveLength(1);
    expect(driver.sessionSeeds[0]).toBeUndefined();
    expect(driver.eventsOfType("node-settled").filter((e) => e.cached === true)).toHaveLength(0);

    engine.askTurnEnded({ siteId: "ask#1", ordinal: 1 }, "live");
    await expect(p0).resolves.toBe("live");
  });

  it("compares personas normalized: absent members equal explicit undefined", async () => {
    const persona: PersonaSpec = { name: "planner", system: undefined };
    const cache = cacheOf([["planner", candidate([entry("s0", "r0", 4)], { persona })]]);
    const { engine, driver } = setup({ importedCache: cache });

    const planner = engine.createActor("actor#1", "planner");
    await expect(engine.ask("ask#1", planner, "s0")).resolves.toBe("r0");
    expect(driver.startAskCount()).toBe(0);
  });

  // docs/dynamic-workflow/authoring.md, Choosing a model per subagent: the model is not part of cache identity.
  it("attaches and hits on a model-only persona change, persisting the new model name", async () => {
    const cache = cacheOf([
      [
        "planner",
        candidate([entry("s0", "r0", 4)], {
          persona: { name: "planner", system: "You plan.", model: "GLM-5.3" },
        }),
      ],
    ]);
    const { engine, driver, journal } = setup({ importedCache: cache });

    const planner = engine.createActor("actor#1", "planner", {
      system: "You plan.",
      model: "GLM-5.3-Flash",
    });
    await expect(engine.ask("ask#1", planner, "s0")).resolves.toBe("r0");
    expect(driver.startAskCount()).toBe(0);
    expect(journal.getActor(RUN, "actor#1", 1)?.persona).toEqual({
      name: "planner",
      system: "You plan.",
      model: "GLM-5.3-Flash",
    });
  });

  it("keeps attachment when a model appears from nothing, splitting on system changes", async () => {
    const cache = cacheOf([
      ["planner", candidate([entry("s0", "r0", 4)], { persona: { name: "planner" } })],
      ["judge", candidate([entry("j0", "v0", 4)], { persona: { name: "judge", system: "old" } })],
    ]);
    const { engine, driver } = setup({ importedCache: cache });

    const planner = engine.createActor("actor#1", "planner", { model: "GLM-5.3-Flash" });
    const judge = engine.createActor("actor#2", "judge", { system: "new", model: "GLM-5.3-Flash" });
    await expect(engine.ask("ask#1", planner, "s0")).resolves.toBe("r0");
    const live = engine.ask("ask#2", judge, "j0");
    await flush();
    expect(driver.startAskCount()).toBe(1);
    engine.askTurnEnded({ siteId: "ask#2", ordinal: 1 }, "live");
    await expect(live).resolves.toBe("live");
  });

  it("never attaches anonymous actors (the name is the cache identity key)", async () => {
    const cache = cacheOf([["planner", candidate([entry("s0", "r0", 4)])]]);
    const { engine, driver } = setup({ importedCache: cache });

    const anon = engine.createActor("actor#1");
    const p0 = engine.ask("ask#1", anon, "s0");
    await flush();

    expect(driver.startAskCount()).toBe(1);
    expect(driver.sessionSeeds[0]).toBeUndefined();
    engine.askTurnEnded({ siteId: "ask#1", ordinal: 1 }, "live");
    await expect(p0).resolves.toBe("live");
  });
});

describe("imported cache -- world nodes", () => {
  it("matches the nth {op,args} occurrence to the nth entry; exhaustion or arg changes go live", async () => {
    const cache = cacheOf(
      [],
      [
        [
          worldKey("grep", ["x"]),
          [worldEntry("grep", ["x"], "first"), worldEntry("grep", ["x"], "second")],
        ],
      ],
    );
    const { engine, driver } = setup({ importedCache: cache });

    await expect(engine.worldRead("world#1", "grep", ["x"])).resolves.toBe("first");
    await expect(engine.worldRead("world#1", "grep", ["x"])).resolves.toBe("second");
    expect(driver.worldReads).toHaveLength(0);

    // Queue exhausted -> live.
    const third = engine.worldRead("world#1", "grep", ["x"]);
    expect(driver.worldReads).toHaveLength(1);
    driver.worldReads[0]?.deferred.resolve("fresh read");
    await expect(third).resolves.toBe("fresh read");

    // Arg change -> different content key -> live.
    const other = engine.worldRead("world#2", "grep", ["y"]);
    expect(driver.worldReads).toHaveLength(2);
    driver.worldReads[1]?.deferred.resolve("result of y");
    await expect(other).resolves.toBe("result of y");
  });

  it("never re-runs executeWorldRead on a world-run hit (no silent effect replay) and journals kind world-run", async () => {
    const cache = cacheOf(
      [],
      [[worldKey("run", ["deploy.sh"]), [worldEntry("run", ["deploy.sh"], { exitCode: 0 })]]],
    );
    const { engine, driver, journal } = setup({ importedCache: cache });

    await expect(engine.worldRead("world#1", "run", ["deploy.sh"])).resolves.toEqual({
      exitCode: 0,
    });
    expect(driver.worldReads).toHaveLength(0);
    expect(journal.getNode(RUN, "world#1", 1)).toMatchObject({
      kind: "world-run",
      status: "completed",
      inputHash: worldKey("run", ["deploy.sh"]),
      result: { exitCode: 0 },
    });
  });
});

describe("imported cache -- divergence rebuild after a crash resume", () => {
  it("re-derives the divergence per seq from journal rows: already-diverged actors gain no accidental suffix hits", async () => {
    // Original pass: seq 0 hit the import, seq 1 diverged (instruction != entries[1]) and everything went
    // live, all three rows completed, then the process died. Resume rebuilds the table wholesale -- without
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
      resumedFrom: "run-a",
    });
    const recordedAsk = (siteId: string, seq: number, instructions: string): NodeRecord => ({
      runId: RUN,
      siteId,
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: seq,
      inputHash: inputHash(instructions),
      status: "completed",
      result: `journal-${seq}`,
    });
    journal.putNode(recordedAsk("ask#1", 0, "s0"));
    journal.putNode(recordedAsk("ask#2", 1, "s1"));
    journal.putNode(recordedAsk("ask#3", 2, "s2"));

    const cache = cacheOf([
      [
        "planner",
        candidate([
          entry("s0", "r0", 4),
          entry("old instruction unlike the new script", "r1", 9),
          entry("s2", "r2", 14),
          entry("s3", "r3", 19),
        ]),
      ],
    ]);
    const { engine, driver } = setup({ journal, importedCache: cache });

    const planner = engine.createActor("actor#1", "planner");
    const p0 = engine.ask("ask#1", planner, "s0");
    const p1 = engine.ask("ask#2", planner, "s1");
    const p2 = engine.ask("ask#3", planner, "s2");
    const p3 = engine.ask("ask#4", planner, "s3");
    await flush();

    // Three rows replay-short-circuit (results from the journal, not the imported entries).
    await expect(p0).resolves.toBe("journal-0");
    await expect(p1).resolves.toBe("journal-1");
    await expect(p2).resolves.toBe("journal-2");

    // Replay settlements re-emit birth facts too. Seq 0 was an import hit originally, its exchange in the
    // predecessor's session; from seq 1 the original diverged and ran live, so this run's own session holds
    // them (the seed copied the prefix).
    expect(
      driver
        .eventsOfType("node-settled")
        .filter((e) => e.cached === true)
        .map((e) => ({ seq: e.actorSeq, actor: e.actor, kind: e.kind, source: e.sourceSessionId })),
    ).toEqual([
      { seq: 0, actor: { siteId: "actor#1", ordinal: 1 }, kind: "ask", source: "sess-a" },
      { seq: 1, actor: { siteId: "actor#1", ordinal: 1 }, kind: "ask", source: undefined },
      { seq: 2, actor: { siteId: "actor#1", ordinal: 1 }, kind: "ask", source: undefined },
    ]);

    // Key assertion: seq 3 hashes equal to entries[3], but the original diverged at seq 1 -> must be live.
    expect(driver.startAskCount()).toBe(1);
    expect(driver.startAsks[0]?.instance.siteId).toBe("ask#4");
    // Consumption counts only to seq 0 (entries[0]'s boundary); the seed truncates there.
    expect(driver.sessionSeeds[0]).toEqual({
      sourceSessionId: "sess-a",
      messageCount: 4,
      resolvedModel: "zhipu/glm-5.3",
    });

    engine.askTurnEnded({ siteId: "ask#4", ordinal: 1 }, "live-3");
    await expect(p3).resolves.toBe("live-3");
  });
});

describe("imported cache -- closing (before the first write, not the first live ask)", () => {
  const NPM_TEST = ["npm", ["test"]];
  const README = ["README.md"];
  // Pure entries: answered only, never touched the world (protocol tools like submit_result count in toolCalls, not worldToolCalls).
  const PURE: AskStats = { tokens: 10, toolCalls: 1, turns: 1, worldToolCalls: 0 };
  // World-touching entries read files or ran commands; after the gate closes even equal hashes stop hitting.
  const TOOLED: AskStats = { tokens: 10, toolCalls: 3, turns: 1, worldToolCalls: 2 };

  /** Predecessor table of four subagents plus two world rows. planner/summarizer pure asks; fixer/reviewer tooled. */
  function closingCache(): ImportedRunCache {
    return cacheOf(
      [
        ["planner", candidate([entry("plan", "r-plan", 4, PURE)])],
        [
          "fixer",
          candidate([entry("old fix instruction", "r-old-fix", 5, TOOLED)], {
            persona: { name: "fixer" },
          }),
        ],
        [
          "reviewer",
          candidate(
            [
              entry("review-1", "r-review-1", 6, TOOLED),
              entry("review-2", "r-review-2", 11, TOOLED),
            ],
            { persona: { name: "reviewer" } },
          ),
        ],
        [
          "summarizer",
          candidate(
            [entry("summarize", "r-sum", 7, PURE), entry("summarize-2", "r-sum-2", 9, PURE)],
            {
              persona: { name: "summarizer" },
            },
          ),
        ],
      ],
      [
        [
          worldKey("run", NPM_TEST),
          [
            worldEntry("run", NPM_TEST, { exitCode: 0, round: 1 }),
            worldEntry("run", NPM_TEST, { exitCode: 0, round: 2 }),
          ],
        ],
        [worldKey("read", README), [worldEntry("read", README, "old readme")]],
      ],
    );
  }

  const closedEvents = (driver: FakeDriver) => driver.eventsOfType("import-cache-closed");

  it("keeps the gate open when a fan-out's first miss goes live, later siblings still hitting (the 2026-09-14 double loss)", async () => {
    const { engine, driver } = setup({ importedCache: closingCache() });
    const fixer = engine.createActor("actor#2", "fixer");
    const planner = engine.createActor("actor#1", "planner");
    const reviewer = engine.createActor("actor#3", "reviewer");

    // Fired in one tick as fixer -> planner -> reviewer -> world-run: fixer misses (the predecessor never finished it)
    const fix = engine.ask("ask#3", fixer, "fix the parser");
    const plan = engine.ask("ask#1", planner, "plan");
    const review = engine.ask("ask#2", reviewer, "review-1");
    const test = engine.worldRead("world#1", "run", NPM_TEST);
    await flush();
    await expect(plan).resolves.toBe("r-plan");
    await expect(review).resolves.toBe("r-review-1");
    await expect(test).resolves.toEqual({ exitCode: 0, round: 1 });
    expect(driver.startAskCount()).toBe(1);
    expect(driver.startAsks[0]?.instance.siteId).toBe("ask#3");
    expect(driver.worldReads).toHaveLength(0);
    expect(closedEvents(driver)).toHaveLength(0);
    expect(driver.eventsOfType("log")).toHaveLength(0);

    engine.askTurnEnded({ siteId: "ask#3", ordinal: 1 }, "fixed");
    await expect(fix).resolves.toBe("fixed");
  });

  it("closes on askMutating: tooled entries and world nodes go live while pure asks hit, exactly one import-cache-closed", async () => {
    const { engine, driver } = setup({ importedCache: closingCache() });
    const fixer = engine.createActor("actor#2", "fixer");
    const reviewer = engine.createActor("actor#3", "reviewer");
    const summarizer = engine.createActor("actor#4", "summarizer");

    // Before the gate: reviewer's first ask hits.
    await expect(engine.ask("ask#2", reviewer, "review-1")).resolves.toBe("r-review-1");

    // fixer misses and goes live; its subagent is about to write a file -- the driver reports askMutating, the gate
    const fix = engine.ask("ask#3", fixer, "fix the parser");
    await flush();
    expect(driver.startAskCount()).toBe(1);
    expect(closedEvents(driver)).toHaveLength(0);
    engine.askMutating({ siteId: "ask#3", ordinal: 1 });
    const closed = closedEvents(driver);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toMatchObject({
      instance: { siteId: "ask#3", ordinal: 1 },
      cause: "mutating-tool",
      actorName: "fixer",
    });
    // Reporting again is a no-op (closing is monotonic).
    engine.askMutating({ siteId: "ask#3", ordinal: 1 });
    expect(closedEvents(driver)).toHaveLength(1);

    // After closing: the second equal-hash world-run row stays in the table but never hits -- live execution.
    const rerun = engine.worldRead("world#1", "run", NPM_TEST);
    expect(driver.worldReads).toHaveLength(1);
    driver.worldReads[0]?.deferred.resolve({ exitCode: 1, round: "live" });
    await expect(rerun).resolves.toEqual({ exitCode: 1, round: "live" });
    // Same for world-read.
    const readme = engine.worldRead("world#2", "read", README);
    expect(driver.worldReads).toHaveLength(2);
    driver.worldReads[1]?.deferred.resolve("new readme");
    await expect(readme).resolves.toBe("new readme");

    // The tooled reviewer's second ask hashes equal to entries[1] yet runs live after the gate (it reads the
    // rewritten repo); the seed truncates at the consumed prefix (entries[0]'s boundary 6), not entries[1]'s 11.
    const review2 = engine.ask("ask#4", reviewer, "review-2");
    await flush();
    expect(driver.startAskCount()).toBe(2);
    expect(driver.startAsks[1]?.instance.siteId).toBe("ask#4");
    const reviewerSeed =
      driver.sessionSeeds[driver.sessionCreations.findIndex((ref) => ref.siteId === "actor#3")];
    expect(reviewerSeed).toEqual({
      sourceSessionId: "sess-a",
      messageCount: 6,
      resolvedModel: "zhipu/glm-5.3",
    });

    // summarizer is a pure ask (toolCalls 0): both hit after the gate -- it depends only on instruction and transcript prefix,
    await expect(engine.ask("ask#5", summarizer, "summarize")).resolves.toBe("r-sum");
    await expect(engine.ask("ask#5", summarizer, "summarize-2")).resolves.toBe("r-sum-2");
    expect(driver.startAskCount()).toBe(2);

    engine.askTurnEnded({ siteId: "ask#3", ordinal: 1 }, "fixed");
    await expect(fix).resolves.toBe("fixed");
    engine.askTurnEnded({ siteId: "ask#4", ordinal: 1 }, "reviewed");
    await expect(review2).resolves.toBe("reviewed");
    expect(closedEvents(driver)).toHaveLength(1);
  });

  it("treats legacy rows without worldToolCalls as world-touching after the gate, conservatively live", async () => {
    const legacy = cacheOf([
      ["planner", candidate([entry("plan", "r-plan", 4, { tokens: 5, toolCalls: 1, turns: 1 })])],
      [
        "fixer",
        candidate([entry("old fix instruction", "r-old-fix", 5, TOOLED)], {
          persona: { name: "fixer" },
        }),
      ],
    ]);
    const { engine, driver } = setup({ importedCache: legacy });
    const fixer = engine.createActor("actor#2", "fixer");
    const planner = engine.createActor("actor#1", "planner");
    const fix = engine.ask("ask#3", fixer, "fix the parser");
    await flush();
    engine.askMutating({ siteId: "ask#3", ordinal: 1 });

    // planner's entry hashes equal and wrote nothing, but that journal vintage lacks the worldToolCalls key -> treated as touching.
    const plan = engine.ask("ask#1", planner, "plan");
    await flush();
    expect(driver.startAskCount()).toBe(2);
    engine.askTurnEnded({ siteId: "ask#1", ordinal: 1 }, "planned live");
    await expect(plan).resolves.toBe("planned live");
    engine.askTurnEnded({ siteId: "ask#3", ordinal: 1 }, "fixed");
    await expect(fix).resolves.toBe("fixed");
  });

  it("stops hitting later pure entries once one link of a pure actor's chain goes live post-close (the transcript differs)", async () => {
    const { engine, driver } = setup({ importedCache: closingCache() });
    const fixer = engine.createActor("actor#2", "fixer");
    const summarizer = engine.createActor("actor#4", "summarizer");

    const fix = engine.ask("ask#3", fixer, "fix the parser");
    await flush();
    engine.askMutating({ siteId: "ask#3", ordinal: 1 });

    // summarizer's first changed instruction -> miss -> live -> divergence; the second hashes equal to entries[1]
    const sum1 = engine.ask("ask#5", summarizer, "summarize differently");
    await flush();
    expect(driver.startAskCount()).toBe(2);
    engine.askTurnEnded({ siteId: "ask#5", ordinal: 1 }, "summary");
    await expect(sum1).resolves.toBe("summary");
    const sum2 = engine.ask("ask#5", summarizer, "summarize-2");
    await flush();
    expect(driver.startAskCount()).toBe(3);
    engine.askTurnEnded({ siteId: "ask#5", ordinal: 2 }, "summary-2");
    await expect(sum2).resolves.toBe("summary-2");

    engine.askTurnEnded({ siteId: "ask#3", ordinal: 1 }, "fixed");
    await expect(fix).resolves.toBe("fixed");
  });

  it("makes askMutating a no-op for non-in-flight instances: late observations never close the gate", async () => {
    const { engine, driver } = setup({ importedCache: closingCache() });
    const planner = engine.createActor("actor#1", "planner");
    // A hit ask never went live; reporting its instance does not count.
    await expect(engine.ask("ask#1", planner, "plan")).resolves.toBe("r-plan");
    engine.askMutating({ siteId: "ask#1", ordinal: 1 });
    engine.askMutating({ siteId: "ask#9", ordinal: 1 });
    expect(closedEvents(driver)).toHaveLength(0);
    await expect(engine.worldRead("world#1", "run", NPM_TEST)).resolves.toEqual({
      exitCode: 0,
      round: 1,
    });
  });

  it("treats a live world-run as one write, closing before dispatch; a live world-read never closes", async () => {
    const { engine, driver } = setup({ importedCache: closingCache() });
    const summarizer = engine.createActor("actor#4", "summarizer");
    const reviewer = engine.createActor("actor#3", "reviewer");

    // The new-arg world-read goes live on its own (absent from the table) and later equal-hash reads still hit: reads never close.
    const peek = engine.worldRead("world#4", "read", ["CHANGELOG.md"]);
    expect(driver.worldReads).toHaveLength(1);
    driver.worldReads[0]?.deferred.resolve("changelog");
    await expect(peek).resolves.toBe("changelog");
    await expect(engine.worldRead("world#2", "read", README)).resolves.toBe("old readme");
    expect(closedEvents(driver)).toHaveLength(0);

    // A new-hash world-run going live closes the gate (the event precedes node-queued: close first, then act).
    const patch = engine.worldRead("world#3", "run", ["sed", ["-i", "s/a/b/", "x.ts"]]);
    expect(driver.worldReads).toHaveLength(2);
    const closedAt = driver.events.findIndex((e) => e.type === "import-cache-closed");
    const queuedAt = driver.events.findIndex(
      (e) => e.type === "node-queued" && e.instance.siteId === "world#3",
    );
    expect(closedAt).toBeGreaterThanOrEqual(0);
    expect(closedAt).toBeLessThan(queuedAt);
    expect(closedEvents(driver)[0]).toMatchObject({
      instance: { siteId: "world#3", ordinal: 1 },
      cause: "world-run",
    });
    driver.worldReads[1]?.deferred.resolve({ exitCode: 0 });
    await expect(patch).resolves.toEqual({ exitCode: 0 });

    // After closing: the equal-hash world-run row remains but never hits -- live; the tooled reviewer live; pure summarizer hits.
    const rerun = engine.worldRead("world#1", "run", NPM_TEST);
    expect(driver.worldReads).toHaveLength(3);
    driver.worldReads[2]?.deferred.resolve({ exitCode: 1, round: "live" });
    await expect(rerun).resolves.toEqual({ exitCode: 1, round: "live" });
    const review = engine.ask("ask#2", reviewer, "review-1");
    await flush();
    expect(driver.startAskCount()).toBe(1);
    await expect(engine.ask("ask#5", summarizer, "summarize")).resolves.toBe("r-sum");
    engine.askTurnEnded({ siteId: "ask#2", ordinal: 1 }, "reviewed");
    await expect(review).resolves.toBe("reviewed");
  });

  it("restores closed-from the import-cache-closed event on crash resume, live ask rows never advancing the cursor", async () => {
    // Original pass: reviewer seq0 hit; fixer seq0 went live and wrote a file (closing the gate); reviewer seq1
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
      resumedFrom: "run-a",
    });
    journal.putActor({
      runId: RUN,
      siteId: "actor#2",
      ordinal: 1,
      name: "fixer",
      persona: { name: "fixer" },
    });
    journal.putActor({
      runId: RUN,
      siteId: "actor#3",
      ordinal: 1,
      name: "reviewer",
      persona: { name: "reviewer" },
    });
    const row = (
      siteId: string,
      actor: [string, number],
      seq: number,
      instructions: string,
    ): NodeRecord => ({
      runId: RUN,
      siteId,
      ordinal: 1,
      kind: "ask",
      actorSiteId: actor[0],
      actorOrdinal: actor[1],
      actorSeq: seq,
      inputHash: inputHash(instructions),
      status: "completed",
      result: `journal-${siteId}`,
    });
    journal.putNode(row("ask#2", ["actor#3", 1], 0, "review-1"));
    journal.putNode(row("ask#3", ["actor#2", 1], 0, "fix the parser"));
    journal.putNode(row("ask#4", ["actor#3", 1], 1, "review-2"));
    journal.appendEvent(RUN, {
      type: "node-queued",
      instance: { siteId: "ask#3", ordinal: 1 },
      kind: "ask",
      actor: { siteId: "actor#2", ordinal: 1 },
      actorSeq: 0,
    });
    journal.appendEvent(RUN, {
      type: "import-cache-closed",
      instance: { siteId: "ask#3", ordinal: 1 },
      cause: "mutating-tool",
      actorName: "fixer",
    });
    journal.appendEvent(RUN, {
      type: "node-queued",
      instance: { siteId: "ask#4", ordinal: 1 },
      kind: "ask",
      actor: { siteId: "actor#3", ordinal: 1 },
      actorSeq: 1,
    });

    const { engine, driver } = setup({ journal, importedCache: closingCache() });
    const fixer = engine.createActor("actor#2", "fixer");
    const reviewer = engine.createActor("actor#3", "reviewer");

    // The prefix short-circuits from the journal.
    await expect(engine.ask("ask#2", reviewer, "review-1")).resolves.toBe("journal-ask#2");
    await expect(engine.ask("ask#3", fixer, "fix the parser")).resolves.toBe("journal-ask#3");
    await expect(engine.ask("ask#4", reviewer, "review-2")).resolves.toBe("journal-ask#4");
    // Resume never re-emits the close event: the verdict is restored, not newly observed.
    expect(closedEvents(driver)).toHaveLength(0);
    // Only the originally-imported-hit row carries a predecessor session: reviewer seq0. fixer seq0 and
    expect(
      driver
        .eventsOfType("node-settled")
        .filter((e) => e.cached === true)
        .map((e) => [e.instance.siteId, e.sourceSessionId]),
    ).toEqual([
      ["ask#2", "sess-a"],
      ["ask#3", undefined],
      ["ask#4", undefined],
    ]);

    // past the prefix: tabled world-runs no longer hit.
    const rerun = engine.worldRead("world#1", "run", NPM_TEST);
    expect(driver.worldReads).toHaveLength(1);
    driver.worldReads[0]?.deferred.resolve({ exitCode: 0, round: "live" });
    await expect(rerun).resolves.toEqual({ exitCode: 0, round: "live" });

    // reviewer seq2 live; the seed boundary is the last hit before the gate (entries[0]'s 6),
    const review3 = engine.ask("ask#5", reviewer, "review-3");
    await flush();
    expect(driver.startAskCount()).toBe(1);
    expect(driver.startAsks[0]?.instance.siteId).toBe("ask#5");
    expect(driver.sessionSeeds[0]).toEqual({
      sourceSessionId: "sess-a",
      messageCount: 6,
      resolvedModel: "zhipu/glm-5.3",
    });
    engine.askTurnEnded({ siteId: "ask#5", ordinal: 1 }, "reviewed");
    await expect(review3).resolves.toBe("reviewed");
  });

  it("on crash resume with only live asks and no close event, the gate stays open and tabled entries hit", async () => {
    // Original: fixer seq0 live (a miss) that wrote nothing; process died. The old rule read that node-queued as gate-closed.
    const journal = new InMemoryJournalStore();
    journal.createRun({
      runId: RUN,
      caps: { maxConcurrency: 16 },
      spentTokens: 0,
      status: "running",
      resumedFrom: "run-a",
    });
    journal.putActor({
      runId: RUN,
      siteId: "actor#2",
      ordinal: 1,
      name: "fixer",
      persona: { name: "fixer" },
    });
    journal.putNode({
      runId: RUN,
      siteId: "ask#3",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#2",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("fix the parser"),
      status: "completed",
      result: "journal-ask#3",
    });
    journal.appendEvent(RUN, {
      type: "node-queued",
      instance: { siteId: "ask#3", ordinal: 1 },
      kind: "ask",
      actor: { siteId: "actor#2", ordinal: 1 },
      actorSeq: 0,
    });

    const { engine, driver } = setup({ journal, importedCache: closingCache() });
    const fixer = engine.createActor("actor#2", "fixer");
    const reviewer = engine.createActor("actor#3", "reviewer");
    await expect(engine.ask("ask#3", fixer, "fix the parser")).resolves.toBe("journal-ask#3");
    await expect(engine.ask("ask#2", reviewer, "review-1")).resolves.toBe("r-review-1");
    await expect(engine.worldRead("world#1", "run", NPM_TEST)).resolves.toEqual({
      exitCode: 0,
      round: 1,
    });
    expect(driver.startAskCount()).toBe(0);
    expect(driver.worldReads).toHaveLength(0);
  });
});

describe("imported cache -- continuing a predecessor's in-flight ask (docs/execution-engine.md, How the engine consumes the cache)", () => {
  /** The ask parked in flight on the predecessor: hash from its instruction, boundary the whole predecessor session's message count. */
  const inFlightOf = (instructions: string, messageBoundary: number) => ({
    inputHash: inputHash(instructions),
    messageBoundary,
  });

  const cachedSettles = (driver: FakeDriver) =>
    driver.eventsOfType("node-settled").filter((e) => e.cached === true);

  it("seeds the same ask (hash equal) with the full half-done transcript and still runs it live", async () => {
    const cache = cacheOf([
      ["planner", candidate([entry("s0", "r0", 4)], { inFlight: inFlightOf("s1", 12) })],
    ]);
    const { engine, driver, journal } = setup({ importedCache: cache });

    const planner = engine.createActor("actor#1", "planner");
    await expect(engine.ask("ask#1", planner, "s0")).resolves.toBe("r0");

    const p1 = engine.ask("ask#2", planner, "s1");
    await flush();

    // Continuing is not a hit: no result to import, so it dispatches anyway.
    expect(driver.startAskCount()).toBe(1);
    expect(driver.startAsks[0]?.instance.siteId).toBe("ask#2");
    expect(cachedSettles(driver)).toHaveLength(1);
    // The seed takes inFlight's boundary (12), not the prefix's last row (4).
    expect(driver.sessionSeeds[0]).toEqual({
      sourceSessionId: "sess-a",
      messageCount: 12,
      resolvedModel: "zhipu/glm-5.3",
    });

    engine.askTurnEnded({ siteId: "ask#2", ordinal: 1 }, "live-1");
    await expect(p1).resolves.toBe("live-1");
    expect(journal.getNode(RUN, "ask#2", 1)?.result).toBe("live-1");
  });

  it("handles a candidate with zero completed entries plus inFlight, the usual amended-mid-first-lap shape", async () => {
    const cache = cacheOf([["planner", candidate([], { inFlight: inFlightOf("s0", 6) })]]);
    const { engine, driver } = setup({ importedCache: cache });

    const planner = engine.createActor("actor#1", "planner");
    const p0 = engine.ask("ask#1", planner, "s0");
    await flush();

    expect(driver.startAskCount()).toBe(1);
    expect(cachedSettles(driver)).toHaveLength(0);
    // A seed exists even at zero consumption -- the watershed between continuation and prefix-truncated divergence.
    expect(driver.sessionSeeds[0]).toEqual({
      sourceSessionId: "sess-a",
      messageCount: 6,
      resolvedModel: "zhipu/glm-5.3",
    });

    engine.askTurnEnded({ siteId: "ask#1", ordinal: 1 }, "live-0");
    await expect(p0).resolves.toBe("live-0");
  });

  it("falls back to the old behavior on an instruction change (hash mismatch): prefix-boundary truncation, no prefix no seed", async () => {
    const withPrefix = cacheOf([
      [
        "planner",
        candidate([entry("s0", "r0", 4)], { inFlight: inFlightOf("old second ask", 12) }),
      ],
    ]);
    const first = setup({ importedCache: withPrefix });
    const planner = first.engine.createActor("actor#1", "planner");
    await expect(first.engine.ask("ask#1", planner, "s0")).resolves.toBe("r0");
    const p1 = first.engine.ask("ask#2", planner, "reworded second ask");
    await flush();
    expect(first.driver.sessionSeeds[0]).toEqual({
      sourceSessionId: "sess-a",
      messageCount: 4,
      resolvedModel: "zhipu/glm-5.3",
    });
    first.engine.askTurnEnded({ siteId: "ask#2", ordinal: 1 }, "live");
    await expect(p1).resolves.toBe("live");

    // Empty prefix plus hash mismatch -> a brand-new session, seed included not.
    const noPrefix = cacheOf([
      ["planner", candidate([], { inFlight: inFlightOf("old first ask", 6) })],
    ]);
    const second = setup({ importedCache: noPrefix });
    const fresh = second.engine.createActor("actor#1", "planner");
    const p0 = second.engine.ask("ask#1", fresh, "reworded first ask");
    await flush();
    expect(second.driver.startAskCount()).toBe(1);
    expect(second.driver.sessionSeeds[0]).toBeUndefined();
    second.engine.askTurnEnded({ siteId: "ask#1", ordinal: 1 }, "live");
    await expect(p0).resolves.toBe("live");
  });

  it("on a closed gate, stops continuing (the half transcript is all old-workspace observation) and falls back to the prefix boundary", async () => {
    const cache = cacheOf([
      ["planner", candidate([entry("s0", "r0", 4)], { inFlight: inFlightOf("s1", 12) })],
      ["fixer", candidate([], { persona: { name: "fixer" } })],
    ]);
    const { engine, driver } = setup({ importedCache: cache });

    const fixer = engine.createActor("actor#2", "fixer");
    const planner = engine.createActor("actor#1", "planner");
    await expect(engine.ask("ask#1", planner, "s0")).resolves.toBe("r0");

    // fixer misses, goes live, writes a file -> gate closes.
    const fix = engine.ask("ask#3", fixer, "fix the parser");
    await flush();
    engine.askMutating({ siteId: "ask#3", ordinal: 1 });
    expect(driver.eventsOfType("import-cache-closed")).toHaveLength(1);

    const p1 = engine.ask("ask#2", planner, "s1");
    await flush();
    const plannerSeed =
      driver.sessionSeeds[driver.sessionCreations.findIndex((ref) => ref.siteId === "actor#1")];
    expect(plannerSeed).toEqual({
      sourceSessionId: "sess-a",
      messageCount: 4,
      resolvedModel: "zhipu/glm-5.3",
    });

    engine.askTurnEnded({ siteId: "ask#2", ordinal: 1 }, "live-1");
    await expect(p1).resolves.toBe("live-1");
    engine.askTurnEnded({ siteId: "ask#3", ordinal: 1 }, "fixed");
    await expect(fix).resolves.toBe("fixed");
  });

  it("diverges earlier per actor: at the in-flight slot it is off-transcript, so no continuation even on a hash match", async () => {
    // entries[0]'s instruction differs -> divergence at seq 0; seq 2 hashes equal to inFlight but must not resurrect.
    const cache = cacheOf([
      [
        "planner",
        candidate([entry("old first ask", "r0", 4), entry("s1", "r1", 9)], {
          inFlight: inFlightOf("s2", 14),
        }),
      ],
    ]);
    const { engine, driver } = setup({ importedCache: cache });

    const planner = engine.createActor("actor#1", "planner");
    const p0 = engine.ask("ask#1", planner, "s0");
    const p1 = engine.ask("ask#2", planner, "s1");
    const p2 = engine.ask("ask#3", planner, "s2");
    await flush();

    expect(driver.sessionSeeds[0]).toBeUndefined();
    engine.askTurnEnded({ siteId: "ask#1", ordinal: 1 }, "live-0");
    await expect(p0).resolves.toBe("live-0");
    await flush();
    engine.askTurnEnded({ siteId: "ask#2", ordinal: 1 }, "live-1");
    await expect(p1).resolves.toBe("live-1");
    await flush();
    engine.askTurnEnded({ siteId: "ask#3", ordinal: 1 }, "live-2");
    await expect(p2).resolves.toBe("live-2");
    expect(driver.startAskCount()).toBe(3);
    expect(cachedSettles(driver)).toHaveLength(0);
  });

  describe("crash resume: reconstruct was-the-gate-open exactly from event order", () => {
    /** The amendment's original pass: seq 0 hit (real row, no node-queued), seq 1 continued (live row, node-queued). */
    function recordedFirstLife(closeBeforeCarry: boolean): InMemoryJournalStore {
      const journal = new InMemoryJournalStore();
      journal.createRun({
        runId: RUN,
        caps: { maxConcurrency: 16 },
        spentTokens: 0,
        status: "running",
        resumedFrom: "run-a",
      });
      journal.putActor({
        runId: RUN,
        siteId: "actor#1",
        ordinal: 1,
        name: "planner",
        persona: { name: "planner" },
      });
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
        result: `journal-${seq}`,
      });
      journal.putNode({ ...row("ask#1", 0, "s0"), messageBoundary: 4 });
      journal.putNode(row("ask#2", 1, "s1"));
      if (closeBeforeCarry) {
        journal.appendEvent(RUN, {
          type: "import-cache-closed",
          instance: { siteId: "world#1", ordinal: 1 },
          cause: "world-run",
        });
      }
      journal.appendEvent(RUN, {
        type: "node-queued",
        instance: { siteId: "ask#2", ordinal: 1 },
        kind: "ask",
        actor: { siteId: "actor#1", ordinal: 1 },
        actorSeq: 1,
      });
      return journal;
    }

    const carryCache = () =>
      cacheOf([["planner", candidate([entry("s0", "r0", 4)], { inFlight: inFlightOf("s1", 12) })]]);

    it("restore the same seed when node-queued precedes the close (the original really continued)", async () => {
      const { engine, driver } = setup({
        journal: recordedFirstLife(false),
        importedCache: carryCache(),
      });
      const planner = engine.createActor("actor#1", "planner");
      await expect(engine.ask("ask#1", planner, "s0")).resolves.toBe("journal-0");
      await expect(engine.ask("ask#2", planner, "s1")).resolves.toBe("journal-1");

      const p2 = engine.ask("ask#3", planner, "s2");
      await flush();
      expect(driver.startAskCount()).toBe(1);
      expect(driver.sessionSeeds[0]).toEqual({
        sourceSessionId: "sess-a",
        messageCount: 12,
        resolvedModel: "zhipu/glm-5.3",
      });
      engine.askTurnEnded({ siteId: "ask#3", ordinal: 1 }, "live-2");
      await expect(p2).resolves.toBe("live-2");
    });

    it("falls back to the prefix boundary when the close precedes node-queued: one copied segment too many splices transcripts", async () => {
      const { engine, driver } = setup({
        journal: recordedFirstLife(true),
        importedCache: carryCache(),
      });
      const planner = engine.createActor("actor#1", "planner");
      await expect(engine.ask("ask#1", planner, "s0")).resolves.toBe("journal-0");
      await expect(engine.ask("ask#2", planner, "s1")).resolves.toBe("journal-1");

      const p2 = engine.ask("ask#3", planner, "s2");
      await flush();
      expect(driver.sessionSeeds[0]).toEqual({
        sourceSessionId: "sess-a",
        messageCount: 4,
        resolvedModel: "zhipu/glm-5.3",
      });
      engine.askTurnEnded({ siteId: "ask#3", ordinal: 1 }, "live-2");
      await expect(p2).resolves.toBe("live-2");
    });
  });
});

describe("imported cache -- asks dispatched before this run's transcript record no worldToolCalls", () => {
  const TOUCHED = { tokens: 20, toolCalls: 4, turns: 2, worldToolCalls: 0 } as const;

  it("strips worldToolCalls from continued asks' settled stats (the counter covers this dispatch's turns only)", async () => {
    const cache = cacheOf([
      ["planner", candidate([], { inFlight: { inputHash: inputHash("s0"), messageBoundary: 6 } })],
    ]);
    const { engine, journal } = setup({ importedCache: cache });
    const planner = engine.createActor("actor#1", "planner");
    const p0 = engine.ask("ask#1", planner, "s0");
    await flush();

    engine.askStats({ siteId: "ask#1", ordinal: 1 }, { ...TOUCHED });
    engine.askTurnEnded({ siteId: "ask#1", ordinal: 1 }, "live-0");
    await expect(p0).resolves.toBe("live-0");

    expect(journal.getNode(RUN, "ask#1", 1)?.stats).toEqual({ tokens: 20, toolCalls: 4, turns: 2 });
  });

  it("strips worldToolCalls from late-arriving stat backfills on continued asks too", async () => {
    const cache = cacheOf([
      ["planner", candidate([], { inFlight: { inputHash: inputHash("s0"), messageBoundary: 6 } })],
    ]);
    const { engine, journal } = setup({ importedCache: cache });
    const planner = engine.createActor("actor#1", "planner");
    const p0 = engine.ask("ask#1", planner, "s0");
    await flush();

    engine.askTurnEnded({ siteId: "ask#1", ordinal: 1 }, "live-0");
    await expect(p0).resolves.toBe("live-0");
    engine.askStats({ siteId: "ask#1", ordinal: 1 }, { ...TOUCHED });

    expect(journal.getNode(RUN, "ask#1", 1)?.stats).toEqual({ tokens: 20, toolCalls: 4, turns: 2 });
  });

  it("drops worldToolCalls for re-dispatched running rows whose transcript already holds the prior lap's tool calls", async () => {
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
      name: "planner",
      persona: { name: "planner" },
    });
    journal.putNode({
      runId: RUN,
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      actorSiteId: "actor#1",
      actorOrdinal: 1,
      actorSeq: 0,
      inputHash: inputHash("s0"),
      status: "running",
    });

    const { engine } = setup({ journal });
    const planner = engine.createActor("actor#1", "planner");
    const p0 = engine.ask("ask#1", planner, "s0");
    await flush();

    engine.askStats({ siteId: "ask#1", ordinal: 1 }, { ...TOUCHED });
    engine.askTurnEnded({ siteId: "ask#1", ordinal: 1 }, "live-0");
    await expect(p0).resolves.toBe("live-0");
    expect(journal.getNode(RUN, "ask#1", 1)?.stats).toEqual({ tokens: 20, toolCalls: 4, turns: 2 });
  });

  it("keeps worldToolCalls on ordinary live asks (the purity signal must survive this rule)", async () => {
    const { engine, journal } = setup();
    const planner = engine.createActor("actor#1", "planner");
    const p0 = engine.ask("ask#1", planner, "s0");
    await flush();

    engine.askStats({ siteId: "ask#1", ordinal: 1 }, { ...TOUCHED });
    engine.askTurnEnded({ siteId: "ask#1", ordinal: 1 }, "live-0");
    await expect(p0).resolves.toBe("live-0");
    expect(journal.getNode(RUN, "ask#1", 1)?.stats).toEqual({ ...TOUCHED });
  });
});

describe("imported cache -- usage accumulates along the lineage (docs/execution-engine.md, Usage across the lineage)", () => {
  it("adds no tokens on hits (the predecessor's bill sits in the inherited value; entry stats copy to the node row), summing only on live divergence", async () => {
    const cache = cacheOf([
      [
        "planner",
        candidate([
          entry("step 1", "r1", 4, { tokens: 100, toolCalls: 0, turns: 1 }),
          entry("step 2", "r2", 9, { tokens: 100, toolCalls: 0, turns: 1 }),
        ]),
      ],
    ]);
    const { engine, driver, journal } = setup({ importedCache: cache, inheritedTokens: 500 });
    const planner = engine.createActor("actor#1", "planner");
    await expect(engine.ask("ask#1", planner, "step 1")).resolves.toBe("r1");
    // After hits the row value is unchanged with no second usage-updated (only the post-run-started inherited one).
    expect(journal.getRun(RUN)?.spentTokens).toBe(500);
    const hitStats = { tokens: 100, toolCalls: 0, turns: 1 };
    expect(journal.getNode(RUN, "ask#1", 1)?.stats).toEqual(hitStats);
    expect(driver.events.filter((event) => event.type === "usage-updated")).toEqual([
      { type: "usage-updated", spentTokens: 500 },
    ]);

    // Divergence: the second ask's instruction changed -> live; only its stats stack on top of 500.
    void engine.ask("ask#2", planner, "step 2, revised").catch(() => {});
    await flush();
    expect(driver.startAskCount()).toBe(1);
    engine.askStats({ siteId: "ask#2", ordinal: 1 }, { tokens: 30, toolCalls: 0, turns: 1 });
    expect(journal.getRun(RUN)?.spentTokens).toBe(530);
    expect(driver.events.at(-1)).toEqual({ type: "usage-updated", spentTokens: 530 });
    engine.stop("user");
  });
});
