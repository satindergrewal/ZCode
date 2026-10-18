import { arcLaneCount } from "./timeline-bands.js";
import type { TimelineArc, TimelineBand, TimelineStation } from "./timeline-model.js";

/**
 * Geometry constants for the horizontal timeline. Verbatim from the design canvas:
 * station width 168, station gap 24, lamp at station left + 17 (pill avatar column). A separate file because the edge-gutter
 * geometry needs them, and it must not depend on render components in turn.
 */
export const STATION_WIDTH = 168;
export const STATION_GAP = 24;
export const STATION_PITCH = STATION_WIDTH + STATION_GAP;
/** Lamp center offset from the station's left edge: margin 12 + radius 5. */
export const MARK_X = 17;

/** Track row height. */
export const RAIL_ROW = 24;
/** Height step between adjacent arc lanes. */
export const ARC_LANE = 14;
/**
 * Height of the lowest arc lane above the track centerline. It must fit: corner radius 8 + the vertical landing segment (arrow 5.25 long,
 * plus a few px of straight line so the arrow reads as landing from above). Used to be 16: after 8 of corner radius the vertical had −1px left —
 * the last segment stepped up one pixel, `marker-end` pointed upward, and the arrow "vanished".
 */
export const ARC_BASE = 26;
/** Spacing between two adjacent arc terminals on the same lamp (takeoff or landing). */
export const TERMINAL_PITCH = 10;
export const PILL_HEIGHT = 32;
export const PILL_GAP = 6;

/**
 * Platform row: only timelines with bands have it,
 * 24px tall; station headers (name + meta) move here from the track row — the main line sits right above it, and only
 * branch-track stations need a leader line.
 */
export const PLATFORM_ROW = 24;
/** Left edge of the name on the platform: same as the lamp margin, so lamp, name and pill avatars form one vertical spine. */
export const CAPTION_X = 12;
/** Fork point distance from the first station's left edge; each higher branch track shifts 8 further left. */
export const FORK_BACK = 16;
/** Merge point distance from the merge station's left edge (negative = to its left). */
export const MERGE_BACK = 10;
/** Length of the tail stub when there is no predecessor, and of the stub when there is no merge station. */
export const TAIL = 4;
export const STUB = 6;

export function timelineWidth(count: number, inset = 0): number {
  return count === 0 ? 0 : (count - 1) * STATION_PITCH + STATION_WIDTH + inset;
}

/** Left edge of station i. */
export function stationX(index: number, inset = 0): number {
  return index * STATION_PITCH + inset;
}

/** Lamp center of station i. */
export function lampX(index: number, inset = 0): number {
  return stationX(index, inset) + MARK_X;
}

/** X where a band forks off the main line; when the band starts at station 0 there is no room to the left, so it lands at 4 (the whole timeline shifts right by `inset`). */
export function bandForkX(band: Pick<TimelineBand, "from">, inset = 0): number {
  return band.from === 0 ? TAIL : stationX(band.from, inset) - FORK_BACK;
}

/** X where a band merges back onto the main line; with no merge station it lands 6px past the last station's slot — still where the strands meet. */
export function bandMergeX(band: Pick<TimelineBand, "join" | "to">, inset = 0): number {
  return band.join === undefined
    ? stationX(band.to, inset) + STATION_WIDTH + STUB
    : stationX(band.join, inset) - MERGE_BACK;
}

/** The band containing station i; undefined outside bands (the same-named helper in `timeline-bands.ts` only knows index bands, this one knows model bands). */
export function bandAt(bands: readonly TimelineBand[], index: number): TimelineBand | undefined {
  return bands.find((band) => band.from <= index && index <= band.to);
}

/**
 * Where the two ends of an arc attach. An arc within one track of a band
 * attaches to lamps at both ends (`inTrack`); every other arc treats the band as one node: a source inside the band takes off from the band's merge point (`fromBand`), a target inside
 * lands on the band's fork point (`toBand`). A band's self-loop has both ends in the same band, but its `air` is the topmost layer
 * and its landing is always on track 0, so it is never mistaken for `inTrack`.
 */
export interface ArcEnds {
  inTrack: boolean;
  fromBand: boolean;
  toBand: boolean;
}

export function arcEnds(
  arc: Pick<TimelineArc, "air" | "from" | "to">,
  bands: readonly TimelineBand[],
  stations: readonly Pick<TimelineStation, "track">[],
): ArcEnds {
  const source = bandAt(bands, arc.from);
  const target = bandAt(bands, arc.to);
  const trackOf = (index: number): number => stations[index]?.track ?? 0;
  const inTrack =
    source !== undefined &&
    source === target &&
    trackOf(arc.from) === arc.air &&
    trackOf(arc.to) === arc.air;
  return {
    fromBand: !inTrack && source !== undefined,
    inTrack,
    toBand: !inTrack && target !== undefined,
  };
}

