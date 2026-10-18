import { createSessionRequestedConfigSchema } from "./create-session-config.js";
import { localTtftContextSchema, localTtftClockSchema } from "../localTtft.js";
import { conversationQuotesSchema } from "../conversationSelection.js";
// Command layer: envelope / ACK / the full command payload set.
// Conversation rewind has no dedicated command (verdict: it is the UI entry of editUserQuery);
// workspace-only file undo goes through applyFileRewind and never truncates chat history.
import { z } from "zod";
import { conversationRowTargetSchema, timestampSchema } from "./core.js";
import { attachmentRefSchema } from "./attachment-ref.js";
import { v4ConversationFileRewindPreviewResultSchema } from "./transport.js";
import { modelSelectionSchema } from "../model-selection.js";
import { modelExecutionSchema } from "../model-execution.js";
import { submissionModeSchema } from "./submission.js";
import { botGroupInputSourceSchema, zcodeAutomationBotDeliveryTargetSchema } from "../bots.js";
import { DYNAMIC_WORKFLOW_MODES } from "../dynamic-workflow-feature.js";
import {
  amendWorkflowRunSettingsPayloadSchema,
  amendWorkflowRunSettingsResultSchema,
} from "./workflow-run-settings-command.js";
import {
  workspaceHookReviewCommandTargetSchema,
  workspaceHookReviewDecisionSchema,
  workspaceHookTrustRevokeTargetSchema,
  requestWorkspaceHookReviewTargetSchema,
} from "./workspace-hook-review.js";
import {
  zcodeBrowserAmbientContextSchema,
  zcodeProtocolMcpServerSchema,
} from "../zcode-protocol/index.js";
import { highspeedMessageMetaSchema } from "../highspeed.js";
import { sharedContextRefSchema } from "./shared-context-ref.js";
import { conversationInputSourceSchema } from "./input-intent.js";
export type { SharedContextRef } from "./shared-context-ref.js";
export * from "./workflow-command-rejections.js";

// Execution-material invariant shared by sendText / editUserQuery / sendQueuedNow: modelExecution may only ride
// this turn's modelSelection; supplying credentials without a Selection is forbidden (history must not reuse pre-rewind credentials).
function requireModelSelectionForExecution(
  payload: { modelSelection?: unknown; modelExecution?: unknown },
  context: z.RefinementCtx,
): void {
  if (payload.modelExecution && !payload.modelSelection) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "modelExecution requires modelSelection",
      path: ["modelExecution"],
    });
  }
}

