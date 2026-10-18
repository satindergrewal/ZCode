import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { phaseBinder } from "./instance-phases.js";
import { aggregateRunStatuses, statusOfRunNode } from "./run-status.js";
import {
  IMPLICIT_PHASE_ID,
  MAIN_LANE_ID,
  type StepRunStatus,
  type StepStatusTable,
  type WorkflowCausalityGraphData,
  type WorkflowHandoffData,
  type WorkflowParticipantData,
  type WorkflowPhaseData,
} from "./types.js";

/**
 * Pure participant-layer selectors.
 *
 * The payload's participants already wear the analyzer's handoff order (first = opener) and handoffs are
 * reduced; this layer only buckets, folds statuses, counts, plus two UI-side duties:
 *   - synthesize an implicit phase for unmarked scripts (withImplicitPhase) so the board has one drawing;
 *   - live, split many-cards by real instances, narrow member cards by ordinal, and bind a single-card to its
 *     only instance or split it too on multiples (liveParticipantView).
 *
 * No React, no DOM: the projection layer and components consume it; tests call it directly.
 */

export { IMPLICIT_PHASE_ID };

/** Once the only view-switch predicate; now it only answers whether this graph needs an implicit phase. */
export function hasPhaseVocabulary(graph: WorkflowCausalityGraphData): boolean {
  return graph.phases !== undefined && graph.phases.length > 0;
}

/**
 * A script without phase markers becomes one implicit module: the phase table holds only workflow (no name,
 * the UI localizes it), no phase edges; control flow reaches normal completion iff the script returns anything.
 * Every step and card folds into it (the analyzer's unphased is a no-phase placeholder, card ids intact).
 * Graphs with a phase vocabulary return as-is (referential equality, memo-friendly).
 */
export function withImplicitPhase(graph: WorkflowCausalityGraphData): WorkflowCausalityGraphData {
  if (hasPhaseVocabulary(graph)) return graph;
  return {
    ...graph,
    exits: graph.sink !== undefined && graph.sink.length > 0 ? [IMPLICIT_PHASE_ID] : [],
    participants: graph.participants.map((participant) => ({
      ...participant,
      phase: IMPLICIT_PHASE_ID,
    })),
    phaseEdges: [],
    phases: [{ id: IMPLICIT_PHASE_ID }],
    steps: graph.steps.map((step) => ({ ...step, phase: IMPLICIT_PHASE_ID })),
  };
}

/**
 * One phase's participants in payload order (= handoff order). The main agent's lane (main) does not count:
 * its only step is the open hole and the hole is a station itself (presentation.md Pills).
 *
 * Fix (2026-09-29, testfield): the analyzer puts the open hole in the phase containing the hole() call and emits
 * a main-lane participant; handed through verbatim, the timeline drew a nameless subagent and the station grew
 * an unnamed-subagent pill
 */
export function participantsOfPhase(
  graph: WorkflowCausalityGraphData,
  phaseId: string,
): WorkflowParticipantData[] {
  return graph.participants.filter(
    (participant) => participant.phase === phaseId && participant.lane !== MAIN_LANE_ID,
  );
}

export function participantById(
  graph: WorkflowCausalityGraphData,
  id: string,
): WorkflowParticipantData | undefined {
  return graph.participants.find((participant) => participant.id === id);
}

/** Handoff edges with both ends in the given set (intra-phase edges). */
export function handoffsWithin(
  graph: WorkflowCausalityGraphData,
  ids: ReadonlySet<string>,
): WorkflowHandoffData[] {
  return graph.handoffs.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
}

export function handoffsAround(
  graph: WorkflowCausalityGraphData,
  id: string,
): { incoming: WorkflowHandoffData[]; outgoing: WorkflowHandoffData[] } {
  return {
    incoming: graph.handoffs.filter((edge) => edge.to === id),
    outgoing: graph.handoffs.filter((edge) => edge.from === id),
  };
}

