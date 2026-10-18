/**
 * The marching edge's light: the edge control flow took into the running station, drawn
 * as a 1.5px round-capped path with a `userSpaceOnUse` gradient stroke — transparent at
 * the path's start, full warning color by 80% — brightest at the lamp, fading back along
 * the direction it came from, as if the lamp lit its own approach. It is static: the
 * marching edge speaks of the past (flow already traveled it); motion belongs to the
 * running lamp's `wf-lamp-running` pulse. The former rolling dashed overlay read as
 * "still en route from the previous station".
 *
 * The gradient runs along x (the path's end-to-end x); every arc, fork, and merge on the
 * timeline is horizontal but for two stub verticals, so that suffices. Paths with equal
 * end x (none today, guarded anyway) flip to y. `id` comes from the caller and must be
 * unique within the SVG.
 */
export interface MarchLightProps {
  /** Path to light; arcs pass the 6px-shortened variant that stops at the arrowhead's base. */
  d: string;
  /** Path start (where the control flow came from). */
  from: { x: number; y: number };
  /** Path end (the running lamp's side). */
  to: { x: number; y: number };
  id: string;
}

export function MarchLight({ d, from, id, to }: MarchLightProps) {
  const alongY = from.x === to.x;
  return (
    <>
      <defs>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id={id}
          x1={alongY ? 0 : from.x}
          x2={alongY ? 0 : to.x}
          y1={alongY ? from.y : 0}
          y2={alongY ? to.y : 0}
        >
          <stop offset={0} stopColor="var(--color-warning)" stopOpacity={0} />
          <stop offset={0.8} stopColor="var(--color-warning)" />
        </linearGradient>
      </defs>
      <path
        className="wf-lit"
        d={d}
        data-testid="workflow-march-light"
        fill="none"
        stroke={`url(#${id})`}
      />
    </>
  );
}
