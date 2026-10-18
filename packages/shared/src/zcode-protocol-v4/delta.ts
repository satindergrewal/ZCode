// ConversationDelta: seven ops, a closed set.
// No row.inserted (mid-insert), no row.moved, no field-level JSON patch--
// structural changes this model cannot express get a snapshot resync, deliberately shrinking the client error surface.
//
// The sole exception is the last two `workflowRun.*`: `workflowRuns` is a high-frequency state key whose whole-key replace would
// re-send the entire table per engine event (O(N) bytes/event, O(N^2)/run). They open a per-(runId, siteId, ordinal) delta hatch
// for that key only, semantics still "whole-key replace, just two levels deeper":
// header keys replace whole, entries replace whole, no field-level deep merge. Rules in workflow-runs-delta.ts.
import { z } from "zod";
import { streamablePathSchema } from "./core.js";
import { conversationRowSchema } from "./rows.js";
import { sharedContextImportStateSchema } from "./shared-context-import.js";
import {
  backgroundWorkSummarySchema,
  commandStateSummarySchema,
  goalStateSchema,
  inputRoutingSchema,
  pendingInteractionSchema,
  planStateSchema,
  queueStateSchema,
  sessionActionAvailabilitySchema,
  sessionConfigStateSchema,
  sessionControlSchema,
  sessionMetaStateSchema,
  sessionModelTransitionSchema,
  sessionUsageStateSchema,
  subagentProjectionStateSchema,
  workspaceHookAdmissionStateSchema,
} from "./snapshot.js";
import {
  WORKFLOW_RUNS_LIMITS,
  workflowRunActorSchema,
  workflowRunNodeSchema,
  workflowRunSchema,
  workflowRunsStateSchema,
} from "./workflow-runs.js";

// StatePatch: whole-key replace (Object.assign), closed key set. Never deep-merge within a key.
export const statePatchSchema = z.object({
  revision: z.number().optional(),
  control: sessionControlSchema.optional(),
  sharedContextImport: sharedContextImportStateSchema.optional(),
  availability: sessionActionAvailabilitySchema.optional(),
  inputRouting: inputRoutingSchema.optional(),
  meta: sessionMetaStateSchema.optional(),
  config: sessionConfigStateSchema.optional(),
  modelTransition: sessionModelTransitionSchema.nullable().optional(),
  usage: sessionUsageStateSchema.optional(),
  queue: queueStateSchema.optional(),
  pendingInteractions: z.array(pendingInteractionSchema).optional(),
  pendingCommands: z.array(commandStateSummarySchema).optional(),
  backgroundWorks: z.array(backgroundWorkSummarySchema).optional(),
  subagents: subagentProjectionStateSchema.optional(),
  // A workflow run's live state. The container is not strict, so legacy desktops merely **strip one key** and
  // keep every other key of the patch--exactly why it needs no version-skew defenses.
  workflowRuns: workflowRunsStateSchema.optional(),
  goal: goalStateSchema.nullable().optional(),
  plan: planStateSchema.nullable().optional(),
  // Soft gate: null = pending zeroed (hint bar gone); object = pending-review state update.
  workspaceHookAdmission: workspaceHookAdmissionStateSchema.nullable().optional(),
});
export type StatePatch = z.infer<typeof statePatchSchema>;

/**
 * A run's **header** = `workflowRunSchema` minus the actors / nodes tables delta-synced per instance.
 *
 * Derived via `.omit` from the same schema, so independently maintained field lists cannot break subscription parses. Small collections
 (reports / artifacts / phases / pendingQuestions...) stay in the header whole-key-replaced--
 */
export const workflowRunHeaderSchema = workflowRunSchema.omit({ actors: true, nodes: true });
export type WorkflowRunHeader = z.infer<typeof workflowRunHeaderSchema>;

/** Partial header update: present keys replace whole, absent keys untouched (never deep-merge). */
export const workflowRunHeaderPatchSchema = workflowRunHeaderSchema.partial();
export type WorkflowRunHeaderPatch = z.infer<typeof workflowRunHeaderPatchSchema>;

