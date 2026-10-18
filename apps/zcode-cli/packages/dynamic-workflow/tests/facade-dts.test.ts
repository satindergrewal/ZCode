import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  analyzeWorkflowScript,
  collectDiagnostics,
  collectSites,
  collectWorldRunCommands,
  createWorkflowProgram,
  FACADE_DTS,
  lowerWorkflow,
  SNIPPET_FACADE_DTS,
  WORLD_RUN_LITERAL_CODE,
} from "../src/index.js";

// Segment splitting (docs/dynamic-workflow/authoring.md, "The facade") promises: FACADE_DTS is byte-deterministic
// once assembled from segments. The hash updates on every intentional facade text change (this history is the
// facade's change ledger); any segment-level edit collides with this -- deliberately: facade text changes must be
// explicit decisions, never silent drift while reshuffling segments.
//   - dfd383f3... (2026-08-26): segment split lands, byte-identical to the pre-split text.
//   - fb2d9943... (2026-08-26): world.run segment added (docs/dynamic-workflow/authoring.md).
//   - 7f7d36ee... (2026-08-27): phase segment added (docs/dynamic-workflow/presentation.md).
//   - 198475cc... (2026-08-28): args segment added (docs/dynamic-workflow/launch.md).
//   - 807e4b79... (2026-08-29): merge re-pin -- the combined hash after feat/dynamic-workflow's phase segment
//     met dwf-reusable's args segment (neither side's hash matches the current text anymore).
//   - e7da7b7b... (2026-08-29): phase segment JSDoc rewritten -- prompt-layer enforcement (required + human-readable
//     phase names following the session language); see docs/dynamic-workflow/authoring.md "Phases" and
//     docs/dynamic-workflow/authoring.md "The skill". Declaration set (declare lines) unchanged.
//   - 877a78c3... (2026-08-31): actor segment agent() JSDoc rewritten -- "name is a display label" became
//     "non-empty names must be unique per run and are the identity key for amend-resume cache matching",
//     including the static-name-in-fan-out guidance; the phase segment's unlike-actor-names line reworded in the
//     same pass. See docs/execution-engine.md, "Amend-resume". Declaration set unchanged.
//   - 05c3401c... (2026-09-04): artifact segment added and report gained a second parameter
//     (docs/dynamic-workflow/authoring.md). This one changed the declaration set: new declare const artifact
//     plus seven spec interfaces; report became (item: unknown, artifactId?: string).
//   - 499c4179... (2026-09-04): BoardSpec.title renamed cardTitle. The old name collided on the same key with
//     ArtifactOptions' inherited title (the board's own card title); both strings, so TS accepted it -- the cost being
//     a board that could never say "this board is the memory regression; every card takes name as its title".
//     Renamed in the spec the same day (docs/dynamic-workflow/authoring.md, "The facade").
//   - 540a2054... (2026-09-04): prose only -- the actor segment's artifact became result/output value,
//     yielding the word to artifact.*. The old phrasings (Node<T>'s "producing a typed artifact",
//     Agent.ask's "T is the task's output artifact") meant the engine-internal sense while the artifact segment
//     used the same word for user-facing products in the same .d.ts -- two senses in one view. Also in the same
//     pass: CreateWorkflow's RULES and the dynamic-workflows skill body; see docs/dynamic-workflow/authoring.md
//     "The guidance" and "Artifacts: what the user keeps", the terminology table. Declaration set unchanged.
//   - 0dd165d5... (2026-09-05): prose only -- the phase segment gained the every-phase-needs-an-ask-or-world.run
//     rule and the rewritten Idiom line (docs/dynamic-workflow/presentation.md, same day: empty phases flash by
//     invisibly, so models are taught not to write them). Declaration set unchanged.
//   - 99abaa45... (2026-09-05): prose only -- ToolProfile and AgentPersona.tools/model JSDoc rewritten:
//     "none suits cheap judge/extract personas" became "use none only when the ask text already carries everything
//     needed; use readonly/default to check files, chase references, or run things; toolless subagents escalate
//     rather than pretend on such asks". Root cause: a production tools:"none" GLM subagent asked to verify disk
//     content emitted escalate("placeholder"); see docs/execution-engine.md and
//     docs/dynamic-workflow/authoring.md "The skill". Declaration set unchanged.
//   - 23aef592... (2026-09-05): the previous two re-pinned on both branches; after merging
//     dwf-visual-redesign and feat/dynamic-workflow both prose blocks coexist, re-pinned on the merge result.
//     Declaration set unchanged.
//   - b500809e... (2026-09-05): prose only -- the artifact segment's overview rewritten as two habits: every run
//     publishes its deliverable (web/PDF means that file via file(); a conclusion means the long-form report,
//     usually markdown(); one-line answers excepted), and boards are for humans watching the run (declare only
//     when there is a mid-flight state worth watching); plus two is-this-card-worth-it checks (would the user open
//     it standalone; does it duplicate another artifact). markdown()'s JSDoc went from "not a copy of return" to
//     "the common shape of report-like deliverables". Same pass as SKILL.md s9 / examples.md. Declaration set unchanged.
//   - f94af7c0... (2026-09-07): prose only -- the phase naming rule gained an echo: "say it like you would tell a
//     teammate what you are doing now", with a paired good/bad example. The same segment's line wraps reflowed to
//     hold max-lines 400 (template-literal lines count as code, not comments). The teaching went from three banned
//     words to one principle plus paired examples (docs/dynamic-workflow/presentation.md, 2026-09-07 ruling; the
//     full example table lives in SKILL.md, Write for the user). Declaration set unchanged.
//   - 853ae664... (2026-09-11): declaration set changed -- declare type ModelTier and AgentPersona.model retired
//     (docs/dynamic-workflow/authoring.md): the host has no lite model source; tiers were a dead knob occupying
//     facade space. Subagents run on the parent session's current model.
//   - fe83dea7... (2026-09-11): declaration set changed -- ToolProfile narrowed to "default" | "readonly", "none"
//     retired (same decision record): over readonly it only bought not-reading-files, achievable in ask text; it also
//     brought the only degraded-escalation family and three prompt branches per tier. ToolProfile and
//     AgentPersona.tools JSDoc rewritten to the two-tier wording in the same pass.
//   - dee40f0b... (2026-09-12): declaration set changed -- declare type ToolProfile and AgentPersona.tools retired
//     entirely (same decision record, round two): tiers only ever bought judges-not-editing-files, which normal
//     subagents never relied on either -- say it in the ask text. AgentPersona is system-only now, JSDoc noting every
//     actor gets the full work toolset.
//   - c19c9310... (2026-09-14): one JSDoc line -- createActor's name note changed CreateWorkflow with
//     resume_from to AmendWorkflow (the amend entry is its own tool now; docs/dynamic-workflow/launch.md).
//   - 21cb21e1... (2026-09-14): declaration set changed -- ArtifactOptions.primary?: boolean
//     (docs/dynamic-workflow/authoring.md, Ids tags and versions): scripts flag the run's deliverable; the completion
//     card and run sidebar lead with it. description gained JSDoc (now displayed beside the deliverable row); the
//     artifact prose gained mark-primary-when-publishing-more-than-one.
//   - abeaec0a... (2026-09-15): merged dwf-better-artifacts -- the previous two (AmendWorkflow JSDoc and
//     ArtifactOptions.primary) coexist; hash taken over the union text.
//   - 7478845e... (2026-09-22): declaration set changed -- the stream segment added (docs/dynamic-workflow/authoring.md,
//     Streams): Channel<T>, channel(), future(), in both facades. Segment text lives in facade/dts-stream.ts
//     (dts.ts is at the line cap) and is still assembled by dts.ts.
//   - 7fd6b30e... (2026-09-26): declaration set changed -- subagent models return to persona
//     (docs/dynamic-workflow/authoring.md, Choosing a model per subagent): ModelRef (a class with a private
//     constructor), model(), AgentPersona.model?: ModelRef | string. Actor segment only; snippets exclude it.
//   - 4f79960c... (2026-09-26): one JSDoc line -- report()'s count cap went 256 -> 65,536
//     (docs/execution-engine.md, Progressive results: report, and Reading the journal). Declaration set unchanged.
//   - 7f7dc6df... (2026-09-26): one JSDoc line -- report()'s per-item cap went 32KB -> 1 MiB, plus a run-level
//     1 GiB byte total (docs/execution-engine.md, Progressive results: report). Declaration set unchanged.
//   - a82956e9... (2026-09-26): merged dwf-report-limit -- the previous three (persona ModelRef/model() and the
//     two report cap JSDoc lines) coexist; hash taken over the union text.
//   - f1990146... (2026-09-28): declaration set changed -- the hole segment added (docs/dynamic-workflow/authoring.md,
//     Holes): hole<T>(name, prompt, body) overloads, snippet included. Segment text lives in facade/dts-hole.ts,
//     spliced after the phase segment. Full facade only -- snippets have no run, hence nothing for the main agent to fill.
//   - b47c6183... (2026-09-28): one JSDoc line -- the hole segment's restricted zone narrowed to array-method
//     fan-out callbacks (for...of bodies are fine: the first lap parks at the hole, later laps run the body after the
//     fill), plus a bodies-must-be-inlined line. Declaration set unchanged.
//   - 278970c4... (2026-09-30): prose only -- comments narrowed to the reference layer (docs/dynamic-workflow/authoring.md,
//     The facade): judgment material (phase naming, the two deliverable habits, the gating idiom, how to write pipeline
//     stages and the like) deleted here, kept only in the skill body; remaining comments rewritten for script authors
//     (actor -> subagent, journaled -> recorded, the hole reader is the main agent so it says you); facade
//     23275 -> 13598 bytes. Declaration set unchanged.
const PINNED_FACADE_SHA256 = "278970c47a2b3e5225d8e993320193221b42bd524121228e363f84ee4654609d";

