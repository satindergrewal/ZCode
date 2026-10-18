import type { TimelineStation } from "./timeline-model.js";
import { fillContains, type HoleParents, type TimelineFill } from "./timeline-holes.js";
import {
  HEAD_ROW,
  MARK_X,
  RAIL_ROW,
  STATION_WIDTH,
  stationX,
  type TimelineLayout,
} from "./timeline-geometry.js";

/**
 * The fill frame (docs/dynamic-workflow/presentation.md "Holes on the timeline", "Filled with phases" and
 * "The stroke"): a 1px line, radius 8, enclosing what one fill wrote, drawn only while the pointer rests
 * on its head (or keyboard focus is there); for two seconds after the fill joins the run it draws itself.
 * The line is one stroke: from its start on the top edge, clockwise around, back to the start — with a
 * head it starts at the pen's x (the head is the legend; the line emerges at the name's right end and
 * closes on the pen), without one it starts top left. Pure geometry, no React, no DOM.
 *
 * Fix rationale (observed 2026-09-29): the earlier region was a tinted fill that lit for any station /
 * pill under the pointer, flickering across the card; nested fills stacked into two shades like panels;
 * the pane had nothing at all.
 */

/** How far the frame overshoots its columns, each side. */
export const FRAME_OUTSET = 8;
/** How much each nesting layer insets same-origin frames. */
export const FRAME_NEST_INSET = 4;
/** The frame's corner radius. */
export const FRAME_RADIUS = 8;
/** The gap the head row leaves for the line, each side. */
export const FRAME_LEGEND_GAP = 4;

/** The frame's bounding rect (integer pixels); `start` is the pen's x on the top edge; absent starts top left. */
export interface FrameBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  start?: number;
}

export interface TimelineFrame {
  holeId: string;
  box: FrameBox;
  /** The fill's moment: freshness (two seconds) runs from it. */
  filledAt?: number;
}

/**
 * The one-stroke path: from `start` on the top edge, rightward, clockwise around, back to `start`. A
 * 1px line stays crisp only on a half pixel: inset the rect half a pixel. The caller passes
 * `pathLength` 1; the dash offset running 1 to 0 is drawn.
 */
export function framePath(box: FrameBox, radius = FRAME_RADIUS): string {
  const x0 = box.x0 + 0.5;
  const y0 = box.y0 + 0.5;
  const x1 = box.x1 - 0.5;
  const y1 = box.y1 - 0.5;
  const r = Math.max(0, Math.min(radius, (x1 - x0) / 2, (y1 - y0) / 2));
  const start = Math.min(Math.max(box.start ?? x0 + r, x0 + r), x1 - r);
  return [
    `M${start},${y0}`,
    `H${x1 - r}`,
    `Q${x1},${y0} ${x1},${y0 + r}`,
    `V${y1 - r}`,
    `Q${x1},${y1} ${x1 - r},${y1}`,
    `H${x0 + r}`,
    `Q${x0},${y1} ${x0},${y1 - r}`,
    `V${y0 + r}`,
    `Q${x0},${y0} ${x0 + r},${y0}`,
    `H${start}`,
  ].join(" ");
}

/** Phase-less fills: hole stations carrying a pen mark, absent from `fills` (their frames enclose their own column). */
export interface FillMark {
  holeId: string;
  index: number;
  filledAt?: number;
}

export function fillMarksOf(
  stations: readonly Pick<TimelineStation, "hole">[],
  fills: readonly Pick<TimelineFill, "holeId">[],
): FillMark[] {
  const headed = new Set(fills.map((fill) => fill.holeId));
  return stations.flatMap((station, index) => {
    const hole = station.hole;
    if (hole?.state !== "filled" || headed.has(hole.siteId)) return [];
    return [
      {
        holeId: hole.siteId,
        index,
        ...(hole.filledAt === undefined ? {} : { filledAt: hole.filledAt }),
      },
    ];
  });
}

/** How many fills share the fill's first column while enclosing it: frames inset per layer. */
function sameStartDepth(
  fill: TimelineFill,
  fills: readonly TimelineFill[],
  parents: HoleParents,
): number {
  return fills.filter(
    (other) =>
      other.holeId !== fill.holeId &&
      other.from === fill.from &&
      fillContains(other.holeId, fill.holeId, parents),
  ).length;
}

/** How many fills enclose `holeId` (the pane's frame insets by it). */
export function fillDepthOf(
  holeId: string,
  fills: readonly Pick<TimelineFill, "holeId">[],
  parents: HoleParents,
): number {
  return fills.filter(
    (other) => other.holeId !== holeId && fillContains(other.holeId, holeId, parents),
  ).length;
}

