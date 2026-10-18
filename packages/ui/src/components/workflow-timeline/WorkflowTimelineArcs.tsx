import type { ReactNode } from "react";
import type { TimelineArc, TimelineBand, TimelineInk, TimelineStation } from "./timeline-model.js";
import {
  ARC_BASE,
  ARC_LANE,
  arcEnds,
  arcTerminalOffsets,
  bandAt,
  bandForkX,
  bandMergeX,
  lampX,
  type TimelineLayout,
} from "./timeline-geometry.js";
import { MarchLight } from "./WorkflowMarchLight.js";
import { STREAM_GAP, StreamChevrons } from "./WorkflowStreamChevrons.js";

/**
 * Arc layer: the timeline's only SVG layer, drawing
 * non-adjacent edges only. From the source's dot up to its arc lane, across to the target, down onto
 * the target's dot, arrowhead down. A station's arc ends — landing and takeoff alike — each take a slot
 * at 10px spacing (`arcTerminalOffsets`: outgoing-left ends on the left, outgoing-right on the right,
 * a side's lowest lane outermost), so outgoing verticals never cross incoming arrows. On first appearance
 * it draws source to target (`pathLength=1` makes the dash offset geometry-free); after that only the ink
 * changes; a travelling edge layers still light (`MarchLight`: brightening toward the dot), motion left to
 * the dots.
 *
 * With a branch, the branch is one node: a source inside takes off from the branch's merge point, a
 * target inside lands on its fork point (landing pulled 4px early; no dot to rest on there). An arc's
 * height comes from its own air (`arc.air`): same-rail arcs inside a branch live in that rail's air;
 * cross-rail and branch-level arcs live in the topmost air. Rail segments move into this layer too
 * (`children`).
 *
 * A branch-level arc's verticals run all the way to the end's own row: a station source takes off from
 * its dot's row, a branch source from the main line's merge point; landing mirrors that — the main
 * line's fork point or the target's dot row. The Loops board's rule three has verticals cross the branch
 * rows via the columns those rows leave free — stopping at the topmost rail row crosses nothing and
 * instead leaves a whole empty row between the main line's dots and their arcs; it reads as broken. The
 * design-canvas generator stopping at `rowY[R−1]` was laziness, not design.
 */
const INK_STROKE: Record<TimelineInk, string> = {
  faint: "var(--color-workflow-trace)",
  march: "var(--color-workflow-trace-strong)",
  strong: "var(--color-workflow-trace-strong)",
};

export function WorkflowTimelineArcs({
  arcs,
  bands,
  children,
  height,
  layout,
  markerId,
  stations,
  width,
}: {
  arcs: readonly TimelineArc[];
  bands: readonly TimelineBand[];
  /** Every station (not the draft's sliced span): arc indices point into it; each station's rail gets read. */
  stations: readonly TimelineStation[];
  layout: TimelineLayout;
  width: number;
  height: number;
  markerId: string;
  children?: ReactNode;
}) {
  const terminals = arcTerminalOffsets(arcs, bands, stations);
  const { inset, rowY } = layout;
  const rowOf = (track: number): number => rowY[track] ?? rowY[0]!;
  const trackOf = (index: number): number => stations[index]?.track ?? 0;
  // The layer is decoration and takes no pointer events. Fix rationale (observed 2026-09-29): this SVG
  // covers the whole timeline and paints after the fill heads, swallowing every hover and click on the
  // head row — frames would not light, heads would not open the pane. Stations and pills paint above it,
  // which is why it went unnoticed.
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute left-0 top-0 overflow-visible"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      width={width}
    >
      <defs>
        {(["faint", "strong"] as const).map((ink) => (
          <marker
            id={`${markerId}-${ink}`}
            key={ink}
            markerHeight="6"
            markerWidth="6"
            orient="auto-start-reverse"
            refX="7"
            refY="4"
            viewBox="0 0 8 8"
          >
            <path d="M0,0.5 L7,4 L0,7.5 Z" fill={INK_STROKE[ink]} />
          </marker>
        ))}
      </defs>
      {children}
      {arcs.map((arc, j) => {
        // Same-rail arcs inside a branch live entirely in that rail's air, ends still on dots; every other arc treats the branch as one node (`arcEnds`).
        const { fromBand, toBand } = arcEnds(arc, bands, stations);
        const source = bandAt(bands, arc.from);
        const target = bandAt(bands, arc.to);
        const ly = rowOf(arc.air) - ARC_BASE - ARC_LANE * arc.lane;
        // Dot ends each take their slot; fork and merge points are a point, not a row of dots, and take no slot (offset always 0).
        const xa =
          fromBand && source !== undefined
            ? bandMergeX(source, inset)
            : lampX(arc.from, inset) + terminals.takeoff[j]!;
        const xb =
          toBand && target !== undefined
            ? bandForkX(target, inset)
            : lampX(arc.to, inset) + terminals.landing[j]!;
        const sign = xb < xa ? -1 : 1;
        // Takeoff and landing hug the end's own row: a branch is the main line's merge / fork point, a station its dot's row.
        const ya = fromBand ? rowY[0]! - 3 : rowOf(trackOf(arc.from)) - 7;
        const yb = toBand ? rowY[0]! - 4 : rowOf(trackOf(arc.to)) - 9;
        const tail = `V${yb}`;
        // Stream arc (presentation.md "Stream rails"): the horizontal breaks at center for chevrons facing along the arc.
        const mid = (xa + xb) / 2;
        const across = arc.stream
          ? `H${mid - (STREAM_GAP / 2) * sign} M${mid + (STREAM_GAP / 2) * sign},${ly} H${xb - 8 * sign}`
          : `H${xb - 8 * sign}`;
        const path = `M${xa},${ya} V${ly + 8} Q${xa},${ly} ${xa + 8 * sign},${ly} ${across} Q${xb},${ly} ${xb},${ly + 8} ${tail}`;
        const ink = arc.ink === "march" ? "strong" : arc.ink;
        return (
          <g
            data-arc-from={arc.from}
            data-arc-ink={arc.ink}
            data-arc-stream={arc.stream ? "true" : undefined}
            data-arc-to={arc.to}
            data-testid="workflow-timeline-arc"
            key={`${arc.from}-${arc.to}-${arc.air}`}
          >
            <path
              className="wf-ink wf-draw"
              d={path}
              fill="none"
              markerEnd={`url(#${markerId}-${ink})`}
              pathLength={1}
              stroke={INK_STROKE[ink]}
              strokeWidth={1}
            />
            {arc.stream ? (
              <StreamChevrons
                direction={sign < 0 ? "left" : "right"}
                ink={arc.ink}
                x={mid}
                y={ly}
              />
            ) : null}
            {arc.ink === "march" && !arc.stream ? (
              // The marching light stops 6px short, at the arrowhead's root.
              <MarchLight
                d={`${path.slice(0, -tail.length)}V${yb - 6}`}
                from={{ x: xa, y: ya }}
                id={`${markerId}-lit-${j}`}
                to={{ x: xb, y: yb - 6 }}
              />
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
