// ============================================================
// Tool-card display payloads of the observation workflow tools (GetWorkflowRun / ListWorkflowRuns / EvalWorkflowSnippet /
// ListSavedWorkflows / ListModels).
// ============================================================
// Own module per the create-workflow-display.ts precedent (feature-level schemas stay out of toolDisplay.ts).
//
// Members must stay in sync with apps/zcode-cli/packages/contracts/src/tools/workflow-observation-display.ts'
// toolResultDisplayPayloadSchema--both strict; one missing side fails the whole row/display
// validation and the card degrades to text (the create_workflow display comment records the same pitfall).
// Length caps correspond one-to-one with the CLI constructor side; display bypasses the result budget.

import { z } from "zod";

/// Why `stopped`.
export const WORKFLOW_RUN_STOP_REASONS = [
  "user",
  "model",
  "provider",
  "interrupted",
  "superseded",
] as const;

export const WORKFLOW_RUN_OBSERVATION_STATUSES = [
  "pending",
  "running",
  "completed",
  "errored",
  "stopped",
] as const;

const usageSchema = z
  .object({
    spentTokens: z.number(),
    nodesObserved: z.number(),
    nodesRunning: z.number(),
    nodesCompleted: z.number(),
    nodesFailed: z.number(),
  })
  .strict();

const actorSchema = z
  .object({
    siteId: z.string(),
    ordinal: z.number(),
    name: z.string().optional(),
  })
  .strict();

// Card payload of the situation snapshot (phases / subagents / health). Field-for-field synced with the CLI side's
// getWorkflowRunToolResultDisplayPayloadSchema counterpart, closed enums, same vocabulary--
// both strict; one missing field or enum value fails the whole row/display validation, card degenerates to text.
// Numeric caps mirror the CLI side's constants (32 phases / 64 subagents / 240 instruction head / 400 summary).
const workflowRunPhaseViewSchema = z
  .object({
    name: z.string().min(1).max(128),
    state: z.enum(["done", "current", "ahead", "unfinished"]),
    rounds: z.number().int().nonnegative(),
    nodesSettled: z.number().int().nonnegative(),
    nodesRunning: z.number().int().nonnegative(),
    enteredAt: z.number().optional(),
    exitedAt: z.number().optional(),
  })
  .strict();

const workflowRunLastToolSchema = z
  .object({
    name: z.string().min(1).max(64),
    target: z.string().max(120).optional(),
    at: z.number().optional(),
  })
  .strict();

