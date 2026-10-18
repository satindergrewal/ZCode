import type { TurnHeaderRow, WorkflowNotificationMeta } from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/fileSummaryTypes.js";

/**
 * Completion-card resolution: is this the turn where the main agent digested one **completed**
 * workflow notification? Pure function, cut along the same seam as `resolveWorkflowTurnDigests`.
 *
 * Requires all three: a background-result turn, workflow origin, terminal payload with
 * status === "completed". failed/cancelled draw no card (the notification row already says the
 * error and shows partial-artifact chips); escalation notices, batch turns (no payload at all),
 * and bash/subagent notifications are not it.
 *
 * The artifact list bottoms out in the notification payload: it persists with the notice and
 * survives cold restore; projection/journal only decorate it with byte counts, provenance, and
 * board spec.
 */
export type WorkflowTerminalNotification = Extract<WorkflowNotificationMeta, { kind: "terminal" }>;

export interface WorkflowTurnCompletion {
  runId: string;
  /** Notification title (CLI workflowTaskSubject, never localized); same source as the row primaryText. */
  name: string;
  /** Wall-clock time from the notice; absent renders `—` in the time cell. */
  durationMs?: number;
  artifacts: NonNullable<WorkflowTerminalNotification["artifacts"]>;
  // Trimmed emitter-side (over 8 or filtered) - the overflow count may under-report.
  artifactsTruncated: boolean;
  // The run joined from the projection; absent (cut by the 8-cap) means three `—` cells and no expand. Restores no longer lose it: CLI cold materialization replays the projection from the journal.
  summary: WorkflowRunCardSummary | undefined;
}

export function resolveWorkflowTurnCompletion(
  header: TurnHeaderRow | undefined,
  join: { byRunId?: ReadonlyMap<string, WorkflowRunCardSummary> },
): WorkflowTurnCompletion | undefined {
  if (header?.origin !== "backgroundResult") return undefined;
  const originMeta = header.originMeta;
  if (originMeta?.backgroundSource !== "workflow") return undefined;
  const notification = originMeta.workflowNotification;
  if (notification?.kind !== "terminal" || notification.status !== "completed") return undefined;
  const name = originMeta.title.trim();
  if (name.length === 0) return undefined;
  return {
    runId: originMeta.workId,
    name,
    ...(notification.durationMs === undefined ? {} : { durationMs: notification.durationMs }),
    artifacts: notification.artifacts ?? [],
    artifactsTruncated: notification.artifactsTruncated === true,
    summary: join.byRunId?.get(originMeta.workId),
  };
}
