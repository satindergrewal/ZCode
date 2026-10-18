import { describe, expect, it } from "vitest";
import {
  FILL_WORKFLOW_HOLE_TOOL_NAME,
  FillWorkflowHoleInputJsonSchema,
  FillWorkflowHoleInputSchema,
  FillWorkflowHoleOutputSchema,
  isFillWorkflowHoleOwnedRun,
} from "../src/tools/fill-workflow-hole.js";
import { CreateWorkflowOutputSchema } from "../src/tools/create-workflow.js";
import { GetWorkflowRunOutputSchema } from "../src/tools/get-workflow-run.js";

// docs/dynamic-workflow/launch.md "The \`FillWorkflowHole\` tool": model surface is run_id +
// hole_id + exactly one source (script / path); \`hole\` is a fact block backfilled by resolveInput -
// runtime schema accepts it, the model-facing JSON schema omits it (same posture as
// AmendWorkflow's \`predecessor\`).
describe("FillWorkflowHoleInputSchema", () => {
  const BODY = 'const verdict = await agent("judge").ask<string>("judge it");\nreturn verdict;';

  it("names the tool and accepts the two model-facing shapes", () => {
    expect(FILL_WORKFLOW_HOLE_TOOL_NAME).toBe("FillWorkflowHole");
    const inline = { run_id: "dwfrun-1", hole_id: "hole#1", script: BODY };
    expect(FillWorkflowHoleInputSchema.parse(inline)).toEqual(inline);
    const file = {
      run_id: "dwfrun-1",
      hole_id: "hole#1",
      path: ".zcode/workflow-drafts/a.verdict.dwf.ts",
    };
    expect(FillWorkflowHoleInputSchema.parse(file)).toEqual(file);
  });

  it("requires run_id and hole_id and rejects unknown keys", () => {
    expect(FillWorkflowHoleInputSchema.safeParse({ hole_id: "hole#1", script: BODY }).success).toBe(
      false,
    );
    expect(
      FillWorkflowHoleInputSchema.safeParse({ run_id: "dwfrun-1", script: BODY }).success,
    ).toBe(false);
    expect(
      FillWorkflowHoleInputSchema.safeParse({
        run_id: "dwfrun-1",
        hole_id: "hole#1",
        script: BODY,
        body: BODY,
      }).success,
    ).toBe(false);
    expect(
      FillWorkflowHoleInputSchema.safeParse({ run_id: "dwfrun-1", hole_id: "hole#1", script: "" })
        .success,
    ).toBe(false);
  });

  it("accepts the resolved hole block and rejects a malformed one", () => {
    const resolved = {
      run_id: "dwfrun-1",
      hole_id: "hole#1",
      script: BODY,
      hole: {
        name: "grouping",
        type: "Verdict",
        draft_path: "/repo/.zcode/workflow-drafts/triage.dwf.ts",
        line: 12,
        owned_by_this_session: true,
      },
    };
    expect(FillWorkflowHoleInputSchema.parse(resolved)).toEqual(resolved);
    expect(
      FillWorkflowHoleInputSchema.safeParse({
        ...resolved,
        hole: { name: "grouping", type: "Verdict", owned_by_this_session: false },
      }).success,
    ).toBe(true);
    expect(
      FillWorkflowHoleInputSchema.safeParse({ ...resolved, hole: { name: "grouping" } }).success,
    ).toBe(false);
  });

  it("does not list the hole block in the model-facing JSON schema", () => {
    const json = FillWorkflowHoleInputJsonSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      "hole_id",
      "path",
      "run_id",
      "script",
    ]);
    expect(json.required?.sort()).toEqual(["hole_id", "run_id"]);
  });

  it("shares CreateWorkflow's output schema so the display rides the fill row", () => {
    expect(FillWorkflowHoleOutputSchema).toBe(CreateWorkflowOutputSchema);
  });
});

