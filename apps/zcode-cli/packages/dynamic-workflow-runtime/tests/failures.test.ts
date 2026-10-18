/**
 * Failure paths: errors are first-class. Wall-clock timeouts, aborts, script throws, and corrupt child NDJSON must all
 * normalize to clear settlements, never swallowed. See "How the bridge settles the run" in docs/execution-engine.md
 * and apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md: script faults -> errored; host-side faults (timeout / crash /
 * protocol corruption) -> stopped(interrupted); abort -> stopped(user | model).
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryJournalStore,
  WorkflowError,
  type Caps,
  type RunSettlement,
} from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "../src/index.js";
import { AutoDriver } from "./auto-driver.js";
import { TEST_CWD } from "./helpers.js";

interface LoweredOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
  caps?: Caps;
}

async function runLowered(
  lowered: string,
  opts: LoweredOpts = {},
): Promise<{ settlement: RunSettlement; journal: InMemoryJournalStore }> {
  const journal = new InMemoryJournalStore();
  // HANG's ask is never answered: the empty action list makes the driver no-op, leaving the request in flight.
  const driver = new AutoDriver(journal, { asks: { "ask#1": () => [] } });
  const settlement = await runWorkflowScript({
    cwd: TEST_CWD,
    lowered,
    runId: "run",
    caps: opts.caps ?? { maxConcurrency: 4 },
    askSpecs: new Map([["ask#1", { typed: false }]]),
    validate: () => [],
    makeDriver: (sink) => {
      driver.attach(sink);
      return driver;
    },
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });
  return { settlement, journal };
}

/**
 * A never-settling sandbox body (for timeout / abort): an ask the driver never answers -- the only legal
 * form of a living-but-idle run. A bare never-settling promise is now a stall: the cell ends the run with ScriptStalled
 * (tests/streams.test.ts) before any timeout or abort could.
 */
const HANG = 'await __host.ask("ask#1", __host.createActor("actor#1", "waiter"), "wait forever");';

type Stopped = { status: "stopped"; reason: string; error?: WorkflowError };
type Errored = { status: "errored"; error: WorkflowError };

describe("failures — wall-clock timeout", () => {
  it("kills the child and stops the run as interrupted with a clear timeout error", async () => {
    const { settlement, journal } = await runLowered(HANG, { timeoutMs: 400 });
    expect(settlement.status).toBe("stopped");
    const stopped = settlement as Stopped;
    expect(stopped.reason).toBe("interrupted");
    expect(stopped.error).toBeInstanceOf(WorkflowError);
    expect(stopped.error?.code).toBe("Interrupted");
    expect(stopped.error?.message).toContain("wall-clock timeout of 400ms");
    // The engine's verdict journals: stopped(interrupted) + failure_json (resumable), never disguised as a user cancel.
    const run = journal.getRun("run");
    expect(run?.status).toBe("stopped");
    expect(run?.stopReason).toBe("interrupted");
    expect(run?.failure?.code).toBe("Interrupted");
  });
});

describe("failures — abort signal", () => {
  it("kills the child and settles stopped(user)", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const { settlement, journal } = await runLowered(HANG, { signal: controller.signal });
    expect(settlement).toEqual({ status: "stopped", reason: "user" });
    // Abort is the only true cancel: journal stopped(user) (resumable), no failure attached.
    expect(journal.getRun("run")).toMatchObject({ status: "stopped", stopReason: "user" });
    expect(journal.getRun("run")?.failure).toBeUndefined();
  });

  it('reads the initiator off the abort reason: "model" settles stopped(model)', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort("model"), 200);
    const { settlement, journal } = await runLowered(HANG, { signal: controller.signal });
    expect(settlement).toEqual({ status: "stopped", reason: "model" });
    expect(journal.getRun("run")?.stopReason).toBe("model");
  });

  it("reads `{ superseded }` off the abort reason: settles stopped(superseded) with the successor", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort({ superseded: "run-next" }), 200);
    const { settlement, journal } = await runLowered(HANG, { signal: controller.signal });
    expect(settlement).toEqual({
      status: "stopped",
      reason: "superseded",
      supersededBy: "run-next",
    });
    // Successor id and reason recorded in one write (docs/execution-engine.md, "Amend-resume").
    expect(journal.getRun("run")).toMatchObject({
      status: "stopped",
      stopReason: "superseded",
      supersededBy: "run-next",
    });
    expect(journal.getRun("run")?.failure).toBeUndefined();
  });

  // The host App stopping runs it owns on close (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md, "Engine ownership", rule two):
  // the run service's close() aborts every in-flight entry with "interrupted", normalized into the same family as timeouts and
  // sandbox crashes: stopped(interrupted) + Interrupted -- not stopped(user), which reads as user-pressed-stop in the UI.
  it('reads "interrupted" off the abort reason: settles stopped(interrupted) with an Interrupted failure', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort("interrupted"), 200);
    const { settlement, journal } = await runLowered(HANG, { signal: controller.signal });
    expect(settlement.status).toBe("stopped");
    const stopped = settlement as Stopped;
    expect(stopped.reason).toBe("interrupted");
    expect(stopped.error).toBeInstanceOf(WorkflowError);
    expect(stopped.error?.code).toBe("Interrupted");
    // The text names run and cause; the detail page uses it to explain the row on next open.
    expect(stopped.error?.message).toContain("run run was interrupted");
    expect(stopped.error?.message).toContain("the owning session closed");
    // The engine's own write: resumable stopped(interrupted) + failure_json.
    expect(journal.getRun("run")).toMatchObject({
      status: "stopped",
      stopReason: "interrupted",
    });
    expect(journal.getRun("run")?.failure?.code).toBe("Interrupted");
  });

  it("settles stopped(user) immediately when the signal is already aborted", async () => {
    const { settlement } = await runLowered(HANG, { signal: AbortSignal.abort() });
    expect(settlement).toEqual({ status: "stopped", reason: "user" });
  });
});

describe("failures — script error", () => {
  it("surfaces the script's thrown error as an errored run", async () => {
    const { settlement, journal } = await runLowered('throw new Error("boom from the script");');
    expect(settlement.status).toBe("errored");
    const error = (settlement as Errored).error;
    expect(error.code).toBe("DriverError");
    expect(error.message).toContain("boom from the script");
    expect(journal.getRun("run")?.status).toBe("errored");
    expect(journal.getRun("run")?.stopReason).toBeUndefined();
  });
});

describe("failures — malformed NDJSON from child", () => {
  it("surfaces a garbage line as interrupted rather than swallowing it", async () => {
    // Inside the sandbox, __send emits one non-JSON line over the transport, simulating corrupt child output.
    const { settlement, journal } = await runLowered(
      'globalThis.__send("this is not json"); await new Promise(() => {});',
    );
    expect(settlement.status).toBe("stopped");
    const stopped = settlement as Stopped;
    expect(stopped.reason).toBe("interrupted");
    expect(stopped.error?.code).toBe("Interrupted");
    expect(stopped.error?.message).toContain("NDJSON");
    // The engine's verdict lands in the journal.
    expect(journal.getRun("run")).toMatchObject({ status: "stopped", stopReason: "interrupted" });
    expect(journal.getRun("run")?.failure?.code).toBe("Interrupted");
  });
});
