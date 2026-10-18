import { z } from "zod";

import {
  CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS,
  createWorkflowToolResultDisplayDiagnosticSchema,
} from "./create-workflow.js";
import {
  GET_WORKFLOW_RUN_ROSTER_LIMITS,
  GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS,
  GetWorkflowRunActorSchema,
  GetWorkflowRunHealthSchema,
  GetWorkflowRunPhaseSchema,
  GetWorkflowRunSubagentLastToolSchema,
  GetWorkflowRunUsageSchema,
} from "./get-workflow-run.js";
import {
  ListWorkflowRunsRunSchema,
  WORKFLOW_RUN_LIFECYCLE_STATUSES,
  WORKFLOW_RUN_STOP_REASONS,
} from "./list-workflow-runs.js";

/**
  * Result-card display payloads of the observation family of workflow tools (GetWorkflowRun / ListWorkflowRuns / EvalWorkflowSnippet /
  * ListSavedWorkflows / ListModels).
 *
  * Length caps mirror the producer side (core's workflow-observation-display.ts) one for one: display bypasses the
  * result budget, so text fields and array lengths must be capped independently before entering live events and persisted metadata,
  * with the producer flagging truncated on overflow.
 */
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES = 40;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS = 1_024;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_ACTORS = 32;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_RESULT_CHARS = 4_000;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS = 2_048;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS = 50;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_ARGS = 32;
/** Max model rows per directory card (the producer slices and flags truncated beyond it). */
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_MODELS = 100;
/** Card bounds for the situation section, same values as the tool face ({@link GET_WORKFLOW_RUN_ROSTER_LIMITS}). */
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_PHASES = GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhases;
export const WORKFLOW_OBSERVATION_DISPLAY_MAX_SUBAGENTS =
  GET_WORKFLOW_RUN_ROSTER_LIMITS.maxSubagents;

/**
  * One subagent on the card. Deliberately a **flat row**, not the tool output's nesting: the card draws one line, and
  * the few facts in currentAsk (dispatched to what, which round, last tool touched) are the second half of that line;
  * another nesting layer would only make the renderer destructure and reassemble.
 *
  * The enum sets stay **verbatim-equal and closed** with the tool face: consuming bundles reject unknown enum values (this once
  * killed a whole subscription), so the two places always change together.
 */
export const getWorkflowRunToolResultDisplaySubagentSchema = z
  .object({
    siteId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    name: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxActorNameLength).optional(),
    state: z.enum(["idle", "executing", "waiting", "parked", "done", "failed", "unfinished"]),
    phaseName: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhaseNameLength).optional(),
        /** The current ask's task summary and progress reading (absent = unknown, never 0). */
    instructionsHead: z
      .string()
      .max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxInstructionsHeadLength)
      .optional(),
    startedAt: z.number().optional(),
    turn: z.number().int().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional(),
    lastTool: GetWorkflowRunSubagentLastToolSchema.optional(),
        /** What it waits on (reason text stays off the card: the card needs only waiting-on-slot vs backoff, plus the remaining delay). */
    waitCause: z.enum(["slot", "backoff"]).optional(),
    retryAfterMs: z.number().nonnegative().optional(),
    waitSince: z.number().optional(),
    parkedOn: z.string().optional(),
    stepsSettled: z.number().int().nonnegative(),
    stepsFailed: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    lastProgressAt: z.number().optional(),
  })
  .strict();

export const getWorkflowRunToolResultDisplayLogEntrySchema = z
  .object({
    sequence: z.number(),
    message: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS),
        // Journal landing time of the event (epoch ms), same source as the tool output's logTail at; the card's age is
        // computed against generatedAt. Optional: payloads predating the situation section lack it, optional in lockstep with shared.
    at: z.number().optional(),
  })
  .strict();

/**
  * Structured failure on the tool card: **code and message only**, deliberately not reusing the tool output's
 * `GetWorkflowRunErrorSchema`。
 *
  * The two channels have different readers: the output is read by the model, which needs providerStop to know what to fix; display is
  * read by the renderer, which strict-validates every frame against the mirror schema in packages/shared. Reuse would make
  * display grow the output's fields, and a lagging mirror rejects the whole row -- session recovery fail-closed.
  * This definition is the other side of that mirror; the two stay field-by-field in sync.
 */
export const getWorkflowRunToolResultDisplayErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
  })
  .strict();

/**
  * GetWorkflowRun's result-card payload. Budget/actors reuse the tool output schema directly (plain numbers or already-bounded
  * small structures); errors use the display-only schema above; logTail and result are capped independently on the display side --
  * the output side's 2048 chars/entries and artifact serialization caps belong to the model channel; neither bound stands in for the other.
 */
