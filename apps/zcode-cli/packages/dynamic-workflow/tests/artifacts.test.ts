/**
 * The compile side of user-facing artifacts (docs/dynamic-workflow/authoring.md): site identity, lowering,
 * compile-time diagnostics, and the declaredArtifacts list. Engine side: tests/engine/engine-artifacts.test.ts.
 *
 * Terminology: artifact here always means the user-facing product (what the script publishes), not the
 */

import { describe, expect, it } from "vitest";
import {
  analyzeWorkflowScript,
  ARTIFACT_DECLARATION_CODE,
  ARTIFACT_HOISTING_CODE,
  ARTIFACT_PRIMARY_CONFLICT_CODE,
  collectArtifactDeclarations,
  collectDiagnostics,
  collectSites,
  createWorkflowProgram,
  lowerWorkflow,
} from "../src/index.js";
import { FACADE_SITING_CODE } from "../src/analysis/facade-misuse.js";

const CHART = '{ x: { field: "round" }, y: { field: "ms" } }';

/** Compiles and collects sites (the script must typecheck clean first, or the site table is untrustworthy). */
function sites(scriptText: string) {
  const workflow = createWorkflowProgram(scriptText);
  expect(collectDiagnostics(workflow.program)).toEqual([]);
  return { table: collectSites(workflow), workflow };
}

function lower(scriptText: string): string {
  const { table, workflow } = sites(scriptText);
  return lowerWorkflow(workflow, table).code;
}

/** Only the three artifact diagnostics (other authoring codes are out of scope here). */
function artifactDiagnostics(scriptText: string) {
  const analyzed = analyzeWorkflowScript(scriptText);
  return analyzed.diagnostics.filter(
    (d) =>
      d.code === ARTIFACT_DECLARATION_CODE ||
      d.code === ARTIFACT_HOISTING_CODE ||
      d.code === ARTIFACT_PRIMARY_CONFLICT_CODE,
  );
}

describe("artifact sites", () => {
  it("mints one site per member with the registry op, on its own counter", () => {
    const { table } = sites(
      [
        `artifact.chart("perf", ${CHART});`,
        `artifact.table("rows", { columns: [{ field: "name" }] });`,
        `artifact.metrics("m", { metrics: [{ field: "p95" }] });`,
        `artifact.board("b", { key: "id", status: "state", columns: ["todo"] });`,
        `await artifact.file("book", "out/book.pdf");`,
        `await artifact.markdown("notes", "# hi");`,
      ].join("\n"),
    );
    expect(table.artifacts.map((site) => [site.id, site.op, site.artifactId])).toEqual([
      ["artifact#1", "chart", "perf"],
      ["artifact#2", "table", "rows"],
      ["artifact#3", "metrics", "m"],
      ["artifact#4", "board", "b"],
      ["artifact#5", "file", "book"],
      ["artifact#6", "markdown", "notes"],
    ]);
  });

  // site-id stability: adding artifact calls must not move any existing id (journal keys are these ids).
  it("leaves ask/actor/report/world-read ids byte-identical", () => {
    const withoutArtifacts = [
      `const a = agent("w");`,
      `const files1 = await files.glob("*.ts");`,
      `report({ n: files1.length });`,
      `const r = await a.ask("go");`,
      `return r;`,
    ].join("\n");
    const withArtifacts = [
      `const a = agent("w");`,
      `artifact.chart("perf", ${CHART});`,
      `const files1 = await files.glob("*.ts");`,
      `report({ n: files1.length }, "perf");`,
      `await artifact.markdown("notes", "# hi");`,
      `const r = await a.ask("go");`,
      `return r;`,
    ].join("\n");
    const idsOf = (text: string) => {
      const { table } = sites(text);
      return [
        ...table.actors.map((s) => s.id),
        ...table.asks.map((s) => s.id),
        ...table.reports.map((s) => s.id),
        ...table.worldReads.map((s) => s.id),
      ];
    };
    expect(idsOf(withArtifacts)).toEqual(idsOf(withoutArtifacts));
  });

  it("collects the report tag as a literal, and keeps a non-literal one raw", () => {
    const { table } = sites(
      [
        `artifact.chart("perf", ${CHART});`,
        `const tag = "perf";`,
        `report({ a: 1 }, "perf");`,
        `report({ a: 2 }, tag);`,
        `report({ a: 3 });`,
      ].join("\n"),
    );
    expect(table.reports.map((s) => s.artifactId)).toEqual(["perf", undefined, undefined]);
    // Non-literal tags have an expression and no value; no tag has neither -- how the diagnostic pass separates
    expect(table.reports.map((s) => s.artifactIdExpr !== undefined)).toEqual([true, true, false]);
  });

  it("consumes the global discovery order alongside report sites", () => {
    const { table, workflow } = sites(
      [`report({ a: 1 });`, `artifact.chart("perf", ${CHART});`, `report({ a: 2 }, "perf");`].join(
        "\n",
      ),
    );
    expect(lowerWorkflow(workflow, table).siteIds).toEqual(["report#1", "artifact#1", "report#2"]);
  });
});