/** Count material for the card's second row: ask count and workspace reads (at most one is nonzero per card). */
export interface ParticipantCounts {
  asks: number;
  reads: number;
}

export function participantCounts(
  graph: WorkflowCausalityGraphData,
  participant: WorkflowParticipantData,
): ParticipantCounts {
  const kinds = new Map(graph.steps.map((step) => [step.id, step.kind]));
  let asks = 0;
  let reads = 0;
  for (const id of participant.steps) {
    const kind = kinds.get(id);
    // The hole site itself (kind hole) is not an ask: no code there yet.
    if (kind === "hole") continue;
    if (kind === "world-read") reads += 1;
    else asks += 1;
  }
  return { asks, reads };
}

/** Any step with repeat renders the repeat glyph (self-loops vanish at participant grain; this is their trace). */
export function participantRepeats(
  graph: WorkflowCausalityGraphData,
  participant: WorkflowParticipantData,
): boolean {
  const repeating = new Set(
    graph.steps.filter((step) => step.repeat !== undefined).map((step) => step.id),
  );
  return participant.steps.some((id) => repeating.has(id));
}

/**
 * Fold of several step statuses: collect statuses of steps with entries and hand to aggregateRunStatuses
 * (the only fold; its lattice lives there). Steps without entries do not participate, they are sites control
 * flow never walked, not queued nodes; no entry at all (or static render) returns undefined. Shared by card,
 * station and inspector-header lamp.
 */
export function collapseStatuses(
  stepIds: readonly string[],
  statuses: StepStatusTable | undefined,
): StepRunStatus | undefined {
  if (statuses === undefined) return undefined;
  const values: StepRunStatus[] = [];
  for (const id of stepIds) {
    const status = statuses[id];
    if (status !== undefined) values.push(status);
  }
  return aggregateRunStatuses(values);
}

/**
 * A card's status: the live view's per-instance narrowed override wins (member cards / split instance cards),
 * else the fold of its steps.
 */
export function participantStatus(
  participant: WorkflowParticipantData,
  statuses: StepStatusTable | undefined,
  participantStatuses?: Record<string, StepRunStatus>,
): StepRunStatus | undefined {
  return participantStatuses?.[participant.id] ?? collapseStatuses(participant.steps, statuses);
}

/** Which other phases the same lane appears in (the inspector's also-in row). */
export function participantAlsoIn(
  graph: WorkflowCausalityGraphData,
  participant: WorkflowParticipantData,
): WorkflowPhaseData[] {
  const phases = new Set(
    graph.participants
      .filter((other) => other.lane === participant.lane && other.phase !== participant.phase)
      .map((other) => other.phase),
  );
  return (graph.phases ?? []).filter((phase) => phases.has(phase.id));
}

/** Split instance-card id: participant@ordinal. */
export function instanceCardId(participantId: string, ordinal: number): string {
  return `${participantId}@${ordinal}`;
}

/**
 * Instances under one card: each split instance card's own (many-cards, multi single-cards), or the one the
 * original card BINDS (single card with exactly one instance, member card's i-th). The name is the engine's
 * effective name and the card face prefers it.
 */
export interface ParticipantInstance {
  /** Participant id before the split (the card's own id when bound). */
  participant: string;
  ordinal: number;
  name?: string;
  /**
   * Bound-not-split: card id and label rules unchanged (member cards keep #i, single cards unlabeled), the
   * runtime name gets no visual mark. Absent = a split instance card labeled #ordinal.
   */
  bound?: true;
}

export interface LiveParticipantView {
  /** Graph with participants and handoffs split per instance; the input graph itself without a run (same reference). */
  graph: WorkflowCausalityGraphData;
  /** Card statuses narrowed per instance (member, instance cards); the rest fold by step. */
  participantStatuses: Record<string, StepRunStatus>;
  /** Instance-card id to identity. */
  instances: Record<string, ParticipantInstance>;
}

