import type { CSSProperties } from "react";
import { lampX, stationX, STATION_WIDTH } from "./timeline-geometry.js";

/**
 * Pure geometry of the edge ledges: one rail compressed at both ends.
 *
 * The timeline scrolls freely; stations whose lamps scroll past the viewport edge **fold** onto that side's ledge — the same 10px lamp, 16px apart,
 * joined by small rail segments of the same ink, on clean ground at the viewport edge. The track row fades over 40px near the ledge; pills only fade at the true viewport boundary.
 * Folding is a fixed point: the wider the ledge (more lamps), the more stations hide under it, so iterate until the set stops changing.
 *
 * Everything in viewport coordinates (x = station lamp center − scrollLeft). No React, no DOM.
 */
export const LEDGE_LAMP = 10;
export const LEDGE_PITCH = 16;
export const LEDGE_PAD = 8;
export const LEDGE_FADE = 40;
export const LEDGE_MAX_LAMPS = 3;
/** Width taken by the `+n` count. */
const LEDGE_MORE = 26;
/** A ledge-to-content rail segment shorter than this is not drawn (it would be a dot). */
const STUB_MIN = 6;
/** Minimum scrollbar thumb length. */
const THUMB_MIN = 24;

export interface TimelineFold {
  /** Stations folded to the left ledge (ascending). */
  left: number[];
  /** Stations folded to the right ledge (ascending). */
  right: number[];
}

export const NO_FOLD: TimelineFold = { left: [], right: [] };

/** Width of one side's ledge (including both paddings; 0 lamps = no ledge). */
export function ledgeWidth(count: number): number {
  if (count <= 0) return 0;
  const lamps = Math.min(count, LEDGE_MAX_LAMPS) * LEDGE_PITCH - (LEDGE_PITCH - LEDGE_LAMP);
  return LEDGE_PAD + lamps + (count > LEDGE_MAX_LAMPS ? LEDGE_MORE : 0) + LEDGE_PAD;
}

/**
 * The fold set: stations whose lamp sits under "ledge + fade`; iterate to a fixed point. When the viewport cannot be measured (width 0), fold nothing.
 * `keep` is the station the camera is flying toward: the viewport was measured before `scrollTo`, and during the flight's
 * few hundred ms it computes as out of view from the stale scrollLeft — yet it is about to come in; a lamp flashing on the ledge is a false positive, so neither side folds it.
 * `inset` is the whole rail's right shift when bands exist: lamps move with it, and so does the folding test.
 */
export function foldStations(
  count: number,
  scrollLeft: number,
  clientWidth: number,
  keep?: number,
  inset = 0,
): TimelineFold {
  if (count === 0 || clientWidth <= 0) return NO_FOLD;
  const xs = Array.from({ length: count }, (_, i) => lampX(i, inset) - scrollLeft);
  let left: number[] = [];
  let right: number[] = [];
  for (let pass = 0; pass < 8; pass += 1) {
    const lw = left.length === 0 ? 0 : ledgeWidth(left.length) + LEDGE_FADE;
    const rw = right.length === 0 ? 0 : ledgeWidth(right.length) + LEDGE_FADE;
    const nextLeft = xs.flatMap((x, i) => (x < lw && i !== keep ? [i] : []));
    const nextRight = xs.flatMap((x, i) =>
      x > clientWidth - rw && i !== keep && !nextLeft.includes(i) ? [i] : [],
    );
    if (nextLeft.length === left.length && nextRight.length === right.length) break;
    left = nextLeft;
    right = nextRight;
  }
  return left.length === 0 && right.length === 0 ? NO_FOLD : { left, right };
}

/** Lamps shown on a ledge (at most three, content-near end first) and the count. */
export function ledgeLamps(
  indexes: readonly number[],
  side: "left" | "right",
): { shown: number[]; more: number } {
  const more = Math.max(0, indexes.length - LEDGE_MAX_LAMPS);
  const shown =
    more === 0
      ? [...indexes]
      : side === "left"
        ? indexes.slice(more)
        : indexes.slice(0, LEDGE_MAX_LAMPS);
  return { shown, more };
}

/**
 * Width of the short rail segment between ledge and first open station: the left ledge runs from the ledge's inner edge to 6px before that station's lamp; the right ledge from the last
 * open station's **slot end** (not the lamp — otherwise it would cross the station header text) to the ledge's inner edge. Below 6, not drawn.
 */
export function ledgeStubWidth(
  fold: TimelineFold,
  side: "left" | "right",
  scrollLeft: number,
  clientWidth: number,
  inset = 0,
): number {
  const indexes = side === "left" ? fold.left : fold.right;
  if (indexes.length === 0) return 0;
  const inner = ledgeWidth(indexes.length) - LEDGE_PAD;
  let width: number;
  if (side === "left") {
    const open = indexes[indexes.length - 1]! + 1;
    width = lampX(open, inset) - scrollLeft - STUB_MIN - inner;
  } else {
    const open = indexes[0]! - 1;
    width = clientWidth - inner - (stationX(open, inset) + STATION_WIDTH - scrollLeft);
  }
  return width < STUB_MIN ? 0 : Math.round(width);
}

