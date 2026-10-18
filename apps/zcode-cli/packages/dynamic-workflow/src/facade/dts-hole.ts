/**
 * The facade's hole segment (docs/dynamic-workflow/authoring.md "Holes: `hole<T>()`"): typed
 * gaps.
 *
 * A separate module only because dts.ts sits at the max-lines cap (prose inside template
 * literals counts as code lines); the contract is unchanged: dts.ts concatenates this segment
 * into `FACADE_DTS` — **the full facade only, never the snippet facade** (a snippet has no run,
 * hence nothing for the main agent to fill). tests/facade-dts.test.ts pins the concatenation by
 * sha256. The segment starts and ends with a single newline, like every other segment.
 */

/**
 * The hole primitive: `hole<T>(name, prompt?, body?)`. Three overloads for the three shapes —
 * an open gap (name + optional prompt), a filled gap (name + body), or both. At run time it is
 * one Boundary A call (`__host.hole`); the site id is the name key `hole#<hash>`
 * (analysis/hole-id.ts); the body is evaluated **in place** inside the cell, see
 * execution-engine.md "The vm cell". All compile-time rules live in 9012
 * (analysis/hole-sites.ts).
 */
export const FACADE_HOLE_SEGMENT = String.raw`
/**
 * A typed gap: code you write later, once an earlier step's findings are in. When the run
 * reaches an unfilled hole, that branch waits while you write the body (FillWorkflowHole);
 * the rest of the run keeps going. prompt is the message you will receive, so interpolate
 * the values the decision needs. The body runs in the hole's place, sees the bindings
 * declared before it, and returns the hole's value. The filled form passes the body last.
 */
declare function hole<T>(name: string, prompt?: string): Promise<T>;
declare function hole<T>(name: string, body: () => Promise<T>): Promise<T>;
declare function hole<T>(name: string, prompt: string, body: () => Promise<T>): Promise<T>;
`;
