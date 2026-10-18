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
import { phaseNameMatches, type PhaseNaming } from "@/components/workflow-graph/phase-name.js";
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
 * Timeline model.
 *
 * One pure function folds the bounded display and the `workflowRuns` projection into three things: stations (phases), rail segments (between
 * adjacent stations joined by an edge), and arcs (non-adjacent edges). The chat card, approval dialog and sidebar list all derive from it — invariant 1:
 * "one model, three consumers". No React, no DOM, no time.
 *
 * Order is **declaration order** (payload `phases[]` = order of the first `phase()` marker), no more ranking: two siblings sharing only a
 * predecessor line up in declaration order and the edge between them becomes an arc. Back edges are judged by **direction** (target station on the left), not by the payload's
 * `back` — the analyzer marks re-entry (a second `phase("plan")` marker) as a forward edge, yet on screen it still points left.
 */

export type TimelineInk = "faint" | "strong" | "march";
export type { TimelineRailKind } from "./timeline-bands.js";
// Arc lane assignment is pure index combinatorics and lives in timeline-bands.ts next to band folding; re-exported here so the render layer's entry point stays put.
export { arcLaneCount, assignArcLanes } from "./timeline-bands.js";

export interface TimelinePill {
  /** Split participant id (instance card `${participant}@${ordinal}`); React key and the handle for opening the instance. */
  key: string;
  lane: LaneRef;
  laneClass: LaneClass;
  /** Runtime name emitted by the engine (a persona may rewrite the name in the script); when absent the lane renders the display name. */
  runtimeName?: string;
  /** Avatar number assigned per agent identity within the workflow, reused across phases. */
  avatarIndex?: number;
  /** undefined when there is no run (static pill, pixel-identical to pending). */
  status: StepRunStatus | undefined;
  /** The instance this pill corresponds to in the projection; synthetic lanes (workspace / unknown) have none. */
  instance?: { siteId: string; ordinal: number; sessionId?: string };
  /**
   * Slot identity handed over by the pill: with an instance it is the instance's ordinal; without, the ordinal this pill
   * will have once it exists — member card `member.index + 1`, single card and `many` card 1 (the engine numbers by station order). Only agent lanes
   * inside a live run have it; with it, a subagent that has not started yet can still open a placeholder transcript tab.
   */
  slot?: { siteId: string; ordinal: number };
  /**
   * Handle handed over by the script pill:
   * it has no instance and no session; what it opens is the **whole run's script transcript**, landing on the first card of that station.
   * Mutually exclusive with `slot`: only the workspace lane of a live run has it; with no run there is nothing to open.
   */
  workspace?: { phaseId: string };
  /** This participant's step id in the phase (activity and count material for the sidebar row). */
  stepIds: string[];
  /** Whether this instance has escalation questions awaiting answers (`run.pendingQuestions`); the roster pin rule reads it. */
  asking?: true;
}

export interface TimelineStation {
  id: string;
  naming: PhaseNaming;
  pills: TimelinePill[];
  /** Fold of member step statuses; undefined when there is no run. */
  status: StepRunStatus | undefined;
  /** Whether any node in the projection lands on this station. */
  visited: boolean;
  /** Highest ordinal among nodes on this station; 0 = not reached. */
  rounds: number;
  /** Source or target of a back edge (leftward arc) — only such stations show `⟳ n`. */
  onLoop: boolean;
  /** Track this station sits on (`timeline-bands.ts`); 0 outside any band, i.e. the main line. */
  track: number;
  /** `settled / observed`; absent until at least one node is observed. Instances settled off the chart count in both too. */
  fraction?: { settled: number; observed: number };
  /** Off-chart entries spent at this station (`station-observation.ts`); absent when none were spent. */
  unlisted?: StationUnlisted;
  /** The last unclosed station in the streaming draft. */
  typing?: true;
}

/** A stretch of rail between two adjacent stations on one track; indices point into `stations`. */
export interface TimelineRail {
  from: number;
  to: number;
  ink: TimelineInk;
  /** Absent = an ordinary segment on one track; the two ends of a band are `fork` / `merge`, adjacent stations across tracks inside a band are `twin`. */
  kind?: TimelineRailKind;
}

