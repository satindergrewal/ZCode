// ============================================================
// CreateWorkflow Tool - typecheck a dynamic-workflow script and start a background run
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import { SAVED_WORKFLOW_MAX_NAME_CHARS, SavedWorkflowScopeSchema } from "./saved-workflow.js";
import {
  WorkflowAdjustableSettingsSchema,
  WorkflowModelBindingsSchema,
} from "./workflow-settings.js";

export const CREATE_WORKFLOW_TOOL_NAME = "CreateWorkflow";

/**
 * Name of the built-in skill that teaches the model to write workflows
 * (apps/zcode-cli/packages/bundled-skills/skills/<name>/SKILL.md). The resolveInput of the four
 * authoring tools (Create/Amend/Save/EvalWorkflowSnippet) gate on it: submissions are refused
 * when the session never loaded that skill
 * (docs/dynamic-workflow/authoring.md "The authoring surface"). Lives in contracts because both
 * core's gate and bootstrap's skill bundle read it, and the two must not import each other.
 */
export const DYNAMIC_WORKFLOW_SKILL_NAME = "dynamic-workflows";

/** Violation copy for "exactly one execution source". A constant because the model is its only reader and all three paths share one sentence. */
export const CREATE_WORKFLOW_SOURCE_ERROR =
  "Provide exactly one workflow source: `script` for a one-off script written inline, `saved` to run a workflow saved in this project, or `path` for a script file on disk (the file a previous result named). Passing more than one, or none, is ambiguous.";

/** Violation copy for `args` belonging only to the `path` source (`saved` has its own `saved.args`; inline scripts declare none). */
export const CREATE_WORKFLOW_ARGS_WITHOUT_PATH_ERROR =
  "`args` belongs to the `path` source: it carries values for the arguments a script file declares in its `/* zcode-workflow` block. For a saved workflow pass `saved.args`; an inline `script` declares no arguments, so it takes none.";

/**
 * The `saved` source. The model fills `name`, optionally `args` and `scope` (for disambiguation);
 * `path` is a fact **backfilled** by `resolveInput`, and after normalization `scope` also becomes
 * the archive actually hit, so both are optional.
 *
 * The normalized input is therefore a legal execution state with `script` and `saved` **both
 * present** - exactly why the XOR cannot be written into zod (see {@link CreateWorkflowInputSchema}).
 */
export const CreateWorkflowSavedSourceSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(SAVED_WORKFLOW_MAX_NAME_CHARS)
      .describe("Name of a saved workflow (see ListSavedWorkflows)."),
    args: z
      .record(z.unknown())
      .optional()
      .describe("Values for the arguments the saved workflow declares."),
    /** Resolve backfill: where the saved file lives. Not filled by the model. */
    path: z.string().min(1).optional(),
    /**
     * Disambiguation: which archive to take the workflow from. Default keeps the existing lookup
     * order (project shadows global on equal names). After normalization `scope` becomes the
     * archive actually hit; see create-workflow-source.ts.
     */
    scope: SavedWorkflowScopeSchema.optional().describe(
      "Which archive to take it from; omit for the normal lookup order.",
    ),
  })
  .strict();

export type CreateWorkflowSavedSource = z.infer<typeof CreateWorkflowSavedSourceSchema>;

/**
 * Runtime `saved` block: the model-facing fields + `draft`.
 *
 * `draft` is the **location** backfilled after `resolveInput` writes the working copy: a saved
 * definition is never mutated by a run; what the model edits is this copy. Same posture as
 * `AmendWorkflow.predecessor` - facts are computed by the tool and left out of the model's JSON
 * schema, so the model never believes it should fill a path. When the draft cannot be written
 * the whole field is absent (best effort).
 */
export const CreateWorkflowResolvedSavedSourceSchema = CreateWorkflowSavedSourceSchema.extend({
  draft: z.string().min(1).optional(),
}).strict();

export type CreateWorkflowResolvedSavedSource = z.infer<
  typeof CreateWorkflowResolvedSavedSourceSchema
>;

