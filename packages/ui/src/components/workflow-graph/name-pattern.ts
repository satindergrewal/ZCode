import type { WorkflowCausalityGraphData } from "./types.js";

/**
 * The single render point for "names only take shape at runtime".
 *
 * Analysis yields shapes, not names: `` agent(`researcher${i + 1}`) `` cannot fold into 8
 * concrete names (that would require expanding the `map`, and `xN` exists precisely to
 * refuse expansion) — only the literals at both template ends are available. So the
 * projection carries the two affixes and the ellipsis is filled in **here**, same
 * reasoning as the anonymous-fallback copy (see the lane-name.ts header): projections are
 * memoized pure functions; copy and glyphs take shape at render time, projections hold
 * data only.
 *
 * An ellipsis (not `*` or `${…}`) is deliberate: it still reads as a name and introduces
 * no new visual vocabulary.
 */
const ELLIPSIS = "…";

/** The name shape of a lane / card; the shape comes from the protocol, not redefined here. */
export type NamePattern = NonNullable<WorkflowCausalityGraphData["lanes"][number]["namePattern"]>;

/**
 * `{head: "researcher"}` -> `researcher…`, `{tail: "-worker"}` -> `…-worker`, both -> `a…b`.
 *
 * With both affixes absent, return undefined instead of a lone `…`: the analyzer never
 * emits that, but contract-wise `{}` passes `.strict()` — without a guard here a
 * meaningless lone ellipsis would appear on screen.
 */
export function formatNamePattern(pattern: NamePattern | undefined): string | undefined {
  if (pattern === undefined) return undefined;
  const head = pattern.head ?? "";
  const tail = pattern.tail ?? "";
  if (head === "" && tail === "") return undefined;
  return `${head}${ELLIPSIS}${tail}`;
}
