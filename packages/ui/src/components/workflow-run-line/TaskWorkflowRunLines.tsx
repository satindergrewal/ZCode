// The workflow run line under a sidebar task row's title:
// Workflow glyph + mini track lights + current phase name — enough to see that this
// session runs a workflow and where it stands. Nothing else: no halo, no marching dash,
// no question chips (escalations are answered by the main agent), no agent counts, no
// arrow — those live in the hover tooltip. A finished run is one neutral word; color is
// reserved for the lights.
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
  STATUS_DOT,
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
import { useWorkflowRunOpen } from "@/v4/workflowRunOpenContext.js";

export interface TaskWorkflowRunLinesIntl {
  formatMessage: (desc: { id: string }, values?: Record<string, string>) => string;
}

interface TaskWorkflowRunLinesProps {
  activity: SessionWorkflowActivity | undefined;
  /** Whether the session is being opened: when true, acknowledge its finished runs (their rows collapse at once). */
  isActive: boolean;
  intl: TaskWorkflowRunLinesIntl;
  /** Session address needed to open the run pane on click; without it (phone home) the row is not a button. */
  session?: { workspacePath: string; workspaceIdentity?: string; sessionId: string };
  /** compact = the phone-remote row (24px, smaller type). */
  density?: "default" | "compact";
  className?: string;
}

const TRACE_FAINT = "var(--color-workflow-trace)";
const TRACE_STRONG = "var(--color-workflow-trace-strong)";
const SEPARATOR = " · ";

function RunRail({ rail, intl }: { rail: WorkflowRunRail; intl: TaskWorkflowRunLinesIntl }) {
  if (rail.implicit) {
    return (
      <span
        data-workflow-run-rail="true"
        data-implicit="true"
        className="flex shrink-0 items-center"
      >
        <span aria-hidden="true" className={cn("size-1.5 rounded-full", STATUS_DOT.running)} />
      </span>
    );
  }
  return (
    <span data-workflow-run-rail="true" className="flex shrink-0 items-center">
      {rail.stations.map((station, index) => (
        <span key={`${station.name}:${index}`} className="flex items-center">
          {index > 0 ? (
            station.twin === true ? (
              // Twin segment: this station runs parallel to the previous one — control flow
              // never traveled here. Two 1px lines 2px apart (4px container, one hugging each
              // edge); width and ink rules match a plain segment exactly.
              <span
                aria-hidden="true"
                data-rail-segment={station.reached ? "strong" : "faint"}
                data-rail-twin="true"
                className="flex h-1 w-1.5 flex-col justify-between"
              >
                <span
                  className="h-px w-full"
                  style={{ backgroundColor: station.reached ? TRACE_STRONG : TRACE_FAINT }}
                />
                <span
                  className="h-px w-full"
                  style={{ backgroundColor: station.reached ? TRACE_STRONG : TRACE_FAINT }}
                />
              </span>
            ) : (
              <span
                aria-hidden="true"
                data-rail-segment={station.reached ? "strong" : "faint"}
                className="h-px w-1.5"
                style={{ backgroundColor: station.reached ? TRACE_STRONG : TRACE_FAINT }}
              />
            )
          ) : null}
          <span
            aria-hidden="true"
            data-rail-station={station.status}
            title={station.name}
            className={cn("size-1.5 rounded-full", STATUS_DOT[station.status])}
          />
        </span>
      ))}
      {rail.hidden > 0 ? (
        <span className="ml-1 text-ui-xs leading-none text-foreground-subtlest">
          {intl.formatMessage(
            { id: "taskList.workflowRun.moreStations" },
            { count: String(rail.hidden) },
          )}
        </span>
      ) : null}
    </span>
  );
}

function runStatusWord(run: SessionWorkflowRunSummary, intl: TaskWorkflowRunLinesIntl): string {
  return intl.formatMessage({ id: `chat.toolCall.workflow.run.status.${run.status}` });
}

/** The row's word: running -> current phase name (no phase vocabulary -> "Workflow"); finished -> neutral word (+ phase / reason). */
function runLineText(
  run: SessionWorkflowRunSummary,
  rail: WorkflowRunRail,
  intl: TaskWorkflowRunLinesIntl,
): string {
  if (isSessionWorkflowRunLive(run.status)) {
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

/** Tooltip's second line: `{phase} - {n agents working} - {elapsed}`; missing segments drop. */
function runTooltipDescription(
  run: SessionWorkflowRunSummary,
  intl: TaskWorkflowRunLinesIntl,
): string | undefined {
  const parts: string[] = [];
  // When parallel, no single station is current: the concurrently running ones are listed
  // as peers, none more current than another.
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
  // Opening a session acknowledges every run finished at that moment; while it stays open,
  // runs finishing later are acknowledged too (collapsing before the reader's eyes).
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
                // The row itself is also clickable (selects the session); the run line is the
                // more specific target, so stop the click from bubbling into a plain select.
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
