// ConversationRow: row types are self-contained.
// Three structural rules: a row stands alone (rendering any row needs no other row);
// structural change replaces the whole row (row.upserted), text growth uses append (row.delta); a turn is a label on a row, not a container.
import { z } from "zod";
import { executionOutputPreviewSchema } from "../execution-output-preview.js";
import { timestampSchema } from "./core.js";
import { backgroundResultOriginMetaSchema, workflowLaunchMetaSchema } from "./workflow-row-meta.js";

// RowBase. rowId: monotonic within a session, never reused, a deterministic pure function of the event log.
const rowBaseFields = {
  rowId: z.number(),
  turnId: z.string(),
  // canonical identity: every new-CLI row carries it; optional solely for legacy-frame compat.
  // entityId locates the persistent entity, productTurnId is the product turn; the UI must not re-guess either.
  entityId: z.string().min(1).optional(),
  productTurnId: z.string().min(1).optional(),
  visibility: z.literal("visible").optional(),
  createdAt: timestampSchema,
  createdAtSeq: z.number(),
  // Defaults all false; only true keys are sent. canRewind is not in the payload (rewind = editUserQuery's UI entry).
  actions: z
    .object({
      canFork: z.literal(true).optional(),
      canEdit: z.literal(true).optional(),
      canRetry: z.literal(true).optional(),
      canRewindFiles: z.literal(true).optional(),
      editDisposition: z.enum(["rewind", "fork"]).optional(),
    })
    .optional(),
} as const;

export const rowActionsSchema = rowBaseFields.actions;
export type RowActions = NonNullable<z.infer<typeof rowActionsSchema>>;

// The workflow round's row-level metadata moved to workflow-row-meta.ts (max-lines); re-exported here under the same names.
export {
  backgroundResultOriginMetaSchema,
  workflowLaunchMetaSchema,
  workflowNotificationMetaSchema,
  workflowSettingsAmendMetaSchema,
  type BackgroundResultOriginMeta,
  type WorkflowLaunchMeta,
  type WorkflowNotificationMeta,
  type WorkflowSettingsAmendMeta,
} from "./workflow-row-meta.js";

export const turnWorkSegmentSchema = z.object({
  segmentId: z.string().min(1),
  triggerEntityId: z.string().min(1).optional(),
  startedAt: timestampSchema,
  endedAt: timestampSchema.optional(),
  activeMs: z.number().nonnegative().optional(),
});
export type TurnWorkSegment = z.infer<typeof turnWorkSegmentSchema>;

// turnHeader: product-turn boundary + authoritative durations + per-round file summary.
// Internal fold boundaries produced by guide are expressed via workSegments; row attribution stays CLI-decided, zero client-side attribution logic.
export const turnHeaderRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("turnHeader"),
  // workflowLaunch: a controlOnly round launched directly by the hub.
  // Recorded skew: adding a closed-enum value makes the row's parse fail and drop on legacy desktop + new CLI (same tier as
  // backgroundSource: "workflow" below); accepted since CLI and desktop release in lockstep.
  origin: z.enum([
    "userInput",
    "backgroundResult",
    "goalContinuation",
    "editRerun",
    "workflowLaunch",
  ]),
  // Execution semantics are adjudicated by the CLI projection; the UI must not infer from input text or duration.
  // optional solely for legacy-snapshot compat; new turnHeaders always write it explicitly.
  executionKind: z.enum(["agent", "controlOnly"]).optional(),
  // Command attribution and historical round count of the current query; optional for legacy transcript/snapshot compat.
  sourceCommandId: z.string().optional(),
  historyRoundCount: z.number().int().nonnegative().optional(),
  state: z.enum(["running", "completedSuccess", "completedInterrupted", "failed"]),
  startedAt: timestampSchema,
  endedAt: timestampSchema.optional(),
  // Authoritative durations: excluding permission waits / user-input waits / verifier waits.
  activeMs: z.number().optional(),
  // guide does not start a product turn, but every accepted guide opens a distinct visual work segment.
  // Absent on plain turns for legacy-snapshot compat; once a guide appears the CLI owns the full first-and-following segments.
  workSegments: z.array(turnWorkSegmentSchema).optional(),
  originMeta: backgroundResultOriginMetaSchema.optional(),
  // Present on rounds with origin === "workflowLaunch" (live-projection source); alongside originMeta, not reusing its shape.
  workflowLaunch: workflowLaunchMetaSchema.optional(),
  fileChanges: z
    .object({
      additions: z.number(),
      deletions: z.number(),
      files: z.number(),
      state: z.enum(["active", "reverted"]).optional(),
    })
    .optional(),
});
export type TurnHeaderRow = z.infer<typeof turnHeaderRowSchema>;

