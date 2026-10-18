// ============================================================
// Side pane spine parts
// ============================================================
// Split out of WorkflowRunPhaseList.tsx (max-lines 400): the list file owns expansion state, question
// attribution and pill wiring; this file holds the pure presentational parts, rail segments, joint rows,
// lamps, avatar clusters on collapsed section headers, round badges, and the subagent row tail
// (counts and model name).

import { useId, useMemo, type CSSProperties } from "react";
import { Repeat2Icon } from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import { STATUS_DOT } from "@/components/workflow-graph/run-status-presentation.js";
import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import type {
  TimelineInk,
  TimelinePill,
  TimelineStation,
} from "@/components/workflow-timeline/timeline-model.js";
import { workflowActorModelLabels } from "@/components/workflow-timeline/subagent-model-label.js";
import { LaneGlyph, agentColor } from "@/components/workflow-timeline/WorkflowAgentPill.js";
import { MarchLight } from "@/components/workflow-timeline/WorkflowMarchLight.js";
import { StreamChevronsBox } from "@/components/workflow-timeline/WorkflowStreamChevrons.js";
import {
  SPINE_JOINT_PX,
  SPINE_TRACK_X,
  type SpineJoint,
  type SpineSection,
} from "@/app-shell/workflowRunSpine.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** How far an open joint's main rail stubs outward (the card's TAIL). */
const SPINE_STUB_PX = 4;

/** Stream rails yield this much on each half across a section boundary; two downward chevrons stand in the notch. */
const SPINE_STREAM_GAP_PX = 7;

/** Max avatars on a collapsed section header; the rest collapse into +n. */
const CLUSTER_MAX = 3;

/**
 * Half of a rail segment. The stretch between adjacent sites is drawn in two halves: the upper site draws
 * lamp-bottom to section-bottom, the lower section-top to lamp-top, same ink, meeting at the section boundary.
 * Rails thereby stretch with expand/collapse on their own, no measuring.
 *
 * Bands add a third kind: full, through the whole section (mainline crossing a branch site, a branch rail
 * crossing someone else's site); the joint rows' main rail is it too. x for track > 0 is inline style
 * (`21 + pitch*t`), computed, Tailwind cannot generate that class.
 *
 * A marching segment is a 1.5px LIT rail, static: it is the edge control flow has already walked; motion
 * belongs to the running lamp. Brightness grows along the control-flow direction and data-rail-position
 * exists so the stylesheet can pick the gradient, both halves carry it: below (upper site's lower half) fades
 * from transparent into 70 percent warning, above (running section's upper half) rises from 70 to full,
 * staying lit into the lamp; full is flat 70 percent.
 */
export function SpineRail({
  ink,
  overhang,
  pitch,
  position,
  stream,
  track = 0,
}: {
  ink: TimelineInk;
  position: "above" | "below" | "full";
  /** Half of a stream rail: yields SPINE_STREAM_GAP_PX at the section boundary, no marching light. */
  stream?: true;
  track?: number;
  /** Track pitch (workflowRunSpine.ts); only read for track > 0. */
  pitch: number;
  /** An open joint's main rail: stubs SPINE_STUB_PX outward, root on top, sink below. */
  overhang?: "top" | "bottom";
}) {
  const x = SPINE_TRACK_X + pitch * track;
  const style: CSSProperties = {};
  // Stream-rail ink sits on the chevrons; both halves stay flat 1px ink.
  const lit = ink === "march" && stream !== true;
  if (track > 0) style.left = lit ? x - 0.75 : x - 0.5;
  if (stream === true && position === "below") style.bottom = SPINE_STREAM_GAP_PX;
  if (stream === true && position === "above") {
    style.top = SPINE_STREAM_GAP_PX;
    style.height = 12 - SPINE_STREAM_GAP_PX;
  }
  if (overhang !== undefined) {
    style.top = overhang === "top" ? -SPINE_STUB_PX : 0;
    style.bottom = overhang === "bottom" ? -SPINE_STUB_PX : 0;
  }
  return (
    <span
      aria-hidden
      className={cn(
        "wf-ink absolute rounded-full",
        lit ? "left-[20.25px] w-[1.5px]" : "left-[20.5px] w-px",
        position === "above" ? "top-0 h-3" : position === "below" ? "bottom-0 top-6" : "inset-y-0",
        !lit && "bg-foreground-subtlest",
        lit && "wf-spine-march",
      )}
      data-rail-ink={ink}
      data-rail-kind={stream === true ? "stream" : undefined}
      data-rail-position={position}
      data-rail-track={track}
      data-testid="workflow-run-spine-rail"
      style={Object.keys(style).length === 0 ? undefined : style}
    />
  );
}

