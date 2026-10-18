/**
 * Engine-side user-facing artifacts (the journal-rows-and-events rows plus the error-code table of
 * docs/dynamic-workflow/authoring.md). The compile side lives in tests/artifacts.test.ts.
 *
 * Terminology: artifact in this file always means the user-facing product (what the script publishes
 * for the user), not `RunSettlement.artifact` (the script's top-level return value).
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryJournalStore,
  WorkflowEngine,
  WorkflowError,
  type ArtifactVersionRecord,
  type Caps,
} from "../../src/engine/index.js";
import { ARTIFACT_CAPS } from "../../src/facade/artifact-caps.js";
import { FakeDriver, type FakeDriverOptions } from "./fake-driver.js";

const RUN = "run";
const CHART = { x: { field: "round" }, y: { field: "ms" } };

function setup(opts: { journal?: InMemoryJournalStore; caps?: Caps } & FakeDriverOptions = {}) {
  const { journal: given, caps, ...driverOptions } = opts;
  const journal = given ?? new InMemoryJournalStore();
  const driver = new FakeDriver(journal, driverOptions);
  const engine = new WorkflowEngine({
    runId: RUN,
    driver,
    caps: caps ?? { maxConcurrency: 16 },
    askSpecs: new Map(),
    validate: () => [],
  });
  return { journal, driver, engine };
}

/** All payloads of one event type (for stream assertions). */
const published = (driver: FakeDriver): ArtifactVersionRecord[] =>
  driver.eventsOfType("artifact-published").map((event) => event.artifact);

/** Captures one run-level failure (settled resolves errored after failRun). */
async function failure(engine: WorkflowEngine): Promise<WorkflowError> {
  const settlement = await engine.settled;
  if (settlement.status !== "errored")
    throw new Error(`expected errored, got ${settlement.status}`);
  return settlement.error;
}