// userInput. originMeta kills text sniffing.
export const userInputRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("userInput"),
  text: z.string(),
  // From this index on, text is engine-appended (dwf ask footer /
  // nudge); the GUI folds it into a collapsed-by-default disclosure; 0 = the whole text; absent = none (legacy transcripts, non-workflow sessions).
  epilogueStart: z.number().int().nonnegative().optional(),
  // workflowLaunch: the user-visible row of a hub-launched round.
  // The message text still goes into text (the legacy client/TUI degradation is that canonical English); new clients use the
  // workflowLaunch metadata below to draw an end-of-round run card instead of a bubble. Closed-enum skew as in the turnHeader.origin comment.
  origin: z.enum([
    "realUser",
    "backgroundResult",
    "goalContinuation",
    "mailbox",
    "synthetic",
    "workflowLaunch",
  ]),
  originMeta: z
    .object({
      // Same value set as backgroundResultOriginMetaSchema (including workflow runs' "workflow").
      backgroundSource: z.enum(["bash", "subagent", "workflow"]).optional(),
      workId: z.string().optional(),
      senderSessionId: z.string().optional(),
      senderLabel: z.string().optional(),
    })
    .optional(),
  // Present on rows with origin === "workflowLaunch"; alongside originMeta, same copy as on turnHeader.
  workflowLaunch: workflowLaunchMetaSchema.optional(),
  // Injected via turn-steer (guideModeTurnSteer).
  guided: z.literal(true).optional(),
  // Mandatory for realUser/guided; absent for system sources. The overlay closeout anchor.
  sourceCommandId: z.string().optional(),
  // edit/retry mints a new sourceCommandId; this field pins the canonical input root,
  // for one-shot restore budgets and other cross-rerun lineage decisions. Legacy transcripts may omit.
  rootSourceCommandId: z.string().optional(),
  // Sender identity written by CLI admission; legacy transcripts may omit.
  clientId: z.string().optional(),
  attachments: z
    .array(
      z.object({
        ref: z.string(),
        fileName: z.string(),
        mime: z.string(),
        bytes: z.number(),
        previewRef: z.string().optional(),
      }),
    )
    .optional(),
});
export type UserInputRow = z.infer<typeof userInputRowSchema>;

// assistantText / reasoning。
// Invariant: appends only into state="streaming" rows; a normal new response always takes a new rowId. The sole exception is
// the output-token Continue already confirmed by ProductProjection's length/zero-tool facts, reopening the same turn's
// visually adjacent assistantText row; clients still observe only standard row.upserted + row.delta.
export const assistantTextRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("assistantText"),
  // One model response's body and tools share this id; optional for legacy-snapshot compat.
  assistantResponseId: z.string().min(1).optional(),
  text: z.string(),
  state: z.enum(["streaming", "complete", "interrupted", "failed"]),
  model: z.string().optional(),
  feedback: z.enum(["like", "dislike"]).optional(),
});
export type AssistantTextRow = z.infer<typeof assistantTextRowSchema>;

export const reasoningRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("reasoning"),
  // One model response's thinking, body, and tools share this id; optional for legacy-snapshot compat.
  assistantResponseId: z.string().min(1).optional(),
  text: z.string(),
  state: z.enum(["streaming", "complete", "interrupted"]),
  durationMs: z.number().optional(),
});
export type ReasoningRow = z.infer<typeof reasoningRowSchema>;

// The toolCall display schema moved to ./toolDisplay.ts (rows.ts is max-lines bound).
import { toolCallDisplaySchema, toolOutputSchema, toolProgressSchema } from "./toolDisplay.js";

export const cuaAppIdentitySchema = z
  .object({
    pid: z.number().int().positive(),
    name: z.string().trim().min(1).max(256),
    bundleId: z.string().trim().min(1).max(512).optional(),
  })
  .strict();
export type CuaAppIdentity = z.infer<typeof cuaAppIdentitySchema>;

