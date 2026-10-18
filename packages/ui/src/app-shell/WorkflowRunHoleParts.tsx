import { PenIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import type { TimelineFill, TimelineHole } from "@/components/workflow-timeline/timeline-holes.js";
import { workflowRunQuestionWaitedLabel } from "@/app-shell/workflowRunQuestions.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * The hole parts of the side pane spine (docs/dynamic-workflow/presentation.md "Holes on the timeline",
 * section "The pane"). Split out of WorkflowRunPhaseList.tsx (max-lines gate).
 *
 * - Hole section header: dashed lamp (warning outline + steady 3px halo while waiting) on the main rail;
 *   once filled, a pen mark follows the name.
 * - Waiting hole body: how long, plus waiting-for-main-agent. The full prompt is not in the projection
 *   (it travels with the notification) and is not repeated here.
 * - Completion with phases: a 24px heading row stands before the first section it wrote, pen (14px,
 *   background covering the rail) at the lamp position, then the name. Completion sections are NOT indented
 *   (user revision 2026-09-29: nesting is expressed by frames enclosing frames); the heading is this completion's
 *   frame anchor, pointer/focus on it draws the frame (WorkflowRunFillFrames.tsx).
 */

export function SpineHoleLamp({
  hole,
  pitch,
  track = 0,
}: {
  hole: TimelineHole;
  pitch: number;
  track?: number;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "wf-lamp absolute left-4 top-[13px] size-2.5 rounded-full border-[1.5px] border-dashed bg-background",
        hole.state === "waiting"
          ? "wf-lamp-hole-waiting border-warning"
          : "border-foreground-subtlest",
      )}
      data-lamp={`hole-${hole.state}`}
      data-testid="workflow-run-phase-lamp"
      style={track === 0 ? undefined : { left: 16 + pitch * track }}
    />
  );
}

/** Waiting hole body (docs/dynamic-workflow/presentation.md "The pane"): elapsed time + waiting-for-main-agent + the prompt the main agent received. */
export function HoleWaitingBody({ hole, now }: { hole: TimelineHole; now: number }) {
  const { intl } = useZCodeIntl();
  const waited = workflowRunQuestionWaitedLabel(hole.since, now, (descriptor, values) =>
    intl.formatMessage(descriptor, values),
  );
  return (
    <div
      className="flex flex-col gap-1 pb-3 pr-3 text-ui-sm text-foreground-subtle"
      data-testid="workflow-run-hole-waiting"
    >
      <span className="text-warning">
        {intl.formatMessage({ id: "chat.toolCall.workflow.run.hole.waitingFor" })}
        {waited === undefined ? null : ` · ${waited}`}
      </span>
      {hole.prompt === undefined ? null : (
        <p
          className="whitespace-pre-wrap break-words text-foreground"
          data-testid="workflow-run-hole-prompt"
        >
          {hole.prompt}
        </p>
      )}
    </div>
  );
}

/**
 * The completion's heading row: stands before the first section it wrote. The main rail crosses the row
 * top to bottom, the pen caps the rail (its background masks that stretch). It is the frame's legend: pen
 * and name carry the background and the frame's top edge passes behind them. Hover changes text color only,
 * no fill (a fill would turn the name's background into a patch). Clicking it follows the section-header path
 * (expand/anchor owned by the list); the tooltip matches the card header's line.
 */
export function FillHeadingRow({
  fill,
  fresh = false,
  on = false,
  onSelect,
  textColumn,
}: {
  fill: TimelineFill;
  textColumn: { paddingLeft: number } | undefined;
  /** Its frame is currently drawn. */
  on?: boolean;
  /** Two seconds after a completion lands: pen and name tint warning. */
  fresh?: boolean;
  onSelect?: () => void;
}) {
  const { intl } = useZCodeIntl();
  const time =
    fill.filledAt === undefined ? undefined : new Date(fill.filledAt).toLocaleTimeString();
  const title = intl.formatMessage(
    {
      id:
        time === undefined
          ? "chat.toolCall.workflow.hole.head.title.untimed"
          : "chat.toolCall.workflow.hole.head.title",
    },
    { name: fill.name, time: time ?? "" },
  );
  const body = (
    <>
      <span
        aria-hidden
        className="absolute left-[14px] top-[5px] grid size-3.5 place-items-center bg-background"
      >
        <PenIcon className="size-3.5" />
      </span>
      <span className="min-w-0 truncate bg-background pr-1.5 text-ui-sm font-medium">
        {fill.name}
      </span>
    </>
  );
  const className = cn(
    "wf-fill-head relative flex h-6 w-full items-center gap-1.5 pl-[39px] pr-3 text-left outline-none",
    fresh ? "text-warning" : on ? "text-foreground" : "text-foreground-subtle",
  );
  const shared = {
    className,
    "data-fill-head": fill.holeId,
    "data-fill-heading": fill.holeId,
    "data-fill-on": on ? "true" : undefined,
    "data-testid": "workflow-run-fill-heading",
    style: textColumn,
    title,
  };
  return onSelect === undefined ? (
    <div {...shared}>{body}</div>
  ) : (
    <button
      {...shared}
      aria-label={intl.formatMessage(
        { id: "chat.toolCall.workflow.hole.open" },
        { name: fill.name },
      )}
      className={cn(
        className,
        "cursor-pointer hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40",
      )}
      onClick={onSelect}
      type="button"
    >
      {body}
    </button>
  );
}
