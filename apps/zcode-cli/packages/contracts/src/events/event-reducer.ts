// ============================================================
// Event Reducer - State projection from events
// ============================================================

import type {
  SessionEvent,
  SessionCreatedPayload,
  SessionCompactedPayload,
  TurnCompletePayload,
  TurnErrorPayload,
  TurnSteerDiscardedPayload,
  TurnSteerDrainedPayload,
  TurnSteerDeliveryChangedPayload,
  TurnSteerQueuedPayload,
  TurnSteerReorderedPayload,
  ToolCallScheduledPayload,
  ToolCallStartedPayload,
  ToolCallResultPayload,
  ToolCallErrorPayload,
  ToolBatchCompletePayload,
  BackgroundTaskStartedPayload,
  BackgroundTaskUpdatedPayload,
  BackgroundTaskCompletedPayload,
  PermissionRequestedPayload,
  PermissionResolvedPayload,
  PermissionDeniedPayload,
  ModelCompletePayload,
  SessionModeChangedPayload,
  TargetChangedPayload,
  TargetCompletionVerificationPayload,
} from "./session.events.js";
import type {
  StreamRecoveryAnchorPayload,
  StreamingToolLedgerPayload,
} from "./stream-recovery.events.js";
import { SessionEventType as EventTypes } from "./session.events.js";
import { getModelUsageContextTokens } from "../model/index.js";
import { parseCheckpointCreatedPayload, parseRewindTriggeredPayload } from "../rewind/index.js";
import {
  GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
  failedGoalCompletionVerification,
  parseGoalCompletionVerificationText,
} from "../tools/target.js";
import type {
  ActiveToolCall,
  PendingPermission,
  SessionProjection,
  SessionStatus,
} from "../interfaces/session.port.js";
import {
  applyBackgroundTaskCompleted,
  applyBackgroundTaskStarted,
  applyBackgroundTaskUpdated,
  applyCompactBoundary,
  applyStreamRecoveryAnchorCreated,
  applyStreamingToolLedgerUpdate,
  initialSessionProjection,
} from "./event-reducer-helpers.js";

function shouldModelCompleteUpdateContextUsed(payload: ModelCompletePayload): boolean {
  if (payload.querySource !== undefined) {
    return payload.querySource === "main_turn";
  }

  // Compatibility with legacy main-session events lacking querySource; internal tool/subtask model calls
  // could also lack it, but their stopReason says tool_internal -- never let them override the main session.
  return payload.stopReason !== "tool_internal";
}

// -----------------------------------------------
// Event Reducer
// -----------------------------------------------

export class EventReducer {
  reduce(events: SessionEvent[]): SessionProjection {
    return events.reduce((projection, event) => this.apply(projection, event), {
      ...initialSessionProjection,
      id: events[0]?.sessionId ?? ("unknown" as any),
    } as SessionProjection);
  }

  apply(projection: SessionProjection, event: SessionEvent): SessionProjection {
    const handler = this.handlers[event.type];
    if (handler) {
      return handler(projection, event);
    }
    return {
      ...projection,
      updatedAt: event.timestamp,
    };
  }

