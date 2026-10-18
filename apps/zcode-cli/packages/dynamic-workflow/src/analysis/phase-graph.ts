import { UNPHASED_ID } from "./constants.js";
import type { OrderEvent, PhaseInfo } from "./causality-order.js";
import { KIND_RANK, reduceOrdering, type OrderKind } from "./causality-reduce.js";
import type { CausalityGraph, Certainty, OrderEdge, Phase, Step } from "./causality-graph.js";

/**
 * The phase view: the grouping an author imposes via phase markers, and its **quotient** over the causal graph.
 *
 * The causal graph itself is untouched -- two mechanical rewrites of the finished graph, nothing else:
 *
 *  - **Cross-phase copies**: a step claimed by k>1 phases becomes k copies (tilde-suffixed id + a source
 *    backlink; the may-set lane mechanism and delimiter) so every-step-exactly-one-phase holds;
 *  - **Quotient**: reduced step edges project onto phase pairs via claims, dedupe, then the same reduction.
 *    {@link reduceOrdering}.
 *
 * On zero-marker scripts the whole thing is the identity: all three fields absent, existing snapshots byte-identical. Not an optimization --
 * contract: the UI view-switch condition is exactly whether the phase vocabulary is present.
 *
 * A separate module, not causality-graph.ts: that file is at the line cap, and phases are one view above it,
 * as the causal graph is one above the site graph.
 */

/** Copy-id delimiter: the same one may-set lane copies use (both expansions stack as ask#2~actor#1~phase#2). */
const COPY_SEPARATOR = "~";

/** Claims: who belongs to which phase, and how certainly. All keyed by **site id**. */
interface PhaseClaims {
  /** Site -> claiming phases, deduped in issue order. */
  bySite: Map<string, string[]>;
  /** site|phase -> the claim certainty within that phase. */
  certainty: Map<string, Certainty>;
  /** Phase -> clock position of its first member issue; the quotient-fact sort key. */
  position: Map<string, number>;
  /** site|phase -> first/last issue positions of that site in that phase (temporal-feasibility input). */
  firstIssue: Map<string, number>;
  lastIssue: Map<string, number>;
}

/* Quotient input: reduced step edges (sink edges dropped), certainty inherited per endpoint. */
export interface PhaseSourceFact {
  from: string;
  to: string;
  kind: OrderKind;
  certainty: Certainty;
  /** The carry edge underlying kind before retyping; carry minimization judges witness strength by it. */
  carryOf?: Exclude<OrderKind, "carry">;
  /**
   * Phase set of the issue events witnessing this fact (only seq facts born of await barriers; see
   * toPhases in causality-graph.ts). Head narrowing via the shared head rule.
   */
  toPhases?: ReadonlySet<string>;
}

/**
 * Which phases an edge head lands on: **intersect provenance when present, else expand fully**.
 *
 * Copy rewrite and quotient projection must share one rule, else phase edges and drilldown step edges tell
 * two different stories -- the whole reason both consumers hang off one function.
 *
 * In practice the intersection equals the facts own set (a barrier fact witnesses exactly the head site claims); written as
 * an intersection so upstream phase-dropping never hangs an edge on a nonexistent phase.
 */
function headPhasesOf(
  claiming: readonly string[],
  toPhases: ReadonlySet<string> | undefined,
): string[] {
  if (toPhases === undefined) return [...claiming];
  const narrowed = claiming.filter((phase) => toPhases.has(phase));
  return narrowed.length > 0 ? narrowed : [...claiming];
}

/**
 * Read the claims off issue events. The issue is a step identity instant, so this pass is the entire attribution logic.
 *
 * Per site-phase certainty derived separately: within that phase there **exists** a region-chain-certain issue, and
 * the step is not a control-edge target. Verbatim per the causality-graph rule, with all-issues replaced by this-phase
 * issues -- when the shared helper runs in preflight and in gate, the two certainties may differ;
 * exactly why copies derive their own.
 */
