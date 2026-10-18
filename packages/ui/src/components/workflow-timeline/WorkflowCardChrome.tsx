import type { ReactNode } from "react";
import { ChevronRightIcon, ListIcon, Maximize2Icon, Workflow } from "lucide-react";
import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import {
  RUN_STATUS_DOT,
  RUN_STATUS_TEXT,
  STATUS_DOT,
  readWorkflowRunStopReason,
  workflowRunStopReasonMessageId,
  isWorkflowRunSuperseded,
} from "@/components/workflow-graph/run-status-presentation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * The workflow card's header and footer.
 *
 * Not `ToolLayout`: its summary row is `inline-flex self-start` and cannot hold a right-aligned status cluster. One header row:
 * icon + kind word + name, and on the right lamp + status word + monospace detail + [⤢] + chevron. Past one station column there is no rank band:
 * unseen stations live on the timeline's own edge gutter.
 */
export const WORKFLOW_CARD_ICON = <Workflow className="size-4 shrink-0 text-foreground-subtle" />;

/** Kind word once joined to a run: the same run must be called the same name on the card, in the run-tail summary, in notifications and on the detail page. */
export const WORKFLOW_RUN_KIND_ID: Record<WorkflowRunState["status"], string> = {
  pending: "chat.toolCall.workflow.card.started",
  running: "chat.toolCall.workflow.card.running",
  completed: "chat.toolCall.workflow.card.completed",
  errored: "chat.toolCall.workflow.card.errored",
  stopped: "chat.toolCall.workflow.card.stopped",
};
/**
 * Neutral kind word when the run is not in the live projection (evicted by the eight-entry cap / cold restore with no journal hit): the card only says "a run was here",
 * without impersonating a terminal state.
 */
export const WORKFLOW_RUN_ENDED_KIND_ID = "chat.toolCall.workflow.card.ended";

/** Kind word for a run superseded by a revision. */
export const WORKFLOW_RUN_SUPERSEDED_KIND_ID = "chat.toolCall.workflow.card.superseded";

/**
 * The single entry point for kind words: stopped ∧ superseded says "superseded", the rest lookup by status. All three consumers (card, run-tail summary,
 * legacy host run card) go through here, or the same superseded run would be "stopped" in one place and "superseded" in another.
 */
export function workflowRunKindMessageId(run: {
  status: WorkflowRunState["status"];
  stopReason?: unknown;
}): string {
  return isWorkflowRunSuperseded(run)
    ? WORKFLOW_RUN_SUPERSEDED_KIND_ID
    : WORKFLOW_RUN_KIND_ID[run.status];
}

/** Run-level status: lamp + word, always as a pair (invariant 3). */
export function WorkflowRunStatus({
  className,
  status,
  run,
  testId,
}: {
  //** Falls back to `run.status` when absent (at least one of the two is given). */
  status?: WorkflowRunState["status"];
  /**
   * Source object carrying `stopReason` (projection run / joined summary): when `stopped`, the reason word follows the status word.
   * Read structurally, not bound to one protocol type.
   *
   * `resumable` is a **status bit** riding with the run from the CLI;
   * when present and true, one more word is appended after the reason word. The UI never derives it from status — "stopped" does not imply resumable.
   */
  run?:
    | { status: WorkflowRunState["status"]; stopReason?: unknown; resumable?: unknown }
    | undefined;
  className?: string;
  testId?: string;
}) {
  const { intl } = useZCodeIntl();
  const effectiveStatus = status ?? run?.status ?? "pending";
  const reason =
    run === undefined ? undefined : readWorkflowRunStopReason({ ...run, status: effectiveStatus });
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5", className)}>
      <span
        aria-hidden
        className={cn("wf-lamp size-2 shrink-0 rounded-full", RUN_STATUS_DOT[effectiveStatus])}
      />
      {/* Status word swaps by value: the old word exits, the new enters. */}
      <span
        className={cn("wf-swap text-ui-sm", RUN_STATUS_TEXT[effectiveStatus])}
        data-testid={testId}
        key={effectiveStatus}
      >
        {intl.formatMessage({ id: `chat.toolCall.workflow.run.status.${effectiveStatus}` })}
      </span>
      {reason ? (
        <span
          className="text-ui-sm text-foreground-subtlest"
          data-testid={testId ? `${testId}-reason` : undefined}
        >
          · {intl.formatMessage({ id: workflowRunStopReasonMessageId(reason) })}
        </span>
      ) : null}
      {/* The third word: this run can continue. "Stopped" names the action, not the consequence — putting the consequence back
          on the status line means the user need not open the detail page to learn they lost nothing. */}
      {run?.resumable === true ? (
        <span
          className="text-ui-sm text-foreground-subtlest"
          data-testid={testId ? `${testId}-resumable` : undefined}
        >
          · {intl.formatMessage({ id: "chat.toolCall.workflow.run.resumable" })}
        </span>
      ) : null}
    </span>
  );
}

/** Static (run not yet joined) status: ring-only lamp + one word ("compiled"). */
export function WorkflowStaticStatus({ word }: { word: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", STATUS_DOT.pending)} />
      <span className="text-ui-sm text-foreground-subtle" data-testid="workflow-card-static-status">
        {word}
      </span>
    </span>
  );
}

