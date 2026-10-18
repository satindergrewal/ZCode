import { describe, expect, it } from "vitest";
import {
  AMEND_WORKFLOW_TOOL_NAME,
  AmendWorkflowInputJsonSchema,
  AmendWorkflowInputSchema,
} from "../src/tools/amend-workflow.js";

// docs/dynamic-workflow/launch.md "The `AmendWorkflow` tool": only run_id is required on the
// model surface; every omitted field inherits the predecessor (script included, see "Keeping
// the predecessor's script"). `predecessor` is a fact block backfilled by resolveInput - the
// runtime schema accepts it, the model-facing JSON schema omits it.
describe("AmendWorkflowInputSchema", () => {
  const SCRIPT = 'return await agent("a").ask<string>("go");';

  it("names the tool and accepts the model-facing shape", () => {
    expect(AMEND_WORKFLOW_TOOL_NAME).toBe("AmendWorkflow");
    const input = { run_id: "dwfrun-prev", script: SCRIPT };
    expect(AmendWorkflowInputSchema.parse(input)).toEqual(input);
    expect(AmendWorkflowInputSchema.parse({ ...input, name: "second pass" })).toEqual({
      ...input,
      name: "second pass",
    });
  });

  it("accepts the resolved predecessor block and rejects a malformed one", () => {
    const resolved = {
      run_id: "dwfrun-prev",
      script: SCRIPT,
      predecessor: { name: "triage", status: "running", owned_by_this_session: true },
    };
    expect(AmendWorkflowInputSchema.parse(resolved)).toEqual(resolved);
    expect(
      AmendWorkflowInputSchema.safeParse({
        ...resolved,
        predecessor: { status: "stopped", stop_reason: "superseded", owned_by_this_session: false },
      }).success,
    ).toBe(true);
    expect(
      AmendWorkflowInputSchema.safeParse({ ...resolved, predecessor: { status: "flying" } })
        .success,
    ).toBe(false);
  });

  // A script-less call returns from resolveInput with the predecessor script plus this flag; presence-only boolean.
  it("accepts script_inherited on the resolved predecessor, only as true", () => {
    const resolved = {
      run_id: "dwfrun-prev",
      script: SCRIPT,
      predecessor: { status: "completed", owned_by_this_session: true, script_inherited: true },
    };
    expect(AmendWorkflowInputSchema.parse(resolved)).toEqual(resolved);
    expect(
      AmendWorkflowInputSchema.safeParse({
        ...resolved,
        predecessor: { ...resolved.predecessor, script_inherited: false },
      }).success,
    ).toBe(false);
  });

  // Subagent-selection three-state (docs/dynamic-workflow/launch.md): omit = inherit, null =
  // session model, string = set. The runtime schema takes all three; folding into one canonical
  // string is resolveInput's job.
  it("accepts the three states of subagent_model and rejects a blank string", () => {
    const input = { run_id: "dwfrun-prev", script: SCRIPT };
    expect(AmendWorkflowInputSchema.parse(input)).toEqual(input);
    expect(AmendWorkflowInputSchema.parse({ ...input, subagent_model: null })).toEqual({
      ...input,
      subagent_model: null,
    });
    expect(
      AmendWorkflowInputSchema.parse({ ...input, subagent_model: "  zhipu/glm-5.3  " }),
    ).toEqual({ ...input, subagent_model: "zhipu/glm-5.3" });
    expect(AmendWorkflowInputSchema.safeParse({ ...input, subagent_model: "   " }).success).toBe(
      false,
    );
  });

  it("requires run_id, leaves script optional, and rejects the legacy resume_from spelling", () => {
    expect(AmendWorkflowInputSchema.safeParse({ script: SCRIPT }).success).toBe(false);
    // Omitted script = the predecessor's: a settings-only amendment need not re-copy the whole script.
    expect(AmendWorkflowInputSchema.parse({ run_id: "dwfrun-prev" })).toEqual({
      run_id: "dwfrun-prev",
    });
    expect(AmendWorkflowInputSchema.parse({ run_id: "dwfrun-prev", max_concurrency: 2 })).toEqual({
      run_id: "dwfrun-prev",
      max_concurrency: 2,
    });
    // If given, it must be a script: an empty string is not "omitted".
    expect(AmendWorkflowInputSchema.safeParse({ run_id: "dwfrun-prev", script: "" }).success).toBe(
      false,
    );
    expect(AmendWorkflowInputSchema.safeParse({ run_id: "", script: SCRIPT }).success).toBe(false);
    expect(
      AmendWorkflowInputSchema.safeParse({
        run_id: "dwfrun-prev",
        script: SCRIPT,
        resume_from: "x",
      }).success,
    ).toBe(false);
  });

  // docs/dynamic-workflow/launch.md "Script files": at most one amendment script (`path` is
  // the common case; neither given = the predecessor's script). "Not both" lives in
  // `validateInput`, not the schema - post-normalization, `script` and `path` coexisting is
  // a legal execution state, so the runtime schema must allow either or both.
  it("takes the revision either inline or as a file, and carries the resolved line offset", () => {
    const byPath = { run_id: "dwfrun-prev", path: ".zcode/workflow-drafts/x.dwf.ts" };
    expect(AmendWorkflowInputSchema.parse(byPath)).toEqual(byPath);
    // Neither given is legal: the predecessor's script is kept (Keeping the predecessor's script).
    expect(AmendWorkflowInputSchema.safeParse({ run_id: "dwfrun-prev" }).success).toBe(true);
    const resolved = { ...byPath, script: SCRIPT, script_line_offset: 4 };
    expect(AmendWorkflowInputSchema.parse(resolved)).toEqual(resolved);
    expect(AmendWorkflowInputSchema.safeParse({ ...byPath, script_line_offset: -1 }).success).toBe(
      false,
    );
  });

  it("keeps predecessor out of the model-facing JSON schema", () => {
    const schema = AmendWorkflowInputJsonSchema as {
      properties?: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
    // `max_concurrency` and `subagent_model` are the model-visible fourth and fifth fields
    // （docs/dynamic-workflow/concurrency.md「Two bounds on a run」、docs/dynamic-workflow/launch.md）；
    // `predecessor` is still overwritten by resolveInput, out of the schema.
    expect(Object.keys(schema.properties ?? {}).sort()).toEqual([
      "max_concurrency",
      "name",
      "path",
      "run_id",
      "script",
      "subagent_model",
    ]);
    // `run_id` is the sole required field: at-most-one-source is validateInput's job; a schema cannot express the refinement.
    expect(schema.required).toEqual(["run_id"]);
    expect(schema.required).not.toContain("name");
    // The backfilled line offset shares `predecessor`'s posture: runtime accepts, model surface omits.
    expect(Object.keys(schema.properties ?? {})).not.toContain("script_line_offset");
    expect(schema.additionalProperties).toBe(false);
  });
});
