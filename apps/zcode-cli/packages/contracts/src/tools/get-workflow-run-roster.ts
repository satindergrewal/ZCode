// ============================================================
// GetWorkflowRun's situation section schema: phases / subagents / health
// ============================================================
// Split out of get-workflow-run.ts for the same reason as the port-side dynamic-workflow-run-roster.port.ts:
// that file nears oxlint's max-lines cap and these three schema groups form a block of their own. Public surface unchanged --
// get-workflow-run.ts re-exports every name here in place; @zcode/contracts import paths stay verbatim.
//
// A field-by-field mirror of the port types (DynamicWorkflowRunPhaseView / SubagentView / Health)
// plus zod bounds. The sides must move together: the port is read-side truth, this the model-facing contract; a missing field means
// an already-learned fact never reaches the model.

import { z } from "zod";

/**
 * Bounds for the situation section. Each equals an existing bound; no parallel regime:
 * phase count and names follow the reducer's WORKFLOW_RUNS_LIMITS.maxPhases / maxPhaseNameLength;
 * instructions head and tool name/target follow the engine-side INSTRUCTIONS_HEAD_MAX_CHARS / LAST_TOOL_TARGET_MAX_CHARS.
 */
export const GET_WORKFLOW_RUN_ROSTER_LIMITS = {
  /** Row cap for the phase table (same value as the reducer's maxPhases). */
  maxPhases: 32,
  maxPhaseNameLength: 128,
  /**
   * Row cap for the roster, deliberately above the phase table: a 50-way fan-out is ordinary, and the reader is asking exactly
   * who is doing what. Past this bound the whole block is cut, flagged via subagentsTruncated --
   * a roster silently missing 18 rows reads as only 64 subagents.
   */
  maxSubagents: 64,
  maxActorNameLength: 128,
  /** Task summary of one ask (node-queued's instructionsHead). */
  maxInstructionsHeadLength: 240,
  maxLastToolNameLength: 64,
  maxLastToolTargetLength: 120,
  /** Free-text reason of node-waiting (one line of the backoff's provider error). */
  maxWaitReasonLength: 240,
} as const;

/** A phase's situation in the section (mirror of the port's DynamicWorkflowRunPhaseView). */
export const GetWorkflowRunPhaseSchema = z
  .object({
    name: z.string().min(1).max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhaseNameLength),
    /** ahead = declared by the script but control flow has not reached it; the only state with rounds 0. */
    state: z.enum(["done", "current", "ahead", "unfinished"]),
    rounds: z.number().int().nonnegative(),
    nodesSettled: z.number().int().nonnegative(),
    nodesRunning: z.number().int().nonnegative(),
    /** Last enter/leave instants (epoch ms). Absent when events carry no timestamp; never 0. */
    enteredAt: z.number().optional(),
    exitedAt: z.number().optional(),
  })
  .strict();

/** The most recent observed tool call within an ask. The target is a lead (path / command head), not the full args. */
export const GetWorkflowRunSubagentLastToolSchema = z
  .object({
    name: z.string().min(1).max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxLastToolNameLength),
    target: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxLastToolTargetLength).optional(),
    at: z.number().optional(),
  })
  .strict();

/**
 * The ask a subagent is running right now. Absent turn / toolCalls read as unknown, 0 reads as
 * no tool call yet -- old journals lack node-progress, so the two must stay distinguishable.
 */
export const GetWorkflowRunSubagentAskSchema = z
  .object({
    siteId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    actorSeq: z.number().int().nonnegative().optional(),
    instructionsHead: z
      .string()
      .max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxInstructionsHeadLength)
      .optional(),
    startedAt: z.number().optional(),
    turn: z.number().int().nonnegative().optional(),
    toolCalls: z.number().int().nonnegative().optional(),
    lastTool: GetWorkflowRunSubagentLastToolSchema.optional(),
  })
  .strict();

/** What the current ask waits on. slot = the process-level admission gate; backoff = the runner retrying with backoff. */
export const GetWorkflowRunSubagentWaitSchema = z
  .object({
    cause: z.enum(["slot", "backoff"]),
    reason: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxWaitReasonLength).optional(),
    retryAfterMs: z.number().nonnegative().optional(),
    since: z.number().optional(),
  })
  .strict();

/**
 * One subagent of the roster (mirror of the port's DynamicWorkflowRunSubagentView).
 *
 * The seven state words are a closed set, read in write order (full decision chain in the port comment): while the run lives
 * parked -> waiting -> executing -> failed -> idle; under a terminal run only
 * `unfinished` → `failed` → `done`。
 */
export const GetWorkflowRunSubagentSchema = z
  .object({
    siteId: z.string().min(1),
    ordinal: z.number().int().nonnegative(),
    name: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxActorNameLength).optional(),
    state: z.enum(["idle", "executing", "waiting", "parked", "done", "failed", "unfinished"]),
    phaseName: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhaseNameLength).optional(),
    currentAsk: GetWorkflowRunSubagentAskSchema.optional(),
    wait: GetWorkflowRunSubagentWaitSchema.optional(),
    /** Which question it is parked on; never present in a read where health.pendingQuestionsKnown is false. */
    parkedOn: z.string().optional(),
    stepsSettled: z.number().int().nonnegative(),
    stepsFailed: z.number().int().nonnegative(),
    tokens: z.number().int().nonnegative(),
    lastProgressAt: z.number().optional(),
  })
  .strict();

/**
 * Run-level concurrency pressure. **The whole object appears only when squeezed below its own bound**: a run at its bound has
 * nothing to say, and its presence means actively being throttled.
 */
export const GetWorkflowRunConcurrencyHealthSchema = z
  .object({
    effective: z.number().int().nonnegative(),
    cap: z.number().int().positive(),
    reason: z.string().max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxWaitReasonLength).optional(),
    since: z.number().optional(),
  })
  .strict();

/** Whether the run as a whole still moves (mirror of the port's DynamicWorkflowRunHealth). */
export const GetWorkflowRunHealthSchema = z
  .object({
    lastProgressAt: z.number().optional(),
    stalledSince: z.number().optional(),
    concurrency: GetWorkflowRunConcurrencyHealthSchema.optional(),
    consecutiveFailures: z.number().int().nonnegative(),
    cachedSteps: z.number().int().nonnegative(),
    /** Terminal runs only: node rows still marked running (processes died under them). Absent at 0. */
    leftoverRunning: z.number().int().positive().optional(),
    /**
     * Whether this read can answer are-any-questions-pending. When false the whole pendingQuestions field is absent
     * and no subagent is reported parked -- no-one-waiting and unknown are two different facts.
     */
    pendingQuestionsKnown: z.boolean(),
  })
  .strict();

export type GetWorkflowRunPhase = z.infer<typeof GetWorkflowRunPhaseSchema>;
export type GetWorkflowRunSubagent = z.infer<typeof GetWorkflowRunSubagentSchema>;
export type GetWorkflowRunSubagentAsk = z.infer<typeof GetWorkflowRunSubagentAskSchema>;
export type GetWorkflowRunHealth = z.infer<typeof GetWorkflowRunHealthSchema>;
