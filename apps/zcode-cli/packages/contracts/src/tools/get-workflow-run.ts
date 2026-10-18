// ============================================================
// GetWorkflowRun Tool - adaptive detail for a single workflow run (progress digest / artifacts / failures)
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import {
  GET_WORKFLOW_RUN_ROSTER_LIMITS,
  GetWorkflowRunHealthSchema,
  GetWorkflowRunPhaseSchema,
  GetWorkflowRunSubagentSchema,
} from "./get-workflow-run-roster.js";
import { WorkflowRunSummarySchema } from "./list-workflow-runs.js";

// The situation-section schema (phases / subagents / health) lives in get-workflow-run-roster.ts and is re-exported here verbatim
// to keep @zcode/contracts import paths unchanged.
export * from "./get-workflow-run-roster.js";

export const GET_WORKFLOW_RUN_TOOL_NAME = "GetWorkflowRun";

export const GetWorkflowRunInputSchema = z
  .object({
        // snake_case follows TaskOutput's task_id: to the model these two keys are one family of run/task ids;
        // a naming fork would only make it guess across the two tools.
    run_id: z
      .string()
      .min(1)
      .describe(
        "The workflow run ID to inspect (as returned by CreateWorkflow or ListWorkflowRuns)",
      ),
  })
  .strict();

export type GetWorkflowRunInput = z.infer<typeof GetWorkflowRunInputSchema>;

export const GetWorkflowRunInputJsonSchema = toToolJsonSchema(GetWorkflowRunInputSchema);

/**
  * Run progress and usage (observability face, no caps at all). nodesObserved is the **row count of persisted nodes** (the three states summed),
  * never a total step count: dynamic workflows have no static total, and queued exists only in the event phase, never persisted.
 */
export const GetWorkflowRunUsageSchema = z
  .object({
    spentTokens: z.number(),
    nodesObserved: z.number(),
    nodesRunning: z.number(),
    nodesCompleted: z.number(),
    nodesFailed: z.number(),
  })
  .strict();

/** One actor site instance. persona is deliberately omitted: a whole system prompt is boundless by nature. */
export const GetWorkflowRunActorSchema = z
  .object({
    siteId: z.string(),
    ordinal: z.number(),
    name: z.string().optional(),
  })
  .strict();

/**
  * One log() narrative. at is when the event landed in the journal (dwf_event.time_created); the model face renders
  * how-long-ago from it; absent on older journals without the column, whose rows carry no age prefix -- **never** fall back to a read-time
  * Date.now(), which would label a week-old narrative as just now.
 */
export const GetWorkflowRunLogEntrySchema = z
  .object({
    sequence: z.number(),
    message: z.string(),
    at: z.number().optional(),
  })
  .strict();

/**
  * An escalation question parked right now, waiting for the main agent's answer.
 *
  * The **query fallback** once an escalation notice is dropped, and the model side's only discovery surface: ResolveWorkflowQuestion takes
  * only qid, and notices have two known drop paths (stale branch generation / shutdown). askedAt lets the model
  * see how long the question has waited -- no timeout backstops it.
 */
export const GetWorkflowRunPendingQuestionSchema = z
  .object({
    qid: z.string(),
        /** The asking actor, site@ordinal form. */
    actor: z.string(),
        /** The actor's human-readable name; absent for anonymous actors (the read side decides how to render nameless). */
    actorName: z.string().optional(),
    question: z.string(),
    context: z.string().optional(),
        /** Asked-at instant (epoch ms, the same ruler as createdAt / updatedAt). */
    askedAt: z.number(),
  })
  .strict();

/**
  * A **user-facing artifact**: output the script published via artifact.* for the user,
  * now presented as a card.
 *
  * ⚠ Terminology: this and the result on this tool's output (the script's top-level return value, also called artifact inside the engine) are **two different
  * things**, with different model-side uses: result is content to relay, the artifact is something to
  * **reference** by title.
 *
  * Deliberately **no uri**: the model cannot read the tool-artifact store. Fields carry the **latest version's** value (version is the version
  * number; per-version history metadata lives in the UI side panel).
 */
export const GetWorkflowRunArtifactSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["file", "markdown", "chart", "table", "metrics", "board"]),
        /** Card title; absent when the script gave none (the facade's default title is the id). */
    title: z.string().optional(),
        /** Latest version number. */
    version: z.number(),
        /** MIME of the content artifact; absent for preset dashboards. */
    contentType: z.string().optional(),
        /** Byte size of the content artifact's latest version; absent for preset dashboards. */
    bytes: z.number().optional(),
        /** Workspace origin of the content artifact (bytes are copied into the store; this only says where it came from). */
    sourcePath: z.string().optional(),
        /** Number of report labels the preset dashboard received; always 0 for content artifacts. */
    itemCount: z.number(),
        /** The run's deliverable (at most one), listed first. */
    primary: z.literal(true).optional(),
  })
  .strict();

