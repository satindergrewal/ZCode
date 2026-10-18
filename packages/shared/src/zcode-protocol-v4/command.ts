import { localTtftContextSchema, localTtftClockSchema } from "../localTtft.js";
// Command layer: envelope / ACK / the full command payload set.
// conversation rewind has no dedicated command (ruling: it is editUserQuery's UI entry);
// workspace-only file undo goes through applyFileRewind, never truncating chat history.
import { z } from "zod";
import { conversationRowTargetSchema, timestampSchema } from "./core.js";
import { attachmentRefSchema } from "./attachment-ref.js";
import { v4ConversationFileRewindPreviewResultSchema } from "./transport.js";
import { modelSelectionSchema } from "../model-selection.js";
import { modelExecutionSchema } from "../model-execution.js";
import { submissionModeSchema } from "./submission.js";
import { zcodeAutomationBotDeliveryTargetSchema } from "../bots.js";
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
import { sharedContextRefSchema } from "./shared-context-ref.js";
export type { SharedContextRef } from "./shared-context-ref.js";

const createSessionRequestedConfigSchema = z.object({
  modelSelection: modelSelectionSchema.optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  thought: z.string().optional(),
  followupMode: z.enum(["queue", "guide"]).optional(),
  // createSession.config means "requested override fields" and cannot reuse snapshot's
  // sessionConfigStateSchema.partial(); snapshot sets default("build") for mode for legacy-snapshot compat, which would
  // misread "mode not sent" as "switch back to build", clobbering the workspace default yolo.
  mode: z.string().optional(),
  planEnabled: z.boolean().optional(),
});

