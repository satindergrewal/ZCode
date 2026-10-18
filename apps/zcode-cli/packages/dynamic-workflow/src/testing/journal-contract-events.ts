/**
 * Split out because journal-contract.ts hit the oxlint max-lines cap (400 lines): the events
 * (append sequence, resume continuation, cursor paging, per-run isolation) live here. The public
 * surface is still exported from journal-contract.ts (`runJournalStoreContract` calls each
 * topic's registration function in the original order).
 *
 * Note: only `it(...)` is registered here, no extra describe — the suite's grouping and case
 * order must stay verbatim-identical to the pre-split layout.
 */

import { expect, it } from "vitest";
import type { JournalStorePort } from "../engine/index.js";
import { baseRun, logs } from "./journal-contract-helpers.js";

export function registerEventCases(factory: () => JournalStorePort): void {
  it("appends events with monotonic sequence and lists them in order", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const a = store.appendEvent("r1", { type: "log", message: "one" });
    const b = store.appendEvent("r1", { type: "log", message: "two" });
    expect(a.sequence).toBe(0);
    expect(b.sequence).toBe(1);
    const events = store.listEvents("r1", { types: "all", reportItems: "all" });
    expect(events.map((e) => e.sequence)).toEqual([0, 1]);
    expect(events.map((e) => (e.event.type === "log" ? e.event.message : ""))).toEqual([
      "one",
      "two",
    ]);
  });

  it("stamps timeCreated on append and gives the same instant back on read", () => {
    // The only clock in the event log (docs/execution-engine.md "The journal"): a log line's age
    // and the time of a subagent's last action can only be derived from it. Both implementations
    // must fill it — leaving readers to fall back to a fresh Date.now() would brand a whole
    // week-old history in one cold replay as "just now". Append and read-back must yield the
    // same number, or the same event differs between the two faces.
    const store = factory();
    store.createRun(baseRun("r1"));
    const before = Date.now();
    const appended = store.appendEvent("r1", { type: "log", message: "one" });
    const after = Date.now();
    expect(appended.timeCreated).toBeTypeOf("number");
    expect(appended.timeCreated!).toBeGreaterThanOrEqual(before);
    expect(appended.timeCreated!).toBeLessThanOrEqual(after);

    const [read] = store.listEvents("r1", { types: "all", reportItems: "all" });
    expect(read?.timeCreated).toBe(appended.timeCreated);
  });

  it("throws when appending an event to an unknown run", () => {
    // An orphaned event could never be read back (listEvents filters by runId) — the same
    // contract breach as putActor/putNode, so it must fail loudly on the spot. The SQLite side
    // gets the same semantics from dwf_event's foreign key.
    const store = factory();
    expect(() => store.appendEvent("nope", { type: "log", message: "orphan" })).toThrow();
  });

  it("continues event sequence monotonically over a pre-populated store (resume case)", () => {
    // Resume semantics: when a new engine takes over a store that already has events, appendEvent
    // must continue after the existing maximum sequence — neither resetting nor reusing numbers.
    // The in-memory implementation satisfies this naturally; the assertion forces the stage-two
    // SQLite implementation into the same MAX(sequence)+1 semantics.
    const store = factory();
    store.createRun(baseRun("r1"));
    store.appendEvent("r1", { type: "log", message: "pre-0" });
    store.appendEvent("r1", { type: "log", message: "pre-1" });

    // Simulate resume: keep appending on the same store (in production another engine instance
    // takes over).
    const resumed = store.appendEvent("r1", { type: "log", message: "post" });
    expect(resumed.sequence).toBe(2);

    const sequences = store
      .listEvents("r1", { types: "all", reportItems: "all" })
      .map((e) => e.sequence);
    expect(sequences).toEqual([0, 1, 2]);
    // Sequence unique (no reuse) and strictly increasing.
    expect(new Set(sequences).size).toBe(sequences.length);
    for (let i = 1; i < sequences.length; i++)
      expect(sequences[i]!).toBeGreaterThan(sequences[i - 1]!);
  });

  it("pages events with afterSequence as a strictly-greater cursor", () => {
    // The cursor is "the last sequence already read", not an offset: afterSequence: 0 must skip
    // sequence 0 (already read), not start from entry 0. Sequences start at 0, which is exactly
    // where an offset-style implementation shows — its first page would repeat one event.
    const store = factory();
    store.createRun(baseRun("r1"));
    for (const message of ["e0", "e1", "e2"]) store.appendEvent("r1", { type: "log", message });

    expect(logs(store.listEvents("r1", { types: "all", reportItems: "all" }))).toEqual([
      "e0",
      "e1",
      "e2",
    ]);
    expect(
      logs(store.listEvents("r1", { types: "all", reportItems: "all", afterSequence: 0 })),
    ).toEqual(["e1", "e2"]);
    expect(
      logs(store.listEvents("r1", { types: "all", reportItems: "all", afterSequence: 1 })),
    ).toEqual(["e2"]);
    expect(store.listEvents("r1", { types: "all", reportItems: "all", afterSequence: 2 })).toEqual(
      [],
    );
  });

  it("returns an empty page for an out-of-range cursor instead of throwing", () => {
    // The detail page refetches whenever lastEventSequence advances; between the projection and
    // the journal there is a race window, so a client returning a not-yet-existing cursor is
    // normal timing, not an error.
    const store = factory();
    store.createRun(baseRun("r1"));
    store.appendEvent("r1", { type: "log", message: "only" });
    expect(store.listEvents("r1", { types: "all", reportItems: "all", afterSequence: 99 })).toEqual(
      [],
    );
    // An unknown run is an empty page too: that is listEvents' whole-form semantics today, and
    // adding the cursor does not change it.
    expect(
      store.listEvents("nope", { types: "all", reportItems: "all", afterSequence: 0 }),
    ).toEqual([]);
  });

  it("caps a page at limit and keeps it anchored at the cursor", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    for (let i = 0; i < 5; i++) store.appendEvent("r1", { type: "log", message: `e${i}` });

    expect(logs(store.listEvents("r1", { types: "all", reportItems: "all", limit: 2 }))).toEqual([
      "e0",
      "e1",
    ]);
    expect(
      logs(
        store.listEvents("r1", { types: "all", reportItems: "all", afterSequence: 1, limit: 2 }),
      ),
    ).toEqual(["e2", "e3"]);
    // A limit beyond the remaining rows yields the rest, padded with nothing.
    expect(
      logs(
        store.listEvents("r1", { types: "all", reportItems: "all", afterSequence: 3, limit: 10 }),
      ),
    ).toEqual(["e4"]);
    expect(store.listEvents("r1", { types: "all", reportItems: "all", limit: 0 })).toEqual([]);
  });

  it("walks every event exactly once when paging by cursor (no overlap, no gap)", () => {
    // The whole-property of paging: advancing the cursor page by page across the entire journal
    // must equal the one-shot full read verbatim. Off-by-one errors (> vs >=, or limit
    // interfering with the cursor) only surface on this assertion.
    const store = factory();
    store.createRun(baseRun("r1"));
    const total = 7;
    for (let i = 0; i < total; i++) store.appendEvent("r1", { type: "log", message: `e${i}` });

    const walked: number[] = [];
    let cursor: number | undefined;
    for (let guard = 0; guard <= total; guard++) {
      const page = store.listEvents("r1", {
        types: "all",
        reportItems: "all",
        afterSequence: cursor,
        limit: 3,
      });
      if (page.length === 0) break;
      for (const stored of page) walked.push(stored.sequence);
      cursor = page[page.length - 1]!.sequence;
    }

    expect(walked).toEqual(
      store.listEvents("r1", { types: "all", reportItems: "all" }).map((e) => e.sequence),
    );
    expect(new Set(walked).size).toBe(total);
  });

  it("keeps the cursor valid across resume", () => {
    // After resume the sequence continues past the existing maximum, so a cursor the run recorded
    // earlier still fetches only new events; should an implementation renumber from 0 per run per
    // boot, or order by row id instead of sequence, the client re-receives old events or misses
    // new ones.
    const store = factory();
    store.createRun(baseRun("r1"));
    store.appendEvent("r1", { type: "log", message: "pre-0" });
    store.appendEvent("r1", { type: "log", message: "pre-1" });
    const cursor = store.listEvents("r1", { types: "all", reportItems: "all" }).at(-1)!.sequence;

    // Simulate resume: another engine instance takes over the same store and keeps appending.
    store.updateRunStatus("r1", "running");
    store.appendEvent("r1", { type: "log", message: "post-0" });
    store.appendEvent("r1", { type: "log", message: "post-1" });

    const tail = store.listEvents("r1", {
      types: "all",
      reportItems: "all",
      afterSequence: cursor,
    });
    expect(logs(tail)).toEqual(["post-0", "post-1"]);
    expect(tail.map((e) => e.sequence)).toEqual([cursor + 1, cursor + 2]);
  });

  it("scopes event pages per runId", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.createRun(baseRun("r2"));
    store.appendEvent("r1", { type: "log", message: "r1-0" });
    store.appendEvent("r2", { type: "log", message: "r2-0" });
    store.appendEvent("r2", { type: "log", message: "r2-1" });
    // Each run's sequence starts from 0 independently, so the cursor must be filtered together
    // with the runId.
    expect(
      logs(store.listEvents("r1", { types: "all", reportItems: "all", afterSequence: 0 })),
    ).toEqual([]);
    expect(
      logs(store.listEvents("r2", { types: "all", reportItems: "all", afterSequence: 0 })),
    ).toEqual(["r2-1"]);
  });
}
