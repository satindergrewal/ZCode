import {
  SessionEventType,
  type DynamicWorkflowRunProgressPayload,
  type TraceContext,
} from "../deps.js";
import {
  formatWorkflowEscalationNotification,
  formatWorkflowStallNotification,
} from "../../runtime-task/notification.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { notifyHoleReached } from "./dynamic-workflow-run-hole-notification.js";

/**
 * Appends a workflow run progress event to the **parent session** (the run has no session of its own).
 *
 * This is an **out-of-turn append**: the run is in flight, and when the event lands the parent may be mid-turn or fully idle.
 * Both must land, and this path supports both — BackgroundTask* uses it (inside core via the
 * tool executor's emitEvent). The dwf event source lives in bootstrap's run service, a layer without
 * AgentRuntimeInternal — hence this public method; same-shaped precedent: {@link recordTargetChanged}.
 *
 * Deliberately `rootTraceContext`, not the current turn's trace: turnId stays empty so the event sponsors no turn.
 * Cold-restore merge re-inserts turn-tagged in-memory events at the tail of their "owning unfinished turn", and a run event
 * belongs to the run, not to a turn — sponsoring one would surface it at the end of a finished conversation after restore.
 */
export async function recordDynamicWorkflowRunProgress(
  this: AgentRuntimeInternal,
  input: DynamicWorkflowRunProgressPayload & { traceContext?: TraceContext },
): Promise<void> {
  const { traceContext: provided, ...payload } = input;
  const traceContext = provided ?? this.rootTraceContext;
  await this.appendEvent(
    this.createEvent(
      SessionEventType.DynamicWorkflowRunProgress,
      payload satisfies DynamicWorkflowRunProgressPayload,
      traceContext,
    ),
    traceContext,
  );
  notifyEscalationRaised.call(this, payload, traceContext);
  notifyRunStalled.call(this, payload, traceContext);
  // The hole (dynamic-workflow-run-hole-notification.ts) needs one snapshot read for type / draft / phases, making it
  // the only async one of the three; the event is already persisted, so the wait is just notification enqueueing.
  await notifyHoleReached.call(this, payload, traceContext);
}

/** Event kind of a run-level stall (the engine's `RunEvent.type`). */
const RUN_STALLED_EVENT_TYPE = "run-stalled";

/**
 * `run-stalled` -> one model-visible in-run notification. Same layer as {@link notifyEscalationRaised}, same three
 * disciplines: exactly one notification per event (the driver emits once per stall segment; re-arming after success produces the next);
 * no nagging; never throw — skip and log on a malformed payload.
 */
function notifyRunStalled(
  this: AgentRuntimeInternal,
  payload: DynamicWorkflowRunProgressPayload,
  traceContext: TraceContext,
): void {
  if (payload.eventType !== RUN_STALLED_EVENT_TYPE) return;
  const sinceMs = payload.payload.sinceMs;
  if (typeof sinceMs !== "number" || !Number.isFinite(sinceMs) || sinceMs < 0) {
    this.logger?.warn?.("Dynamic workflow stall notification skipped: malformed payload", {
      event: "dynamic_workflow.stall.notification_skipped",
      module: "core.runtime",
      runId: payload.runId,
      sequence: payload.sequence,
    });
    return;
  }
  const runLabel = this.runtimeTaskRegistry.get(payload.runId)?.description ?? payload.runId;
  const reason = stringField(payload.payload, "reason");
  const capValue = payload.payload.cap;
  const cap =
    typeof capValue === "number" && Number.isFinite(capValue) && capValue >= 0
      ? Math.floor(capValue)
      : undefined;
  this.enqueueBackgroundTaskNotification({
    originMeta: {
      backgroundSource: "workflow",
      title: runLabel,
      workId: payload.runId,
      workflowNotification: {
        kind: "stall",
        sinceMs: Math.floor(sinceMs),
        ...(reason === undefined ? {} : { reason: reason.slice(0, 64) }),
        ...(cap === undefined ? {} : { cap }),
      },
    },
    taskId: payload.runId,
    text: formatWorkflowStallNotification({
      runLabel,
      runId: payload.runId,
      sinceMs,
      ...(reason === undefined ? {} : { reason }),
      ...(cap === undefined ? {} : { cap }),
    }),
    traceContext,
  });
}

/** Event kind of the escalation Q&A (the engine's `RunEvent.type`, arriving via the progress payload's `eventType`). */
const ESCALATION_RAISED_EVENT_TYPE = "escalation-raised";