describe("facade dts segments", () => {
  it("FACADE_DTS is byte-identical to the pinned composition", () => {
    const hash = createHash("sha256").update(FACADE_DTS, "utf8").digest("hex");
    expect(hash).toBe(PINNED_FACADE_SHA256);
  });

  // Comments carry the reference layer only: what it does, what it returns, when it rejects or fails the run, caps,
  // compile-time argument rules (docs/dynamic-workflow/authoring.md, The facade). Judgment material is stated once
  // in the skill body; the facade enters context only via skill 16.2, and comments restating it would be paid twice
  // per writing session and be the drift-prone copy. Before the 2026-09-30 dedup: 23275 bytes, ~20k of them comments.
  it("stays a reference: FACADE_DTS is under 14 000 bytes", () => {
    expect(Buffer.byteLength(FACADE_DTS, "utf8")).toBeLessThan(14_000);
  });

  // args exists in both facades: the snippet's verbatim-portable invariant requires a saved script referencing args
  // to compile unmodified in EvalWorkflowSnippet (where it is {} at runtime).
  it("SNIPPET_FACADE_DTS keeps world reads, world.run, log and args, drops actors/report/artifact/phase", () => {
    expect(SNIPPET_FACADE_DTS).toContain("declare const args");
    expect(FACADE_DTS).toContain("declare const args");
    expect(SNIPPET_FACADE_DTS).toContain("declare const files");
    expect(SNIPPET_FACADE_DTS).toContain("declare const git");
    expect(SNIPPET_FACADE_DTS).toContain("declare const world");
    expect(SNIPPET_FACADE_DTS).toContain("declare function log");
    // The stream segment exists in both facades: pipeline mechanics are exactly what snippets rehearse.
    expect(SNIPPET_FACADE_DTS).toContain("declare function channel");
    expect(SNIPPET_FACADE_DTS).toContain("declare function future");
    expect(SNIPPET_FACADE_DTS).toContain("declare interface Channel<T>");
    expect(SNIPPET_FACADE_DTS).not.toContain("declare function agent");
    expect(SNIPPET_FACADE_DTS).not.toContain("declare function report");
    expect(SNIPPET_FACADE_DTS).not.toContain("declare function phase");
    // Model declarations belong to the actor: snippets have no subagents, hence no optional model.
    expect(FACADE_DTS).toContain("declare function model");
    expect(SNIPPET_FACADE_DTS).not.toContain("declare function model");
    expect(SNIPPET_FACADE_DTS).not.toContain("ModelRef");
    // Artifacts are what a run hands the user; snippets have no run, so the segment is deliberately absent, types included.
    expect(FACADE_DTS).toContain("declare const artifact");
    expect(SNIPPET_FACADE_DTS).not.toContain("declare const artifact");
    expect(SNIPPET_FACADE_DTS).not.toContain("ArtifactRef");
    // Holes exist in the full facade only (docs/dynamic-workflow/authoring.md, Holes): snippets have no run.
    expect(FACADE_DTS).toContain(
      "declare function hole<T>(name: string, prompt?: string): Promise<T>;",
    );
    expect(FACADE_DTS).toContain(
      "declare function hole<T>(name: string, body: () => Promise<T>): Promise<T>;",
    );
    expect(FACADE_DTS).toContain(
      "declare function hole<T>(name: string, prompt: string, body: () => Promise<T>): Promise<T>;",
    );
    expect(SNIPPET_FACADE_DTS).not.toContain("declare function hole");
  });

  it("rejects hole() in the snippet facade at compile time (TS2304)", () => {
    const workflow = createWorkflowProgram(`return await hole<string>("decide");`, {
      facadeDts: SNIPPET_FACADE_DTS,
    });
    const diagnostics = collectDiagnostics(workflow.program);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.message).toContain("Cannot find name 'hole'");
  });

  // docs/dynamic-workflow/authoring.md, What the facade does not have: no budget identifier in the script facade.
  it("neither facade declares budget", () => {
    expect(FACADE_DTS).not.toContain("budget");
    expect(SNIPPET_FACADE_DTS).not.toContain("budget");
  });
});