describe("artifact lowering", () => {
  it("lowers content members to __host.publishArtifact with positional args", () => {
    const code = lower(
      `await artifact.file("book", "out/book.pdf", { title: "Book" });\n` +
        `await artifact.markdown("notes", "# hi");`,
    );
    expect(code).toContain(
      `__host.publishArtifact("artifact#1", "file", ["book", "out/book.pdf", { title: "Book" }])`,
    );
    expect(code).toContain(`__host.publishArtifact("artifact#2", "markdown", ["notes", "# hi"])`);
  });

  it("lowers preset members to __host.declareArtifact", () => {
    const code = lower(`artifact.chart("perf", ${CHART});`);
    expect(code).toContain(`__host.declareArtifact("artifact#1", "chart", ["perf", {`);
    expect(code).not.toContain("publishArtifact");
  });

  it("passes the report tag through as a third argument", () => {
    const code = lower(
      `artifact.chart("perf", ${CHART});\nreport({ a: 1 }, "perf");\nreport({ a: 2 });`,
    );
    expect(code).toContain(`__host.report("report#1", { a: 1 }, "perf")`);
    expect(code).toContain(`__host.report("report#2", { a: 2 })`);
  });

  it("leaves log and phase on their own host members", () => {
    const code = lower(`phase("gate");\nlog("hi");\nawait artifact.markdown("n", "x");`);
    expect(code).toContain("__host.log(");
    // Markers no longer collapse to void 0: they rewrite to enterPhase (the lowering section of the engine doc).
    expect(code).toContain('__host.enterPhase("gate")');
    expect(code).toContain("__host.publishArtifact(");
  });

  it("keeps artifact sites in the lowered site id list", () => {
    const { table, workflow } = sites(`await artifact.file("book", "b.pdf");`);
    expect(lowerWorkflow(workflow, table).siteIds).toEqual(["artifact#1"]);
  });
});

