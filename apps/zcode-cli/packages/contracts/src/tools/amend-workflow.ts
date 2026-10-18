// ============================================================
// AmendWorkflow Tool - revise a run: stop it if it is still going, import its finished work, start the revision
// ============================================================
//
// Why a separate tool from CreateWorkflow: amending is a different action and a different card -- the model is not
// starting something but changing something the user is watching, and the predecessor may still be running. Both share one output shape, so the
// executor's background tracking, the backgrounded contract, and the display payload exist only once.

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import {
  WORKFLOW_RUN_LIFECYCLE_STATUSES,
  WORKFLOW_RUN_STOP_REASONS,
} from "./list-workflow-runs.js";

export const AMEND_WORKFLOW_TOOL_NAME = "AmendWorkflow";

/**
  * Violation note for at-most-one-amendment-script. Same spot, same tone as CREATE_WORKFLOW_SOURCE_ERROR;
  * unlike it, providing neither is **legal** here -- that means keep the predecessor's script.
 */
export const AMEND_WORKFLOW_SOURCE_ERROR =
  "Provide at most one revised script: `path` for the script file you edited (the usual form), or `script` for the whole revised script inline. Passing both is ambiguous; omit both to keep the predecessor's script unchanged.";

/**
  * Model-facing input. Only run_id is required; every other field follows one rule: **omit to inherit from the predecessor**. predecessor is not
  * listed here -- it is a resolveInput-backfilled fact (below), absent from the model's JSON schema.
 */
const AmendWorkflowModelInputSchema = z.object({
  run_id: z
    .string()
    .min(1)
    .describe(
      "ID of the run to amend (from a result, a notification, GetWorkflowRun or ListWorkflowRuns).",
    ),
  /**
      * Omitting both script and path = keep the predecessor's archived script:
      * a settings-only amendment need not re-paste a multi-thousand-token script. Same lifecycle as the two settings -- resolveInput reads the
      * predecessor's script back in and stamps predecessor.script_inherited; from then on hook, confirmation dialog, and handler all see one
      * script. The runtime schema must still accept absence: after hook rewrites, call-runner revalidates the model's original shape.
   */
  script: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The whole revised script, inline. This OR `path`, never both; omit both to keep the predecessor's script.",
    ),
  /**
      * The everyday amendment source: edit one line of the predecessor's script in place,
      * then hand back the same path. Inline is still accepted, but it re-streams the whole script -- exactly what this path exists to avoid.
   */
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The revised script's file, usually the predecessor's own script file edited in place. This OR `script`, never both.",
    ),
  name: z
    .string()
    .min(1)
    .optional()
    .describe("Display label for the new run; defaults to the predecessor's."),
  /**
      * Three states: omitted = keep the predecessor's cap,
      * null = clear (back to the ceiling), number = set (clamped below the ceiling). The tri-state lives only until resolveInput, which
      * normalizes it to a number or absence; confirmation dialog and handler read the would-be effective value. The runtime schema keeps nullable
      * because call-runner revalidates the model's original shape after hook rewrites.
   */
  max_concurrency: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe(
      "Omit to keep the predecessor's limit, null to remove it, a number to set one (only when the user asks).",
    ),
  /**
      * Tri-state, word-for-word the same rules as max_concurrency:
      * omitted = keep the predecessor's choice (resolveInput re-resolves once after backfilling from the predecessor snapshot, so an already-
      * deleted model fails now instead of at the subagent's first utterance), null = clear (back to the session model),
      * string = set. The tri-state lives only until resolveInput: it normalizes to a canonical string or absence.
   */
  subagent_model: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .optional()
    .describe(
      "Omit to keep the predecessor's choice, null for the session model, a model id to set one (only when the user asks).",
    ),
});

/**
  * Predecessor facts backfilled by resolveInput (step 2).
 *
  * Both the permission decision (this session's runs skip confirmation) and the confirmation dialog (still running, will be stopped) read it, and both sit
  * before the handler and must agree synchronously -- so resolveInput (async, the flow's single port read) computes it into the inputs.
  * Normalization **unconditionally overwrites**: a model-forged value is invalid (same precedent as saved.path).
 */
export const AmendWorkflowPredecessorSchema = z
  .object({
    name: z.string().min(1).optional(),
    status: z.enum(WORKFLOW_RUN_LIFECYCLE_STATUSES),
    stop_reason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
    owned_by_this_session: z.boolean(),
    /**
          * Neither script nor path was given on this call; the input script was read from the predecessor archive by resolveInput. Present-means-true only:
          * the confirmation dialog uses it to say script unchanged on the lineage row, the handler to switch to inherited wording and the diagnostic's first sentence. Overwritten
          * unconditionally along with the rest; a model-forged value is invalid.
     */
    script_inherited: z.literal(true).optional(),
  })
  .strict();

export type AmendWorkflowPredecessor = z.infer<typeof AmendWorkflowPredecessorSchema>;

/**
  * The predecessor belongs to this session and was not user-stopped -- the confirm-free owner rule.
 *
  * It lives in contracts, not the permission service, because it now has **two** readers that must agree word for word:
  * the permission service admits it in the always-ask branch, and when an in-place call hits not_live the handler uses it to decide whether the
  * falling-back amendment would have opened a dialog at all. Written twice, someday a
  * nothing-approved call would silently start a new run.
 *
  * Takes unknown: the permission service holds not-yet-parsed tool inputs, the handler the parsed fact block.
 */
export function isAmendWorkflowOwnedPredecessor(predecessor: unknown): boolean {
  if (!predecessor || typeof predecessor !== "object") return false;
  const facts = predecessor as Record<string, unknown>;
  return facts.owned_by_this_session === true && facts.stop_reason !== "user";
}

/**
  * Runtime input: the model-facing keys plus backfilled predecessor and script_line_offset. .strict():
  * legacy spellings such as resume_from are visible errors here too.
 */
export const AmendWorkflowInputSchema = AmendWorkflowModelInputSchema.extend({
  predecessor: AmendWorkflowPredecessorSchema.optional(),
  /**
      * Body-line to file-line offset, nonzero only when the path file carries a /* zcode-workflow block. Same posture as predecessor:
      * a resolved fact, not a fillable parameter; absent from the model's JSON schema.
   */
  script_line_offset: z.number().int().nonnegative().optional(),
}).strict();

export type AmendWorkflowInput = z.infer<typeof AmendWorkflowInputSchema>;

/** The JSON schema handed to the model: no predecessor, no script_line_offset. */
export const AmendWorkflowInputJsonSchema = toToolJsonSchema(
  AmendWorkflowModelInputSchema.strict(),
);