describe("snippet compilation (scratch facade)", () => {
  const compileSnippet = (scriptText: string) =>
    createWorkflowProgram(scriptText, { facadeDts: SNIPPET_FACADE_DTS });

  it("compiles a world-read + pure-logic snippet cleanly", () => {
    const workflow = compileSnippet(
      `const paths = await files.glob("src/**/*.ts");\n` +
        `log(\`found \${paths.length}\`);\n` +
        `return paths.filter((p) => p.endsWith(".test.ts"));`,
    );
    expect(collectDiagnostics(workflow.program)).toEqual([]);
  });

  it("rejects agent() at compile time (TS2304, not a runtime surprise)", () => {
    const workflow = compileSnippet(`return await agent("a").ask("do it");`);
    const diagnostics = collectDiagnostics(workflow.program);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.message).toContain("Cannot find name 'agent'");
  });

  it("rejects report() and phase() the same way", () => {
    for (const source of [`report({ found: 1 });`, `phase("gate");`]) {
      const workflow = compileSnippet(source);
      expect(collectDiagnostics(workflow.program).length).toBeGreaterThan(0);
    }
  });

  // Facade identity is judged by declaration file name (registry/sites/misuse/lowering, five places); a renamed
  // scratch facade would silently empty site collection and stop degrading files.glob to __host.worldRead --
  it("lowers files.glob in a snippet to a world-read site (facade filename invariant)", () => {
    const workflow = compileSnippet(`return await files.glob("*.ts");`);
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const table = collectSites(workflow);
    const lowered = lowerWorkflow(workflow, table);
    expect(lowered.code).toContain(`__host.worldRead("world-read#1", "glob"`);
  });
});

