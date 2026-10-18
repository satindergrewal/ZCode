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
import { STREAM_GAP, StreamChevrons } from "./WorkflowStreamChevrons.js";
import { stationLampClass } from "./WorkflowTimelineLedge.js";
import { slideClass, slideStyle, type FillSlide } from "./use-fill-growth.js";

/**
 * Rail layer.
 *
 * Without a branch, rail segments remain a border stub in the station-header row (pixel-identical). With
 * a branch the whole rail moves into the arc layer SVG: main line on the bottom row, branch rails above,
 * forking before the branch and merging after it, two 8px quarter-circles lifting the branch and setting
 * it back (branches rise). Dots stay DOM (status classes
 * need to), absolutely positioned on their own rail's row; headers move to the platform row, and a branch
 * station is tied back to its name by a dotted leader.
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

/** A rail piece on screen: one path, one ink, plus the two stations it joins (a handle for tests and debugging). */
export interface TimelineRailPiece {
  key: string;
  d: string;
  /**
   * The path's end points, from the same numbers as `d` — the marching light lays its gradient from
   * these two points instead of parsing `d` back.
   */
  start: TimelinePoint;
  end: TimelinePoint;
  ink: TimelineInk;
  /**
   * `fork` / `merge` are the branch-end curves; `tail` / `stub` the main line's stub with no predecessor /
   * merge station; `stream` is a rail's stream segment — the path breaks mid-way by `STREAM_GAP`, with
   * `chevrons` the gap's center.
   */
  kind?: "fork" | "merge" | "tail" | "stub" | "stream";
  chevrons?: TimelinePoint;
  from?: number;
  to?: number;
}

/** Path plus end points: every kind in `timelineRailPieces` computes these three first, then adds ink and stations. */
type RailShape = Pick<TimelineRailPiece, "d" | "end" | "start">;

/**
 * Rail segment to path (pure). A plain segment on one rail is a straight line on that row (dot + 8 to
 * dot - 8); the main line's pieces pass through fork and merge points, so it stays straight. A plain
 * segment with both ends in different branches can only be the stretch between adjacent branches, drawn
 * on the main line from the former's merge point to the latter's fork. Double segments never draw on the card.
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
  // Branch rail t leaves the main line at forkX − 8(t−1), two quarter-circles rise to its row, then across to 8px before the first dot.
  const forkPath = (band: TimelineBand, track: number, head: number): RailShape => {
    const xf = forkX(band) - 8 * (track - 1);
    const yt = rowOf(track);
    return {
      d: `M${xf},${y0} Q${xf + 8},${y0} ${xf + 8},${y0 - 8} V${yt + 8} Q${xf + 8},${yt} ${xf + 16},${yt} H${lx(head) - 8}`,
      end: { x: lx(head) - 8, y: yt },
      start: { x: xf, y: y0 },
    };
  };
  // The merge mirrors the fork: across from 8px past the last dot to xm − 8, back onto the main line. The higher the rail, the further left it lands.
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
  // A branch with no predecessor / no merge station grows its own ends: a tail / stub of main line and
  // the branch rails' curves — the model has no matching segment (fork and merge need that station to
  // form one), so ink comes from the rail's own entry / exit.
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
    // A double segment only says these two run in parallel; the card does not draw it — fork and merge already said it.
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
    const x1 = lx(rail.from) + 8;
    const x2 = lx(rail.to) - 8;
    if (rail.kind === "stream") {
      // Stream rail (presentation.md "Stream rails"): one straight line in two strokes, a gap left for the chevrons.
      const mid = (x1 + x2) / 2;
      pieces.push({
        ...ends,
        chevrons: { x: mid, y: yt },
        d: `M${x1},${yt} H${mid - STREAM_GAP / 2} M${mid + STREAM_GAP / 2},${yt} H${x2}`,
        end: { x: x2, y: yt },
        kind: "stream",
        start: { x: x1, y: yt },
      });
      continue;
    }
    pieces.push({ ...ends, ...straight(x1, x2, yt) });
  }
  return pieces;
}

/**
 * Rails and leader lines, drawn in the arc layer SVG (mounted only with a branch). Marching segments
 * keep the arc's old trick of an extra layer, except theirs is now still light (`MarchLight`): fading in
 * from the segment's start, brightest at the dot end.
 */
export function WorkflowTimelineTracks({
  folded,
  layout,
  model,
}: {
  model: Pick<WorkflowTimelineModel, "bands" | "rails" | "stations">;
  layout: TimelineLayout;
  /** Stations folded to a ledge: their leader fades with the dot. */
  folded: ReadonlySet<number>;
}) {
  const pieces = timelineRailPieces(model, layout);
  // The rail layer lives inside the arc layer SVG; gradient ids must be unique across it: instance prefix plus segment key (chars like : > stripped).
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
          {piece.chevrons === undefined ? null : (
            <StreamChevrons ink={piece.ink} x={piece.chevrons.x} y={piece.chevrons.y} />
          )}
          {/* The stream never layers march light: its ink is on the chevron. */}
          {piece.ink === "march" && piece.kind !== "stream" ? (
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
 * Dots (with a branch): still a DOM span — status classes, halo and pulse in CSS — just absolutely
 * positioned onto their own rail's row instead of following the header.
 */
export function WorkflowTimelineLamps({
  draft,
  folded,
  layout,
  slide,
  stations,
}: {
  stations: readonly TimelineStation[];
  layout: TimelineLayout;
  folded: ReadonlySet<number>;
  draft: boolean;
  /** Fill growth (`use-fill-growth.ts`): dots right of the inserted column slide with their stations. */
  slide?: FillSlide;
}) {
  return (
    <>
      {stations.map((station, i) => (
        <span
          aria-hidden
          className={cn(
            stationLampClass(station.status, station.hole),
            "absolute",
            "wf-foldable",
            folded.has(i) && "wf-folded",
            draft && "wf-land",
            slideClass(i, slide),
          )}
          data-lamp={station.status ?? "pending"}
          data-lamp-track={station.track}
          key={station.id}
          style={{
            ...slideStyle(i, slide),
            left: lampX(i, layout.inset) - 5,
            top: (layout.rowY[station.track] ?? layout.rowY[0]!) - 5,
          }}
        />
      ))}
    </>
  );
}
