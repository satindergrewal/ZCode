import { describe, expect, it } from "vitest";
import {
  InMemoryJournalStore,
  WorkflowEngine,
  refToString,
  type AskSpec,
} from "../../src/engine/index.js";
import { FakeDriver, flush } from "./fake-driver.js";

/**
 * Lexical birth phases (docs/execution-engine.md, Identity: sites, ordinals, phases): EngineConfig.sitePhases
 * stamps tabulated sites from the table and falls back to the dynamic current phase otherwise. When two
 * the last-passed marker is timing's guess -- the tabulated phase is what the confirmed graph shows users.
 */

const RUN = "run";
const untyped = (...ids: string[]): Map<string, AskSpec> =>
  new Map(ids.map((id) => [id, { typed: false } as AskSpec]));

function setup(sitePhases?: ReadonlyMap<string, string>) {
  const journal = new InMemoryJournalStore();
  const driver = new FakeDriver(journal, {});
  const engine = new WorkflowEngine({
    runId: RUN,
    driver,
    caps: { maxConcurrency: 16 },
    askSpecs: untyped("ask#1", "ask#2"),
    validate: () => [],
    ...(sitePhases === undefined ? {} : { sitePhases }),
  });
  return { driver, engine };
}

describe("WorkflowEngine — lexical birth phase (sitePhases)", () => {
  it("stamps a listed site with its lexical phase, whatever marker ran last", async () => {
    const { engine, driver } = setup(
      new Map([
        ["actor#1", "gather"],
        ["ask#1", "gather"],
        ["actor#2", "verify"],
        ["ask#2", "verify"],
      ]),
    );
    // Timing: both stages' markers passed, current phase at verify; gather's ask fires after the await,
    engine.enterPhase("gather");
    engine.enterPhase("verify");
    const verifier = engine.createActor("actor#2", "verifier");
    void engine.ask("ask#2", verifier, "verify");
    const researcher = engine.createActor("actor#1", "researcher");
    void engine.ask("ask#1", researcher, "research");
    void engine.worldRead("world-read#1", "glob", ["src/**"]);
    await flush();

    expect(
      driver.eventsOfType("actor-created").map((e) => [refToString(e.actor), e.phaseName]),
    ).toEqual([
      ["actor#2@1", "verify"],
      ["actor#1@1", "gather"],
    ]);
    const queued = new Map(
      driver.eventsOfType("node-queued").map((e) => [refToString(e.instance), e.phaseName]),
    );
    expect(queued.get("ask#2@1")).toBe("verify");
    expect(queued.get("ask#1@1")).toBe("gather");
    // Off-table sites fall back to the dynamic current phase.
    expect(queued.get("world-read#1@1")).toBe("verify");
  });

  it("falls back to the dynamic phase for every site when no table is given", async () => {
    const { engine, driver } = setup();
    engine.enterPhase("only");
    const actor = engine.createActor("actor#1", "a");
    void engine.ask("ask#1", actor, "x");
    await flush();
    expect(driver.eventsOfType("node-queued")[0]).toMatchObject({ phaseName: "only" });
  });

  it("leaves an unlisted instance unstamped before any marker", async () => {
    const { engine, driver } = setup(new Map([["ask#2", "later"]]));
    const actor = engine.createActor("actor#1", "a");
    void engine.ask("ask#1", actor, "x");
    await flush();
    expect(driver.eventsOfType("node-queued")[0]).not.toHaveProperty("phaseName");
  });
});
