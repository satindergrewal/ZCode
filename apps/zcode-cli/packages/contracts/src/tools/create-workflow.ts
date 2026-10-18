// ============================================================
// CreateWorkflow Tool - typecheck a dynamic-workflow script and start a background run
// ============================================================

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";
import { SAVED_WORKFLOW_MAX_NAME_CHARS, SavedWorkflowScopeSchema } from "./saved-workflow.js";

export const CREATE_WORKFLOW_TOOL_NAME = "CreateWorkflow";

/**
 * Built-in skill name that teaches models to write workflows (apps/zcode-cli/packages/bundled-skills/skills/<name>/SKILL.md).
 * The resolveInput of all four authoring tools (Create/Amend/Save/EvalWorkflowSnippet) gates on it: without this
 * skill loaded in the session, script submission is rejected.
 * It lives in contracts because both core's gate and bootstrap's skill pack read it, and neither may import the other.
 */
export const DYNAMIC_WORKFLOW_SKILL_NAME = "dynamic-workflows";

/** The "exactly one body source" violation note. A constant because the model is its only reader: same sentence on all three paths. */
export const CREATE_WORKFLOW_SOURCE_ERROR =
  "Provide exactly one workflow source: `script` for a one-off script written inline, `saved` to run a workflow saved in this project, or `path` for a script file on disk (the file a previous result named). Passing more than one, or none, is ambiguous.";

/** Violation note for `args` belonging only to the `path` source (`saved` has its own saved.args; inline scripts declare none). */
export const CREATE_WORKFLOW_ARGS_WITHOUT_PATH_ERROR =
  "`args` belongs to the `path` source: it carries values for the arguments a script file declares in its `/* zcode-workflow` block. For a saved workflow pass `saved.args`; an inline `script` declares no arguments, so it takes none.";

/**
 * The `saved` source. The model fills `name`, optionally `args` and `scope` (disambiguation); `path` is a fact
 * **backfilled** by `resolveInput`, and after normalization `scope` becomes the matched root, so both are optional.
 * The normalized input is therefore a legal execution state with `script` and `saved` **both present** -- exactly why
 * the XOR cannot live in zod (see {@link CreateWorkflowInputSchema}).
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
    /** Resolution backfill: where the saved file lives. Never model-filled. */
    path: z.string().min(1).optional(),
    /**
     * Disambiguation: which tier to take the workflow from; default follows the existing lookup order (project shadows global on name ties).
     * After normalization `scope` is the **matched** root; see create-workflow-source.ts.
     */
    scope: SavedWorkflowScopeSchema.optional().describe(
      "Which archive to take it from; omit for the normal lookup order.",
    ),
  })
  .strict();

export type CreateWorkflowSavedSource = z.infer<typeof CreateWorkflowSavedSourceSchema>;

/**
 * The runtime `saved` block: the model-facing fields plus `draft`.
 *
 * `draft` is the **location** backfilled after `resolveInput` writes the working copy: a saved definition is never
 * mutated by a run -- what the model edits is this copy. Same stance as `AmendWorkflow.predecessor`: facts are
 * computed by the tool and kept out of the model's JSON schema, so the model never believes it should fill a path.
 * When the write fails the field is absent entirely (best-effort draft).
 */
export const CreateWorkflowResolvedSavedSourceSchema = CreateWorkflowSavedSourceSchema.extend({
  draft: z.string().min(1).optional(),
}).strict();

export type CreateWorkflowResolvedSavedSource = z.infer<
  typeof CreateWorkflowResolvedSavedSourceSchema
>;

