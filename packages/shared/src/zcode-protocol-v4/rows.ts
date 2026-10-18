import { conversationQuotesSchema } from "../conversationSelection.js";
import { botGroupInputSourceSchema } from "../bots.js";
// ConversationRow: row types are self-contained.
// Three structural rules: a row stands alone (rendering it needs no other row);
// structural changes replace the whole row (row.upserted), text growth appends (row.delta); a turn is a label on rows, not a container.
import { z } from "zod";
import { highspeedMessageMetaSchema } from "../highspeed.js";
import { executionOutputPreviewSchema } from "../execution-output-preview.js";
import { timestampSchema } from "./core.js";
import { conversationInputSourceSchema } from "./input-intent.js";
import { backgroundResultOriginMetaSchema, workflowLaunchMetaSchema } from "./workflow-row-meta.js";
import { attachmentRefSchema } from "./attachment-ref.js";

// RowBase. rowId: monotonic within a session, never reused, a deterministic pure function of the event log.
const rowBaseFields = {
  rowId: z.number(),
  turnId: z.string(),
  // canonical identity: every row from new CLIs; optional only for legacy-frame compat.
  // entityId addresses the persisted entity; productTurnId is the product turn. Never re-guessed by the UI.
  entityId: z.string().min(1).optional(),
  productTurnId: z.string().min(1).optional(),
  visibility: z.literal("visible").optional(),
  createdAt: timestampSchema,
  createdAtSeq: z.number(),
  // Default all false; only true keys ship. canRewind is not in the payload (rewind = editUserQuery's UI entry).
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

// Workflow-turn row metadata moved to workflow-row-meta.ts (max-lines); re-exported here unchanged.
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

// turnHeader: product-turn boundary + authoritative work time + per-turn file summary.
// workSegments expresses the internal fold boundaries guides produce; row attribution stays CLI-side, zero client logic.
export const turnHeaderRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("turnHeader"),
  // workflowLaunch: a controlOnly launch straight from the hub.
  // Recorded skew: a closed-enum addition => on old desktop + new CLI the row fails to parse and drops (same tier as
  // the backgroundSource: "workflow" addition below); accepted because CLI and desktop release in lockstep.
  origin: z.enum([
    "userInput",
    "backgroundResult",
    "goalContinuation",
    "editRerun",
    "workflowLaunch",
  ]),
  // Execution semantics are arbitrated by the CLI projection; the UI must not infer them from input text or duration.
  // optional only for legacy snapshots; new turnHeaders always write it explicitly.
  executionKind: z.enum(["agent", "controlOnly"]).optional(),
  // Command attribution of the current query plus the history round count; optional for legacy transcript/snapshot.
  sourceCommandId: z.string().optional(),
  historyRoundCount: z.number().int().nonnegative().optional(),
  state: z.enum(["running", "completedSuccess", "completedInterrupted", "failed"]),
  startedAt: timestampSchema,
  endedAt: timestampSchema.optional(),
  // Authoritative work time: excludes permission waits / user-input waits / verifier waits.
  activeMs: z.number().optional(),
  // Output-usage accumulation of mainline ModelComplete within this product turn; optional for legacy snapshots.
  outputTokens: z.number().int().nonnegative().optional(),
  // True durations aggregated by the CLI from runtime events; optional for legacy snapshots and plain turns.
  modelDurationMs: z.number().nonnegative().optional(),
  toolDurationMs: z.number().nonnegative().optional(),
  otherDurationMs: z.number().nonnegative().optional(),
  // A guide never switches product turn, but every accepted guide opens its own visual work segment.
  // Absent on plain turns for legacy-snapshot compat; once a guide appears the CLI projects the first and later segments in full.
  workSegments: z.array(turnWorkSegmentSchema).optional(),
  originMeta: backgroundResultOriginMetaSchema.optional(),
  // Present on turns with origin === "workflowLaunch" (live-projection source); parallel to originMeta, not its shape.
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

// userInput. originMeta eliminates text sniffing.
export const userInputRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("userInput"),
  inputOrigin: z.enum(["desktop", "mobile"]).optional(),
  botGroupSource: botGroupInputSourceSchema.optional(),
  conversationQuotes: conversationQuotesSchema.optional(),
  text: z.string(),
  // From this index on, text is engine-appended (dwf ask epilogue /
  // nudge); the GUI folds it into a collapsed-by-default disclosure. 0 = all of it; absent = none (old transcripts, non-workflow sessions).
  epilogueStart: z.number().int().nonnegative().optional(),
  // workflowLaunch: the user-visible row of a hub-launched turn.
  // Message text still goes into text (the legacy client / TUI fallback is that canonical sentence); new clients use the
  // workflowLaunch metadata below to draw a turn-end run card instead of a bubble. Closed-enum skew as in the turnHeader.origin comment.
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
      // Same value set as backgroundResultOriginMetaSchema (including "workflow" for workflow runs).
      backgroundSource: z.enum(["bash", "subagent", "workflow"]).optional(),
      workId: z.string().optional(),
      senderSessionId: z.string().optional(),
      senderLabel: z.string().optional(),
    })
    .optional(),
  // Present on rows with origin === "workflowLaunch"; parallel to originMeta, same copy as on turnHeader.
  workflowLaunch: workflowLaunchMetaSchema.optional(),
  // Injected via turn-steer (guideModeTurnSteer).
  guided: z.literal(true).optional(),
  // Required for realUser/guided; absent for system sources. Anchor for overlay closing.
  sourceCommandId: z.string().optional(),
  // edit/retry mint a new sourceCommandId; this field stays pinned to the canonical input root,
  // for cross-rerun lineage calls such as one-shot restore budgets. Legacy transcripts may omit.
  rootSourceCommandId: z.string().optional(),
  // Submitter identity written by CLI admission; legacy transcripts may omit.
  clientId: z.string().optional(),
  // Persisted fact for accelerated-history display; absent stays compatible with plain messages and old snapshots.
  highspeed: highspeedMessageMetaSchema.optional(),
  // A duplicate definition once stripped the source during post-dequeue row validation, losing attachment previews; shares the inbound ref schema.
  attachments: z.array(attachmentRefSchema).optional(),
  // Messages sent via plugin UI carry their source; the card shows "from plugin X". Legacy transcripts may omit.
  source: conversationInputSourceSchema.optional(),
});
export type UserInputRow = z.infer<typeof userInputRowSchema>;