/** Whether content still hides beyond each side (left: scrolled past; right: not at the end yet). */
export interface EdgeOverflow {
  left: boolean;
  right: boolean;
}

/**
 * The scrolling layer's mask, in **two horizontal bands** (user revision: pills fade only at the true boundary, in step with their station's lamp):
 *   - rail band (arc air + track row, height `railBand`): fully transparent under a ledge, then 40px back to opaque — the ledge must land on
 *     clean ground; on a ledge-less but overflowing side, 40px fade from the viewport edge (no hard cut of header text).
 *   - pill band (the rest of the height): 40px fade at the viewport edge, and only when that side truly has content outside. Pills do not fold with lamps
 *     (symmetric sides), stay lit under the ledge, all the way to the boundary.
 * Each mask layer takes one band (no-repeat, sliced by position / size); default add compositing = union. With no overflow on either side, no mask.
 */
export function timelineMaskStyle(
  fold: TimelineFold,
  railBand: number,
  edges: EdgeOverflow,
): CSSProperties | undefined {
  if (!edges.left && !edges.right) return undefined;
  const edgeLeft = edges.left ? `transparent 0px, #000 ${LEDGE_FADE}px` : "#000 0px";
  const edgeRight = edges.right
    ? `#000 calc(100% - ${LEDGE_FADE}px), transparent 100%`
    : "#000 100%";
  const railLeft =
    fold.left.length > 0
      ? `transparent ${ledgeWidth(fold.left.length) + LEDGE_PAD}px, #000 ${ledgeWidth(fold.left.length) + LEDGE_PAD + LEDGE_FADE}px`
      : edgeLeft;
  const railRight =
    fold.right.length > 0
      ? `#000 calc(100% - ${ledgeWidth(fold.right.length) + LEDGE_PAD + LEDGE_FADE}px), transparent calc(100% - ${ledgeWidth(fold.right.length) + LEDGE_PAD}px)`
      : edgeRight;
  const image = `linear-gradient(90deg, ${railLeft}, ${railRight}), linear-gradient(90deg, ${edgeLeft}, ${edgeRight})`;
  const size = `100% ${railBand}px, 100% calc(100% - ${railBand}px)`;
  const position = `0 0, 0 ${railBand}px`;
  return {
    WebkitMaskImage: image,
    WebkitMaskPosition: position,
    WebkitMaskRepeat: "no-repeat, no-repeat",
    WebkitMaskSize: size,
    maskImage: image,
    maskPosition: position,
    maskRepeat: "no-repeat, no-repeat",
    maskSize: size,
  };
}

/** Scrollbar thumb: length = viewport² / content (at least 24), position by scroll ratio; absent without overflow. */
export function scrollbarThumb(
  scrollLeft: number,
  clientWidth: number,
  scrollWidth: number,
): { left: number; width: number } | undefined {
  if (clientWidth <= 0 || scrollWidth <= clientWidth) return undefined;
  const width = Math.max(THUMB_MIN, (clientWidth * clientWidth) / scrollWidth);
  const range = scrollWidth - clientWidth;
  const left = ((clientWidth - width) * Math.min(Math.max(scrollLeft, 0), range)) / range;
  return { left: Math.round(left), width: Math.round(width) };
}

/**
 * One leg of the camera's flight: `scrollTo(target)` sent, not yet landed. While flying, `index` does not fold.
 * `from` is the previous sampled scrollLeft — smooth scrolling only approaches the target monotonically, so "farther than last time" means the user took over.
 */
export interface CameraFlight {
  index: number;
  /** Landing clamped by `scrollWidth − clientWidth`. */
  target: number;
  from: number;
}

/**
 * After one scroll sample, is the flight still on: landed (±1px) or veered off (user took over) ends it; otherwise record this position and keep flying.
 * Position only, no timers — a user-interrupted smooth scroll never reaches its target, and a timer fallback would make the target station miss its fold.
 */
export function flightAfterScroll(
  flight: CameraFlight | undefined,
  scrollLeft: number,
): CameraFlight | undefined {
  if (flight === undefined) return undefined;
  const distance = Math.abs(scrollLeft - flight.target);
  if (distance <= 1) return undefined;
  if (distance > Math.abs(flight.from - flight.target) + 1) return undefined;
  return scrollLeft === flight.from ? flight : { ...flight, from: scrollLeft };
}

/** Camera: the scrollLeft that centers a station (never below 0 at the left end). Tapping a ledge lamp takes this path. */
export function stationCameraLeft(index: number, clientWidth: number, inset = 0): number {
  return Math.max(0, stationX(index, inset) - (clientWidth - STATION_WIDTH) / 2);
}

/**
 * Rail-segment lookup key: a **pair of stations**, not the start. One station in a band can grow several segments at once —
 * one on the main line, one forked, one twin — keyed by start you would get whichever sorted first.
 */
export function railKey(from: number, to: number): string {
  return `${from}>${to}`;
}
