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

/**
 * The arc layer: the timeline's single SVG layer, drawing only
 * non-adjacent edges. Up from the source's lamp into its air lane, across to the target, down onto the target's lamp, arrow pointing down. A station's arc terminals —
 * landing and takeoff alike — each take one slot, 10px apart (`arcTerminalOffsets`: far-end-left on the left, far-end-right on the right,
 * within each side the lowest lane outermost), so an outgoing vertical never crosses an incoming arrow. On first appearance, drawn from source to target
 (`pathLength=1` makes dashoffset geometry-independent); afterwards only the ink changes; the traveling edge adds a motionless light
 (`MarchLight`: brightening toward the lamp); the motion belongs to the lamp alone.
 *
 * With bands, a band is **one node**: a source inside takes off from the band's merge point, a target inside
 * lands on the band's fork point (landing pulled 4px earlier — no lamp to rest on there). An arc's height comes from its own **air** (`arc.air`): same-track
 * arcs live in that track's air; cross-track and band-level arcs always in the topmost air. Rail segments move into this layer too (`children`).
 *
 * Band-level arcs run their verticals all the way to the **endpoint's own row**: a station source takes off from its lamp's row, a band source from the merge point
 * on the main line; landings likewise — the main line's fork point or the target lamp's row. The Loops board's rule three says verticals "cross branch rows through their
 * empty columns" — stopping beside the topmost track row would cross nothing, while between a main-line lamp and its arc a whole row would gape,
 * reading as disconnected. The design canvas's generator stopping at `rowY[R−1] is laziness, not design.
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
  /** All stations (not just the draft-cut prefix): arc indices point into it, and every station's track must be readable. */
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
  return (
    <svg
      aria-hidden
      className="absolute left-0 top-0 overflow-visible"
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
        // An arc within one track of a band lives entirely in that track's air, both ends lamps; every other arc treats the band as one node (`arcEnds`).
        const { fromBand, toBand } = arcEnds(arc, bands, stations);
        const source = bandAt(bands, arc.from);
        const target = bandAt(bands, arc.to);
        const ly = rowOf(arc.air) - ARC_BASE - ARC_LANE * arc.lane;
        // Lamp-bound ends each take their slot; fork and merge are points, not rows of lamps, and take no slot (offset constant 0).
        const xa =
          fromBand && source !== undefined
            ? bandMergeX(source, inset)
            : lampX(arc.from, inset) + terminals.takeoff[j]!;
        const xb =
          toBand && target !== undefined
            ? bandForkX(target, inset)
            : lampX(arc.to, inset) + terminals.landing[j]!;
        const sign = xb < xa ? -1 : 1;
        // Takeoff and landing hug the **endpoint's own row**: a band is the merge / fork point on the main line, a station its lamp's row.
        const ya = fromBand ? rowY[0]! - 3 : rowOf(trackOf(arc.from)) - 7;
        const yb = toBand ? rowY[0]! - 4 : rowOf(trackOf(arc.to)) - 9;
        const tail = `V${yb}`;
        const path = `M${xa},${ya} V${ly + 8} Q${xa},${ly} ${xa + 8 * sign},${ly} H${xb - 8 * sign} Q${xb},${ly} ${xb},${ly + 8} ${tail}`;
        const ink = arc.ink === "march" ? "strong" : arc.ink;
        return (
          <g
            data-arc-from={arc.from}
            data-arc-ink={arc.ink}
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
            {arc.ink === "march" ? (
              // The traveling edge's light is 6px short at the end, stopping at the arrow's root.
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
