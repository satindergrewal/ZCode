/**
 * Split out because journal-contract.ts hit the oxlint max-lines cap (400 lines): the
 * storage-boundary isolation and per-runId scoping closing cases live here. The public surface
 * is still exported from journal-contract.ts (`runJournalStoreContract` calls each topic's
 * registration function in the original order).
 *
 * Note: only `it(...)` is registered here, no extra describe — the suite's grouping and case
 * order must stay verbatim-identical to the pre-split layout.
 */

import { expect, it } from "vitest";
import type { JournalStorePort, NodeRecord } from "../engine/index.js";
import { baseRun } from "./journal-contract-helpers.js";

export function registerIsolationCases(factory: () => JournalStorePort): void {
  it("isolates stored records from later mutation of the caller's object", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const node: NodeRecord = {
      runId: "r1",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      inputHash: "abc",
      status: "completed",
      result: { nested: { value: 1 } },
    };
    store.putNode(node);
    // Mutating the caller's object must not touch the stored record (storage-boundary isolation).
    (node.result as { nested: { value: number } }).nested.value = 999;
    const stored = store.getNode("r1", "ask#1", 1);
    expect(stored).toBeDefined();
    const result = stored!.result as { nested: { value: number } };
    expect(result.nested.value).toBe(1);
  });

  it("scopes records per runId", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.createRun(baseRun("r2"));
    store.putNode({
      runId: "r1",
      siteId: "ask#1",
      ordinal: 1,
      kind: "ask",
      inputHash: "h",
      status: "completed",
    });
    expect(store.listNodes("r1", { kinds: "all", withResult: true })).toHaveLength(1);
    expect(store.listNodes("r2", { kinds: "all", withResult: true })).toHaveLength(0);
    expect(store.getNode("r2", "ask#1", 1)).toBeUndefined();
  });
}