/**
 * The card's frame. Headed fill: x from first column left − 8 to last column right + 8, y from the head
 * row's middle to 8px under its tallest pill column (columns without pills — a collapsed card, say —
 * stop 4px under the rail / platform row); same-origin nested frames inset 4px left, right and bottom
 * per layer. Phase-less: its own column, 4px over the rail row to 8px under its pill, starting top left.
 * Always clamped to the timeline canvas (else the scroll layer clips half a line off the first and last
 * columns' frames).
 */
export function timelineFrames({
  columnHeight,
  fills,
  height,
  inset,
  layout,
  parents,
  stations,
  width,
}: {
  fills: readonly TimelineFill[];
  stations: readonly Pick<TimelineStation, "hole" | "track">[];
  layout: Pick<TimelineLayout, "pillsTop" | "rowY">;
  /** Station i's pill-column height (0 with none). */
  columnHeight: (index: number) => number;
  height: number;
  width: number;
  inset: number;
  parents: HoleParents;
}): TimelineFrame[] {
  const bottomOf = (from: number, to: number): number => {
    let tallest = 0;
    for (let i = from; i <= to; i += 1) tallest = Math.max(tallest, columnHeight(i));
    // Pill-column top = rail (or platform) row bottom + 8, so with no pills pillsTop − 4 is 4px under that row.
    return tallest > 0 ? layout.pillsTop + tallest + FRAME_OUTSET : layout.pillsTop - 4;
  };
  const clamp = (box: FrameBox): FrameBox => ({
    ...box,
    x0: Math.max(0, box.x0),
    x1: Math.min(width, box.x1),
    y0: Math.max(0, box.y0),
    y1: Math.min(height, box.y1),
  });
  const frames: TimelineFrame[] = fills.map((fill) => {
    const k = sameStartDepth(fill, fills, parents) * FRAME_NEST_INSET;
    return {
      holeId: fill.holeId,
      box: clamp({
        x0: stationX(fill.from, inset) - FRAME_OUTSET + k,
        x1: stationX(fill.to, inset) + STATION_WIDTH + FRAME_OUTSET - k,
        y0: HEAD_ROW / 2,
        y1: bottomOf(fill.from, fill.to) - k,
        start: stationX(fill.from, inset) + MARK_X,
      }),
      ...(fill.filledAt === undefined ? {} : { filledAt: fill.filledAt }),
    };
  });
  for (const mark of fillMarksOf(stations, fills)) {
    const rowY = layout.rowY[stations[mark.index]?.track ?? 0] ?? layout.rowY[0]!;
    frames.push({
      holeId: mark.holeId,
      box: clamp({
        x0: stationX(mark.index, inset) - FRAME_OUTSET,
        x1: stationX(mark.index, inset) + STATION_WIDTH + FRAME_OUTSET,
        y0: rowY - RAIL_ROW / 2 - 4,
        y1: bottomOf(mark.index, mark.index),
      }),
      ...(mark.filledAt === undefined ? {} : { filledAt: mark.filledAt }),
    });
  }
  return frames;
}

/** The head row's cut-out in the top edge (the legend): one rectangle per row, 4px clearance a side. No cut when the width is unmeasurable (0). */
export function legendGaps(
  rows: readonly { left: number; width: number }[],
): { x: number; width: number }[] {
  return rows
    .filter((row) => row.width > 0)
    .map((row) => ({ x: row.left - FRAME_LEGEND_GAP, width: row.width + 2 * FRAME_LEGEND_GAP }));
}

/**
 * The pane's frame: x from 8 to list right − 12, inset 4px per nesting layer; a titled fill runs from
 * the title's middle to 4px under its last section, pen start at the rail's x (21 — the pen covers that
 * stretch); a phase-less fill encloses its own section, 2px inset top and bottom, starting top left.
 * Vertical positions come from the caller measuring the DOM (section expand / collapse moves them).
 */
export const SPINE_FRAME_LEFT = 8;
export const SPINE_FRAME_RIGHT = 12;
export const SPINE_RAIL_X = 21;

export function spineFrameBox({
  bottom,
  depth,
  headed,
  top,
  width,
}: {
  /** Top of the title row (headed) or of the section (headless), relative to list content. */
  top: number;
  /** Bottom of the last section. */
  bottom: number;
  width: number;
  depth: number;
  headed: boolean;
}): FrameBox {
  const k = depth * FRAME_NEST_INSET;
  return headed
    ? {
        x0: SPINE_FRAME_LEFT + k,
        x1: width - SPINE_FRAME_RIGHT - k,
        y0: Math.round(top + HEAD_ROW / 2),
        y1: Math.round(bottom + 4),
        start: SPINE_RAIL_X,
      }
    : {
        x0: SPINE_FRAME_LEFT + k,
        x1: width - SPINE_FRAME_RIGHT - k,
        y0: Math.round(top + 2),
        y1: Math.round(bottom - 2),
      };
}
