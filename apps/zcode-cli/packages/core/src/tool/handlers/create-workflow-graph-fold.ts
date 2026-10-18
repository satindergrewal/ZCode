// ============================================================
// Phase-edge folding and reduction -- the only edge-deletion point in the display graph's phase layer.
// ============================================================
// Split from create-workflow-graph-bounds.ts: folding itself is self-contained pure graph theory (ordered-pair
// folding + SCCs + reduction over quotient nodes), while the rest of the trim layer is referential integrity
// and caps. Split out, this logic can be read and pinned alone, and bounds keeps max-lines headroom.

import {
  reduceOrdering,
  type ReducibleEdge,
  // Same reason as bounds: the /projections subpath, not the root bucket -- the root bucket drags the
  // TypeScript compiler into the browser bundle (portfolio replay reuses this path in the browser).
} from "@zcode/dynamic-workflow/projections";

/** One edge before folding: kind already collapsed to "is a back edge". */
export interface RawEdge {
  from: string;
  to: string;
  back: boolean;
}

/**
 * Phase-edge folding (handoff edges arrive already reduced by the analyzer's own algorithm; untouched here):
 *
 * 1. One ordered pair folds into one edge (first-seen order); `back` iff **all** pre-fold edges are back edges --
 * any forward fact wins: better one extra rank constraint than one missing. Self-loops dropped.
 *
 * 2. Reduction runs on **quotient nodes**, not the raw graph. Take SCCs over forward edges (back edges excluded):
 * intra-component edges stay unconditionally; cross-component edges dedupe by (component pair, kind) and feed the
 * analyzer's greedy irreducible reduction (same-kind forward edges, back edges as carry (`carryOf: "seq"`), else it
 * degenerates to untyped reduction), then expand back over surviving component pairs. Output keeps input order.
 *
 * Feeding the raw graph into reduction is wrong: a witness path can loop back around. When two unrelated
 * if/else groups reuse the same phase names, the quotient graph holds both A->B and B->A as plain branch
 * edges, so reduction deletes choose->A as implied by choose->B->A and the picture claims "the branch always
 * takes B; A is a fork of B" -- a falsehood. A path through nodes on the same cycle as an endpoint asserts
 * nothing about control reaching there; witnesses hold only on the quotient DAG.
 */
export function foldPhaseEdges(raw: readonly RawEdge[]): RawEdge[] {
  const folded = foldPairs(raw);
  const componentOf = componentsOf(folded);
  const component = (id: string): string => componentOf.get(id) ?? id;
  const keyOf = (from: string, to: string, back: boolean): string => `${from} ${to} ${back}`;

  // Cross-component edges dedupe by (component pair, kind), first-seen; intra-component edges never enter
  // reduction -- in the quotient they are self-loops, asserting nothing about DAG reachability.
  const order: string[] = [];
  const byKey = new Map<string, ReducibleEdge>();
  for (const edge of folded) {
    const from = component(edge.from);
    const to = component(edge.to);
    if (from === to) continue;
    const key = keyOf(from, to, edge.back);
    if (byKey.has(key)) continue;
    order.push(key);
    byKey.set(
      key,
      edge.back ? { carryOf: "seq", from, kind: "carry", to } : { from, kind: "seq", to },
    );
  }
  const condensed = order.map((key) => byKey.get(key) as ReducibleEdge);
  const kept = new Set(
    reduceOrdering(condensed).map((edge) => keyOf(edge.from, edge.to, edge.kind === "carry")),
  );
  return folded.filter((edge) => {
    const from = component(edge.from);
    const to = component(edge.to);
    return from === to || kept.has(keyOf(from, to, edge.back));
  });
}

/** One ordered pair folds to one edge, first-seen order; `back` is the conjunction over fold members; self-loops dropped. */
function foldPairs(raw: readonly RawEdge[]): RawEdge[] {
  const order: string[] = [];
  const byKey = new Map<string, RawEdge>();
  for (const edge of raw) {
    if (edge.from === edge.to) continue;
    const key = `${edge.from} ${edge.to}`;
    const seen = byKey.get(key);
    if (seen === undefined) {
      order.push(key);
      byKey.set(key, { ...edge });
    } else {
      seen.back = seen.back && edge.back;
    }
  }
  return order.map((key) => byKey.get(key) as RawEdge);
}

/**
 * Node -> representative of its SCC (first-seen node of the component). Forward edges only: a back edge speaks
 * about the "next round"; counting it collapses the loop body into one node and inner redundancy never trims.
 *
 * Mutual reachability, not Tarjan: the phase graph caps at 32 nodes (`CREATE_WORKFLOW_GRAPH_MAX_PHASES`), cost
 * is irrelevant, and "a reaches b and b reaches a" is the definition itself -- no re-proof needed to read it.
 */
function componentsOf(folded: readonly RawEdge[]): Map<string, string> {
  const nodes: string[] = [];
  const seen = new Set<string>();
  const next = new Map<string, string[]>();
  for (const edge of folded) {
    for (const id of [edge.from, edge.to]) {
      if (seen.has(id)) continue;
      seen.add(id);
      nodes.push(id);
    }
    if (edge.back) continue;
    const list = next.get(edge.from);
    if (list === undefined) next.set(edge.from, [edge.to]);
    else list.push(edge.to);
  }

  const reach = new Map<string, Set<string>>();
  for (const start of nodes) {
    const reached = new Set<string>();
    const stack = [...(next.get(start) ?? [])];
    while (stack.length > 0) {
      const node = stack.pop() as string;
      if (reached.has(node)) continue;
      reached.add(node);
      stack.push(...(next.get(node) ?? []));
    }
    reach.set(start, reached);
  }

  const componentOf = new Map<string, string>();
  for (const node of nodes) {
    if (componentOf.has(node)) continue;
    componentOf.set(node, node);
    for (const other of reach.get(node) ?? []) {
      if (componentOf.has(other)) continue;
      if (reach.get(other)?.has(node) === true) componentOf.set(other, node);
    }
  }
  return componentOf;
}