// -- 6.4 Command payload catalog --
export const commandPayloadSchemas = {
  // Absent firstInput => empty phase=draft session; present => straight to turnHeader+userInput rows.
  createSession: z.object({
    workspaceId: z.string(),
    permissionScope: z.literal("session").optional(),
    firstInput: z
      .object({
        text: z.string(),
        attachments: z.array(attachmentRefSchema).optional(),
        modelSelection: modelSelectionSchema.optional(),
        mode: submissionModeSchema.optional(),
        planEnabled: z.boolean().optional(),
      })
      .optional(),
    config: createSessionRequestedConfigSchema.optional(),
    // MCP is runtime-startup configuration: it enters the record at create time and cannot be patched in later.
    mcpServers: z.array(zcodeProtocolMcpServerSchema).optional(),
    // Off-Peak tool-surface flag, equivalent to legacy session/create -- V4 createSession is the desktop's
    // actual new-session path; without passthrough OffPeakCreate/OffPeakList never register. Additive:
    // legacy CLIs' z.object silently drops the key (fail-closed).
    offPeakToolEnabled: z.boolean().optional(),
    // Dynamic-workflow rollout flag, same pattern as offPeakToolEnabled.
    dynamicWorkflowEnabled: z.boolean().optional(),
    // Rollout mode ships alongside the boolean (launch.md "On demand: activation"); legacy z.object drops it silently.
    dynamicWorkflowMode: z.enum(DYNAMIC_WORKFLOW_MODES).optional(),
  }),
  // The parent session comes from envelope.sessionId; the server derives full runtime config from the parent record.
  // With firstInput present, the child starts its first plain input right after creation; otherwise the side panel stays empty.
  createSelectionSideSession: z.object({
    firstInput: z
      .object({
        text: z.string().trim().min(1),
        // The submission recommendation covers only the new child's full selection; absent keeps the parent runtime's inheritance.
        modelSelection: modelSelectionSchema.optional(),
      })
      .optional(),
  }),
  // Arbitrated by inputRouting: startNow / enqueue / guide / choice.
  // heldQueueDisposition: required while held (inputRouting.mode=choice);
  // clear => empty the queue then startNow, keep => keep the queue and startNow immediately.
  sendText: z
    .object({
      text: z.string(),
      attachments: z.array(attachmentRefSchema).optional(),
      // Desktop Cmd/Ctrl+Enter overrides only this busy input, never the session followupMode.
      // startNow has the CLI preempt the current turn atomically, bypassing queue admission.
      requestedDelivery: z.enum(["startNow", "queue", "guide"]).optional(),
      browserAmbientContext: zcodeBrowserAmbientContextSchema.optional(),
      // Share handover allows one imported context of the current session; the runtime resolves full content from
      // persisted provenance, never from a renderer-supplied command field.
      context_refs: z.array(sharedContextRefSchema).max(1).optional(),
      // Origin marker when a plugin UI sends on the user's behalf (ui/message); persisted with the intent, projected onto the user row.
      source: conversationInputSourceSchema.optional(),
      heldQueueDisposition: z.enum(["clearQueueAndSend", "keepQueueAndSend"]).optional(),
      // The queueItemId set visible in the paused-queue confirm dialog. The CLI validates before clear/keep,
      // so concurrent desktop/mobile additions are never swept away unconfirmed.
      expectedHeldQueueItemIds: z.array(z.string().min(1)).optional(),
      // Legacy senders may omit during migration; CLI admission pins the current Session Selection into the
      // canonical intent. After the renderer migration, first-party submissions always carry both explicitly.
      modelSelection: modelSelectionSchema.optional(),
      mode: submissionModeSchema.optional(),
      planEnabled: z.boolean().optional(),
      // This execution still uses the standard Selection above; this carries only non-persisted semantics, dynamic auth, and child policy.
      // Accepted for idle startNow only, keeping Secret/Ticket out of the plain CommandInbox.
      modelExecution: modelExecutionSchema.optional(),
      // The highspeed card snapshot rides input facts into message.data; no runtime credentials or headers.
      // This turn's boosted model and credentials ride modelSelection + modelExecution above; see
      // docs/highspeed/highspeed-access-mode-migration.md.
      highspeedMeta: highspeedMessageMetaSchema.optional(),
      automationId: z.string().min(1).optional(),
      offPeakTaskId: z.string().min(1).optional(),
      offPeakRunType: z.enum(["init", "resume"]).optional(),
      // Bot origin is injected by the Host only, letting CronCreate read and persist the callback target within the turn.
      botDeliveryTarget: zcodeAutomationBotDeliveryTargetSchema.optional(),
      inputOrigin: z.enum(["desktop", "mobile"]).optional(),
      botGroupSource: botGroupInputSourceSchema.optional(),
      conversationQuotes: conversationQuotesSchema.optional(),
      // Follow-up user input in scheduled-task sessions keeps turn-scoped tool-surface isolation; it must not borrow
      // automationId, or plain user input gets mislabeled as an automation dispatch.
      toolDisallowlist: z.array(z.string().min(1)).optional(),
    })
    .superRefine((payload, context) => {
      if (payload.automationId && payload.offPeakTaskId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "automationId and offPeakTaskId are mutually exclusive",
        });
      }
      if (payload.offPeakRunType && !payload.offPeakTaskId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "offPeakRunType requires offPeakTaskId",
          path: ["offPeakRunType"],
        });
      }
      requireModelSelectionForExecution(payload, context);
    }),
  sendGoalCommand: z.object({
    text: z.string(),
    displayText: z.string().optional(),
    modelSelection: modelSelectionSchema.optional(),
    mode: submissionModeSchema.optional(),
    planEnabled: z.boolean().optional(),
    heldQueueDisposition: z.enum(["clearQueueAndSend", "keepQueueAndSend"]).optional(),
    expectedHeldQueueItemIds: z.array(z.string().min(1)).optional(),
  }),
  sendMissionCommand: z.object({
    enabled: z.boolean(),
  }),
  stop: z.object({
    // From activeWorks; the CLI uses it to reject late Stops that would kill unrelated later executions.
    expectedForegroundExecutionId: z.string().min(1).optional(),
  }),
  // compact is an input-class maintenance command: run immediately when idle, FIFO when busy/held.
  // Admission is revision-independent, no CAS; sourceCommandId provides the idempotency boundary.
  compact: z.object({}),
  // Available on stable assistant rows while running.
  forkAssistant: z.object({ target: conversationRowTargetSchema }),
  applyFileRewind: z.object({ target: conversationRowTargetSchema }),
  editUserQuery: z
    .object({
      target: conversationRowTargetSchema,
      newText: z.string(),
      conversationQuotes: conversationQuotesSchema.optional(),
      attachments: z.array(attachmentRefSchema).optional(),
      // Edited resends count as fresh submissions: only cards and execution material from this re-prepare are accepted;
      // never reuse credentials from the rewound history.
      modelSelection: modelSelectionSchema.optional(),
      modelExecution: modelExecutionSchema.optional(),
      highspeedMeta: highspeedMessageMetaSchema.optional(),
      // Default preserve: switch conversation branch only; rewind safely restores that turn's files first.
      workspaceMode: z.enum(["preserve", "rewind"]).optional(),
    })
    .superRefine(requireModelSelectionForExecution),
  retryTurn: z.object({ target: conversationRowTargetSchema }),
  // (2026-09-12): setToolWidgetState / setSessionPluginUiState removed -- plugin UI widgetState
  // went back to host-renderer memory, no longer written to CLI session storage; model-visible info moves to ui/update-model-context.
  setAssistantFeedback: z.object({
    target: conversationRowTargetSchema,
    feedback: z.enum(["like", "dislike"]).nullable(),
  }),
  setHighspeedMetrics: z.object({
    target: conversationRowTargetSchema,
    regularTps: z.number().positive(),
    outputTokens: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    highspeedTps: z.number().positive(),
    savedDurationMs: z.number().nonnegative(),
    modelDurationMs: z.number().nonnegative().optional(),
    toolDurationMs: z.number().nonnegative().optional(),
    otherDurationMs: z.number().nonnegative().optional(),
  }),
  sendQueuedNow: z
    .object({
      queueItemId: z.string(),
      // Manual promotion lets the renderer attach same-card execution material for the queued item; credentials never persist into the queue.
      modelSelection: modelSelectionSchema.optional(),
      modelExecution: modelExecutionSchema.optional(),
      highspeedMeta: highspeedMessageMetaSchema.optional(),
    })
    .superRefine(requireModelSelectionForExecution),
  editQueueItem: z.object({ queueItemId: z.string(), newText: z.string() }),
  // beforeQueueItemId = null => move to tail.
  reorderQueueItem: z.object({
    queueItemId: z.string(),
    beforeQueueItemId: z.string().nullable(),
  }),
  deleteQueueItem: z.object({ queueItemId: z.string() }),
  setAutoDrain: z.object({ autoDrain: z.boolean() }),
  // First resolve wins, later ones no-op (reasonCode=proto.alreadyResolved).
  resolveInteraction: z.object({
    interactionId: z.string(),
    answer: z.object({
      optionId: z.string().optional(),
      freeText: z.string().optional(),
      // (Elicitation receipt convergence): losslessly carries AskUserQuestion/plan-approval
      // multi-question answers and annotations. With action present the CLI broker maps exactly to
      // accept/decline/cancel (content passes through with legacy userInput response semantics); absent keeps the
      // optionId/freeText compat path, legacy client behavior unchanged.
      action: z.enum(["accept", "decline", "cancel"]).optional(),
      content: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
  respondWorkspaceHookReview: workspaceHookReviewCommandTargetSchema.extend({
    decision: workspaceHookReviewDecisionSchema,
  }),
  toggleWorkspaceHookReviewItem: workspaceHookReviewCommandTargetSchema.extend({
    reviewItemId: z.string().trim().min(1),
    enabled: z.boolean(),
  }),
  revokeWorkspaceHookTrust: z.union([
    workspaceHookReviewCommandTargetSchema.extend({
      reviewItemIds: z.array(z.string().trim().min(1)).min(1),
    }),
    workspaceHookTrustRevokeTargetSchema,
  ]),
  // Soft gate: opt-in review flow; clone revokes non-flow targets without hookDeclarationDigests.
  requestWorkspaceHookReview: requestWorkspaceHookReviewTargetSchema,
  // The first valid AskUserQuestion action pauses this auto-resolution for good; repeat/late calls are idempotent no-ops.
  snoozeInteractionAutoResolution: z.object({
    interactionId: z.string(),
  }),
  switchModelConfig: z.object({
    provider: z.string(),
    model: z.string(),
    thought: z.string(),
  }),
  // Additive (frozen surface evolves under golden tests): agent collaboration-mode switch.
  // Value domain = the switchable subset of core CollaborationMode (auto is not user-switchable, no UI command).
  switchCollaborationMode: z.object({
    mode: z.enum(["build", "edit", "plan", "yolo", "guarded"]),
  }),
  setFollowupMode: z.object({ mode: z.enum(["queue", "guide"]) }),
  pauseGoal: z.object({}),
  resumeGoal: z.object({}),
  cancelBackgroundWork: z.object({ workId: z.string() }),
  // cancel & resume: resume a dwf run cancelled or interrupted by process death. workId = runId (the same identity
  // equation as cancelBackgroundWork); `name` optional, feeding the completion notice subject (the original CreateWorkflow
  // tool input is gone after restart). Deliberately no baseRevision: same family as cancelBackgroundWork (the workflowRuns
  // surface is revision-free; a fake CAS failure only hurts). The gate is CLI-side (resumable set = cancelled plus failed+Interrupted);
  // rejection ACKs with fault.command.workflowRunResumeRejected.<reason>.
  // fault.command.workflowRunResumeRejected.<reason>.
  resumeWorkflowRun: z.object({ workId: z.string(), name: z.string().optional() }),
  // startSavedWorkflow: the hub's Run no longer synthesizes
  // conversation copy; it asks the agent to start the saved workflow in a new session. Same family as cancelBackgroundWork /
  // resumeWorkflowRun: no baseRevision (the workflowRuns surface is revision-free; fake CAS failures only hurt). name is filled by the
  // agent from resolution (invariant 6); the command takes no name override.
  // Rejection ACKs with fault.command.savedWorkflowStartRejected.<reason> (vocabulary: savedWorkflowStartRejectionReasonSchema in
  // workflow-command-rejections.ts below); missing capability (no dwf port) => V4CapabilityUnsupportedError
  // (same error as resumeWorkflowRun).
  startSavedWorkflow: z.object({
    name: z.string().min(1),
    scope: z.enum(["project", "global"]).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  }),
  // amendWorkflowRunSettings: the run card/detail Configure action asks the agent to amend the run with new settings, no model round.
  // Payload, result, and rejection vocabulary in workflow-run-settings-command.ts; missing capability => V4CapabilityUnsupportedError.
  amendWorkflowRunSettings: amendWorkflowRunSettingsPayloadSchema,
  renameSession: z.object({ title: z.string() }),
  deleteSession: z.object({}),
  discardSharedContext: z.object({ contextId: z.string().trim().min(1) }).strict(),
} as const;

export type CommandType = keyof typeof commandPayloadSchemas;
export type CommandPayloadMap = {
  [T in CommandType]: T extends "sendText"
    ? z.infer<(typeof commandPayloadSchemas)[T]> &
        import("../zcode-task-types-core.js").ZCodeBackgroundTurnAttribution
    : z.infer<(typeof commandPayloadSchemas)[T]>;
};

export const commandTypeSchema = z.enum(
  Object.keys(commandPayloadSchemas) as [CommandType, ...CommandType[]],
);

// cancelBackgroundWork rejections: when core answers "nothing was cancelled" (missing task / terminal / unsupported type)
// it goes upstream as prefix + reason, never a fake-success accepted -- the detail page tells the user the run is not running.
// reason is core's stopBackgroundTask reason minus the `background_task_` prefix: not_found /
// not_running / cancel_not_supported.
export const BACKGROUND_WORK_CANCEL_REJECTED_FAULT_PREFIX =
  "fault.command.backgroundWorkCancelRejected." as const;

// CAS-checked commands: the envelope must carry baseRevision.
export const COMMANDS_REQUIRING_BASE_REVISION: ReadonlySet<CommandType> = new Set([
  "applyFileRewind",
  "forkAssistant",
  "editUserQuery",
  "retryTurn",
  "setAssistantFeedback",
  "sendQueuedNow",
  "editQueueItem",
  "reorderQueueItem",
  "deleteQueueItem",
  "setAutoDrain",
  "switchModelConfig",
  "switchCollaborationMode",
  "setFollowupMode",
  "pauseGoal",
  "resumeGoal",
]);

export const ROW_TARGETING_COMMANDS: ReadonlySet<CommandType> = new Set([
  "applyFileRewind",
  "forkAssistant",
  "editUserQuery",
  "retryTurn",
  "setAssistantFeedback",
  "setHighspeedMetrics",
]);

// -- Envelope --
export const commandEnvelopeSchema = z.object({
  ttft: localTtftContextSchema.optional(),
  // uuid v7, client-generated, stable across retries.
  commandId: z.string(),
  clientId: z.string(),
  // Null for createSession.
  sessionId: z.string().nullable(),
  baseRevision: z.number().optional(),
  baseLogEpoch: z.string().trim().min(1).optional(),
  type: commandTypeSchema,
  payload: z.unknown(),
  // Client clock, telemetry only; the server decides nothing with it.
  issuedAt: timestampSchema,
});
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;

/** Validates the envelope, then the payload by type (the envelope schema cannot statically bind payloads; funnel here). */
export function parseCommandEnvelope(
  value: unknown,
): { ok: true; envelope: CommandEnvelope } | { ok: false; error: z.ZodError } {
  const envelope = commandEnvelopeSchema.safeParse(value);
  if (!envelope.success) return { ok: false, error: envelope.error };
  const payload = commandPayloadSchemas[envelope.data.type].safeParse(envelope.data.payload);
  if (!payload.success) return { ok: false, error: payload.error };
  if (
    (COMMANDS_REQUIRING_BASE_REVISION.has(envelope.data.type) &&
      envelope.data.baseRevision === undefined) ||
    (ROW_TARGETING_COMMANDS.has(envelope.data.type) && envelope.data.baseLogEpoch === undefined)
  ) {
    return {
      ok: false,
      error: new z.ZodError([
        {
          code: "custom",
          path: [envelope.data.baseRevision === undefined ? "baseRevision" : "baseLogEpoch"],
          message: "CAS commands require baseRevision and baseLogEpoch",
        },
      ]),
    };
  }
  return {
    ok: true,
    envelope: { ...envelope.data, payload: payload.data },
  };
}

// ── ACK ──
export const commandResultSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["createSession", "createSelectionSideSession", "forkAssistant"]),
    sessionId: z.string(),
    input: z
      .object({
        delivery: z.enum(["startNow", "queue", "guide"]),
        inputId: z.string(),
        // The core admission ACK does not wait for TurnStarted; messageId may be filled by later events.
        messageId: z.string().optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("resolveInteraction"),
    resolvedBy: z.object({
      clientId: z.string(),
      optionId: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("applyFileRewind"),
    applied: z.boolean(),
    preview: v4ConversationFileRewindPreviewResultSchema,
    response: z.string(),
  }),
  z.object({
    type: z.literal("editUserQuery"),
    // fork remains for legacy ACK decoding only; new editUserQuery no longer creates child sessions.
    disposition: z.enum(["rewind", "fork", "blocked"]),
    sessionId: z.string().min(1),
    reasonCode: z.string().min(1).optional(),
    preview: v4ConversationFileRewindPreviewResultSchema.optional(),
  }),
  z.object({
    // startSavedWorkflow accepted ACK：
    // runId links the launch-turn run card state / notifications / side panel; toolCallId = launch-<uuid> links the synthesized CreateWorkflow turn.
    type: z.literal("startSavedWorkflow"),
    runId: z.string().min(1),
    toolCallId: z.string().min(1),
  }),
  amendWorkflowRunSettingsResultSchema,
  z.object({
    // messageId fills in as bystander attribution after TurnStarted; the core admission ACK does not wait
    // for projection commit, so messageId must not be a precondition of input accepted.
    type: z.literal("inputAccepted"),
    delivery: z.enum(["startNow", "queue", "guide"]),
    inputId: z.string(),
    messageId: z.string().optional(),
  }),
  z.object({
    // restart-discarded used to return one undifferentiated fault, leaving renderers unable to tell
    // runtime-local queues from startNow still needing confirmation. delivery comes from session_input
    // persisted facts, never guessed from the current UI phase.
    type: z.literal("inputDisposition"),
    delivery: z.enum(["startNow", "queue", "guide"]),
  }),
]);
export type CommandResult = z.infer<typeof commandResultSchema>;

export const commandAckSchema = z.object({
  /** App Memory switch at session creation; absent means unknown (legacy senders). */
  memoryEnabled: z.boolean().optional(),
  ttftExcluded: z.literal("capacity").optional(),
  commandId: z.string(),
  // accepted promises nothing about surviving the CLI process; the authoritative data (sourceCommandId) settles it.
  status: z.enum(["accepted", "rejected", "stale", "duplicate", "noop", "failed"]),
  // Required for rejected/stale/noop/failed; = guard id or fault code (namespace).
  reasonCode: z.string().optional(),
  message: z.string().optional(),
  revisionAtDecision: z.number(),
  // duplicate replays the cached result; accepted may also carry one immediately (fork).
  result: commandResultSchema.optional(),
});
export type CommandAck = z.infer<typeof commandAckSchema>;

// ── commands/query ──
export const commandKeySchema = z
  .object({
    // Null belongs to the global/createSession idempotency bucket only; session commands must carry a sessionId.
    sessionId: z.string().nullable(),
    commandId: z.string().min(1),
  })
  .strict();
export type CommandKey = z.infer<typeof commandKeySchema>;

export const commandsQueryParamsSchema = z
  .object({
    commands: z.array(commandKeySchema).min(1).max(64),
    clock: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (params) => !params.clock || params.commands.every((key) => key.sessionId === null),
    "clock probes cannot query session commands",
  );
export type CommandsQueryParams = z.infer<typeof commandsQueryParamsSchema>;

export const commandQueryItemSchema = z
  .object({
    key: commandKeySchema,
    result: z.union([commandAckSchema, z.literal("unknown")]),
  })
  .strict();
export type CommandQueryItem = z.infer<typeof commandQueryItemSchema>;

export const commandsQueryResultSchema = z
  .object({
    results: z.array(commandQueryItemSchema).min(1).max(64),
    clock: localTtftClockSchema.optional(),
  })
  .strict();
export type CommandsQueryResult = z.infer<typeof commandsQueryResultSchema>;