/**
 * The body has three sources, exactly one required -- but this XOR is **deliberately not in the schema**.
 *
 * Reason: normalization. After `resolveInput` resolves a saved script (or `path` file), the input carries both
 * `script` (the bytes to run) and `saved`/`path` (its provenance). A superRefine would explode this legal shape in
 * two places -- the handler's own `parse`, and call-runner's revalidation after a hook rewrites the input -- and
 * **only on non-inline paths**, the classic ships-untested bug. So the XOR is enforced by `entry.validateInput` on
 * the **model input**, the only place it is true. JSON schema cannot express refinements anyway; the model is
 * guided by field descriptions.
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
     * The third source: a script file on disk. It is the **return path** of inline submission -- the tool writes the
     * draft, the result names the file, and the model next round changes one line and hands the same path back.
     * Files with a `/* zcode-workflow` block parse as saved definitions (block stripped, body as script, `args`
     * validated against the block's declarations).
     */
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        "A script file on disk (relative or absolute), usually the file a previous result named. Exactly one of `script`, `saved` and `path`.",
      ),
    /**
     * Args declared by the `path` file. `saved` has its own `saved.args` (same validation), inline scripts none --
     * so this field lives and dies with `path`; `validateInput` pins that on the model input.
     */
    args: z
      .record(z.unknown())
      .optional()
      .describe("Values for the arguments a `path` file declares. Only with `path`."),
    /**
     * The run's own concurrency cap. Lower only, never raise:
     * `resolveInput` clamps to [1, ceiling], so the confirmation dialog and handler see the value that will apply.
     * Absent means ceiling. Set only on user request -- provider rate limits are the runtime's adaptive job;
     * the model should not treat this as insurance.
     */
    max_concurrency: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Upper bound on subagents working at once. Only when the user asks to limit parallelism; never as a reaction to provider errors.",
      ),
    /**
     * Which model this run's subagents run on. Same family as `max_concurrency`: the model surface takes a loose
     * string and `resolveInput` resolves it via the model-catalog port into canonical `providerId/modelId[$reasoningLevel]`
     * -- dialog and handler see the value that will apply; unresolvable names fail as a business error BEFORE the
     * dialog opens. The main agent always stays on the session model; absent means subagents too.
     */
    subagent_model: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Model for the subagents (`providerId/modelId` or a model id). Only when the user asks; you stay on the session model.",
      ),
    // Amend-resume is not here: that is `AmendWorkflow`'s job (amend-workflow.ts). `.strict()` turns the legacy
    // `resume_from` spelling into a visible schema error instead of a silently ignored full-price rerun.
  })
  .strict();

/**
 * Runtime input: the model-facing fields plus facts backfilled by `resolveInput`.
 *
 * Backfilled items share `AmendWorkflow.predecessor`'s stance -- absent from the model's JSON schema because they
 * are resolution results, not fillable parameters; if the model fills them anyway, normalization overrides unconditionally.
 */
export const CreateWorkflowInputSchema = CreateWorkflowModelInputSchema.extend({
  saved: CreateWorkflowResolvedSavedSourceSchema.optional(),
  /**
   * Line offset from body lines to file lines (non-zero only for `path`/`saved` files with a metadata block). Added
   * when diagnostics report file lines, so the number pastes straight into an `Edit` on that file.
   */
  script_line_offset: z.number().int().nonnegative().optional(),
}).strict();

export type CreateWorkflowInput = z.infer<typeof CreateWorkflowInputSchema>;

/** The JSON schema given to the model: no `script_line_offset`, and `saved` carries no `draft`. */
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

// The CreateWorkflow display is a bounded projection independent of the model text: diagnostics can be numerous and
// must be length-capped at the protocol boundary so typecheck results cannot inflate continuous/replayable messages.
// The diagnostic display entry shape is shared by both create_workflow and eval_workflow_snippet display payloads
// (same TS diagnostic shape, same cap), hence defined here and not in tool-result-metadata.ts --
// the latter would back-reference this file's schemas and cycle.
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

// The causality graph is a bounded projection of the display channel, capped right at the tool-output boundary: the
// persisted tool output and the live display payload share one contract, so truncation semantics cannot diverge.
// The payload carries only fields the GUI reads: edges are one shape `{from, to, back?}`; region/certainty/edge kinds
// stay in the analyzer. The second layer is subagent-oriented: per-phase participant cards plus handoff edges;
// step-level edges therefore left the payload (no readers); step/lanes remain keys into run state and the inspector.
export const CREATE_WORKFLOW_GRAPH_MAX_STEPS = 64;
export const CREATE_WORKFLOW_GRAPH_MAX_LANES = 32;
export const CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS = 64;
export const CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS = 256;
export const CREATE_WORKFLOW_GRAPH_MAX_HANDOFF_TYPES = 8;
export const CREATE_WORKFLOW_GRAPH_MAX_PHASES = 32;
export const CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES = 128;
export const CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS = 64;
export const CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS = 128;