/**
 * Every vertical rail in one section (precomputed by workflowRunSpine.ts), drawn in one go. A stream rail's
 * lower half places two downward chevrons centered on the section's bottom edge
 * (presentation.md "The spine") at z-index 1 so the next header's hover background cannot cover them.
 */
export function SpinePieces({ pitch, section }: { pitch: number; section: SpineSection }) {
  return (
    <>
      {section.rails.map((rail) => (
        <SpineRail key={`${rail.track}:${rail.position}`} pitch={pitch} {...rail} />
      ))}
      {section.rails.map((rail) =>
        rail.stream === true && rail.position === "below" ? (
          <StreamChevronsBox
            count={2}
            direction="down"
            ink={rail.ink}
            key={`stream:${rail.track}`}
            style={{ left: SPINE_TRACK_X + pitch * rail.track, top: "100%", zIndex: 1 }}
          />
        ) : null,
      )}
    </>
  );
}

/**
 * Joint rows (presentation.md "The spine"): a fork or join takes a full 16px row BETWEEN sections. The main
 * rail crosses straight through; every branch leaves (or returns to) the mainline along the same y=8 bus:
 * down, one corner of radius min(6, pitch/2), across to its own column, another corner, down to the row bottom.
 * A single branch joins its two corners into an S. A join mirrors the fork.
 *
 * Curves always paint base ink first, then marching overlays a lit gradient along the same path (MarchLight):
 * fading in from the control-flow end, brightest at the lamp end, static. The gradient's ends are the path's
 * first and last points; id comes from useId(), unique per svg.
 * Open rows (a fork with no predecessor, a join with no sink) do not tie to the neighbor section; the rail
 * stubs 4px outward and caps round: a root, a sink (the card's TAIL / STUB). The row is decorative
 * (aria-hidden), lamps and headers already say it. A missing joint means no joint here: draw nothing.
 */