// The artifact type surface (docs/dynamic-workflow/authoring.md, Two families): the two families' semantic
// asymmetry must hold at the type level -- content members await an ArtifactRef, predeclared members are void.
describe("artifact facade (type surface)", () => {
  const diagnosticsOf = (scriptText: string) =>
    collectDiagnostics(createWorkflowProgram(scriptText).program);

  it("types content members as Promise<ArtifactRef>", () => {
    expect(
      diagnosticsOf(
        `const ref = await artifact.file("book", "out/book.pdf", { title: "Book", contentType: "application/pdf" });\n` +
          `const md = await artifact.markdown("notes", "# hi", { description: "d" });\n` +
          `return ref.id + String(ref.version) + md.id;`,
      ),
    ).toEqual([]);
  });

  it("rejects using a content member's result as anything but an ArtifactRef", () => {
    const diagnostics = diagnosticsOf(`const n: number = await artifact.file("book", "b.pdf");`);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.message).toContain("not assignable");
  });

  it("types preset members as void (a declaration has nothing to await)", () => {
    expect(
      diagnosticsOf(
        `artifact.chart("perf", { type: "line", x: { field: "round" }, y: [{ field: "ms", label: "ms" }], scale: "log", baseline: { field: "budget" } });\n` +
          `artifact.table("rows", { columns: [{ field: "name" }], key: "name" });\n` +
          `artifact.metrics("m", { metrics: [{ field: "p95", unit: "ms" }] });\n` +
          `artifact.board("b", { key: "id", status: "state", columns: ["todo", "done"], detail: [{ field: "owner" }] });`,
      ),
    ).toEqual([]);
    const diagnostics = diagnosticsOf(
      `const v: number = artifact.chart("perf", { x: { field: "r" }, y: { field: "m" } });`,
    );
    expect(diagnostics.length).toBeGreaterThan(0);
  });

  it("lets a board name itself and its cards separately (the cardTitle rename)", () => {
    expect(
      diagnosticsOf(
        `artifact.board("b", { title: "memory regression", key: "id", status: "state", columns: ["todo"], cardTitle: "name" });`,
      ),
    ).toEqual([]);
    // The old name means nothing outside BoardSpec's fields: title names the board, never a card.
    expect(FACADE_DTS).toContain("cardTitle?: string");
  });

  it("accepts primary on every member and rejects a non-boolean one", () => {
    expect(
      diagnosticsOf(
        `await artifact.file("book", "b.pdf", { primary: true });\n` +
          `await artifact.markdown("notes", "# hi", { title: "Notes", primary: false });\n` +
          `artifact.board("b", { key: "id", status: "state", columns: ["todo"], primary: true });`,
      ),
    ).toEqual([]);
    expect(
      diagnosticsOf(`await artifact.file("book", "b.pdf", { primary: "yes" });`).length,
    ).toBeGreaterThan(0);
    expect(FACADE_DTS).toContain("primary?: boolean");
  });

  it("rejects a malformed spec at compile time (missing y, wrong chart type)", () => {
    expect(diagnosticsOf(`artifact.chart("perf", { x: { field: "r" } });`).length).toBeGreaterThan(
      0,
    );
    expect(
      diagnosticsOf(
        `artifact.chart("perf", { x: { field: "r" }, y: { field: "m" }, type: "pie" });`,
      ).length,
    ).toBeGreaterThan(0);
  });

  it("makes report's second argument an optional string", () => {
    expect(diagnosticsOf(`report({ a: 1 });\nreport({ a: 1 }, "perf");`)).toEqual([]);
    expect(diagnosticsOf(`report({ a: 1 }, 1);`).length).toBeGreaterThan(0);
  });

  it("leaves artifact out of the snippet facade (TS2304, not a runtime surprise)", () => {
    const workflow = createWorkflowProgram(`await artifact.file("book", "b.pdf");`, {
      facadeDts: SNIPPET_FACADE_DTS,
    });
    const diagnostics = collectDiagnostics(workflow.program);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics[0]?.message).toContain("Cannot find name 'artifact'");
  });
});