export const CREATE_WORKFLOW_STEP_KINDS = ["ask", "world-read"] as const;

// The statically knowable part of a name that only materializes at runtime (`` agent(`researcher${i + 1}`) ``): the
// literal before the first hole (head) and after the last (tail). At least one is present -- without either the
// analyzer omits the whole field, never an empty pattern. **Data only**: rendering the ellipsis in "researcher..."
// is the view layer's decision.
export const CreateWorkflowNamePatternSchema = z
  .object({
    head: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS).optional(),
    tail: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS).optional(),
  })
  .strict();

export type CreateWorkflowNamePattern = z.infer<typeof CreateWorkflowNamePatternSchema>;

// One step = one facade operation that waits (ask / files.*). The lane is the executing actor (or workspace/unknown);
// lanes appear only when the receiver is a may-set, in which case the step was expanded per candidate lane
// (one copy each, with `source`). repeat distinguishes two multiplicity hints: stack (instances coexist, drawn as
// stacked cards) and serial (instances in sequence, already expressed by the loop arrow).
// certainty/region stay out of the payload: the GUI does not draw them.
export const CreateWorkflowStepSchema = z
  .object({
    id: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    kind: z.enum(CREATE_WORKFLOW_STEP_KINDS),
    label: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS),
    /** When `label` only got the fallback (inline `agent()` receiver): the static shape of that name. */
    labelPattern: CreateWorkflowNamePatternSchema.optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
    lane: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    lanes: z
      .array(z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS))
      .max(CREATE_WORKFLOW_GRAPH_MAX_LANES)
      .optional(),
    /**
     * The site id this copy expanded from, present only on may-set lane expansions (copy ids look like `ask#2~actor#1`).
     * It is the live-overlay join key: runtime instances report site ids, so source-carrying cards collect state by
     * `(node.siteId === source, node.actorSiteId === lane)`. Deliberately excluded from referential-integrity
     * convergence -- it points at the site the copy replaced, a node the graph does not contain.
     */
    source: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS).optional(),
    /**
     * `phases` / `phaseEdges` / `exits` live and die together: either all present (and then **every** step carries
     * one -- a complete partition) or all absent (zero-marker script).
     */
    phase: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS).optional(),
    repeat: z.enum(["stack", "serial"]).optional(),
  })
  .strict();

export type CreateWorkflowStep = z.infer<typeof CreateWorkflowStepSchema>;
// Lane = one actor (plus the workspace lane). Multiplicity no longer rides lanes (formerly families -> nesting):
// Lane = one actor (plus the workspace lane). Multiplicity no longer rides lanes (formerly families -> nesting):
// lanes are not rendered; family members count via participants' member/many.
export const CreateWorkflowLaneSchema = z
  .object({
    id: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    /** Static shape when `name` is absent and `agent()`'s first arg is a holed template; mutually exclusive with `name`. */
    namePattern: CreateWorkflowNamePatternSchema.optional(),

  })
  .strict();

export type CreateWorkflowLane = z.infer<typeof CreateWorkflowLaneSchema>;
// Edges mean one thing: runs-after. Phase edges and handoff edges share the shape. `back` marks cycle back-edges --
// drawn like any other edge, unlabeled; only layout ranking (back edges leave column order) and the header cycle
// count read it. The analyzer's kind/certainty/exact stay out of the payload; both edge layers got the same
// transitive reduction.
// transitive reduction.
export const CreateWorkflowEdgeSchema = z
    to: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_ID_CHARS),
    back: z.literal(true).optional(),
  })
  .strict();

