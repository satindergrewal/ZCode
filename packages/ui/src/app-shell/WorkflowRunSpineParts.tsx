// ============================================================
// Parts of the sidebar spine.
// ============================================================
// Split from WorkflowRunPhaseList.tsx (max-lines 400): the list file owns expansion state, question
// attribution, and pill wiring; this file holds the four pure presentational parts -- rail segments,
// lamps, collapsed-header avatar clusters, and round chips.

import { useId, type CSSProperties } from "react";
import { Repeat2Icon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { STATUS_DOT } from "@/components/workflow-graph/run-status-presentation.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import type {
  TimelineInk,
  TimelinePill,
  TimelineStation,
} from "@/components/workflow-timeline/timeline-model.js";
import { LaneGlyph, agentColor } from "@/components/workflow-timeline/WorkflowAgentPill.js";
import { MarchLight } from "@/components/workflow-timeline/WorkflowMarchLight.js";
import type { SpineSection } from "@/app-shell/workflowRunSpine.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** Max avatars on a collapsed header; the rest collapse into `+n`. */
const CLUSTER_MAX = 3;

/** Vertical-rail center for track t; the main line is 21, each branch 12px further right (`workflowRunSpine.ts`). */
const TRACK_X = 21;
const TRACK_GAP = 12;

/**
 * One half of a rail segment. The span between two adjacent stations is drawn in two pieces: the
 * upper station from lamp-bottom to section-bottom, the lower from section-top to lamp-top -- same
 * ink, joined at the section boundary. The rail thus lengths with expand/collapse by itself, no
 * measuring.
 *
 * Bands add a third kind: `full` crosses the whole section (the main rail past branch stations,
 * branch rails past others' stations); `from` / `to` leave the 13px for the fork/merge curves. The
 * x of track t > 0 is inline style -- it is computed; Tailwind cannot generate the class.
 *
 * The march segment is a 1.5px **lit** rail, static: it marks the edge control flow already
 * traversed; motion belongs to the running lamp. Brightness grows along the direction of control
 * flow -- `data-rail-position` exists so the stylesheet can pick the gradient, and both halves
 * carry it: `below` (lower half of the previous section) fades from transparent to 70% accent,
 * `above` (upper half of the running section) rises from 70% to full, staying lit into the lamp;
 * `full` is flat 70%.
 */
function SpineRail({
  from,
  ink,
  position,
  to,
  track = 0,
}: {
  ink: TimelineInk;
  position: "above" | "below" | "full";
  track?: number;
  from?: number;
  to?: number;
}) {
  const style: CSSProperties = {};
  if (track > 0)
    style.left = (ink === "march" ? TRACK_X - 0.75 : TRACK_X - 0.5) + TRACK_GAP * track;
  if (from !== undefined) style.top = from;
  if (to !== undefined) style.bottom = to;
  return (
    <span
      aria-hidden
      className={cn(
        "wf-ink absolute rounded-full",
        ink === "march" ? "left-[20.25px] w-[1.5px]" : "left-[20.5px] w-px",
        position === "above" ? "top-0 h-3" : position === "below" ? "bottom-0 top-6" : "inset-y-0",
        ink !== "march" && "bg-foreground-subtlest",
        ink === "march" && "wf-spine-march",
      )}
      data-rail-ink={ink}
      data-rail-position={position}
      data-rail-track={track}
      data-testid="workflow-run-spine-rail"
      style={Object.keys(style).length === 0 ? undefined : style}
    />
  );
}

/**
 * Fork / merge curves: the branch track leaves the main rail within the 13px above the band's
 * first section and returns mirrored at the merge station's section top (or the band-last
 * section's bottom). Faint and strong ink share one drawing here (like the vertical rails); when
 * marching, a lit light (`MarchLight`) overlays the same path, fading in from the control-flow end
 * and brightest at the lamp end, static. The gradient endpoints are exactly the two points of
 * `path` (fork: main-rail top to branch bottom; merge the reverse); the path string is not parsed.
 * `id` comes from `useId()`, unique within one SVG.
 */
