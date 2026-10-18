/**
 * Contract cases for `updateRunScript`
 * (docs/execution-engine.md "Holes" -> "The engine's part"): it is the **second writer** of the
 * `script_text` / `script_hash` columns after `createRun` — one fill writes the effective script
 * back onto the run row, and resume checks the row's hash against the row's text, so both columns
 * must land in one stroke; everything else on the row (status, usage, caps, settlement bag,
 * metadata) is outside this write's scope, same family as `updateRunUsage`.
 *
 * A separate module rather than an append to journal-contract-runs.ts: that file already sits at
 * the oxlint max-lines cap. Only `it(...)` is registered here, no extra describe — the suite's
 * grouping and case order are owned by journal-contract.ts.
 */

import { expect, it } from "vitest";
import type { JournalStorePort } from "../engine/index.js";
import { baseRun } from "./journal-contract-helpers.js";

export function registerScriptCases(factory: () => JournalStorePort): void {
  it("rewrites the script text and hash together and leaves the rest of the row untouched", () => {
    const store = factory();
    store.createRun({
      ...baseRun("r1"),
      scriptText: "original",
      scriptHash: "h0",
      name: "nightly",
      args: { depth: 2 },
      toolCallId: "call-1",
      resumedFrom: "r0",
      cwd: "/repo",
    });
    store.updateRunUsage("r1", 4200);
    store.updateRunCaps("r1", { maxConcurrency: 2 });

    store.updateRunScript("r1", "effective", "h1");

    const run = store.getRun("r1");
    expect(run?.scriptText).toBe("effective");
    expect(run?.scriptHash).toBe("h1");
    expect(run?.status).toBe("running");
    expect(run?.spentTokens).toBe(4200);
    expect(run?.caps).toEqual({ maxConcurrency: 2 });
    expect(run?.name).toBe("nightly");
    expect(run?.args).toEqual({ depth: 2 });
    expect(run?.toolCallId).toBe("call-1");
    expect(run?.resumedFrom).toBe("r0");
    expect(run?.cwd).toBe("/repo");
    expect(run?.failure).toBeUndefined();
  });

  it("fills the script columns of a run created without them", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunScript("r1", "effective", "h1");
    expect(store.getRun("r1")).toMatchObject({ scriptText: "effective", scriptHash: "h1" });
  });

  it("keeps the rewritten script across a status settlement and across a resume flip", () => {
    const store = factory();
    store.createRun({ ...baseRun("r1"), scriptText: "original", scriptHash: "h0" });
    store.updateRunScript("r1", "effective", "h1");
    store.updateRunStatus("r1", "stopped", { stopReason: "user" });
    expect(store.getRun("r1")).toMatchObject({
      status: "stopped",
      scriptText: "effective",
      scriptHash: "h1",
    });
    store.updateRunStatus("r1", "running");
    expect(store.getRun("r1")).toMatchObject({
      status: "running",
      scriptText: "effective",
      scriptHash: "h1",
    });
  });

  it("takes the last write when the script is rewritten twice (a second fill)", () => {
    const store = factory();
    store.createRun({ ...baseRun("r1"), scriptText: "original", scriptHash: "h0" });
    store.updateRunScript("r1", "first fill", "h1");
    store.updateRunScript("r1", "second fill", "h2");
    expect(store.getRun("r1")).toMatchObject({ scriptText: "second fill", scriptHash: "h2" });
  });

  it("writes only the named run", () => {
    const store = factory();
    store.createRun({ ...baseRun("r1"), scriptText: "one", scriptHash: "h-one" });
    store.createRun({ ...baseRun("r2"), scriptText: "two", scriptHash: "h-two" });
    store.updateRunScript("r1", "one'", "h-one'");
    expect(store.getRun("r2")).toMatchObject({ scriptText: "two", scriptHash: "h-two" });
  });

  it("throws when rewriting the script of an unknown run", () => {
    const store = factory();
    expect(() => store.updateRunScript("nope", "x", "h")).toThrow();
  });
}
