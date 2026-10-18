/**
 * Sandbox security: the vm.createContext evaluation unit's isolation contract ("The sandbox" in docs/execution-engine.md).
 * These scripts deliberately cannot pass facade typecheck (raw process/import access), so they bypass the compiler:
 * handwritten lowered bodies go straight to the harness -- the vm contract is the subject under test, legitimately.
 */

import { describe, expect, it } from "vitest";
import { InMemoryJournalStore, type RunSettlement } from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "../src/index.js";
import { AutoDriver } from "./auto-driver.js";
import { TEST_CWD } from "./helpers.js";

/** Feeds a handwritten lowered body (free identifier: __host only); returns the settlement. */
async function runLowered(lowered: string): Promise<RunSettlement> {
  const journal = new InMemoryJournalStore();
  const driver = new AutoDriver(journal);
  return runWorkflowScript({
    cwd: TEST_CWD,
    lowered,
    caps: { maxConcurrency: 4 },
    askSpecs: new Map(),
    validate: () => [],
    makeDriver: (sink) => {
      driver.attach(sink);
      return driver;
    },
    timeoutMs: 15000,
  });
}

/** Convenience: runs a body that just returns an expression, handing back the artifact. */
async function evalInSandbox(expr: string): Promise<unknown> {
  const settlement = await runLowered(`return ${expr};`);
  expect(settlement.status).toBe("completed");
  return (settlement as { status: "completed"; artifact: unknown }).artifact;
}

describe("sandbox security — Node globals are absent", () => {
  it("process / fetch / require / globalThis.process are undefined", async () => {
    expect(await evalInSandbox("typeof process")).toBe("undefined");
    expect(await evalInSandbox("typeof fetch")).toBe("undefined");
    expect(await evalInSandbox("typeof require")).toBe("undefined");
    expect(await evalInSandbox("typeof globalThis.process")).toBe("undefined");
    expect(await evalInSandbox("typeof Buffer")).toBe("undefined");
    expect(await evalInSandbox("typeof global")).toBe("undefined");
  });

  it("ES intrinsics are present (curated globals, not a stripped realm)", async () => {
    expect(await evalInSandbox("typeof JSON")).toBe("object");
    expect(await evalInSandbox("typeof Promise")).toBe("function");
    expect(await evalInSandbox("Array.isArray([1,2])")).toBe(true);
  });
});

describe("sandbox security — dynamic import throws", () => {
  it("import() rejects with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING", async () => {
    const result = await evalInSandbox(
      '(await (async () => { try { await import("node:fs"); return "NO-THROW"; } catch (e) { return String(e && (e.code || e.name)); } })())',
    );
    expect(result).toContain("ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING");
  });
});

describe("sandbox security — runtime nondeterminism bans (belt)", () => {
  it("Date.now() throws", async () => {
    expect(
      await evalInSandbox(
        '(() => { try { Date.now(); return "NO"; } catch (e) { return e.message; } })()',
      ),
    ).toContain("Date.now()");
  });

  it("argless new Date() throws; new Date(ms) is allowed", async () => {
    expect(
      await evalInSandbox(
        '(() => { try { new Date(); return "NO"; } catch (e) { return e.message; } })()',
      ),
    ).toContain("argless new Date()");
    // Argument-bearing construction still works (only the nondeterministic argless forms are banned).
    expect(await evalInSandbox("new Date(0).getTime()")).toBe(0);
  });

  it("Math.random() throws", async () => {
    expect(
      await evalInSandbox(
        '(() => { try { Math.random(); return "NO"; } catch (e) { return e.message; } })()',
      ),
    ).toContain("Math.random()");
  });
});

describe("sandbox security — eval binds to the same curated globals", () => {
  it('eval("process") sees undefined; eval("Date.now()") throws', async () => {
    // Dynamically created code binds the same curated globals: isolation is not static rewriting of the script text.
    expect(await evalInSandbox('eval("typeof process")')).toBe("undefined");
    expect(
      await evalInSandbox(
        '(() => { try { eval("Date.now()"); return "NO"; } catch (e) { return "THREW"; } })()',
      ),
    ).toBe("THREW");
  });
});
