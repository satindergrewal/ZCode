/**
 * End-to-end pipeline: real script -> lowering -> sandbox child -> engine -> AutoDriver. Asserts the final artifact,
 * journal contents (per-node actorSeq/inputHash/result), and event-stream sanity. See docs/execution-engine.md.
 */

import { describe, expect, it } from "vitest";
import { InMemoryJournalStore, WorkflowError, inputHash } from "@zcode/dynamic-workflow";
import { runScript } from "./helpers.js";

const RUN = "run";

describe("e2e — single typed ask", () => {
  it("lowers, runs in the sandbox, validates the submit, and returns the artifact", async () => {
    const script = [
      "interface Summary { title: string; points: string[]; }",
      'const worker = agent("worker", "You summarize repos.");',
      'const s = await worker.ask<Summary>("Summarize the repo");',
      "log(`title: ${s.title}`);",
      "return s;",
    ].join("\n");

    const artifact = { title: "The Repo", points: ["a", "b"] };
    const { settlement, journal, driver } = await runScript(script, {
      asks: {
        "ask#1": () => ({
          type: "submit",
          payload: artifact,
          stats: { tokens: 42, toolCalls: 1, turns: 1 },
        }),
      },
    });

    expect(settlement).toEqual({ status: "completed", artifact });

    // Journal: the ask node completed, with actorSeq/inputHash/stats and actor attribution.
    const node = journal.getNode(RUN, "ask#1", 1);
    expect(node?.status).toBe("completed");
    expect(node?.kind).toBe("ask");
    expect(node?.result).toEqual(artifact);
    expect(node?.actorSeq).toBe(0);
    expect(node?.inputHash).toBe(inputHash("Summarize the repo"));
    expect(node?.stats?.tokens).toBe(42);
    expect(node?.actorSiteId).toBe("actor#1");

    // The actor is recorded.
    const actor = journal.getActor(RUN, "actor#1", 1);
    expect(actor?.name).toBe("worker");
    expect(actor?.persona?.system).toBe("You summarize repos.");

    // Event-stream sanity: run-started -> actor-created -> node dispatched -> settled(ok) -> run-settled(completed).
    const types = driver.events.map((e) => e.type);
    expect(types[0]).toBe("run-started");
    expect(types).toContain("actor-created");
    expect(types).toContain("node-dispatched");
    expect(driver.eventsOfType("log").some((e) => e.message === "title: The Repo")).toBe(true);
    const settled = driver.eventsOfType("node-settled");
    expect(settled.at(-1)?.outcome).toBe("ok");
    expect(types.at(-1)).toBe("run-settled");
  });
});