describe("world.run (compile side)", () => {
  it("typechecks and lowers to the run op with positional args", () => {
    const workflow = createWorkflowProgram(
      `const r = await world.run("lean", ["--make", "proof.lean"], { timeoutMs: 60000 });\n` +
        `return r.exitCode === 0;`,
    );
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const table = collectSites(workflow);
    const lowered = lowerWorkflow(workflow, table);
    expect(lowered.code).toContain(`__host.worldRead("world-read#1", "run"`);
  });

  it("collects the deduplicated, sorted command set from literals", () => {
    const workflow = createWorkflowProgram(
      `await world.run("node", ["-e", "0"]);\n` +
        `await world.run(\`lean\`, ["a.lean"]);\n` +
        `await world.run("node", ["-e", "1"]);`,
    );
    const table = collectSites(workflow);
    const { commands, diagnostics } = collectWorldRunCommands(workflow, table);
    expect(diagnostics).toEqual([]);
    expect(commands).toEqual(["lean", "node"]);
  });

  it("rejects a non-literal cmd with a positioned WORLD_RUN_LITERAL_CODE diagnostic", () => {
    const workflow = createWorkflowProgram(
      `const cmd = "lean";\nconst r = await world.run(cmd, []);\nreturn r.exitCode;`,
    );
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const table = collectSites(workflow);
    const { diagnostics } = collectWorldRunCommands(workflow, table);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe(WORLD_RUN_LITERAL_CODE);
    expect(diagnostics[0]?.line).toBe(2);
    expect(diagnostics[0]?.message).toContain("string literal");
    // analyzeWorkflowScript surfaces it alongside misuse (ok:false).
    const analyzed = analyzeWorkflowScript(
      `const cmd = "lean";\nconst r = await world.run(cmd, []);\nreturn r.exitCode;`,
    );
    expect(analyzed.ok).toBe(false);
    expect(analyzed.diagnostics[0]?.code).toBe(WORLD_RUN_LITERAL_CODE);
  });

  it("rejects a substitution template cmd", () => {
    const workflow = createWorkflowProgram(
      `const suffix = "n";\nawait world.run(\`lea\${suffix}\`, []);`,
    );
    const table = collectSites(workflow);
    const { diagnostics } = collectWorldRunCommands(workflow, table);
    expect(diagnostics).toHaveLength(1);
  });

  it("keeps the world.run step label carrying the command (confirmation surface)", () => {
    const analyzed = analyzeWorkflowScript(`await world.run("lean", ["a.lean"]);`);
    expect(analyzed.ok).toBe(true);
    const step = analyzed.causality?.steps.find((s) => s.label.includes("lean"));
    expect(step).toBeDefined();
    expect(step?.label).toBe("run lean");
  });
});

