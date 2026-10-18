import type { CSSProperties } from "react";
import { ArrowUpRightIcon, ChevronDownIcon, CircleXIcon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { laneDisplayName } from "@/components/workflow-graph/lane-name.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { RosterCounts, RosterMore } from "./roster-model.js";
import type { TimelinePill } from "./timeline-model.js";
import { LaneGlyph } from "./WorkflowAgentPill.js";
import { RosterTally } from "./WorkflowRosterParts.js";

/**
 * The "n more" row: on the card's roster station,
 * the sixth pill after five pinned — same height, surface, padding, radius, hover grammar. Content: a stack of three faces (the most
 * important three of the rest, expressions carrying status), `n more`, a red `✕ n` when failures hide behind, and the resident ↗ in the tail.
 *
 * It is a door, not a status: one click opens the run panel, lands on this station, expands the list (`onOpen` wired by the card to `onSelectStation`).
 * No status mark to yield to, so ↗ shows without hover (an empty tail reads "nothing here"). Without callbacks it is a static span.
 *
 * On the side panel the same body is a **door** (`door` present): the tail becomes a down-chevron, toggling in place.
 * Closed, it carries the rest-count row (hidden failures red, inside the count row, no separate `✕ n`); open, the count moves into the list's
 * group header, the row keeps only the number, surface up one step, name to foreground.
 */
export function WorkflowMoreRow({
  door,
  enterDelayMs,
  more,
  onOpen,
}: {
  more: RosterMore;
  //** Entrance delay (lands after the pinned pills); absent = immediately. */
  enterDelayMs?: number;
  //** Present = the whole row is a button (the callback's existence is the gate). */
  onOpen?: () => void;
  //** Door form (side panel): open state and the rest-count. Absent = the card's row (↗ resident). */
  door?: { open: boolean; tally: RosterCounts };
}) {
  const { intl } = useZCodeIntl();
  const format = intl.formatMessage.bind(intl);
  const nameOf = (pill: TimelinePill) => pill.runtimeName ?? laneDisplayName(pill.lane, format);
  const label = format(
    { id: "chat.toolCall.workflow.timeline.roster.more" },
    { count: more.count },
  );
  const title = format(
    {
      id:
        door === undefined
          ? "chat.toolCall.workflow.timeline.roster.moreTitle"
          : door.open
            ? "chat.toolCall.workflow.timeline.roster.door.fold"
            : "chat.toolCall.workflow.timeline.roster.door.list",
    },
    { count: more.count },
  );
  // Same entrance discipline as the pills: backwards fill when delayed.
  const style =
    enterDelayMs === undefined || enterDelayMs <= 0
      ? undefined
      : ({ animationDelay: `${enterDelayMs}ms`, animationFillMode: "backwards" } as CSSProperties);
  const Root = onOpen === undefined ? "span" : "button";
  return (
    <Root
      aria-label={title}
      aria-expanded={door?.open}
      className={cn(
        "wf-pill wf-agent-pill wf-more-row wf-arrive flex h-8 min-w-0 items-center gap-2 rounded-full pl-2 pr-2.5 text-ui-sm",
        door?.open === true ? "bg-surface-hover" : "bg-surface",
        onOpen !== undefined &&
          "wf-pill-open cursor-pointer text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
      )}
      data-door={door === undefined ? undefined : door.open ? "open" : "closed"}
      data-more-count={more.count}
      data-testid="workflow-roster-more-row"
      onClick={onOpen}
      style={style}
      title={title}
      {...(onOpen === undefined ? {} : { type: "button" as const })}
    >
      <span className="wf-more-deck flex shrink-0 items-center" data-testid="workflow-more-deck">
        {more.deck.map((pill) => (
          <LaneGlyph
            className="wf-more-face size-4 shrink-0 text-foreground-subtle"
            key={pill.key}
            avatarIndex={pill.avatarIndex}
            laneClass={pill.laneClass}
            name={nameOf(pill)}
            status={pill.status}
          />
        ))}
      </span>
      <span
        className={cn(
          "wf-pill-name min-w-0 flex-1 truncate",
          door?.open === true ? "text-foreground" : "text-foreground-subtle",
        )}
      >
        {label}
      </span>
      {door === undefined ? null : door.open ? null : (
        <RosterTally className="mr-0.5 shrink-0" counts={door.tally} />
      )}
      {door !== undefined || more.failed === 0 ? null : (
        <span
          className="flex shrink-0 items-center gap-[3px] font-mono text-ui-xs tabular-nums text-destructive"
          data-testid="workflow-more-failed"
          title={format(
            { id: "chat.toolCall.workflow.timeline.roster.failed" },
            { count: more.failed },
          )}
        >
          <CircleXIcon aria-hidden className="size-2.5" />
          <span className="font-medium">{more.failed}</span>
        </span>
      )}
      <span
        className="wf-pill-tail grid size-3.5 shrink-0 place-items-center"
        data-testid="workflow-pill-tail"
      >
        {door === undefined ? (
          <span
            aria-hidden
            className="wf-pill-go wf-pill-go-rest flex size-3.5 items-center justify-center text-foreground-subtlest"
            data-testid="workflow-more-open"
          >
            <ArrowUpRightIcon className="size-3.5" />
          </span>
        ) : (
          <span
            aria-hidden
            className={cn(
              "wf-pill-go wf-pill-go-rest flex size-3.5 items-center justify-center text-foreground-subtlest transition-transform",
              door.open && "rotate-180",
            )}
            data-testid="workflow-more-chevron"
          >
            <ChevronDownIcon className="size-3.5" />
          </span>
        )}
      </span>
    </Root>
  );
}