describe("e2e — world reads + typed ask", () => {
  it("journals glob/read with input hashes and threads their results into an ask", async () => {
    const script = [
      "interface Verdict { approved: boolean; reason: string; }",
      'const paths = await files.glob("src/**/*.ts");',
      'const first = paths[0] ?? "none";',
      "const text = await files.read(first);",
      "log(`read ${text.length} bytes from ${first}`);",
      'const v = await agent("reviewer").ask<Verdict>(`Review ${first}`);',
      "return { count: paths.length, first, approved: v.approved };",
    ].join("\n");

    const files = { glob: ["src/a.ts", "src/b.ts"], read: "export const x = 1;\n" };
    const seenArgs: unknown[][] = [];
    const { settlement, journal } = await runScript(script, {
      worldReads: (op, args) => {
        // Boundary A hands the driver positional arrays (packed verbatim by lowering, op-agnostic).
        seenArgs.push(args);
        return op === "glob" ? files.glob : files.read;
      },
      asks: {
        "ask#1": ({ message }) => {
          // The instruction must have the glob's first result interpolated, proving world-read results flow back.
          expect(message.instructions).toContain("src/a.ts");
          return { type: "submit", payload: { approved: true, reason: "ok" } };
        },
      },
    });

    expect(settlement).toEqual({
      status: "completed",
      artifact: { count: 2, first: "src/a.ts", approved: true },
    });

    const glob = journal.getNode(RUN, "world-read#1", 1);
    expect(glob?.kind).toBe("world-read");
    expect(glob?.result).toEqual(files.glob);
    // inputHash covers {op, args}: script args stay positional across the sandbox boundary.
    expect(glob?.inputHash).toBe(inputHash({ op: "glob", args: ["src/**/*.ts"] }));
    const read = journal.getNode(RUN, "world-read#2", 1);
    expect(read?.result).toBe(files.read);
    expect(read?.inputHash).toBe(inputHash({ op: "read", args: ["src/a.ts"] }));
    // The array survives NDJSON element-for-element (protocol.ts args matching the child-source mirror).
    expect(seenArgs).toEqual([["src/**/*.ts"], ["src/a.ts"]]);
  });

  it("carries multi-arg and optional-arg ops through the wire unchanged", async () => {
    // The wire shape is unchanged (op string + args array), so the newer grep/git.* ops ride the same path.
    // This case proves it: a script using multi-arg, optional-default, zero-arg, and a git.log that
    // shadows the top-level log() -- every (op, args) the driver receives matches across the boundary.
    const script = [
      'const hits = await files.grep("TODO", "*.ts");',
      'const narrow = await files.grep("FIXME");',
      "const changed = await git.changedFiles();",
      'const diff = await git.diff("main", "src/a.ts");',
      "const status = await git.status();",
      "const commits = await git.log(3);",
      'log(`${hits.length} TODOs on ${status.branch ?? "detached"}`);',
      "return {",
      "  hits: hits.length + narrow.length,",
      "  changed: changed.length,",
      "  diffBytes: diff.length,",
      "  commits: commits.map((c) => c.hash),",
      "};",
    ].join("\n");

    const seen: { op: string; args: unknown[] }[] = [];
    const { settlement, journal } = await runScript(script, {
      worldReads: (op, args) => {
        seen.push({ op, args });
        switch (op) {
          case "grep":
            return [{ path: "src/a.ts", line: 7, text: "// TODO" }];
          case "git-changed-files":
            return ["src/a.ts", "src/b.ts"];
          case "git-diff":
            return "@@ -1 +1 @@\n";
          case "git-status":
            return {
              branch: "main",
              clean: false,
              staged: [],
              unstaged: ["src/a.ts"],
              untracked: [],
            };
          default:
            return [{ hash: "abc", subject: "s", author: "a", date: "2026-08-20T00:00:00+08:00" }];
        }
      },
    });

    expect(settlement).toEqual({
      status: "completed",
      artifact: { hits: 2, changed: 2, diffBytes: 12, commits: ["abc"] },
    });
    // An omitted trailing optional arrives as a shorter array, not an undefined hole.
    expect(seen).toEqual([
      { op: "grep", args: ["TODO", "*.ts"] },
      { op: "grep", args: ["FIXME"] },
      { op: "git-changed-files", args: [] },
      { op: "git-diff", args: ["main", "src/a.ts"] },
      { op: "git-status", args: [] },
      { op: "git-log", args: [3] },
    ]);
    // Six world-read sites share one per-kind counter; log(...) occupies none.
    expect(journal.getNode(RUN, "world-read#6", 1)?.inputHash).toBe(
      inputHash({ op: "git-log", args: [3] }),
    );
    expect(journal.getNode(RUN, "world-read#7", 1)).toBeUndefined();
  });
});

describe("e2e — fan-out over Promise.all", () => {
  it("runs one ask instance per globbed path, each on its own actor", async () => {
    const script = [
      "interface Verdict { approved: boolean; reason: string; }",
      'const paths = await files.glob("src/**/*.ts");',
      "const verdicts = await Promise.all(",
      // Per-element names: each fan-out element is a new actor; a shared static name hits the runtime
      // DuplicateActorName (the compiler has its own 9005 fan-out clause; see analysis/actor-names.ts).
      "  paths.map((p) => agent(`reviewer-${p}`).ask<Verdict>(`Security-review ${p}`)),",
      ");",
      "return verdicts.filter((v) => !v.approved).map((v) => v.reason);",
    ].join("\n");

    const paths = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const { settlement, journal, driver } = await runScript(script, {
      worldReads: () => paths,
      asks: {
        // Verdict keyed on the path in the instruction: b fails.
        "ask#1": ({ message }) => {
          const approved = !message.instructions.includes("src/b.ts");
          return {
            type: "submit",
            payload: { approved, reason: approved ? "clean" : "vuln in b" },
          };
        },
      },
    });

    expect(settlement).toEqual({ status: "completed", artifact: ["vuln in b"] });

    // Three ask instances (ask#1@1..3), three actors (actor#1@1..3), all completed.
    const askNodes = journal
      .listNodes(RUN, { kinds: "all", withResult: true })
      .filter((n) => n.kind === "ask");
    expect(askNodes).toHaveLength(3);
    expect(askNodes.every((n) => n.status === "completed")).toBe(true);
    expect(driver.sessionCreations).toHaveLength(3);
    // The ok settlement = 3 asks + 1 glob world-read.
    expect(driver.eventsOfType("node-settled").filter((e) => e.outcome === "ok")).toHaveLength(4);
  });
});

