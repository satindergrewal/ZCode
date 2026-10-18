import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { laneRefsById, type LaneRef } from "@/components/workflow-graph/lane-name.js";
import {
  collapseStatuses,
  liveParticipantView,
  participantStatus,
  participantsOfPhase,
  withImplicitPhase,
} from "@/components/workflow-graph/participant-model.js";
import { phaseBinder } from "@/components/workflow-graph/instance-phases.js";
import type { PhaseNaming } from "@/components/workflow-graph/phase-name.js";
import { phaseMembers } from "@/components/workflow-graph/phase-model.js";
import { workflowRunOverlay } from "@/components/workflow-graph/run-status.js";
import {
  laneClassOf,
  type LaneClass,
  type StepRunStatus,
  type WorkflowCausalityGraphData,
} from "@/components/workflow-graph/types.js";
import { sharedTimelineModel } from "./timeline-cache.js";
import {
  isCurrentPhase,
  phaseStreamIndexes,
  stageStatuses,
  stationStatus,
  streamInk,
} from "./stage-lamps.js";
import {
  holeTable,
  railTouchesHole,
  stationFillOf,
  tailStubOf,
  timelineHoleGraph,
  type HoleLabels,
  type TimelineFill,
  type TimelineHole,
} from "./timeline-holes.js";
import {
  observePhase,
  phaseEntryFor,
  siteIdsOf,
  stationUnlisted,
  type StationUnlisted,
} from "./station-observation.js";
import {
  assignAirLanes,
  bandOf,
  foldPhaseBands,
  foldPhaseEdges,
  trackOf,
  type RailSpec,
  type TimelineRailKind,
} from "./timeline-bands.js";

/**
 * The timeline model.
 *
 * One pure function folds the bounded display plus the workflowRuns projection into three things: stations
 * (phases), rail segments (between adjacent edged stations) and arcs (non-adjacent edges). The chat card,
 * confirm dialog and side pane list all derive from here, invariant 1: one model, three consumers. No React,
 * no DOM, no time.
 *
 * Order is declaration order (payload phases[] = first phase-marker order), no more ranking: two sibling phases
 * sharing only a predecessor line up in declaration order and the edge between them becomes an arc. Loop-backs
 * are decided by DIRECTION (target left of source), not by the payload's back flag; the analyzer marks re-entry
 * (a second phase("plan")) forward and it still draws leftward.
 */

export type TimelineInk = "faint" | "strong" | "march";
export type { TimelineRailKind } from "./timeline-bands.js";
// Arc lane assignment is pure subscript combinatorics and lives with band folding in timeline-bands.ts; exported
// from here so renderer entry points stay put.
export { arcLaneCount, assignArcLanes } from "./timeline-bands.js";

export interface TimelinePill {
  /** Split participant id (instance card participant@ordinal); React key and the handle that opens the instance. */
  key: string;
  lane: LaneRef;
  laneClass: LaneClass;
  /** Runtime name as emitted by the engine (persona may rewrite the script's name); lane display name when absent. */
  runtimeName?: string;
  /** Avatar index per agent identity within the workflow, reused across phases. */
  avatarIndex?: number;
  /** undefined with no run (static pill, pixel-identical to pending). */
  status: StepRunStatus | undefined;
  /** The projection instance behind this pill; none for synthesized lanes (workspace / unknown). */
  instance?: { siteId: string; ordinal: number; sessionId?: string };
  /**
   * Slot identity handed over by the pill: the instance's ordinal when it exists, otherwise the ordinal it
   * WILL have, member.index + 1 on member cards, 1 on single/many cards (the engine numbers by site order).
   // Stage lamps (spec Station status): stations that are parallel or stream with member steps read only their
  // own nodes and the feeding stations.
   */
  slot?: { siteId: string; ordinal: number };
  /**
   * Handle handed over by the script pill: no instance, no session; what opens is the WHOLE run's script
   * transcript anchored to this site's first card. Mutually exclusive with slot: only workspace lanes of a
   * live run have it; no run, nothing to open.
   */
  workspace?: { phaseId: string };
  /** This participant's step id in the phase (activity and count material for the side pane row). */
  stepIds: string[];
  /** Whether the instance has pending escalations (run.pendingQuestions); roster pinning reads it. */
  asking?: true;
}