/**
 * `escalation-raised` -> one model-visible in-run notification.
 *
 * Why this layer instead of a new port: the progress sink already delivers every RunEvent here, the **only** place
 * that sees both run events and the AgentRuntime. Another port would route one fact two ways.
 *
 * Three disciplines:
 *   - **exactly one notification per raised**, no re-sends, no nagging. Once dropped (stale branch / shutdown)
 *     the fallback is a query — GetWorkflowRun's pendingQuestions, not a retry.
 *   - **`escalation-resolved` sends nothing**: the answerer is the main agent itself; the tool result is the receipt.
 *   - **never throw**: this is the observation surface; the run's truth lives in the journal. On a malformed payload, skip and log —
 *     it crossed a port boundary and was bounded once; defensive reading is what it deserves.
 */
function notifyEscalationRaised(
  this: AgentRuntimeInternal,
  payload: DynamicWorkflowRunProgressPayload,
  traceContext: TraceContext,
): void {
  if (payload.eventType !== ESCALATION_RAISED_EVENT_TYPE) return;

  const qid = stringField(payload.payload, "qid");
  const question = stringField(payload.payload, "question");
  if (qid === undefined || question === undefined) {
    this.logger?.warn?.("Dynamic workflow escalation notification skipped: malformed payload", {
      event: "dynamic_workflow.escalation.notification_skipped",
      module: "core.runtime",
      runId: payload.runId,
      sequence: payload.sequence,
    });
    return;
  }

  // Display-name fallback chain matches the terminal-state notice: registry entry description (CreateWorkflow's name /
  // derived from the script's first line) -> runId. Deliberately no port query — the notice is produced synchronously and this path does no I/O.
  const runLabel = this.runtimeTaskRegistry.get(payload.runId)?.description ?? payload.runId;
  const context = stringField(payload.payload, "context");
  // An anonymous actor has no actorName (the engine intentionally synthesizes no fallback label, see the RunEvent note): fall back to the
  // structured ref `site@ordinal`, unique within the run and readable as a sentence. The notice text and the manifest
  // payload share one fallback chain — two independent chains would show the same actor under different names.
  const actor = stringField(payload.payload, "actorName") ?? actorRefLabel(payload.payload);
  // askedAt is epoch ms and may be absent (stringField cannot read numbers; defensive direct read).
  const askedAt = payload.payload.askedAt;

  this.enqueueBackgroundTaskNotification({
    originMeta: {
      backgroundSource: "workflow",
      title: runLabel,
      // workId = runId: same display anchor as the run's terminal notice, so both notifications land on one background work item.
      workId: payload.runId,
      // Manifest payload (escalation discriminant): the GUI collapses to "Subagent X has a question" and
      // expands to the full question. Emitter-minted and bounded (question / context <= 4000, shared schema, synchronous).
      workflowNotification: {
        kind: "escalation",
        qid,
        actor,
        question: question.slice(0, WORKFLOW_ESCALATION_TEXT_MAX_CHARS),
        ...(context === undefined
          ? {}
          : { context: context.slice(0, WORKFLOW_ESCALATION_TEXT_MAX_CHARS) }),
        ...(typeof askedAt === "number" && Number.isFinite(askedAt) ? { askedAt } : {}),
      },
    },
    // taskId lets the notification inherit the run's branchGeneration (fencing for late notices); fallback is a snapshot query.
    taskId: payload.runId,
    text: formatWorkflowEscalationNotification({
      runLabel,
      runId: payload.runId,
      qid,
      actor,
      question,
      ...(context === undefined ? {} : { context }),
    }),
    traceContext,
  });
}

/** Bound for question / context in the manifest payload (shared schema: <= 4000 chars). */
const WORKFLOW_ESCALATION_TEXT_MAX_CHARS = 4_000;

/** `{siteId, ordinal}` -> `site@ordinal` (the shape of the engine's `refToString`); unreadable means "unknown actor". */
function actorRefLabel(payload: Record<string, unknown>): string {
  const actor = payload.actor;
  if (typeof actor === "string") return actor;
  if (typeof actor !== "object" || actor === null) return "unknown actor";
  const siteId = stringField(actor as Record<string, unknown>, "siteId");
  const ordinal = (actor as Record<string, unknown>).ordinal;
  if (siteId === undefined || typeof ordinal !== "number") return "unknown actor";
  return `${siteId}@${ordinal}`;
}

function stringField(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
