/**
 * Hidden subcommand __zcode-dwf-child <entry path>: the dynamic-workflow sandbox child entry.
 *
 * Reason to exist: a SEA single-file binary **does not interpret Node CLI flags** -- the flags in the harness's default
 * node --max-old-space-size=... <entry> would land verbatim in the CLI's strict parseArgs, and the child would
 * error out at once, failing every workflow run under SEA. The fix mirrors the official plugin host
 * (plugin-host-command.ts): under SEA bootstrap has the harness re-exec this binary with this subcommand,
 * and run.ts dispatches here before parseArgs.
 *
 * The payload no longer travels on argv (the Windows command-line
 * limit is 32,767 chars): the harness writes a self-contained entry file <cwd>/.zcode/workflow-runs/<runId>.mjs and the last argv
 * item is just its path. The entry file carries childMain and the payload; this module only import()s it and injects the CLI process's
 * vm/readline/stdio into its exported start -- hence this module **no longer depends on @zcode/dynamic-workflow-runtime**.
 * The best-effort v8.setFlagsFromString heap cap moved into the entry file with the payload.
 */

import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createContext, runInContext } from "node:vm";
import { ZCODE_DWF_CHILD_COMMAND } from "@zcode/contracts";
import type { RunContext } from "@zcode/shared-types";

export function isDwfChildInvocation(argv: readonly string[]): boolean {
  return argv[0] === ZCODE_DWF_CHILD_COMMAND;
}

/** Entry-file export surface (produced by child-source.ts's renderChildEntry). */
interface ChildEntryModule {
  start?: (deps: {
    vm: { createContext: typeof createContext; runInContext: typeof runInContext };
    createInterface: typeof createInterface;
    stdin: NodeJS.ReadableStream;
    stdout: { write(chunk: string): unknown };
  }) => Promise<void>;
}

/**
 * Runs the sandbox child until the script terminates. argv is the remainder after the subcommand name, with the **last** item the entry file path.
 *
 * Must await termination before returning: after run() returns, the CLI entry arms a 1s exit watchdog
 * (shutdown.ts's scheduleCliExitWatchdog); returning early lets the watchdog force-exit the child as the run barely starts.
 */
export async function runDwfChildCommand(ctx: RunContext, argv: string[]): Promise<number> {
  const entryPath = argv[argv.length - 1];
  if (argv.length === 0 || entryPath === undefined) {
    ctx.stderr.write(`Usage: ${ZCODE_DWF_CHILD_COMMAND} <entry path>\n`);
    return 1;
  }

  try {
    // Dynamic import of an on-disk ESM (same pattern as plugin-host-command.ts loading plugin entries). The entry file
    // decides itself that it is not the process entry (argv[1] is the subcommand, not it), does not self-start, and is started via start here.
    const entry = (await import(pathToFileURL(resolve(entryPath)).href)) as ChildEntryModule;
    if (typeof entry.start !== "function") {
      throw new Error(`workflow entry file exports no start(): ${entryPath}`);
    }
    await entry.start({
      vm: { createContext, runInContext },
      createInterface,
      stdin: ctx.stdin,
      stdout: ctx.stdout,
    });
    return 0;
  } catch (error) {
    // stdout is the parent's NDJSON channel; diagnostics go to stderr only -- the harness attributes
    // exited-without-finishing failures precisely via the child's stderr (child.on close in harness.ts).
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Workflow child failed: ${message}\n`);
    return 1;
  }
}
