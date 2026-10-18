/**
 * Run args reach the sandbox through the real entry path: runWorkflowScript -> ChildPayload -> vm context.
 *
 * Four joints along it can silently break (options -> payload, payload -> sandbox global, the BOOTSTRAP
 * __host.args, lowering's args -> __host.args), and every breakage looks alike: the script reads
 * undefined or ReferenceErrors outright -- hence a real child here, not a stub.
 *
 * The other half (args into dwf_run.args_json, resume reading it back for replay) is guarded by run-metadata assertions and
 * bootstrap's resume tests, one end each.
 */

import { describe, expect, it } from "vitest";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "../src/index.js";
import { AutoDriver } from "./auto-driver.js";
import { askSpecsFor, TEST_CWD } from "./helpers.js";

const RUN = "run";

function baseOptions(scriptText: string, journal: InMemoryJournalStore) {
  const driver = new AutoDriver(journal, {});
  return {
    scriptText,
    cwd: TEST_CWD,
    runId: RUN,
    caps: { maxConcurrency: 16 },
    askSpecs: askSpecsFor(scriptText),
    validate: () => [],
    makeDriver: (sink: Parameters<typeof driver.attach>[0]) => {
      driver.attach(sink);
      return driver;
    },
    timeoutMs: 20000,
  };
}

describe("args in the sandbox", () => {
  it("delivers the validated bag to the script", async () => {
    const journal = new InMemoryJournalStore();
    const script = "return [String(args.target), Number(args.depth), args.deep];";

    const settlement = await runWorkflowScript({
      cwd: TEST_CWD,
      ...baseOptions(script, journal),
      args: { target: "packages/core", depth: 3, deep: { nested: true } },
    });

    expect(settlement).toEqual({
      status: "completed",
      artifact: ["packages/core", 3, { nested: true }],
    });
  });

  // Invariant 7: args is always defined. An inline run reading args.x must be a legal property read,
  // not a ReferenceError -- exactly what the encode-absent-payload-as-{} line guards.
  it("is an empty object, never undefined, for a run with no arguments", async () => {
    const journal = new InMemoryJournalStore();
    const script = "return [typeof args, Object.keys(args).length, args.missing === undefined];";

    const settlement = await runWorkflowScript(baseOptions(script, journal));

    expect(settlement).toEqual({ status: "completed", artifact: ["object", 0, true] });
  });

  it("journals the args alongside the rest of the run metadata", async () => {
    const journal = new InMemoryJournalStore();

    await runWorkflowScript({
      cwd: TEST_CWD,
      ...baseOptions("return String(args.who);", journal),
      args: { who: "ada" },
    });

    // This is what resume reads: a run's identity includes its args (invariant 6).
    expect(journal.getRun(RUN)?.args).toEqual({ who: "ada" });
  });

  it("leaves args off the run record entirely when the run had none", async () => {
    const journal = new InMemoryJournalStore();
    await runWorkflowScript(baseOptions("return 1;", journal));
    // An absent key, not {}: the record keeps no-args and empty-args distinguishable.
    expect(journal.getRun(RUN)?.args).toBeUndefined();
  });

  // The freeze is shallow (child-source's comment owns that boundary): top-level reassignment fails silently under
  // non-strict lowered bodies) or throws, while nested objects stay mutable. This pins the top-level half and that
  // changes do not tunnel back to the host -- the host's arg bag must survive the script untouched.
  it("freezes the top level of the bag", async () => {
    const journal = new InMemoryJournalStore();
    const script = [
      "const frozen = Object.isFrozen(args);",
      "let threw = false;",
      "try { (args as Record<string, unknown>).injected = 1; } catch { threw = true; }",
      "return [frozen, threw || args.injected === undefined];",
    ].join("\n");

    const settlement = await runWorkflowScript({
      cwd: TEST_CWD,
      ...baseOptions(script, journal),
      args: { original: 1 },
    });

    expect(settlement).toEqual({ status: "completed", artifact: [true, true] });
    // The host-side bag left untouched by the script.
    expect(journal.getRun(RUN)?.args).toEqual({ original: 1 });
  });
});