/**
 * There are three execution sources, exactly one required - but this XOR is **deliberately not
 * encoded in the schema**.
 *
 * The reason is normalization: once `resolveInput` resolves the saved script (or `path` file),
 * the input carries both `script` (the bytes to run) and `saved` / `path` (its provenance). A
 * superRefine would explode this legal shape in two places - the handler's own `parse`, and the
 * call-runner's revalidation after a hook rewrites the input - and **only on non-inline paths**,
 * the class of bug that ships when untested. So the XOR is enforced by `entry.validateInput` on
 * the **model input**, the only place where it is true. A JSON schema cannot express refinements
 * anyway; the model side is guided by field descriptions.
 */
const CreateWorkflowModelInputSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Short run label in the user's language. Always pass it for an inline script; defaults to the saved workflow's name.",
      ),
    script: z
      .string()
      .optional()
      .describe("The whole workflow script, inline. Exactly one of `script`, `saved` and `path`."),
    saved: CreateWorkflowSavedSourceSchema.optional().describe(
      "A saved workflow to run, by name. Exactly one of `script`, `saved` and `path`.",
    ),
    /**
     * Third source:
     * a script file on disk. It is the **return path** of inline submission - the tool writes a
     * draft, the result names that file, and next time the model changes one line and hands the
     * same path back. Files with a `/* zcode-workflow` block parse as saved definitions (block
     * stripped, body as script, `args` validated against the block's declarations).
     */
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "A script file on disk (relative or absolute), usually the file a previous result named. Exactly one of `script`, `saved` and `path`.",
      ),
    /**
     * Args declared by the `path` file. `saved` has its own `saved.args` (same validation rules)
     * and inline scripts declare none, so this field lives and dies with `path` -
     * `validateInput` pins that on the model input.
     */
    args: z
      .record(z.unknown())
      .optional()
      .describe("Values for the arguments a `path` file declares. Only with `path`."),
    /**
     * This run's own concurrency cap (docs/dynamic-workflow/concurrency.md "Two bounds on a run").
     * Above or below the default both fine, no ceiling: `resolveInput` only floors to >= 1, and
     * confirm dialog and handler see the value that will take effect. Absent means the default
     * concurrency. Set only on user request - provider throttling is handled adaptively by the
     * runtime; the model should not use it as insurance.
     */
    max_concurrency: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Subagents working at once, above or below the default. Only when the user asks for more or less parallelism; never as a reaction to provider errors.",
      ),
    /**
     * Model for this run's subagents. Same family as
     * `max_concurrency`: the model surface takes a loose string and `resolveInput` resolves it
     * through the model-catalog port into canonical `providerId/modelId[$reasoningLevel]` - the
     * confirm dialog and handler see the value that will take effect, and an unresolvable name
     * returns as a business failure **before** the dialog opens. The main agent itself always
     * stays on the session model; absent means subagents do too.
     */
    subagent_model: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Model for the subagents (`providerId/modelId` or a model id). Only when the user asks; you stay on the session model.",
      ),
    // Amend-resume is not here: it is `AmendWorkflow`'s job (amend-workflow.ts). `.strict()` makes
    // the legacy spelling `resume_from` a visible schema error instead of a silently ignored full-price rerun.
  })
  .strict();

/**
 * Runtime input: the model-facing fields + facts backfilled by `resolveInput`.
 *
 * Backfilled entries share the `AmendWorkflow.predecessor` posture - the model's JSON schema
 * omits them because they are not fillable parameters but resolution results; if the model fills
 * them anyway, normalization overwrites unconditionally.
 */
export const CreateWorkflowInputSchema = CreateWorkflowModelInputSchema.extend({
  saved: CreateWorkflowResolvedSavedSourceSchema.optional(),
  /**
   * Line offset body line -> file line (non-zero only when a `path` / `saved` file carries a
   * metadata block). Added when diagnostics are reported by file line, so line numbers paste
   * directly into an `Edit` of that file.
   */
  script_line_offset: z.number().int().nonnegative().optional(),
  /**
   * The two settings adjustable in the confirm dialog
   * (docs/dynamic-workflow/launch.md "Adjusting the settings in the window"), backfilled by
   * `resolveInput` when the port is present. As above: a resolution result, omitted from the
   * model's JSON schema.
   */
  adjustable_settings: WorkflowAdjustableSettingsSchema.optional(),
  /**
   * Binding table resolved from models named in the script
   * (docs/dynamic-workflow/launch.md "Models the script names"), backfilled by `resolveInput`.
   * As above: a resolution result, omitted from the model's JSON schema.
   */
  model_bindings: WorkflowModelBindingsSchema.optional(),
}).strict();