export function collectPhaseClaims(
  events: readonly OrderEvent[],
  steps: ReadonlySet<string>,
  certainChain: (chain: readonly string[]) => boolean,
  controlled: ReadonlySet<string>,
): PhaseClaims {
  const bySite = new Map<string, string[]>();
  const position = new Map<string, number>();
  const firstIssue = new Map<string, number>();
  const lastIssue = new Map<string, number>();
  const certainSeen = new Set<string>();
  // The same clock as the causal graph: one tick per issue event, on-graph step or not.
  let clock = 0;
  for (const event of events) {
    if (event.at !== "issue") continue;
    const at = clock;
    clock += 1;
    if (!steps.has(event.step)) continue;
    const claiming = bySite.get(event.step);
    if (claiming === undefined) bySite.set(event.step, [event.phase]);
    else if (!claiming.includes(event.phase)) claiming.push(event.phase);
    if (!position.has(event.phase)) position.set(event.phase, at);
    const key = `${event.step}|${event.phase}`;
    if (!firstIssue.has(key)) firstIssue.set(key, at);
    lastIssue.set(key, at);
    if (certainChain(event.regions)) certainSeen.add(key);
  }

  const certainty = new Map<string, Certainty>();
  for (const [site, claiming] of bySite) {
    for (const phase of claiming) {
      const key = `${site}|${phase}`;
      certainty.set(key, certainSeen.has(key) && !controlled.has(site) ? "always" : "maybe");
    }
  }
  return { bySite, certainty, firstIssue, lastIssue, position };
}

/**
 * Add the phase vocabulary to the finished causal graph: copies, step phase fields, the phase table, phase edges.
 *
 * Runs after the lane expansion (claims per lane copy) and, like it, is a mechanical rewrite of the
 * finished graph: step set, lanes, regions, and existing step-edge content are never recomputed.
 */