describe("e2e — untyped ask (final text)", () => {
  it("settles an untyped ask on turn-end with the final text; no submit tool offered", async () => {
    const script = [
      'const a = agent("assistant");',
      'const answer = await a.ask("What is 2+2?");',
      "return answer;",
    ].join("\n");

    const { settlement, journal, driver } = await runScript(script, {
      asks: { "ask#1": () => ({ type: "text", finalText: "four" }) },
    });

    expect(settlement).toEqual({ status: "completed", artifact: "four" });
    expect(driver.startAsks[0]?.message.typed).toBe(false);
    expect(journal.getNode(RUN, "ask#1", 1)?.result).toBe("four");
  });
});

describe("e2e — report (progressive results)", () => {
  it("journals each reported item and emits it, without deadlocking the child", async () => {
    // report rides the event channel, not request/response: never awaited, so the child continues right after sending.
    // This case is also the liveness proof for that -- if the parent believed a response was required, the script would wait
    // forever at the first report and the run would die in a timeout instead of completing.
    const script = [
      "interface Plan { steps: string[]; }",
      'const planner = agent("planner");',
      'const plan = await planner.ask<Plan>("draft a plan");',
      'report({ phase: "planned", steps: plan.steps });',
      "for (const step of plan.steps) {",
      '  report({ phase: "step", step });',
      "}",
      "return plan.steps.length;",
    ].join("\n");

    const { settlement, journal, driver } = await runScript(script, {
      asks: { "ask#1": () => ({ type: "submit", payload: { steps: ["a", "b"] } }) },
    });

    expect(settlement).toEqual({ status: "completed", artifact: 2 });

    // Three reports: report#1 once plus report#2 twice (same site in a loop, ordinal increasing).
    const reports = journal
      .listNodes(RUN, { kinds: "all", withResult: true })
      .filter((n) => n.kind === "report");
    expect(reports.map((n) => `${n.siteId}@${n.ordinal}`)).toEqual([
      "report#1@1",
      "report#2@1",
      "report#2@2",
    ]);
    // Written once, settled, no actor attribution, result is the item, inputHash covers it.
    expect(reports.every((n) => n.status === "completed" && n.actorSeq === undefined)).toBe(true);
    expect(reports[0]?.result).toEqual({ phase: "planned", steps: ["a", "b"] });
    expect(reports[0]?.inputHash).toBe(inputHash({ phase: "planned", steps: ["a", "b"] }));
    expect(reports.map((n) => n.result)).toEqual([
      { phase: "planned", steps: ["a", "b"] },
      { phase: "step", step: "a" },
      { phase: "step", step: "b" },
    ]);

    // Boundary C: exactly one event per unskipped report, in arrival order (the event channel's FIFO is load-bearing).
    expect(driver.eventsOfType("report").map((e) => e.item)).toEqual(reports.map((n) => n.result));
  });

  it("carries the reported items even though the run fails afterwards", async () => {
    // Why report exists: a run dying on its twelfth ask still did eleven asks' work.
    // Reports must survive in the journal, not evaporate with the failure.
    const script = [
      'const scout = agent("scout");',
      'const a = await scout.ask<string>("first");',
      "report({ done: a });",
      'const b = await scout.ask<string>("second");',
      "report({ done: b });",
      "return b;",
    ].join("\n");

    const { settlement, journal } = await runScript(script, {
      asks: {
        "ask#1": () => ({ type: "text", finalText: "ok-1" }),
        "ask#2": () => ({ type: "fail", error: new WorkflowError("DriverError", "boom") }),
      },
    });

    expect(settlement.status).toBe("errored");
    const reports = journal
      .listNodes(RUN, { kinds: "all", withResult: true })
      .filter((n) => n.kind === "report");
    expect(reports).toHaveLength(1);
    expect(reports[0]?.result).toEqual({ done: "ok-1" });
  });

  it("emits nothing on replay: a resumed run never shows an item twice", async () => {
    // Resume re-runs the script, so every report call executes again. Already-journalled (siteId, ordinal)
    // pairs skip silently -- the entire report/log difference and the only reason report journals.
    const script = [
      'const scout = agent("scout");',
      'const a = await scout.ask<string>("first");',
      "report({ found: a });",
      "return a;",
    ].join("\n");

    const journal = new InMemoryJournalStore();
    const first = await runScript(script, {
      journal,
      asks: { "ask#1": () => ({ type: "text", finalText: "ok-1" }) },
    });
    expect(first.settlement.status).toBe("completed");
    expect(first.driver.eventsOfType("report")).toHaveLength(1);

    const resumed = await runScript(script, {
      journal,
      // Resume must dispatch nothing: asks short-circuit on journal hits, reports dedupe from the journal.
      onStartAsk: (instance) => {
        throw new Error(`resume must not dispatch asks, dispatched ${instance.siteId}`);
      },
    });

    expect(resumed.settlement).toEqual({ status: "completed", artifact: "ok-1" });
    expect(resumed.driver.eventsOfType("report")).toEqual([]);
    expect(
      journal.listNodes(RUN, { kinds: "all", withResult: true }).filter((n) => n.kind === "report"),
    ).toHaveLength(1);
  });

  it("fails the run on the item past the 65,536-item cap, keeping every item before it", async () => {
    // The count cap (docs/execution-engine.md, "Progressive results: report") traverses the whole sandbox path:
    // number 65,537 fails the run, the first 65,536 journal fine, and no try/catch sees it.
    const script = [
      "try {",
      "  for (let i = 0; i < 65537; i += 1) report(i);",
      "} catch {",
      '  return "caught";',
      "}",
      'return "not-caught";',
    ].join("\n");

    const { settlement, journal } = await runScript(script);

    expect(settlement.status).toBe("errored");
    expect((settlement as { error?: WorkflowError }).error?.code).toBe("ReportCapExceeded");
    expect(journal.countNodes(RUN, "report")).toBe(65_536);
  }, 120_000);

  it("carries an item just under the 1 MiB per-item cap through the sandbox intact", async () => {
    // The 1MiB per-item cap (same section): a near-cap
    // item must cross verbatim, journal intact, run completing normally.
    const script = ['report({ n: 1, big: "y".repeat(1000000) });', 'return "done";'].join("\n");

    const { settlement, journal } = await runScript(script);

    expect(settlement).toEqual({ status: "completed", artifact: "done" });
    const [row] = journal.listNodes(RUN, { kinds: ["report"], withResult: true });
    expect(row?.result).toEqual({ n: 1, big: "y".repeat(1_000_000) });
  });

  it("fails the run when a reported item exceeds the per-item cap", async () => {
    // A cap breach fails the whole run (report returns void; there is no channel to reject into), so the assertion
    // targets the run settlement, not a caught error -- the script's try/catch receives nothing.
    const script = [
      'const big = "x".repeat(1100000);',
      "try {",
      "  report({ big });",
      "} catch {",
      '  return "caught";',
      "}",
      'return "not-caught";',
    ].join("\n");

    const { settlement, journal } = await runScript(script);

    expect(settlement.status).toBe("errored");
    expect((settlement as { error?: WorkflowError }).error?.code).toBe("ReportCapExceeded");
    expect(
      journal.listNodes(RUN, { kinds: "all", withResult: true }).filter((n) => n.kind === "report"),
    ).toEqual([]);
  });
});

