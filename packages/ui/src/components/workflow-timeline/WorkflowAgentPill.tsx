import type { CSSProperties, ReactNode } from "react";
import {
  ArrowUpRightIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  CircleXIcon,
  LoaderCircleIcon,
  TerminalIcon,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { LaneClass, StepRunStatus } from "@/components/workflow-graph/types.js";
import { WorkflowAgentFace, agentColor } from "@/components/workflow-timeline/WorkflowAgentFace.js";

export { agentColor, avatarColor } from "@/components/workflow-timeline/WorkflowAgentFace.js";

/**
 * Subagent pill: tinted avatar +
 * name + status mark on the right. Both the card's station row and the sidebar's row — one feature, one pill.
 *
 * The avatar is a tile face (`WorkflowAgentFace`): body color from the nine-hue ring by agent number, expression from status.
 * The workspace has no identity, hence no color, just the terminal glyph. `pending` is pixel-identical to no-status (invariant 3):
 * no mark, name in the fainter color, face asleep.
 *
 * When openable (`open` present) the whole pill is a button: hover lands four things at once (surface up one step, hue-tinted
 * inner border, avatar larger and deeper, ↗ replacing the status mark in the tail slot); one click opens that subagent's transcript. A pill that cannot
 * be opened has no hover state; `inertTitle` says why.
 *
 * The tail slot (`wf-pill-tail`) is one 14px cell shared by status mark and ↗: both stack in the same cell; on hover the mark shrinks out,
 * the arrow shrinks in. So subagent and script pills keep their marks on the same right edge — ↗ never takes a slot of its own
 (while hidden it must not occupy space: else the subagent's mark would sit one cell left of the workspace's).
 */

/** Lane glyph: agent lanes get the tile face (numbered color, status expression); workspace / unresolved lanes get an icon. */
export function LaneGlyph({
  laneClass,
  className,
  avatarIndex,
  name,
  status,
}: {
  laneClass: LaneClass;
  className?: string;
  name: string;
  avatarIndex?: number | undefined;
  status?: StepRunStatus | undefined;
}) {
  if (laneClass === "agent") {
    return (
      <WorkflowAgentFace
        avatarIndex={avatarIndex}
        className={className}
        name={name}
        status={status}
      />
    );
  }
  const Glyph = laneClass === "workspace" ? TerminalIcon : CircleHelpIcon;
  return <Glyph aria-hidden className={className} />;
}

/** Status mark: spinner / check / cross; `pending` and undefined have none. A new mark pops in on change; on hover of an openable pill it yields to ↗. */
export function PillStatusMark({ status }: { status: StepRunStatus | undefined }) {
  const { intl } = useZCodeIntl();
  if (status === undefined || status === "pending") return null;
  const label = intl.formatMessage({ id: `chat.toolCall.workflow.graph.status.${status}` });
  return (
    <span
      aria-label={label}
      className={cn(
        "wf-mark flex size-3.5 shrink-0 items-center justify-center",
        // Keep the running ring neutral so normal loading does not read as a warning.
        status === "running" && "text-foreground-subtle",
        status === "done" && "text-foreground-subtle",
        status === "failed" && "text-destructive",
      )}
      data-testid="workflow-pill-status"
      key={status}
      role="img"
      title={label}
    >
      {status === "running" ? (
        <LoaderCircleIcon
          aria-hidden
          className="size-3.5 animate-spin motion-reduce:animate-none"
        />
      ) : status === "done" ? (
        <CircleCheckIcon aria-hidden className="size-3.5" />
      ) : (
        <CircleXIcon aria-hidden className="size-3.5" />
      )}
    </span>
  );
}

/** Wiring when the pill is openable: click handler, accessible label, the ↗ testid and data attributes (the sidebar row pins instances by them). */
export interface WorkflowAgentPillOpen {
  onOpen: () => void;
  label: string;
  testId?: string;
  data?: Record<`data-${string}`, string>;
}

export function WorkflowAgentPill({
  children,
  avatarIndex,
  className,
  enterDelayMs,
  inertTitle,
  laneClass,
  name,
  open,
  size = "md",
  status,
  title,
  trailing,
}: {
  avatarIndex?: number | undefined;
  //** Entrance delay (a column of pills lands in sequence, 30 ms apart); absent = immediately. */
  enterDelayMs?: number;
  //** Localized display name (runtime name > lane display name). */
  name: string;
  laneClass: LaneClass;
  status: StepRunStatus | undefined;
  title?: string;
  className?: string;
  //** Present = the whole pill is a button (the callback's existence is the gate). */
  open?: WorkflowAgentPillOpen;
  //** Tooltip when not openable ("the session transcript appears once the subagent starts"); falls back to title / name when absent. */
  inertTitle?: string;
  //** Auxiliary info after the name, before the status mark (the sidebar row's activity and counts). */
  children?: ReactNode;
  //** Controls after the status mark. */
  trailing?: ReactNode;
  //** `row` (24 px, no surface at rest, pill on hover) for the side panel list's two columns; default 32 px. */
  size?: "md" | "row";
}) {
  const tinted = laneClass === "agent";
  // Delayed entrances need backwards fill: hold the first frame while waiting, else the pill shows full then flashes and re-enters.
  // Not both: forwards would leave the transform on the element.
  const style = {
    ...(tinted ? { "--wf-avatar": agentColor(avatarIndex, name) } : {}),
    ...(enterDelayMs === undefined || enterDelayMs <= 0
      ? {}
      : { animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" as const }),
  } as CSSProperties;
  const settled = status !== undefined && status !== "pending";
  const hasMark = settled;
  const hasTail = hasMark || open !== undefined;
  const Root = open === undefined ? "span" : "button";
  const body = (
    <>
      <LaneGlyph
        laneClass={laneClass}
        name={name}
        avatarIndex={avatarIndex}
        status={status}
        className={cn(
          "shrink-0",
          size === "row" ? "size-3.5" : "size-4",
          tinted ? "text-[var(--wf-avatar)]" : "text-foreground-subtle",
        )}
      />
      <span
        className={cn(
          "wf-pill-name min-w-0 flex-1 truncate",
          settled ? "text-foreground" : "text-foreground-subtle",
        )}
      >
        {name}
      </span>
      {children}
      {hasTail ? (
        <span
          className="wf-pill-tail grid size-3.5 shrink-0 place-items-center [&>*]:col-start-1 [&>*]:row-start-1"
          data-testid="workflow-pill-tail"
        >
          <PillStatusMark status={status} />
          {open === undefined ? null : (
            <span
              aria-hidden
              className="wf-pill-go flex size-3.5 items-center justify-center text-foreground-subtlest"
              data-testid={open.testId ?? "workflow-pill-open"}
              {...open.data}
            >
              <ArrowUpRightIcon className="size-3.5" />
            </span>
          )}
        </span>
      ) : null}
      {trailing}
    </>
  );
  return (
    <Root
      aria-label={open?.label}
      className={cn(
        "wf-pill wf-agent-pill wf-arrive flex rounded-full min-w-0 items-center",
        size === "row"
          ? "h-6 gap-1.5 pl-1 pr-1.5 text-ui-sm"
          : "h-8 gap-2 bg-surface pl-2 pr-2.5 text-ui-sm",
        open !== undefined &&
          "wf-pill-open cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        className,
      )}
      data-agent-open={open === undefined ? undefined : "true"}
      data-agent-status={status ?? "pending"}
      data-pill-size={size}
      data-testid="workflow-agent-pill"
      onClick={open?.onOpen}
      style={style}
      title={open === undefined ? (inertTitle ?? title ?? name) : (title ?? name)}
      {...(open === undefined ? {} : { type: "button" as const })}
    >
      {body}
    </Root>
  );
}
