/**
 * Usage events: the driver reports stats per ask settlement; the engine accumulates run-level spentTokens and emits `usage-updated`.
 * The event carries the spent total directly (docs/dynamic-workflow/authoring.md, "Usage, not budget"); the child protocol carries no
 * budget snapshot, and the script facade has no budget global (invariants 3/4).
 */

import { describe, expect, it } from "vitest";
import { runScript } from "./helpers.js";

describe("usage-updated — accumulated spentTokens", () => {
  it("emits the running total after each stats-carrying ask", async () => {
    const script = [
      'const a = agent("a");',
      'const r1 = await a.ask("first");',
      'const r2 = await a.ask("second");',
      "return { r1, r2 };",
    ].join("\n");

    const { settlement, driver, journal } = await runScript(script, {
      caps: { maxConcurrency: 16 },
      asks: {
        "ask#1": () => ({
          type: "text",
          finalText: "r1",
          stats: { tokens: 100, toolCalls: 0, turns: 1 },
        }),
        "ask#2": () => ({
          type: "text",
          finalText: "r2",
          stats: { tokens: 50, toolCalls: 0, turns: 1 },
        }),
      },
    });

    expect(settlement).toEqual({ status: "completed", artifact: { r1: "r1", r2: "r2" } });
    expect(driver.eventsOfType("usage-updated")).toEqual([
      { type: "usage-updated", spentTokens: 100 },
      { type: "usage-updated", spentTokens: 150 },
    ]);
    expect(journal.getRun("run")?.spentTokens).toBe(150);
  });

  it("rejects a script that reads budget at compile time (TS2304, not a runtime surprise)", async () => {
    await expect(
      runScript("return budget.remainingTokens();", { caps: { maxConcurrency: 16 }, asks: {} }),
    ).rejects.toThrow("Cannot find name 'budget'");
  });
});