/**
 * Live view.
 *
 *  - many-cards: one card per appeared actor instance on the lane, handoff edges copied per instance from the
 *    original; unappeared instances keep the original card (status by step fold).
 *  - single card: exactly one instance on the lane binds it (id unchanged, status still by step fold, name at last);
 *    more than one takes the many-card split path, runtime cardinality beats static.
 *  - member cards (literal expansion): member i binds the lane's i-th instance by ordinal, status reads only that
 *    instance's nodes; unappeared means pending and unbound. Instances beyond of render no card.
 *  - synthesized lanes (workspace etc) have no instances; cards untouched.
 *
 * Nodes narrow by (siteId in the card's sites, actorSiteId == lane, actorOrdinal == ordinal, the card's phase in
 * phasesOf(node)); the site is step.source ?? step.id (may-set copies report the site id, same source as
 * run-status.ts's correlation key). An instance whose sites have no node yet is pending: the instance is an
 * observed fact that has not acted here; the fold's undefined-on-empty is by design, unpacking absence is ours.
 *
 * Instance binding: a card's claimed instances are no longer the whole lane's. When k phases re-enter one site,
 * k cards share the lane and lane-claiming broadcasts (every site listing all 100). See instancesOfCard.
 */
export function liveParticipantView(
  graph: WorkflowCausalityGraphData,
  run: WorkflowRunState | undefined,
): LiveParticipantView {
  if (run === undefined) return { graph, instances: {}, participantStatuses: {} };
  const siteOf = new Map(graph.steps.map((step) => [step.id, step.source ?? step.id]));
  const binder = phaseBinder(graph, run);
  const sitesOf = (participant: WorkflowParticipantData) =>
    new Set(participant.steps.map((id) => siteOf.get(id) ?? id));
  const index = runIndex(run);
  /**
   * Instances under THIS card: actors on the lane that left a node on this card's sites with the node's stamp
   * inside this card's phase; actors with no node on those sites yet (created un-asked, or not reached) file by
   * their OWN birth stamp. In stamp-less runs phasesOf is always every phase, and the two rules together are
   * exactly today's by-lane behavior, byte-identical for old runs.
   *
   * Served from the lane index instead of rescanning run.nodes per card (see runIndex). One sort per lane,
   * same order as the old filter-then-sort: stable sort, order-preserving filter.
   */
  const instancesOfCard = (participant: WorkflowParticipantData, sites: ReadonlySet<string>) => {
    const claimed: WorkflowRunState["actors"][number][] = [];
    for (const actor of index.actorsBySite.get(participant.lane) ?? []) {
      let seen = false;
      let here = false;
      for (const node of index.nodesByActor.get(actorKey(participant.lane, actor.ordinal)) ?? []) {
        if (!sites.has(node.siteId)) continue;
        seen = true;
        if (binder.has(participant.phase, node.phaseName)) {
          here = true;
          break;
        }
      }
      if (here || (!seen && binder.has(participant.phase, actor.phaseName))) claimed.push(actor);
    }
    return claimed;
  };
  const statusFor = (
    participant: WorkflowParticipantData,
    ordinal: number,
    sites: ReadonlySet<string>,
  ): StepRunStatus => {
    const values: StepRunStatus[] = [];
    for (const node of index.nodesByActor.get(actorKey(participant.lane, ordinal)) ?? []) {
      if (!sites.has(node.siteId) || !binder.has(participant.phase, node.phaseName)) continue;
      values.push(statusOfRunNode(node));
    }
    return aggregateRunStatuses(values) ?? "pending";
  };

  const participants: WorkflowParticipantData[] = [];
  const replacements = new Map<string, string[]>();
  const participantStatuses: Record<string, StepRunStatus> = {};
  const instances: Record<string, ParticipantInstance> = {};
  let changed = false;
  for (const participant of graph.participants) {
    const sites = sitesOf(participant);
    const actors = instancesOfCard(participant, sites);
    if (participant.member !== undefined) {
      const actor = actors[participant.member.index];
      participantStatuses[participant.id] =
        actor === undefined ? "pending" : statusFor(participant, actor.ordinal, sites);
      if (actor !== undefined) instances[participant.id] = boundInstance(participant.id, actor);
      participants.push(participant);
      continue;
    }
    if (participant.many !== true && actors.length === 1) {
      instances[participant.id] = boundInstance(participant.id, actors[0]!);
      participants.push(participant);
      continue;
    }
    if (participant.many === true || actors.length > 1) {
      if (actors.length === 0) {
        participants.push(participant);
        continue;
      }
      changed = true;
      const ids: string[] = [];
      for (const actor of actors) {
        const id = instanceCardId(participant.id, actor.ordinal);
        const { many: _many, ...rest } = participant;
        participants.push({ ...rest, id });
        participantStatuses[id] = statusFor(participant, actor.ordinal, sites);
        instances[id] = {
          ordinal: actor.ordinal,
          participant: participant.id,
          ...(actor.name === undefined ? {} : { name: actor.name }),
        };
        ids.push(id);
      }
      replacements.set(participant.id, ids);
      continue;
    }
    participants.push(participant);
  }
  if (!changed) return { graph, instances, participantStatuses };

  const handoffs: WorkflowHandoffData[] = [];
  for (const edge of graph.handoffs) {
    const froms = replacements.get(edge.from) ?? [edge.from];
    const tos = replacements.get(edge.to) ?? [edge.to];
    for (const from of froms) for (const to of tos) handoffs.push({ ...edge, from, to });
  }
  return { graph: { ...graph, handoffs, participants }, instances, participantStatuses };
}