/**
 * Arc terminal slots: both ends of an arc on a lamp — the source station's **takeoff** and the target station's **landing** —
 * are this station's arc terminals. Each terminal takes one slot, pitch `TERMINAL_PITCH`, centered on the lamp; a station with a single terminal keeps
 * the lamp center, so conflict-free timelines stay pixel-identical.
 *
 * Previously only landings shifted while takeoffs always sat at the lamp center: with both incoming and outgoing arcs at one station, the outgoing
 * vertical crossed the incoming arrow — two verticals stacked, the arrow stuck mid-shaft (branches A/B of testfield's "workflow stress test"). Lanes separate
 * two arcs sharing a station along y, but do nothing along x.
 *
 * Slot order, left to right: first terminals whose far end is to this station's **left**, then those to the **right**; within each side the
 * lowest lane sits outermost**. An arc's vertical + horizontal is an L opening toward the far end: left-facing on the left, right-facing on the right; the two
 * Ls sit back to back and never meet; within one side, if the lower-bending arc sat innermost, the higher one's vertical would cross its horizontal —
 * the lane closed-interval argument rotated 90°. Band fork/merge points take no slot: only landings at a fork, only takeoffs at a merge; verticals at
 * the same point share one line like strands, never covering an arrow below.
 *
 * Returns two offset columns aligned with `arcs` (relative to lamp center, px); a side whose end is not a lamp is constant 0.
 */
export function arcTerminalOffsets(
  arcs: readonly Pick<TimelineArc, "air" | "from" | "lane" | "to">[],
  bands: readonly TimelineBand[],
  stations: readonly Pick<TimelineStation, "track">[],
): { takeoff: number[]; landing: number[] } {
  const takeoff = arcs.map(() => 0);
  const landing = arcs.map(() => 0);
  interface Terminal {
    arc: number;
    end: "takeoff" | "landing";
    /** −1 when the far end is to the left, 1 when to the right. */
    side: -1 | 1;
    lane: number;
  }
  const byStation = new Map<number, Terminal[]>();
  const add = (station: number, terminal: Terminal): void => {
    const list = byStation.get(station) ?? [];
    list.push(terminal);
    byStation.set(station, list);
  };
  arcs.forEach((arc, j) => {
    const ends = arcEnds(arc, bands, stations);
    if (!ends.fromBand) {
      add(arc.from, { arc: j, end: "takeoff", lane: arc.lane, side: arc.to > arc.from ? 1 : -1 });
    }
    if (!ends.toBand) {
      add(arc.to, { arc: j, end: "landing", lane: arc.lane, side: arc.from > arc.to ? 1 : -1 });
    }
  });
  for (const list of byStation.values()) {
    // Arcs in the same station and air layer pairwise intersect (closed intervals), so their lanes must differ; the stable sort keeps arc order as tiebreak.
    list.sort(
      (left, right) =>
        left.side - right.side || (left.side < 0 ? left.lane - right.lane : right.lane - left.lane),
    );
    list.forEach((terminal, k) => {
      const offset = (k - (list.length - 1) / 2) * TERMINAL_PITCH;
      if (terminal.end === "takeoff") takeoff[terminal.arc] = offset;
      else landing[terminal.arc] = offset;
    });
  }
  return { landing, takeoff };
}

/** The timeline's rows: each track's centerline, the platform row, the top of the pill column, and the global right shift. */
export interface TimelineLayout {
  /** Centerline y per track, index = track number; `rowY[0]` is the main line (the bottom row). */
  rowY: number[];
  /** Platform row centerline; without bands it degenerates to the main-line row — station headers still sit on the track row then. */
  capY: number;
  /** Top of the pill column. */
  pillsTop: number;
  /** How far the whole rail shifts right: 12 when a band starts at station 0 (the fork needs a foothold), else 0. */
  inset: number;
  /** There are bands on screen. */
  banded: boolean;
}

/**
 * Row layout: top-down `t = R−1 … 0`; each track
 * reserves its own **air** (arc lanes) first, then one 24px track row; the main line thus lands at the bottom, right above the platform row. Air is counted
 * by the arc count in that layer: the topmost layer keeps 6px of breathing room with no arcs, the rest 0. Without bands R = 1 and the whole formula
 * degenerates pixel-identically to the old "arc lanes + track row".
 */
export function timelineLayout(
  arcs: readonly TimelineArc[],
  bands: readonly TimelineBand[],
): TimelineLayout {
  const banded = bands.length > 0;
  const tracks = banded ? Math.max(2, ...bands.map((band) => band.tracks.length)) : 1;
  const rowY: number[] = [];
  let y = 0;
  for (let t = tracks - 1; t >= 0; t -= 1) {
    const lanes = arcLaneCount(arcs.filter((arc) => arc.air === t));
    // The topmost lane's top line lands at y = 8: rowY = air + RAIL_ROW/2 = 8 + ARC_BASE + ARC_LANE × (lanes − 1).
    const air =
      lanes === 0
        ? t === tracks - 1
          ? 6
          : 0
        : 8 + ARC_BASE - RAIL_ROW / 2 + ARC_LANE * (lanes - 1);
    y += air;
    rowY[t] = y + RAIL_ROW / 2;
    y += RAIL_ROW;
  }
  const capY = banded ? y + PLATFORM_ROW / 2 : rowY[0]!;
  if (banded) y += PLATFORM_ROW;
  return {
    banded,
    capY,
    inset: banded && bands.some((band) => band.from === 0) ? CAPTION_X : 0,
    pillsTop: y + 8,
    rowY,
  };
}
