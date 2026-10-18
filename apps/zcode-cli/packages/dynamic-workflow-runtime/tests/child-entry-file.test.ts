/**
 * The sandbox entry file's on-disk contract (docs/dynamic-workflow/launch.md, "Single-executable builds").
 *
 * Bug root cause: the harness used to base64 the whole lowered body onto the child command line; Windows caps those at
 * 32,767 chars, so past ~18KB every spawn is ENAMETOOLONG -- no longer run starting on Windows.
 * Secondary defect: such spawn failures throw synchronously in Node, bypassing the engine and leaving journal rows running forever.
 *
 * Four things pinned:
 *   1. the entry lands at <cwd>/.zcode/workflow-runs/<runId>.mjs with a .gitignore beside it, surviving settlement;
 *   2. regression guard: command-line length stays flat no matter the script size (200KB lowered body included);
 *   3. unwritable project .zcode -> tmpdir fallback + onWarning, run proceeds;
 *   4. a synchronous spawn throw -> engine-settled failed, journal status failed, not running.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { spawn as spawnType } from "node:child_process";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";
import {
  childEntryFileName,
  fallbackWorkflowRunsDir,
  runWorkflowScript,
  workflowRunsDir,
  writeChildEntryFile,
  type HarnessWarning,
} from "../src/index.js";
import { AutoDriver } from "./auto-driver.js";

// Wraps the real spawn: args intercepted, child starts normally; spawnOverride replaces it when set (the sync-throw case).
const spawnCalls: Array<{ args: readonly string[] }> = [];
let spawnOverride:
  | ((...args: Parameters<typeof spawnType>) => ReturnType<typeof spawnType>)
  | undefined;
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const wrapped: typeof spawnType = ((...args: Parameters<typeof spawnType>) => {
    spawnCalls.push({ args: (args[1] ?? []) as readonly string[] });
    if (spawnOverride !== undefined) return spawnOverride(...args);
    return actual.spawn(...args);
  }) as typeof spawnType;
  return { ...actual, spawn: wrapped };
});

const roots: string[] = [];

afterEach(async () => {
  spawnCalls.length = 0;
  spawnOverride = undefined;
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Runs a handwritten lowered body (no ask sites); returns settlement and journal. */
async function runLowered(
  lowered: string,
  extra: Partial<Parameters<typeof runWorkflowScript>[0]> = {},
): Promise<{
  settlement: Awaited<ReturnType<typeof runWorkflowScript>>;
  journal: InMemoryJournalStore;
}> {
  const journal = new InMemoryJournalStore();
  const driver = new AutoDriver(journal);
  const settlement = await runWorkflowScript({
    lowered,
    runId: "run",
    caps: { maxConcurrency: 4 },
    askSpecs: new Map(),
    validate: () => [],
    makeDriver: (sink) => {
      driver.attach(sink);
      return driver;
    },
    timeoutMs: 20000,
    ...extra,
  });
  return { settlement, journal };
}

