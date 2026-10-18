/**
 * The sandbox child's spawn-strategy contract (RunWorkflowOptions.childSpawn).
 *
 * After the 2026-09-09 change (docs/dynamic-workflow/launch.md), the payload no longer rides the command line: the harness
 * writes the entry to <cwd>/.zcode/workflow-runs/<runId>.mjs and argv carries only the path.
 *   - Default: `node --max-old-space-size=... <entry>` (no --input-type / --eval);
 *   - SEA (root cause in the same spec, "SEA subcommand"): the single-file binary does not interpret Node CLI flags,
 *     so the caller (bootstrap, SEA only) may switch to childSpawn.argsPrefix:
 *     execPath [...argsPrefix, <entry>], zero flags.
 *
 * Both assertion directions are required:
 *   - the default branch's argv shape (flags, entry path, ELECTRON_RUN_AS_NODE) is pinned, or the SEA fix would
 *     quietly regress the desktop Electron helper fix;
 *   - the argsPrefix branch must really run a run to completion -- asserting argv shape only proves string assembly,
 *     not that the child's import-entry-and-call-start shape holds. A SEA-CLI stand-in script
 *     (exactly what dwf-child-command.ts does) drives the real path.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { spawn as spawnType } from "node:child_process";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "../src/index.js";
import { AutoDriver } from "./auto-driver.js";
import { askSpecsFor } from "./helpers.js";

// Wraps the real spawn: only args/options intercepted; the child starts normally -- bridging and settlement stay real.
const spawnCalls: Array<{ args: readonly string[]; options: Record<string, unknown> }> = [];
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const wrapped: typeof spawnType = ((...args: Parameters<typeof spawnType>) => {
    spawnCalls.push({
      args: (args[1] ?? []) as readonly string[],
      options: (args[2] ?? {}) as Record<string, unknown>,
    });
    return actual.spawn(...args);
  }) as typeof spawnType;
  return { ...actual, spawn: wrapped };
});

const SCRIPT = ['const a = agent("a");', 'const r = await a.ask("hello");', "return r;"].join("\n");

const roots: string[] = [];

afterEach(async () => {
  spawnCalls.length = 0;
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Runs one real ask (AutoDriver replies "hi"); returns the settlement and the run cwd. */
async function runOnce(extra: Partial<Parameters<typeof runWorkflowScript>[0]> = {}) {
  const cwd = await tempRoot("dwf-spawn-args-cwd-");
  const journal = new InMemoryJournalStore();
  const driver = new AutoDriver(journal, {
    asks: { "ask#1": () => ({ type: "text", finalText: "hi" }) },
  });
  const settlement = await runWorkflowScript({
    scriptText: SCRIPT,
    runId: "run",
    cwd,
    caps: { maxConcurrency: 16 },
    askSpecs: askSpecsFor(SCRIPT),
    validate: () => [],
    makeDriver: (sink) => {
      driver.attach(sink);
      return driver;
    },
    timeoutMs: 20000,
    ...extra,
  });
  return { settlement, cwd };
}

/** Extracts the embedded payload from the entry text (no import -- importing would run its top-level logic in the test process). */
async function readEntryPayload(entryPath: string): Promise<Record<string, unknown>> {
  const text = await readFile(entryPath, "utf8");
  const match = /^export const payload = (.*);$/m.exec(text);
  expect(match).not.toBeNull();
  return JSON.parse(match![1]!) as Record<string, unknown>;
}

/**
 * Writes a SEA CLI stand-in: the minimal dwf-child-command.ts -- import the entry, inject real
 * deps, call start. Crucially it accepts no Node flags, only the trailing argv path -- exactly the SEA binary's behavior.
 */
async function writeSeaCliStandIn(): Promise<string> {
  const root = await tempRoot("dwf-sea-standin-");
  const scriptPath = join(root, "sea-cli-stand-in.mjs");
  await writeFile(
    scriptPath,
    `import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createContext, runInContext } from "node:vm";

// Strictly mimics the SEA binary: any token beyond the trailing entry path is an error.
if (process.argv.length !== 3) {
  process.stderr.write("sea-cli-stand-in: unexpected argv " + JSON.stringify(process.argv.slice(2)) + "\\n");
  process.exit(1);
}

const entry = await import(pathToFileURL(process.argv[2]).href);
await entry.start({
  vm: { createContext, runInContext },
  createInterface,
  stdin: process.stdin,
  stdout: process.stdout,
});
`,
    "utf8",
  );
  return scriptPath;
}