describe("e2e — Promise.race with a losing in-flight ask", () => {
  // Bug regression (engine.complete leaving in-flight asks alive): the race winner settles, the script returns, the child sends complete --
  // and the loser's ask used to stay in liveNodes, its turn running on in the host process, nudged into
  // another model call at turn end, node-settled/usage-updated landing after run-settled.
  // complete now abortInFlight synchronously like cancel/failRun: the loser is cancelled driver-side and
  // run-settled is the stream's final event.
  it("completes with the winner and aborts the loser at the driver", async () => {
    const script = [
      'const fast = agent("fast");',
      'const slow = agent("slow");',
      "const winner = await Promise.race([",
      '  fast.ask<string>("quick answer"),',
      '  slow.ask<string>("slow answer"),',
      "]);",
      "return winner;",
    ].join("\n");

    const { settlement, journal, driver } = await runScript(script, {
      asks: {
        // ask<string> is untyped (last-turn text is the result): the winner settles with its turn-end text.
        "ask#1": () => ({
          type: "text",
          finalText: "won",
          stats: { tokens: 5, toolCalls: 0, turns: 1 },
        }),
        // Loser: no actions at all -- the ask hangs, a slow turn still running.
        "ask#2": () => [],
      },
    });

    expect(settlement).toEqual({ status: "completed", artifact: "won" });

    // The loser is cancelled driver-side (the host process no longer holds its turn).
    expect(driver.cancels.some((i) => i.siteId === "ask#2")).toBe(true);

    // Stream invariant: run-settled is last, the loser's node-settled(cancelled) before it.
    const types = driver.events.map((e) => e.type);
    expect(types.at(-1)).toBe("run-settled");
    const loserSettled = driver
      .eventsOfType("node-settled")
      .find((e) => e.instance.siteId === "ask#2");
    expect(loserSettled?.outcome).toBe("cancelled");

    // Journal: winner completed; loser keeps its admission-time running row (aligned with cancel's resume semantics).
    expect(journal.getNode(RUN, "ask#1", 1)?.status).toBe("completed");
    expect(journal.getNode(RUN, "ask#2", 1)?.status).toBe("running");
  });
});