export function WorkflowCardHeader({
  detail,
  detailTitle,
  expanded,
  kind,
  leading,
  live = false,
  name,
  onOpenDetails,
  onToggle,
  status,
  toggleLabel: toggleLabelOverride,
  trailing,
}: {
  //** Kind word; when a string, swaps by copy (re-keying remounts, playing wf-swap). */
  kind: ReactNode;
  name: string;
  //** Running kind-word shimmer (same expression as ToolLayout's isRunning). */
  live?: boolean;
  status?: ReactNode;
  detail?: string;
  //** Tooltip for the detail string; only when a subagent model is present (strength and canonical string live here). */
  detailTitle?: string;
  //** Slot before the status (the run-tail summary's pending-question chip). */
  leading?: ReactNode;
  //** Slot after detail, before ⤢ (the run-tail summary puts Resume in the header). */
  trailing?: ReactNode;
  onOpenDetails?: () => void;
  expanded: boolean;
  //** Absent = not collapsible (forceOpen / canToggle=false). */
  onToggle?: () => void;
  //** Accessible name of the chevron; defaults to the tool card's "expand / collapse tool details". */
  toggleLabel?: string;
}) {
  const { intl } = useZCodeIntl();
  const openLabel = intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" });
  const toggleLabel =
    toggleLabelOverride ??
    intl.formatMessage({
      id: expanded ? "chat.toolCall.collapseDetails" : "chat.toolCall.expandDetails",
    });
  return (
    <div
      className="flex min-w-0 items-center gap-2 text-ui-base"
      data-testid="workflow-card-header"
    >
      {WORKFLOW_CARD_ICON}
      {/* The kind word swaps by copy (key=copy; old word exits, new enters). The swap's wf-swap must wrap outside the shimmer's
          animated-gradient-text: background-clip:text only clips its own layer's text;
          once a child is promoted to its own layer by a transform/opacity animation, the glyphs turn transparent — the header shows a blank stretch. */}
      <span className="shrink-0 whitespace-nowrap font-medium" data-testid="workflow-card-kind">
        <span className="wf-swap" key={typeof kind === "string" ? kind : undefined}>
          <span className={live ? "animated-gradient-text" : "text-foreground"}>{kind}</span>
        </span>
      </span>
      <span
        // The name is UI text; card headers shared by tool summaries and statuses like cancel all pass through the same fixup.
        className="min-w-0 flex-1 truncate text-foreground-subtle"
        data-testid="workflow-card-name"
        title={name}
      >
        {name}
      </span>
      {/* The right cluster is compressible; only the detail string yields: chips, status and buttons are shrink-0 (Button base class),
          detail gets min-w-0 + truncate, so all negative space lands on it and Configure / Stop / ⤢ stay inside the card.
          The cluster's min-w-0 is required, do not delete it as redundant: a flex item's automatic minimum size is
          min-content, and truncate's white-space:nowrap makes the detail's min-content the full string width —
          neither overflow:hidden nor a child's min-w-0 shrinks it. Without the cluster's min-w-0 the cluster's floor
          is "whole detail + buttons": it will not shrink a pixel and still pushes buttons out of the card (this fix's origin).
          Measured in the browser (card width stepped down): before the fix buttons overflowed from 520px; after, zero overflow above 290px,
          380px with a pending-question chip — the chip is shrink-0 too and raises the floor. */}
      <span className="flex min-w-0 items-center gap-2">
        {leading}
        {status}
        {detail === undefined || detail.length === 0 ? null : (
          <span
            className="min-w-0 truncate text-ui-base tabular-nums text-foreground-subtlest"
            data-testid="workflow-card-detail"
            {...(detailTitle === undefined ? {} : { title: detailTitle })}
          >
            {detail}
          </span>
        )}
        {trailing}
        {onOpenDetails === undefined ? null : (
          <ControlHintTooltip title={openLabel} side="top">
            <Button
              aria-label={openLabel}
              data-testid="workflow-card-open-details"
              onClick={onOpenDetails}
              size="icon-md"
              type="button"
              variant="ghost"
            >
              <Maximize2Icon className="size-3.5" />
            </Button>
          </ControlHintTooltip>
        )}
        {onToggle === undefined ? null : (
          <Button
            aria-expanded={expanded}
            aria-label={toggleLabel}
            data-testid="workflow-card-toggle"
            onClick={onToggle}
            size="icon-md"
            type="button"
            variant="ghost"
          >
            <ChevronRightIcon
              className={cn("size-4 transition-transform", expanded && "rotate-90")}
            />
          </Button>
        )}
      </span>
    </div>
  );
}

/** Footer summary row: lamp + status word + list icon, segments joined by `·`, trailing controls (failed-state Resume). */
export function WorkflowCardFooter({
  parts = [],
  status,
  trailing,
}: {
  status: WorkflowRunState["status"];
  //** Summary segments; when absent or empty, only lamp, status word and trailing render. */
  parts?: readonly string[];
  trailing?: ReactNode;
}) {
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-sm text-foreground-subtle"
      data-testid="workflow-card-footer"
    >
      <WorkflowRunStatus status={status} />
      {parts.length > 0 ? (
        <>
          <ListIcon aria-hidden className="size-3.5 shrink-0 text-foreground-subtlest" />
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 tabular-nums">
            {parts.map((part, i) => (
              <span className="flex items-center gap-x-2" key={i}>
                {i > 0 ? (
                  <span aria-hidden className="text-foreground-subtlest">
                    ·
                  </span>
                ) : null}
                <span>{part}</span>
              </span>
            ))}
          </span>
        </>
      ) : null}
      {trailing}
    </div>
  );
}