// -- Command payload set --
export const commandPayloadSchemas = {
  // Absent firstInput -> phase=draft empty session; present -> turnHeader+userInput rows directly.
  createSession: z.object({
    workspaceId: z.string(),
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
    // MCP is runtime-startup config: it must enter the record at create time, not be patched after the first turn.
    mcpServers: z.array(zcodeProtocolMcpServerSchema).optional(),
    // Off-Peak tooling flag, equivalent to legacy session/create--V4 createSession is the desktop's actual
    // new-session path; without passthrough OffPeakCreate/OffPeakList never register. Additive:
    // legacy CLIs' z.object silently drops the key (fail-closed).
    offPeakToolEnabled: z.boolean().optional(),
    // Dynamic-workflow rollout flag, same pattern as offPeakToolEnabled.
    dynamicWorkflowEnabled: z.boolean().optional(),
  }),
  // The parent session is given by envelope.sessionId; the server derives the full runtime config from the parent record.
  // With firstInput present, the child starts its first normal input right after creation; otherwise the subscreen stays empty.
  createSelectionSideSession: z.object({
    firstInput: z
      .object({
        text: z.string().trim().min(1),
        // The submitted selection only covers the new child's complete choice; absent keeps the parent runtime inheritance.
        modelSelection: modelSelectionSchema.optional(),
      })
      .optional(),
  }),
  // Adjudicated by inputRouting: startNow / enqueue / guide / choice.
  // heldQueueDisposition: mandatory in held state (inputRouting.mode=choice);
  // clear -> empty the queue then startNow, keep -> keep the queue and startNow immediately.
  sendText: z
    .object({
      text: z.string(),
      attachments: z.array(attachmentRefSchema).optional(),
      // Desktop Cmd/Ctrl+Enter overrides only this busy input, never session followupMode.
      // startNow has the CLI preempt the current turn atomically, bypassing queue admission.
      requestedDelivery: z.enum(["startNow", "queue", "guide"]).optional(),
      browserAmbientContext: zcodeBrowserAmbientContextSchema.optional(),
      // Share handover allows one imported context of the current session; the full body is resolved by the runtime from
      // persisted provenance, never passed from the renderer in the command.
      context_refs: z.array(sharedContextRefSchema).max(1).optional(),
      heldQueueDisposition: z.enum(["clearQueueAndSend", "keepQueueAndSend"]).optional(),
      // The queueItemId set visible when the pause-confirm dialog opened. The CLI validates before clear/keep,
      // so desktop/phone concurrent additions are not swept along unconfirmed.
      expectedHeldQueueItemIds: z.array(z.string().min(1)).optional(),
      // Legacy senders may omit during migration; CLI admission pins the current Session Selection into the
      // canonical intent. After the renderer migrates, first-party submissions always carry both explicitly.
      modelSelection: modelSelectionSchema.optional(),
      mode: submissionModeSchema.optional(),
      planEnabled: z.boolean().optional(),
      // This execution still uses the standard Selection above; only non-persisted semantics, dynamic auth, and child policy ride here.
      // Accepted only for idle startNow, keeping Secret/Ticket out of the plain CommandInbox.
      modelExecution: modelExecutionSchema.optional(),
      automationId: z.string().min(1).optional(),
      offPeakTaskId: z.string().min(1).optional(),
      offPeakRunType: z.enum(["init", "resume"]).optional(),
      // Bot origin injected only by the Host, for CronCreate to read and persist the callback address within the current turn.
      botDeliveryTarget: zcodeAutomationBotDeliveryTargetSchema.optional(),
      // Follow-up user inputs of scheduled-task sessions keep turn-scoped tooling isolation; do not borrow
      // automationId, or plain user inputs get mislabeled as automation dispatches.
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
      if (payload.modelExecution && !payload.modelSelection) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "modelExecution requires modelSelection",
          path: ["modelExecution"],
        });
      }
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
  // compact is an input-like maintenance command: run immediately when idle, join the FIFO when busy/held.
  // Admission is revision-independent, no CAS; sourceCommandId provides the idempotence boundary.
  compact: z.object({}),
  // Available on stable assistant rows while running.
  forkAssistant: z.object({ target: conversationRowTargetSchema }),
  applyFileRewind: z.object({ target: conversationRowTargetSchema }),
  editUserQuery: z.object({
    target: conversationRowTargetSchema,
    newText: z.string(),
    attachments: z.array(attachmentRefSchema).optional(),
    // Absent = preserve: switch conversation branch only; rewind first safely restores that round's files.
    workspaceMode: z.enum(["preserve", "rewind"]).optional(),
  }),
  retryTurn: z.object({ target: conversationRowTargetSchema }),
  setAssistantFeedback: z.object({
    target: conversationRowTargetSchema,
    feedback: z.enum(["like", "dislike"]).nullable(),
  }),
  sendQueuedNow: z.object({ queueItemId: z.string() }),
  editQueueItem: z.object({ queueItemId: z.string(), newText: z.string() }),
  // beforeQueueItemId = null -> move to the tail.
  reorderQueueItem: z.object({
    queueItemId: z.string(),
    beforeQueueItemId: z.string().nullable(),
  }),
  deleteQueueItem: z.object({ queueItemId: z.string() }),
  setAutoDrain: z.object({ autoDrain: z.boolean() }),
  // First come first served; late arrivals no-op (reasonCode=proto.alreadyResolved).
  resolveInteraction: z.object({
    interactionId: z.string(),
    answer: z.object({
      optionId: z.string().optional(),
      freeText: z.string().optional(),
      // (Elicitation receipt convergence): lossless carrier for AskUserQuestion/plan-approval
      // multi-question answers and annotations. With action present the CLI broker maps exactly to
      // accept/decline/cancel (content passes through legacy userInput response semantics); absent keeps the
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
  // Soft gate: open the review flow on demand; clones revoke non-flow targets but carry no hookDeclarationDigests.
  requestWorkspaceHookReview: requestWorkspaceHookReviewTargetSchema,
  // The first valid AskUserQuestion action pauses this auto-finish permanently; repeat/late calls are idempotent no-ops.
  snoozeInteractionAutoResolution: z.object({
    interactionId: z.string(),
  }),
  switchModelConfig: z.object({
    provider: z.string(),
    model: z.string(),
    thought: z.string(),
  }),
  // Additive (frozen surface backed by golden tests): agent collaboration-mode switch.
  // Value domain = the switchable subset of core CollaborationMode (auto is not user-switchable, stays out of the UI command surface).
  switchCollaborationMode: z.object({
    mode: z.enum(["build", "edit", "plan", "yolo"]),
  }),
  setFollowupMode: z.object({ mode: z.enum(["queue", "guide"]) }),
  pauseGoal: z.object({}),
  resumeGoal: z.object({}),
  cancelBackgroundWork: z.object({ workId: z.string() }),
  // cancel & resume: resume a dwf run cancelled or interrupted by process death.
  // workId == runId (the same identity equation as cancelBackgroundWork); `name` optional,
  // feeding the post-resume completion notice subject (the original CreateWorkflow tool input is unavailable after restart). Deliberately no
  // baseRevision: kin of cancelBackgroundWork (the workflowRuns surface is revision-free; a fake CAS failure
  // would only hurt). The gate lives CLI-side (resumable set = cancelled union failed+Interrupted); rejections ACK with
  // fault.command.workflowRunResumeRejected.<reason>.
  resumeWorkflowRun: z.object({ workId: z.string(), name: z.string().optional() }),
  // startSavedWorkflow: the hub's "Run" no longer synthesizes
  // conversation copy; it asks the agent to start the saved workflow in a new session. Kin of cancelBackgroundWork / resumeWorkflowRun:
  // no baseRevision (workflowRuns surface is revision-free; fake CAS failures only hurt). name is filled by the agent from
  // the resolution (invariant 6); the command accepts no name override.
  // Rejections ACK with fault.command.savedWorkflowStartRejected.<reason> (vocabulary in
  // savedWorkflowStartRejectionReasonSchema below); missing capability (no dwf port) -> V4CapabilityUnsupportedError
  // (the same error as resumeWorkflowRun).
  startSavedWorkflow: z.object({
    name: z.string().min(1),
    scope: z.enum(["project", "global"]).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  }),
  // amendWorkflowRunSettings: the run card / detail page "Configure" asks the agent to revise the run with new settings, no model round.
  // Payload, result, and rejection vocabulary in workflow-run-settings-command.ts; missing capability -> V4CapabilityUnsupportedError.
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

// startSavedWorkflow rejection vocabulary:
// The bootstrap handler mints the fault code; the ui launcher looks up i18n copy; both share this enum to avoid drift.
// invalid_name / not_found: resolution; invalid_args: argument validation; compile_failed: analyzeScript diagnostics;
// session_busy: the session has an active turn; start_failed: any other start failure before port.submit.
export const savedWorkflowStartRejectionReasonSchema = z.enum([
  "invalid_name",
  "not_found",
  "invalid_args",
  "compile_failed",
  "session_busy",
  "start_failed",
]);
export type SavedWorkflowStartRejectionReason = z.infer<
  typeof savedWorkflowStartRejectionReasonSchema
>;

// Full fault code = prefix + reason (e.g. fault.command.savedWorkflowStartRejected.not_found).
// Same namespace family as workflowRunResumeRejected; exported for bootstrap to concat and ui to prefix-match.
export const SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX =
  "fault.command.savedWorkflowStartRejected." as const;

// resumeWorkflowRun rejections: prefix + port reason (not_found / not_resumable / superseded /
// already_running / script_missing / script_mismatch / compile_failed); `ack.message` carries
// bounded compile_failed diagnostics.
export const WORKFLOW_RUN_RESUME_REJECTED_FAULT_PREFIX =
  "fault.command.workflowRunResumeRejected." as const;

// cancelBackgroundWork rejections: when core definitively cancels nothing (missing task / already terminal / unsupported kind),
// upstream gets prefix + reason instead of a fake-success accepted--the detail page tells the user the run is not running.
// reason is core's stopBackgroundTask reason minus the `background_task_` prefix: not_found /
// not_running / cancel_not_supported。
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
]);

// -- Envelope --
export const commandEnvelopeSchema = z.object({
  ttft: localTtftContextSchema.optional(),
  // uuid v7, client-generated, stable across retries.
  commandId: z.string(),
  clientId: z.string(),
  // Null at createSession.
  sessionId: z.string().nullable(),
  baseRevision: z.number().optional(),
  baseLogEpoch: z.string().trim().min(1).optional(),
  type: commandTypeSchema,
  payload: z.unknown(),
  // Client clock, telemetry only; the server never adjudicates with it.
  issuedAt: timestampSchema,
});
export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>;

/** Validate the envelope and the payload by type (the envelope schema cannot statically bind the payload; funneled here). */
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
        // The Core admission ACK does not wait for TurnStarted; messageId may be backfilled by later events.
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
    // fork kept only for legacy ACK decode compat; new editUserQuery no longer spawns child sessions.
    disposition: z.enum(["rewind", "fork", "blocked"]),
    sessionId: z.string().min(1),
    reasonCode: z.string().min(1).optional(),
    preview: v4ConversationFileRewindPreviewResultSchema.optional(),
  }),
  z.object({
    // startSavedWorkflow accepted ACK：
    // runId joins the launch-round run card state / notice / side panel; toolCallId = launch-<uuid> joins the synthesized CreateWorkflow round.
    type: z.literal("startSavedWorkflow"),
    runId: z.string().min(1),
    toolCallId: z.string().min(1),
  }),
  amendWorkflowRunSettingsResultSchema,
  z.object({
    // messageId is backfilled as bypass attribution only after TurnStarted; the Core admission ACK does not wait
    // for projection commit, so messageId must not be a precondition of input accepted.
    type: z.literal("inputAccepted"),
    delivery: z.enum(["startNow", "queue", "guide"]),
    inputId: z.string(),
    messageId: z.string().optional(),
  }),
  z.object({
    // restart discarded used to return one indiscriminate fault, leaving renderers unable to tell
    // runtime-local queues from startNow still needing confirmation. delivery comes from persisted session_input
    // facts, never guessed from the current UI phase.
    type: z.literal("inputDisposition"),
    delivery: z.enum(["startNow", "queue", "guide"]),
  }),
]);
export type CommandResult = z.infer<typeof commandResultSchema>;

export const commandAckSchema = z.object({
  /// App Memory toggle adopted at session creation; absent on legacy senders means unknown.
  memoryEnabled: z.boolean().optional(),
  ttftExcluded: z.literal("capacity").optional(),
  commandId: z.string(),
  // accepted promises nothing across CLI processes; final closeout defers to authoritative data (sourceCommandId).
  status: z.enum(["accepted", "rejected", "stale", "duplicate", "noop", "failed"]),
  // Mandatory on rejected/stale/noop/failed; = guard id or fault code (namespaced).
  reasonCode: z.string().optional(),
  message: z.string().optional(),
  revisionAtDecision: z.number(),
  // duplicate replays the cached result; accepted may also carry it immediately (fork).
  result: commandResultSchema.optional(),
});
export type CommandAck = z.infer<typeof commandAckSchema>;

// ── commands/query ──
export const commandKeySchema = z
  .object({
    // Null belongs only to the global/createSession idempotence bucket; session commands must carry sessionId.
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
