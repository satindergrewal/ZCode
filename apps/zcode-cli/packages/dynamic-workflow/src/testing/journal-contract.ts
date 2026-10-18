/**
 * The JournalStorePort contract suite: write once, run many times. Stage one runs it against the
 * in-memory implementation, stage two reuses it against the SQLite implementation. The
 * implementation under test is injected as a `() => JournalStorePort` factory; coverage spans the
 * write/read semantics and isolation of runs / actors / nodes / events.
 *
 * Why it lives in src/ (not tests/): the SQLite implementation is in @zcode/adapters and must
 * import this same suite via the `@zcode/dynamic-workflow/testing` subpath. vitest remains a
 * devDependency — this file runs only inside the consumer's test process, never on a runtime
 * path.
 *
 * The cases live in per-topic sibling modules (journal-contract-runs / -script / -nodes /
 * -artifacts / -events / -isolation / -reads.ts, shared fixtures in journal-contract-helpers.ts;
 * split reason: the oxlint max-lines cap of 400 lines). This file keeps only the entry point: the
 * same describe registers each group in the pre-split order, so the suite's grouping and order
 * stay verbatim-identical.
 */

import { describe } from "vitest";
import type { JournalStorePort } from "../engine/index.js";
import { registerRunCases } from "./journal-contract-runs.js";
import { registerScriptCases } from "./journal-contract-script.js";
import { registerNodeCases } from "./journal-contract-nodes.js";
import { registerArtifactCases } from "./journal-contract-artifacts.js";
import { registerEventCases } from "./journal-contract-events.js";
import { registerIsolationCases } from "./journal-contract-isolation.js";
import { registerReadCases } from "./journal-contract-reads.js";

export function runJournalStoreContract(factory: () => JournalStorePort): void {
  describe("JournalStorePort contract", () => {
    registerRunCases(factory);
    registerScriptCases(factory);
    registerNodeCases(factory);
    registerArtifactCases(factory);
    registerEventCases(factory);
    registerIsolationCases(factory);
    registerReadCases(factory);
  });
}