const workflowRunSubagentViewSchema = z
  .object({
    siteId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    name: z.string().max(128).optional(),
    state: z.enum(["idle", "executing", "waiting", "parked", "done", "failed", "unfinished"]),
    phaseName: z.string().max(128).optional(),
    instructionsHead: z.string().max(240).optional(),
    startedAt: z.number().optional(),
    turn: z.number().int().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional(),
    lastTool: workflowRunLastToolSchema.optional(),
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

const workflowRunHealthSchema = z
  .object({
    lastProgressAt: z.number().optional(),
    stalledSince: z.number().optional(),
    concurrency: z
      .object({
        effective: z.number().int().nonnegative(),
        cap: z.number().int().positive(),
        reason: z.string().max(240).optional(),
        since: z.number().optional(),
      })
      .strict()
      .optional(),
    consecutiveFailures: z.number().int().nonnegative(),
    cachedSteps: z.number().int().nonnegative(),
    leftoverRunning: z.number().int().positive().optional(),
    pendingQuestionsKnown: z.boolean(),
  })
  .strict();

const diagnosticSchema = z
  .object({
    line: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    code: z.number().int().nonnegative(),
    message: z.string().min(1).max(2_048),
  })
  .strict();

const workflowRunSummaryRowSchema = z
  .object({
    runId: z.string().min(1),
    label: z.string(),
    labelSource: z.enum(["name", "script"]),
    status: z.enum(WORKFLOW_RUN_OBSERVATION_STATUSES),
    stopReason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
    ownedByThisSession: z.boolean(),
    possiblyInterrupted: z.boolean().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    spentTokens: z.number(),
  })
  .strict();

export const toolCallGetWorkflowRunDisplaySchema = z
  .object({
    kind: z.literal("get_workflow_run"),
    runId: z.string().min(1),
    label: z.string(),
    status: z.enum(WORKFLOW_RUN_OBSERVATION_STATUSES),
    stopReason: z.enum(WORKFLOW_RUN_STOP_REASONS).optional(),
    possiblyInterrupted: z.boolean().optional(),
    // All five snapshot members optional: transcripts persisted before the snapshot existed lack these keys, and this schema is
    // strict--mandatory fields would strip this card whole in every history session opened after upgrade, degrading to text.
    // The constructor still fills all every time (same note CLI-side).
    summary: z.string().max(400).optional(),
    generatedAt: z.number().optional(),
    usage: usageSchema,
    phases: z.array(workflowRunPhaseViewSchema).max(32).optional(),
    subagents: z.array(workflowRunSubagentViewSchema).max(64).optional(),
    health: workflowRunHealthSchema.optional(),
    actors: z.array(actorSchema).max(32),
    logTail: z
      .array(
        z
          .object({
            sequence: z.number(),
            message: z.string().max(1_024),
            // When the event entered the journal (epoch ms); the card's "how long ago" is computed against generatedAt.
            // optional: the column does not exist on pre-snapshot payloads; absent on old rows, never rejected.
            at: z.number().optional(),
          })
          .strict(),
      )
      .max(40),
    result: z.string().max(4_000).optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
      })
      .strict()
      .optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallGetWorkflowRunDisplay = z.infer<typeof toolCallGetWorkflowRunDisplaySchema>;

export const toolCallListWorkflowRunsDisplaySchema = z
  .object({
    kind: z.literal("list_workflow_runs"),
    runs: z.array(workflowRunSummaryRowSchema).max(50),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallListWorkflowRunsDisplay = z.infer<typeof toolCallListWorkflowRunsDisplaySchema>;

export const toolCallEvalWorkflowSnippetDisplaySchema = z
  .object({
    kind: z.literal("eval_workflow_snippet"),
    ok: z.boolean(),
    diagnostics: z.array(diagnosticSchema).max(100),
    logs: z.array(z.string().max(1_024)).max(40),
    response: z.string().max(4_000),
    durationMs: z.number().int().nonnegative(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallEvalWorkflowSnippetDisplay = z.infer<
  typeof toolCallEvalWorkflowSnippetDisplaySchema
>;

export const toolCallSavedWorkflowListDisplaySchema = z
  .object({
    kind: z.literal("saved_workflow_list"),
    workflows: z
      .array(
        z
          .object({
            name: z.string().min(1),
            description: z.string().max(2_048).optional(),
            whenToUse: z.string().max(2_048).optional(),
            scope: z.string(),
            path: z.string().min(1),
            argNames: z.array(z.string()).max(32),
          })
          .strict(),
      )
      .max(50),
    invalid: z
      .array(
        z
          .object({
            path: z.string().min(1),
            reason: z.string().max(1_024).optional(),
          })
          .strict(),
      )
      .optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallSavedWorkflowListDisplay = z.infer<
  typeof toolCallSavedWorkflowListDisplaySchema
>;

// ListModels' catalog card payload. Synced with
// contracts' listModelsToolResultDisplayPayloadSchema--both strict; a missing member strips the block
 // and the card degrades to `<models>` text. Length caps mirror the CLI constants (100 rows / 2048 chars).
export const toolCallListModelsDisplaySchema = z
  .object({
    kind: z.literal("list_models"),
    current: z.string().optional(),
    models: z
      .array(
        z
          .object({
            id: z.string().min(1),
            providerId: z.string().min(1),
            modelId: z.string().min(1),
            providerLabel: z.string().max(2_048).optional(),
            reasoningLevels: z.array(z.string()),
            defaultReasoningLevel: z.string().optional(),
            contextWindow: z.number().optional(),
            disabledReason: z.string().max(2_048).optional(),
          })
          .strict(),
      )
      .max(100),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallListModelsDisplay = z.infer<typeof toolCallListModelsDisplaySchema>;

// ResumeWorkflowRun's result card payload. Synced with contracts'
// resumeWorkflowRunToolResultDisplayPayloadSchema--both strict; a missing member strips the block and the card
// degrades to text. The payload is deliberately minimal {runId} (rationale in the contracts-side comment).
export const toolCallResumeWorkflowRunDisplaySchema = z
  .object({
    kind: z.literal("resume_workflow_run"),
    runId: z.string().min(1),
  })
  .strict();
export type ToolCallResumeWorkflowRunDisplay = z.infer<
  typeof toolCallResumeWorkflowRunDisplaySchema
>;
