// ============================================================
// Protocol vocabulary of the workspace transcript
// ============================================================
// A run's `files.*` / `git.*` / `world.run` calls, replayed in the side panel as tool cards.
// Authoritative in the journal's `dwf_node` rows (`kind in {world-read, world-run}`): `input_json`
// (migration 0030) gives op and args, `result_json` the body.
//
// Two v4 queries, split like the user-facing artifacts' 1/3:
//   Workspace  the light row list (op / args / status / summary / time), **no bodies**;
//              re-query when the live projection's `lastEventSequence` rises
//   NodeResult one node's body, shape-preserving bounded by maxBytes; fetched on expand, cached per tab
//
// Layering: bodies never enter the list; the list's "how big / exit code / how many" are computed in-DB by the storage layer
// with SQLite JSON functions. Kin of workflowRunEvents: read-only, stateless, resend-safe, deliberately not a v4 command,
// no atSeq / atLogEpoch (journal reads; nothing stale to guard). New method, skew-safe by construction.

import { z } from "zod";

/** Display caps of the workspace transcript. The numbers are the contract. */
export const WORKFLOW_WORKSPACE_LIMITS = {
  /// Rows per list; over-cap tail-clipped by the gateway with `truncated` set.
  maxNodes: 2000,
  /// Length of `op` names (`git-changed-files` is the longest).
  maxOpLength: 32,
  /// Arg count (<= 8 after engine-side truncation; untruncated originals <= 3 per the facade signature).
  maxArgs: 16,
  /// Display length of failure messages; over-long tail-clipped by the host.
  maxErrorMessageLength: 2000,
  /// Max bytes read back per body (truncation, not rejection--an audit view, not the script's data plane).
  resultMaxBytes: 32 * 1024,
} as const;

export const workflowRunWorkspaceNodeKindSchema = z.enum(["world-read", "world-run"]);
export type WorkflowRunWorkspaceNodeKind = z.infer<typeof workflowRunWorkspaceNodeKindSchema>;

/** journal row status (the wire mirror of `NodeRecordStatus`). */
export const workflowRunWorkspaceNodeStatusSchema = z.enum(["running", "completed", "failed"]);
export type WorkflowRunWorkspaceNodeStatus = z.infer<typeof workflowRunWorkspaceNodeStatusSchema>;

/** Structured failure: journal error_json's code + message (no other fields on the wire). */
export const workflowRunWorkspaceNodeErrorSchema = z
  .object({
    code: z.string().min(1).max(64),
    message: z.string().max(WORKFLOW_WORKSPACE_LIMITS.maxErrorMessageLength),
  })
  .strict();
export type WorkflowRunWorkspaceNodeError = z.infer<typeof workflowRunWorkspaceNodeErrorSchema>;

/**
 // One list row's summary: the numbers reportable without the body. Which appear depends on op--array bodies
 // (glob / grep / changedFiles) have `resultCount`, `world.run` has `exitCode` plus both output byte counts, string bodies
 // only `resultBytes`.
 */
export const workflowRunWorkspaceNodeSummarySchema = z
  .object({
    resultBytes: z.number().int().nonnegative(),
    resultCount: z.number().int().nonnegative().optional(),
    exitCode: z.number().int().optional(),
    stdoutBytes: z.number().int().nonnegative().optional(),
    stderrBytes: z.number().int().nonnegative().optional(),
  })
  .strict();
export type WorkflowRunWorkspaceNodeSummary = z.infer<typeof workflowRunWorkspaceNodeSummarySchema>;

/**
 // One row of the workspace transcript. `op` / `args` come from input_json; pre-upgrade history rows lack both
 // (the UI falls back to the static graph's step label); `inputTruncated` marks args as per-item string previews, not originals.
 */
export const workflowRunWorkspaceNodeSchema = z
  .object({
    siteId: z.string().min(1).max(64),
    ordinal: z.number().int().nonnegative(),
    kind: workflowRunWorkspaceNodeKindSchema,
    op: z.string().min(1).max(WORKFLOW_WORKSPACE_LIMITS.maxOpLength).optional(),
    args: z.array(z.unknown()).max(WORKFLOW_WORKSPACE_LIMITS.maxArgs).optional(),
    inputTruncated: z.literal(true).optional(),
    status: workflowRunWorkspaceNodeStatusSchema,
    error: workflowRunWorkspaceNodeErrorSchema.optional(),
    summary: workflowRunWorkspaceNodeSummarySchema.optional(),
    /// journal row created/last-updated (epoch millis); their difference is the step's duration.
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type WorkflowRunWorkspaceNode = z.infer<typeof workflowRunWorkspaceNodeSchema>;

// -- v4 query 1: workflowRunWorkspace (light row list) --
export const v4ConversationWorkflowRunWorkspaceParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
  })
  .strict();
export type V4ConversationWorkflowRunWorkspaceParams = z.infer<
  typeof v4ConversationWorkflowRunWorkspaceParamsSchema
>;

export const v4ConversationWorkflowRunWorkspaceResultSchema = z
  .object({
    /// By journal order (row id ascending = engine admission order).
    nodes: z.array(workflowRunWorkspaceNodeSchema).max(WORKFLOW_WORKSPACE_LIMITS.maxNodes),
    /// The list was tail-clipped past maxNodes.
    truncated: z.boolean().optional(),
  })
  .strict();
export type V4ConversationWorkflowRunWorkspaceResult = z.infer<
  typeof v4ConversationWorkflowRunWorkspaceResultSchema
>;

// -- v4 query 2: workflowRunNodeResult (one node's body) --
// Authorization is CLI-side (the port): sessionId must be the run's parentSessionId, else the same answer as "no such node".
// The body is bounded **shape-preserving** by maxBytes: strings tail-clipped, arrays tail-dropped, the run's stdout / stderr
// clipped each--a card wants "what ran, first few hundred lines", not the script's all-or-nothing.
export const v4ConversationWorkflowRunNodeResultParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    runId: z.string().min(1),
    siteId: z.string().min(1).max(64),
    ordinal: z.number().int().nonnegative(),
    /// Default and cap both resultMaxBytes; clamped by the gateway.
    maxBytes: z.number().int().positive().max(WORKFLOW_WORKSPACE_LIMITS.resultMaxBytes).optional(),
  })
  .strict();
export type V4ConversationWorkflowRunNodeResultParams = z.infer<
  typeof v4ConversationWorkflowRunNodeResultParamsSchema
>;

export const v4ConversationWorkflowRunNodeResultResultSchema = z
  .object({
    status: workflowRunWorkspaceNodeStatusSchema,
    /// The bounded body; absent on running and failed rows.
    result: z.unknown().optional(),
    error: workflowRunWorkspaceNodeErrorSchema.optional(),
    truncated: z.boolean(),
    /// Serialized bytes before truncation.
    totalBytes: z.number().int().nonnegative(),
  })
  .strict();
export type V4ConversationWorkflowRunNodeResultResult = z.infer<
  typeof v4ConversationWorkflowRunNodeResultResultSchema
>;