export type CreateWorkflowInput = z.infer<typeof CreateWorkflowInputSchema>;

/** JSON schema for the model: no `script_line_offset`, `adjustable_settings`, or `model_bindings`; no `draft` inside `saved` either. */
export const CreateWorkflowInputJsonSchema = toToolJsonSchema(CreateWorkflowModelInputSchema);

export const CreateWorkflowDiagnosticSchema = z
  .object({
    code: z.number(),
    column: z.number(),
    line: z.number(),
    message: z.string(),
  })
  .strict();

export type CreateWorkflowDiagnostic = z.infer<typeof CreateWorkflowDiagnosticSchema>;

// The CreateWorkflow display is a bounded projection independent of the model text: diagnostics
// can be numerous and must be length-capped at the protocol boundary so a typecheck result cannot
// blow continuous/replayable messages into unbounded payloads.
// The display entry shape is shared by the create_workflow and eval_workflow_snippet display
// payloads (same TS diagnostic shape, same cap), hence defined here rather than in
// tool-result-metadata.ts - the latter would need to reference schemas in this file, creating a cycle.
export const CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS = 100;
export const CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS = 2_048;

export const createWorkflowToolResultDisplayDiagnosticSchema = z
  .object({
    line: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    code: z.number().int().nonnegative(),
    message: z.string().min(1).max(CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS),
  })
  .strict();

// The causality graph is a bounded projection on the display channel, capped directly at the
// tool-output boundary: persisted tool output and live display payloads share one contract so
// the two never drift into different truncation semantics.
// The payload carries only fields the GUI actually reads: edges are the single
// `{from, to, back?}` shape; region / certainty / edge kinds stay in the analyzer. The second
// layer is subagent-oriented: per-phase participant cards + handoff edges;
// step-level edges no longer travel in the payload (no readers); step / lane remain keys for
// run state and the inspector.
export const CREATE_WORKFLOW_GRAPH_MAX_STEPS = 64;
export const CREATE_WORKFLOW_GRAPH_MAX_LANES = 32;
export const CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS = 64;
export const CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS = 256;
export const CREATE_WORKFLOW_GRAPH_MAX_HANDOFF_TYPES = 8;
export const CREATE_WORKFLOW_GRAPH_MAX_PHASES = 32;
export const CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES = 128;
export const CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS = 64;
export const CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS = 128;

// `hole`: a still-open hole is a site (docs/dynamic-workflow/presentation.md "Holes on the
// timeline") on the main agent's `lane`; filled holes are no longer sites.
export const CREATE_WORKFLOW_STEP_KINDS = ["ask", "world-read", "hole"] as const;

// The static portion obtainable when the name only forms at runtime
// (`` agent(`researcher${i + 1}`) ``): the literal before the first hole (head) and after the
// last hole (tail). At least one is present - if the analyzer cannot get either, the whole field
// is absent, never an empty pattern. **Data only**: rendering it as "researcher..." with an
// ellipsis is the render layer's decision.
export const CreateWorkflowNamePatternSchema = z
  .object({
    head: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS).optional(),
    tail: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS).optional(),
  })
  .strict();

export type CreateWorkflowNamePattern = z.infer<typeof CreateWorkflowNamePatternSchema>;

