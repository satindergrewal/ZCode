// ============================================================
// ListWorkflowRuns Tool - enumerate workflow runs by project (cwd), including cross-session history
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const LIST_WORKFLOW_RUNS_TOOL_NAME = "ListWorkflowRuns";

/**
 * Lifecycle vocabulary for runs. Same set as the port-side DynamicWorkflowRunLifecycleStatus, but
 * redeclared here as a zod enum: the schema is the **runtime** validation surface, where a type-only union is useless.
 * If the two drift, legal model-passed statuses get rejected by the tool -- so the port-side note points back here too.
 */
export const WORKFLOW_RUN_LIFECYCLE_STATUSES = [
  "completed",
  "errored",
  "pending",
  "running",
  "stopped",
] as const;

/** Why stopped (zod face of the port's DynamicWorkflowRunStopReason). */
export const WORKFLOW_RUN_STOP_REASONS = [
  "user",
  "model",
  "provider",
  "interrupted",
  "superseded",
] as const;

/** limit bound and default. 50 is the no-cursor-pagination ceiling for a low-cardinality entity like runs. */
export const LIST_WORKFLOW_RUNS_MIN_LIMIT = 1;
export const LIST_WORKFLOW_RUNS_MAX_LIMIT = 50;
export const LIST_WORKFLOW_RUNS_DEFAULT_LIMIT = 20;

export const ListWorkflowRunsInputSchema = z
  .object({
    limit: clampedLimit().describe(
      `Maximum number of runs to return (${LIST_WORKFLOW_RUNS_MIN_LIMIT}-${LIST_WORKFLOW_RUNS_MAX_LIMIT}, default ${LIST_WORKFLOW_RUNS_DEFAULT_LIMIT}). Most recently updated runs come first.`,
    ),
    statuses: z
      .array(z.enum(WORKFLOW_RUN_LIFECYCLE_STATUSES))
      .optional()
      .describe(
        'Optional status filter. Omit to see every run in this project. Pass ["running", "pending"] to see only what is still in flight.',
      ),
  })
  // Deliberately no cwd input: the tool always reads the current session's working directory (the model may not scan across projects -- also
  // the premise for sideEffectScope: "none" holding). .strict() makes an extra cwd a visible error.
  .strict();

export type ListWorkflowRunsInput = z.infer<typeof ListWorkflowRunsInputSchema>;

export const ListWorkflowRunsInputJsonSchema = toToolJsonSchema(ListWorkflowRunsInputSchema);

/**
 * The section **shared by list and detail** (schema face of the port's DynamicWorkflowRunSummary).
 *
 * Why one shared field bag instead of two independently evolving field tables: the same run showing a different
 * name or owner in list vs detail is the kind of inconsistency tests miss and trust suffers from. The bag lives on the **list** side,
 * the shallowest projection of this section; detail extends it.
 */
export const WorkflowRunSummarySchema = z.object({
  runId: z.string().min(1),
  /** Cooked display label (name -> script first line -> runId, derived service-side). */
  label: z.string(),
  /** name = user-given; script = derived from the script at read time (runId fallback included). */
  labelSource: z.enum(["name", "script"]),
  status: z.enum(WORKFLOW_RUN_LIFECYCLE_STATUSES),
  /** Present only when status is stopped. */
  stopReason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
  /** The run this one was amended from (dwf_run.resumed_from); absent when not an amendment. */
  resumedFrom: z.string().min(1).optional(),
  /** The amendment that stopped and superseded this run (settlement bag of stopped superseded); absent when not superseded. */
  supersededBy: z.string().min(1).optional(),
  ownedByThisSession: z.boolean(),
  /** A this-session-cannot-confirm-alive mark; present only when true. Never a status rewrite. */
  possiblyInterrupted: z.boolean().optional(),
  /** epoch ms (journal time_created / time_updated). */
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const ListWorkflowRunsRunSchema = WorkflowRunSummarySchema.extend({
  spentTokens: z.number(),
}).strict();

export type ListWorkflowRunsRun = z.infer<typeof ListWorkflowRunsRunSchema>;

export const ListWorkflowRunsOutputSchema = z
  .object({
    runs: z.array(ListWorkflowRunsRunSchema),
    /** More runs exist beyond this page (probed via limit+1). Present only when true. */
    truncated: z.boolean().optional(),
  })
  .strict();

export type ListWorkflowRunsOutput = z.infer<typeof ListWorkflowRunsOutputSchema>;

export const ListWorkflowRunsOutputJsonSchema = toToolJsonSchema(ListWorkflowRunsOutputSchema);

/**
 * limit clamps instead of rejecting: a read-only enumeration has no reason to become a tool error the model must
 * recover from over one out-of-range number; limit defaults to 20, clamped to [1, 50].
 *
 * The clamp lives in preprocess, not the handler, so two things hold at once: the JSON schema still projects the inner
 * schema (type integer + minimum/maximum/default, the model sees the bounds) while runtime out-of-range values are
 * folded into range. A Math.min/max in the handler would be pre-empted by this schema's min/max: dead code, never run.
 * Semantic coercion via preprocess is established convention (task-output's semanticBoolean, bash's
 * timeout）。
 */
function clampedLimit(): z.ZodEffects<z.ZodDefault<z.ZodNumber>, number, unknown> {
  return z.preprocess((value) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return value;
    return Math.min(
      LIST_WORKFLOW_RUNS_MAX_LIMIT,
      Math.max(LIST_WORKFLOW_RUNS_MIN_LIMIT, Math.trunc(value)),
    );
  }, z.number().int().min(LIST_WORKFLOW_RUNS_MIN_LIMIT).max(LIST_WORKFLOW_RUNS_MAX_LIMIT).default(LIST_WORKFLOW_RUNS_DEFAULT_LIMIT));
}
