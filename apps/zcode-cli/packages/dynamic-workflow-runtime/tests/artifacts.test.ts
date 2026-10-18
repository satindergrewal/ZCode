/**
 * User-facing artifacts (docs/dynamic-workflow/authoring.md) cross the whole pipeline: real script -> lowering -> sandbox
 * child -> NDJSON wire protocol -> engine core -> driver. This file pins the wire-protocol segment: which channel each family takes,
 * whether tags cross, and whether rejections are catchable.
 *
 * Terminology: artifact here is the user-facing product; settlement.artifact is the script's top-level return --
 * one word, two senses in one file -- exactly why the spec keeps a terminology table.
 */

import { describe, expect, it } from "vitest";
import { WorkflowError, type ArtifactVersionRecord } from "@zcode/dynamic-workflow";
import { runScript } from "./helpers.js";

const RUN = "run";
const CHART = '{ x: { field: "round" }, y: { field: "ms" } }';

describe("e2e -- predeclared artifacts and tagged reports", () => {
  it("declarations arrive first via the event channel and every tagged report lands on that id", async () => {
    const script = [
      `artifact.chart("perf", ${CHART});`,
      "for (const round of [1, 2, 3]) {",
      '  report({ round, ms: round * 10 }, "perf");',
      "}",
      "return { rounds: 3 };",
    ].join("\n");

    const { settlement, journal, driver } = await runScript(script);
    expect(settlement.status).toBe("completed");

    // The declaration journals an artifact node with artifact_id and spec.
    const declaration = journal.getNode(RUN, "artifact#1", 1);
    expect(declaration?.kind).toBe("artifact");
    expect(declaration?.artifactId).toBe("perf");
    expect((declaration?.result as ArtifactVersionRecord | undefined)?.kind).toBe("chart");

    // All three report rows carry the same artifact_id -- where board-equals-journal-projection lands.
    const reports = journal
      .listNodes(RUN, { kinds: "all", withResult: true })
      .filter((node) => node.kind === "report");
    expect(reports.map((node) => node.artifactId)).toEqual(["perf", "perf", "perf"]);
    expect(driver.eventsOfType("report").map((event) => event.artifactId)).toEqual([
      "perf",
      "perf",
      "perf",
    ]);

    // Event order: artifact-published precedes the first report (one shared FIFO event channel).
    const types = driver.events.map((event) => event.type);
    expect(types.indexOf("artifact-published")).toBeLessThan(types.indexOf("report"));
  });

  it("redeclaring the same spec is an idempotent no-op and the run completes", async () => {
    const script = [
      `artifact.chart("perf", ${CHART});`,
      `artifact.chart("perf", ${CHART});`,
      "return 1;",
    ].join("\n");
    const { settlement, driver, journal } = await runScript(script);
    expect(settlement.status).toBe("completed");
    expect(driver.eventsOfType("artifact-published")).toHaveLength(1);
    expect(
      journal
        .listNodes(RUN, { kinds: "all", withResult: true })
        .filter((node) => node.kind === "artifact"),
    ).toHaveLength(1);
  });

  it("a tag naming an undeclared id fails the run (void returns have no rejection channel)", async () => {
    const { settlement } = await runScript(`report({ a: 1 }, "perf");\nreturn 1;`);
    expect(settlement.status).toBe("errored");
    if (settlement.status !== "errored") return;
    expect(settlement.error.code).toBe("ArtifactUndeclared");
  });
});

describe("e2e -- content artifacts", () => {
  it("crosses via request/response with positional args and the ref returns to the script", async () => {
    const script = [
      'const ref = await artifact.file("book", "out/book.pdf", { title: "Book" });',
      'const notes = await artifact.markdown("notes", "# hi");',
      "return { id: ref.id, version: ref.version, notes: notes.id };",
    ].join("\n");

    const { settlement, driver, journal } = await runScript(script);
    expect(settlement).toEqual({
      status: "completed",
      artifact: { id: "book", version: 1, notes: "notes" },
    });

    expect(driver.artifactPublishes.map((r) => [r.op, r.id, r.version, r.path, r.content])).toEqual(
      [
        ["file", "book", 1, "out/book.pdf", undefined],
        ["markdown", "notes", 1, undefined, "# hi"],
      ],
    );
    expect(driver.artifactPublishes[0]?.opts).toEqual({ title: "Book" });
    expect(journal.getNode(RUN, "artifact#1", 1)?.status).toBe("completed");
    expect(driver.eventsOfType("artifact-published").map((e) => e.artifact.id)).toEqual([
      "book",
      "notes",
    ]);
  });

  it("re-publishing the same id yields a new version", async () => {
    const script = [
      'const a = await artifact.markdown("notes", "one");',
      'const b = await artifact.markdown("notes", "two");',
      "return [a.version, b.version];",
    ].join("\n");
    const { settlement } = await runScript(script);
    expect(settlement).toEqual({ status: "completed", artifact: [1, 2] });
  });

  it("driver rejections cross as structured errors the script catches and continues", async () => {
    const script = [
      'let code = "none";',
      "try {",
      '  await artifact.file("book", "out/missing.pdf");',
      "} catch (e) {",
      '  code = (e as { code?: string }).code ?? "no-code";',
      "}",
      "return code;",
    ].join("\n");

    const { settlement, journal, driver } = await runScript(script, {
      artifacts: () => {
        throw new WorkflowError("ArtifactSourceMissing", "out/missing.pdf does not exist");
      },
    });
    // The gating idiom works: the script gets the structured code and the run completes.
    expect(settlement).toEqual({ status: "completed", artifact: "ArtifactSourceMissing" });
    expect(journal.getNode(RUN, "artifact#1", 1)?.status).toBe("failed");
    expect(journal.getNode(RUN, "artifact#1", 1)?.error?.code).toBe("ArtifactSourceMissing");
    // Failure rides artifact-failed, never posing as a node settlement (artifact sites have no graph node).
    expect(driver.eventsOfType("artifact-failed").map((e) => [e.id, e.op, e.error.code])).toEqual([
      ["book", "file", "ArtifactSourceMissing"],
    ]);
    expect(driver.eventsOfType("node-settled")).toEqual([]);
  });

  it("mixes with asks: the subagent-written path is handed over by the script", async () => {
    const script = [
      'const writer = agent("writer");',
      'const path = await writer.ask("write the book");',
      'const ref = await artifact.file("book", path, { title: "Book" });',
      "return ref.version;",
    ].join("\n");

    const { settlement, driver } = await runScript(script, {
      asks: { "ask#1": () => ({ type: "text", finalText: "out/book.pdf" }) },
    });
    expect(settlement).toEqual({ status: "completed", artifact: 1 });
    expect(driver.artifactPublishes[0]?.path).toBe("out/book.pdf");
  });
});