export type CreateWorkflowEdge = z.infer<typeof CreateWorkflowEdgeSchema>;
// Participant = one card in the panel's second layer: the subagent (or workspace/unresolved) that had steps on some
// lane in a phase. Fan-out families expand to one card per literal member (`member`); unknown cardinality becomes
// one `many` card for all. `steps` are its steps in this phase -- run state aggregates from them, the inspector
// lists asks from them. Array order is handoff order (analyzer-set): collapsed top-to-bottom, expanded left-to-right, opener first.
// lists asks from them. Array order is handoff order (analyzer-set): collapsed top-to-bottom, expanded left-to-right, opener first.
export const CreateWorkflowParticipantSchema = z
    /** Phase id; constant `unphased` for phase-less scripts (then `phases` is absent). */
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
// Handoff = runs-after between participants (the reduced happens-before quotient per card). `types` are the artifact
// kinds crossing this edge (site-graph data edges); inspector-only, never on arrows.
// kinds crossing this edge (site-graph data edges); inspector-only, never on arrows.
  types: z
    .min(1)
    .max(CREATE_WORKFLOW_GRAPH_MAX_HANDOFF_TYPES)
    .optional(),
}).strict();

export type CreateWorkflowHandoff = z.infer<typeof CreateWorkflowHandoffSchema>;
// Phase = a group of steps the author marked with `phase("...")`. The name is the key (two markers, one phase), so
// `name` is the author's verbatim text; the synthesized fallback phase `unphased` has **no name** -- its display
// name is UI-localized (same pattern as workspace/unknown lanes). loc is the first marker's position.
// name is UI-localized (same pattern as workspace/unknown lanes). loc is the first marker's position.
  .object({
    name: z.string().min(1).max(CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS).optional(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
     * Other phases still **running** when this one was entered: their fanned-out strands had not yet joined. Phase
     * table order; listed phase ids, never self; absent entirely when empty (lives and dies with the vocabulary).
     *
     * It is **node fact**, not an edge -- control did not transfer; both sides were merely live together. So it
     * neither enters `phaseEdges` nor participates in edge reduction (reduction would read it as runs-after and cut
     * real edges). The reader is the timeline: fold adjacent phases it links into one forked "band", side tracks
     * above the main line; the sidebar mini-track draws double-lined segments from it.
     * above the main line; the sidebar mini-track draws double-lined segments from it.
     */
      .min(1)
      .max(CREATE_WORKFLOW_GRAPH_MAX_PHASES)
      .optional(),
  })
  .strict();

export type CreateWorkflowPhase = z.infer<typeof CreateWorkflowPhaseSchema>;
// The name is historical (once causality-graph-only). Three layers: step layer = sites (run-state keys, no longer
// drawn); participant layer = per-phase cards and handoffs (causal facts quotiented per card); phase layer = control
// flow facts (the control-flow graph's phase quotient). Bridges between layers: Participant.phase / Participant.steps,
// Step.phase, and exits.
// Step.phase, and exits.
export const CreateWorkflowCausalityGraphSchema = z
    lanes: z.array(CreateWorkflowLaneSchema).max(CREATE_WORKFLOW_GRAPH_MAX_LANES),
    participants: z
      .array(CreateWorkflowParticipantSchema)
      .max(CREATE_WORKFLOW_GRAPH_MAX_PARTICIPANTS),
    handoffs: z.array(CreateWorkflowHandoffSchema).max(CREATE_WORKFLOW_GRAPH_MAX_HANDOFFS),
     * The phase vocabulary; all-or-nothing with `phaseEdges`, `exits`, `Step.phase`: zero-marker scripts omit all
     * four, and the UI's view toggle keys on "vocabulary present". Over-bound also means absent entirely
     * (+ `truncated`) -- a half phase graph lies. Zero-member phases (marker only, no steps) still appear: control flows through them.
     * (+ `truncated`) -- a half phase graph lies. Zero-member phases (marker only, no steps) still appear: control flows through them.
     */
      .array(CreateWorkflowEdgeSchema)
      .max(CREATE_WORKFLOW_GRAPH_MAX_PHASE_EDGES)
      .optional(),
     * Phases after which control flow can finish normally (sources of edges into the sink terminal in the phase
     * quotient); phase-table order. The phase view's "phase -> deliverable" arrows read it, making every arrow on
     * that canvas a control-flow edge. May be empty in-group (no normal completion path); never appears outside the group alone.
     * that canvas a control-flow edge. May be empty in-group (no normal completion path); never appears outside the group alone.
     */
      .max(CREATE_WORKFLOW_GRAPH_MAX_PHASES)
    /** Which steps feed the deliverable (data fact, for drill-down); absent for return-less scripts. */
    /** Which steps feed the deliverable (data fact, for drill-down); absent for return-less scripts. */
      .optional(),
    truncated: z.boolean().optional(),
  })
  .strict();