// Phase markers (docs/dynamic-workflow/presentation.md): lowering rewrites phase("...")
// into __host.enterPhase; the child hands it to the engine over the event channel, which emits phase-entered.
describe("e2e — phase markers", () => {
  const script = [
    'phase("Prepare");',
    'const scout = agent("scout");',
    "for (let i = 0; i < 2; i++) {",
    '  phase("Ask");',
    "  await scout.ask<string>(`round ${i}`);",
    "}",
    'phase("Wrap up");',
    'return "ok";',
  ].join("\n");

  it("emits one phase-entered per evaluated marker, in evaluation order, with per-name ordinals", async () => {
    const { settlement, journal, driver } = await runScript(script, {
      asks: { "ask#1": () => ({ type: "text", finalText: "fine" }) },
    });
    expect(settlement.status).toBe("completed");
    expect(driver.eventsOfType("phase-entered")).toEqual([
      { type: "phase-entered", name: "Prepare", ordinal: 1 },
      { type: "phase-entered", name: "Ask", ordinal: 1 },
      { type: "phase-entered", name: "Ask", ordinal: 2 },
      { type: "phase-entered", name: "Wrap up", ordinal: 1 },
    ]);
    // Arrival order is load-bearing: enter-Ask precedes dispatching the ask inside it.
    const order = driver.events
      .filter((e) => e.type === "phase-entered" || e.type === "node-queued")
      .map((e) =>
        e.type === "phase-entered"
          ? `phase:${e.name}@${e.ordinal}`
          : `node:${e.instance.siteId}@${e.instance.ordinal}`,
      );
    expect(order).toEqual([
      "phase:Prepare@1",
      "phase:Ask@1",
      "node:ask#1@1",
      "phase:Ask@2",
      "node:ask#1@2",
      "phase:Wrap up@1",
    ]);
    // Markers are not sites: no journal row.
    expect(journal.listNodes(RUN, { kinds: "all", withResult: true }).map((n) => n.kind)).toEqual([
      "ask",
      "ask",
    ]);
  });

  it("re-emits the prefix on resume (no journal row to dedupe against); consumers reduce monotonically", async () => {
    const journal = new InMemoryJournalStore();
    const first = await runScript(script, {
      journal,
      asks: { "ask#1": () => ({ type: "text", finalText: "fine" }) },
    });
    expect(first.settlement.status).toBe("completed");
    const resumed = await runScript(script, {
      journal,
      onStartAsk: (instance) => {
        throw new Error(`resume must not dispatch asks, dispatched ${instance.siteId}`);
      },
    });
    expect(resumed.settlement.status).toBe("completed");
    expect(resumed.driver.eventsOfType("phase-entered")).toEqual(
      first.driver.eventsOfType("phase-entered"),
    );
  });
});