// One step = one facade op that waits (ask / files.*). The lane is the actor executing it (or
// workspace / unknown); lanes appear only when the receiver is a may-set, in which case the step
// has been expanded per candidate lane (each copy with `source`). `repeat` separates two
// multiplicity hints: stack (instances coexist, drawn stacked) and
// serial (instances in sequence, already expressed by the loop-back arrow).
// certainty / region do not enter the payload: the GUI does not draw them.
export const CreateWorkflowStepSchema = z
  .object({
    id: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    kind: z.enum(CREATE_WORKFLOW_STEP_KINDS),
    label: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS),
    /** Static shape of the name when `label` only got the fallback string (inline `agent()` receiver). */
    labelPattern: CreateWorkflowNamePatternSchema.optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    lane: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    lanes: z
      .array(z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS))
      .max(CREATE_WORKFLOW_GRAPH_MAX_LANES)
      .optional(),
    /**
     * Site id expanded from, present only on copies of a may-set lane expansion
     * (copy ids look like `ask#2~actor#1`). It is the live-overlay join key: runtime instances
     * report the site id, so source-carrying cards collect state by
     * `(node.siteId === source, node.actorSiteId === lane)`. Deliberately excluded from
     * referential-integrity convergence - it points at the site the copy replaced, a node the
     * graph does not contain.
     */
    source: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS).optional(),
    /**
     * Phase the author marked this site into via `phase("...")` (`phase#2`, or the reserved
     * `unphased`). Lives and dies with the graph's `phases` / `phaseEdges` / `exits`: either all
     * four present (and then **every** step carries one; the partition is total) or all absent
     * (zero-marker scripts).
     */
    phase: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS).optional(),
    repeat: z.enum(["stack", "serial"]).optional(),
    /**
     * This site was written in by a hole fill: the value is the filling hole's site id (name key
     * `hole#<8 hex>`); on the hole's **own** phase it is the enclosing hole. The timeline draws
     * the fill's arrowhead and region from it
     * (docs/dynamic-workflow/presentation.md "Holes on the timeline"); absent for scripts never
     * filled.
     */
    fill: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS).optional(),
  })
  .strict();

export type CreateWorkflowStep = z.infer<typeof CreateWorkflowStepSchema>;

// Lane = one actor (plus one workspace lane). Multiplicity no longer attaches to lanes (was
// families -> nesting): lanes are no longer rendered; a family's member count is expressed by the
// participants' `member` / `many`.
export const CreateWorkflowLaneSchema = z
  .object({
    id: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    name: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS).optional(),
    /** Static shape when `name` is absent and the first `agent()` arg is a template with holes; mutually exclusive with `name`. */
    namePattern: CreateWorkflowNamePatternSchema.optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
  })
  .strict();

export type CreateWorkflowLane = z.infer<typeof CreateWorkflowLaneSchema>;

// An edge says one thing: runs after. Phase edges and handoffs share the shape. `back` marks a
// loop-back edge - drawn like any other edge, unlabeled; read only by layout ranking (back edges
// stay out of column order) and the frame header's cycle count. The analyzer's
// kind / certainty / exact stay out of the payload; both edge layers had the transitive reduction.
export const CreateWorkflowEdgeSchema = z
  .object({
    from: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    to: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    back: z.literal(true).optional(),
  })
  .strict();

export type CreateWorkflowEdge = z.infer<typeof CreateWorkflowEdgeSchema>;

/**
 * Phase stream (docs/dynamic-workflow/presentation.md "Streams"): the `from` phase hands work to
 * the `to` phase while both are running - two future phases chained by a channel. It is **not**
 * runs after, so it stays out of `phaseEdges`, carries no `back` (the UI infers direction from
 * site positions), and carries no analyzer edge kind.
 */
export const CreateWorkflowStreamSchema = z
  .object({
    from: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    to: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
  })
  .strict();

export type CreateWorkflowStream = z.infer<typeof CreateWorkflowStreamSchema>;

// Participant = one card in the board's second layer: the subagent (or workspace /
// unresolved) with a step on some lane in some phase. A fan-out family expanded by literal
// cardinality gets one card per member (`member`); unknown cardinality gets one `many` card for
// all. `steps` are its steps in this phase - run state aggregates from them; the inspector lists
// asks from them.
// Array order is handoff order (analyzer-fixed): collapsed top-to-bottom, expanded
// left-to-right; the first is the opener.
export const CreateWorkflowParticipantSchema = z
  .object({
    /** `${phase}:${lane}`, family members `${phase}:${lane}[${index}]`. */
    id: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    /** Phase id; always `unphased` for scripts without phase vocabulary (then `phases` is absent). */
    phase: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    lane: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    steps: z
      .array(z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS))
      .min(1)
      .max(CREATE_WORKFLOW_GRAPH_MAX_STEPS),
    member: z
      .object({
        index: z.number().int().nonnegative(),
        of: z.number().int().positive(),
      })
      .strict()
      .optional(),
    many: z.literal(true).optional(),
  })
  .strict();

