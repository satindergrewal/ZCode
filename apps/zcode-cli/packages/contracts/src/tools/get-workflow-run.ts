// ============================================================
// GetWorkflowRun Tool - adaptive detail of a single workflow run (progress summary / artifacts / failure)
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

// The situation cross-section (phases / subagents / health) schemas live in
// get-workflow-run-roster.ts; re-exported verbatim here to keep the `@zcode/contracts` import path unchanged.
export * from "./get-workflow-run-roster.js";

export const GET_WORKFLOW_RUN_TOOL_NAME = "GetWorkflowRun";

export const GetWorkflowRunInputSchema = z
  .object({
    // snake_case matching TaskOutput's `task_id`: to the model these are the same family of
    // run/task identifiers; a naming-style fork only makes it guess between the two tools.
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
 * Run progress and usage (observation surface, no caps). `nodesObserved` is the **row count of
 * stored nodes** (sum of the three states), never a fake "total steps": dynamic workflows have
 * no static total, and `queued` exists only as an event phase, never stored.
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

/** One actor site instance. `persona` deliberately omitted: the whole system prompt is naturally unbounded. */
export const GetWorkflowRunActorSchema = z
  .object({
    siteId: z.string(),
    ordinal: z.number(),
    name: z.string().optional(),
  })
  .strict();

/**
 * One `log()` narrative. `at` is when the entry was journaled (`dwf_event.time_created`); the
 * model surface renders "how long ago" from it. Absent on journals predating the column - such
 * rows carry no age prefix. **Never** fall back to read-time `Date.now()`: it would label a
 * week-old narrative "just now".
 */
export const GetWorkflowRunLogEntrySchema = z
  .object({
    sequence: z.number(),
    message: z.string(),
    at: z.number().optional(),
  })
  .strict();

/**
 * An escalation question parked right now, awaiting the main agent.
 *
 * The **query fallback** when an escalation notification is dropped, and the model side's only
 * discovery surface: `ResolveWorkflowQuestion` accepts only `qid`, and notifications have two
 * known drop paths (stale branch generation / shutdown). `askedAt` shows the model how long the
 * question has waited - no timeout backstops it.
 */
export const GetWorkflowRunPendingQuestionSchema = z
  .object({
    qid: z.string(),
    /** Asking actor, `site@ordinal` form. */
    actor: z.string(),
    /** The actor's human-readable name; absent for anonymous actors (readers decide how to render nameless). */
    actorName: z.string().optional(),
    question: z.string(),
    context: z.string().optional(),
    /** Asked-at (epoch ms, same ruler as createdAt / updatedAt). */
    askedAt: z.number(),
  })
  .strict();

/** Upper bound of `holes`, same value as the display contract's hole cap (docs/dynamic-workflow/presentation.md). */
export const GET_WORKFLOW_RUN_MAX_HOLES = 32;

/**
 * One hole (docs/dynamic-workflow/authoring.md "Holes"). `waiting` awaits a body via
 * `FillWorkflowHole`; `filled` already has one; `since` / `filledAt` share createdAt's ruler.
 * Like escalation questions, the model side's only discovery surface once a notification is lost.
 */
export const GetWorkflowRunHoleSchema = z
  .object({
    /** The hole's site id (`hole#21b40fca`, name key); also `FillWorkflowHole`'s `hole_id`. */
    siteId: z.string(),
    ordinal: z.number(),
    /** The hole's literal name. */
    name: z.string(),
    /** Type argument verbatim (`Verdict`). */
    type: z.string(),
    state: z.enum(["waiting", "filled"]),
    /** Reached-at (epoch ms); present while `waiting`. */
    since: z.number().optional(),
    /** Filled-at (epoch ms); present when `filled`. */
    filledAt: z.number().optional(),
    /** Session that filled it. */
    filledBy: z.string().optional(),
  })
  .strict();

export type GetWorkflowRunHole = z.infer<typeof GetWorkflowRunHoleSchema>;

/**
 * One **user-facing artifact**: a product the script published via `artifact.*`, already sitting
 * in front of the user as a card.
 *
 * ⚠ Terminology: distinct from `result` on this tool's output (the script's top-level return
 * value, also called artifact in engine terms) - **two different things**. Model usage differs
 * too: `result` is content to relay; artifacts are things to **reference** by title.
 *
 * Deliberately **no `uri`**: the model cannot read the tool-artifact store. Fields take the
 ** latest version's values (`version` is the number; earlier versions' metadata live in the UI
 * side panel).
 */
export const GetWorkflowRunArtifactSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["file", "markdown", "chart", "table", "metrics", "board"]),
    /** Card title; absent when the script gave none (the facade's default title is the id). */
    title: z.string().optional(),
    /** Latest version number. */
    version: z.number(),
    /** MIME of content artifacts; absent for preset boards. */
    contentType: z.string().optional(),
    /** Byte count of the latest content version; absent for preset boards. */
    bytes: z.number().optional(),
    /** Workspace origin of a content artifact (bytes were copied into the store; this is only "where it came from"). */
    sourcePath: z.string().optional(),
    /** Label `report` entries received by a preset board; always 0 for content artifacts. */
    itemCount: z.number(),
    /** The run's deliverable (at most one), leading the list. */
    primary: z.literal(true).optional(),
  })
  .strict();

