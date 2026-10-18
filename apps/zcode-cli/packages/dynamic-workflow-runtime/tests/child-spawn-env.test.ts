/**
 * Sandbox child spawn-env contract: must carry ELECTRON_RUN_AS_NODE=1 explicitly and inherit the parent env.
 *
 * Bug root cause (2026-08-19, desktop): the desktop agent process runs under the Electron Helper
 * (process.execPath points at the Helper) while the CLI sanitizes ELECTRON_RUN_AS_NODE out of its own
 * process.env at startup (shared/runtimeEnv.ts, keeping Bash/MCP children from inheriting it).
 * The harness spawned children without env -> the sanitized env propagated -> the Electron Helper never entered
 * Node mode, booted as a full Electron/Chromium app, and stalled in GPU init: the child alive but
 * silent forever, the run stuck at run-started (no node/actor rows, no failure settlement). The fix mirrors
 * official-plugin-runtime.ts: spawn env carries ELECTRON_RUN_AS_NODE=1 explicitly
 * (inert under plain Node, no side effects).
 *
 * Both assertions are required: asserting only the flag misses the wrong fix that reduces env to the flag, dropping PATH and other inherited entries;
 * asserting only inheritance misses the flag itself.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { spawn as spawnType } from "node:child_process";
import { runWorkflowScript } from "../src/index.js";
import { AutoDriver } from "./auto-driver.js";
import { askSpecsFor, TEST_CWD } from "./helpers.js";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";

// Wraps the real spawn: only options are intercepted; the child starts normally -- bridging and settlement stay real.
const spawnCalls: Array<{ options: Record<string, unknown> }> = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const wrapped: typeof spawnType = ((...args: Parameters<typeof spawnType>) => {
    spawnCalls.push({ options: (args[2] ?? {}) as Record<string, unknown> });
    return actual.spawn(...args);
  }) as typeof spawnType;
  return { ...actual, spawn: wrapped };
});

const SCRIPT = ['const a = agent("a");', 'const r = await a.ask("hello");', "return r;"].join("\n");
const CANARY_KEY = "DWF_SPAWN_ENV_CANARY";

afterEach(() => {
  delete process.env[CANARY_KEY];
  spawnCalls.length = 0;
});

describe("sandbox child spawn env", () => {
  it("spawns the child with ELECTRON_RUN_AS_NODE=1 and the inherited parent env", async () => {
    process.env[CANARY_KEY] = "inherited";

    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal, {
      asks: { "ask#1": () => ({ type: "text", finalText: "hi" }) },
    });
    const settlement = await runWorkflowScript({
      cwd: TEST_CWD,
      scriptText: SCRIPT,
      runId: "run",
      caps: { maxConcurrency: 16 },
      askSpecs: askSpecsFor(SCRIPT),
      validate: () => [],
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
      timeoutMs: 20000,
    });

    // The real chain still runs to completion -- a broken env (say, a clobbered PATH) surfaces as a failed settlement here.
    expect(settlement).toEqual({ status: "completed", artifact: "hi" });

    expect(spawnCalls).toHaveLength(1);
    const env = spawnCalls[0]?.options.env as Record<string, string | undefined> | undefined;
    expect(env).toBeDefined();
    expect(env?.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env?.[CANARY_KEY]).toBe("inherited");
  });
});
