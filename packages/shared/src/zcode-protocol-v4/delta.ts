import { mcpAppInstanceSchema } from "../mcp-apps/instance.js";
// ConversationDelta: snapshot deltas and plugin-UI live-only notices; the op set is closed (10-protocol-spec 4.5).
// No row.inserted (mid-insert), no row.moved, no field-level JSON patch --
// structural changes this model cannot express get a snapshot resync, deliberately shrinking the client error surface.
//
// The sole exception is the last two `workflowRun.*` ops: `workflowRuns` is a high-frequency state key and whole-key
// replacement would resend the table per engine event (O(N) bytes/event, O(N^2)/run). They open a delta hatch --
// keyed by (runId, siteId, ordinal) -- for that key only, semantics still whole-key replacement, just two levels down:
// header keys replace whole, entries replace whole, zero field-level deep merges. Rules in workflow-runs-delta.ts.
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

// StatePatch: whole-key replacement (Object.assign), closed key set. Never deep-merge inside a key.
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
  // A workflow run's live state. The container is not strict, so legacy desktops merely strip the new key
  // and keep every other key -- exactly why it needs no version-skew defense.
  workflowRuns: workflowRunsStateSchema.optional(),
  goal: goalStateSchema.nullable().optional(),
  plan: planStateSchema.nullable().optional(),
  // Soft gate: null = pending zeroed (banner gone); object = pending-review state update.
  workspaceHookAdmission: workspaceHookAdmissionStateSchema.nullable().optional(),
});
export type StatePatch = z.infer<typeof statePatchSchema>;

export const pluginUiResourceSubscriberSchema = z
  .object({
    scopeId: z.string(),
    generation: z.number().int().nonnegative(),
    instance: mcpAppInstanceSchema,
  })
  .strict();

/**
 * A run's **header** = `workflowRunSchema` minus the actors / nodes instance-incremented tables.
 *
 * `.omit`-derived, not a transcribed field list: the 2026-09-04 permanently-dead subscription was the price of
 * two hand-written run vocabularies. Small collections (reports / artifacts / phases / pendingQuestions...) stay in the
 * header whole-key -- dozens of entries at most; a second delta syntax for them is one more thing to get wrong.
 */
export const workflowRunHeaderSchema = workflowRunSchema.omit({ actors: true, nodes: true });
export type WorkflowRunHeader = z.infer<typeof workflowRunHeaderSchema>;

/** Partial header update: present keys replace whole, absent keys untouched (never deep-merged). */
export const workflowRunHeaderPatchSchema = workflowRunHeaderSchema.partial();
export type WorkflowRunHeaderPatch = z.infer<typeof workflowRunHeaderPatchSchema>;

/** Header keys that became **absent**. Zero-entries-means-key-absent is protocol for reports / pendingQuestions etc, so the delta must say it. */
export const workflowRunHeaderKeySchema = workflowRunHeaderSchema.keyof();
export type WorkflowRunHeaderKey = z.infer<typeof workflowRunHeaderKeySchema>;

/**
 * The **identity** of one evicted entry (the dedup key both tables share). `.pick` from the actor schema, not
 * hand-written: these two bounds deserve one definition, same reason as `workflowRunHeaderSchema`'s `.omit`.
 *
 * Deliberately **identity only**: an eviction's whole message is "this one left"; carrying the entry would make
 * consumers read it as an upsert.
 */
export const workflowRunEntryRefSchema = workflowRunActorSchema.pick({
  siteId: true,
  ordinal: true,
});
export type WorkflowRunEntryRef = z.infer<typeof workflowRunEntryRefSchema>;

