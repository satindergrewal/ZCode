// ============================================================
// Section subcomponents of WorkflowRunSidePane (status header / terminal-state results).
// ============================================================
// Split out of WorkflowRunSidePane.tsx (eslint max-lines 400 gate): the pane file keeps data assembly and
// interaction wiring; this file holds pure presentational sections. Props are fully cooked view values, no
// projection, lease or command-channel access.

import { workflowRunStopReasonMessageId } from "@/components/workflow-graph/run-status-presentation.js";
import { memo, type ReactNode } from "react";
import type { WorkflowRunSaveSlots } from "@/components/workflow-timeline/WorkflowRunSaveControls.js";
import {
  ArrowUpRightIcon,
  ListIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  SquareIcon,
} from "lucide-react";
import type { WorkflowRunState, WorkflowRunUsage } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { workflowRunResultView } from "@/app-shell/workflowRunPanel.js";
import { workflowRunConcurrencyChip } from "@/app-shell/workflowRunThrottle.js";
import { WorkflowRunStatus } from "@/components/workflow-timeline/WorkflowCardChrome.js";
import { RunHolesWaitingChip } from "@/components/workflow-timeline/WorkflowHoleParts.js";
import { WorkflowTruncatedNotice } from "@/components/workflow-timeline/WorkflowTruncatedNotice.js";
import { useNowTicker } from "@/components/workflow-graph/use-now-ticker.js";

const formatCount = (value: number): string => value.toLocaleString();

/**
 * The summary row's model span: when the run is configurable it is also a button (underline on hover) opening
 * the same Configure popover anchored to itself; otherwise plain text with a tooltip.
 */
