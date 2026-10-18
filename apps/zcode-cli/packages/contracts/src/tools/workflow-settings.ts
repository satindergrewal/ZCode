// ============================================================
// The two run settings adjustable in the confirm dialog (shared by CreateWorkflow / AmendWorkflow)
// ============================================================
// docs/dynamic-workflow/launch.md「Adjusting the settings in the window」。
//
// Two schemas, there and back:
//   - `WorkflowAdjustableSettingsSchema`: fact backfilled into the input by `resolveInput`,
//     telling the confirm dialog "this agent will apply the values you change here" plus the
//     local ceiling.
//   - `WorkflowSettingsAdjustmentSchema`: the change the user returns in the Allow response's
//     `content`.
//
// The backfill block rides the **input channel**, not the `create_workflow` display: the display
// field set is frozen (see the warning on tool-result-metadata.ts); one extra key makes
// strictly-parsing clients drop the whole block, graph included. The input channel is schemaless
// for every client version. Old clients that ignore the block keep the plain-text condition row;
// old agents never write it, so new clients are never handed a change they would drop.

import { z } from "zod";

/** Length cap of the canonical `providerId/modelId[$level]` (team-plan providerIds are UUIDs). */
const WORKFLOW_SETTINGS_MAX_MODEL_CHARS = 512;

/**
 * The "adjustable in confirm dialog" fact backfilled by `resolveInput`. Same posture as
 * `script_line_offset` and `AmendWorkflow.predecessor`: a resolution result, not a fillable
 * parameter - absent from the model's JSON schema, unconditionally overwritten if the model fills it.
 */
export const WorkflowAdjustableSettingsSchema = z
  .object({
    /** Host has a model catalog and can resolve the dialog's model choice. When false the dialog only tunes the cap; the model row is one sentence. */
    subagent_model: z.boolean(),
    /**
     * Default concurrency D (key predates the "default concurrency" concept, kept for compat);
     * absent when the port cannot answer. Not a cap: the stepper is unbounded, this only feeds
     * the "default N" hint and the "equals default = no own cap" test.
     */
    concurrency_ceiling: z.number().int().positive().optional(),
  })
  .strict();

export type WorkflowAdjustableSettings = z.infer<typeof WorkflowAdjustableSettingsSchema>;

/** Most distinct model names one script may name (entry cap of the binding table); far above any real script, keeps the table bounded. */
export const WORKFLOW_MODEL_BINDINGS_MAX_ENTRIES = 64;
/** Per-name length cap inside the script (a model id or `providerId/modelId[$level]`). */
const WORKFLOW_MODEL_NAME_MAX_CHARS = 512;

/**
 * Script-named model -> canonical form
 * (docs/dynamic-workflow/launch.md "Models the script names"): keys are the names **verbatim**
 * in the script (untrimmed; the runtime persona carries exactly that string), values
 * `providerId/modelId[$level]`.
 *
 * Same posture and channel as {@link WorkflowAdjustableSettingsSchema}: backfilled into the
 * input by `resolveInput`, absent from the model's JSON schema, unconditionally overwritten if
 * the model fills it. The confirm dialog does not render it per name (the script's choice is the
 * author's model decision); it only rewords the model sentence to "subagents default to" when
 * present. The response has no field to change it.
 */
export const WorkflowModelBindingsSchema = z
  .record(
    z.string().min(1).max(WORKFLOW_MODEL_NAME_MAX_CHARS),
    z.string().trim().min(1).max(WORKFLOW_SETTINGS_MAX_MODEL_CHARS),
  )
  .refine((bindings) => Object.keys(bindings).length <= WORKFLOW_MODEL_BINDINGS_MAX_ENTRIES, {
    message: `at most ${WORKFLOW_MODEL_BINDINGS_MAX_ENTRIES} model names`,
  });

export type WorkflowModelBindings = z.infer<typeof WorkflowModelBindingsSchema>;

/**
 * Settings the user changed in the confirm dialog, i.e. the Allow response's `content`. Tool's
 * own field names and three-states: omitted = unchanged, `null` = back to default (session
 * model / default concurrency), value = set - verbatim the same rule as `AmendWorkflow`'s
 * model surface, so the agent side has one parser.
 *
 * Deliberately **not** strict: the response comes from the client; the broker takes the two keys
 * it knows and drops the rest rather than voiding both user changes over one unknown key.
 */
export const WorkflowSettingsAdjustmentSchema = z.object({
  subagent_model: z
    .string()
    .trim()
    .min(1)
    .max(WORKFLOW_SETTINGS_MAX_MODEL_CHARS)
    .nullable()
    .optional(),
  max_concurrency: z.number().int().positive().nullable().optional(),
});

export type WorkflowSettingsAdjustment = z.infer<typeof WorkflowSettingsAdjustmentSchema>;

/** Parse a response `content`: a change made of known keys; `undefined` when malformed or keyless. */
export function parseWorkflowSettingsAdjustment(
  content: unknown,
): WorkflowSettingsAdjustment | undefined {
  const parsed = WorkflowSettingsAdjustmentSchema.safeParse(content);
  if (!parsed.success) return undefined;
  const adjustment: WorkflowSettingsAdjustment = {};
  if (parsed.data.subagent_model !== undefined) {
    adjustment.subagent_model = parsed.data.subagent_model;
  }
  if (parsed.data.max_concurrency !== undefined) {
    adjustment.max_concurrency = parsed.data.max_concurrency;
  }
  return Object.keys(adjustment).length === 0 ? undefined : adjustment;
}