describe("publishArtifact -- content members", () => {
  it("publishes via the driver, records a completed row, emits artifact-published, and hands the ref back", async () => {
    const { engine, driver, journal } = setup();
    const ref = await engine.publishArtifact("artifact#1", "file", [
      "book",
      "out/book.pdf",
      { title: "Book" },
    ]);

    expect(ref).toEqual({ id: "book", version: 1 });
    // The driver-facing request shape: the engine computes the version and passes it (the store's toolCallId carries it).
    expect(driver.artifactPublishes).toEqual([
      {
        runId: RUN,
        siteId: "artifact#1",
        ordinal: 1,
        op: "file",
        id: "book",
        version: 1,
        path: "out/book.pdf",
        opts: { title: "Book" },
      },
    ]);
    const node = journal.getNode(RUN, "artifact#1", 1);
    expect(node?.kind).toBe("artifact");
    expect(node?.status).toBe("completed");
    expect(node?.artifactId).toBe("book");
    expect((node?.result as ArtifactVersionRecord | undefined)?.uri).toBe(
      "zcode-artifact://fake/book/1",
    );
    expect(published(driver).map((r) => [r.id, r.version])).toEqual([["book", 1]]);
  });

  it("versions re-publishes of one id, derived from completed row counts", async () => {
    const { engine } = setup();
    const first = await engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]);
    const second = await engine.publishArtifact("artifact#1", "file", ["book", "b.pdf"]);
    expect([first.version, second.version]).toEqual([1, 2]);
  });

  it("sends markdown as content, not path", async () => {
    const { engine, driver } = setup();
    await engine.publishArtifact("artifact#1", "markdown", ["notes", "# hi"]);
    expect(driver.artifactPublishes[0]?.content).toBe("# hi");
    expect(driver.artifactPublishes[0]?.path).toBeUndefined();
  });

  it("short-circuits on journal hits: no driver call, no re-emitted events", async () => {
    const journal = new InMemoryJournalStore();
    const first = setup({ journal });
    await first.engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]);
    first.engine.complete(undefined);

    const resumed = setup({ journal });
    const ref = await resumed.engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]);
    expect(ref).toEqual({ id: "book", version: 1 });
    expect(resumed.driver.artifactPublishes).toEqual([]);
    expect(published(resumed.driver)).toEqual([]);
  });

  it("re-rejects from a recorded failure on resume (resume is crash recovery, not re-validation)", async () => {
    const journal = new InMemoryJournalStore();
    const first = setup({ journal, withoutArtifactStore: true });
    await expect(
      first.engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]),
    ).rejects.toMatchObject({ code: "ArtifactStoreUnavailable" });
    first.engine.complete(undefined);

    // The second assembly has a store: the recorded failure is still a failure, the driver never called.
    const resumed = setup({ journal });
    await expect(
      resumed.engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]),
    ).rejects.toMatchObject({ code: "ArtifactStoreUnavailable" });
    expect(resumed.driver.artifactPublishes).toEqual([]);
  });

  it("keeps version numbers continuous across resume", async () => {
    const journal = new InMemoryJournalStore();
    const first = setup({ journal });
    await first.engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]);
    first.engine.complete(undefined);

    const resumed = setup({ journal });
    // The first call replay-hits (v1); the second is a new ordinal that would be 1 had the version count not
    await resumed.engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]);
    const next = await resumed.engine.publishArtifact("artifact#1", "file", ["book", "b.pdf"]);
    expect(next.version).toBe(2);
  });

  it("fails the whole run on an inputHash mismatch (never silently drifts)", async () => {
    const journal = new InMemoryJournalStore();
    const first = setup({ journal });
    await first.engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]);
    first.engine.complete(undefined);

    const resumed = setup({ journal });
    await expect(
      resumed.engine.publishArtifact("artifact#1", "file", ["book", "OTHER.pdf"]),
    ).rejects.toMatchObject({ code: "InputHashMismatch" });
    expect((await failure(resumed.engine)).code).toBe("InputHashMismatch");
  });

  it("rejects version 17 at node level, catchable, with the run alive", async () => {
    const { engine } = setup();
    for (let i = 1; i <= ARTIFACT_CAPS.maxVersionsPerArtifact; i++) {
      await engine.publishArtifact("artifact#1", "file", ["book", `v${i}.pdf`]);
    }
    await expect(
      engine.publishArtifact("artifact#1", "file", ["book", "v17.pdf"]),
    ).rejects.toMatchObject({ code: "ArtifactVersionCapExceeded" });
    expect(engine.status()).toBe("running");
  });

  it("rejects the 33rd id", async () => {
    const { engine } = setup();
    for (let i = 1; i <= ARTIFACT_CAPS.maxArtifactsPerRun; i++) {
      await engine.publishArtifact("artifact#1", "markdown", [`doc${i}`, "x"]);
    }
    await expect(
      engine.publishArtifact("artifact#1", "markdown", ["overflow", "x"]),
    ).rejects.toMatchObject({ code: "ArtifactCapExceeded" });
  });

  it("makes cross-kind id reuse a node-level rejection", async () => {
    const { engine } = setup();
    await engine.publishArtifact("artifact#1", "file", ["x", "a.pdf"]);
    await expect(
      engine.publishArtifact("artifact#2", "markdown", ["x", "hi"]),
    ).rejects.toMatchObject({ code: "ArtifactKindMismatch" });
    expect(engine.status()).toBe("running");
  });

  it("rejects loudly without an artifact store and journals the failure", async () => {
    const { engine, journal, driver } = setup({ withoutArtifactStore: true });
    await expect(
      engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]),
    ).rejects.toMatchObject({ code: "ArtifactStoreUnavailable" });
    const node = journal.getNode(RUN, "artifact#1", 1);
    expect(node?.status).toBe("failed");
    expect(node?.error?.code).toBe("ArtifactStoreUnavailable");
    expect(node?.artifactId).toBe("book");
    // The failure emits its own event with what a failure card needs to render.
    expect(published(driver)).toEqual([]);
    expect(driver.eventsOfType("artifact-failed")).toEqual([
      {
        type: "artifact-failed",
        instance: { siteId: "artifact#1", ordinal: 1 },
        id: "book",
        op: "file",
        error: node?.error,
      },
    ]);
  });

  // 2026-09-04 ruling: artifact sites enter no graph, so a node-settled landing on one would render
  // an unknown node (the projection folds node-settled into nodes[], and the layer finds no node for the id).
  it("emits no node-settled on failure: artifact sites have no node to settle", async () => {
    const { engine, driver } = setup({ withoutArtifactStore: true });
    await expect(
      engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]),
    ).rejects.toMatchObject({ code: "ArtifactStoreUnavailable" });
    expect(driver.eventsOfType("node-settled")).toEqual([]);
    expect(driver.eventsOfType("node-queued")).toEqual([]);
    expect(driver.eventsOfType("node-dispatched")).toEqual([]);
  });

  // The success-side dual (parity with report is deliberate): artifact-published only, no node lifecycle.
  it("likewise emits only artifact-published on success, never a node lifecycle event", async () => {
    const { engine, driver } = setup();
    await engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]);
    expect(driver.eventsOfType("artifact-published")).toHaveLength(1);
    for (const type of ["node-queued", "node-dispatched", "node-settled"] as const) {
      expect(driver.eventsOfType(type)).toEqual([]);
    }
  });

  it("re-emits nothing when replay hits a failure row", async () => {
    const journal = new InMemoryJournalStore();
    const first = setup({ journal, withoutArtifactStore: true });
    await expect(
      first.engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]),
    ).rejects.toMatchObject({ code: "ArtifactStoreUnavailable" });
    first.engine.complete(undefined);

    const resumed = setup({ journal });
    await expect(
      resumed.engine.publishArtifact("artifact#1", "file", ["book", "a.pdf"]),
    ).rejects.toMatchObject({ code: "ArtifactStoreUnavailable" });
    expect(resumed.driver.eventsOfType("artifact-failed")).toEqual([]);
    expect(resumed.driver.eventsOfType("artifact-published")).toEqual([]);
  });

  // The argument-shape guard is a deterministic rejection: decided by args alone, no driver round trip,
  // so neither a row nor an event: there is no id to write, and inventing one would imply a phantom artifact.
  it("rejects argument-shape errors outright: no row, no event", async () => {
    const { engine, journal, driver } = setup();
    await expect(engine.publishArtifact("artifact#1", "file", [42, "a.pdf"])).rejects.toMatchObject(
      { code: "DriverError" },
    );
    await expect(
      engine.publishArtifact("artifact#2", "markdown", ["notes", 7]),
    ).rejects.toMatchObject({ code: "DriverError" });
    expect(
      journal
        .listNodes(RUN, { kinds: "all", withResult: true })
        .filter((n) => n.kind === "artifact"),
    ).toEqual([]);
    expect(driver.eventsOfType("artifact-failed")).toEqual([]);
  });

  it("maps driver rejections to a failed node plus a catchable structured error", async () => {
    const { engine, journal, driver } = setup({ deferArtifactPublishes: true });
    const promise = engine.publishArtifact("artifact#1", "file", ["book", "missing.pdf"]);
    driver.artifactDeferrals[0]?.reject(
      new WorkflowError("ArtifactSourceMissing", "out/book.pdf does not exist"),
    );
    await expect(promise).rejects.toMatchObject({ code: "ArtifactSourceMissing" });
    expect(journal.getNode(RUN, "artifact#1", 1)?.status).toBe("failed");
    expect(driver.eventsOfType("artifact-failed").map((e) => [e.id, e.op, e.error.code])).toEqual([
      ["book", "file", "ArtifactSourceMissing"],
    ]);
    expect(engine.status()).toBe("running");
  });

  it("lets a failed publish release the id, retrying still version 1", async () => {
    const { engine, driver } = setup({ deferArtifactPublishes: true });
    const first = engine.publishArtifact("artifact#1", "file", ["book", "missing.pdf"]);
    driver.artifactDeferrals[0]?.reject(new WorkflowError("ArtifactSourceMissing", "no"));
    await expect(first).rejects.toMatchObject({ code: "ArtifactSourceMissing" });

    const second = engine.publishArtifact("artifact#1", "file", ["book", "now-there.pdf"]);
    driver.artifactDeferrals[1]?.resolve({ id: "book", kind: "file", version: 1 });
    expect(await second).toEqual({ id: "book", version: 1 });
  });
});

