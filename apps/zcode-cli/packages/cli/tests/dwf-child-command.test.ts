/**
 * Dispatch and execution of the hidden `__zcode-dwf-child` subcommand.
 *
 * Bug root cause (docs/dynamic-workflow/launch.md, "Single-executable builds"): the SEA single-file binary does not interpret Node
 * CLI flags; the harness default `node --max-old-space-size=... <entry>` hands the flags to strict
 * parseArgs and the child exits instantly -- every dwf run failed under SEA. The fix mirrors the official plugin host:
 * re-exec this binary and dispatch before parseArgs.
 *
 * After the 2026-09-09 change, the last argv item is the entry file path (the payload no longer rides the command line). Two things are pinned:
 *   1. dispatch happens before parseArgs -- any form reaching parseArgs errors on the path as an unknown argument;
 *   2. the child really runs: the subcommand imports the entry file, injects real vm/readline/stdio, calls its `start`,
 *      and writes NDJSON to stdout. The entry file is rendered by the same harness `renderChildEntry` as in production.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { ZCODE_DWF_CHILD_COMMAND } from "@zcode/contracts";
import { renderChildEntry } from "@zcode/dynamic-workflow-runtime";
import type { RunContext } from "@zcode/shared-types";
import { isDwfChildInvocation } from "../src/dwf-child-command.js";
import { run } from "../src/run.js";

const createCapturedStdout = () => {
  let output = "";
  return {
    output: () => output,
    stream: {
      isTTY: false,
      write: (chunk: string | Uint8Array): boolean => {
        output += typeof chunk === "string" ? chunk : chunk.toString();
        return true;
      },
    } as unknown as NodeJS.WriteStream,
  };
};

/**
 * A child-context RunContext: stdin must be a real Readable (childMain builds readline from it;
 * the `{ isTTY: false }` fake stdin in cli.unit.test.ts makes readline throw).
 * Here it is an immediately-EOF empty stream: this case's script issues no ask, so the parent has no response to feed.
 */
const createChildContext = (
  argv: string[],
): { ctx: RunContext; stdout: () => string; stderr: () => string } => {
  const stdout = createCapturedStdout();
  const stderr = createCapturedStdout();
  return {
    ctx: {
      argv,
      stderr: stderr.stream,
      stdin: Readable.from([]) as unknown as NodeJS.ReadStream,
      stdout: stdout.stream,
    },
    stdout: stdout.output,
    stderr: stderr.output,
  };
};

/**
 * Writes an entry file with the production renderer. Deliberately not via engine/compiler: under test is the CLI-boundary contract
 * (the trailing argv path plus the entry's `start` export), not the workflow compilation pipeline.
 * No `maxOldSpaceSizeMb`: with the flag missing from `execArgv`, the entry best-effort sets a heap cap for this very process,
 * and the test process must not be touched by it.
 */
const writeEntry = async (
  lowered: string,
): Promise<{ path: string; dispose: () => Promise<void> }> => {
  const root = await mkdtemp(join(tmpdir(), "dwf-child-cmd-"));
  const path = join(root, "run.mjs");
  await writeFile(path, renderChildEntry({ lowered }, { runId: "run" }), "utf8");
  return { path, dispose: () => rm(root, { force: true, recursive: true }) };
};

test("recognises the dwf child subcommand only as argv[0]", () => {
  assert.equal(isDwfChildInvocation([ZCODE_DWF_CHILD_COMMAND, "/tmp/run.mjs"]), true);
  assert.equal(isDwfChildInvocation([ZCODE_DWF_CHILD_COMMAND]), true);
  assert.equal(isDwfChildInvocation([]), false);
  assert.equal(isDwfChildInvocation(["--help"]), false);
  // Occurrences elsewhere do not count: a plain prompt mentioning the word must not change CLI behavior.
  assert.equal(isDwfChildInvocation(["-p", ZCODE_DWF_CHILD_COMMAND]), false);
});

test("runs the sandbox child from the entry file and writes the NDJSON completion to stdout", async () => {
  const entry = await writeEntry('__host.log("from the sandbox");\nreturn { ok: 42 };');
  try {
    const { ctx, stdout, stderr } = createChildContext([ZCODE_DWF_CHILD_COMMAND, entry.path]);

    const exitCode = await run(ctx);

    assert.equal(exitCode, 0);
    assert.equal(stderr(), "");
    const lines = stdout()
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
    assert.deepEqual(lines, [
      { kind: "event", type: "log", message: "from the sandbox" },
      { kind: "complete", ok: true, value: { ok: 42 } },
    ]);
  } finally {
    await entry.dispose();
  }
});

test("reports a lowered-body syntax error as an error completion, not a crash", async () => {
  const entry = await writeEntry("this is not javascript(");
  try {
    const { ctx, stdout, stderr } = createChildContext([ZCODE_DWF_CHILD_COMMAND, entry.path]);

    const exitCode = await run(ctx);

    assert.equal(exitCode, 0);
    assert.equal(stderr(), "");
    const message = JSON.parse(stdout().trim());
    assert.equal(message.kind, "complete");
    assert.equal(message.ok, false);
    assert.equal(message.error.name, "SyntaxError");
  } finally {
    await entry.dispose();
  }
});

test("fails with usage when the entry path argument is missing", async () => {
  const { ctx, stdout, stderr } = createChildContext([ZCODE_DWF_CHILD_COMMAND]);

  const exitCode = await run(ctx);

  assert.equal(exitCode, 1);
  // stdout is the parent's NDJSON channel; wiring errors go to stderr only.
  assert.equal(stdout(), "");
  assert.match(stderr(), new RegExp(`Usage: ${ZCODE_DWF_CHILD_COMMAND}`));
});

test("fails on stderr when the entry file does not exist", async () => {
  const { ctx, stdout, stderr } = createChildContext([
    ZCODE_DWF_CHILD_COMMAND,
    join(tmpdir(), "dwf-child-cmd-missing", "nope.mjs"),
  ]);

  const exitCode = await run(ctx);

  assert.equal(exitCode, 1);
  assert.equal(stdout(), "");
  assert.match(stderr(), /Workflow child failed: /);
});