/** Structured failure. code is the stable discriminator -- the model must tell a dead process from a real script failure. */
export const GetWorkflowRunErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
        /** Present only when code is ProviderStop. */
    providerStop: z
      .object({
        kind: z.enum([
          "auth",
          "not_configured",
          "model_unavailable",
          "invalid_request",
          "quota",
          "other",
        ]),
        reason: z.string(),
        providerId: z.string().optional(),
        providerLabel: z.string().optional(),
        modelId: z.string().optional(),
        providerCode: z.string().optional(),
        subagent: z.string().optional(),
        subagentName: z.string().optional(),
        phase: z.string().optional(),
        rawMessage: z.string().optional(),
        resetAt: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Char cap for summary. A one-sentence budget: past it, it is not a summary but another report. */
export const GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS = 400;

export const GetWorkflowRunOutputSchema = WorkflowRunSummarySchema.extend({
  /**
      * The situation in one sentence: status + running/finished for how long + phase position + step and in-flight breakdown + pending questions + latest progress.
      * Assembled **deterministically** by the handler from the structured fields below (no model in the loop), so one snapshot always yields
      * the same sentence; cap {@link GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS}, dropping whole trailing sentences on overflow.
   */
  summary: z.string().max(GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS),
  /**
      * When this snapshot was read (epoch ms). Every how-long-ago on the model face is computed against it --
      * one ruler per output, so two ages are comparable. formatModelContent takes a single argument (core's ToolEntry
      * contract), so the clock read can only happen in the handler, the result carried along in the output; the formatter is thus
      * a pure (output) => text function, pinable verbatim.
   */
  generatedAt: z.number(),
  usage: GetWorkflowRunUsageSchema,
  /**
      * This run's own concurrency cap (subagents in flight at once), **present only below the current ceiling**: a run at the ceiling
      * has nothing to say (same rule as pendingQuestions: absent when none). This is the value inherited when AmendWorkflow omits max_concurrency --
      * the model thereby knows what an amendment inherits.
   */
  maxConcurrency: z.number().int().positive().optional(),
  /**
      * Which model this run's subagents run on, canonical providerId/modelId plus optional reasoning level, **present only when set**:
      * a run on the session model has nothing to say (same absent-when-none rule as maxConcurrency).
      * This is the value inherited when AmendWorkflow omits subagent_model.
   */
  subagentModel: z.string().optional(),
  /**
      * This run's script file, **already shaped as the model face should see it** (workspace-relative under the session working directory,
      * else absolute). **Present only when this run recorded a file** (same absent-when-none rule as subagentModel): projects where the
      * draft never materialized, and runs predating the feature, have nothing to say. When present, it is exactly the path the next
      * AmendWorkflow should pass.
   */
  scriptPath: z.string().optional(),
  actors: z.array(GetWorkflowRunActorSchema),
    /** Tail of log() events, in sequence order. Empty array when there are none. */
  logTail: z.array(GetWorkflowRunLogEntrySchema),
  /**
      * Phase table: declared phases in declaration order, followed by entered-but-undeclared ones. **The whole field is absent when the
      * script declared no phase and none was ever entered** -- such a run has no notion of phases; an empty array would read as an empty phase table.
   */
  phases: z
    .array(GetWorkflowRunPhaseSchema)
    .max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhases)
    .optional(),
  /**
      * Subagent roster, in mint order. **Always present**: a run with no actors is an empty array -- unlike phases,
      * how-many-subagents-always has an answer, and 0 is that answer.
   *
      * Deliberately not merged with the sibling actors: that one is a constant identity table, each entry here a read-time snapshot.
   */
  subagents: z.array(GetWorkflowRunSubagentSchema).max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxSubagents),
    /** The roster was cut by this bound. Absent otherwise (same family as truncated: never a false). */
  subagentsTruncated: z.literal(true).optional(),
    /** Whether the run as a whole still moves. Always present. */
  health: GetWorkflowRunHealthSchema,
  /**
      * The script's top-level return value, **already serialized to text** (string as-is, else pretty JSON). Present only for
      * completed runs; an undefined artifact means the whole field is absent.
   *
      * Why a string, not the raw value: model-facing serialization has exactly one implementation, in core
      * (serializeWorkflowArtifact, shared by the completion notice and TaskOutput). Passing raw values would allow the same
      * run's artifact to look different in the notice and in this tool.
   */
  result: z.string().optional(),
    /** Present for errored always; for stopped only provider / interrupted. code passes through verbatim, never folded. */
  error: GetWorkflowRunErrorSchema.optional(),
  /**
      * Escalation questions still awaiting an answer, in asked order. **The whole field is absent at zero** (port-projection rule, no empty arrays):
      * readers collapse the whole pending section instead of rendering an empty one.
   */
  pendingQuestions: z.array(GetWorkflowRunPendingQuestionSchema).optional(),
  /**
      * User-facing artifacts published by this run, in first-published order, **attached in any state** (a still-running run may
      * already have delivered its first image). **Absent when empty**, same rule as pendingQuestions. Capped at 32
      * (= ARTIFACT_CAPS.maxArtifactsPerRun, the most ids a run can have).
   */
  artifacts: z.array(GetWorkflowRunArtifactSchema).optional(),
}).strict();

export type GetWorkflowRunOutput = z.infer<typeof GetWorkflowRunOutputSchema>;

export const GetWorkflowRunOutputJsonSchema = toToolJsonSchema(GetWorkflowRunOutputSchema);
