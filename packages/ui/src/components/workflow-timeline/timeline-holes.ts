import {
  WORKFLOW_HOLE_SITE_ID_PATTERN,
  type WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import type { WorkflowCausalityGraphData } from "@/components/workflow-graph/types.js";
import type { TimelineRail, TimelineStation, WorkflowTimelineModel } from "./timeline-model.js";

/**
 * Hole derivations on the timeline model (docs/dynamic-workflow/presentation.md Holes on the timeline).
 * Split out of timeline-model.ts (max-lines gate): that file only asks is-this-station-a-hole at build and
 * where-is-the-head / does-the-tail-need-40px at finish; every rule lives here. No React, no DOM, no time.
 *
 * A hole IS a phase (id = site id, name = literal; rule 9012 keeps names unique):
 *   - open: display holes[] lists it (tail or not); while the run parks on it, run.holes says waiting.
 *   - filled: display holes[] no longer lists it; the phases and sites it wrote carry fill: <its id>. With
 *     phases, the body's stations stand where the hole was and the hole keeps only a HEAD (pen - name) above
 *     them; without phases, the hole's own phase holds the body's asks, the station keeps its name and grows
 *     a pen mark.
 * The filled name has no display anchor (no longer a site), so it comes from run.holes; run-less static graphs
 * (confirm dialog, completion row) get holeLabels from the caller; with neither, fall back to the site id,
 * better than blank. The hole kind (T of hole<T>) exists on the wire only, a compile-time contract, not UI copy.
 *
 * Nesting: holes inside completions. The hole id is a name key (hole# + 8 hex), depth-free, so nesting does not
 * live in the id: a hole's OWN phase/station carries fill: <enclosing hole> (top-level holes none), yielding
 * the parent map HoleTable.parents. The outer head covers every station whose fill is it or any hole inside it;
 * the inner region lands inside the outer. Heads sort by from, outer first on ties (outer region paints first,
 * inner stacks above). Fix history: pre-2026-09-29 ids concatenated per level (hole#1/hole#1) and hit the
 * protocol's 64-char bound after eight-ish steps.
 *
 * A station's fill answers which completion region it belongs to: usually the phase's fill, but a filled hole's
 * OWN station belongs to its own region (hovering lights itself; it lands with its completion), hence its own
 * id; see stationFillOf.
 */
export type TimelineHoleState = "open" | "waiting" | "filled";

export interface TimelineHole {
  siteId: string;
  state: TimelineHoleState;
  /** Prompt the main agent received (waiting, from run.holes); the side pane's waiting body renders it. */
  prompt?: string;
  /** The script's tail: rails run 40px past it. */
  tail?: true;
  /** Arrival time (waiting); completion time (filled). */
  since?: number;
  filledAt?: number;
  filledBy?: string;
}

/** A phase-carrying completion's head: covers stations from..to (subscripts into stations). */
export interface TimelineFill {
  holeId: string;
  name: string;
  from: number;
  to: number;
  filledAt?: number;
}

export type HoleLabels = ReadonlyMap<string, { name: string }>;

export function isHoleSiteId(id: string): boolean {
  return WORKFLOW_HOLE_SITE_ID_PATTERN.test(id);
}

/** Hole id to enclosing hole id (top-level holes absent). */
export type HoleParents = Readonly<Record<string, string>>;

/** Every layer from id outward along the parents (self first); loop-safe, an id never repeats. */
function holeAncestors(id: string, parents: HoleParents): string[] {
  const out: string[] = [];
  for (
    let cur: string | undefined = id;
    cur !== undefined && !out.includes(cur);
    cur = parents[cur]
  ) {
    if (isHoleSiteId(cur)) out.push(cur);
  }
  return out;
}

/** Whether id is completion holeId itself or a hole inside it (any depth). */
export function fillContains(holeId: string, id: string, parents: HoleParents): boolean {
  return holeAncestors(id, parents).includes(holeId);
}

/**
 * Parents: each hole's own phase and station carry fill = enclosing hole (analyzer convention, docs/analysis.md
 * Sites). Phase first (filled holes keep only the phase), station fallback (an open hole is a kind-hole station
 * on the display).
 */
export function holeParentsOf(
  graph: Pick<WorkflowCausalityGraphData, "steps">,
  phases: readonly { id: string; fill?: string }[],
): HoleParents {
  const parents: Record<string, string> = {};
  for (const step of graph.steps) {
    if (step.kind === "hole" && step.fill !== undefined && step.fill !== step.id)
      parents[step.id] = step.fill;
  }
  for (const phase of phases) {
    if (isHoleSiteId(phase.id) && phase.fill !== undefined && phase.fill !== phase.id)
      parents[phase.id] = phase.fill;
  }
  return parents;
}

/**
 * Drop hole phases already represented by a head from the timeline: filled, memberless, and with other
 * stations inside its body. The analyzer keeps such phases in the table (side pane and phaseNames need them to
 * name each chain step, docs/analysis.md Sites) but on the timeline it would be a bare lamp before the body,
 * the head already says its name. Dropping rewires in-edges to out-edges (a-h-b becomes a-b) so rails stay
 * whole; completions without body stations stay (their marked stations are the only trace).
 */
export function withoutHeadedHolePhases(
  graph: WorkflowCausalityGraphData,
): WorkflowCausalityGraphData {
  const phases = graph.phases ?? [];
  const open = new Set((graph.holes ?? []).map((hole) => hole.siteId));
  const withMembers = new Set(
    graph.steps.flatMap((step) => (step.phase === undefined ? [] : [step.phase])),
  );
  const parents = holeParentsOf(graph, phases);
  const hidden = new Set(
    phases
      .filter(
        (phase) => isHoleSiteId(phase.id) && !open.has(phase.id) && !withMembers.has(phase.id),
      )
      .filter((hole) =>
        phases.some(
          (phase) =>
            phase.id !== hole.id &&
            phase.fill !== undefined &&
            fillContains(hole.id, phase.fill, parents),
        ),
      )
      .map((phase) => phase.id),
  );
  if (hidden.size === 0) return graph;
  // Shrink one by one, rewiring paths through each drop so consecutive drops connect too.
  let edges = [...(graph.phaseEdges ?? [])];
  for (const id of hidden) {
    const into = edges.filter((edge) => edge.to === id && edge.from !== id);
    const out = edges.filter((edge) => edge.from === id && edge.to !== id);
    edges = edges.filter((edge) => edge.from !== id && edge.to !== id);
    for (const a of into)
      for (const b of out)
        edges.push({ from: a.from, to: b.to, ...(b.back === true ? { back: true } : {}) });
  }
  const seen = new Set<string>();
  const phaseEdges = edges.filter((edge) => {
    const key = `${edge.from}>${edge.to}>${edge.back === true ? 1 : 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    ...graph,
    phaseEdges,
    phases: phases
      .filter((phase) => !hidden.has(phase.id))
      .map((phase) =>
        phase.alongside === undefined
          ? phase
          : { ...phase, alongside: phase.alongside.filter((id) => !hidden.has(id)) },
      ),
  };
}

/**
 * Which graph the timeline builds stations from: headed hole phases dropped (withoutHeadedHolePhases) while
 * the parent map computes from the PRE-drop graph, dropped holes still parent their body's holes, keeping
 * nesting intact.
 */
export function timelineHoleGraph(full: WorkflowCausalityGraphData): {
  graph: WorkflowCausalityGraphData;
  phases: NonNullable<WorkflowCausalityGraphData["phases"]>;
  parents: HoleParents;
} {
  const graph = withoutHeadedHolePhases(full);
  return { graph, parents: holeParentsOf(full, full.phases ?? []), phases: graph.phases ?? [] };
}

/** Which completion region a station belongs to (folded onto the station): a filled hole's own station its own region, others the phase's fill. */
export function stationFillOf(
  phase: { id: string; fill?: string },
  hole: TimelineHole | undefined,
): { fill?: string } {
  const fill = hole?.state === "filled" ? phase.id : phase.fill;
  return fill === undefined ? {} : { fill };
}

export interface HoleTable {
  /** Phase id to is-this-station-a-hole (those whose own phase survives the table). */
  byPhase: ReadonlyMap<string, TimelineHole>;
  /** Heads of phase-carrying completions, ascending by from. */
  fills: TimelineFill[];
  /** Containment among holes (see holeParentsOf). */
  parents: HoleParents;
}

/**
 * Read the hole table from display and run. phases is the model's station-building phase table (implicit phase
 * synthesized), subscript-aligned with stations.
 */
export function holeTable(
  graph: WorkflowCausalityGraphData,
  phases: readonly NonNullable<WorkflowCausalityGraphData["phases"]>[number][],
  run: WorkflowRunState | undefined,
  labels: HoleLabels | undefined,
  /** Parents from the PRE-shrink graph (dropped hole phases still parent their body's holes); computed here when absent. */
  parents: HoleParents = holeParentsOf(graph, phases),
): HoleTable {
  const runHoles = new Map((run?.holes ?? []).map((hole) => [hole.siteId, hole]));
  const index = new Map(phases.map((phase, i) => [phase.id, i]));
  const byPhase = new Map<string, TimelineHole>();
  const open = new Set<string>();
  for (const hole of graph.holes ?? []) {
    open.add(hole.siteId);
    const live = runHoles.get(hole.siteId);
    const waiting = live?.state === "waiting";
    byPhase.set(hole.siteId, {
      siteId: hole.siteId,
      state: waiting ? "waiting" : "open",
      ...(hole.tail === true ? { tail: true as const } : {}),
      ...(waiting && live.since !== undefined ? { since: live.since } : {}),
      ...(waiting && live.prompt !== undefined ? { prompt: live.prompt } : {}),
    });
  }
  // Filled holes: recorded filled by the run, named by some phase/site fill, or whose phase id is a hole id.
  const filled = new Set<string>();
  for (const hole of runHoles.values()) if (hole.state === "filled") filled.add(hole.siteId);
  // Named holes plus every outer layer: once the inner fills, outers may no longer be named by any phase.
  for (const phase of phases) {
    if (phase.fill !== undefined)
      for (const id of holeAncestors(phase.fill, parents)) filled.add(id);
    if (isHoleSiteId(phase.id)) filled.add(phase.id);
  }
  for (const step of graph.steps) {
    if (step.fill !== undefined) for (const id of holeAncestors(step.fill, parents)) filled.add(id);
  }
  for (const id of open) filled.delete(id);

  const fills: TimelineFill[] = [];
  const last = phases.length - 1;
  for (const holeId of filled) {
    const live = runHoles.get(holeId);
    const label = labels?.get(holeId);
    const own = index.get(holeId);
    // Body: stations whose fill is it or any hole inside, the outer span covers the inner. Its own station is
    // not body (its fill is the outer); directly before the body, the head claim below takes it.
    const body = phases.flatMap((phase, i) =>
      phase.fill !== undefined && fillContains(holeId, phase.fill, parents) ? [i] : [],
    );
    if (own !== undefined) {
      byPhase.set(holeId, {
        siteId: holeId,
        state: "filled",
        // A hole at the table's end is the script's tail: keep 40px after fill so the head fits.
        ...(own === last && body.length === 0 ? { tail: true as const } : {}),
        ...(live?.filledAt === undefined ? {} : { filledAt: live.filledAt }),
        ...(live?.filledBy === undefined ? {} : { filledBy: live.filledBy }),
      });
    }
    if (body.length === 0) continue;
    // The hole's own phase directly before the body joins the head too (body statements before the first marker land there).
    const from = own !== undefined && own === Math.min(...body) - 1 ? own : Math.min(...body);
    fills.push({
      holeId,
      name: live?.name ?? label?.name ?? holeId,
      from,
      to: Math.max(...body),
      ...(live?.filledAt === undefined ? {} : { filledAt: live.filledAt }),
    });
  }
  // Same-start outers first: longer span, then nesting depth (outer shallow). Fix note: once ids stopped
  // concatenating per level, parent-walk collection runs inner-to-outer and insertion order would put inner
  // heads above outer ones.
  const depth = (id: string): number => holeAncestors(id, parents).length;
  fills.sort(
    (left, right) =>
      left.from - right.from || right.to - left.to || depth(left.holeId) - depth(right.holeId),
  );
  return { byPhase, fills, parents };
}

/** Tail hole: open/waiting draws a 40px fading dashed stub; after a phase-less fill only 40px reserved (the head must land). */
export function tailStubOf(stations: readonly TimelineStation[]): "open" | "filled" | undefined {
  const hole = stations[stations.length - 1]?.hole;
  if (hole === undefined || hole.tail !== true) return undefined;
  return hole.state === "filled" ? "filled" : "open";
}

/** Rail segments touching an open/waiting hole are dashed: no code there yet. */
export function railTouchesHole(
  stations: readonly TimelineStation[],
  rail: Pick<TimelineRail, "from" | "to">,
): boolean {
  const at = (i: number): boolean => {
    const state = stations[i]?.hole?.state;
    return state === "open" || state === "waiting";
  };
  return at(rail.from) || at(rail.to);
}

/**
 * The completion row's draft phase line (docs/dynamic-workflow/presentation.md The fill row): the parent
 * rail's stretch where the completion sits. Full ink on the completion's stations, one ghost neighbor each side
 * (40 percent), other stations undrawn. No arcs, bands or live state: a static graph saying between which two
 * stations the new ones land. Undefined when the hole is unknown.
 */
export function narrowTimelineToFill(
  model: WorkflowTimelineModel,
  holeId: string,
): WorkflowTimelineModel | undefined {
  const fill = model.fills?.find((candidate) => candidate.holeId === holeId);
  let from: number;
  let to: number;
  if (fill !== undefined) {
    from = fill.from;
    to = fill.to;
  } else {
    const own = model.stations.findIndex(
      (station) => station.hole?.siteId === holeId && station.hole.state === "filled",
    );
    if (own < 0) return undefined;
    from = own;
    to = own;
  }
  const start = Math.max(0, from - 1);
  const end = Math.min(model.stations.length - 1, to + 1);
  const stations = model.stations.slice(start, end + 1).map((station, i) => {
    const at = start + i;
    const ghost = at < from || at > to;
    const { typing: _typing, ...rest } = station;
    void _typing;
    return ghost ? { ...rest, ghost: true as const } : rest;
  });
  const rails = model.rails.flatMap((rail) =>
    rail.kind === undefined && rail.from >= start && rail.to <= end && rail.to === rail.from + 1
      ? [{ ...rail, from: rail.from - start, to: rail.to - start }]
      : [],
  );
  const includesLast = end === model.stations.length - 1;
  return {
    arcs: [],
    bands: [],
    fills: fill === undefined ? [] : [{ ...fill, from: from - start, to: to - start }],
    live: false,
    rails,
    runningIndex: undefined,
    stations,
    ...(includesLast && model.tailStub !== undefined ? { tailStub: model.tailStub } : {}),
  };
}