export interface TimelineStation {
  id: string;
  naming: PhaseNaming;
  pills: TimelinePill[];
  /** Fold of member step states; undefined with no run. */
  status: StepRunStatus | undefined;
  /** Any projected node landed on this station's site. */
  visited: boolean;
  /** Max node ordinal on the station's site; 0 = not yet. */
  rounds: number;
  // A hole awaiting completion stays running (the run parks on it): while in future it is parallel too, so the
  // stage rule must not downgrade it to pending for having no nodes (rules aligned in the dwf-recursive /
  // dwf-pipeline-display merge).
  onLoop: boolean;
  /** Track index (timeline-bands.ts); 0 off-band, the mainline. */
  track: number;
  /** settled / observed counts; absent with no observed node. Off-table settled instances count too. */
  fraction?: { settled: number; observed: number };
  /** Off-table entries this bound spent at the station (station-observation.ts); absent when none. */
  unlisted?: StationUnlisted;
  /** Last not-yet-closed station of the streaming draft. */
  typing?: true;
  /** This station is a hole (timeline-holes.ts): dashed lamp, kind badge; current while waited on. */
  hole?: TimelineHole;
  /** Written in by a completion (fill on the display phase): hover lights the enclosing completion. */
  fill?: string;
  /** Neighbor on the completion row's draft line: context only, 40 percent ink. */
  ghost?: true;
}

/** One rail segment between adjacent stations on a track; subscripts index stations. */
export interface TimelineRail {
  from: number;
  to: number;
  ink: TimelineInk;
  /**
   Absent means a plain segment on one track. Band ends are fork/merge, cross-track neighbors in a band are
   twin, and a phase stream between adjacent stations on one track is stream (ink: march while both ends run,
   strong once crossed).
   */
  kind?: TimelineRailKind;
  /** Touches an open/waiting hole: dashed, no code there yet. */
  dashed?: true;
}

/**
 * Non-adjacent edge; to < from is a loop-back. lane starts at 0, closest to the rails; only arcs that
 * intersect in x get lanes (see assignArcLanes), disjoint arcs share a height.
 */
export interface TimelineArc {
  from: number;
  to: number;
  lane: number;
  ink: TimelineInk;
  /** Which track's air it draws in; lanes assign per air, so arcLaneCount filters by air first. */
  air: number;
  /** Non-adjacent phase stream: stream ink rules, never marches, never rings stations. */
  stream?: true;
}

/** One track of a band; stations are its members in declaration order. */
export interface TimelineTrack {
  stations: number[];
  /** Ink of the fork entering this track; without a predecessor, per first-station arrival. */
  entry: TimelineInk;
  /** Ink merging out of this track; without a sink, per last-station arrival. */
  exit: TimelineInk;
}

/** A band: a declaration-ordered run of stations split across tracks; arcs treat it as one node (timeline-bands.ts). */
export interface TimelineBand {
  from: number;
  to: number;
  /** Predecessor hosting the fork; absent leaves a small tail. */
  pred?: number;
  /** Successor hosting the join; absent leaves a small stub. */
  join?: number;
  tracks: TimelineTrack[];
}

export interface WorkflowTimelineModel {
  stations: TimelineStation[];
  rails: TimelineRail[];
  arcs: TimelineArc[];
  /** Bands folded from parallel phases, ascending by from; empty without alongside. */
  bands: TimelineBand[];
  /** Running station, rightmost when several; undefined none. */
  runningIndex: number | undefined;
  /** Whether a run projection takes part (decides if lamps/ink have anything to say). */
  live: boolean;
  /** Streaming draft: stations written word by word, subagents counted not drawn (draft-scan.ts). */
  draft?: { agents: number };
  /** Heads left by phase-carrying completions (timeline-holes.ts), ascending by from; empty if none. */
  fills?: TimelineFill[];
  /** Hole id to enclosing hole id (holeParentsOf); hover lights the outer region by it. */
  holeParents?: Readonly<Record<string, string>>;
  /** Last station is a tail hole: open draws a 40px fading dashed stub, filled reserves 40px. */
  tailStub?: "open" | "filled";
}