describe("sandbox child spawn strategy", () => {
  it("spawns only the heap flag and the entry path when childSpawn is absent", async () => {
    const { settlement, cwd } = await runOnce();

    expect(settlement).toEqual({ status: "completed", artifact: "hi" });
    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0]!.args;

    // The command line carries flags and path only -- no payload, no child source (Windows' 32,767-char cap).
    expect(args).toEqual([
      "--max-old-space-size=256",
      join(cwd, ".zcode", "workflow-runs", "run.mjs"),
    ]);
    await expect(readEntryPayload(args[1]!)).resolves.toMatchObject({
      lowered: expect.any(String),
    });
    expect(spawnCalls[0]!.options.env).toMatchObject({ ELECTRON_RUN_AS_NODE: "1" });
    expect(spawnCalls[0]!.options.cwd).toBe(cwd);
  });

  it("keeps host-only run metadata out of the child payload (launch stays host-side)", async () => {
    // Only args cross -- the sandbox script reads them. Every other run metadata (lineage pointer, tool-call id, parent session,
    // display name, and the whole launch block: origin anchor and subagent models) is host-side fact. Baking them into the entry
    // would add a never-read copy of run-level fact that also persists in the project's
    // .zcode dir. launch.subagentModel doubly so: the model surface is entirely host-side (the child only
    // bridges asks back); the child knowing its model is useless, with no code path reading it.
    //
    // All five are really forwarded, or not-in-payload is an empty claim.
    const { settlement, cwd } = await runOnce({
      launch: { inputId: "input-origin", subagentModel: "zhipu/glm-5.3-flash$high" },
      resumedFrom: "run-predecessor",
      toolCallId: "call-origin",
      parentSessionId: "sess_parent",
      name: "nightly triage",
      args: { topic: "release" },
    });

    expect(settlement).toEqual({ status: "completed", artifact: "hi" });
    const payload = await readEntryPayload(join(cwd, ".zcode", "workflow-runs", "run.mjs"));
    // The one that crosses is still there: this assertion stops all-nothing from hiding behind an empty payload.
    expect(payload.args).toEqual({ topic: "release" });
    for (const field of ["launch", "resumedFrom", "toolCallId", "parentSessionId", "name"]) {
      expect(field in payload).toBe(false);
    }
  });

  it("maps maxOldSpaceSizeMb onto the node flag on the default path", async () => {
    await runOnce({ maxOldSpaceSizeMb: 512 });

    expect(spawnCalls[0]!.args[0]).toBe("--max-old-space-size=512");
  });

  it("spawns argsPrefix + entry path with zero node flags, and the run still settles", async () => {
    const standIn = await writeSeaCliStandIn();

    const { settlement, cwd } = await runOnce({ childSpawn: { argsPrefix: [standIn] } });

    // The real path completing is this branch's claim: argv assembled right, and the child's import-entry-call-start shape holds.
    expect(settlement).toEqual({ status: "completed", artifact: "hi" });
    expect(spawnCalls).toHaveLength(1);
    const args = spawnCalls[0]!.args;
    expect(args).toEqual([standIn, join(cwd, ".zcode", "workflow-runs", "run.mjs")]);
    // Not one flag may leak -- the SEA binary exits on unknown arguments.
    expect(args.some((arg) => arg.startsWith("--"))).toBe(false);
    // The heap cap can only ride the payload (no flags on the argsPrefix path), applied best-effort by the entry file.
    await expect(readEntryPayload(args[1]!)).resolves.toMatchObject({ maxOldSpaceSizeMb: 256 });
    // The existing Electron helper fix holds on both branches.
    expect(spawnCalls[0]!.options.env).toMatchObject({ ELECTRON_RUN_AS_NODE: "1" });
  });

  it("forwards every argsPrefix token in order, entry path last", async () => {
    const standIn = await writeSeaCliStandIn();

    // The stand-in accepts exactly argv.length === 3, so one extra token makes it fail loudly -- proving
    // prefix-passthrough with the entry last is no accident.
    const { settlement } = await runOnce({
      childSpawn: { argsPrefix: [standIn, "__zcode-dwf-child"] },
      timeoutMs: 20000,
    });

    // Nonzero child exit with no complete: host-side fault, stopped(interrupted).
    expect(settlement).toMatchObject({ status: "stopped", reason: "interrupted" });
    expect(spawnCalls[0]!.args).toEqual([
      standIn,
      "__zcode-dwf-child",
      expect.stringMatching(/run\.mjs$/),
    ]);
  });
});