// assistantText / reasoning.
// Invariant: appends only into state="streaming" rows; a fresh response always mints a new rowId. Sole exception:
// the output-token Continue that ProductProjection confirmed via length/zero-tool facts may reopen the same turn's
// visually adjacent assistantText row; clients still observe only standard row.upserted + row.delta.
export const assistantTextRowSchema = z.object({
  ...rowBaseFields,
  kind: z.literal("assistantText"),
  // The body and tools of one model response share this id; optional for legacy snapshots.
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
  // The thinking, body, and tools of one model response share this id; optional for legacy snapshots.
  assistantResponseId: z.string().min(1).optional(),
  text: z.string(),
  state: z.enum(["streaming", "complete", "interrupted"]),
  durationMs: z.number().optional(),
});
export type ReasoningRow = z.infer<typeof reasoningRowSchema>;

// toolCall display schemas moved to ./toolDisplay.ts (rows.ts is at the max-lines cap).
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
  // The body and tools of one model response share this id; optional for legacy snapshots.
  assistantResponseId: z.string().min(1).optional(),
  toolCallId: z.string(),
  toolName: z.string(),
  status: z.enum(["inputStreaming", "pendingApproval", "running", "success", "error", "cancelled"]),
  inputText: z.string(),
  input: z.unknown().optional(),
  cuaApp: cuaAppIdentitySchema.optional(),
  output: toolOutputSchema.optional(),
  // A display parse failure drops only this card's payload, never the row (rationale in toolDisplay.ts's toolOutputSchema
  // comment: decorative payloads must not decide row/frame/subscription life or death).
  display: toolCallDisplaySchema.optional().catch(undefined),
  // (2026-09-12): widgetState / widgetStateVisibility removed; plugin UI state no longer enters the row.
  // Required when status=error.
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  // Present while running (ToolCallProgress events), cleared on terminal state.
  progress: toolProgressSchema.optional(),
  // Bounded Bash content shared by continuous/replayable, cleared on terminal state or background handoff.
  outputPreview: executionOutputPreviewSchema.optional(),
  // When status=pendingApproval, points at the pendingInteractions entry.
  approvalInteractionId: z.string().optional(),
  backgrounded: z.literal(true).optional(),
  workId: z.string().optional(),
  startedAt: timestampSchema.optional(),
  endedAt: timestampSchema.optional(),
});
export type ToolCallRow = z.infer<typeof toolCallRowSchema>;

// Share artifacts are part of the session's canonical projection; the ref is a Host-authorized read reference in local projections,
// and public share projections must replace it with zcode-artifact://share/:id -- never pass local paths through.
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
  // Present => the UI may drill down by subscribing conversation/<childSessionId> (child rows are not inlined).
  childSessionId: z.string().optional(),
  backgrounded: z.literal(true).optional(),
  workId: z.string().optional(),
  startedAt: timestampSchema.optional(),
  endedAt: timestampSchema.optional(),
});
export type SubagentRow = z.infer<typeof subagentRowSchema>;

// Hook runtime descriptors exist for CLI event/projection input compat only. The conversation wire row uses the
// client-safe summary below: no command, absolute paths, stdin/stdout/stderr, tool input, or env vars.
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
    // True only once HookRunStarted has been observed for this runId; admission-only blocked stays false.
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

// timelineMarker.
// compact.status=cancelled means auto compact was stopped; the failure terminal state is failed.
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
  // Appears in the parent (optional display).
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
    // The explicit empty-to-X model boundary has no origin; never keeps both origin fields appearing or neither,
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
  // Timeline receipt of a workspace-domain action.
  z.object({
    type: z.literal("checkpointRestored"),
    checkpointId: z.string(),
  }),
]);
export type TimelineMarkerPayload = z.infer<typeof timelineMarkerPayloadSchema>;

/**
 * Marker lanes:
 * Placement semantics are arbitrated by the CLI projection; the UI assembles by lane only, never infers from marker type.
 * - assistantWork: assistant work activity (compact), files into the Worked collapsed group;
 * - turnTailBoundary: turn-end boundary (goalVerify/forkNotice), stays uncollapsed at the turn tail;
 * - lightBoundary: light turn-top boundary (modelChange), rendered before the user input.
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
  // Required for user-triggered markers.
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