// Confirmation-exempt owner rule (docs/dynamic-workflow/launch.md "Approval"): lives in the
// contract like AmendWorkflow's predicate; permission service and handler read the same one.
describe("isFillWorkflowHoleOwnedRun", () => {
  it("is true only for a hole block that says owned_by_this_session", () => {
    expect(isFillWorkflowHoleOwnedRun({ name: "n", type: "T", owned_by_this_session: true })).toBe(
      true,
    );
    expect(isFillWorkflowHoleOwnedRun({ name: "n", type: "T", owned_by_this_session: false })).toBe(
      false,
    );
    expect(isFillWorkflowHoleOwnedRun({ name: "n", type: "T", owned_by_this_session: "yes" })).toBe(
      false,
    );
    expect(isFillWorkflowHoleOwnedRun(undefined)).toBe(false);
    expect(isFillWorkflowHoleOwnedRun(null)).toBe(false);
  });
});

// GetWorkflowRun's \`holes\` follows pendingQuestions' rule: absent when none, <=32, strict fields.
describe("GetWorkflowRunOutputSchema.holes", () => {
  const base = {
    runId: "dwfrun-1",
    label: "triage",
    labelSource: "name",
    status: "running",
    ownedByThisSession: true,
    createdAt: 1,
    updatedAt: 2,
    generatedAt: 3,
    summary: "Running.",
    usage: { spentTokens: 0, nodesObserved: 0, nodesRunning: 0, nodesCompleted: 0, nodesFailed: 0 },
    actors: [],
    logTail: [],
    subagents: [],
    health: { consecutiveFailures: 0, cachedSteps: 0, pendingQuestionsKnown: true },
  };

  it("accepts waiting and filled holes", () => {
    const holes = [
      {
        siteId: "hole#1",
        ordinal: 1,
        name: "grouping",
        type: "Verdict",
        state: "waiting",
        since: 10,
      },
      {
        siteId: "hole#2",
        ordinal: 1,
        name: "wrapup",
        type: "string",
        state: "filled",
        filledAt: 20,
        filledBy: "sess_a",
      },
    ];
    expect(GetWorkflowRunOutputSchema.parse({ ...base, holes })).toMatchObject({ holes });
    expect(
      GetWorkflowRunOutputSchema.safeParse({ ...base, holes: [{ ...holes[0], state: "open" }] })
        .success,
    ).toBe(false);
  });
});

// Recursive holes: a filled body may itself hole, site ids like \`hole#1/hole#1\` (deeper too).
// Input only requires non-empty ids and no regex may refuse \`/\` - the model must be able to
// copy the notification's id verbatim.
describe("FillWorkflowHoleInputSchema — nested hole ids", () => {
  it("accepts nested site ids verbatim", () => {
    for (const id of ["hole#1/hole#1", "hole#1/hole#1/hole#2", "hole#3/hole#1/hole#1/hole#1"]) {
      const input = { run_id: "dwfrun-1", hole_id: id, script: "return 1;" };
      expect(FillWorkflowHoleInputSchema.parse(input)).toEqual(input);
    }
  });
});

describe("CreateWorkflowOutputSchema.fill (the block the fill row names itself by)", () => {
  const base = { diagnostics: [], ok: true, response: "joined" };
  it("site id + name pass strict; draft path/line optional; unknown keys and empty name refused; absent passes", () => {
    expect(CreateWorkflowOutputSchema.safeParse(base).success).toBe(true);
    expect(
      CreateWorkflowOutputSchema.safeParse({
        ...base,
        fill: { siteId: "hole#1", name: "grouping" },
      }).success,
    ).toBe(true);
    expect(
      CreateWorkflowOutputSchema.safeParse({
        ...base,
        fill: {
          siteId: "hole#1/hole#1",
          name: "step2",
          draftPath: "/w/.zcode/workflow-drafts/a.dwf.ts",
          line: 61,
        },
      }).success,
    ).toBe(true);
    expect(
      CreateWorkflowOutputSchema.safeParse({ ...base, fill: { siteId: "hole#1", name: "" } })
        .success,
    ).toBe(false);
    expect(
      CreateWorkflowOutputSchema.safeParse({
        ...base,
        fill: { siteId: "hole#1", name: "x", type: "T" },
      }).success,
    ).toBe(false);
  });
});