export const toolCallRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("toolCall"),
  // One model response's body and tools share this id; optional for legacy-snapshot compat.
  assistantResponseId: z.string().min(1).optional(),
  toolCallId: z.string(),
  toolName: z.string(),
  status: z.enum(["inputStreaming", "pendingApproval", "running", "success", "error", "cancelled"]),
  inputText: z.string(),
  input: z.unknown().optional(),
  cuaApp: cuaAppIdentitySchema.optional(),
  output: toolOutputSchema.optional(),
  // A display parse failure drops only this card's payload, never the row (rationale in toolDisplay.ts's toolOutputSchema
  // comment: decoration payloads must not decide row/frame/subscription life).
  display: toolCallDisplaySchema.optional().catch(undefined),
  // Mandatory when status=error.
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  // Only during replayable-tier runs; cleared at terminal state.
  progress: toolProgressSchema.optional(),
  // Bounded Bash content shared by continuous/replayable; cleared at terminal state or background handoff.
  outputPreview: executionOutputPreviewSchema.optional(),
  // When status=pendingApproval, points into pendingInteractions.
  approvalInteractionId: z.string().optional(),
  backgrounded: z.literal(true).optional(),
  workId: z.string().optional(),
  startedAt: timestampSchema.optional(),
  endedAt: timestampSchema.optional(),
});
export type ToolCallRow = z.infer<typeof toolCallRowSchema>;

// Share results are part of the session's canonical projection; in local projections ref is a Host-authorized read reference,
// and public share projections must replace it with zcode-artifact://share/:id--local paths must not pass through.
export const conversationArtifactTypeSchema = z.enum([
  "pdf",
  "pptx",
  "docx",
  "xlsx",
  "image",
  "html",
  "md",
  "text",
]);
export type ConversationArtifactType = z.infer<typeof conversationArtifactTypeSchema>;

export const artifactRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("artifact"),
  artifactVersionId: z.string().trim().min(1),
  logicalArtifactKey: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  artifactType: conversationArtifactTypeSchema,
  mimeType: z.string().trim().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  ref: z.string().trim().min(1),
  state: z.literal("current"),
});
export type ArtifactRow = z.infer<typeof artifactRowSchema>;

// subagent. Precondition: subagent mirror events must enter the event log.
export const subagentRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("subagent"),
  // The Agent/Task tool call that spawned this subagent; concurrent spawn order is not a correlation key.
  parentToolCallId: z.string().optional(),
  subagentType: z.string(),
  status: z.enum(["running", "success", "failed", "cancelled"]),
  summaryText: z.string(),
  // Present => the UI may drill down by subscribing conversation/<childSessionId> (child rows are never inlined).
  childSessionId: z.string().optional(),
  backgrounded: z.literal(true).optional(),
  workId: z.string().optional(),
  startedAt: timestampSchema.optional(),
  endedAt: timestampSchema.optional(),
});
export type SubagentRow = z.infer<typeof subagentRowSchema>;

// The Hook runtime descriptor exists for CLI event/projection input compat only. Conversation wire rows use the
// client-safe summary below, carrying no commands, absolute paths, stdin/stdout/stderr, tool input, or env vars.
export const hookExecutionDescriptorSchema = z
  .object({
    clientVisible: z.literal(true),
    sourceKind: z.enum(["user", "plugin", "project", "internal"]),
    sourcePath: z.string().optional(),
    pluginId: z.string().optional(),
    pluginName: z.string().optional(),
    statusMessage: z.string().optional(),
    executionType: z.enum(["process", "command"]),
    executionMode: z.enum(["foreground", "background"]),
    commandDisplay: z.string(),
    timeoutMs: z.number().int().positive(),
  })
  .strict();
export type HookExecutionDescriptor = z.infer<typeof hookExecutionDescriptorSchema>;

export const hookExecutionProjectionSchema = z
  .object({
    hookRunId: z.string().min(1),
    hookIndex: z.number().int().nonnegative(),
    // True once HookRunStarted observed for this runId; admission-only blocked stays false.
    didExecute: z.boolean(),
    state: z.enum(["running", "completed", "failed"]),
    outcome: z.enum(["success", "blocked", "failed", "cancelled", "timed_out"]).optional(),
    blockReason: z.string().trim().min(1).optional(),
    startedAt: timestampSchema,
    endedAt: timestampSchema.optional(),
    durationMs: z.number().nonnegative().optional(),
    displayName: z.string().trim().min(1),
    sourceKind: z.enum(["user", "plugin", "project"]),
    pluginName: z.string().optional(),
    toolName: z.string().optional(),
  })
  .strict();