describe("artifact id diagnostics", () => {
  it("rejects a non-literal id, positioned on the argument", () => {
    const diagnostics = artifactDiagnostics(
      `const id = "book";\nawait artifact.file(id, "b.pdf");`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe(ARTIFACT_DECLARATION_CODE);
    expect(diagnostics[0]?.line).toBe(2);
    expect(diagnostics[0]?.message).toContain("compile-time string literal");
  });

  it("rejects a substitution-template id", () => {
    expect(
      artifactDiagnostics('const n = 1;\nawait artifact.file(`book-${n}`, "b.pdf");'),
    ).toHaveLength(1);
  });

  it("rejects an empty id", () => {
    const diagnostics = artifactDiagnostics(`await artifact.file("", "b.pdf");`);
    expect(diagnostics[0]?.message).toContain("must not be empty");
  });

  it("rejects an over-long id", () => {
    const id = "x".repeat(65);
    const diagnostics = artifactDiagnostics(`await artifact.file("${id}", "b.pdf");`);
    expect(diagnostics[0]?.message).toContain("the limit is 64");
  });

  it("rejects illegal characters", () => {
    const diagnostics = artifactDiagnostics(`await artifact.file("out/book pdf", "b.pdf");`);
    expect(diagnostics[0]?.message).toContain("[A-Za-z0-9_.-]");
  });

  it("accepts the legal character set", () => {
    expect(artifactDiagnostics(`await artifact.file("perf.p95_v2-final", "b.pdf");`)).toEqual([]);
  });

  it("rejects one id used with two kinds, pointing at the second", () => {
    const diagnostics = artifactDiagnostics(
      `await artifact.file("x", "b.pdf");\nawait artifact.markdown("x", "hi");`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.line).toBe(2);
    expect(diagnostics[0]?.message).toContain("two different kinds");
  });

  it("allows the same id republished with the same kind (that is a new version)", () => {
    expect(
      artifactDiagnostics(`await artifact.file("x", "a.pdf");\nawait artifact.file("x", "b.pdf");`),
    ).toEqual([]);
  });
});

describe("primary diagnostics (9009)", () => {
  it("rejects two different ids both marked primary, positioned on the second flag", () => {
    const diagnostics = artifactDiagnostics(
      `await artifact.file("book", "b.pdf", { primary: true });\n` +
        `await artifact.markdown("notes", "hi", { title: "Notes",\n  primary: true });`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe(ARTIFACT_PRIMARY_CONFLICT_CODE);
    expect(diagnostics[0]?.line).toBe(3);
    expect(diagnostics[0]?.message).toContain('"book" already is');
  });

  it("counts a preset's spec flag too", () => {
    const diagnostics = artifactDiagnostics(
      `artifact.board("b", { key: "id", status: "s", columns: ["x"], primary: true });\n` +
        `await artifact.file("book", "b.pdf", { primary: true });`,
    );
    expect(diagnostics.map((d) => d.code)).toEqual([ARTIFACT_PRIMARY_CONFLICT_CODE]);
  });

  it("allows the same id flagged twice (a new version of the deliverable)", () => {
    expect(
      artifactDiagnostics(
        `await artifact.file("x", "a.pdf", { primary: true });\nawait artifact.file("x", "b.pdf", { primary: true });`,
      ),
    ).toEqual([]);
  });

  it("ignores a computed or false flag — that half belongs to the engine", () => {
    expect(
      artifactDiagnostics(
        `const p = true;\nawait artifact.file("a", "a.pdf", { primary: p });\n` +
          `await artifact.file("b", "b.pdf", { primary: true });\nawait artifact.file("c", "c.pdf", { primary: false });`,
      ),
    ).toEqual([]);
  });
});

describe("preset hoisting diagnostics", () => {
  it("rejects a preset declared in a loop body", () => {
    const diagnostics = artifactDiagnostics(
      `for (const p of ["a"]) {\n  artifact.chart("perf", ${CHART});\n}`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe(ARTIFACT_HOISTING_CODE);
    expect(diagnostics[0]?.message).toContain("inside a loop");
  });

  it("rejects a preset declared inside a callback", () => {
    const diagnostics = artifactDiagnostics(
      `["a"].forEach(() => {\n  artifact.table("rows", { columns: [{ field: "n" }] });\n});`,
    );
    expect(diagnostics[0]?.code).toBe(ARTIFACT_HOISTING_CODE);
    expect(diagnostics[0]?.message).toContain("inside a callback");
  });

  it("rejects a preset declared inside a conditional branch", () => {
    const diagnostics = artifactDiagnostics(
      `if (args.deep) {\n  artifact.metrics("m", { metrics: [{ field: "p95" }] });\n}`,
    );
    expect(diagnostics[0]?.code).toBe(ARTIFACT_HOISTING_CODE);
    expect(diagnostics[0]?.message).toContain("conditional branch");
  });

  // Regression (2026-09-29, testfield): a fill's body is spliced into the hole(name, prompt, async () => {...})
  const BOARD = '{ key: "module", status: "status", columns: ["done", "concerns"] }';

  it("lets a fill declare a preset: the hole's body runs where the hole stands", () => {
    expect(
      artifactDiagnostics(
        `return await hole<number>("step 1 build", "p", async () => {\n` +
          `  artifact.board("modules", ${BOARD});\n` +
          `  report({ module: "lexer", status: "done" }, "modules");\n` +
          `  return 1;\n` +
          `});`,
      ),
    ).toEqual([]);
  });

  it("lets a fill nested in a tail chain declare a preset too", () => {
    expect(
      artifactDiagnostics(
        `return await hole<number>("step 1 build", "p", async () => {\n` +
          `  return await hole<number>("step 2 review", "q", async () => {\n` +
          `    artifact.chart("perf", ${CHART});\n` +
          `    return 2;\n` +
          `  });\n` +
          `});`,
      ),
    ).toEqual([]);
  });

  it("still sees the loop around a hole whose fill declares a preset", () => {
    const diagnostics = artifactDiagnostics(
      `for (const p of ["a", "b"]) {\n` +
        `  await hole<void>("per-lap policy", p, async () => {\n` +
        `    artifact.board("modules", ${BOARD});\n` +
        `  });\n` +
        `}`,
    );
    expect(diagnostics.map((d) => d.code)).toEqual([ARTIFACT_HOISTING_CODE]);
    expect(diagnostics[0]?.message).toContain("inside a loop");
  });

  it("still flags a real callback inside a fill", () => {
    const diagnostics = artifactDiagnostics(
      `return await hole<number>("step 1 build", "p", async () => {\n` +
        `  ["a"].forEach(() => {\n    artifact.board("modules", ${BOARD});\n  });\n` +
        `  return 1;\n` +
        `});`,
    );
    expect(diagnostics.map((d) => d.code)).toEqual([ARTIFACT_HOISTING_CODE]);
    expect(diagnostics[0]?.message).toContain("inside a callback");
  });

  it("leaves content members alone in loops and branches (a new version per round is the point)", () => {
    expect(
      artifactDiagnostics(
        `for (const p of ["a"]) {\n  await artifact.file("book", "b.pdf");\n}\n` +
          `if (args.x) { await artifact.markdown("notes", "hi"); }`,
      ),
    ).toEqual([]);
  });

  it("accepts a top-level preset declaration fed from inside a loop", () => {
    expect(
      artifactDiagnostics(
        `artifact.chart("perf", ${CHART});\nfor (const p of ["a"]) {\n  report({ round: 1 }, "perf");\n}`,
      ),
    ).toEqual([]);
  });
});

describe("report tag diagnostics", () => {
  it("rejects a non-literal tag", () => {
    const diagnostics = artifactDiagnostics(
      `artifact.chart("perf", ${CHART});\nconst t = "perf";\nreport({ a: 1 }, t);`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.line).toBe(3);
    expect(diagnostics[0]?.message).toContain("compile-time string literal");
  });

  it("rejects a tag naming no declared preset, and lists the ones that exist", () => {
    const diagnostics = artifactDiagnostics(
      `artifact.chart("perf", ${CHART});\nreport({ a: 1 }, "nope");`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain('declared presets: "perf"');
  });

  it("says so plainly when the script declares no presets at all", () => {
    const diagnostics = artifactDiagnostics(`report({ a: 1 }, "perf");`);
    expect(diagnostics[0]?.message).toContain("no preset artifacts at all");
  });

  it("rejects a tag naming a content artifact", () => {
    const diagnostics = artifactDiagnostics(
      `await artifact.markdown("doc", "# hi");\nreport({ a: 1 }, "doc");`,
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toContain("holds content rather than a stream of items");
  });

  it("accepts a tag declared later in the text (order is a run-time matter)", () => {
    expect(
      artifactDiagnostics(`report({ a: 1 }, "perf");\nartifact.chart("perf", ${CHART});`),
    ).toEqual([]);
  });

  it("leaves untagged reports alone", () => {
    expect(artifactDiagnostics(`report({ a: 1 });`)).toEqual([]);
  });
});

describe("declaredArtifacts", () => {
  it("is deduplicated and sorted by id", () => {
    const analyzed = analyzeWorkflowScript(
      [
        `artifact.chart("perf", ${CHART});`,
        `artifact.chart("perf", ${CHART});`,
        `await artifact.file("book", "b.pdf");`,
        `await artifact.file("book", "b2.pdf");`,
        `artifact.board("kanban", { key: "id", status: "s", columns: ["a"] });`,
      ].join("\n"),
    );
    expect(analyzed.ok).toBe(true);
    expect(analyzed.declaredArtifacts).toEqual([
      { id: "book", kind: "file" },
      { id: "kanban", kind: "board" },
      { id: "perf", kind: "chart" },
    ]);
  });

  it("is empty for a script with no artifacts, and for one that does not compile", () => {
    expect(analyzeWorkflowScript(`log("hi");`).declaredArtifacts).toEqual([]);
    expect(analyzeWorkflowScript(`const x: number = "no";`).declaredArtifacts).toEqual([]);
  });

  it("comes straight off the site table, so collectArtifactDeclarations is usable alone", () => {
    const { table, workflow } = sites(`await artifact.file("book", "b.pdf");`);
    const { declaredArtifacts, diagnostics } = collectArtifactDeclarations(workflow, table);
    expect(diagnostics).toEqual([]);
    expect(declaredArtifacts).toEqual([{ id: "book", kind: "file" }]);
  });
});

/**
 * Where diagnostics land (2026-09-04 ruling): artifact diagnostics must ride the same authoring channel as
 *
 * the world.run non-literal-cmd diagnostics: the analyzeWorkflowScript {ok, diagnostics} channel.
 * It has three consumers over the same core analyzeScript(...): the CreateWorkflow handler (!ok renders
 * each diagnostic as L{line}:C{column} {message} for the model to fix, without executing), SaveWorkflow
 * (!ok skips the write), and hub direct-launch (!ok or any diagnostic -> compile_failed). Collected is not
 * seen: ok must clear and diagnostics must carry positions. Both pinned beside the world.run precedent.
 */
describe("authoring diagnostics channel", () => {
  const BAD_ARTIFACT = `const id = "book";\nawait artifact.file(id, "b.pdf");`;
  const BAD_WORLD_RUN = `const cmd = "lean";\nawait world.run(cmd, []);`;

  it("clears ok and surfaces the diagnostic, exactly like a non-literal world.run cmd", () => {
    const artifactRun = analyzeWorkflowScript(BAD_ARTIFACT);
    const worldRun = analyzeWorkflowScript(BAD_WORLD_RUN);
    expect(artifactRun.ok).toBe(worldRun.ok);
    expect(artifactRun.ok).toBe(false);
    expect(artifactRun.diagnostics).toHaveLength(1);
    expect(artifactRun.diagnostics[0]?.code).toBe(ARTIFACT_DECLARATION_CODE);
  });

  it("positions every artifact diagnostic, so the model-facing render has a line and column", () => {
    const scripts = [
      BAD_ARTIFACT,
      `await artifact.file("", "b.pdf");`,
      `await artifact.file("a b", "b.pdf");`,
      `await artifact.file("x", "a.pdf");\nawait artifact.markdown("x", "hi");`,
      `report({ a: 1 }, "perf");`,
      `for (const p of ["a"]) {\n  artifact.chart("perf", ${CHART});\n}`,
    ];
    for (const script of scripts) {
      const analyzed = analyzeWorkflowScript(script);
      expect(analyzed.ok).toBe(false);
      expect(analyzed.diagnostics.length).toBeGreaterThan(0);
      for (const diagnostic of analyzed.diagnostics) {
        expect(diagnostic.line).toBeGreaterThan(0);
        expect(diagnostic.column).toBeGreaterThan(0);
        expect(diagnostic.message.length).toBeGreaterThan(0);
      }
    }
  });

  it("withholds the graphs, like the other authoring rules", () => {
    const analyzed = analyzeWorkflowScript(BAD_ARTIFACT);
    expect(analyzed.causality).toBeUndefined();
    expect(analyzed.graph).toBeUndefined();
    // The list itself still renders (read straight off the site table, no interpretation) -- this one id is unreadable.
    expect(analyzed.declaredArtifacts).toEqual([]);
  });

  it("still reports artifact diagnostics alongside the other authoring families", () => {
    const analyzed = analyzeWorkflowScript(
      [
        `const cmd = "lean";`,
        `await world.run(cmd, []);`,
        `await artifact.file("a b", "b.pdf");`,
        `phase(cmd);`,
      ].join("\n"),
    );
    expect(analyzed.ok).toBe(false);
    // One pass, every finding: the author sees the full fix list at once (same reasoning as world.run/phase).
    const codes = new Set(analyzed.diagnostics.map((d) => d.code));
    expect(codes.has(ARTIFACT_DECLARATION_CODE)).toBe(true);
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe("artifact facade siting", () => {
  it("rejects taking a reference to a facade artifact member", () => {
    const analyzed = analyzeWorkflowScript(`const publish = artifact.file;\nlog("x");`);
    expect(analyzed.ok).toBe(false);
    expect(analyzed.diagnostics[0]?.code).toBe(FACADE_SITING_CODE);
    expect(analyzed.diagnostics[0]?.message).toContain("'file'");
  });

  it("still allows a direct call", () => {
    expect(analyzeWorkflowScript(`await artifact.file("book", "b.pdf");`).ok).toBe(true);
  });
});