export function SpineJointRow({
  joint,
  kind,
  pitch,
}: {
  joint: SpineJoint | undefined;
  kind: "fork" | "merge";
  pitch: number;
}) {
  const lightBase = useId();
  if (joint === undefined) return null;
  const main = SPINE_TRACK_X - 0.5;
  const r = Math.min(6, pitch / 2);
  const bus = SPINE_JOINT_PX / 2;
  const curves = joint.branches.map((branch) => {
    const x = main + pitch * branch.track;
    const d =
      kind === "fork"
        ? `M${main},0 V${bus - r} Q${main},${bus} ${main + r},${bus} H${x - r} Q${x},${bus} ${x},${bus + r} V${SPINE_JOINT_PX}`
        : `M${x},0 V${bus - r} Q${x},${bus} ${x - r},${bus} H${main + r} Q${main},${bus} ${main},${bus + r} V${SPINE_JOINT_PX}`;
    const from = kind === "fork" ? { x: main, y: 0 } : { x, y: 0 };
    const to = kind === "fork" ? { x, y: SPINE_JOINT_PX } : { x: main, y: SPINE_JOINT_PX };
    return { ...branch, d, from, to };
  });
  const width = main + pitch * Math.max(1, ...joint.branches.map((branch) => branch.track)) + 8;
  return (
    <div
      aria-hidden
      className="relative shrink-0"
      data-joint-kind={kind}
      data-joint-open={joint.open === true ? "true" : undefined}
      data-testid="workflow-run-spine-joint"
      style={{ height: SPINE_JOINT_PX }}
    >
      <SpineRail
        ink={joint.main}
        pitch={pitch}
        position="full"
        {...(joint.open === true ? { overhang: kind === "fork" ? "top" : "bottom" } : {})}
      />
      <svg
        className="absolute left-0 top-0 overflow-visible"
        height={SPINE_JOINT_PX}
        viewBox={`0 0 ${width} ${SPINE_JOINT_PX}`}
        width={width}
      >
        {curves.map((curve) => (
          <g
            data-curve-ink={curve.ink}
            data-curve-track={curve.track}
            data-testid={`workflow-run-spine-${kind}`}
            key={curve.track}
          >
            <path
              className="wf-ink"
              d={curve.d}
              fill="none"
              stroke="var(--color-foreground-subtlest)"
              strokeLinecap="round"
              strokeWidth={1}
            />
          </g>
        ))}
        {/* Light paints above all base ink: branches share the bus, later base ink must not cover earlier light. */}
        {curves.map((curve) =>
          curve.ink === "march" ? (
            <g data-testid={`workflow-run-spine-${kind}-lit`} key={`lit:${curve.track}`}>
              <MarchLight
                d={curve.d}
                from={curve.from}
                id={`${lightBase}lit-${curve.track}`}
                to={curve.to}
              />
            </g>
          ) : null,
        )}
      </svg>
    </div>
  );
}

/**
 * Rails' lamps: hollow not yet, green passed, red ring failed, amber pulsing running. The running lamp shares
 * its life with the card's (wf-lamp-running): steady halo plus one heartbeat; under motion-reduce, halo only.
 */
export function SpineLamp({
  pitch,
  status,
  track = 0,
}: {
  status: StepRunStatus;
  track?: number;
  pitch: number;
}) {
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
      style={track === 0 ? undefined : { left: 16 + pitch * track }}
    />
  );
}

/** Avatar cluster on a collapsed section header: who is at this site at a glance; subagents get numbered tinted tile faces, workspaces the terminal glyph. */
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

/** Round badge: retry-N, present only at loop-back ends after at least one round (same rule as the card). */
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

/**
 * The subagent row's tail: counts (N tasks, N reads) plus the model name when the persona names one
 * (presentation.md "The spine"). Model names can be long (custom provider name/model): they yield with the
 * subagent name, counts do not.
 */
export function SpinePillTrailer({
  counts,
  modelName,
}: {
  counts: readonly string[];
  modelName: string | undefined;
}) {
  return (
    <>
      {counts.length === 0 ? null : (
        <span className="shrink-0 font-mono text-ui-xs tabular-nums text-foreground-subtlest">
          {counts.join(" · ")}
        </span>
      )}
      {modelName === undefined ? null : (
        <span
          className="min-w-0 max-w-[45%] truncate font-mono text-ui-xs text-foreground-subtlest"
          data-testid="workflow-run-agent-model"
        >
          {counts.length === 0 ? modelName : `· ${modelName}`}
        </span>
      )}
    </>
  );
}

/** Memoized {@link workflowActorModelLabels} per actors table and locale (the spine looks it up every render). */
export function useWorkflowActorModelLabels(
  actors: readonly { siteId: string; ordinal: number; model?: string }[] | undefined,
  providerName: ((providerId: string) => string | undefined) | undefined,
): ReadonlyMap<string, { name: string; canonical: string }> {
  const { intl } = useZCodeIntl();
  return useMemo(
    () =>
      workflowActorModelLabels(actors, {
        formatMessage: intl.formatMessage.bind(intl),
        ...(providerName === undefined ? {} : { providerName }),
      }),
    [actors, intl, providerName],
  );
}