/**
 * Non-adjacent edges: `to < from` is a back edge. `lane` starts at 0, closest to the tracks is 0; only arcs **intersecting in x** get
 * separate lanes (see {@link assignArcLanes}); unrelated arcs share the same height.
 */
export interface TimelineArc {
  from: number;
  to: number;
  lane: number;
  ink: TimelineInk;
  /** Which air layer the arc is drawn in; lanes are allocated per layer, so `arcLaneCount` must filter by `air` first. */
  air: number;
}

/** One track inside a band; `stations` are its members, in declaration order. */
export interface TimelineTrack {
  stations: number[];
  /** The ink forking into this track; with no predecessor, judged by whether the first station was reached. */
  entry: TimelineInk;
  /** The ink merging out of this track; with no merge station, judged by whether the last station was reached. */
  exit: TimelineInk;
}

/** A band: a contiguous run of stations in declaration order, split across tracks; arcs treat it as one node (`timeline-bands.ts`). */
export interface TimelineBand {
  from: number;
  to: number;
  /** The predecessor station hosting the fork; when absent the drawing shows only a small tail. */
  pred?: number;
  /** The successor station hosting the merge; when absent the drawing shows only a small stub. */
  join?: number;
  tracks: TimelineTrack[];
}

export interface WorkflowTimelineModel {
  stations: TimelineStation[];
  rails: TimelineRail[];
  arcs: TimelineArc[];
  /** Bands folded from parallel phases, ascending by `from`; timelines without `alongside` have none. */
  bands: TimelineBand[];
  /** The currently running station (rightmost when several); undefined if none. */
  runningIndex: number | undefined;
  /** Whether any run projection participates (decides whether lamp / ink have anything to say). */
  live: boolean;
  /** Streaming draft: stations are written stroke by stroke, subagents only counted, never drawn (`draft-scan.ts`). The analyzer's model has no such field. */
  draft?: { agents: number };
}

/** Maps `currentPhase` to a station; same name rule as `phaseEntryFor`. */
function isCurrentPhase(run: WorkflowRunState | undefined, name: string | undefined): boolean {
  return phaseNameMatches(name, run?.currentPhase);
}

/**
 * A station's lamp. Member nodes speak first — running / failed are hard facts;
 * control flow only after that: if this station is the current phase and the run is live, it is running (from the first ask
 * dispatch until the last ask settles and the next marker arrives, control flow sits at this station); a station with no observed nodes (zero members,
 * or the whole station skipped) can only be lit from entry records. `nodeStatus` is the fold's result; absent (undefined) means "no
 * nodes" — the fold never fabricates a pending for a station control flow never visited.
 */
function stationStatus(
  run: WorkflowRunState | undefined,
  nodeStatus: StepRunStatus | undefined,
  current: boolean,
  entered: boolean,
): StepRunStatus | undefined {
  if (run === undefined) return undefined;
  if (nodeStatus === "running" || nodeStatus === "failed") return nodeStatus;
  const live = run.status === "running" || run.status === "pending";
  if (current && live) return "running";
  // The current phase closes with the run's terminal state: a failure at this station counts (nodes or not); cancelled
  // draws the way nodes do: failed as well.
  if (current) return run.status === "completed" ? "done" : "failed";
  if (nodeStatus !== undefined) return nodeStatus;
  return entered ? "done" : "pending";
}

/**
 * One model, three consumers (invariant 1): card, detail page and sidebar list get the **same** model object in the same frame,
 * memoized by (graph, run) object identity — why identity is the right key: `timeline-cache.ts`. The model is read-only,
 * no consumer mutates it, so sharing doubles as referential stability.
 */
export function buildWorkflowTimeline(
  input: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
): WorkflowTimelineModel {
  return sharedTimelineModel(input, run, () => computeWorkflowTimeline(input, run));
}