export type CreateWorkflowParticipant = z.infer<typeof CreateWorkflowParticipantSchema>;

// Handoff = runs after between participants (post-reduction, happens-before quotiented by card).
// `types` lists artifact kinds crossing the edge (site-graph data edges); inspector-only, never
// on the arrow.
export const CreateWorkflowHandoffSchema = CreateWorkflowEdgeSchema.extend({
  types: z
    .array(z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS))
    .min(1)
    .max(CREATE_WORKFLOW_GRAPH_MAX_HANDOFF_TYPES)
    .optional(),
}).strict();

export type CreateWorkflowHandoff = z.infer<typeof CreateWorkflowHandoffSchema>;

// Phase = a group of steps the author marked out with `phase("...")`. The name is the key (two
// markers of the same name are one phase), so `name` is the author's verbatim word; the
// synthesized fallback phase `unphased` has **no name**, display name localized by the UI (same
// pattern as the workspace/unknown lanes). loc is the first marker's position.
export const CreateWorkflowPhaseSchema = z
  .object({
    id: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    name: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS).optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    /**
     * Other phases **still running** when this one was entered: strands they fanned out had not
     * joined yet. Phase-table order, listed phase ids, self excluded; the whole field is absent
     * when empty (present/absent with the vocabulary).
     *
     * It is a **node fact**, not an edge - control did not transfer from those phases; both sides
     * are simultaneously present - so it neither enters `phaseEdges` nor participates in edge
     * reduction (reduction would read it as runs after and cut real edges).
     * The reader is the timeline: fold adjacent phases linked by it into one forked "band", with
     * side tracks above the main line; the sidebar mini-track draws double segments from it.
     */
    alongside: z
      .array(z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS))
      .min(1)
      .max(CREATE_WORKFLOW_GRAPH_MAX_PHASES)
      .optional(),
    /** This phase was written in by a hole fill: the value is the filling hole's site id (same as `Step.fill`). */
    fill: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS).optional(),
  })
  .strict();

export type CreateWorkflowPhase = z.infer<typeof CreateWorkflowPhaseSchema>;

/** Upper bound of `holes`, the same number as the phase table: one hole is one phase. */
export const CREATE_WORKFLOW_GRAPH_MAX_HOLES = CREATE_WORKFLOW_GRAPH_MAX_PHASES;

// One **still-open** hole (docs/dynamic-workflow/authoring.md "Holes"; presentation.md "Holes on
// the timeline"): drawn as a dashed site on the timeline, listed as a chip in the confirm dialog.
// Filled holes are not here - their bodies are ordinary sites and phases, carrying only the
// `fill` marker.
export const CreateWorkflowHoleSchema = z
  .object({
    /** The hole's site id (name key `hole#<8 hex>`), also its id as a phase. */
    siteId: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    /** The hole's literal name. */
    name: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS),
    /** Type argument verbatim (`Verdict`). */
    type: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS),
    /** Phase id it was born in (`phases[].id`); present/absent with the phase vocabulary. */
    phase: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS).optional(),
    /** Tail hole: `return await hole(...)`; the script's ending is not written yet. */
    tail: z.literal(true).optional(),
  })
  .strict();

export type CreateWorkflowHole = z.infer<typeof CreateWorkflowHoleSchema>;

