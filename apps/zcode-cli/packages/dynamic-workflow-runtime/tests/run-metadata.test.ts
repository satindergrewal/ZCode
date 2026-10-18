/**
 * Run metadata is recorded through the real entry path: runWorkflowScript -> engine construction -> createRun.
 *
 * The direct new WorkflowEngine unit tests (in the dynamic-workflow package) prove only that the engine writes these fields;
 * This proves the harness really hands them down -- a dropped field shows up as a forever-empty dwf_run column,
 * leaving resume's script_hash check without a comparison object.
 *
 * The harness deliberately does not compute scriptHash: the compile-once path passes `lowered` (the harness
 * never sees the original text); hashing whatever text it has would record the lowered body's hash on that path --
 * a silently wrong comparison basis. Hashing belongs to the caller.
 */

import { describe, expect, it } from "vitest";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "../src/index.js";
import { AutoDriver } from "./auto-driver.js";
import { askSpecsFor, TEST_CWD } from "./helpers.js";

const RUN = "run";

const SCRIPT = ['const a = agent("a");', 'const r = await a.ask("hello");', "return r;"].join("\n");

describe("run metadata through the real entry point", () => {
  it("forwards scriptText / scriptHash / parentSessionId / cwd / toolCallId onto the journaled run record", async () => {
    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal, {
      asks: { "ask#1": () => ({ type: "text", finalText: "hi" }) },
    });

    const settlement = await runWorkflowScript({
      scriptText: SCRIPT,
      runId: RUN,
      caps: { maxConcurrency: 16 },
      askSpecs: askSpecsFor(SCRIPT),
      validate: () => [],
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
      timeoutMs: 20000,
      // Caller-supplied metadata: verbatim into EngineConfig, untouched by the harness.
      scriptHash: "caller-computed-hash",
      parentSessionId: "sess_parent",
      cwd: TEST_CWD,
      toolCallId: "call-origin",
    });

    expect(settlement).toEqual({ status: "completed", artifact: "hi" });
    const run = journal.getRun(RUN);
    expect(run).toMatchObject({
      runId: RUN,
      status: "completed",
      // scriptText records the caller's original script, not the lowered body.
      scriptText: SCRIPT,
      scriptHash: "caller-computed-hash",
      parentSessionId: "sess_parent",
      cwd: TEST_CWD,
      // The only persisted anchor for post-restart tool-card join / resume notifications (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md).
      toolCallId: "call-origin",
    });
  });

  it("carries the run's subagent model on the journaled run-launched event, reasoning segment included", async () => {
    // The subagent model lives zero-SQL inside run-launched (docs/dynamic-workflow/launch.md), riding with the launch anchor and
    // phase table: the harness forwards the whole launch block verbatim, neither reading nor parsing it.
    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal, {
      asks: { "ask#1": () => ({ type: "text", finalText: "hi" }) },
    });

    await runWorkflowScript({
      scriptText: SCRIPT,
      runId: RUN,
      cwd: TEST_CWD,
      caps: { maxConcurrency: 16 },
      askSpecs: askSpecsFor(SCRIPT),
      validate: () => [],
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
      timeoutMs: 20000,
      launch: { inputId: "input-origin", subagentModel: "zhipu/glm-5.3-flash$high" },
    });

    const launched = journal
      .listEvents(RUN, { types: "all", reportItems: "all" })
      .find((stored) => stored.event.type === "run-launched");
    expect(launched?.event).toEqual({
      type: "run-launched",
      inputId: "input-origin",
      // The level segment rides along: $high is part of the choice; the host reads the full string from this event.
      subagentModel: "zhipu/glm-5.3-flash$high",
    });
    // The row carries no such fact: it is not a dwf_run column (user ruling: no migration).
    expect("subagentModel" in journal.getRun(RUN)!).toBe(false);
  });

  it("omits subagentModel entirely when launch carries none", async () => {
    // Absent means the subagent ran on the session model. A undefined-valued key would make readers parse unset as
    // set-to-empty -- different meanings in AmendWorkflow's three states.
    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal, {
      asks: { "ask#1": () => ({ type: "text", finalText: "hi" }) },
    });

    await runWorkflowScript({
      scriptText: SCRIPT,
      runId: RUN,
      cwd: TEST_CWD,
      caps: { maxConcurrency: 16 },
      askSpecs: askSpecsFor(SCRIPT),
      validate: () => [],
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
      timeoutMs: 20000,
      launch: { inputId: "input-origin" },
    });

    const launched = journal
      .listEvents(RUN, { types: "all", reportItems: "all" })
      .find((stored) => stored.event.type === "run-launched");
    expect("subagentModel" in launched!.event).toBe(false);
  });

  it("journals the authored scriptText, not the lowered body, when both are given", async () => {
    // The compile-once shape: the caller compiles lowered itself and hands down the author's text. The record must be
    // the original -- the two texts differ deliberately, so a lowered-for-original swap fails this assertion.
    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal, {});

    const settlement = await runWorkflowScript({
      cwd: TEST_CWD,
      lowered: "return 7;",
      runId: RUN,
      caps: { maxConcurrency: 16 },
      askSpecs: new Map(),
      validate: () => [],
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
      timeoutMs: 20000,
      scriptText: "return 3 + 4; // authored",
      scriptHash: "hash-of-source",
    });

    expect(settlement).toEqual({ status: "completed", artifact: 7 });
    expect(journal.getRun(RUN)).toMatchObject({
      scriptText: "return 3 + 4; // authored",
      scriptHash: "hash-of-source",
    });
  });

  it("forwards the run name onto the journaled run record", async () => {
    // name rides the same metadata path as scriptText/cwd. A dropped name means dwf_run.name
    // stays empty forever and host enumeration degenerates to bare runIds (run-introspection labels gone).
    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal, {});

    await runWorkflowScript({
      cwd: TEST_CWD,
      lowered: "return 1;",
      runId: RUN,
      caps: { maxConcurrency: 16 },
      askSpecs: new Map(),
      validate: () => [],
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
      timeoutMs: 20000,
      name: "nightly triage",
    });

    expect(journal.getRun(RUN)).toMatchObject({ name: "nightly triage" });
  });

  it("omits the metadata entirely when the caller passes none", async () => {
    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal, {});

    await runWorkflowScript({
      cwd: TEST_CWD,
      lowered: "return 1;",
      runId: RUN,
      caps: { maxConcurrency: 16 },
      askSpecs: new Map(),
      validate: () => [],
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
      timeoutMs: 20000,
    });

    const run = journal.getRun(RUN)!;
    for (const field of ["scriptText", "scriptHash", "parentSessionId", "name"]) {
      expect(field in run).toBe(false);
    }
  });

  it("rejects a resume whose scriptHash does not match the journaled one", async () => {
    // Proves end-to-end that the check now has a comparison object: the first pass records the hash, the second is rejected on a different one.
    const journal = new InMemoryJournalStore();
    const driver = new AutoDriver(journal, {
      asks: { "ask#1": () => ({ type: "text", finalText: "hi" }) },
    });
    const base = {
      runId: RUN,
      caps: { maxConcurrency: 16 },
      askSpecs: askSpecsFor(SCRIPT),
      validate: () => [],
      timeoutMs: 20000,
    } as const;

    await runWorkflowScript({
      cwd: TEST_CWD,
      ...base,
      scriptText: SCRIPT,
      scriptHash: "hash-v1",
      makeDriver: (sink) => {
        driver.attach(sink);
        return driver;
      },
    });
    expect(journal.getRun(RUN)?.scriptHash).toBe("hash-v1");

    const resumed = new AutoDriver(journal, {});
    await expect(
      runWorkflowScript({
        cwd: TEST_CWD,
        ...base,
        scriptText: `${SCRIPT}\n// edited`,
        scriptHash: "hash-v2",
        makeDriver: (sink) => {
          resumed.attach(sink);
          return resumed;
        },
      }),
    ).rejects.toMatchObject({
      code: "ScriptHashMismatch",
      mismatch: { expected: "hash-v1", got: "hash-v2" },
    });

    // A rejected resume must not rewrite existing records (the hash-v1 script stays resumable).
    expect(journal.getRun(RUN)).toMatchObject({ status: "completed", scriptHash: "hash-v1" });
  });
});
