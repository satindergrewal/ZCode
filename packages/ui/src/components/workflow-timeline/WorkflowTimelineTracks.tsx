import { useId } from "react";
import { cn } from "@/components/lib/utils.js";
import type {
  TimelineBand,
  TimelineInk,
  TimelineStation,
  WorkflowTimelineModel,
} from "./timeline-model.js";
import {
  bandAt,
  bandForkX,
  bandMergeX,
  lampX,
  STUB,
  TAIL,
  type TimelineLayout,
} from "./timeline-geometry.js";
import { MarchLight } from "./WorkflowMarchLight.js";
import { stationLampClass } from "./WorkflowTimelineLedge.js";

/**
 * The track layer.
 *
 * Without bands, rail segments remain a border sliver in the header row (pixel-identical). **With bands**, the whole rail moves into the arc layer's
 * SVG: the main line on the bottom row, branch tracks above it, the band forked before and merged after, two 8px quarter-circle arcs lifting each branch
 * up and back down (branches upward). Lamps stay DOM (status classes must
 * be), absolutely positioned on their own track's row; headers move to the platform row, branch-track stations tied to their name by a dotted leader.
 */
const INK_STROKE: Record<TimelineInk, string> = {
  faint: "var(--color-workflow-trace)",
  march: "var(--color-workflow-trace-strong)",
  strong: "var(--color-workflow-trace-strong)",
};

/** A point on the canvas. */
export interface TimelinePoint {
  x: number;
  y: number;
}

/** A stretch of rail on screen: one path, one ink, plus the two stations it joins (test and debug handle). */
export interface TimelineRailPiece {
  key: string;
  d: string;
  /**
   * The path's two endpoints, from the same numbers as `d` — the traveling edge's light gradients across these two points (`MarchLight`),
   * instead of parsing `d` in hindsight.
   */
  start: TimelinePoint;
  end: TimelinePoint;
  ink: TimelineInk;
  /** `fork` / `merge` are the band-end curves; `tail` / `stub` the main line's bit with no predecessor / merge station. */
  kind?: "fork" | "merge" | "tail" | "stub";
  from?: number;
  to?: number;
}

/** A path plus its two endpoints: in `timelineRailPieces` every kind computes these three first, then gets ink and stations. */
type RailShape = Pick<TimelineRailPiece, "d" | "end" | "start">;

/**
 * Rail segment -> path (pure). An ordinary segment on one track is a straight line on that row (lamp + 8 -> lamp − 8); the main line's
 * own segments pass through fork and merge points, so the main line stays one straight line. An ordinary segment with both ends in **different bands** can only be
 * the stretch between adjacent bands, drawn on the main line from the former's merge to the latter's fork. Twin segments are not drawn on the card.
 */
export function timelineRailPieces(
  model: Pick<WorkflowTimelineModel, "bands" | "rails" | "stations">,
  layout: TimelineLayout,
): TimelineRailPiece[] {
  const { bands, rails, stations } = model;
  const { inset, rowY } = layout;
  const y0 = rowY[0]!;
  const rowOf = (track: number): number => rowY[track] ?? y0;
  const lx = (i: number): number => lampX(i, inset);
  const forkX = (band: TimelineBand): number => bandForkX(band, inset);
  const mergeX = (band: TimelineBand): number => bandMergeX(band, inset);
  const trackOfStation = (i: number): number => stations[i]?.track ?? 0;

  /** A straight segment on one row. */
  const straight = (x1: number, x2: number, y: number): RailShape => ({
    d: `M${x1},${y} H${x2}`,
    end: { x: x2, y },
    start: { x: x1, y },
  });
  // Branch track t leaves the main line at forkX − 8(t−1), two quarter-circle arcs rise to its row, then across to 8px before the first lamp.
  const forkPath = (band: TimelineBand, track: number, head: number): RailShape => {
    const xf = forkX(band) - 8 * (track - 1);
    const yt = rowOf(track);
    return {
      d: `M${xf},${y0} Q${xf + 8},${y0} ${xf + 8},${y0 - 8} V${yt + 8} Q${xf + 8},${yt} ${xf + 16},${yt} H${lx(head) - 8}`,
      end: { x: lx(head) - 8, y: yt },
      start: { x: xf, y: y0 },
    };
  };
  // The merge mirrors the fork: across from 8px past the last lamp to xm − 8, back onto the main line. The higher the track in the band, the further left it lands.
  const mergePath = (band: TimelineBand, track: number, tail: number): RailShape => {
    const xm = mergeX(band) - 8 * (band.tracks.length - 1 - track);
    const yt = rowOf(track);
    return {
      d: `M${lx(tail) + 8},${yt} H${xm - 8} Q${xm},${yt} ${xm},${yt + 8} V${y0 - 8} Q${xm},${y0} ${xm + 8},${y0}`,
      end: { x: xm + 8, y: y0 },
      start: { x: lx(tail) + 8, y: yt },
    };
  };

  const pieces: TimelineRailPiece[] = [];
  // A band with no predecessor / no merge station grows its own ends: a small tail / stub on the main line, plus the branch curves — the model has
  // no matching rail segment (fork and merge need that station to become a segment); ink from the track's own entry / exit.
  for (const band of bands) {
    const main = band.tracks[0]!;
    if (band.pred === undefined) {
      const head = main.stations[0]!;
      pieces.push({
        ...straight(forkX(band) - TAIL, lx(head) - 8, y0),
        ink: main.entry,
        key: `tail:${band.from}`,
        kind: "tail",
        to: head,
      });
      band.tracks.forEach((track, t) => {
        if (t === 0) return;
        const first = track.stations[0]!;
        pieces.push({
          ...forkPath(band, t, first),
          ink: track.entry,
          key: `fork:${band.from}:${t}`,
          kind: "fork",
          to: first,
        });
      });
    }
    if (band.join === undefined) {
      const last = main.stations[main.stations.length - 1]!;
      pieces.push({
        ...straight(lx(last) + 8, mergeX(band) + STUB, y0),
        ink: main.exit,
        key: `stub:${band.to}`,
        kind: "stub",
        from: last,
      });
      band.tracks.forEach((track, t) => {
        if (t === 0) return;
        const end = track.stations[track.stations.length - 1]!;
        pieces.push({
          ...mergePath(band, t, end),
          ink: track.exit,
          key: `merge:${band.to}:${t}`,
          kind: "merge",
          from: end,
        });
      });
    }
  }

  for (const rail of rails) {
    // The twin segment only says "these two run in parallel"; not drawn on the card — fork and merge already said it.
    if (rail.kind === "twin") continue;
    const ends = { from: rail.from, ink: rail.ink, key: `${rail.from}>${rail.to}`, to: rail.to };
    if (rail.kind === "fork") {
      const band = bandAt(bands, rail.to);
      if (band === undefined) continue;
      pieces.push({ ...ends, ...forkPath(band, trackOfStation(rail.to), rail.to), kind: "fork" });
      continue;
    }
    if (rail.kind === "merge") {
      const band = bandAt(bands, rail.from);
      if (band === undefined) continue;
      pieces.push({
        ...ends,
        ...mergePath(band, trackOfStation(rail.from), rail.from),
        kind: "merge",
      });
      continue;
    }
    const source = bandAt(bands, rail.from);
    const target = bandAt(bands, rail.to);
    if (source !== undefined && target !== undefined && source !== target) {
      pieces.push({ ...ends, ...straight(mergeX(source), forkX(target), y0) });
      continue;
    }
    const yt = rowOf(trackOfStation(rail.from));
    pieces.push({ ...ends, ...straight(lx(rail.from) + 8, lx(rail.to) - 8, yt) });
  }
  return pieces;
}