// The name is historical (it once carried only the causality graph). Three layers: the step layer
// is sites (keys for run state, no longer drawn); the participant layer is per-phase cards and
// handoffs (causality facts quotiented by card); the phase layer is control-flow facts (the
// control-flow graph's phase quotient). Bridges between layers: `Participant.phase` /
// `Participant.steps`, `Step.phase`, and `exits`.
export const CreateWorkflowCausalityGraphSchema = z
  .object({
    steps: z.array(CreateWorkflowStepSchema).max(CREATE_WORKFLOW_GRAPH_MAX_STEPS),
    lanes: z.array(CreateWorkflowLaneSchema).max(CREATE_WORKFLOW_GRAPH_MAX_LANES),
    participants: z
      .array(CreateWorkflowParticipantSchema)
      .max(CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS),
    handoffs: z.array(CreateWorkflowHandoffSchema).max(CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS),
    /**
     * Phase vocabulary, all-or-nothing with `phaseEdges`, `exits`, `Step.phase`: zero-marker
     * scripts omit all four, and the UI's view switch keys on "vocabulary present". On overflow
     * it is also absent wholesale (+ `truncated`) - a half-cut phase graph lies. Phases with no
     * members (marked but stepless) are in the table too: control flow passes through them.
     */
    phases: z.array(CreateWorkflowPhaseSchema).max(CREATE_WORKFLOW_GRAPH_MAX_PHASES).optional(),
    phaseEdges: z
      .array(CreateWorkflowEdgeSchema)
      .max(CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES)
      .optional(),
    /**
     * Phase streams: `data` edges of the causality graph's phase quotient whose ends are mutual
     * `alongside` (found at the bounds layer); present/absent with the vocabulary, absent when
     * the group is empty. The timeline uses it to lift a pipeline's phases out of the band into
     * one line, drawn as a stream track.
     */
    phaseStreams: z
      .array(CreateWorkflowStreamSchema)
      .max(CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES)
      .optional(),
    /**
     * Phases after which control flow can finish normally (sources of edges into the sink
     * terminal in the control-flow graph's phase quotient), phase-table order. The phase view's
     * "phase -> result" arrow reads it, making every arrow on that view real control flow. May be
     * empty within the group (no normal completion path); must not appear outside the group.
     */
    exits: z
      .array(z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS))
      .max(CREATE_WORKFLOW_GRAPH_MAX_PHASES)
      .optional(),
    /** Steps feeding the result (data facts, for drilldown); absent when the script returns nothing. */
    sink: z
      .array(z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS))
      .max(CREATE_WORKFLOW_GRAPH_MAX_STEPS)
      .optional(),
    /**
     * Still-open holes, source order (docs/dynamic-workflow/presentation.md "The display
     * contract"). One hole is one phase, so the cap matches the phase table's; filled holes are
     * not here - the phases and sites they wrote in carry `fill`. Absent entirely when none.
     */
    holes: z.array(CreateWorkflowHoleSchema).max(CREATE_WORKFLOW_GRAPH_MAX_HOLES).optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

export type CreateWorkflowCausalityGraph = z.infer<typeof CreateWorkflowCausalityGraphSchema>;

/**
 * The run's declared phase table: **named** phases of the causality graph, declaration order. Run
 * state only knows phases already entered, so for the sidebar mini-track to draw "stations
 * ahead" the table must be handed to the engine at submit time and recorded in `run-launched`.
 * Both submit paths (the `CreateWorkflow` tool, hub direct launch) share this function, so the
 * same script draws the same track on both. No graph / no phase vocabulary / only synthesized
 * `unphased` -> `undefined` (the field is absent entirely, not an empty array: the UI draws an
 * implicit station from absence).
 */
export function createWorkflowPhaseNames(
  graph: Pick<CreateWorkflowCausalityGraph, "phases"> | undefined,
): string[] | undefined {
  return namedPhases(graph)?.map((phase) => phase.name);
}

/**
 * "Running alongside" table aligned **by position** with {@link createWorkflowPhaseNames}:
 * `out[i]` holds indices (into the same named-phase table) of other phases still running when
 * the i-th named phase was entered.
 *
 * The index space is **named phases**, not the graph's original phase table: unnamed phases (the
 * synthesized `unphased`) are skipped, and references to them, to unlisted phases, or to self
 * are dropped - an out-of-range index would tie "running alongside" to the wrong station. It
 * enters `run-launched` as `DynamicWorkflowRunSubmitRequest.phaseAlongside`; the sidebar
 * mini-track draws adjacent in-band stations as a double segment.
 *
 * No graph / no phase vocabulary / no phase with alongside -> `undefined` (field absent
 * entirely, not a list of empty arrays: absence means "this track is a straight line").
 */