/** Structured failure. `code` is the stable discriminant - the model must tell "process died" from "script failed". */
export const GetWorkflowRunErrorSchema = z
  .object({
    code: z.string(),
    message: z.string(),
    /** Present only when `code === "ProviderStop"`. */
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

/** Character cap of `summary`. A one-sentence budget: past it, it is not a summary but another report. */
export const GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS = 400;

export const GetWorkflowRunOutputSchema = WorkflowRunSummarySchema.extend({
  /**
   * The situation in one sentence: status + running/ended for how long + phase position + step
   * and in-flight breakdown + pending questions + last progress. Assembled **deterministically**
   * by the handler from the structured fields below (no model in the loop), so one snapshot
   * always yields one sentence; capped by {@link GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS}, dropping
   * whole trailing sentences on overflow.
   */
  summary: z.string().max(GET_WORKFLOW_RUN_SUMMARY_MAX_CHARS),
  /**
   * When this snapshot was read (epoch ms). Every "how long ago" on the model surface is
   * computed against it - one clock per output, or two ages cannot compare. `formatModelContent`
   * takes a single argument (core's ToolEntry contract), so reading the clock can only happen in
   * the handler, carried out with the result; the formatter stays a pure `(output) => text`,
   * pinable verbatim.
   */
  generatedAt: z.number(),
  usage: GetWorkflowRunUsageSchema,
  /**
   * This run's own concurrency cap (subagents in flight), **present only when below the current
   * ceiling**: a run at the ceiling has nothing to say (same "absent when default" rule as
   * pendingQuestions). This is the value AmendWorkflow inherits when `max_concurrency` is
   * omitted - the model thus knows what an amendment would inherit.
   */
  maxConcurrency: z.number().int().positive().optional(),
  /**
   * Model of this run's subagents, canonical `providerId/modelId[$reasoningLevel]`, **present
   * only when set**: a run on the session model has nothing to say (same rule as
   * `maxConcurrency`). This is the value AmendWorkflow inherits when `subagent_model` is omitted.
   */
  subagentModel: z.string().optional(),
  /**
   * Models named by this run's script: verbatim script name -> canonical form, **present only
   * when the script named models**. Same-name bindings AmendWorkflow inherits.
   */
  modelBindings: z.record(z.string()).optional(),
  /**
   * This run's script file, **already shaped for the model surface** (workspace-relative when
   * under the session cwd, else absolute). **Present only when the run recorded a file** (same
   * rule as `subagentModel`): projects where drafts cannot be written and pre-feature runs have
   * nothing to say. When present, it is exactly the `path` the next `AmendWorkflow` should pass.
   */
  scriptPath: z.string().optional(),
  actors: z.array(GetWorkflowRunActorSchema),
  /** Tail of `log()` events, in order (sequence ascending). Empty array when none. */
  logTail: z.array(GetWorkflowRunLogEntrySchema),
  /**
   * Phase table: declared phases in declaration order, then those "entered but undeclared".
   * **Absent entirely when the script declared no phases and entered none** - such a run has no
   * notion of phases; an empty array would read as "the phase table is empty".
   */
  phases: z
    .array(GetWorkflowRunPhaseSchema)
    .max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxPhases)
    .optional(),
  /**
   * Subagent roster, minting order. **Always present**; zero actors is an empty array: unlike
   * `phases`, "how many subagents" always has an answer, and 0 is it.
   *
   * Deliberately not merged with the sibling `actors`: that is a constant identity table; each
   * entry here is a read-time snapshot.
   */
  subagents: z.array(GetWorkflowRunSubagentSchema).max(GET_WORKFLOW_RUN_ROSTER_LIMITS.maxSubagents),
  /** The roster was cut by this bound. Absent when not (same `truncated` family: never `false`). */
  subagentsTruncated: z.literal(true).optional(),
  /** Whether the run as a whole is still moving. Always present. */
  health: GetWorkflowRunHealthSchema,
  /**
   * The script's top-level return value, **already serialized to text** (strings verbatim,
   * otherwise pretty JSON). Present only for completed runs; an `undefined` product drops the field.
   *
   * Why a string, not the raw value: model-facing serialization has one implementation in core
   * (`serializeWorkflowArtifact`, shared by the completion notification and TaskOutput). Passing
   * raw values would allow "the same run's product looks different in the notification and in
   * this tool".
   */
  result: z.string().optional(),
  /** Always present for errored; for stopped only provider / interrupted. `code` passes through verbatim, unfolded. */
  error: GetWorkflowRunErrorSchema.optional(),
  /**
   * Escalated questions still owed answers, in asked order. **Absent entirely when none**
   * (same rule as the port projection, never an empty array): readers hide the whole pending
   * section instead of rendering an empty one.
   */
  pendingQuestions: z.array(GetWorkflowRunPendingQuestionSchema).optional(),
  /**
   * This run's holes (docs/dynamic-workflow/launch.md "The `FillWorkflowHole` tool"; engine docs
   * "The run snapshot"): every site reached, `waiting` for the main agent's body, `filled` done.
   * Same rule as pendingQuestions: **absent entirely when none**, bounded 32; the query fallback
   * when hole notifications are lost.
   */
  holes: z.array(GetWorkflowRunHoleSchema).max(GET_WORKFLOW_RUN_MAX_HOLES).optional(),
  /**
   * User-facing artifacts published by this run, first-publication order, **attached in any
   * state** (a running run may have delivered its first image already). **Absent entirely when
   * none**, same rule as pendingQuestions. Bounded 32
   * (= `ARTIFACT_CAPS.maxArtifactsPerRun`, the most ids a run can have).
   */
  artifacts: z.array(GetWorkflowRunArtifactSchema).optional(),
}).strict();

export type GetWorkflowRunOutput = z.infer<typeof GetWorkflowRunOutputSchema>;

export const GetWorkflowRunOutputJsonSchema = toToolJsonSchema(GetWorkflowRunOutputSchema);