  private handlers: Record<
    string,
    (projection: SessionProjection, event: SessionEvent) => SessionProjection
  > = {
    [EventTypes.SessionCreated]: (p, e) => {
      const payload = e.payload as SessionCreatedPayload;
      return {
        ...p,
        id: e.sessionId,
        mode: payload.mode,
        planEnabled: payload.planEnabled ?? payload.mode === "plan",
        contextWindow: payload.contextWindow,
        createdAt: e.timestamp,
        updatedAt: e.timestamp,
        status: "idle" as SessionStatus,
      };
    },

    [EventTypes.TurnStarted]: (p, e) => {
      return {
        ...p,
        currentTurnId: e.turnId,
        // The previous provider failure wrote projection.lastError; once the new round's message is accepted the
        // old error is no longer current. Clear at the source so readSession/getTaskSnapshot keep restoring stale banners.
        lastError: undefined,
        turnCount: p.turnCount + 1,
        status: "running" as SessionStatus,
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.SessionCompacted]: (p, e) => {
      const payload = e.payload as SessionCompactedPayload;
      return applyCompactBoundary(p, payload.compactBoundary, e.timestamp);
    },

    [EventTypes.SessionModeChanged]: (p, e) => {
      const payload = e.payload as SessionModeChangedPayload;
      return {
        ...p,
        ...(payload.permissionGrant
          ? {
              pendingSteerInputs: p.pendingSteerInputs.map((item) =>
                payload.permissionGrant!.queueItemIds.includes(item.pendingInputId) && item.intent
                  ? { ...item, intent: { ...item.intent, mode: "yolo" as const } }
                  : item,
              ),
            }
          : {}),
        mode: payload.mode,
        planEnabled: payload.planEnabled ?? payload.mode === "plan",
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.CompactBoundary]: (p, e) => {
      return applyCompactBoundary(p, e.payload, e.timestamp);
    },

    [EventTypes.CheckpointCreated]: (p, e) => {
      const payload = parseCheckpointCreatedPayload(e.payload);
      return {
        ...p,
        lastCheckpoint: {
          checkpointId: payload.checkpointId,
          compactBoundaryId: payload.compactBoundaryId,
          coveredByCompact: payload.coveredByCompact,
          createdAt: e.timestamp,
          fileCount: payload.fileCount,
          messageId: payload.messageId,
          targetMessageId: payload.targetMessageId,
          toolMessageId: payload.toolMessageId,
          scope: payload.scope,
          snapshotRef: payload.snapshotRef,
        },
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.RewindTriggered]: (p, e) => {
      const payload = parseRewindTriggeredPayload(e.payload);
      return {
        ...p,
        lastRewind: {
          compactBoundaryId: payload.compactBoundaryId,
          reason: payload.reason,
          rewindId: payload.rewindId,
          scope: payload.scope,
          strategy: payload.strategy,
          targetCheckpointId: payload.targetCheckpointId,
          targetMessageId: payload.targetMessageId,
          triggeredAt: e.timestamp,
        },
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.TurnComplete]: (p, e) => {
      const payload = e.payload as TurnCompletePayload;
      return {
        ...p,
        status: "idle" as SessionStatus,
        totalTokenCount: p.totalTokenCount + payload.tokenCount,
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.ModelComplete]: (p, e) => {
      const payload = e.payload as ModelCompletePayload;
      if (payload.querySource === GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE) {
        return {
          ...p,
          targetCompletionVerifications: [
            ...p.targetCompletionVerifications,
            parseGoalCompletionVerificationText(payload.content),
          ],
          updatedAt: e.timestamp,
        };
      }
      // The input bar's context usage reflects only the main session's latest provider context.
      // Title generation, compaction summaries, subagents, and tool-internal calls are not the main session's
      // visible context; letting their usage overwrite the projection renders 89/1m-style sidecar requests.
      if (!shouldModelCompleteUpdateContextUsed(payload)) {
        return {
          ...p,
          updatedAt: e.timestamp,
        };
      }
      // AI SDK v6 provider input already is total input (cache read/write included);
      // compute context used via the shared helper instead of re-deriving cache breakdown everywhere.
      const contextUsed = getModelUsageContextTokens(payload.usage);
      return {
        ...p,
        ...(contextUsed !== undefined ? { contextUsed } : {}),
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.StreamingToolLedgerUpdated]: (p, e) => {
      return applyStreamingToolLedgerUpdate(
        p,
        e.payload as StreamingToolLedgerPayload,
        e.timestamp,
      );
    },

    [EventTypes.StreamRecoveryAnchorCreated]: (p, e) => {
      return applyStreamRecoveryAnchorCreated(
        p,
        e.payload as StreamRecoveryAnchorPayload,
        e.timestamp,
      );
    },

    [EventTypes.TargetChanged]: (p, e) => {
      const payload = e.payload as TargetChangedPayload;
      const targetChanged =
        payload.action === "set" && payload.previousTarget?.targetID !== payload.target?.targetID;
      return {
        ...p,
        target: payload.target,
        targetCompletionVerifications: targetChanged ? [] : p.targetCompletionVerifications,
        targetCompletionVerificationTimeline: targetChanged
          ? []
          : p.targetCompletionVerificationTimeline,
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.TargetCompletionVerification]: (p, e) => {
      const payload = e.payload as TargetCompletionVerificationPayload;
      const existing = p.targetCompletionVerificationTimeline.find(
        (item) =>
          item.verificationId === payload.verificationId ||
          (payload.goalIteration !== undefined &&
            item.targetId === payload.targetId &&
            item.goalIteration === payload.goalIteration),
      );
      const startedAt =
        existing?.startedAt ?? (payload.status === "started" ? e.timestamp : undefined);
      // A goal check's UI identity is target + iteration; verificationId is per-attempt.
      // Merging started/completed or replayed recovery only by verificationId would append one goal check as several rows.
      const goalIteration =
        payload.goalIteration ??
        existing?.goalIteration ??
        p.targetCompletionVerificationTimeline.length + 1;
      const nextTimelineItem = {
        targetId: payload.targetId,
        status: payload.status,
        verificationId: payload.verificationId,
        ...(payload.verification ? { verification: payload.verification } : {}),
        goalIteration,
        ...((payload.anchorAssistantMessageId ?? existing?.anchorAssistantMessageId)
          ? {
              anchorAssistantMessageId:
                payload.anchorAssistantMessageId ?? existing?.anchorAssistantMessageId,
            }
          : {}),
        ...((payload.anchorTurnId ?? existing?.anchorTurnId)
          ? { anchorTurnId: payload.anchorTurnId ?? existing?.anchorTurnId }
          : {}),
        ...(startedAt ? { startedAt } : {}),
        updatedAt: e.timestamp,
      };
      const nextTimeline = existing
        ? p.targetCompletionVerificationTimeline.map((item) =>
            item === existing ? nextTimelineItem : item,
          )
        : [...p.targetCompletionVerificationTimeline, nextTimelineItem];
      return {
        ...p,
        // failed_closed/cancelled have no model_complete result event, so the lifecycle verdict must be folded into
        // the summary ledger here; normal completed keeps flowing through the existing model_complete projection,
        // avoiding double counting across old and new events.
        targetCompletionVerifications:
          payload.status === "failed_closed" || payload.status === "cancelled"
            ? [
                ...p.targetCompletionVerifications,
                payload.verification ??
                  failedGoalCompletionVerification(
                    "The completion verifier did not return a persisted result.",
                  ),
              ]
            : p.targetCompletionVerifications,
        targetCompletionVerificationTimeline: nextTimeline,
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.TurnError]: (p, e) => {
      const payload = e.payload as TurnErrorPayload;
      return {
        ...p,
        status: "error" as SessionStatus,
        // The projection feeds restart/recovery; preserve the real provider/subagent root cause.
        lastError: {
          type: payload.error.type,
          ...(payload.error.code ? { code: payload.error.code } : {}),
          message: payload.error.message,
          ...(payload.error.detail ? { detail: payload.error.detail } : {}),
          // TurnError's provider/network attribution is shared fact between live and cold projection;
          // the old reducer kept only prose and code, so task meta/telemetry could not distinguish provider rejections.
          ...(payload.error.attribution ? { attribution: payload.error.attribution } : {}),
        },
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.TurnSteerQueued]: (p, e) => {
      const payload = e.payload as TurnSteerQueuedPayload;
      const existingIndex = p.pendingSteerInputs.findIndex(
        (item) => item.pendingInputId === payload.pendingInputId,
      );
      const existing = existingIndex >= 0 ? p.pendingSteerInputs[existingIndex] : undefined;
      const next = {
        pendingInputId: payload.pendingInputId,
        input: payload.input,
        inputPreview: payload.inputPreview,
        inputSize: payload.inputSize,
        commandKind: payload.commandKind ?? existing?.commandKind,
        source: payload.source ?? existing?.source,
        inputPresentation: payload.inputPresentation ?? existing?.inputPresentation,
        intent: payload.intent ?? existing?.intent,
        toolDisallowlist: payload.toolDisallowlist ?? existing?.toolDisallowlist,
        // editQueueItem re-emits the queued event with the same id; an edit is not a new admission --
        // keep the original enqueued-at and array position, or cold rebuild would move it to the tail.

        queuedAt: existing?.queuedAt ?? e.timestamp,
        targetTurnId: payload.targetTurnId,
        traceId: e.traceId,
      };
      return {
        ...p,
        pendingSteerInputs:
          existingIndex >= 0
            ? p.pendingSteerInputs.map((item, index) => (index === existingIndex ? next : item))
            : [...p.pendingSteerInputs, next],
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.TurnSteerDeliveryChanged]: (p, e) => {
      const payload = e.payload as TurnSteerDeliveryChangedPayload;
      return {
        ...p,
        pendingSteerInputs: p.pendingSteerInputs.map((item) =>
          item.pendingInputId === payload.pendingInputId
            ? {
                ...item,
                intent:
                  payload.intent ??
                  (item.intent
                    ? {
                        ...item.intent,
                        admittedDelivery: payload.admittedDelivery,
                        fallbackReasonCode: payload.fallbackReasonCode,
                      }
                    : undefined),
              }
            : item,
        ),
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.TurnSteerReordered]: (p, e) => {
      const payload = e.payload as TurnSteerReorderedPayload;
      const byId = new Map(p.pendingSteerInputs.map((item) => [item.pendingInputId, item]));
      const orderedIds = new Set(payload.orderedPendingInputIds);
      const ordered = payload.orderedPendingInputIds.flatMap((id) => {
        const item = byId.get(id);
        return item ? [item] : [];
      });
      const rest = p.pendingSteerInputs.filter((item) => !orderedIds.has(item.pendingInputId));
      return {
        ...p,
        pendingSteerInputs: [...ordered, ...rest].map((item, queuePosition) => ({
          ...item,
          ...(item.intent ? { intent: { ...item.intent, queuePosition } } : {}),
        })),
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.TurnSteerDrained]: (p, e) => {
      const payload = e.payload as TurnSteerDrainedPayload;
      return {
        ...p,
        pendingSteerInputs: p.pendingSteerInputs.filter(
          (item) => !payload.pendingInputIds.includes(item.pendingInputId),
        ),
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.TurnSteerDiscarded]: (p, e) => {
      const payload = e.payload as TurnSteerDiscardedPayload;
      return {
        ...p,
        pendingSteerInputs: p.pendingSteerInputs.filter(
          (item) => !payload.pendingInputIds.includes(item.pendingInputId),
        ),
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.ToolCallScheduled]: (p, e) => {
      const payload = e.payload as ToolCallScheduledPayload;
      const newToolCall: ActiveToolCall = {
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        status: "pending",
      };
      return {
        ...p,
        activeToolCalls: [...p.activeToolCalls, newToolCall],
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.ToolCallStarted]: (p, e) => {
      const payload = e.payload as ToolCallStartedPayload;
      return {
        ...p,
        activeToolCalls: p.activeToolCalls.map((tc) =>
          tc.toolCallId === payload.toolCallId
            ? { ...tc, status: "running", startedAt: payload.startedAt }
            : tc,
        ),
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.ToolCallResult]: (p, e) => {
      const payload = e.payload as ToolCallResultPayload;
      return {
        ...p,
        activeToolCalls: p.activeToolCalls.map((tc) =>
          tc.toolCallId === payload.toolCallId
            ? { ...tc, status: payload.result.success ? "completed" : "failed" }
            : tc,
        ),
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.ToolCallError]: (p, e) => {
      const payload = e.payload as ToolCallErrorPayload;
      return {
        ...p,
        activeToolCalls: p.activeToolCalls.map((tc) =>
          tc.toolCallId === payload.toolCallId ? { ...tc, status: "failed" } : tc,
        ),
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.ToolBatchComplete]: (p, e) => {
      const payload = e.payload as ToolBatchCompletePayload;
      const activeToolCalls = p.activeToolCalls.filter(
        (tc) => !payload.toolCallIds.includes(tc.toolCallId as any),
      );
      return {
        ...p,
        activeToolCalls,
        // a tool batch can finish before the turn makes its follow-up model request.
        // Only turn_complete moves the session projection back to idle.
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.BackgroundTaskStarted]: (p, e) => {
      const payload = e.payload as BackgroundTaskStartedPayload;
      return applyBackgroundTaskStarted(p, payload, e.timestamp);
    },

    [EventTypes.BackgroundTaskUpdated]: (p, e) => {
      const payload = e.payload as BackgroundTaskUpdatedPayload;
      return applyBackgroundTaskUpdated(p, payload, e.timestamp);
    },

    [EventTypes.BackgroundTaskCompleted]: (p, e) => {
      const payload = e.payload as BackgroundTaskCompletedPayload;
      return applyBackgroundTaskCompleted(p, payload, e.timestamp);
    },

    [EventTypes.PermissionRequested]: (p, e) => {
      const payload = e.payload as PermissionRequestedPayload;
      const newPending: PendingPermission = {
        input: payload.input,
        reason: payload.reason,
        requestId: payload.requestId,
        toolCallId: payload.toolCallId,
        toolName: payload.toolName,
        ...(payload.approvalMode ? { approvalMode: payload.approvalMode } : {}),
        ...(payload.suggestedPermissionUpdates
          ? { suggestedPermissionUpdates: payload.suggestedPermissionUpdates }
          : {}),
        ...(payload.origin ? { origin: payload.origin } : {}),
        ...(payload.display ? { display: payload.display } : {}),
        ...(payload.optionsPolicy ? { optionsPolicy: payload.optionsPolicy } : {}),
        riskLevel: payload.riskLevel,
        requestedAt: e.timestamp,
      };
      return {
        ...p,
        pendingPermissions: [...p.pendingPermissions, newPending],
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.PermissionResolved]: (p, e) => {
      const payload = e.payload as PermissionResolvedPayload;
      let toolStatus: ActiveToolCall["status"] = "completed";
      if (payload.decision === "deny") {
        toolStatus = "denied";
      }

      return {
        ...p,
        pendingPermissions: p.pendingPermissions.filter(
          (pp) => pp.toolCallId !== payload.toolCallId,
        ),
        activeToolCalls: p.activeToolCalls.map((tc) =>
          tc.toolCallId === payload.toolCallId ? { ...tc, status: toolStatus } : tc,
        ),
        updatedAt: e.timestamp,
      };
    },

    [EventTypes.PermissionDenied]: (p, e) => {
      const payload = e.payload as PermissionDeniedPayload;
      return {
        ...p,
        pendingPermissions: p.pendingPermissions.filter(
          (pp) => pp.toolCallId !== payload.toolCallId,
        ),
        activeToolCalls: p.activeToolCalls.map((tc) =>
          tc.toolCallId === payload.toolCallId ? { ...tc, status: "denied" } : tc,
        ),
        updatedAt: e.timestamp,
      };
    },
  };
}

// -----------------------------------------------
// Utility Functions
// -----------------------------------------------

export function reduce(events: SessionEvent[]): SessionProjection {
  return new EventReducer().reduce(events);
}

export function apply(projection: SessionProjection, event: SessionEvent): SessionProjection {
  return new EventReducer().apply(projection, event);
}