/**
 * Rails and leader lines, inside the arc layer's SVG (mounted with bands only). Traveling segments layer the light per the arc rule, except the layer
 * is now a **motionless** light (`MarchLight`): fading in from the segment's start, brightest at the lamp.
 */
export function WorkflowTimelineTracks({
  folded,
  layout,
  model,
}: {
  model: Pick<WorkflowTimelineModel, "bands" | "rails" | "stations">;
  layout: TimelineLayout;
  /** Stations folded to a ledge: their leader fades out with the lamp. */
  folded: ReadonlySet<number>;
}) {
  const pieces = timelineRailPieces(model, layout);
  // The track layer lives inside the arc layer's SVG, so gradient ids must be unique SVG-wide: instance prefix + segment key (minus `:` `>` and the like).
  const gradientBase = useId();
  return (
    <g>
      {pieces.map((piece) => (
        <g
          data-rail-from={piece.from}
          data-rail-ink={piece.ink}
          data-rail-kind={piece.kind}
          data-rail-to={piece.to}
          data-testid="workflow-timeline-rail"
          key={piece.key}
        >
          <path
            className="wf-ink"
            d={piece.d}
            fill="none"
            stroke={INK_STROKE[piece.ink]}
            strokeWidth={1}
          />
          {piece.ink === "march" ? (
            <MarchLight
              d={piece.d}
              from={piece.start}
              id={`${gradientBase}lit-${piece.key.replace(/[^\w-]/g, "-")}`}
              to={piece.end}
            />
          ) : null}
        </g>
      ))}
      {model.stations.map((station, i) =>
        station.track === 0 ? null : (
          <path
            className={cn("wf-foldable", folded.has(i) && "wf-folded")}
            d={`M${lampX(i, layout.inset)},${(layout.rowY[station.track] ?? layout.rowY[0]!) + 7} V${layout.capY - 10}`}
            data-leader-station={i}
            data-testid="workflow-timeline-leader"
            fill="none"
            key={station.id}
            stroke="var(--color-workflow-trace)"
            strokeDasharray="1 2"
            strokeLinecap="round"
            strokeWidth={1}
          />
        ),
      )}
    </g>
  );
}

/**
 * Lamps (with bands): still a DOM span — status classes, glow and pulse all in CSS — just absolutely positioned on their own track's
 * row instead of following the header.
 */
export function WorkflowTimelineLamps({
  draft,
  folded,
  layout,
  stations,
}: {
  stations: readonly TimelineStation[];
  layout: TimelineLayout;
  folded: ReadonlySet<number>;
  draft: boolean;
}) {
  return (
    <>
      {stations.map((station, i) => (
        <span
          aria-hidden
          className={cn(
            stationLampClass(station.status),
            "absolute",
            "wf-foldable",
            folded.has(i) && "wf-folded",
            draft && "wf-land",
          )}
          data-lamp={station.status ?? "pending"}
          data-lamp-track={station.track}
          key={station.id}
          style={{
            left: lampX(i, layout.inset) - 5,
            top: (layout.rowY[station.track] ?? layout.rowY[0]!) - 5,
          }}
        />
      ))}
    </>
  );
}