/**
 * Keys join with a NUL, same reason as shared workflow-runs-actor-status.ts: siteId is engine-given free
 * text and printable separators like dash collide (a-1,2) vs (a,1-2).
 */
function actorKey(siteId: string, ordinal: number): string {
  return `${siteId}\0${ordinal}`;
}

interface RunIndex {
  /** actorKey to the instances' nodes, in run.nodes order. */
  nodesByActor: ReadonlyMap<string, WorkflowRunState["nodes"][number][]>;
  /** Lane to its actors, ascending by ordinal (claim order). */
  actorsBySite: ReadonlyMap<string, WorkflowRunState["actors"][number][]>;
}

/**
 * Two indexes built once per view (docs/dynamic-workflow/presentation.md The timeline model, Cost). Without
 * them every instance card rescans run.nodes for its own status; the table bounds are 1024 instances x 1024
 * nodes, a million comparisons per frame (14ms measured, per card and per detail page). Indexed, modeling is
 * linear in actors + nodes.
 *
 * Nodes without an actor (world-read) and old payloads without ordinals stay out: the old filter
 * node.actorSiteId == lane && node.actorOrdinal == ordinal is false for them anyway; dropping equals keeping.
 */
function runIndex(run: WorkflowRunState): RunIndex {
  const nodesByActor = new Map<string, WorkflowRunState["nodes"][number][]>();
  for (const node of run.nodes) {
    if (node.actorSiteId === undefined || node.actorOrdinal === undefined) continue;
    const key = actorKey(node.actorSiteId, node.actorOrdinal);
    const bucket = nodesByActor.get(key);
    if (bucket === undefined) nodesByActor.set(key, [node]);
    else bucket.push(node);
  }
  const actorsBySite = new Map<string, WorkflowRunState["actors"][number][]>();
  for (const actor of run.actors) {
    const bucket = actorsBySite.get(actor.siteId);
    if (bucket === undefined) actorsBySite.set(actor.siteId, [actor]);
    else bucket.push(actor);
  }
  for (const actors of actorsBySite.values()) actors.sort((a, b) => a.ordinal - b.ordinal);
  return { actorsBySite, nodesByActor };
}

function boundInstance(
  participantId: string,
  actor: WorkflowRunState["actors"][number],
): ParticipantInstance {
  return {
    bound: true,
    ordinal: actor.ordinal,
    participant: participantId,
    ...(actor.name === undefined ? {} : { name: actor.name }),
  };
}
