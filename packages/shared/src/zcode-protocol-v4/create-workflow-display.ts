// ============================================================
// CreateWorkflow tool-card display payload (the toolCallDisplaySchema member of rows.ts)
// ============================================================
// Split from rows.ts: the workflow display + causal graph schemas pushed rows.ts past its max-lines cap,
// and they form one self-contained vocabulary (same precedent as workspace-hook-review.ts -- feature schemas get their own module).

import { z } from "zod";

// The CreateWorkflow display is a bounded projection independent of model text; diagnostic count and per-message length must be
// capped at the protocol boundary so a typecheck result cannot inflate continuous/replayable messages into unbounded payloads.
// causalityGraph mirrors the same bounds: step / lane / edge counts and label lengths are capped at the tool-output boundary.
// The graph vocabulary is deliberately tiny: participant cards + one arrow (runs after; `back` marks back edges only) +
// phase modules + deliverable markers; the analyzer's kind / certainty / exact / region never enter the payload. Handoff edges are causality facts per subagent; phase-layer
// edges are the phase quotient of the control-flow graph; steps / lanes serve only as runtime-state and inspector keys, never drawn.
//
// The static shape obtainable only when the name forms at runtime (`agent(`researcher${i + 1}`)`): the literal before the first hole (head)
// and after the last hole (tail). At least one present; both trimmed and non-empty.
// Data only: the ellipsis that renders "researcher..." is added by name-pattern.ts at render time; the projection stores no copy
// (same reasoning as the anonymous fallback -- see the lane-name.ts header).
const namePatternSchema = z
  .object({
    head: z.string().min(1).max(128).optional(),
    tail: z.string().min(1).max(128).optional(),
  })
  .strict();

// One edge = runs after; handoff and phase edges share the shape. `back` marks loop-back edges only (read by layout ranking and cycle counts),
// drawn like any other edge.
const workflowEdgeSchema = z
  .object({
    from: z.string().min(1).max(64),
    to: z.string().min(1).max(64),
    back: z.literal(true).optional(),
  })
  .strict();

