// The workflow run line under sidebar task-row titles:
// Workflow glyph + mini rail lamps + current phase name. At a glance: this session runs a workflow and where it
// stands. Nothing else is drawn, no halo, no marching dashes, no question chip (the main agent answers
// escalations, not the user), no subagent count, no arrows; those live in the hover tooltip. A finished run
// reduces to one neutral word and color is reserved for lamps.
import { useEffect, useMemo, type MouseEvent } from "react";
import { Workflow } from "lucide-react";
import type {
  SessionWorkflowActivity,
  SessionWorkflowRunSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { isSessionWorkflowRunLive } from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  readWorkflowRunStopReason,
  workflowRunStopReasonMessageId,
} from "@/components/workflow-graph/run-status-presentation.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { getWorkflowRunAckStore, useWorkflowRunAcknowledged } from "@/lib/workflowRunAckStore.js";
import {
  foldWorkflowRunRail,
  selectWorkflowRunLines,
  settledWorkflowRunIds,
  workflowRunParallelPhaseLabel,
  type WorkflowRunRail,
} from "@/lib/workflowRunLine.js";
import { WorkflowRunRail as RunRail } from "@/components/workflow-run-line/WorkflowRunRail.js";
import { useWorkflowRunOpen } from "@/v4/workflowRunOpenContext.js";

export interface TaskWorkflowRunLinesIntl {
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
}

interface TaskWorkflowRunLinesProps {
  activity: SessionWorkflowActivity | undefined;
  /** Whether the session is being opened: when true, acknowledge all its finished runs (finished rows fold at once). */
  isActive: boolean;
  intl: TaskWorkflowRunLinesIntl;
  /** Session address needed to open the run pane on click; absent (mobile home) leaves the row a non-button. */
  session?: { workspacePath: string; workspaceIdentity?: string; sessionId: string };
  /** compact = the mobile remote-control row (24px, smaller type). */
  density?: "default" | "compact";
  className?: string;
}

const SEPARATOR = " · ";

function runStatusWord(run: SessionWorkflowRunSummary, intl: TaskWorkflowRunLinesIntl): string {
  return intl.formatMessage({ id: `chat.toolCall.workflow.run.status.${run.status}` });
}

/** Row word: running shows the current phase name (Workflow when the phase has no label); finished shows a neutral word (+ phase / reason). */
function runLineText(
  run: SessionWorkflowRunSummary,
  rail: WorkflowRunRail,
  intl: TaskWorkflowRunLinesIntl,
): string {
  if (isSessionWorkflowRunLive(run.status)) {
    // Parked on a hole: deciding groups, awaiting completion (docs/dynamic-workflow/presentation.md Holes on the timeline).
    if (run.waitingHole !== undefined) {
      return intl.formatMessage(
        { id: "taskList.workflowRun.holeWaiting" },
        { name: run.waitingHole },
      );
    }
    if (rail.implicit) {
      return intl.formatMessage({ id: "chat.toolCall.workflow.graph.phase.workflow" });
    }
    return run.currentPhase ?? runStatusWord(run, intl);
  }
  const word = runStatusWord(run, intl);
  if (run.status === "errored" && run.currentPhase !== undefined) {
    return `${word}${SEPARATOR}${run.currentPhase}`;
  }
  const reason = readWorkflowRunStopReason(run);
  if (reason !== undefined) {
    return `${word}${SEPARATOR}${intl.formatMessage({ id: workflowRunStopReasonMessageId(reason) })}`;
  }
  return word;
}

function runName(run: SessionWorkflowRunSummary, intl: TaskWorkflowRunLinesIntl): string {
  return run.name ?? intl.formatMessage({ id: "chat.toolCall.workflow.graph.phase.workflow" });
}

/** Tooltip second line: {phase} - {n agents working} - {elapsed}, missing segments omitted. */
function runTooltipDescription(
  run: SessionWorkflowRunSummary,
  intl: TaskWorkflowRunLinesIntl,
): string | undefined {
  const parts: string[] = [];
  // When parallel, current phase is no single site: simultaneously running sites list side by side, none more
  // current than the others.
  const parallel = workflowRunParallelPhaseLabel(run.phases);
  if (parallel !== undefined) parts.push(parallel);
  else if (run.currentPhase !== undefined) parts.push(run.currentPhase);
  if (isSessionWorkflowRunLive(run.status) && run.agentsWorking > 0) {
    parts.push(
      intl.formatMessage(
        { id: "chat.toolCall.workflow.card.agentsWorking" },
        { count: String(run.agentsWorking) },
      ),
    );
  }
  if (run.startedAt !== undefined) parts.push(formatTaskRelativeTime(run.startedAt, intl));
  return parts.length === 0 ? undefined : parts.join(SEPARATOR);
}

