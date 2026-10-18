// ============================================================
// AmendWorkflow Tool - revise a run: stop it if it is still going, import its finished work, start the revision
// ============================================================
//
// Why a separate tool from CreateWorkflow: amending is a **different action, different card** -
// the model is not starting something but changing something the user is watching, and the
// predecessor may still be running. Both share one output shape, so the executor's background
// tracking, the `backgrounded` contract, and the display payload stay single-instance.

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import {
  WorkflowAdjustableSettingsSchema,
  WorkflowModelBindingsSchema,
} from "./workflow-settings.js";
import {
  WORKFLOW_RUN_LIFECYCLE_STATUSES,
  WORKFLOW_RUN_STOP_REASONS,
} from "./list-workflow-runs.js";

export const AMEND_WORKFLOW_TOOL_NAME = "AmendWorkflow";

/**
 * Violation copy for "at most one amendment script source". Same slot and tone as
 * `CREATE_WORKFLOW_SOURCE_ERROR`; unlike it, giving neither is **legal** here - that means
 * "keep the predecessor's script".
 */
export const AMEND_WORKFLOW_SOURCE_ERROR =
  "Provide at most one revised script: `path` for the script file you edited (the usual form), or `script` for the whole revised script inline. Passing both is ambiguous; omit both to keep the predecessor's script unchanged.";

/**
 * Model-facing input. Only `run_id` required; every other field obeys one rule: **omit =
 * inherit the predecessor**. `predecessor` is not here - it is a fact backfilled by resolveInput
 * (below), absent from the model's JSON schema.
 */
const AmendWorkflowModelInputSchema = z.object({
  run_id: z
    .string()
    .min(1)
    .describe(
      "ID of the run to amend (from a result, a notification, GetWorkflowRun or ListWorkflowRuns).",
    ),
  /**
   * Both `script` and `path` omitted = reuse the predecessor's archived script: an amendment
   * that only tunes settings need not re-copy thousands of tokens of script. Same lifecycle as
   * the two settings - `resolveInput` reads the predecessor's script in and stamps
   * `predecessor.script_inherited`; hooks, confirm dialog, and handler all see one script. The
   * runtime schema still must accept absence: after a hook rewrites, call-runner revalidates the
   * model's original shape.
   */
  script: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The whole revised script, inline. This OR `path`, never both; omit both to keep the predecessor's script.",
    ),
  /**
   * The common amendment source: edit one line of the predecessor's script file in place, hand
   * the same path back. Inline is still accepted, but it re-streams the whole script - exactly
   * what this path exists to avoid.
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
   * Three-state (docs/dynamic-workflow/concurrency.md "Two bounds on a run"): omitted = keep
   * the predecessor's cap, `null` = lift (back to default concurrency), number = set (floored to
   * >= 1, no ceiling). The states live only until `resolveInput`: normalized there into a number
   * or absence, so dialog and handler see the effective value. The runtime schema keeps
   * `nullable` because call-runner revalidates the model's original shape after hooks.
   */
  max_concurrency: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe(
      "Omit to keep the predecessor's limit, null to return to the default, a number to set one above or below it (only when the user asks).",
    ),
  /**
   * Three-state, verbatim the same rule as `max_concurrency`: omitted = keep the predecessor's
   * selection (`resolveInput` backfills from the predecessor snapshot then **re-resolves once**,
   * so an already-deleted model fails now, not at the subagent's first word), `null` = clear
   * (back to the session model), string = set. The states live only until `resolveInput`:
   * normalized into a canonical string or absence.
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
 * Both the permission decision (this session's runs skip confirmation) and the confirm dialog
 * ("still running, will be stopped") read it; both precede the handler and must agree - so
 * resolveInput (async, the flow's single port read) computes it into the input. Normalization
 * **unconditionally overwrites**: a model-forged copy is invalid (same precedent as saved.path).
 */
export const AmendWorkflowPredecessorSchema = z
  .object({
    name: z.string().min(1).optional(),
    status: z.enum(WORKFLOW_RUN_LIFECYCLE_STATUSES),
    stop_reason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
    owned_by_this_session: z.boolean(),
    /**
     * Neither `script` nor `path` given this call; the input's `script` was read from the
     * predecessor archive by resolveInput. Presence-only boolean: the confirm dialog says
     * "script unchanged" on the lineage row; the handler switches to the "inherit" copy and the
     * diagnostic's first sentence. Unconditionally overwritten with the block; model-forged
     * copies are invalid.
     */
    script_inherited: z.literal(true).optional(),
  })
  .strict();

export type AmendWorkflowPredecessor = z.infer<typeof AmendWorkflowPredecessorSchema>;

/**
 * "This predecessor is this session's, and not user-stopped" - the confirmation-exempt owner rule
 * （docs/dynamic-workflow/launch.md「Amending this session's runs」）。
 *
 * It lives in the contract, not the permission service, because it now has **two** readers that
 * must agree word for word: the service admits on its always-ask branch, and when an in-place
 * concurrency change hits `not_live` the handler decides from it whether the falling-back
 * amendment would have opened the dialog ("When the port says `not_live`"). Written twice, one
 * day a nothing-approved call quietly launches a new run.
 *
 * Takes `unknown`: the permission service sees not-yet-parsed tool input; the handler sees the
 * resolved fact block.
 */
export function isAmendWorkflowOwnedPredecessor(predecessor: unknown): boolean {
  if (!predecessor || typeof predecessor !== "object") return false;
  const facts = predecessor as Record<string, unknown>;
  return facts.owned_by_this_session === true && facts.stop_reason !== "user";
}

/**
 * Runtime input: the model-facing keys + backfilled `predecessor` and `script_line_offset`.
 * `.strict()`: legacy spellings like `resume_from` are visible errors here too.
 */
export const AmendWorkflowInputSchema = AmendWorkflowModelInputSchema.extend({
  predecessor: AmendWorkflowPredecessorSchema.optional(),
  /**
   * Body-line -> file-line offset, non-zero only when the `path` file carries a
   * `/* zcode-workflow` block. Same posture as `predecessor`: a resolution result, not a
   * fillable parameter; absent from the model's JSON schema.
   */
  script_line_offset: z.number().int().nonnegative().optional(),
  /** The two dialog-adjustable settings; same block and backfill rule as CreateWorkflow (workflow-settings.ts). */
  adjustable_settings: WorkflowAdjustableSettingsSchema.optional(),
  /** Binding table resolved from the new script's named models; same block as CreateWorkflow (same-name keeps the predecessor's binding, see launch.md). */
  model_bindings: WorkflowModelBindingsSchema.optional(),
}).strict();

export type AmendWorkflowInput = z.infer<typeof AmendWorkflowInputSchema>;

/** JSON schema for the model: no `predecessor`, `script_line_offset`, `adjustable_settings`, or `model_bindings`. */
export const AmendWorkflowInputJsonSchema = toToolJsonSchema(
  AmendWorkflowModelInputSchema.strict(),
);