const toolCallCreateWorkflowCausalityGraphSchema = z
  .object({
    steps: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            // `hole`: the open hole's own stop (docs/dynamic-workflow/presentation.md, Holes on the timeline);
            // lane always `main`, phase the hole's own (memberless); the run's `holes[]` joins by siteId.
            // Kept in sync with contracts' CREATE_WORKFLOW_STEP_KINDS.
            kind: z.enum(["ask", "world-read", "hole"]),
            label: z.string().min(1).max(128),
            // The static shape when an inline `agent()` receiver's label falls back to the fallback string.
            labelPattern: namePatternSchema.optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
            lane: z.string().min(1).max(64),
            lanes: z.array(z.string().min(1).max(64)).max(32).optional(),
            // Expansion-source stop id, present only on may-set lane expansions (the live-overlay join key);
            // the field is additive: old payloads without it still pass .strict().
            source: z.string().min(1).max(64).optional(),
            // Phases the author assigned via `phase("...")` markers.
            // Rides with the graph's phases / phaseEdges / exits: all present or all absent.
            phase: z.string().min(1).max(64).optional(),
            repeat: z.enum(["stack", "serial"]).optional(),
            // This stop was written by a fill (docs/dynamic-workflow/presentation.md, Holes on the timeline):
            // the value is that hole's stop id (name key `hole#<8 hex>`); on the hole's OWN phase/stop the value is the
            // containing hole (nesting lives only here, not in the id). The timeline draws the fill's head and region from the phase key; this copy
            // on the step is inspector material. additive: old payloads without it still pass .strict().
            fill: z.string().min(1).max(64).optional(),
          })
          .strict(),
      )
      .max(64),
    lanes: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            name: z.string().min(1).max(128).optional(),
            // The static shape when `name` is absent and agent()'s first arg is a hole-bearing template; disjoint from name.
            namePattern: namePatternSchema.optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .max(32),
    // Participants = one subagent card per phase (workspace/unresolved share the shape); array order is handoff order, first is the opener.
    // fan-out families expand to members by literal cardinality; unknown cardinality becomes one many card.
    participants: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            phase: z.string().min(1).max(64),
            lane: z.string().min(1).max(64),
            steps: z.array(z.string().min(1).max(64)).min(1).max(64),
            member: z
              .object({ index: z.number().int().nonnegative(), of: z.number().int().positive() })
              .strict()
              .optional(),
            many: z.literal(true).optional(),
          })
          .strict(),
      )
      .max(64),
    // Handoff = runs after between participants; types are the artifact types crossing it (inspector material, never on the arrow).
    handoffs: z
      .array(
        workflowEdgeSchema
          .extend({ types: z.array(z.string().min(1).max(128)).min(1).max(8).optional() })
          .strict(),
      )
      .max(256),
    // Phase vocabulary: author-imposed grouping; the main view uses it as nodes. All-or-nothing with phaseEdges / exits / Step.phase --
    // marker-free scripts omit all of it and the UI falls back to the step/lane view. Empty phases still appear here.
    // `unphased` has no name; the UI localizes the display name.
    phases: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            name: z.string().min(1).max(128).optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
            // Other phases still running when this one entered (strands not yet joined), in phase-table order, itself excluded;
            // absent when empty. A node fact, not an edge -- control never transferred from there, so not in phaseEdges.
            // The timeline folds adjacent phases into one forked band; the sidebar mini-track draws a double segment.
            alongside: z.array(z.string().min(1).max(64)).min(1).max(32).optional(),
            // This phase was written by a fill: the value is that hole's stop id. The timeline folds consecutive stops of one `fill` into
            // one fill head + region (docs/dynamic-workflow/presentation.md, Holes on the timeline).
            fill: z.string().min(1).max(64).optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    phaseEdges: z.array(workflowEdgeSchema).max(128).optional(),
    // Phase streams (docs/dynamic-workflow/presentation.md, Streams): data edges whose endpoints are alongside each other,
    // only {from, to} -- not runs after, not in phaseEdges, no back. All-or-nothing with the vocabulary.
    phaseStreams: z
      .array(z.object({ from: z.string().min(1).max(64), to: z.string().min(1).max(64) }).strict())
      .max(128)
      .optional(),
    // Open holes in source order (docs/dynamic-workflow/authoring.md, Holes): a hole is a phase (id = stop id, name = literal),
    // so it also appears in `phases`; this table adds the two facts the phase table cannot carry -- that it is a hole, its type text --
    // plus `tail` (it is the script's tail: the track runs 40px past it, then fades). Filled holes are not here.
    holes: z
      .array(
        z
          .object({
            siteId: z.string().min(1).max(64),
            name: z.string().min(1).max(128),
            type: z.string().min(1).max(128),
            phase: z.string().min(1).max(64).optional(),
            tail: z.boolean().optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    // Phases after which control flow can finish normally (the phase view's phase -> deliverable arrow); may be empty.
    exits: z.array(z.string().min(1).max(64)).max(32).optional(),
    sink: z.array(z.string().min(1).max(64)).max(64).optional(),
    truncated: z.boolean().optional(),
  })
  .strict();
export type ToolCallCreateWorkflowCausalityGraph = z.infer<
  typeof toolCallCreateWorkflowCausalityGraphSchema
>;

export const toolCallCreateWorkflowDisplaySchema = z
  .object({
    kind: z.literal("create_workflow"),
    ok: z.boolean(),
    errorCount: z.number().int().nonnegative(),
    diagnostics: z
      .array(
        z
          .object({
            line: z.number().int().nonnegative(),
            column: z.number().int().nonnegative(),
            code: z.number().int().nonnegative(),
            message: z.string().min(1).max(2_048),
          })
          .strict(),
      )
      .max(100),
    causalityGraph: toolCallCreateWorkflowCausalityGraphSchema.optional(),
    truncated: z.boolean().optional(),
    // Which hole this FillWorkflowHole row filled (docs/dynamic-workflow/presentation.md, The fill row): stop id,
    // **name**, draft path and line. The row names itself from it and the card join accumulates head labels from it -- the transcript stores only the
    // model's own input, and resolveInput's backfilled `hole` never reaches the row, so the name must ride the display. Present on success and rejection.
    fill: z
      .object({
        siteId: z.string().min(1).max(64),
        name: z.string().min(1).max(128),
        draftPath: z.string().min(1).max(1_024).optional(),
        line: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ToolCallCreateWorkflowDisplay = z.infer<typeof toolCallCreateWorkflowDisplaySchema>;