export function TaskWorkflowRunLines({
  activity,
  isActive,
  intl,
  session,
  density = "default",
  className,
}: TaskWorkflowRunLinesProps) {
  const isAcknowledged = useWorkflowRunAcknowledged();
  const openRun = useWorkflowRunOpen();
  const settledKey = settledWorkflowRunIds(activity).join(" ");
  // Opening a session acknowledges every run finished by now; while it stays open, runs finishing also
  // acknowledge immediately (folding before the reader's eyes).
  useEffect(() => {
    if (!isActive || settledKey.length === 0) return;
    getWorkflowRunAckStore().acknowledge(settledKey.split(" "));
  }, [isActive, settledKey]);
  const selection = useMemo(
    () => selectWorkflowRunLines(activity, isAcknowledged),
    [activity, isAcknowledged],
  );
  if (selection.lines.length === 0) return null;
  const interactive = openRun !== null && session !== undefined;
  const compact = density === "compact";

  return (
    <div
      data-workflow-run-lines="true"
      className={cn("flex min-w-0 max-w-full flex-col items-start", className)}
    >
      {selection.lines.map((run) => {
        const rail = foldWorkflowRunRail(run.phases);
        const text = runLineText(run, rail, intl);
        const name = runName(run, intl);
        const statusWord = runStatusWord(run, intl);
        const ariaLabel = intl.formatMessage(
          { id: "taskList.workflowRun.ariaLabel" },
          { name, status: statusWord },
        );
        const content = (
          <>
            <Workflow aria-hidden="true" className="size-3 shrink-0 text-foreground-subtle" />
            <RunRail rail={rail} intl={intl} />
            <span className="min-w-0 truncate">{text}</span>
          </>
        );
        const lineClassName = cn(
          "flex min-w-0 max-w-full items-center gap-1.5 rounded-md text-foreground-subtle",
          compact ? "h-6 text-ui-sm" : "h-5 text-ui-sm",
          interactive && "-ml-1 px-1 hover:bg-surface-hover hover:text-foreground",
        );
        const lineProps = {
          "data-workflow-run-line": "true",
          "data-run-id": run.runId,
          "data-run-status": run.status,
          className: lineClassName,
        };
        const line =
          interactive && session !== undefined && openRun !== null ? (
            <button
              type="button"
              {...lineProps}
              aria-label={ariaLabel}
              onClick={(event: MouseEvent<HTMLButtonElement>) => {
                // The row itself is clickable (select the session); the run line is the more specific target, so stop
                // the click from bubbling into a plain selection.
                event.preventDefault();
                event.stopPropagation();
                openRun({
                  workspacePath: session.workspacePath,
                  ...(session.workspaceIdentity
                    ? { workspaceIdentity: session.workspaceIdentity }
                    : {}),
                  sessionId: session.sessionId,
                  run,
                });
              }}
            >
              {content}
            </button>
          ) : (
            <span {...lineProps} aria-label={ariaLabel}>
              {content}
            </span>
          );
        const description = runTooltipDescription(run, intl);
        return (
          <ControlHintTooltip
            key={run.runId}
            title={`${name}${SEPARATOR}${statusWord}`}
            {...(description === undefined ? {} : { description })}
            side="right"
            align="center"
          >
            {line}
          </ControlHintTooltip>
        );
      })}
      {selection.overflow > 0 ? (
        <span
          data-workflow-run-overflow={String(selection.overflow)}
          className={cn("text-foreground-subtlest", compact ? "h-6 text-ui-sm" : "h-5 text-ui-xs")}
        >
          {intl.formatMessage(
            { id: "taskList.workflowRun.moreRuns" },
            { count: String(selection.overflow) },
          )}
        </span>
      ) : null}
    </div>
  );
}