export type CreateWorkflowCausalityGraph = z.infer<typeof CreateWorkflowCausalityGraphSchema>;

 * The run's declared phase table: the causality graph's **named** phases in declaration order. Run state only knows
 * entered phases; for the sidebar mini-track to show "stops ahead" the table must be handed to the engine at submit
 * time and recorded in `run-launched`. Both submit paths (CreateWorkflow tool, hub direct launch) share this helper,
 * so the same script draws the same track on both. No graph / no phase vocabulary / only synthesized `unphased`
 * -> `undefined` (the field is absent, not an empty array: the UI draws an implicit stop from absence).
 * -> `undefined` (the field is absent, not an empty array: the UI draws an implicit stop from absence).
 */
): string[] | undefined {
  return namedPhases(graph)?.map((phase) => phase.name);
}

 * The positionally-aligned "running alongside" table for {@link createWorkflowPhaseNames}: `out[i]` holds the
 * (named-table) indices of phases still running when named phase i was entered.
 *
 * Index space is **named phases**, not the graph's raw phase table: unnamed (synthesized `unphased`) phases are
 * skipped, and references to them, to unlisted phases, or to self are dropped -- an out-of-range index would tie
 * "running alongside" to the wrong stop. Travels via `DynamicWorkflowRunSubmitRequest.phaseAlongside` into
 * `run-launched`; the sidebar mini-track draws double-lined segments for in-band neighbors.
 *
 * No graph / no vocabulary / no phase with alongside -> `undefined` (field absent, not a row of empties:
 * absence means "this track is a straight line").
 * absence means "this track is a straight line").
 */
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
/** Named phases (declaration order, capped), `name` narrowed. */
/** Named phases (declaration order, capped), `name` narrowed. */
 * `CREATE_WORKFLOW_GRAPH_MAX_PHASES`. One helper precisely so both pass the same filter and land in the same
 * index space -- `phaseAlongside[i]` must mean stop `phaseNames[i]`.
 * index space -- `phaseAlongside[i]` must mean stop `phaseNames[i]`.
 */
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
// The two new fields appear only when a confirmation actually launched a run; diagnostic-only results keep the old shape.
// Explicit schema, not smuggled through raw: `.strict()` exists so shape changes are explicit commitments.
// Explicit schema, not smuggled through raw: `.strict()` exists so shape changes are explicit commitments.
export const CreateWorkflowOutputSchema = z
    ok: z.boolean(),
    response: z.string(),
    /** Present only when a background run launched; not a generic status field, hence the single literal. */
    /** Background task id == taskId == runId (the key for cancel and status queries). */
    /** Present only when AmendWorkflow changed concurrency in place: **no** new run, so neither
     * `status: "backgrounded"` nor `backgroundTaskId`; the run is the one from this call. */
    /** An explicit block, not shape-guessing: "ok without status" has other sources on this tool
     * (typecheck-only when no run port exists). Values are absolute; `maxConcurrency === ceiling` means
     * "this run has no cap of its own". */
    /** This fact does **not cross v4**: the protocol toolOutputSchema carries only text/display/truncated,
     * so it serves CLI/TUI and in-process consumers; desktop UI cannot see it. */

     * so it serves CLI/TUI and in-process consumers; desktop UI cannot see it.
     */

        runId: z.string().min(1),
        maxConcurrency: z.number().int().positive(),
        previous: z.number().int().positive(),
        ceiling: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CreateWorkflowOutput = z.infer<typeof CreateWorkflowOutputSchema>;

export const CreateWorkflowOutputJsonSchema = toToolJsonSchema(CreateWorkflowOutputSchema);