export type HookExecutionProjection = z.infer<typeof hookExecutionProjectionSchema>;

export const hookInvocationRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("hookInvocation"),
  hookInvocationId: z.string().min(1),
  hookEventName: z.enum([
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
  ]),
  hookCount: z.number().int().positive(),
  state: z.enum(["running", "completed", "failed"]),
  startedAt: timestampSchema,
  endedAt: timestampSchema.optional(),
  durationMs: z.number().nonnegative().optional(),
  lane: z.enum(["assistantWork", "toolBefore", "toolAfter"]),
  anchorToolCallId: z.string().optional(),
  executions: z.array(hookExecutionProjectionSchema),
});
export type HookInvocationRow = z.infer<typeof hookInvocationRowSchema>;

// timelineMarker。
// compact.status=cancelled means auto compact was stopped; the failure terminal is failed.
export const timelineMarkerPayloadSchema = z.union([
  z.object({
    type: z.literal("compact"),
    origin: z.enum(["manual", "auto"]),
    status: z.enum(["running", "success", "failed", "noop", "cancelled"]),
    tokensBefore: z.number().optional(),
    tokensAfter: z.number().optional(),
    summaryRef: z.string().optional(),
  }),
  // Appears at the head of the child session (forkTimelineIsBoundary).
  z.object({
    type: z.literal("forkNotice"),
    parentSessionId: z.string(),
    parentRowId: z.number(),
  }),
  // Appears on the parent (optional display).
  z.object({
    type: z.literal("forkCreated"),
    childSessionId: z.string(),
    atRowId: z.number(),
  }),
  z.object({
    type: z.literal("modelChange"),
    fromProvider: z.string(),
    fromModel: z.string(),
    toProvider: z.string(),
    toModel: z.string(),
    toThought: z.string(),
  }),
  z.object({
    type: z.literal("modelChange"),
    // An explicit empty->X model boundary has no origin; never keeps the two origin fields from appearing alone,
    // so renderers never receive half a provider/model tuple.
    fromProvider: z.never().optional(),
    fromModel: z.never().optional(),
    toProvider: z.string(),
    toModel: z.string(),
    toThought: z.string(),
  }),
  z.object({
    type: z.literal("goalSet"),
    objective: z.string(),
    previousObjective: z.string().optional(),
  }),
  z.object({
    type: z.literal("goalVerify"),
    iteration: z.number(),
    outcome: z.enum(["running", "pass", "notSatisfied", "failed"]),
    detail: z.string().optional(),
  }),
  z.object({
    type: z.literal("retryNotice"),
    attempt: z.number(),
    reasonCode: z.string(),
  }),
  // Receipt of workspace-domain actions on the timeline.
  z.object({
    type: z.literal("checkpointRestored"),
    checkpointId: z.string(),
  }),
]);
export type TimelineMarkerPayload = z.infer<typeof timelineMarkerPayloadSchema>;

/**
 * marker lanes:
 * Placement semantics are adjudicated by the CLI projection; the UI assembles by lane only and never infers from marker type.
 * - assistantWork: assistant work activity (compact), into the "worked" collapsed group;
 * - turnTailBoundary: end-of-round boundary (goalVerify/forkNotice), stays at the round tail, not collapsed;
 * - lightBoundary: top-of-round light boundary (modelChange), rendered before the user input.
 * optional = legacy-snapshot compat (the UI falls back by marker type when absent).
 */
export const timelineMarkerLaneSchema = z.enum([
  "assistantWork",
  "turnTailBoundary",
  "lightBoundary",
]);
export type TimelineMarkerLane = z.infer<typeof timelineMarkerLaneSchema>;

export const timelineMarkerRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("timelineMarker"),
  // User-triggered markers always carry it.
  sourceCommandId: z.string().optional(),
  lane: timelineMarkerLaneSchema.optional(),
  marker: timelineMarkerPayloadSchema,
});
export type TimelineMarkerRow = z.infer<typeof timelineMarkerRowSchema>;

export const conversationRowSchema = z.discriminatedUnion("kind", [
  turnHeaderRowSchema,
  userInputRowSchema,
  assistantTextRowSchema,
  reasoningRowSchema,
  toolCallRowSchema,
  artifactRowSchema,
  subagentRowSchema,
  hookInvocationRowSchema,
  timelineMarkerRowSchema,
]);
export type ConversationRow = z.infer<typeof conversationRowSchema>;
export type ConversationRowKind = ConversationRow["kind"];
