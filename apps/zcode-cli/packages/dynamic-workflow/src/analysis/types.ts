import type { ScriptLoc } from "../compiler/compile.js";

/**
 * The site-graph types: the may-flow digraph over facade call sites emitted by the
 * analyzer. This module is the
 * shared vocabulary; the taint pass (later step) fills in the edges.
 */

/**
 * A node kind. `source`/`sink` are the two virtual endpoints; the rest are facade
 * call sites. `fan-out` nodes are only emitted by the taint pass once an iteration
 * candidate is shown to reach a facade site — this substrate never produces them.
 */
export type SiteKind = "ask" | "world-read" | "join" | "fan-out" | "hole" | "source" | "sink";

/** A 1-based, prelude-stripped location in the author's script. */
export type SiteLoc = ScriptLoc;

/**
  * When the name only materializes at runtime (a template receiver), the statically knowable shape:
  * the literal before the first hole (head) and after the last hole (tail).
 *
  * Why only the shape: folding the template into 8 concrete names would require expanding the map, and xN /
  * maybe stack exist precisely to refuse expansion. So this is a shape, never names.
 *
  * Invariants: at least one of head/tail present (else undefined, never an empty pattern), both trimmed,
  * each with at least one letter or digit -- a trailing-dash-only affix renders worse than unnamed-actor, so it is dropped.
  * The ellipsis is added at **render time**; this only carries data.
 */
export interface NamePattern {
  head?: string;
  tail?: string;
}

/**
 * A graph node. The virtual `source`/`sink` carry no location and a fixed label;
 * a `hole` node is an OPEN `hole<T>()` site (docs/analysis.md「Sites」): its label is the
 * hole's name, its prompt is a sink and its result a value of type T from outside the run;
 * every other node is positioned at its facade call site. `actors` is populated for
 * `ask` nodes only: the may-set of actor site ids the ask's receiver resolves to
 * (the same set that drives the context relation), so the renderer can place the
 * node in its actor lane(s). Ordered by actor source order, deduped. `within` is the
 * id of the nearest enclosing promoted fan-out node when the site's call lies
 * lexically inside a promoted iteration candidate's body — the site then executes
 * once per element;
 * omitted otherwise. `artifactType` is the producer's statically known artifact type
 * (a human-readable type name, provenance semantics) for `ask`/`world-read`/`join`/
 * `fan-out` nodes; absent on the virtual endpoints and when the type is
 * unknowable/uninformative (`any`/`unknown`/`never`/`void`).
 */
export interface SiteNode {
  id: string;
  kind: SiteKind;
  loc?: SiteLoc;
  label: string;
  /**
      * When label only gets the fallback string (an inline agent(...).ask(...) whose receiver is a call expression,
      * neither literal nor identifier, hence ask): the template's static shape. Only ask nodes carry it.
   */
  labelPattern?: NamePattern;
  actors?: string[];
  within?: string;
  artifactType?: string;
}

/**
 * An actor (`agent()` site). Rendered as a lane, not a graph node. `within` is the
 * id of the nearest enclosing promoted fan-out when the `agent()` call lies inside
 * that fan-out's body: a lane FAMILY (one fresh actor per element) rather than a
 * single shared lane. Omitted for actors created outside any fan-out.
 */
export interface ActorSite {
  id: string;
  loc: SiteLoc;
  name?: string;
  /**
      * When name is absent (agent()'s first arg not a literal) but that arg is a template: the static shape. In practice
      * exclusive with name: literals give names, templates shapes. **Deliberately not written into name** --
      * name's contract is the author's verbatim word; mixing in reconstructions would blur literal-vs-inferred forever.
   */
  namePattern?: NamePattern;
  within?: string;
}

/**
 * A may-flow edge: "the output of `from` may feed `to`". `data` edges carry
 * artifacts; `context` edges relate asks sharing an actor. `exact` is false once
 * any widening rule fired along the witness path. `port` records a join input /
 * element position when the join argument is a static array literal. `type` is the
 * producer's artifact type name (provenance: the value feeding `to` was computed from
 * `from`'s output), port-refined for edges OUT OF a join; absent on context edges,
 * source-completion edges, and when the type is unknowable/uninformative.
 */
export interface SiteEdge {
  from: string;
  to: string;
  kind: "data" | "context";
  exact: boolean;
  port?: number;
  type?: string;
}

export interface SiteGraph {
  nodes: SiteNode[];
  actors: ActorSite[];
  edges: SiteEdge[];
}