export const conversationDeltaSchema = z.discriminatedUnion("op", [
  // Append at the tail (the 99% case).
  z.object({ op: z.literal("row.appended"), row: conversationRowSchema }),
  // Whole-row replacement by rowId (state-machine transitions).
  z.object({ op: z.literal("row.upserted"), row: conversationRowSchema }),
  // Remove the row and everything after (edit/retry branch). Hits every client-loaded row with rowId >= fromRowId.
  z.object({ op: z.literal("row.removed"), fromRowId: z.number() }),
  // Streaming text append. Valid only on streaming rows (server-guaranteed; clients may assert).
  z.object({
    op: z.literal("row.delta"),
    rowId: z.number(),
    path: streamablePathSchema,
    append: z.string(),
  }),
  z.object({ op: z.literal("state.updated"), patch: statePatchSchema }),
  // MCP resource notices for plugin-UI subscriptions. live-only: no snapshot change (apply is a no-op), never cold-restored;
  // the renderer fans out by subscribers to the matching sandbox instance.
  z.object({
    op: z.literal("pluginUi.resourceUpdated"),
    pluginId: z.string(),
    serverName: z.string(),
    uri: z.string(),
    subscribers: z.array(pluginUiResourceSubscriberSchema),
  }),
  z.object({
    op: z.literal("pluginUi.resourceListChanged"),
    pluginId: z.string(),
    serverName: z.string(),
    subscribers: z.array(pluginUiResourceSubscriberSchema),
  }),
  z.object({
    op: z.literal("pluginUi.instanceClosed"),
    pluginId: z.string(),
    serverName: z.string(),
    subscribers: z.array(pluginUiResourceSubscriberSchema),
  }),
  // App-Provided Tools' instance mailbox: model-initiated page tool calls, live-only to the single instance (exactly one subscriber);
  // the page claims it and calls tools/call, the result returns via mcp/uiResolveAppToolCall. No snapshot change, never cold-restored.
  z.object({
    op: z.literal("pluginUi.appToolCall"),
    activity: z.boolean().optional(),
    cancelled: z.boolean().optional(),
    pluginId: z.string(),
    serverName: z.string(),
    subscribers: z.array(pluginUiResourceSubscriberSchema),
    callId: z.string(),
    toolName: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  }),
  /**
   * Key-level delta of one dwf run. `revision` is the **post-change** `workflowRuns.revision` (absolute);
   * one engine event yields at most one such op (node phase, derived actor state, usage, watermark land together, atomically).
   *
   * Six payload parts, each with its own meaning: `run` replaces by key, `cleared` names keys turned absent,
   * `removedActors` / `removedNodes` delete entries by (siteId, ordinal), `actors` / `nodes` upsert whole
   * by the same key. The four tables' bounds equal the state key's -- a delta must not be able to forge an invalid state.
   *
   * **Apply order is header -> deletions -> upserts**, stated here and in field order: a key deleted and re-added in one op
   * (an overflowed run's resume-after-clear, or an entry evicted then returning) must land at the table tail to match
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
  /** The producer evicted this run (only producers evict, and they must say so -- clients never enforce bounds). */
  z.object({
    op: z.literal("workflowRun.removed"),
    runId: workflowRunSchema.shape.runId,
    revision: workflowRunsStateSchema.shape.revision,
  }),
]);
export type ConversationDelta = z.infer<typeof conversationDeltaSchema>;
export type PluginUiResourceDelta = Extract<
  ConversationDelta,
  { op: "pluginUi.resourceUpdated" | "pluginUi.resourceListChanged" }
>;
export type PluginUiAppToolCallDelta = Extract<ConversationDelta, { op: "pluginUi.appToolCall" }>;
/** All live-only deltas delivered per sandbox instance. */
export type PluginUiInstanceDelta =
  | Extract<ConversationDelta, { op: "pluginUi.instanceClosed" }>
  | PluginUiResourceDelta
  | PluginUiAppToolCallDelta;
export type WorkflowRunUpdatedDelta = Extract<ConversationDelta, { op: "workflowRun.updated" }>;
export type WorkflowRunRemovedDelta = Extract<ConversationDelta, { op: "workflowRun.removed" }>;
