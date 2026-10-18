/**
 * Split out because journal-contract.ts hit the oxlint max-lines cap (400 lines): the user-facing
 * artifact rows (kind: "artifact", the artifactId column, report tags) live here. The public
 * surface is still exported from journal-contract.ts (`runJournalStoreContract` calls each
 * topic's registration function in the original order).
 *
 * Note: only `it(...)` is registered here, no extra describe — the suite's grouping and case
 * order must stay verbatim-identical to the pre-split layout.
 */

import { expect, it } from "vitest";
import type { ArtifactVersionRecord, JournalStorePort, NodeRecord } from "../engine/index.js";
import { baseRun } from "./journal-contract-helpers.js";

export function registerArtifactCases(factory: () => JournalStorePort): void {
  // ——— User-facing artifacts (docs/dynamic-workflow/authoring.md) ———
  // Note: the artifact here is a deliverable the script publishes to the user, not
  // `RunSettlement.artifact` (the script's top-level return value). Both senses exist; see the
  // spec's terminology table.

  // Persisted shape of a successful content-member publish: `kind: "artifact"`, `result` the
  // whole ArtifactVersionRecord, `artifactId` pointing at the artifact it published. Both
  // implementations must read it back **verbatim** — `uri` is the only path to the bytes (bytes
  // never enter the journal); reworking or dropping it turns a published artifact into a card
  // that cannot open.
  it("round-trips a completed artifact node with its version record", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const record: ArtifactVersionRecord = {
      id: "book",
      kind: "file",
      version: 2,
      title: "注意力之书",
      description: "59 页 typst 排版",
      contentType: "application/pdf",
      bytes: 1_234_567,
      uri: "zcode-artifact://ses_parent/abc123",
      sourcePath: "out/book.pdf",
      publishedAt: 1_725_000_000_000,
      primary: true,
    };
    const node: NodeRecord = {
      runId: "r1",
      siteId: "artifact#1",
      ordinal: 2,
      kind: "artifact",
      inputHash: "ah",
      status: "completed",
      result: record,
      artifactId: "book",
    };
    store.putNode(node);

    const stored = store.getNode("r1", "artifact#1", 2);
    expect(stored).toEqual(node);
    expect(stored?.result).toEqual(record);
  });

  // A preset declaration's row: same kind, same artifactId column, only result holds the spec
  // instead of byte metadata. The board itself carries no data (each of its points is a tagged
  // report row), so this row is the entire record of "this board once existed".
  it("round-trips a preset declaration artifact node with its spec", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const record: ArtifactVersionRecord = {
      id: "perf",
      kind: "chart",
      version: 1,
      title: "查询延迟",
      spec: { type: "line", x: { field: "round" }, y: [{ field: "queryMsAfter" }] },
    };
    const node: NodeRecord = {
      runId: "r1",
      siteId: "artifact#2",
      ordinal: 1,
      kind: "artifact",
      inputHash: "ph",
      status: "completed",
      result: record,
      artifactId: "perf",
    };
    store.putNode(node);
    expect(store.getNode("r1", "artifact#2", 1)).toEqual(node);
  });

  // A failed publish must land **with its artifactId**: the read face has to be able to say
  // "this publish of that id did not succeed". A failed row has no result (the bytes were never
  // written); the error sits on error — the same replay-sanity requirement as persisting
  // settled failures.
  it("round-trips a failed artifact node with its error and artifact id", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const failed: NodeRecord = {
      runId: "r1",
      siteId: "artifact#1",
      ordinal: 3,
      kind: "artifact",
      inputHash: "ah3",
      status: "failed",
      error: { code: "ArtifactSourceMissing", message: "out/book.pdf 不存在" },
      artifactId: "book",
    };
    store.putNode(failed);

    const stored = store.getNode("r1", "artifact#1", 3);
    expect(stored).toEqual(failed);
    expect(stored !== undefined && "result" in stored).toBe(false);
  });

  // Content members go through the two-write "admit running -> settle" shape, while putNode is
  // a whole-row replace upsert: if the settling write stops carrying artifactId, the artifact's
  // ownership is erased and that publish vanishes from the "which artifacts does this run have"
  // read face. The engine carries it on both writes; this case pins that shape in the storage
  // layer.
  it("keeps the artifact id across the running → settled rewrite", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const running: NodeRecord = {
      runId: "r1",
      siteId: "artifact#1",
      ordinal: 1,
      kind: "artifact",
      inputHash: "ah",
      status: "running",
      artifactId: "book",
    };
    store.putNode(running);
    expect(store.getNode("r1", "artifact#1", 1)).toEqual(running);

    store.putNode({
      ...running,
      status: "completed",
      result: { id: "book", kind: "file", version: 1 } satisfies ArtifactVersionRecord,
    });
    const settled = store.getNode("r1", "artifact#1", 1)!;
    expect(settled.status).toBe("completed");
    expect(settled.artifactId).toBe("book");
  });

  // Where the "a board is a projection of the journal" invariant lands: each point of a board
  // is one row of `kind = "report"` with a matching `artifactId`. The tag must therefore live
  // on the report row for as long as the item does.
  it("round-trips the artifact tag on a report node", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const tagged: NodeRecord = {
      runId: "r1",
      siteId: "report#1",
      ordinal: 3,
      kind: "report",
      inputHash: "rh",
      status: "completed",
      result: { round: 3, queryMsAfter: 12.5 },
      artifactId: "perf",
    };
    store.putNode(tagged);
    expect(store.getNode("r1", "report#1", 3)).toEqual(tagged);
  });

  // Untagged reports, asks, world-* nodes and pre-0029 rows have no such column: it must
  // decode as an **absent key**, not a key holding undefined. Board queries filter rows by
  // "artifactId matches", so a spurious key fails the whole toEqual and also makes "no tag"
  // and "tag is undefined" indistinguishable on the read face.
  it("leaves artifactId absent on nodes that carry no artifact", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const plain: NodeRecord = {
      runId: "r1",
      siteId: "report#2",
      ordinal: 1,
      kind: "report",
      inputHash: "rh2",
      status: "completed",
      result: { finding: "untagged" },
    };
    store.putNode(plain);

    const stored = store.getNode("r1", "report#2", 1)!;
    expect("artifactId" in stored).toBe(false);
    expect(stored).toEqual(plain);
  });

  // listNodes is the query face the engine uses to recover an artifact's next version
  // ("completed rows for the id, plus one" — recovered like reportCount), so the tag must be
  // present on the enumeration face too; reading it back on getNode alone is not enough.
  it("returns artifactId from listNodes as well as getNode", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.putNode({
      runId: "r1",
      siteId: "artifact#1",
      ordinal: 1,
      kind: "artifact",
      inputHash: "a1",
      status: "completed",
      result: { id: "book", kind: "file", version: 1 } satisfies ArtifactVersionRecord,
      artifactId: "book",
    });
    store.putNode({
      runId: "r1",
      siteId: "report#1",
      ordinal: 1,
      kind: "report",
      inputHash: "r1h",
      status: "completed",
      result: { round: 1 },
      artifactId: "perf",
    });
    store.putNode({
      runId: "r1",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      inputHash: "k1",
      status: "completed",
      result: "plain",
    });

    const nodes = store.listNodes("r1", { kinds: "all", withResult: true });
    expect(nodes.map((n) => n.artifactId)).toEqual(["book", "perf", undefined]);
    expect("artifactId" in nodes[2]!).toBe(false);
  });
}