function computeWorkflowTimeline(
  input: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
): WorkflowTimelineModel {
  const graph = withImplicitPhase(input);
  const phases = graph.phases ?? [];
  const index = new Map(phases.map((phase, i) => [phase.id, i]));
  const members = phaseMembers(graph);
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

  // Edges: dedupe by index first (self-loops and edges into unlisted phases say nothing at this granularity), then hand to band folding —
  // adjacent pairs become rail segments, the rest become arcs; the band absorbs the fork/merge edges (`timeline-bands.ts`).
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
  const folded = foldPhaseBands(
    phases.length,
    phases.map((phase) =>
      (phase.alongside ?? []).flatMap((id) => {
        const at = index.get(id);
        return at === undefined ? [] : [at];
      }),
    ),
  );
  const fold = foldPhaseEdges(phases.length, folded, edges);
  const arcPairs = [...fold.arcs].sort(
    (left, right) => Math.abs(left.from - left.to) - Math.abs(right.from - right.to),
  );
  // Both ends of a back edge get the ring; when an endpoint is inside a band the whole band rings — a band is one node, re-entry rings the band.
  const onLoop = new Set<number>();
  for (const arc of arcPairs) {
    if (arc.to >= arc.from) continue;
    for (const end of [arc.from, arc.to]) {
      const band = bandOf(folded, end);
      if (band === undefined) onLoop.add(end);
      else for (let i = band.from; i <= band.to; i += 1) onLoop.add(i);
    }
  }

  // Name hashes collide; assign consecutive numbers by participant identity so an agent keeps one avatar across phases.
  const avatarIndexes = new Map<string, number>();
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
      // Empty fold = this subagent did nothing at this station in this run: hollow is honest. undefined is reserved for
      // run-less static pills.
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
    return {
      id: phase.id,
      naming: { id: phase.id, ...(phase.name === undefined ? {} : { name: phase.name }) },
      pills,
      status: stationStatus(
        run,
        collapseStatuses(
          memberSteps.map((step) => step.id),
          overlay.statuses,
        ),
        isCurrentPhase(run, phase.name),
        observed.entered,
      ),
      visited: observed.visited,
      rounds: observed.rounds,
      onLoop: onLoop.has(i),
      track: trackOf(folded, i),
      ...(observed.observed === 0
        ? {}
        : { fraction: { observed: observed.observed, settled: observed.settled } }),
      ...(unlisted === undefined ? {} : { unlisted }),
    };
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
    ink: visited(rail.from) && visited(rail.to) ? ("strong" as TimelineInk) : "faint",
    ...(rail.kind === undefined ? {} : { kind: rail.kind }),
    to: rail.to,
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
      ink: strong ? "strong" : "faint",
      lane: lanes[at] ?? 0,
      to: arc.to,
    };
  });

  // Traveling edge: the one entering the running phase from the last settled phase. The projection has no timestamps, so three rules pick
  // the most honest candidate: re-entry back edge > rail segment into the station > any arc landing on it.
  // Evaluated per running station — two tracks of a band can run at once, and each of their forks should light up.
  for (let r = 0; r < stations.length; r += 1) {
    if (stations[r]?.status !== "running") continue;
    const entry = bandOf(folded, r)?.from ?? r;
    const reentry = arcs.find(
      (arc) =>
        arc.to === entry && arc.from > arc.to && visited(arc.from) && stations[r]!.rounds >= 2,
    );
    if (reentry !== undefined) {
      reentry.ink = "march";
      continue;
    }
    // The twin segment is not the control-flow path; it only says "these two run in parallel" and never travels.
    const inbound = rails.filter(
      (rail) => rail.to === r && rail.kind !== "twin" && visited(rail.from),
    );
    if (inbound.length > 0) {
      for (const rail of inbound) rail.ink = "march";
      continue;
    }
    const landing = arcs.find((arc) => arc.to === r && visited(arc.from));
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

  return { arcs, bands, live: run !== undefined, rails, runningIndex, stations };
}

/** What a pill is "doing now": prefers the running step's label, then the last settled one, then the first. */
export function pillActivity(
  graph: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
  pill: TimelinePill,
): { label: string; asks: number; reads: number } {
  const stepsById = new Map(graph.steps.map((step) => [step.id, step]));
  const statuses = run === undefined ? {} : workflowRunOverlay(run, graph).statuses;
  let asks = 0;
  let reads = 0;
  let running: string | undefined;
  let done: string | undefined;
  let first: string | undefined;
  for (const id of pill.stepIds) {
    const step = stepsById.get(id);
    if (step === undefined) continue;
    if (step.kind === "world-read") reads += 1;
    else asks += 1;
    first ??= step.label;
    const status = statuses[id];
    if (status === "running") running ??= step.label;
    else if (status === "done" || status === "failed") done = step.label;
  }
  return { asks, label: running ?? done ?? first ?? "", reads };
}