describe("child entry file", () => {
  it("lands under <cwd>/.zcode/workflow-runs/<runId>.mjs with a .gitignore, and stays after the run settles", async () => {
    const cwd = await tempRoot("dwf-entry-cwd-");

    const { settlement } = await runLowered("return __host.args.x;", {
      cwd,
      runId: "dwfrun-1234",
      args: { x: 7 },
    });

    expect(settlement).toEqual({ status: "completed", artifact: 7 });
    const entryPath = join(cwd, ".zcode", "workflow-runs", "dwfrun-1234.mjs");
    expect(spawnCalls[0]!.args).toEqual(["--max-old-space-size=256", entryPath]);
    // Keeping them is the ruling: the directory doubles as the archive of what actually executed per run.
    const text = await readFile(entryPath, "utf8");
    expect(text).toContain("// zcode dynamic workflow run dwfrun-1234");
    expect(text).toContain(
      'export const payload = {"lowered":"return __host.args.x;","args":{"x":7},"maxOldSpaceSizeMb":256}',
    );
    expect(text).toContain("export const start = ");
    // The harness writes exactly one `*` and never touches the project's own .gitignore.
    await expect(
      readFile(join(cwd, ".zcode", "workflow-runs", ".gitignore"), "utf8"),
    ).resolves.toBe("*\n");
  });

  it("keeps the command line short no matter how large the script is (Windows ENAMETOOLONG guard)", async () => {
    const cwd = await tempRoot("dwf-entry-big-");
    // A 200KB lowered body: far past Windows' 32,767-char command line and Linux' 128KB per-arg limit.
    const lowered = `const pad = ${JSON.stringify("x".repeat(200_000))};\nreturn pad.length;`;

    const { settlement } = await runLowered(lowered, { cwd });

    expect(settlement).toEqual({ status: "completed", artifact: 200_000 });
    const argvChars = spawnCalls[0]!.args.reduce((sum, arg) => sum + arg.length, 0);
    expect(argvChars).toBeLessThan(1_000);
    expect(spawnCalls[0]!.args.every((arg) => arg.length < 32_767)).toBe(true);
  });

  it("falls back to os.tmpdir() and warns when the project .zcode cannot be created", async () => {
    const cwd = await tempRoot("dwf-entry-fallback-");
    // .zcode as a plain file: mkdir fails with ENOTDIR/EEXIST -- one real unwritable-project shape.
    await writeFile(join(cwd, ".zcode"), "not a directory", "utf8");
    const warnings: HarnessWarning[] = [];

    const { settlement } = await runLowered("return 1;", {
      cwd,
      runId: "dwfrun-fallback",
      onWarning: (warning) => warnings.push(warning),
    });

    expect(settlement).toEqual({ status: "completed", artifact: 1 });
    const expectedPath = join(fallbackWorkflowRunsDir(), "dwfrun-fallback.mjs");
    expect(spawnCalls[0]!.args[1]).toBe(expectedPath);
    await expect(stat(expectedPath)).resolves.toBeDefined();
    expect(warnings).toEqual([
      {
        kind: "entry_file_fallback",
        projectDir: join(cwd, ".zcode", "workflow-runs"),
        fallbackDir: fallbackWorkflowRunsDir(),
        error: expect.stringMatching(/ENOTDIR|EEXIST|ENOENT/),
      },
    ]);
    await rm(expectedPath, { force: true });
  });

  it("settles a synchronous spawn failure as stopped(interrupted) through the engine, so the journal row is not left running", async () => {
    const cwd = await tempRoot("dwf-entry-throw-");
    spawnOverride = () => {
      // Node throws ENAMETOOLONG/E2BIG synchronously exactly like this (only EACCES/EAGAIN/EMFILE/ENFILE/ENOENT become error events).
      const error = new Error("spawn ENAMETOOLONG") as Error & { code: string };
      error.code = "ENAMETOOLONG";
      throw error;
    };

    const { settlement, journal } = await runLowered("return 1;", { cwd });

    expect(settlement.status).toBe("stopped");
    expect(settlement.status === "stopped" ? settlement.error?.message : "").toContain(
      "spawn ENAMETOOLONG",
    );
    // Engine-settled: the row is stopped(interrupted), not a forever-running orphan (which would make AmendWorkflow
    // reject with has-not-settled-yet); host-side faults are resumable.
    expect(journal.getRun("run")).toMatchObject({ status: "stopped", stopReason: "interrupted" });
  });
});

describe("writeChildEntryFile", () => {
  it("sanitises the run id into the file name", () => {
    expect(childEntryFileName("dwfrun-1234-abcd")).toBe("dwfrun-1234-abcd.mjs");
    expect(childEntryFileName("../evil/run id")).toBe(".._evil_run_id.mjs");
  });

  it("reports where it wrote", async () => {
    const cwd = await tempRoot("dwf-entry-unit-");

    const written = writeChildEntryFile({ cwd, runId: "r1", source: "export const x = 1;\n" });

    expect(written).toEqual({ path: join(workflowRunsDir(cwd), "r1.mjs"), location: "project" });
    await expect(readFile(written.path, "utf8")).resolves.toBe("export const x = 1;\n");
  });

  it("leaves an existing .gitignore alone", async () => {
    const cwd = await tempRoot("dwf-entry-gitignore-");
    writeChildEntryFile({ cwd, runId: "r1", source: "" });
    await writeFile(join(workflowRunsDir(cwd), ".gitignore"), "custom\n", "utf8");

    writeChildEntryFile({ cwd, runId: "r2", source: "" });

    await expect(readFile(join(workflowRunsDir(cwd), ".gitignore"), "utf8")).resolves.toBe(
      "custom\n",
    );
  });
});