describe("primary (docs/dynamic-workflow/authoring.md, 'Ids, tags and versions')", () => {
  it("stamps the primary flag onto the record, event and journal row alike", async () => {
    const { engine, driver, journal } = setup();
    await engine.publishArtifact("artifact#1", "file", ["book", "a.pdf", { primary: true }]);
    expect(published(driver)[0]?.primary).toBe(true);
    expect(journal.getNode(RUN, "artifact#1", 1)?.result).toMatchObject({ primary: true });
    // Unstamped rows have no such key (absent, not false).
    await engine.publishArtifact("artifact#2", "file", ["notes", "n.pdf"]);
    expect("primary" in (published(driver)[1] ?? {})).toBe(false);
  });

  it("sticks per id: the next version stays primary without restating it", async () => {
    const { engine, driver } = setup();
    await engine.publishArtifact("artifact#1", "file", ["book", "a.pdf", { primary: true }]);
    await engine.publishArtifact("artifact#1", "file", ["book", "b.pdf"]);
    expect(published(driver).map((r) => [r.version, r.primary])).toEqual([
      [1, true],
      [2, true],
    ]);
  });

  it("rejects a second primary id at node level: failure row plus artifact-failed, run alive", async () => {
    const { engine, driver, journal } = setup();
    await engine.publishArtifact("artifact#1", "file", ["book", "a.pdf", { primary: true }]);
    await expect(
      engine.publishArtifact("artifact#2", "markdown", ["notes", "hi", { primary: true }]),
    ).rejects.toMatchObject({ code: "ArtifactPrimaryConflict" });
    expect(journal.getNode(RUN, "artifact#2", 1)?.status).toBe("failed");
    expect(driver.eventsOfType("artifact-failed")).toHaveLength(1);
    expect(engine.status()).toBe("running");
    // The loser never claimed the id: republishing without the flag is its version 1.
    const ref = await engine.publishArtifact("artifact#2", "markdown", ["notes", "hi"]);
    expect(ref.version).toBe(1);
  });

  it("admits both concurrent primary publishes and fails the later one at settlement", async () => {
    const { engine, driver } = setup();
    const results = await Promise.allSettled([
      engine.publishArtifact("artifact#1", "file", ["a", "a.pdf", { primary: true }]),
      engine.publishArtifact("artifact#2", "file", ["b", "b.pdf", { primary: true }]),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(published(driver).map((r) => r.id)).toEqual(["a"]);
    expect(driver.eventsOfType("artifact-failed")[0]?.error.code).toBe("ArtifactPrimaryConflict");
  });

  it("re-rejects on failure-row replay without claiming the flag", async () => {
    const journal = new InMemoryJournalStore();
    const first = setup({ journal });
    await first.engine.publishArtifact("artifact#1", "file", ["book", "a.pdf", { primary: true }]);
    await expect(
      first.engine.publishArtifact("artifact#2", "file", ["other", "o.pdf", { primary: true }]),
    ).rejects.toMatchObject({ code: "ArtifactPrimaryConflict" });
    first.engine.complete(undefined);

    const resumed = setup({ journal });
    await resumed.engine.publishArtifact("artifact#1", "file", [
      "book",
      "a.pdf",
      { primary: true },
    ]);
    await expect(
      resumed.engine.publishArtifact("artifact#2", "file", ["other", "o.pdf", { primary: true }]),
    ).rejects.toMatchObject({ code: "ArtifactPrimaryConflict" });
    // The resume rebuild keeps book primary, so the third id is rejected too.
    await expect(
      resumed.engine.publishArtifact("artifact#3", "file", ["third", "t.pdf", { primary: true }]),
    ).rejects.toMatchObject({ code: "ArtifactPrimaryConflict" });
    expect(resumed.driver.artifactPublishes).toEqual([]);
  });

  it("guards non-boolean primary deterministically: DriverError, no row, no event", async () => {
    const { engine, driver, journal } = setup();
    await expect(
      engine.publishArtifact("artifact#1", "file", ["book", "a.pdf", { primary: "yes" }]),
    ).rejects.toMatchObject({ code: "DriverError" });
    expect(journal.getNode(RUN, "artifact#1", 1)).toBeUndefined();
    expect(driver.eventsOfType("artifact-failed")).toEqual([]);
  });

  it("lets predeclared artifacts be primary; a second flagged id is a failRun", async () => {
    const { engine, driver } = setup();
    engine.declareArtifact("artifact#1", "board", [
      "triage",
      { key: "id", status: "s", columns: ["x"], primary: true },
    ]);
    expect(published(driver)[0]?.primary).toBe(true);
    engine.declareArtifact("artifact#2", "chart", ["perf", { ...CHART, primary: true }]);
    expect((await failure(engine)).code).toBe("ArtifactPrimaryConflict");
  });

  it("fails the run when a predeclared id claims primary after a content primary", async () => {
    const { engine } = setup();
    await engine.publishArtifact("artifact#1", "file", ["book", "a.pdf", { primary: true }]);
    engine.declareArtifact("artifact#2", "chart", ["perf", { ...CHART, primary: true }]);
    expect((await failure(engine)).code).toBe("ArtifactPrimaryConflict");
  });

  it("makes a non-boolean spec primary ArtifactSpecInvalid", async () => {
    const { engine } = setup();
    engine.declareArtifact("artifact#1", "chart", ["perf", { ...CHART, primary: 1 }]);
    const err = await failure(engine);
    expect(err.code).toBe("ArtifactSpecInvalid");
    expect(err.message).toContain("primary must be a boolean");
  });
});

describe("declareArtifact -- predeclared members", () => {
  it("records a completed row, emits artifact-published, and keeps spec and title on the record", () => {
    const { engine, driver, journal } = setup();
    engine.declareArtifact("artifact#1", "chart", ["perf", { ...CHART, title: "Perf" }]);

    const node = journal.getNode(RUN, "artifact#1", 1);
    expect(node?.kind).toBe("artifact");
    expect(node?.status).toBe("completed");
    expect(node?.artifactId).toBe("perf");
    const record = node?.result as ArtifactVersionRecord;
    expect(record).toMatchObject({ id: "perf", kind: "chart", version: 1, title: "Perf" });
    expect(record.spec).toEqual({ ...CHART, title: "Perf" });
    expect(published(driver)).toHaveLength(1);
  });

  it("skips the driver entirely", () => {
    const { engine, driver } = setup();
    engine.declareArtifact("artifact#1", "table", ["rows", { columns: [{ field: "n" }] }]);
    expect(driver.artifactPublishes).toEqual([]);
  });

  it("makes same-id same-spec redeclaration an idempotent no-op: no row, no event", () => {
    const { engine, driver, journal } = setup();
    engine.declareArtifact("artifact#1", "chart", ["perf", CHART]);
    engine.declareArtifact("artifact#2", "chart", ["perf", { ...CHART }]);
    expect(published(driver)).toHaveLength(1);
    expect(journal.getNode(RUN, "artifact#2", 1)).toBeUndefined();
    expect(
      journal
        .listNodes(RUN, { kinds: "all", withResult: true })
        .filter((n) => n.kind === "artifact"),
    ).toHaveLength(1);
  });

  it("fails the run on same-id different-spec (void returns have no rejection channel)", async () => {
    const { engine } = setup();
    engine.declareArtifact("artifact#1", "chart", ["perf", CHART]);
    engine.declareArtifact("artifact#2", "chart", [
      "perf",
      { x: { field: "round" }, y: { field: "OTHER" } },
    ]);
    expect((await failure(engine)).code).toBe("ArtifactRedeclared");
  });

  it("fails the run on a malformed spec, with a message naming what is wrong", async () => {
    const { engine } = setup();
    engine.declareArtifact("artifact#1", "chart", ["perf", { x: { field: "" }, y: CHART.y }]);
    const error = await failure(engine);
    expect(error.code).toBe("ArtifactSpecInvalid");
    expect(error.message).toContain("x.field");
  });

  it("validates each kind against its own required fields", async () => {
    const cases: Array<[Parameters<WorkflowEngine["declareArtifact"]>[1], unknown]> = [
      ["chart", { x: { field: "r" } }],
      ["table", { columns: [] }],
      ["metrics", { metrics: "not a list" }],
      ["board", { key: "id", status: "s", columns: [] }],
    ];
    for (const [op, spec] of cases) {
      const { engine } = setup();
      engine.declareArtifact("artifact#1", op, ["x", spec]);
      expect((await failure(engine)).code).toBe("ArtifactSpecInvalid");
    }
  });

  it("validates both board titles: names the board, cardTitle names the field", async () => {
    const good = setup();
    good.engine.declareArtifact("artifact#1", "board", [
      "b",
      {
        title: "memory regression",
        key: "id",
        status: "state",
        columns: ["todo"],
        cardTitle: "name",
      },
    ]);
    expect(good.engine.status()).toBe("running");

    const bad = setup();
    bad.engine.declareArtifact("artifact#1", "board", [
      "b",
      { key: "id", status: "state", columns: ["todo"], cardTitle: "" },
    ]);
    const error = await failure(bad.engine);
    expect(error.code).toBe("ArtifactSpecInvalid");
    expect(error.message).toContain("cardTitle");
  });

  it("flags oversized titles and oversized specs as invalid", async () => {
    const long = setup();
    long.engine.declareArtifact("artifact#1", "chart", [
      "perf",
      { ...CHART, title: "x".repeat(ARTIFACT_CAPS.maxTitleLength + 1) },
    ]);
    expect((await failure(long.engine)).code).toBe("ArtifactSpecInvalid");

    const big = setup();
    big.engine.declareArtifact("artifact#1", "table", [
      "rows",
      { columns: [{ field: "n", label: "y".repeat(ARTIFACT_CAPS.maxSpecSerializedBytes + 1) }] },
    ]);
    expect((await failure(big.engine)).code).toBe("ArtifactSpecInvalid");
  });

  it("fails the run when predeclared and content share an id (no rejection channel in that family)", async () => {
    const { engine } = setup();
    await engine.publishArtifact("artifact#1", "markdown", ["x", "hi"]);
    engine.declareArtifact("artifact#2", "chart", ["x", CHART]);
    expect((await failure(engine)).code).toBe("ArtifactKindMismatch");
  });

  it("fails the run on the 33rd id", async () => {
    const { engine } = setup();
    for (let i = 1; i <= ARTIFACT_CAPS.maxArtifactsPerRun; i++) {
      engine.declareArtifact(`artifact#${i}`, "chart", [`c${i}`, CHART]);
    }
    engine.declareArtifact("artifact#33", "chart", ["overflow", CHART]);
    expect((await failure(engine)).code).toBe("ArtifactCapExceeded");
  });

  it("skips silently on replay hits", () => {
    const journal = new InMemoryJournalStore();
    const first = setup({ journal });
    first.engine.declareArtifact("artifact#1", "chart", ["perf", CHART]);
    first.engine.complete(undefined);

    const resumed = setup({ journal });
    resumed.engine.declareArtifact("artifact#1", "chart", ["perf", CHART]);
    expect(published(resumed.driver)).toEqual([]);
    expect(
      journal
        .listNodes(RUN, { kinds: "all", withResult: true })
        .filter((n) => n.kind === "artifact"),
    ).toHaveLength(1);
  });

  it("still knows the id was declared after resume (idempotency and tagging rely on it)", async () => {
    const journal = new InMemoryJournalStore();
    const first = setup({ journal });
    first.engine.declareArtifact("artifact#1", "chart", ["perf", CHART]);
    first.engine.complete(undefined);

    const resumed = setup({ journal });
    resumed.engine.report("report#1", { round: 1 }, "perf");
    expect(resumed.driver.eventsOfType("report")[0]?.artifactId).toBe("perf");
    expect(resumed.engine.status()).toBe("running");
  });
});

describe("report artifact tags", () => {
  it("lands the tag on the node row and the event", () => {
    const { engine, driver, journal } = setup();
    engine.declareArtifact("artifact#1", "chart", ["perf", CHART]);
    engine.report("report#1", { round: 1, ms: 12 }, "perf");

    expect(journal.getNode(RUN, "report#1", 1)?.artifactId).toBe("perf");
    const event = driver.eventsOfType("report")[0];
    expect(event?.artifactId).toBe("perf");
    expect(event?.item).toEqual({ round: 1, ms: 12 });
  });

  it("grows no artifactId key on untagged reports", () => {
    const { engine, driver, journal } = setup();
    engine.report("report#1", { a: 1 });
    expect(journal.getNode(RUN, "report#1", 1)?.artifactId).toBeUndefined();
    expect(driver.eventsOfType("report")[0]?.artifactId).toBeUndefined();
  });

  it("fails the run when a tag names an undeclared id, listing declared ones", async () => {
    const { engine } = setup();
    engine.declareArtifact("artifact#1", "chart", ["perf", CHART]);
    engine.report("report#1", { a: 1 }, "nope");
    const error = await failure(engine);
    expect(error.code).toBe("ArtifactUndeclared");
    expect(error.message).toContain("perf");
  });

  it("raises ArtifactUndeclared for content ids too (they are not predeclared)", async () => {
    const { engine } = setup();
    await engine.publishArtifact("artifact#1", "markdown", ["doc", "hi"]);
    engine.report("report#1", { a: 1 }, "doc");
    expect((await failure(engine)).code).toBe("ArtifactUndeclared");
  });

  it("keeps tags out of inputHash, so untagged journal rows still hit", () => {
    const journal = new InMemoryJournalStore();
    const first = setup({ journal });
    first.engine.report("report#1", { a: 1 });
    first.engine.complete(undefined);

    const resumed = setup({ journal });
    resumed.engine.report("report#1", { a: 1 });
    expect(resumed.driver.eventsOfType("report")).toEqual([]);
    expect(resumed.engine.status()).toBe("running");
  });
});