// args lowering (docs/dynamic-workflow/launch.md, Running a saved workflow): the only facade value rather than
describe("args lowering", () => {
  it("lowers a facade args read to __host.args, with no site of its own", () => {
    const workflow = createWorkflowProgram(`const target = String(args.target);\nreturn target;`);
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const table = collectSites(workflow);
    const lowered = lowerWorkflow(workflow, table);
    expect(lowered.code).toContain("__host.args.target");
    // Reading a value is no wait point: no site id, hence no causality node.
    expect(lowered.siteIds).toEqual([]);
  });

  it("lowers args in the snippet facade too (verbatim portability)", () => {
    const workflow = createWorkflowProgram(`return String(args.x);`, {
      facadeDts: SNIPPET_FACADE_DTS,
    });
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const lowered = lowerWorkflow(workflow, collectSites(workflow));
    expect(lowered.code).toContain("__host.args.x");
  });

  // The verdict follows the checker's resolution, not names: a script-declared args resolves to the script file's
  // symbol; a name heuristic would rewrite this into const __host.args = ..., a runtime SyntaxError.
  it("leaves a script-declared local `args` alone", () => {
    const workflow = createWorkflowProgram(`const args = { local: 1 };\nreturn args.local;`);
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const lowered = lowerWorkflow(workflow, collectSites(workflow));
    expect(lowered.code).not.toContain("__host.args");
    expect(lowered.code).toContain("args.local");
  });

  it("leaves a parameter named args and an unrelated `.args` property alone", () => {
    const workflow = createWorkflowProgram(
      [
        "function pick(args: { a: number }): number { return args.a; }",
        "const holder = { args: 7 };",
        "return pick({ a: 1 }) + holder.args;",
      ].join("\n"),
    );
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const lowered = lowerWorkflow(workflow, collectSites(workflow));
    expect(lowered.code).not.toContain("__host.args");
  });

  // A script using both args and ask: the rewrite must not break sites, and sites must not swallow args.
  it("coexists with ask sites", () => {
    const workflow = createWorkflowProgram(
      `const r = await agent("w").ask(String(args.topic));\nreturn r;`,
    );
    expect(collectDiagnostics(workflow.program)).toEqual([]);
    const table = collectSites(workflow);
    const lowered = lowerWorkflow(workflow, table);
    expect(lowered.code).toContain("__host.args.topic");
    expect(lowered.code).toContain('__host.ask("ask#1"');
  });
});