function SpineCurve({
  at,
  ink,
  kind,
  track,
}: {
  kind: "fork" | "merge";
  track: number;
  ink: TimelineInk;
  at: "top" | "bottom";
}) {
  const lightId = useId();
  const x = TRACK_X - 0.5 + TRACK_GAP * track;
  const main = TRACK_X - 0.5;
  const path =
    kind === "fork"
      ? `M${main},0 V1 C${main},8 ${x},5 ${x},13`
      : `M${x},0 C${x},8 ${main},5 ${main},13`;
  const from = kind === "fork" ? { x: main, y: 0 } : { x, y: 0 };
  const to = kind === "fork" ? { x, y: 13 } : { x: main, y: 13 };
  const width = x + 8;
  return (
    <svg
      aria-hidden
      className={cn("absolute left-0", at === "top" ? "top-0" : "bottom-0")}
      data-curve-ink={ink}
      data-curve-track={track}
      data-testid={`workflow-run-spine-${kind}`}
      height={13}
      viewBox={`0 0 ${width} 13`}
      width={width}
    >
      <path
        d={path}
        fill="none"
        stroke="var(--color-foreground-subtlest)"
        strokeLinecap="round"
        strokeWidth={1}
      />
      {ink === "march" ? <MarchLight d={path} from={from} id={lightId} to={to} /> : null}
    </svg>
  );
}

/** Every vertical rail and curve of one section (as computed by `workflowRunSpine.ts`), drawn in one go. */
export function SpinePieces({ section }: { section: SpineSection }) {
  return (
    <>
      {section.rails.map((rail) => (
        <SpineRail key={`${rail.track}:${rail.position}`} {...rail} />
      ))}
      {section.curves.map((curve) => (
        <SpineCurve key={`${curve.kind}:${curve.track}`} {...curve} />
      ))}
    </>
  );
}

/**
 * Lamp on the rail: hollow = not yet reached, green = passed, red ring = failed, pulsing amber =
 * running. A running lamp shares the card lamp's life (`wf-lamp-running`): steady halo plus one
 * heartbeat; under `motion-reduce` only the halo remains.
 */
export function SpineLamp({ status, track = 0 }: { status: StepRunStatus; track?: number }) {
  return (
    <span
      aria-hidden
      className={cn(
        "wf-lamp absolute left-4 top-[13px] size-2.5 rounded-full",
        STATUS_DOT[status],
        status === "pending" && "bg-background",
        status === "running" && "wf-lamp-running motion-reduce:animate-none",
      )}
      data-lamp={status}
      data-testid="workflow-run-phase-lamp"
      style={track === 0 ? undefined : { left: 16 + TRACK_GAP * track }}
    />
  );
}

/** Avatar cluster on a collapsed header: who is at this station, at a glance; subagents are numbered tinted tile faces, the workspace a terminal glyph. */
export function AvatarCluster({
  pills,
  nameOf,
}: {
  pills: readonly TimelinePill[];
  nameOf: (pill: TimelinePill) => string;
}) {
  if (pills.length === 0) return null;
  const shown = pills.slice(0, CLUSTER_MAX);
  const more = pills.length - shown.length;
  return (
    <span className="flex items-center gap-1" data-testid="workflow-run-phase-cluster">
      {shown.map((pill) => {
        const tinted = pill.laneClass === "agent";
        const color = tinted ? agentColor(pill.avatarIndex, nameOf(pill)) : undefined;
        return (
          <span
            className={cn(
              "contents",
              tinted ? "text-[var(--wf-avatar)]" : "text-foreground-subtle",
            )}
            key={pill.key}
            style={color === undefined ? undefined : { ["--wf-avatar" as string]: color }}
            title={nameOf(pill)}
          >
            <LaneGlyph
              className="size-4 shrink-0"
              avatarIndex={pill.avatarIndex}
              laneClass={pill.laneClass}
              name={nameOf(pill)}
              status={pill.status}
            />
          </span>
        );
      })}
      {more > 0 ? (
        <span className="ml-1 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
          +{more}
        </span>
      ) : null}
    </span>
  );
}

/** Rounds: `⟳ n`, present only at both ends of a back-edge after at least one round (same rule as on the card). */
export function Rounds({ station }: { station: TimelineStation }) {
  const { intl } = useZCodeIntl();
  if (!station.onLoop || station.rounds === 0) return null;
  return (
    <span
      className="flex items-center gap-[3px]"
      data-testid="workflow-run-phase-rounds"
      title={intl.formatMessage(
        { id: "chat.toolCall.workflow.timeline.rounds" },
        { count: station.rounds },
      )}
    >
      <Repeat2Icon aria-hidden className="size-[11px]" />
      <span>{station.rounds}</span>
    </span>
  );
}