/** Header keys turned **absent**. "Zero => key absent" is the protocol contract of reports / pendingQuestions etc., so the delta must say it. */
export const workflowRunHeaderKeySchema = workflowRunHeaderSchema.keyof();
export type WorkflowRunHeaderKey = z.infer<typeof workflowRunHeaderKeySchema>;

/**
 * The **identity** of one evicted entry (the dedupe key shared by both tables). `.pick`ed from the actor schema rather than
 * hand-writing two fields: those bounds must have one definition, verbatim the `workflowRunHeaderSchema` `.omit` rationale.
 *
 * Deliberately **identity only**: all an eviction says is "this one left"; carrying the entry would make consumers
 * upsert。
 */
export const workflowRunEntryRefSchema = workflowRunActorSchema.pick({
  siteId: true,
  ordinal: true,
});
export type WorkflowRunEntryRef = z.infer<typeof workflowRunEntryRefSchema>;

export const conversationDeltaSchema = z.discriminatedUnion("op", [
  // Append at the tail (99%).
  z.object({ op: z.literal("row.appended"), row: conversationRowSchema }),
  // Whole-row replace by rowId (state-machine transition).
  z.object({ op: z.literal("row.upserted"), row: conversationRowSchema }),
  // Delete this row and everything after (edit/retry branch). Hits all loaded rows with rowId >= fromRowId.
  z.object({ op: z.literal("row.removed"), fromRowId: z.number() }),
  // Streaming text append. Only onto streaming rows (server-guaranteed; clients may assert).
  z.object({
    op: z.literal("row.delta"),
    rowId: z.number(),
    path: streamablePathSchema,
    append: z.string(),
  }),
  z.object({ op: z.literal("state.updated"), patch: statePatchSchema }),
  /**
   * Key-level delta of one dwf run. `revision` is the **post-change** `workflowRuns.revision` (absolute);
   * one engine event yields at most one such op (node phase, derived actor state, usage, watermark land together, atomically).
   *
   * The six payloads each mean one thing: `run` replaces by key, `cleared` names keys turned absent,
   * `removedActors` / `removedNodes` delete by (siteId, ordinal), `actors` / `nodes` upsert whole by the same key.
   * The four tables' caps equal the state key's--a delta must not be able to assemble an illegal state.
   *
   * **Application order is header -> removals -> upserts**, stated here and in field order: a key deleted then added by one op
   * (an overflowed run clearing tables at resume, or an entry evicted then returning) must land at the tail to match
   * sequential application of the two ops.
   */
  z.object({
    op: z.literal("workflowRun.updated"),
    runId: workflowRunSchema.shape.runId,
    revision: workflowRunsStateSchema.shape.revision,
    run: workflowRunHeaderPatchSchema.optional(),
    cleared: z
      .array(workflowRunHeaderKeySchema)
      .max(workflowRunHeaderKeySchema.options.length)
      .optional(),
    removedActors: z
      .array(workflowRunEntryRefSchema)
      .max(WORKFLOW_RUNS_LIMITS.maxActors)
      .optional(),
    removedNodes: z.array(workflowRunEntryRefSchema).max(WORKFLOW_RUNS_LIMITS.maxNodes).optional(),
    actors: z.array(workflowRunActorSchema).max(WORKFLOW_RUNS_LIMITS.maxActors).optional(),
    nodes: z.array(workflowRunNodeSchema).max(WORKFLOW_RUNS_LIMITS.maxNodes).optional(),
  }),
  /** The producer evicted this run (only the producer evicts, and it must be announced--clients never apply caps themselves). */
  z.object({
    op: z.literal("workflowRun.removed"),
    runId: workflowRunSchema.shape.runId,
    revision: workflowRunsStateSchema.shape.revision,
  }),
]);
export type ConversationDelta = z.infer<typeof conversationDeltaSchema>;
export type WorkflowRunUpdatedDelta = Extract<ConversationDelta, { op: "workflowRun.updated" }>;
export type WorkflowRunRemovedDelta = Extract<ConversationDelta, { op: "workflowRun.removed" }>;
