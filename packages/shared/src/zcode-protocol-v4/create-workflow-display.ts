// ============================================================
// CreateWorkflow's tool-card display payload (a member of rows.ts' toolCallDisplaySchema)
// ============================================================
// Split from rows.ts: the workflow display + causal graph schemas pushed rows.ts past its max-lines cap,
// and they form one self-contained vocabulary (same precedent as workspace-hook-review.ts--feature-level schemas get their own module).

import { z } from "zod";

// The CreateWorkflow display is a bounded projection independent of model text; diagnostic count and per-message length must be
// capped at the protocol boundary, keeping type-check results from bloating continuous/replayable messages into unbounded payloads.
// causalityGraph likewise: step / lane / edge counts and label lengths are capped at the tool-output boundary, mirrored
// by the same bounds here. The graph's vocabulary is deliberately tiny: participant cards + one arrow (runs after; `back` marks back edges only) +
// phase modules + deliverable markers; the analyzer's kind / certainty / exact / region never enter the payload. Handoff edges are causal facts quotiented by subagent; phase-level
// edges are the control-flow graph's phase quotient; steps / lanes serve only as run-state and inspector keys, never drawn.
//
// The statically obtainable shape when the name only forms at runtime (`` agent(`researcher${i + 1}`) ``): the literal
// before the first hole (head) and after the last (tail). At least one present; both trimmed with real characters.
// Data only: the ellipsis rendering "researcher..." is added by name-pattern.ts at render time; no copy is stored in the projection
// (same rationale as the anonymous fallback--see lane-name.ts' header).
const namePatternSchema = z
  .object({
    head: z.string().min(1).max(128).optional(),
    tail: z.string().min(1).max(128).optional(),
  })
  .strict();

// One edge = runs after; handoff and phase edges share the shape. `back` marks only loop-back edges (read by layout ranking and cycle counts),
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
            kind: z.enum(["ask", "world-read"]),
            label: z.string().min(1).max(128),
            // The static shape of that name when the inline `agent()` receiver's label falls back to the fallback string.
            labelPattern: namePatternSchema.optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
            lane: z.string().min(1).max(64),
            lanes: z.array(z.string().min(1).max(64)).max(32).optional(),
            // The expanded-from site id, present only on may-set lane-expanded copies (the live-overlay correlation key);
            // adding the field is additive, legacy payloads without it still pass .strict().
            source: z.string().min(1).max(64).optional(),
            // Phases the author marked with `phase("...")`.
            // Rises and falls with the graph's phases / phaseEdges / exits: all present or all absent.
            phase: z.string().min(1).max(64).optional(),
            repeat: z.enum(["stack", "serial"]).optional(),
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
    // The static shape when `name` is absent and agent()'s first arg is a hole-y template; exclusive with name.
            namePattern: namePatternSchema.optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .max(32),
    // Participants: one subagent card per phase (workspace / unresolved alike); array order is handoff order, first one opens.
    // fan-out families expand by literal cardinality into members; unknown cardinality becomes one many card.
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
    // Handoff = runs after between participants; types are the artifact kinds crossing it (inspector material, never on the arrow).
    handoffs: z
      .array(
        workflowEdgeSchema
          .extend({ types: z.array(z.string().min(1).max(128)).min(1).max(8).optional() })
          .strict(),
      )
      .max(256),
    // Phase vocabulary: the author's grouping structure, the main view's nodes. All-or-nothing with phaseEdges / exits / Step.phase--
    // marker-less scripts omit the whole set and the UI falls back to the step/lane view. Zero-member phases stay in the table.
    // `unphased` has no name; display name is UI-localized.
    phases: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            name: z.string().min(1).max(128).optional(),
            line: z.number().int().positive().optional(),
            column: z.number().int().positive().optional(),
            // Other phases still running when this one was entered (their strands not yet joined), in phase-table order, excluding itself,
            // absent when empty. A node fact, not an edge--control never transferred from there, so not in phaseEdges.
            // The timeline folds adjacent phases into one forked "band"; the sidebar mini-track draws a double strand.
            alongside: z.array(z.string().min(1).max(64)).min(1).max(32).optional(),
          })
          .strict(),
      )
      .max(32)
      .optional(),
    phaseEdges: z.array(workflowEdgeSchema).max(128).optional(),
    // Phases after which control flow can finish normally (the phase view's "phase -> deliverable" arrows); may be empty within a group.
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
  })
  .strict();
export type ToolCallCreateWorkflowDisplay = z.infer<typeof toolCallCreateWorkflowDisplaySchema>;
