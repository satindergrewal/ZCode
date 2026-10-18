import type { RegionKind } from "./constants.js";
import type { OrderKind } from "./causality-reduce.js";
import type { SiteLoc, NamePattern } from "./types.js";

// causality-graph.ts sat at oxlint's max-lines cap (400); the causal graph's public types
// (Step / Region / OrderEdge / Lane / Phase / CausalityGraph and the three lane constants) and the internal
// Fact moved here; the public surface still exports from causality-graph.ts (re-exported verbatim there). No
// typescript import, so the browser-side projections barrel reaches it safely.

/** `hole`: an OPEN `hole<T>()` — the script waits there for the main agent's fill. */
export type StepKind = "ask" | "world-read" | "hole";
export type Certainty = "always" | "maybe";

/** The single lane every `files.*` read runs in. */
export const WORKSPACE_LANE = "workspace";
/** The main agent's lane: where every open hole waits (docs/analysis.md「Sites」). */
export const MAIN_LANE = "main";
/** Lane of an ask whose receiver the analysis could not resolve to any actor site. */
export const UNKNOWN_LANE = "unknown";
/** The terminal marker: the artifact the script returns. */
export const SINK_ID = "sink";

export interface Step {
  /** A site id (`ask#3`, `world-read#1`); it is also the runtime instance's key. */
  id: string;
  kind: StepKind;
  label: string;
  /** When label only gets the fallback string: the inline agent() receiver's template shape. */
  labelPattern?: NamePattern;
  loc: SiteLoc;
  /** Actor site id, or `workspace` / `unknown`. For an unexpanded may-set, `lanes[0]`. */
  lane: string;
  /** Present only when the ask receiver is dynamically selected: the candidate lanes. */
  lanes?: string[];
  /**
   * The step this one was expanded from, emitted only on a may-set copy (see
   * `expandMaySetLanes` in causality-graph-lanes.ts). It is the site id a runtime instance
   * actually reports, which is what makes it the live overlay's join key (`source ?? id`
   * against `node.siteId`, narrowed by `node.actorSiteId === lane`).
   *
   * This composes with future per-callsite specialization rather than competing with it. Once
   * specialization lands, the expanded-from id IS the specialized site id —
   * `ask#3/2~actor#1` carries source `ask#3/2` — so the join stays stable under both
   * features. On a copy the field means "the site the runtime reports", NOT "the site
   * before specialization".
   */
  source?: string;
  /** Innermost enclosing region id. */
  region: string;
  certainty: Certainty;
  /**
   * The author-declared phase this step belongs to (`phase#2`, or the reserved
   * `unphased`). Present only when the script declares at least one `phase()` marker, in
   * which case EVERY step carries one — a step claimed by k>1 phases is expanded into k
   * copies to keep the partition total (see phase-graph.ts).
   */
  phase?: string;
  /**
   * How this step's instances relate when an enclosing region repeats:
   *   `stack`  — they coexist, which is the one multiplicity cue (stacked cards);
   *   `serial` — they follow one another, already visible as the cycle-closing arrow.
   * Absent when the step runs at most once. Finding: the cue splits on
   * CONCURRENCY, not cardinality — a step is `serial` exactly when a barrier inside
   * the repeating region settles it, or when a fixed actor's mailbox serializes it.
   */
  repeat?: "stack" | "serial";
  /**
   * The filled hole whose body wrote this step: the `hole#<hash>/` prefix of its site id, or,
   * for an open hole (whose id is a bare name key), the site table's `fill`. Absent outside
   * every fill.
   */
  fill?: string;
}

export interface Region {
  id: string;
  kind: RegionKind;
  parent?: string;
  loc?: SiteLoc;
  /** Derivable literal round count of a `for`; model-only, never displayed. */
  bound?: number;
  label?: string;
}

export interface OrderEdge {
  from: string;
  to: string;
  kind: OrderKind;
  certainty: Certainty;
  /** `data` edges only: the taint witness path's exactness bit. Model-only. */
  exact?: boolean;
}

export interface Lane {
  id: string;
  /** The author's verbatim word, when `agent()` was given a literal. Never a reconstruction. */
  name?: string;
  /**
   * Static shape of the name when name is absent and agent()'s first arg is a holey template. The ellipsis is render-time.
   */
  namePattern?: NamePattern;
  loc?: SiteLoc;
  /**
   * Enclosing iteration regions of the `agent()` call, outermost first. A non-empty
   * list makes the lane a family — one fresh actor per element — and nested iterations
   * MULTIPLY, so multiplicity is the product and a single id cannot express it.
   */
  families?: string[];
}

/**
 * An author-declared phase: a name for a group of steps, and the position of the marker
 * that opened it. The synthetic fallback `unphased` carries neither — the UI shows a
 * localized word for it, exactly as it does for the `workspace` / `unknown` lanes.
 */
export interface Phase {
  id: string;
  name?: string;
  loc?: SiteLoc;
  /** The filled hole whose body wrote this phase (a filled hole's own phase names itself). */
  fill?: string;
}

export interface CausalityGraph {
  steps: Step[];
  regions: Region[];
  lanes: Lane[];
  edges: OrderEdge[];
  /** Step ids whose artifacts reach the script's return; absent when it returns nothing. */
  sink?: { fedBy: string[] };
  /**
   * The phase vocabulary, present TOGETHER WITH `phaseEdges` and `Step.phase` or not at
   * all: a script with no `phase()` markers gets none of the three and its graph is
   * byte-identical to what it was before the feature. `unphased` first when it has
   * members, then the author's phases in first-reach order.
   */
  phases?: Phase[];
  /** The quotient of `edges` by the phase partition. Never carries `exact`. */
  phaseEdges?: OrderEdge[];
}

/** Ordered facts inside the projection (inputs to dedupe, back-edge typing, reduction); not on the package's public face. */
export interface Fact {
  from: string;
  to: string;
  kind: OrderKind;
  certainty: Certainty;
  exact?: boolean;
  /** The carry edge's underlying kind (the forward kind before retyping); carry minimization judges witness strength by it. */
  carryOf?: Exclude<OrderKind, "carry">;
  /**
   * Phase set of the issue events witnessing this fact (carried only by **seq facts born of await barriers**).
   * Phase copies narrow an edge's head with it: a barrier fact is witnessed on one concrete issue, while the current
   * one-site-one-step design merges a site's issues across call sites into one step; losing the provenance would
   * let the gate's bench-before-cargo-test claim also hold for the preflight bench --
   * a backwards time claim (extra order is allowed; wrong order is not).
   *
   * Absent = no provenance = the head fully expanded (data/control/fifo and region-dup facts expand per contract).
   *
   * The tail has no symmetric provenance (settle events carry no phase), but **the tail side is no longer a gap**: the phase copy's temporal
   * feasibility check (admits in phase-graph.ts) intercepts by position on **both ends** alike, so pseudo-edges like a copy placed
   * before the step producing its own argument are removed by that rule, not by provenance here.
   */
  toPhases?: Set<string>;
  /**
   * This seq fact can only hold via the **next round**: from is emitted in an arm ending in continue,
   * to later in the same loop body. A linear time walk under may-semantics would keep walking the body, recording
   * fixer-round-k before juries-round-k-plus-one as same-round forward order; the control-flow projection says loop-via-continue for the same spot.
   * Facts with this mark are treated as carry at back-edge typing (only when every fact in the pair carries it --
   * see dedupeFacts in causality-graph-lanes.ts). Arms ending in break are stronger: their steps cannot
   * precede later steps of the same loop at all, so such facts are not emitted.
   */
  viaJump?: true;
}
