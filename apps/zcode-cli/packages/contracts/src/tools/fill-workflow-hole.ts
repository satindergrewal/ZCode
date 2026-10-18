// ============================================================
// FillWorkflowHole Tool - fill a waiting hole's function body
// ============================================================
// docs/dynamic-workflow/launch.md "The `FillWorkflowHole` tool"; engine side
// apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md "Holes"; the port method
// `DynamicWorkflowRunPort.fillHole`（interfaces/dynamic-workflow-run.port.ts）。
//
// Why a separate tool from AmendWorkflow: filling **starts nothing** - the run keeps its id,
// journal, and subagents; the model's snippet simply grows at the hole. Output shares one shape
// with CreateWorkflow / AmendWorkflow so the valid script's display payload rides the tool row
// as on launch, and the run card takes the latest under its run id.

import { z } from "zod";
import { CreateWorkflowOutputJsonSchema, CreateWorkflowOutputSchema } from "./create-workflow.js";
import { toToolJsonSchema } from "./json-schema.js";

export const FILL_WORKFLOW_HOLE_TOOL_NAME = "FillWorkflowHole";

/**
 * Violation copy for "exactly one body source". Same slot and tone as
 * `CREATE_WORKFLOW_SOURCE_ERROR`; unlike AmendWorkflow, giving neither is **also** a violation
 * here - there is no body to inherit.
 */
export const FILL_WORKFLOW_HOLE_SOURCE_ERROR =
  "Provide exactly one body source: `script` for the hole's statements written inline, or `path` for a file holding them (usually the fill file a rejected attempt was saved to). Passing both, or neither, is ambiguous.";

/**
 * Model-facing input. `hole` is not here - a fact backfilled by resolveInput (below), absent
 * from the model's JSON schema.
 */
const FillWorkflowHoleModelInputSchema = z.object({
  run_id: z
    .string()
    .min(1)
    .describe("ID of the run that is waiting at the hole (from the hole notification)."),
  hole_id: z
    .string()
    .min(1)
    .describe(
      "The hole's site id from the notification or from GetWorkflowRun's holes, e.g. `hole#21b40fca`.",
    ),
  /**
   * The body is **statements only**: no `hole(...)` call, no arrow, none of the surrounding
   * script. The tool splices it into the run's stored script as the hole's body and compiles
   * wholesale (docs/dynamic-workflow/launch.md "Input and output").
   */
  script: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The body: only the statements of the hole's function, inline. This OR `path`, never both. It is compiled where the hole stands and sees every binding declared before it; it must return the hole's type.",
    ),
  /**
   * The return path of a refused attempt ("The fill file"): an inline submission is written to
   * the fill file, diagnostics carry that file's line numbers, and the next try edits one line
   * and hands the same path back.
   */
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "A file holding those statements — usually the fill file named by a rejected attempt, edited in place. This OR `script`, never both.",
    ),
});

/**
 * Hole facts backfilled by resolveInput
 * (docs/dynamic-workflow/launch.md "Approval").
 *
 * Both the permission decision (this session's runs skip confirmation) and the confirm dialog
 * (hole name and type, draft path) read it; both precede the handler and must agree - so
 * resolveInput (async, the flow's single port read) computes it into the input. Normalization
 * **unconditionally overwrites**: a model-forged copy is invalid (same precedent as
 * AmendWorkflow's `predecessor`).
 *
 * `owned_by_this_session` folded into the second amend condition: the run is this session's
 * **and** not user-stopped. A user-stopped run cannot still wait at a hole, so in practice the
 * bit is false only via ownership.
 */
export const FillWorkflowHoleHoleSchema = z
  .object({
    /** The hole's literal name (the `"grouping"` of `hole<T>("grouping", ...)`). */
    name: z.string().min(1),
    /** Type argument verbatim (`Verdict`, `string[]`), as written in the script. */
    type: z.string().min(1),
    /** The run's draft file (absolute); absent when the run recorded none. */
    draft_path: z.string().min(1).optional(),
    /** Line of the hole call in the draft (1-based); absent when unreadable. */
    line: z.number().int().positive().optional(),
    owned_by_this_session: z.boolean(),
  })
  .strict();

export type FillWorkflowHoleHole = z.infer<typeof FillWorkflowHoleHoleSchema>;

/**
 * "This run is this session's, and not user-stopped" - the confirmation-exempt owner rule
 * (docs/dynamic-workflow/launch.md "Approval", reading the "Amending this session's runs" clause).
 *
 * Same argument as `isAmendWorkflowOwnedPredecessor`: lives in the contract so the permission
 * service and handler read one predicate. Takes `unknown`: the service sees not-yet-parsed
 * input, the handler the resolved fact block.
 */
export function isFillWorkflowHoleOwnedRun(hole: unknown): boolean {
  if (!hole || typeof hole !== "object") return false;
  return (hole as Record<string, unknown>).owned_by_this_session === true;
}

/**
 * Runtime input: the model-facing keys + backfilled `hole`. `.strict()`: any legacy spelling
 * is a visible error here. After normalization `script` (the body bytes) and `path` may both
 * be present - a `path` submit resolves into `script` and keeps the path as provenance, the
 * same "read once, only once" discipline as AmendWorkflow.
 */
export const FillWorkflowHoleInputSchema = FillWorkflowHoleModelInputSchema.extend({
  hole: FillWorkflowHoleHoleSchema.optional(),
}).strict();

export type FillWorkflowHoleInput = z.infer<typeof FillWorkflowHoleInputSchema>;

/** JSON schema for the model: no `hole`. */
export const FillWorkflowHoleInputJsonSchema = toToolJsonSchema(
  FillWorkflowHoleModelInputSchema.strict(),
);

/**
 * The output **is** `CreateWorkflowOutput` (the same schema object, not a copy): the display
 * payload is therefore protocol-identical to a launch row, and the UI's CreateWorkflow row
 * renderer picks this tool's rows by tool name. Filling starts nothing, so
 * `status: "backgrounded"` and `backgroundTaskId` are always absent here.
 */
export const FillWorkflowHoleOutputSchema = CreateWorkflowOutputSchema;
export type FillWorkflowHoleOutput = z.infer<typeof FillWorkflowHoleOutputSchema>;
export const FillWorkflowHoleOutputJsonSchema = CreateWorkflowOutputJsonSchema;
