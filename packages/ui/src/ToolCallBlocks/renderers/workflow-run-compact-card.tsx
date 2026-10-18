import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import {
  RUN_STATUS_DOT,
  RUN_STATUS_TEXT,
} from "@/components/workflow-graph/run-status-presentation.js";
import type { WorkflowRunCardSummary } from "@/ToolCallBlocks/shared.js";

function isInteractiveDescendant(target: EventTarget | null, card: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  const interactive = target.closest("button, a, input, textarea, select, [role='button']");
  // The card itself carries role=button, so closest matches the card from anywhere inside
  // it and "click card to open details" never runs (the plan card's original bug). Intercept
  // real child controls only.
  return interactive !== null && interactive !== card;
}

/**
 * Compact clickable card for a workflow run — the "third run state" shared by the
 * CreateWorkflow and ResumeWorkflowRun tool cards.
 *
 * The whole card is the entry point (DESIGN.md semantic colors plus the existing run-status
 * vocabulary): the measured discoverability failure came from the entry once being buried in
 * the expanded card body. The two callers differ only in labelText/primaryText (create: the
 * workflow name; resume: the runId); the status word and step count are live from the join
 * summary.
 *
 * A missing `onOpen` is presentational only: no role/tabIndex/hover — the host injects the
 * callback only when a run is actually openable (the gating semantic of
 * `ToolCallBlockRenderContext.onOpenWorkflowRun`).
 */
export function WorkflowRunCompactCard({
  ariaLabel,
  icon,
  labelText,
  primaryText,
  primaryTitle,
  workflowRun,
  statusLabel,
  stepsLabel,
  onOpen,
  showIcon,
  children,
}: {
  ariaLabel: string;
  icon: ReactNode;
  labelText: string;
  primaryText: string;
  primaryTitle?: string;
  workflowRun: WorkflowRunCardSummary;
  statusLabel: string;
  stepsLabel: string;
  onOpen: (() => void) | undefined;
  showIcon: boolean;
  /** Additional content below the card (e.g. ToolSnapshotFieldNotice), rendered with it. */
  children?: ReactNode;
}) {
  // Whole-card click / Enter / Space — verbatim the switch-mode.tsx plan-card idiom,
  // guards included: the card itself carries role=button so the check must exclude the card
  // itself, or "click card to open details" never runs; and child keydowns bubble to the
  // card, opening details twice per keypress.
  const handleCardClick = (event: MouseEvent<HTMLElement>) => {
    if (!onOpen) return;
    if (!isInteractiveDescendant(event.target, event.currentTarget)) onOpen();
  };
  const handleCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!onOpen) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    if (isInteractiveDescendant(event.target, event.currentTarget)) return;
    event.preventDefault();
    onOpen();
  };

  return (
    <>
      <section
        aria-label={ariaLabel}
        className={cn(
          "flex w-full min-w-0 items-center gap-2 overflow-hidden rounded-xl border border-card-border bg-card px-3 py-2.5 text-foreground shadow-xs outline-none transition-colors",
          onOpen
            ? "hover:border-border-hover focus-visible:border-input-border-focused focus-visible:ring-2 focus-visible:ring-ring/40"
            : undefined,
        )}
        data-testid="workflow-run-card"
        data-workflow-run-id={workflowRun.runId}
        data-workflow-run-status={workflowRun.status}
        onClick={handleCardClick}
        onKeyDown={handleCardKeyDown}
        role={onOpen ? "button" : undefined}
        tabIndex={onOpen ? 0 : undefined}
      >
        {showIcon ? icon : null}
        <span className="shrink-0 text-ui-base font-medium text-foreground-subtle">
          {labelText}
        </span>
        {/* The workflow name is a UI title: default font, so it does not read as monospaced code. */}
        <span
          className="min-w-0 flex-1 truncate text-ui-base text-foreground-subtlest"
          title={primaryTitle ?? primaryText}
        >
          {primaryText}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {/* The status word always sits beside the dot: status is never color- or animation-only. */}
          <span
            aria-hidden="true"
            className={cn("size-1.5 shrink-0 rounded-full", RUN_STATUS_DOT[workflowRun.status])}
          />
          <span className={cn("text-ui-sm", RUN_STATUS_TEXT[workflowRun.status])}>
            {statusLabel}
          </span>
        </span>
        {/* The step count is "settled of scheduled", never a total percentage — dynamic workflows have no static total. */}
        <span className="shrink-0 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
          {stepsLabel}
        </span>
      </section>
      {children}
    </>
  );
}
