/**
 * Resume's journal-read shape (docs/execution-engine.md, Reading the journal):
 *
 * - report rows are counted, not read: 65,536 reports restore counts and replay dedupe without
 * - the node table reads once: per-actor ask counts build from the already-read ask rows, not a full table
 * - events read only the types the settle order and import-close verdicts need.
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryJournalStore,
  WorkflowEngine,
  type AskSpec,
  type GetNodeOptions,
  type InstanceRef,
  type JournalStorePort,
  type ListEventsOptions,
  type ListNodesOptions,
  type NodeKind,
} from "../../src/engine/index.js";
import { FakeDriver, flush } from "./fake-driver.js";

const RUN = "run";
const ACTORS = 5;
const REPORTS = 40;

function inst(siteId: string, ordinal = 1): InstanceRef {
  return { siteId, ordinal };
}

const specs = new Map<string, AskSpec>([["ask#1", { typed: false } as AskSpec]]);

/** A journal forwarding to the real store, recording each read's shape. */
class RecordingJournal extends InMemoryJournalStore {
  readonly nodeReads: ListNodesOptions[] = [];
  readonly eventReads: ListEventsOptions[] = [];
  readonly pointReads: Array<{ siteId: string; opts: GetNodeOptions | undefined }> = [];
  readonly counts: NodeKind[] = [];
  readonly byteSums: NodeKind[] = [];
  recording = false;

  override listNodes(runId: string, opts: ListNodesOptions) {
    if (this.recording) this.nodeReads.push(opts);
    return super.listNodes(runId, opts);
  }

  override listEvents(runId: string, opts: ListEventsOptions) {
    if (this.recording) this.eventReads.push(opts);
    return super.listEvents(runId, opts);
  }

  override getNode(runId: string, siteId: string, ordinal: number, opts?: GetNodeOptions) {
    if (this.recording) this.pointReads.push({ siteId, opts });
    return super.getNode(runId, siteId, ordinal, opts);
  }

  override countNodes(runId: string, kind: NodeKind) {
    if (this.recording) this.counts.push(kind);
    return super.countNodes(runId, kind);
  }

  override sumResultBytes(runId: string, kind: NodeKind) {
    if (this.recording) this.byteSums.push(kind);
    return super.sumResultBytes(runId, kind);
  }
}

function engineOn(journal: JournalStorePort) {
  const driver = new FakeDriver(journal);
  const engine = new WorkflowEngine({
    runId: RUN,
    driver,
    caps: { maxConcurrency: 16 },
    askSpecs: specs,
    validate: () => [],
  });
  return { driver, engine };
}

/** One script: ACTORS actors ask once each, then REPORTS. Incarnation one answers all; two hits all. */
async function runScript(
  engine: WorkflowEngine,
  answer: (i: number) => void,
): Promise<Array<Promise<unknown>>> {
  const asks: Array<Promise<unknown>> = [];
  for (let i = 0; i < ACTORS; i += 1) {
    const actor = engine.createActor("actor#1");
    asks.push(engine.ask("ask#1", actor, `task ${i}`));
  }
  await flush();
  for (let i = 0; i < ACTORS; i += 1) answer(i);
  await Promise.all(asks);
  for (let i = 0; i < REPORTS; i += 1)
    engine.report("report#1", { finding: i, pad: "x".repeat(64) });
  return asks;
}

describe("resume reads only what it uses", () => {
  it("never loads a report item, and reads the node table once however many actors register", async () => {
    const journal = new RecordingJournal();
    const first = engineOn(journal);
    await runScript(first.engine, (i) =>
      first.engine.askTurnEnded(inst("ask#1", i + 1), `answer ${i}`),
    );
    first.engine.stop("user");
    await first.engine.settled;

    journal.recording = true;
    const resumed = engineOn(journal);
    await runScript(resumed.engine, () => {});
    journal.recording = false;

    // Node table: exactly two reads (work rows without results, plus artifact rows), actor-count independent.
    expect(journal.nodeReads).toEqual([
      { kinds: ["ask", "world-read", "world-run"], withResult: false },
      { kinds: ["artifact"], withResult: true },
    ]);
    // Report count and bytes are aggregates: count(*) and sum(octet_length(result_json)).
    expect(journal.counts).toEqual(["report"]);
    expect(journal.byteSums).toEqual(["report"]);
    // Events: only settle-order types, and not one report item read.
    expect(journal.eventReads.length).toBeGreaterThan(0);
    for (const read of journal.eventReads) {
      expect(read.types).not.toBe("all");
      expect(read.reportItems).toEqual({ limit: 0 });
    }
    // Report replay dedupe compares hashes only.
    const reportPoints = journal.pointReads.filter((read) => read.siteId === "report#1");
    expect(reportPoints).toHaveLength(REPORTS);
    for (const read of reportPoints) expect(read.opts).toEqual({ withResult: false });

    // Behavior unchanged: all hit, no report re-emitted, no new dispatches.
    expect(resumed.driver.eventsOfType("report")).toEqual([]);
    expect(resumed.driver.startAskCount()).toBe(0);
  });

  it("still holds a live ask behind the actor's recorded asks after a resume", async () => {
    // recordedCount builds from the ask rows resume already read: an actor answered twice in incarnation one,
    // the third ask must dispatch after both hits (the hold rule) and alone.
    const journal = new InMemoryJournalStore();
    const first = engineOn(journal);
    const actor = first.engine.createActor("actor#1");
    const a = first.engine.ask("ask#1", actor, "one");
    await flush();
    first.engine.askTurnEnded(inst("ask#1", 1), "r1");
    await a;
    const b = first.engine.ask("ask#1", actor, "two");
    await flush();
    first.engine.askTurnEnded(inst("ask#1", 2), "r2");
    await b;
    first.engine.stop("user");
    await first.engine.settled;

    const resumed = engineOn(journal);
    const again = resumed.engine.createActor("actor#1");
    const hits = [
      resumed.engine.ask("ask#1", again, "one"),
      resumed.engine.ask("ask#1", again, "two"),
    ];
    const live = resumed.engine.ask("ask#1", again, "three");
    await expect(Promise.all(hits)).resolves.toEqual(["r1", "r2"]);
    await flush();
    expect(resumed.driver.startAskCount()).toBe(1);
    expect(resumed.driver.startAsks[0]?.instance).toEqual(inst("ask#1", 3));
    resumed.engine.askTurnEnded(inst("ask#1", 3), "r3");
    await expect(live).resolves.toBe("r3");
  });
});