/**
 * One model, three consumers (invariant 1): card, detail page and side pane list get the SAME model object in
 * the same frame, memoized on (graph, run) object identity; why identity is the right key is timeline-cache.ts's
 * story. The model is read-only, no consumer mutates it, so sharing doubles as reference stability.
 */
export function buildWorkflowTimeline(
  input: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
  /**
   * Filled holes' names and kinds (docs/dynamic-workflow/presentation.md Holes on the timeline): a run-less
   * static graph (confirm dialog, completion row) passed in via tool args. When given, the shared cache is
   * bypassed, that table keys on (graph, run).
   */
  holeLabels?: HoleLabels,
): WorkflowTimelineModel {
  if (holeLabels !== undefined) return computeWorkflowTimeline(input, run, holeLabels);
  return sharedTimelineModel(input, run, () => computeWorkflowTimeline(input, run, undefined));
}

function computeWorkflowTimeline(
  input: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
  holeLabels: HoleLabels | undefined,
): WorkflowTimelineModel {
  // Hole phases already represented by a head become no station; the parent map computes from the pre-shrink
  // graph so nesting survives (timeline-holes.ts).
  const { graph, parents, phases } = timelineHoleGraph(withImplicitPhase(input));
  const index = new Map(phases.map((phase, i) => [phase.id, i]));
  const members = phaseMembers(graph);
  const holes = holeTable(graph, phases, run, holeLabels, parents);
  const overlay = workflowRunOverlay(run, graph);
  const live = liveParticipantView(graph, run);
  const binder = phaseBinder(graph, run);
  const laneRefs = laneRefsById(graph.lanes);
  const sessionByInstance = new Map(
    (run?.actors ?? []).map((actor) => [`${actor.siteId}@${actor.ordinal}`, actor.sessionId]),
  );
  const askingInstances = new Set(
    (run?.pendingQuestions ?? [])
      .filter(
        (question) => question.actorSiteId !== undefined && question.actorOrdinal !== undefined,
      )
      .map((question) => `${question.actorSiteId}@${question.actorOrdinal}`),
  );

  // Edges: dedupe by subscript first (self-loops and edges to unlisted phases say nothing at this granularity),
  // then hand to band folding: adjacent ones become rail segments, the rest arcs, and bands eat the fork/join
  // legs (timeline-bands.ts).
  const edges: { from: number; to: number }[] = [];
  const seen = new Set<string>();
  for (const edge of graph.phaseEdges ?? []) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const key = `${from}>${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to });
  }
  // Phase streams (spec Streams): dedupe by subscript too; they pull a line's stages out of bands.
  const streams = phaseStreamIndexes(graph.phaseStreams, index);
  const alongsideIndexes = phases.map((phase) =>
    (phase.alongside ?? []).flatMap((id) => {
      const at = index.get(id);
      return at === undefined ? [] : [at];
    }),
  );
  const folded = foldPhaseBands(phases.length, alongsideIndexes, streams);
  const fold = foldPhaseEdges(phases.length, folded, edges, streams);
  const arcPairs = [...fold.arcs].sort(
    (left, right) => Math.abs(left.from - left.to) - Math.abs(right.from - right.to),
  );
  // Both ends of a loop-back ring; when an endpoint is in a band the whole band rings, a band is one node and
  // re-entry rings all of it.
  const onLoop = new Set<number>();
  for (const arc of arcPairs) {
    if (arc.to >= arc.from || arc.stream) continue;
    for (const end of [arc.from, arc.to]) {
      const band = bandOf(folded, end);
      if (band === undefined) onLoop.add(end);
      else for (let i = band.from; i <= band.to; i += 1) onLoop.add(i);
    }
  }

  // Name hashes collide; number consecutively per instance identity so an agent keeps one avatar across phases.
  const avatarIndexes = new Map<string, number>();
  const nodeStatuses: (StepRunStatus | undefined)[] = [];
  const entered: boolean[] = [];
  const hasMembers: boolean[] = [];
  const stations: TimelineStation[] = phases.map((phase, i) => {
    const memberSteps = members.get(phase.id) ?? [];
    const unlisted = stationUnlisted(run, binder, phase.id);
    const observed = observePhase(
      run,
      siteIdsOf(memberSteps),
      phaseEntryFor(run, phase.name),
      (node) => binder.has(phase.id, node.phaseName),
      unlisted,
    );
    const pills: TimelinePill[] = participantsOfPhase(live.graph, phase.id).map((participant) => {
      const instance = live.instances[participant.id];
      const lane = laneRefs.get(participant.lane) ?? {
        id: participant.lane,
        laneClass: laneClassOf(participant.lane),
      };
      // Empty fold = this subagent did nothing at this station in this run: hollow is the honest state.
      // undefined is reserved for run-less static pills.
      const status =
        run === undefined
          ? undefined
          : (participantStatus(participant, overlay.statuses, live.participantStatuses) ??
            "pending");
      const sessionId =
        instance === undefined
          ? undefined
          : sessionByInstance.get(`${participant.lane}@${instance.ordinal}`);
      const slot =
        run !== undefined && lane.laneClass === "agent"
          ? {
              ordinal: instance?.ordinal ?? (participant.member?.index ?? 0) + 1,
              siteId: participant.lane,
            }
          : undefined;
      const avatarKey = `${participant.lane}@${instance?.ordinal ?? (participant.member?.index ?? 0) + 1}`;
      if (lane.laneClass === "agent" && !avatarIndexes.has(avatarKey)) {
        avatarIndexes.set(avatarKey, avatarIndexes.size);
      }
      return {
        ...(lane.laneClass === "agent" ? { avatarIndex: avatarIndexes.get(avatarKey)! } : {}),
        key: participant.id,
        lane,
        laneClass: lane.laneClass,
        ...(instance?.name === undefined ? {} : { runtimeName: instance.name }),
        status,
        ...(instance === undefined
          ? {}
          : {
              instance: {
                ordinal: instance.ordinal,
                siteId: participant.lane,
                ...(sessionId === undefined ? {} : { sessionId }),
              },
            }),
        ...(slot === undefined ? {} : { slot }),
        ...(run !== undefined && lane.laneClass === "workspace"
          ? { workspace: { phaseId: phase.id } }
          : {}),
        stepIds: [...participant.steps],
        ...(instance !== undefined && askingInstances.has(`${participant.lane}@${instance.ordinal}`)
          ? { asking: true as const }
          : {}),
      };
    });
    const nodeStatus = collapseStatuses(
      memberSteps.map((step) => step.id),
      overlay.statuses,
    );
    nodeStatuses.push(nodeStatus);
    entered.push(observed.entered);
    hasMembers.push(memberSteps.length > 0);
    // A run parked on a hole: that station is current (the entering segment marches, focus aims there); the lamp
    // rendering is the hole's word.
    const hole = holes.byPhase.get(phase.id);
    const waiting = hole?.state === "waiting";
    return {
      id: phase.id,
      naming: { id: phase.id, ...(phase.name === undefined ? {} : { name: phase.name }) },
      pills,
      status: waiting
        ? "running"
        : stationStatus(run, nodeStatus, isCurrentPhase(run, phase.name), observed.entered),
      visited: observed.visited || waiting,
      rounds: observed.rounds,
      ...(hole === undefined ? {} : { hole }),
      ...stationFillOf(phase, hole),
      onLoop: onLoop.has(i),
      track: trackOf(folded, i),
      ...(observed.observed === 0
        ? {}
        : { fraction: { observed: observed.observed, settled: observed.settled } }),
      ...(unlisted === undefined ? {} : { unlisted }),
    };
  });

  // Stage lamps (spec Station status): stations that are parallel or stream with member steps read only their
  // own nodes and the feeding stations.
  const staged = stageStatuses({
    alongside: alongsideIndexes,
    entered,
    hasMembers,
    nodeStatuses,
    run,
    sequential: stations.map((station) => station.status),
    streams,
  });
  // Stage lamps (spec Station status): a parallel-or-stream station with member steps reads only its own
  // nodes and the stations feeding it.
  stations.forEach((station, i) => {
    if (station.hole?.state !== "waiting") station.status = staged[i];
  });

  const visited = (i: number): boolean => stations[i]?.visited === true;
  let runningIndex: number | undefined;
  for (let i = stations.length - 1; i >= 0; i -= 1) {
    if (stations[i]?.status === "running") {
      runningIndex = i;
      break;
    }
  }

  const rails: TimelineRail[] = fold.rails.map((rail: RailSpec) => ({
    from: rail.from,
    ink:
      rail.kind === "stream"
        ? streamInk(stations[rail.from]!, stations[rail.to]!)
        : visited(rail.from) && visited(rail.to)
          ? ("strong" as TimelineInk)
          : "faint",
    ...(rail.kind === undefined ? {} : { kind: rail.kind }),
    to: rail.to,
    ...(railTouchesHole(stations, rail) ? { dashed: true as const } : {}),
  }));
  const lanes = assignAirLanes(arcPairs);
  const arcs: TimelineArc[] = arcPairs.map((arc, at) => {
    const back = arc.to < arc.from;
    const strong = back
      ? visited(arc.from) && (stations[arc.to]?.rounds ?? 0) >= 2
      : visited(arc.from) && visited(arc.to);
    return {
      air: arc.air,
      from: arc.from,
      ink: arc.stream
        ? streamInk(stations[arc.from]!, stations[arc.to]!)
        : strong
          ? "strong"
          : "faint",
      lane: lanes[at] ?? 0,
      ...(arc.stream ? { stream: true as const } : {}),
      to: arc.to,
    };
  });

  // Marching edge: the one entering the running phase from the last settled phase. The projection has no
  for (let r = 0; r < stations.length; r += 1) {
    if (stations[r]?.status !== "running") continue;
    const entry = bandOf(folded, r)?.from ?? r;
    const reentry = arcs.find(
      (arc) =>
        !arc.stream &&
        arc.to === entry &&
        arc.from > arc.to &&
        visited(arc.from) &&
        stations[r]!.rounds >= 2,
    );
    if (reentry !== undefined) {
      reentry.ink = "march";
      continue;
    }
    const inbound = rails.filter(
      (rail) =>
        rail.to === r && rail.kind !== "twin" && rail.kind !== "stream" && visited(rail.from),
    );
    if (inbound.length > 0) {
      for (const rail of inbound) rail.ink = "march";
      continue;
    }
    const landing = arcs.find((arc) => !arc.stream && arc.to === r && visited(arc.from));
    if (landing !== undefined) landing.ink = "march";
  }

  const railInk = (from: number, to: number): TimelineInk =>
    rails.find((rail) => rail.from === from && rail.to === to && rail.kind !== "twin")?.ink ??
    "faint";
  const bands: TimelineBand[] = fold.bands.map((band) => ({
    from: band.from,
    ...(band.join === undefined ? {} : { join: band.join }),
    ...(band.pred === undefined ? {} : { pred: band.pred }),
    to: band.to,
    tracks: band.tracks.map((members) => {
      const head = members[0]!;
      const tail = members[members.length - 1]!;
      return {
        entry:
          band.pred === undefined
            ? ((visited(head) ? "strong" : "faint") as TimelineInk)
            : railInk(band.pred, head),
        exit:
          band.join === undefined
            ? ((visited(tail) ? "strong" : "faint") as TimelineInk)
            : railInk(tail, band.join),
        stations: [...members],
      };
    }),
  }));

  const tailStub = tailStubOf(stations);
  return {
    arcs,
    bands,
    fills: holes.fills,
    ...(Object.keys(holes.parents).length === 0 ? {} : { holeParents: holes.parents }),
    live: run !== undefined,
    rails,
    runningIndex,
    stations,
    ...(tailStub === undefined ? {} : { tailStub }),
  };
}