function SubagentModelSegment({
  children,
  className,
  configureOpen,
  onConfigureFrom,
  title,
}: {
  children: ReactNode;
  className?: string;
  configureOpen: boolean;
  onConfigureFrom?: (element: HTMLElement) => void;
  title: string;
}) {
  if (onConfigureFrom === undefined) {
    return (
      <span className={className} data-testid="workflow-run-subagent-model" title={title}>
        {children}
      </span>
    );
  }
  return (
    <button
      aria-expanded={configureOpen}
      aria-haspopup="dialog"
      className={`${className ?? ""} cursor-pointer rounded-sm text-left underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/40`}
      data-testid="workflow-run-subagent-model"
      onClick={(event) => onConfigureFrom(event.currentTarget)}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}

/**
 * Status header: row one is name and actions (Configure, Resume, Stop); row two is lamp and status word plus
 * the concurrency chip, three buttons beside the status read as too crowded, so status stands alone. Below: the
 * lineage row and a summary line word-identical to the chat card footer, one run must speak identically on both
 * surfaces. Without summary material (no graph, no timeline) it falls back to the legacy usage line.
 */
export const WorkflowRunStatusHeader = memo(function WorkflowRunStatusHeader({
  cancellable,
  configureOpen = false,
  onCancel,
  onConfigureFrom,
  onOpenSuccessor,
  onResume,
  rejection,
  resumable,
  run,
  saveSlots,
  subagentModel,
  summaryParts,
  title,
  usage,
}: {
  cancellable: boolean;
  /** Whether the Configure popover is open (drives aria-expanded on the button and model span). */
  configureOpen?: boolean;
  onCancel: () => void;
  /**
   * Opens the Configure popover anchored to the clicked element. Absent = run not configurable: no
   * Configure button and the model span is plain text.
   */
  onConfigureFrom?: (element: HTMLElement) => void;
  /** Explanation of the last rejected Stop / Resume; detail is the diagnostics carried by the ACK. */
  rejection?: { text: string; detail?: string };
  /** Opens the successor that superseded this run (run.supersededBy); absent when the host cannot resolve it, the row is plain text. */
  onOpenSuccessor?: () => void;
  onResume: () => void;
  resumable: boolean;
  run: WorkflowRunState | undefined;
  /**
   * The saved chip and the save / run-again actions (docs/dynamic-workflow/transcript-and-notifications.md
   * Saving the run, and running it again). One run must speak identically on the completion card and here, so
   * both surfaces render the nodes built by the same controller; this component only places them: verbs before
   * Stop, chip on the second row. null/absent means no service context and no controls at all.
   */
  saveSlots?: WorkflowRunSaveSlots | null;
  /**
   * This run's subagent model: name is the on-screen word, title carries strength and the canonical id
   * (docs/dynamic-workflow/presentation.md The run pane). The header's first row no longer holds a model chip,
   the model is the second row's first word, opening both the summary line and the degenerate usage line.
   Absent = nothing to say.
   */
  subagentModel?: { name: string; title: string };
  /** Summary row spans (workflowSummaryParts); falls back to the usage line when absent. */
  summaryParts: readonly string[] | undefined;
  title: string;
  usage: WorkflowRunUsage | undefined;
}) {
  const { intl } = useZCodeIntl();
  const saveChip = saveSlots?.leading ?? null;
  const saveVerb = saveSlots?.trailing ?? null;
  const cancelLabel = intl.formatMessage({ id: "chat.toolCall.workflow.run.cancel" });
  const resumeLabel = intl.formatMessage({ id: "chat.toolCall.workflow.run.resume" });
  // Concurrency chip (docs/dynamic-workflow/concurrency.md What the user sees): present when the effective
  // bound (min of shared cap and this run's own) is pressed below the bound, or the run has its own bound, and
  // the run is configurable. Cooldown is a deadline, so with one active it ticks down and expires itself.
  const cooldownActive = run?.concurrency?.cooldownMs !== undefined;
  const now = useNowTicker(cooldownActive);
  const concurrency = workflowRunConcurrencyChip(run, now);
  // Lineage row (presentation.md The run pane, status header): a revised run says what it was revised from, a
  // superseded run points at its successor. The two are not exclusive (a revised run can be superseded too),
  // hence separate rows.
  const resumedFrom = run?.resumedFrom;
  const supersededBy = run?.supersededBy;

  return (
    <div className="shrink-0 border-b border-border px-4 py-3">
      <div className="flex items-center gap-2">
        {/* The run name is an identifier: monospace (DESIGN.md reserves font-mono for technical values). */}
        <span className="min-w-0 flex-1 truncate font-mono text-ui-base font-medium text-foreground">
          {title}
        </span>
        {/* Configure precedes Resume / Stop: opens the Configure popover anchored beneath this button. */}
        {onConfigureFrom === undefined ? null : (
          <Button
            aria-expanded={configureOpen}
            aria-haspopup="dialog"
            data-testid="workflow-run-configure"
            onClick={(event) => onConfigureFrom(event.currentTarget)}
            size="sm"
            type="button"
            variant="outline"
          >
            <SlidersHorizontalIcon className="size-3.5" />
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.configure" })}
          </Button>
        )}
        {/* Resume renders only when resumable (predicate in isWorkflowRunResumable): the button's existence is the capability gate. */}
        {resumable ? (
          <ControlHintTooltip
            title={intl.formatMessage({ id: "chat.toolCall.workflow.run.resumeHint" })}
            side="bottom"
          >
            <Button
              aria-label={resumeLabel}
              data-testid="workflow-run-resume"
              onClick={onResume}
              size="sm"
              type="button"
              variant="outline"
            >
              <RotateCcwIcon className="size-3.5" />
              {resumeLabel}
            </Button>
          </ControlHintTooltip>
        ) : null}
        {/* Save / run-again precede Stop: the completion card's order, keep it first, stop it last. */}
        {saveVerb}
        // Stop shares the card button's icon (solid square): one action, one face. When available
        the tooltip // carries a second line, paused runs can be resumed; since the verb renamed
        from cancel, say before the // press that this is not a discard. Unavailable, only the
        reason remains, no second line.
        <ControlHintTooltip
          title={
            cancellable
              ? cancelLabel
              : intl.formatMessage({ id: "chat.toolCall.workflow.run.cancelDisabled" })
          }
          side="bottom"
          {...(cancellable
            ? { description: intl.formatMessage({ id: "chat.toolCall.workflow.run.stopHint" }) }
            : {})}
        >
          <Button
            aria-label={cancelLabel}
            data-testid="workflow-run-cancel"
            disabled={!cancellable}
            onClick={onCancel}
            size="sm"
            type="button"
            variant="outline"
          >
            <SquareIcon className="size-3.5 fill-current" />
            {cancelLabel}
          </Button>
        </ControlHintTooltip>
      </div>
      {/* Row two: lamp and status word plus concurrency chip. Without the projected run none exist and the row is absent. */}
      {run === undefined && concurrency === undefined && saveChip === null ? null : (
        <div
          className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2"
          data-testid="workflow-run-status-row"
        >
          {run ? <WorkflowRunStatus run={run} testId="workflow-run-status" /> : null}
          {/* N holes awaiting completion (docs/dynamic-workflow/presentation.md Holes on the timeline): the card's own chip. */}
          <RunHolesWaitingChip run={run} testId="workflow-run-holes" />
          {/* The chip trails the status word: row one is full and it is not an action anyway. */}
          {saveChip}
          {/* Max concurrency 4: how many subagents this run may fly at once, the governor pressing the shared
            bucket under this run's bound, or the user's own cap for this run (above or below default). Why the
            run is fast or slow, visible at a glance. Absent entirely when riding the default or the run can no
            longer be configured (completed / superseded).
            Same shape as the status badge (border+text) in active color: the runtime tuning itself, not a fault. */}
          {concurrency === undefined ? null : (
            <span
              className="shrink-0 rounded-xs border border-warning/60 px-1.5 py-0.5 font-mono text-ui-xs leading-none text-warning"
              data-testid="workflow-run-concurrency"
            >
              {intl.formatMessage(
                { id: "chat.toolCall.workflow.run.concurrency.label" },
                { cap: String(concurrency.cap) },
              )}
              {concurrency.cooldownUntil === undefined
                ? null
                : ` · ${intl.formatMessage(
                    { id: "chat.toolCall.workflow.run.concurrency.cooldown" },
                    { time: new Date(concurrency.cooldownUntil).toLocaleTimeString() },
                  )}`}
            </span>
          )}
        </div>
      )}

      {/* Rejected Stop / Resume: one line plus optional diagnostics. warning not destructive: nothing happened, nothing broke. */}
      {rejection === undefined ? null : (
        <div
          className="mt-1.5 text-ui-xs text-warning"
          data-testid="workflow-run-rejection"
          role="status"
        >
          <span>{rejection.text}</span>
          {rejection.detail === undefined ? null : (
            <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap font-mono text-ui-xs text-foreground-subtle">
              {rejection.detail}
            </pre>
          )}
        </div>
      )}

      {resumedFrom === undefined ? null : (
        <div
          className="mt-1.5 flex min-w-0 items-baseline gap-2 text-ui-xs text-foreground-subtlest"
          data-testid="workflow-run-amends"
        >
          <span className="shrink-0">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.amends" })}
          </span>
          <span className="min-w-0 truncate font-mono" title={resumedFrom}>
            {resumedFrom}
          </span>
        </div>
      )}
      {supersededBy === undefined ? null : onOpenSuccessor === undefined ? (
        <div
          className="mt-1.5 flex min-w-0 items-baseline gap-2 text-ui-xs text-foreground-subtlest"
          data-testid="workflow-run-superseded-by"
        >
          <span className="shrink-0">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.supersededBy" })}
          </span>
          <span className="min-w-0 truncate font-mono" title={supersededBy}>
            {supersededBy}
          </span>
        </div>
      ) : (
        <button
          className="mt-1.5 flex min-w-0 cursor-pointer items-baseline gap-2 rounded-md text-left text-ui-xs text-foreground-subtle outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          data-testid="workflow-run-superseded-by"
          onClick={onOpenSuccessor}
          type="button"
        >
          <span className="shrink-0">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.supersededBy" })}
          </span>
          <span className="min-w-0 truncate font-mono" title={supersededBy}>
            {supersededBy}
          </span>
          <ArrowUpRightIcon aria-hidden className="size-3 shrink-0 self-center" />
        </button>
      )}

      {summaryParts !== undefined ? (
        <div
          className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm text-foreground-subtle"
          data-testid="workflow-run-usage"
        >
          <ListIcon aria-hidden className="size-3.5 shrink-0 text-foreground-subtlest" />
          {summaryParts.map((part, i) => (
            <span className="flex items-center gap-x-2 tabular-nums" key={i}>
              {i > 0 ? (
                <span aria-hidden className="text-foreground-subtlest">
                  ·
                </span>
              ) : null}
              {i === 0 && subagentModel !== undefined ? (
                <SubagentModelSegment
                  configureOpen={configureOpen}
                  title={subagentModel.title}
                  {...(onConfigureFrom === undefined ? {} : { onConfigureFrom })}
                >
                  {part}
                </SubagentModelSegment>
              ) : (
                <span>{part}</span>
              )}
            </span>
          ))}
        </div>
      ) : usage ? (
        // Usage is an observation surface with no cap to divide by: one line, usage N tokens M steps, no progress track.
        <div
          className="mt-2 flex items-baseline justify-between gap-2"
          data-testid="workflow-run-usage"
        >
          {/* Without a graph the summary row disappears whole, but the model must not vanish with it: it is the
              constraint the user set for this run, graph or no graph. So it leads here too, same word, same tooltip. */}
          <span className="flex min-w-0 items-baseline gap-2">
            {subagentModel === undefined ? null : (
              <SubagentModelSegment
                className="min-w-0 truncate text-ui-xs text-foreground-subtle"
                configureOpen={configureOpen}
                title={subagentModel.title}
                {...(onConfigureFrom === undefined ? {} : { onConfigureFrom })}
              >
                {intl.formatMessage(
                  { id: "chat.toolCall.workflow.run.subagentModel.label" },
                  { model: subagentModel.name },
                )}
              </SubagentModelSegment>
            )}
            <span className="shrink-0 text-ui-xs text-foreground-subtle">
              {intl.formatMessage({ id: "chat.toolCall.workflow.run.usage.label" })}
            </span>
          </span>
          <span className="font-mono text-ui-xs tabular-nums text-foreground">
            {intl.formatMessage(
              { id: "chat.toolCall.workflow.run.usage.value" },
              { tokens: formatCount(usage.spentTokens), steps: usage.nodesUsed },
            )}
          </span>
        </div>
      ) : null}
      {/* The showing-n-of-m note under the summary row, same implementation as the card: the spine lists what
          the instance table retained while the row's counts already included the rest, this line is exactly that
          difference. */}
      <WorkflowTruncatedNotice className="mt-1.5" run={run} testId="workflow-run-truncated" />
    </div>
  );
});

/** Terminal area: untracked note / completed-artifact preview / failed-and-cancelled error panel. Each appears only in its matching terminal state. */
export const WorkflowRunResultSections = memo(function WorkflowRunResultSections({
  result,
}: {
  result: ReturnType<typeof workflowRunResultView>;
}) {
  const { intl } = useZCodeIntl();

  return (
    <>
      {/* Run absent from the projection: pre-eviction or pre-cold-start CLI. Wording says live state is gone, never that the run is. */}
      {result.kind === "absent" ? (
        <div
          className="shrink-0 border-b border-border px-4 py-3"
          data-testid="workflow-run-untracked"
        >
          <div className="text-ui-base text-foreground">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.untracked.title" })}
          </div>
          <p className="mt-1 text-ui-xs text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.untracked.body" })}
          </p>
        </div>
      ) : null}

      {/* Result / failure panels */}
      {result.kind === "completed" ? (
        <div
          className="shrink-0 border-b border-border px-4 py-3"
          data-testid="workflow-run-result"
        >
          <div className="text-ui-xs font-medium text-foreground-subtle">
            {intl.formatMessage({ id: "chat.toolCall.workflow.run.result.title" })}
          </div>
          {result.preview === undefined ? (
            <p className="mt-1 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "chat.toolCall.workflow.run.result.completedHint" })}
            </p>
          ) : (
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-ui-xs text-foreground">
              {result.preview}
            </pre>
          )}
        </div>
      ) : null}

      {result.kind === "error" ? (
        <div
          className="shrink-0 border-b border-destructive/40 px-4 py-3"
          data-testid="workflow-run-error"
        >
          <div className="text-ui-xs font-medium text-destructive">
            {intl.formatMessage({
              id:
                result.status === "stopped"
                  ? "chat.toolCall.workflow.run.result.stoppedTitle"
                  : "chat.toolCall.workflow.run.result.erroredTitle",
            })}
            {result.status === "stopped" && result.stopReason ? (
              <span
                className="font-normal text-foreground-subtle"
                data-testid="workflow-run-stop-reason"
              >
                {" · "}
                {intl.formatMessage({ id: workflowRunStopReasonMessageId(result.stopReason) })}
              </span>
            ) : null}
          </div>
          {/*
            The projection writes WorkflowErrorJson.message into error; product-projection.ts's run-settled
            branch keeps only .message (code dropped) and the engine's messages are human short sentences:
            run cancelled, typed ask ended without a result, node count over the 100 cap. Hence body
            typography, not a mono code block (DESIGN.md reserves font-mono for paths/commands/code/
            identifiers/terminal data). pre-wrap stays so newlines in message survive.
            No code is available here and the pane has no second home for it: the event-log section is gone
            (2026-09-04, per user note in docs/dynamic-workflow/presentation.md); the structured payload
            lives in the journal, its readers models and CLIs, not the human at this pane.
          */}
          <p
            className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words text-ui-base text-foreground"
            data-testid="workflow-run-error-message"
          >
            {result.message ??
              intl.formatMessage({ id: "chat.toolCall.workflow.run.result.noError" })}
          </p>
        </div>
      ) : null}
    </>
  );
});