export const getWorkflowRunToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("get_workflow_run"),
    runId: z.string().min(1),
    label: z.string(),
    status: z.enum(WORKFLOW_RUN_LIFECYCLE_STATUSES),
        /** Present only when status is stopped. */
    stopReason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
    possiblyInterrupted: z.boolean().optional(),
    /**
          * The situation section: the one-line summary, snapshot instant, phase table, roster, health.
     *
          * All five fields **optional**, though the producer always fills them. The reason is the **transcript already in the store**:
          * get_workflow_run payloads persisted before the situation section lack these keys, and the display schema is
          * strict -- requiring them would fail whole-card validation for every historical session opened after the upgrade,
          * degrading to plain text. The text fallback is only for old rows with **no payload at all**, not payload-bearing ones.
     *
          * generatedAt is the base for every how-long-ago on the card: computed against the snapshot instant, never render-time
          * Date.now() -- on reopening a three-day-old transcript, the card's ages are still the then-current ages.
     */
    summary: z.string().max(GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS).optional(),
    generatedAt: z.number().optional(),
    usage: GetWorkflowRunUsageSchema,
    phases: z
      .array(GetWorkflowRunPhaseSchema)
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_PHASES)
      .optional(),
    subagents: z
      .array(getWorkflowRunToolResultDisplaySubagentSchema)
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_SUBAGENTS)
      .optional(),
    health: GetWorkflowRunHealthSchema.optional(),
    actors: z.array(GetWorkflowRunActorSchema).max(WORKFLOW_OBSERVATION_DISPLAY_MAX_ACTORS),
    logTail: z
      .array(getWorkflowRunToolResultDisplayLogEntrySchema)
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES),
    result: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_RESULT_CHARS).optional(),
    error: getWorkflowRunToolResultDisplayErrorSchema.optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

/** ListWorkflowRuns's result-card payload: run rows reuse the output schema directly (limit already capped at 50). */
export const listWorkflowRunsToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("list_workflow_runs"),
    runs: z.array(ListWorkflowRunsRunSchema).max(WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS),
    truncated: z.boolean().optional(),
  })
  .strict();

/**
  * EvalWorkflowSnippet's result-card payload. Diagnostics reuse the create_workflow display diagnostic schema
  * (same TS diagnostic shape, same cap); logs take the tail, response capped independently.
 */
export const evalWorkflowSnippetToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("eval_workflow_snippet"),
    ok: z.boolean(),
    diagnostics: z
      .array(createWorkflowToolResultDisplayDiagnosticSchema)
      .max(CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS),
    logs: z
      .array(z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS))
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES),
    response: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_RESULT_CHARS),
    durationMs: z.number().int().nonnegative(),
    truncated: z.boolean().optional(),
  })
  .strict();

/**
  * ListSavedWorkflows's result-card payload. Root cause: on the v4 wire output.text is formatModelContent's
  * XML-style projection, so the UI's JSON probe never hits (falling into the raw-JSON fallback card) -- structured lists must travel through
  * this display channel. description / whenToUse capped independently; args keep names only (declaration details belong to the confirmation dialog).
 */
export const savedWorkflowListToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("saved_workflow_list"),
    workflows: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS).optional(),
            whenToUse: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS).optional(),
            scope: z.string(),
            path: z.string().min(1),
            argNames: z.array(z.string()).max(WORKFLOW_OBSERVATION_DISPLAY_MAX_ARGS),
          })
          .strict(),
      )
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS),
    invalid: z
      .array(
        z
          .object({
            path: z.string().min(1),
            reason: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS).optional(),
          })
          .strict(),
      )
      .optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

/**
  * ListModels's result-card payload. Same root cause as saved_workflow_list: on the v4 wire output.text is
  * formatModelContent's models projection, so the UI's JSON probe never hits -- the structured catalog has only this channel.
 *
  * The fields are the tool output itself (everything the reader draws -- what exists, whence, which is current),
  * plus one truncated. providerLabel / disabledReason are free text from the registry; display bypasses the result
  * budget, so they are capped here; the rest are short ids and small numbers, passed through verbatim.
 */
export const listModelsToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("list_models"),
        /** The session's current model (canonical form); absent when nothing in the catalog matches. */
    current: z.string().optional(),
    models: z
      .array(
        z
          .object({
            id: z.string().min(1),
            providerId: z.string().min(1),
            modelId: z.string().min(1),
            providerLabel: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS).optional(),
            reasoningLevels: z.array(z.string()),
            defaultReasoningLevel: z.string().optional(),
            contextWindow: z.number().optional(),
            disabledReason: z.string().max(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS).optional(),
          })
          .strict(),
      )
      .max(WORKFLOW_OBSERVATION_DISPLAY_MAX_MODELS),
    truncated: z.boolean().optional(),
  })
  .strict();

export type GetWorkflowRunToolResultDisplayPayload = z.infer<
  typeof getWorkflowRunToolResultDisplayPayloadSchema
>;
export type ListWorkflowRunsToolResultDisplayPayload = z.infer<
  typeof listWorkflowRunsToolResultDisplayPayloadSchema
>;
export type EvalWorkflowSnippetToolResultDisplayPayload = z.infer<
  typeof evalWorkflowSnippetToolResultDisplayPayloadSchema
>;
export type SavedWorkflowListToolResultDisplayPayload = z.infer<
  typeof savedWorkflowListToolResultDisplayPayloadSchema
>;
export type ListModelsToolResultDisplayPayload = z.infer<
  typeof listModelsToolResultDisplayPayloadSchema
>;

/**
  * ResumeWorkflowRun's result-card payload.
 *
  * Deliberately minimal, runId only: all a resume card must convey is which run continues in the background -- the response guidance prose is
  * model-channel wording and the UI has its own localization table; extra fields only add wire bytes with no reader. On the producer side, a
  * failed safeParse of the output schema returns undefined (text fallback), the same skeleton as the four producers above.
 */
export const resumeWorkflowRunToolResultDisplayPayloadSchema = z
  .object({
    kind: z.literal("resume_workflow_run"),
    runId: z.string().min(1),
  })
  .strict();
export type ResumeWorkflowRunToolResultDisplayPayload = z.infer<
  typeof resumeWorkflowRunToolResultDisplayPayloadSchema
>;