export function projectPhaseGraph(
  graph: CausalityGraph,
  phases: readonly PhaseInfo[],
  claims: PhaseClaims,
  facts: readonly PhaseSourceFact[],
  sharesIteration: (a: string, b: string) => boolean,
): CausalityGraph {
  if (phases.length === 0) return graph; // zero markers -> zero vocabulary, graph byte-identical

  const claimsOf = (siteId: string): string[] => claims.bySite.get(siteId) ?? [UNPHASED_ID];
  const certaintyOfClaim = (siteId: string, phase: string): Certainty =>
    claims.certainty.get(`${siteId}|${phase}`) ?? "maybe";

  /**
   * Temporal feasibility: may an a-to-b edge land on copy pair (a at P, b at Q)?
   *
   * Each phase copy **occupies a time position** -- the root difference from lane copies: lane copies sit side by side at one rank,
   * full expansion asserts no order; phase-copy full expansion asserts false order (gate bench
   * before the preflight bench issue). The walk has the data: per site-phase issue
   * positions. More-order is the allowed direction; wrong order is not.
   *
   * Two channels, disjoined:
   *  - Position: some b-in-Q issue after the first a-in-P issue;
   *  - Recurrence: both sites share one closed iteration region. Not optional -- the round-k producer feeds
   *    the round-k+1 copy, before-in-position yet realizable. Without it,
   *    cross-phase loop-carried data would vanish -- manufacturing concurrency, the one forbidden direction.
   *
   * Shares the iteration predicate with the carry rule: one relation, one question, answered once --
   * the two sides must not each answer it independently.
   */
  const admits = (from: string, fromPhase: string, to: string, toPhase: string): boolean => {
    const firstFrom = claims.firstIssue.get(`${from}|${fromPhase}`);
    const lastTo = claims.lastIssue.get(`${to}|${toPhase}`);
    if (firstFrom === undefined || lastTo === undefined) return true; // nothing to judge: do not block
    return lastTo > firstFrom || sharesIteration(from, to);
  };
  /**
   * Kinds subject to temporal feasibility. carry excluded: its realizability was judged already,
   * and carry asserts next-round, meaningless to position-compare. fifo excluded: the lane rule already
   * decided it, and same-site copies share lanes, indeed FIFO with each other.
   */
  const ADMITTED_KINDS = new Set<OrderKind>(["data", "control", "seq"]);

  // --- 1. cross-phase copies -----------------------------------------------------
  // Copies are **both-run, not candidates** -- do not slip into maybe by analogy with lane copies. The site really
  // fires from two callers (the shared helper runs in preflight and in gate); both copies execute; each
  // certainty reflects only its own phase claim, never either-or.
  //
  // region and repeat are **site-level facts** (from the first issue), deliberately not recomputed per phase: copies are
  // a mechanical rewrite; per-phase region re-attribution wants per-phase region trees -- another decision.
  // So the gate bench copy carries the preflight first-issue region and stack -- do not
  // fix that without a decision.
  const copiesOf = new Map<string, (Step & { phase: string })[]>();
  for (const step of graph.steps) {
    const siteId = step.source ?? step.id;
    const claiming = claimsOf(siteId);
    if (claiming.length < 2) continue;
    copiesOf.set(
      step.id,
      claiming.map((phase) => ({
        ...step,
        certainty: weakest([step.certainty, certaintyOfClaim(siteId, phase)]),
        id: `${step.id}${COPY_SEPARATOR}${phase}`,
        phase,
        // The source backlink is the runtime-reported site id, **set once**: lane copies already carry it; reuse.
        source: siteId,
      })),
    );
  }

  const steps: Step[] = graph.steps.flatMap((step) => {
    const copies = copiesOf.get(step.id);
    if (copies !== undefined) return copies;
    // k equals 1: the claim is unique (every issue of the step lands in this phase), so the phase
    // certainty equals the step own verbatim; no override.
    return [{ ...step, phase: claimsOf(step.source ?? step.id)[0] as string }];
  });

  // --- 2. edge rewrite: mirror of the lane-expansion mechanism --------------------------------------
  const stepById = new Map(graph.steps.map((step) => [step.id, step]));
  const siteOf = (id: string): string => {
    const step = stepById.get(id);
    return step === undefined ? id : (step.source ?? step.id);
  };
  // Fact provenance indexes by **site pair** (facts predate both copies; one per ordered pair), so
  // lane-copy edges fold back to site pairs before lookup.
  const provenance = new Map<string, ReadonlySet<string>>();
  for (const fact of facts) {
    if (fact.toPhases !== undefined) provenance.set(`${fact.from}|${fact.to}`, fact.toPhases);
  }

  const endpointsOf = (
    id: string,
    toPhases?: ReadonlySet<string>,
  ): { certainty: Certainty; id: string; lane?: string; phase: string }[] => {
    const copies = copiesOf.get(id);
    if (copies !== undefined) {
      const heads = new Set(headPhasesOf(claimsOf(siteOf(id)), toPhases));
      return copies
        .filter((copy) => heads.has(copy.phase))
        .map((copy) => ({
          certainty: copy.certainty,
          id: copy.id,
          lane: copy.lane,
          phase: copy.phase,
        }));
    }
    const step = stepById.get(id);
    return [
      {
        certainty: step?.certainty ?? "maybe",
        id,
        lane: step?.lane,
        phase: claimsOf(siteOf(id))[0] as string,
      },
    ];
  };

  const edges: OrderEdge[] = [];
  for (const edge of graph.edges) {
    // Neither end a copy -> keep as-is. This early return is also the constructive zero-marker byte-identity guarantee: single-endpoint pairs
    // never reach any rule below.
    if (!copiesOf.has(edge.from) && !copiesOf.has(edge.to)) {
      edges.push(edge);
      continue;
    }
    const fromSite = siteOf(edge.from);
    const toSite = siteOf(edge.to);
    // The tail does not narrow by provenance, but **the tail is temporal-feasibility-bound too** --
    // this is where the tail-side pseudo-edge (a copy before the ask producing its own argument) dies.
    const pairs: { certainty: Certainty; from: string; to: string }[] = [];
    const admitted: typeof pairs = [];
    for (const tail of endpointsOf(edge.from)) {
      for (const head of endpointsOf(edge.to, provenance.get(`${fromSite}|${toSite}`))) {
        // fifo matches by lane, the lane-expansion rule. Same-site phase copies share lanes, so fifo between
        // them survives -- correct: one site emissions are FIFO with each other.
        if (edge.kind === "fifo" && tail.lane !== head.lane) continue;
        // A copy to itself: only when the original was already a self-edge (distinct-site copy ids cannot collide),
        // so this writes the invariant down; not a reachable branch.
        if (tail.id === head.id && edge.from !== edge.to) continue;
        const pair = {
          certainty: weakest([edge.certainty, tail.certainty, head.certainty]),
          from: tail.id,
          to: head.id,
        };
        pairs.push(pair);
        if (!ADMITTED_KINDS.has(edge.kind) || admits(fromSite, tail.phase, toSite, head.phase)) {
          admitted.push(pair);
        }
      }
    }
    // All blocked -> fall back to full expansion, the head-rule posture: a real order unrealizable
    // anywhere means the position judgment misled us; silently dropping a real order manufactures concurrency.
    for (const pair of admitted.length > 0 ? admitted : pairs) {
      edges.push({ ...edge, ...pair });
    }
  }

  // --- 3. phase table: memberful phases, unphased first -------------------------------------
  const members = new Set<string>(steps.map((step) => step.phase as string));
  const phaseList: Phase[] = [];
  if (members.has(UNPHASED_ID)) phaseList.push({ id: UNPHASED_ID });
  for (const phase of phases) {
    // Zero-member phases drop (narrowing may strip a phase of all steps) -- an empty node has no home to point to.
    if (!members.has(phase.id)) continue;
    phaseList.push({
      id: phase.id,
      loc: phase.loc,
      name: phase.name,
      ...(phase.fill === undefined ? {} : { fill: phase.fill }),
    });
  }
  const live = new Set(phaseList.map((phase) => phase.id));

  // --- 4. quotient: computed on claims, independent of copy materialization ------------------------------------
  const quotient: PhaseSourceFact[] = [];
  for (const fact of facts) {
    // Rule-identical to the copy rewrite: head narrowing + temporal feasibility,
    // likewise active only when an end is copied. The two consumers must not tell two stories -- phase edges and
    // drilldown step edges must say the same thing.
    const tails = claimsOf(fact.from);
    const heads = headPhasesOf(claimsOf(fact.to), fact.toPhases);
    const copied = tails.length > 1 || claimsOf(fact.to).length > 1;
    const gated = copied && ADMITTED_KINDS.has(fact.kind);
    const pairs: { from: string; to: string }[] = [];
    const admitted: typeof pairs = [];
    for (const from of tails) {
      for (const to of heads) {
        pairs.push({ from, to });
        if (!gated || admits(fact.from, from, fact.to, to)) admitted.push({ from, to });
      }
    }
    for (const { from, to } of admitted.length > 0 ? admitted : pairs) {
      if (!live.has(from) || !live.has(to)) continue;
      // Intra-phase order does not graph; intra-phase carry is the loop-lives-in-one-phase drawing, kept as a self loop.
      if (from === to && fact.kind !== "carry") continue;
      quotient.push({
        certainty: fact.certainty,
        from,
        kind: fact.kind,
        to,
        ...(fact.carryOf === undefined ? {} : { carryOf: fact.carryOf }),
      });
    }
  }

  const position = (id: string): number => claims.position.get(id) ?? 0;
  const deduped = dedupePhaseFacts(quotient).sort(
    (a, b) =>
      position(a.from) - position(b.from) ||
      position(a.to) - position(b.to) ||
      a.kind.localeCompare(b.kind),
  );
  // Phase edges carry no exact: the data-edge taint witness bit, undefined on the quotient.
  const phaseEdges: OrderEdge[] = reduceOrdering(deduped).map((fact) => ({
    certainty: fact.certainty,
    from: fact.from,
    kind: fact.kind,
    to: fact.to,
  }));

  const sink = graph.sink;
  return {
    edges,
    lanes: graph.lanes,
    phaseEdges,
    phases: phaseList,
    regions: graph.regions,
    steps,
    // Phase-level sink edges do not graph (the UI derives them from the feeding step phase), but fedBy itself follows the copy.
    ...(sink === undefined
      ? {}
      : { sink: { fedBy: sink.fedBy.flatMap((id) => endpointsOf(id).map((end) => end.id)) } }),
  };
}

/**
 * One fact per ordered phase pair: strongest kind, maybe-wins certainty --
 * a verbatim mirror of the step-level dedupe; consistency first (any-always-witnesses-is-always
 * is the truer semantics on the quotient).
 */
function dedupePhaseFacts(facts: readonly PhaseSourceFact[]): PhaseSourceFact[] {
  const byPair = new Map<string, PhaseSourceFact>();
  for (const fact of facts) {
    const key = `${fact.from}|${fact.to}`;
    const existing = byPair.get(key);
    if (existing === undefined) {
      byPair.set(key, { ...fact });
      continue;
    }
    if (KIND_RANK[fact.kind] > KIND_RANK[existing.kind]) existing.kind = fact.kind;
    if (existing.carryOf === undefined && fact.carryOf !== undefined)
      existing.carryOf = fact.carryOf;
    if (fact.certainty === "maybe") existing.certainty = "maybe";
  }
  return [...byPair.values()];
}

function weakest(values: readonly Certainty[]): Certainty {
  return values.includes("maybe") ? "maybe" : "always";
}