export function createWorkflowPhaseAlongside(
  graph: Pick<CreateWorkflowCausalityGraph, "phases"> | undefined,
): number[][] | undefined {
  const named = namedPhases(graph);
  if (named === undefined) return undefined;
  const indexOf = new Map(named.map((phase, index) => [phase.id, index]));
  let any = false;
  const out = named.map((phase, self) => {
    const indexes: number[] = [];
    for (const id of phase.alongside ?? []) {
      const index = indexOf.get(id);
      if (index === undefined || index === self || indexes.includes(index)) continue;
      indexes.push(index);
    }
    any = any || indexes.length > 0;
    return indexes;
  });
  return any ? out : undefined;
}

/** Named phases (declaration order, capped), with `name` narrowed. */
type CreateWorkflowNamedPhase = CreateWorkflowPhase & { name: string };

/**
 * The table shared by the two functions above: **named** phases of the causality graph,
 * declaration order, capped at `CREATE_WORKFLOW_GRAPH_MAX_PHASES`. Extracted as a function
 * precisely so both walk the same filter into the same index space - `phaseAlongside[i]` must
 * refer to station `phaseNames[i]`.
 */
function namedPhases(
  graph: Pick<CreateWorkflowCausalityGraph, "phases"> | undefined,
): CreateWorkflowNamedPhase[] | undefined {
  if (graph?.phases === undefined) return undefined;
  const named: CreateWorkflowNamedPhase[] = [];
  for (const phase of graph.phases) {
    const name = phase.name;
    if (name === undefined) continue;
    named.push({ ...phase, name });
    if (named.length >= CREATE_WORKFLOW_GRAPH_MAX_PHASES) break;
  }
  return named.length === 0 ? undefined : named;
}

// The two new fields appear only when a run actually launched after confirmation; diagnostics-only results keep the original shape.
// Explicit schemas instead of smuggling through raw: the point of .strict() is that shape changes are explicit commits.
export const CreateWorkflowOutputSchema = z
  .object({
    diagnostics: z.array(CreateWorkflowDiagnosticSchema),
    ok: z.boolean(),
    response: z.string(),
    causalityGraph: CreateWorkflowCausalityGraphSchema.optional(),
    /** Present only when a background run launched; not a general status field, hence the single literal. */
    status: z.literal("backgrounded").optional(),
    /** Background task id == taskId == runId (the key for cancel and status queries). */
    backgroundTaskId: z.string().min(1).optional(),
    /**
     * Present only when `AmendWorkflow` changed concurrency in place
     * (docs/dynamic-workflow/launch.md "Changing only the parallelism of a live run"): **no** new
     * run, hence neither `status: "backgrounded"` nor `backgroundTaskId`; the run is the one from
     * the call.
     *
     * An explicit block, not shape-guessing by consumers: "ok without status" has other origins
     * on this tool (typecheck-only when no run port exists). Numbers are absolute;
     * `maxConcurrency === defaultConcurrency` means "this run has no cap of its own".
     *
     * ⚠ This fact does **not cross v4**: the protocol's `toolOutputSchema` carries only
     * `text` / `display` / `truncated`, so it serves the CLI/TUI, in-process consumers, and
     * contract tests; the desktop UI cannot see it.
     */
    retuned: z
      .object({
        runId: z.string().min(1),
        maxConcurrency: z.number().int().positive(),
        previous: z.number().int().positive(),
        defaultConcurrency: z.number().int().positive(),
      })
      .strict()
      .optional(),
    /**
     * Which hole `FillWorkflowHole` filled
     * (docs/dynamic-workflow/launch.md "The `FillWorkflowHole` tool"):
     * site id and **name**, plus draft path and line. Present on success and refusal, and
     * **crosses v4** - the display projection carries it verbatim and the tool row names itself
     * from it. Not readable from the row's input: the transcript stores the model's own input;
     * the `hole` block backfilled by resolveInput is for permission rules and the handler only,
     * never reaching the row (first observed live 2026-09-28: the row title became the hole's
     * site id).
     */
    fill: z
      .object({
        siteId: z.string().min(1).max(64),
        name: z.string().min(1).max(128),
        draftPath: z.string().min(1).optional(),
        line: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CreateWorkflowOutput = z.infer<typeof CreateWorkflowOutputSchema>;

export const CreateWorkflowOutputJsonSchema = toToolJsonSchema(CreateWorkflowOutputSchema);
