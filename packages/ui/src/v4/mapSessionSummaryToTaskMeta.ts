// sessions-index SessionSummary -> sidebar live-detail ZCodeTaskMeta mapping.
// These objects never decide row existence alone; the later join uses persisted tasks-index.sqlite rows as the left table.
// Note: summary.sessionEnded means successful-turn close (completedSuccess true), not deletion;
// session.removed only drops live detail; persistent-row removal stays with the tasks-index row/tombstone.
import type { TraceId, ZCodeProvider, ZCodeTaskMeta } from "@zcode/shared";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import {
  attachTaskListRowActivity,
  type TaskListMetaWithActivity,
} from "@/v4/taskListRowActivity.js";

/** phase -> sidebar persisted state (running/completed/error); drafts have no result state. */
function phaseToStatus(phase: SessionSummary["phase"]): ZCodeTaskMeta["status"] {
  switch (phase) {
    case "running":
    case "prewarming":
      return "running";
    case "completedSuccess":
    case "completedInterrupted":
      return "completed";
    case "error":
      return "error";
    default:
      return undefined; // draft
  }
}

export interface MapSessionSummaryOptions {
  workspacePath: string;
  workspaceIdentity?: string;
  /** Locally existing meta (keeps manual title/provider etc., safe from list-refresh wipes). */
  previous?: ZCodeTaskMeta;
}

/**
 * SessionSummary -> live-detail ZCodeTaskMeta. Fields absent from sessions-index
 * (traceId/mode/provider) take sane defaults or previous; real persisted fields follow the task row at join time.
 */
export function mapSessionSummaryToTaskMeta(
  summary: SessionSummary,
  options: MapSessionSummaryOptions,
): TaskListMetaWithActivity {
  const previous = options.previous;
  const status = phaseToStatus(summary.phase);
  const summaryTitleIsCustom = summary.titleSource === "custom";
  // When the legacy task-index already holds a titleOverridden=true manual title, the
  // sessions-index cold-start summary may still be a first_input/generated title. Treat summary.title as the new
  // manual-title authority only when the v4 session store explicitly marks custom.
  const title =
    previous?.titleOverridden === true && !summaryTitleIsCustom
      ? previous.title
      : summary.title || previous?.title || "";
  const titleOverridden =
    summaryTitleIsCustom || previous?.titleOverridden === true ? true : undefined;
  return attachTaskListRowActivity(
    {
      taskId: summary.sessionId,
      traceId: (previous?.traceId ?? `session-${summary.sessionId}`) as TraceId,
      title,
      ...(titleOverridden ? { titleOverridden } : {}),
      workspacePath: options.workspacePath,
      ...(options.workspaceIdentity ? { workspaceIdentity: options.workspaceIdentity } : {}),
      createdAt: summary.createdAt || previous?.createdAt || 0,
      updatedAt: summary.lastActivityAt || previous?.updatedAt || 0,
      mode: previous?.mode ?? "default",
      ...(previous?.model ? { model: previous.model } : {}),
      ...(summary.parentSessionId ? { forkedFromTaskId: summary.parentSessionId } : {}),
      ...(previous?.provider ? { provider: previous.provider as ZCodeProvider } : {}),
      ...(status ? { status } : {}),
      ...(summary.pendingInteraction
        ? {
            pendingInteraction: {
              interactionId: summary.pendingInteraction.interactionId,
              kind: summary.pendingInteraction.kind,
              ...(summary.pendingInteraction.toolName
                ? { toolName: summary.pendingInteraction.toolName }
                : {}),
              ...(summary.pendingInteraction.autoResolution
                ? { autoResolution: summary.pendingInteraction.autoResolution }
                : {}),
            },
          }
        : {}),
      ...(previous?.unreadAt ? { unreadAt: previous.unreadAt } : {}),
    },
    {
      phase: summary.phase,
      lastActivityAt: summary.lastActivityAt,
      hasBackgroundWork: summary.hasBackgroundWork,
      ...(summary.pendingInteractionSummary
        ? { pendingInteractions: summary.pendingInteractionSummary }
        : {}),
      ...(summary.workflowActivity ? { workflowActivity: summary.workflowActivity } : {}),
    },
  );
}
