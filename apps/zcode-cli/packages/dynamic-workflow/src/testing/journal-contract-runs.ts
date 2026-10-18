/**
 * Split out because journal-contract.ts hit the oxlint max-lines cap (400 lines): the run-record
 * cases (create run / settlement bag / metadata columns / usage) live here. The public surface
 * is still exported from journal-contract.ts (`runJournalStoreContract` calls each topic's
 * registration function in the original order).
 *
 * Note: only `it(...)` is registered here, no extra describe — the suite's grouping and case
 * order must stay verbatim-identical to the pre-split layout.
 */

import { expect, it } from "vitest";
import type { JournalStorePort } from "../engine/index.js";
import { baseRun } from "./journal-contract-helpers.js";

export function registerRunCases(factory: () => JournalStorePort): void {
  it("creates and reads back a run record", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    expect(store.getRun("r1")).toMatchObject({ runId: "r1", status: "running", spentTokens: 0 });
    expect(store.getRun("missing")).toBeUndefined();
  });

  it("rejects duplicate run creation loudly", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    expect(() => store.createRun(baseRun("r1"))).toThrow();
  });

  it("updates run status and failure", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "errored", {
      failure: { code: "ReportCapExceeded", message: "cap" },
    });
    const run = store.getRun("r1");
    expect(run?.status).toBe("errored");
    expect(run?.failure).toEqual({ code: "ReportCapExceeded", message: "cap" });
    expect(run?.stopReason).toBeUndefined();
  });

  // The three terminal states (docs/execution-engine.md): stopped is written in one stroke
  // together with its stopReason; provider / interrupted carry a failure, user / model do not.
  // Both implementations must read back identical field for field — SQLite's physical columns
  // keep the legacy words (cancelled + failure_json envelope); decoding them is that side's
  // own business.
  it("settles a stopped run with its reason and a ProviderStop failure", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const failure = {
      code: "ProviderStop" as const,
      message: "Sign-in to BigModel expired.",
      providerStop: {
        kind: "auth" as const,
        reason: "auth_failed",
        providerId: "account:bigmodel-coding-plan",
        modelId: "GLM-5.3",
        providerCode: "1006",
        subagent: "verify@2",
        phase: "Verify",
        rawMessage: "[1006] token expired",
      },
    };
    store.updateRunStatus("r1", "stopped", { stopReason: "provider", failure });
    const run = store.getRun("r1");
    expect(run?.status).toBe("stopped");
    expect(run?.stopReason).toBe("provider");
    expect(run?.failure).toEqual(failure);
    expect(run?.result).toBeUndefined();
  });

  it("settles a stopped run without a failure and reads the reason back", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "stopped", { stopReason: "model" });
    const run = store.getRun("r1");
    expect(run?.status).toBe("stopped");
    expect(run?.stopReason).toBe("model");
    expect(run?.failure).toBeUndefined();
  });

  it("settles an interrupted run with its Interrupted failure", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "stopped", {
      stopReason: "interrupted",
      failure: { code: "Interrupted", message: "owner process exited" },
    });
    const run = store.getRun("r1");
    expect(run?.status).toBe("stopped");
    expect(run?.stopReason).toBe("interrupted");
    expect(run?.failure?.code).toBe("Interrupted");
  });

  // Why the settlement bag exists: terminal state and artifact must land in one stroke. Two
  // strokes open a crash window and mint a "completed but artifact unrecoverable" run.
  it("settles a completed run together with its artifact", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "completed", { result: { answer: 42, notes: ["a", "b"] } });
    const run = store.getRun("r1");
    expect(run?.status).toBe("completed");
    expect(run?.result).toEqual({ answer: 42, notes: ["a", "b"] });
    expect(run?.failure).toBeUndefined();
  });

  // The artifact is the script's top-level return value — any JSON value, not just records.
  it.each([
    ["a string artifact", "plain text answer"],
    ["an array artifact", [1, "two", { three: true }]],
    ["a number artifact", 7],
    ["a boolean artifact", false],
    // null is a legal artifact and must come back as null, not collapse into "no result".
    ["a null artifact", null],
  ])("round-trips %s", (_label, artifact) => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "completed", { result: artifact });
    const run = store.getRun("r1");
    expect(run?.status).toBe("completed");
    expect("result" in (run ?? {})).toBe(true);
    expect(run?.result).toEqual(artifact);
  });

  it("leaves result absent for an errored settlement", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "errored", { failure: { code: "DriverError", message: "boom" } });
    const run = store.getRun("r1");
    expect(run?.status).toBe("errored");
    expect(run?.failure).toEqual({ code: "DriverError", message: "boom" });
    expect(run?.result).toBeUndefined();
  });

  // Absent settlement bag = "do not touch failure or result". Covers both the engine's own
  // `running` write and rows persisted before 0020.
  it("leaves result absent when no settlement bag is passed", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "completed");
    expect(store.getRun("r1")!.result).toBeUndefined();
    expect(store.getRun("r1")?.status).toBe("completed");
  });

  // Storage side of rule three
  // (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md "Engine ownership").
  // Bug root cause (2026-09-04): the second desktop instance's orphan reconcile wrote a
  // terminal failure onto a run whose engine was still alive in this process, and the engine
  // then completed normally — while the old "absent = untouched" semantics (SQLite's coalesce)
  // left the foreign failure in place, so the row claimed both "completed" and "interrupted".
  // The failure triple is therefore **rewritten wholesale**; the artifact is left alone.
  it("clears a stale failure when a later settlement completes the run", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "stopped", {
      stopReason: "interrupted",
      failure: { code: "Interrupted", message: "foreign reconcile" },
    });
    store.updateRunStatus("r1", "completed", { result: { done: true } });
    const run = store.getRun("r1");
    expect(run?.status).toBe("completed");
    expect(run?.failure).toBeUndefined();
    expect(run?.stopReason).toBeUndefined();
    expect(run?.result).toEqual({ done: true });
  });

  it("clears an errored failure when a later settlement completes the run", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "errored", { failure: { code: "DriverError", message: "boom" } });
    store.updateRunStatus("r1", "completed", { result: { done: true } });
    const run = store.getRun("r1");
    expect(run?.status).toBe("completed");
    expect(run?.failure).toBeUndefined();
    expect(run?.result).toEqual({ done: true });
  });

  it("keeps an already-settled artifact when a later write omits it", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "completed", { result: { kept: true } });
    store.updateRunStatus("r1", "completed");
    expect(store.getRun("r1")!.result).toEqual({ kept: true });
  });

  // A predecessor stopped by amend: `superseded` lands in the same stroke as the successor id
  // and reads back inside the same envelope
  // (docs/execution-engine.md "Amend-resume"). Missing the one value in the sniff allowlist,
  // the envelope fails to decode as a whole and the row degrades to user.
  it("round-trips stopped(superseded) together with supersededBy", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "stopped", { stopReason: "superseded", supersededBy: "r2" });
    const run = store.getRun("r1");
    expect(run?.status).toBe("stopped");
    expect(run?.stopReason).toBe("superseded");
    expect(run?.supersededBy).toBe("r2");
    expect(run?.failure).toBeUndefined();
    // The other reasons carry no successor pointer.
    store.createRun(baseRun("r3"));
    store.updateRunStatus("r3", "stopped", { stopReason: "model" });
    expect(store.getRun("r3")?.supersededBy).toBeUndefined();
  });

  // Resume semantics: flipping a run back to a non-terminal status must also clear the previous
  // generation's settlement leftovers. The engine's resume branch writes
  // `updateRunStatus(runId, "running")` (no settlement bag), and under "absent key = untouched"
  // terminal semantics, a run that orphan reconcile marked failed+Interrupted would come back
  // from resume with stale failure_json coexisting with running — the journal snapshot read
  // face would report "running" and "failed" at once. So a non-terminal write **clears**; it
  // does not preserve.
  it("clears failure and stopReason when flipping a stopped run back to a non-terminal status", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "stopped", {
      stopReason: "interrupted",
      failure: { code: "Interrupted", message: "killed" },
    });
    store.updateRunStatus("r1", "running");
    const run = store.getRun("r1");
    expect(run?.status).toBe("running");
    expect(run?.failure).toBeUndefined();
    expect(run?.stopReason).toBeUndefined();
    expect(run?.supersededBy).toBeUndefined();
  });

  it("clears result when flipping a completed run back to a non-terminal status", () => {
    // A completed run is not in the resumable set, but the port's semantics are defined by
    // status class, not caller preference: non-terminal = no settlement. Carving exceptions
    // into the semantics would leak gate knowledge into the storage layer.
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "completed", { result: { stale: true } });
    store.updateRunStatus("r1", "pending");
    const run = store.getRun("r1");
    expect(run?.status).toBe("pending");
    expect(run?.result).toBeUndefined();
  });

  it("ignores a settlement bag on a non-terminal write (cleared, not stored)", () => {
    // A settlement bag on a non-terminal write is a contradictory request from the caller: a
    // "running" run has no settlement. The semantics are clear-on-write, so the two
    // implementations do not each invent their own reading of the contradiction.
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunStatus("r1", "running", { failure: { code: "DriverError", message: "x" } });
    expect(store.getRun("r1")?.failure).toBeUndefined();
  });

  // createRun must honor this field too: the in-memory implementation clones the record whole,
  // so if SQLite skips the column, one record stored through both implementations and read
  // back diverges. The engine only creates runs as running, but the port's semantics should
  // not have that hole.
  it("creates and reads back a run carrying an artifact", () => {
    const store = factory();
    store.createRun({ ...baseRun("r1"), status: "completed", result: { seeded: true } });
    expect(store.getRun("r1")!.result).toEqual({ seeded: true });
  });

  // name is the run's display label (`input.name` -> createRun -> dwf_run.name), the same
  // metadata path as scriptText/cwd. Both implementations have createRun/getRun, so it is
  // contract: should SQLite skip the column, one record stored through both and read back
  // diverges (verbatim the argument that once fixed the result column).
  it("round-trips a run name and keeps it absent when unnamed", () => {
    const store = factory();
    store.createRun({ ...baseRun("named"), name: "nightly triage" });
    store.createRun(baseRun("unnamed"));

    expect(store.getRun("named")?.name).toBe("nightly triage");
    const unnamed = store.getRun("unnamed");
    expect(unnamed?.name).toBeUndefined();
    // An absent optional field must come back absent, not become name: null / name: undefined.
    expect(unnamed !== undefined && "name" in unnamed).toBe(false);
  });

  // The args (`dwf_run.args_json`, migration 0026) ride the same createRun metadata path as
  // scriptText / name, with an even harder contract case: resume **replays** the stored args,
  // so if SQLite skips the column, the resumed run silently runs a whole pass with `{}` —
  // "approved A, resumed B".
  it("round-trips the run args and keeps them absent when the run had none", () => {
    const store = factory();
    store.createRun({
      ...baseRun("with-args"),
      args: { target: "packages/core", depth: 3, nested: { deep: true } },
    });
    store.createRun(baseRun("no-args"));

    expect(store.getRun("with-args")?.args).toEqual({
      target: "packages/core",
      depth: 3,
      nested: { deep: true },
    });
    const bare = store.getRun("no-args");
    // An absent optional field comes back absent (pre-0026 rows take exactly this path): at
    // the record level "no args" and "empty args bag" stay distinguishable, so the sandbox
    // side can uniformly read absence as `{}`.
    expect(bare?.args).toBeUndefined();
    expect(bare !== undefined && "args" in bare).toBe(false);
  });

  it("keeps the run args across a status settlement", () => {
    const store = factory();
    store.createRun({ ...baseRun("r-args"), args: { keep: "me" } });
    store.updateRunStatus("r-args", "completed", { result: "done" });
    // Resume can read it back because the settlement UPDATE does not touch this column.
    expect(store.getRun("r-args")?.args).toEqual({ keep: "me" });
  });

  // Settlement touches status and artifact only: name is not in updateRunStatus's write
  // surface (were the SQLite UPDATE to include the name column, settling would drop it).
  it("keeps the run name across a status settlement", () => {
    const store = factory();
    store.createRun({ ...baseRun("r1"), name: "keeps its name" });
    store.updateRunStatus("r1", "completed", { result: "done" });
    expect(store.getRun("r1")?.name).toBe("keeps its name");
  });

  // toolCallId is the id of the CreateWorkflow tool call that started the run — the persistent
  // anchor joining the tool card across a restart and on resume
  // (docs/execution-engine.md). It rides the same createRun metadata path as
  // scriptText/cwd and is contract: should SQLite skip the column, the post-restart discovery
  // query loses the correlation key.
  it("round-trips the originating toolCallId and keeps it absent when not given", () => {
    const store = factory();
    store.createRun({ ...baseRun("anchored"), toolCallId: "call-42" });
    store.createRun(baseRun("bare"));

    expect(store.getRun("anchored")?.toolCallId).toBe("call-42");
    const bare = store.getRun("bare");
    expect(bare?.toolCallId).toBeUndefined();
    // An absent optional field must come back absent, not become toolCallId: null / undefined.
    expect(bare !== undefined && "toolCallId" in bare).toBe(false);
  });

  // Settlement touches status and artifact only: toolCallId is not in updateRunStatus's write
  // surface.
  it("keeps the toolCallId across a status settlement and across a resume flip", () => {
    const store = factory();
    store.createRun({ ...baseRun("r1"), toolCallId: "call-7" });
    store.updateRunStatus("r1", "stopped", { stopReason: "user" });
    expect(store.getRun("r1")?.toolCallId).toBe("call-7");
    // The resume flip back to running clears the settlement; the anchor must survive as is.
    store.updateRunStatus("r1", "running");
    expect(store.getRun("r1")?.toolCallId).toBe("call-7");
  });

  // resumedFrom is the amend-resume lineage pointer (which predecessor run this run amends,
  // docs/execution-engine.md). Same createRun metadata path as toolCallId / args; the contract
  // case is that it is a **survival dependency**: after a amended run crashes, plain resume
  // rebuilds the ImportedCache by reading this pointer back — should SQLite skip the column,
  // the resumed run downgrades every unconsumed cache entry to a live re-run.
  it("round-trips the resumedFrom lineage pointer and keeps it absent for a fresh run", () => {
    const store = factory();
    store.createRun({ ...baseRun("amended"), resumedFrom: "run-predecessor" });
    store.createRun(baseRun("fresh"));

    expect(store.getRun("amended")?.resumedFrom).toBe("run-predecessor");
    const fresh = store.getRun("fresh");
    expect(fresh?.resumedFrom).toBeUndefined();
    // An absent optional field must come back absent (NULL decodes to an absent key, not
    // null / undefined) — most runs are not amendments; this is the common path.
    expect(fresh !== undefined && "resumedFrom" in fresh).toBe(false);
  });

  // Neither settlement nor the resume flip touches the lineage write surface: a chain of
  // amendments walks this pointer back through ancestors of any depth, and one link losing
  // the pointer at settlement breaks the chain right there.
  it("keeps resumedFrom across a status settlement and across a resume flip", () => {
    const store = factory();
    store.createRun({ ...baseRun("r1"), resumedFrom: "run-a" });
    store.updateRunStatus("r1", "stopped", { stopReason: "user" });
    expect(store.getRun("r1")?.resumedFrom).toBe("run-a");
    store.updateRunStatus("r1", "running");
    expect(store.getRun("r1")?.resumedFrom).toBe("run-a");
  });

  it("isolates a stored artifact from later mutation of the caller's object", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    const artifact = { nested: { value: 1 } };
    store.updateRunStatus("r1", "completed", { result: artifact });
    artifact.nested.value = 999;
    // r1 was createRun'd two lines up, so getRun must hit; a non-null assertion instead of ?.
    // keeps the following .nested.value chain from reading as unsafe optional chaining in lint
    // (?., short-circuiting to undefined, would throw right there).
    expect((store.getRun("r1")!.result as { nested: { value: number } }).nested.value).toBe(1);
  });

  it("settles an artifact and a failure independently on separate runs", () => {
    const store = factory();
    store.createRun(baseRun("ok"));
    store.createRun(baseRun("bad"));
    store.updateRunStatus("ok", "completed", { result: "done" });
    store.updateRunStatus("bad", "errored", {
      failure: { code: "DriverError", message: "stop" },
    });
    expect(store.getRun("ok")?.result).toBe("done");
    expect(store.getRun("ok")?.failure).toBeUndefined();
    expect(store.getRun("bad")?.result).toBeUndefined();
    expect(store.getRun("bad")?.failure?.code).toBe("DriverError");
  });

  it("throws when updating an unknown run", () => {
    const store = factory();
    expect(() => store.updateRunStatus("nope", "completed")).toThrow();
  });

  it("persists accumulated usage without disturbing status or failure", () => {
    // Usage is a write path independent of run settlement: every askStats accumulation must
    // land, or resume starts over from zero tokens (the stage-1.5 latent bug).
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunUsage("r1", 4200);
    expect(store.getRun("r1")).toMatchObject({ spentTokens: 4200, status: "running" });
    expect(store.getRun("r1")?.failure).toBeUndefined();

    // Writing usage onto an already-settled (failure included) run must not rewrite status or
    // failure.
    store.updateRunStatus("r1", "errored", {
      failure: { code: "DriverError", message: "over" },
    });
    store.updateRunUsage("r1", 5100);
    const run = store.getRun("r1");
    expect(run?.spentTokens).toBe(5100);
    expect(run?.status).toBe("errored");
    expect(run?.failure).toEqual({ code: "DriverError", message: "over" });
  });

  it("throws when updating the usage of an unknown run", () => {
    const store = factory();
    expect(() => store.updateRunUsage("nope", 1)).toThrow();
  });

  // The **second writer** of `caps_max_concurrency`
  // (docs/dynamic-workflow/concurrency.md "Two bounds on a run"): an amend that changes only
  // `max_concurrency` applies in place to the live run, while resume keeps the caps stored in
  // the row — not persisted, the restored run would keep the old bound. Same narrow-write
  // family as usage: touch this column only; status / usage / settlement bag untouched.
  it("retunes the concurrency cap without disturbing status, usage or failure", () => {
    const store = factory();
    store.createRun(baseRun("r1"));
    store.updateRunUsage("r1", 4200);
    store.updateRunCaps("r1", { maxConcurrency: 2 });
    expect(store.getRun("r1")).toMatchObject({
      caps: { maxConcurrency: 2 },
      spentTokens: 4200,
      status: "running",
    });

    // Writing caps onto an already-settled (failure included) run must not rewrite status or
    // failure.
    store.updateRunStatus("r1", "errored", {
      failure: { code: "DriverError", message: "over" },
    });
    store.updateRunCaps("r1", { maxConcurrency: 7 });
    const run = store.getRun("r1");
    expect(run?.caps).toEqual({ maxConcurrency: 7 });
    expect(run?.status).toBe("errored");
    expect(run?.failure).toEqual({ code: "DriverError", message: "over" });
  });

  it("throws when retuning the caps of an unknown run", () => {
    const store = factory();
    expect(() => store.updateRunCaps("nope", { maxConcurrency: 1 })).toThrow();
  });
}
