import type { WorkflowRunState } from "@zcode/shared/zcode-protocol-v4";
import { phaseBinder } from "./instance-phases.js";
import { aggregateRunStatuses, statusOfRunNode } from "./run-status.js";
import {
  IMPLICIT_PHASE_ID,
  type StepRunStatus,
  type StepStatusTable,
  type WorkflowCausalityGraphData,
  type WorkflowHandoffData,
  type WorkflowParticipantData,
  type WorkflowPhaseData,
} from "./types.js";

/**
 * Pure selectors over the participant layer.
 *
 * The payload's `participants` already arrive in the analyzer's **hand-off order** (the
 * first card is the opener) and `handoffs` is already reduced; this layer only buckets,
 * collapses statuses, counts, plus two UI-owned concerns:
 *   - unstamped scripts get one implicit phase (`withImplicitPhase`) so the board has a
 *     single rendering;
 *   - while running, `many` cards split per real instance, member cards narrow by
 *     ordinal, and single-instance cards bind their instance or split the same way
 *     (`liveParticipantView`).
 *
 * No React, no DOM: consumed by the projection layer and components, called directly by tests.
 */

export { IMPLICIT_PHASE_ID };

/** Used to be the sole view switch; now it only answers whether this graph needs an implicit phase. */
export function hasPhaseVocabulary(graph: WorkflowCausalityGraphData): boolean {
  return graph.phases !== undefined && graph.phases.length > 0;
}

/**
 * A script without `phase()` stamps becomes one implicit module: the phase table holds
 * only `workflow` (no name; the UI localizes it to "Workflow"), no phase edges, and the
 * control flow reaches normal completion iff the script yields a result; every step and
 * every card belongs to it (the analyzer's `unphased` is just a "no phase" placeholder;
 * card ids are unchanged).
 * Graphs with a vocabulary are returned as-is (reference equality, memo-friendly).
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

/** A phase's participants, in payload order (= hand-off order). */
export function participantsOfPhase(
  graph: WorkflowCausalityGraphData,
  phaseId: string,
): WorkflowParticipantData[] {
  return graph.participants.filter((participant) => participant.phase === phaseId);
}

export function participantById(
  graph: WorkflowCausalityGraphData,
  id: string,
): WorkflowParticipantData | undefined {
  return graph.participants.find((participant) => participant.id === id);
}

/** Hand-off edges with both ends in the given set (intra-phase edges). */
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

/** Card sub-row counters: ask count and workspace-read count (at most one is nonzero per card). */
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
    if (kinds.get(id) === "world-read") reads += 1;
    else asks += 1;
  }
  return { asks, reads };
}

/** Any step with `repeat` => the card shows the repeat glyph (self-loops vanish at participant granularity; this is their trace). */
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
 * Collapsing several step statuses: collect the statuses of owned steps that **have an
 * entry** and hand them to `aggregateRunStatuses` (the only collapse; see the lattice
 * there). Steps without an entry do not participate — they are sites the control flow
 * never reached, not queued nodes; with no entries at all (or a static render) return
 * undefined. Shared by card, station, and inspector header light.
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
 * One card's status: the per-instance narrowed override from the live view wins
 * (member cards / split instance cards); otherwise collapse over its steps.
 */
export function participantStatus(
  participant: WorkflowParticipantData,
  statuses: StepStatusTable | undefined,
  participantStatuses?: Record<string, StepRunStatus>,
): StepRunStatus | undefined {
  return participantStatuses?.[participant.id] ?? collapseStatuses(participant.steps, statuses);
}

/** Which other phases the same lane appears in (the inspector's "also in" row). */
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

/** Split instance-card id: `${participant.id}@${ordinal}`. */
export function instanceCardId(participantId: string, ordinal: number): string {
  return `${participantId}@${ordinal}`;
}

/**
 * The instances under one card:
 * each split instance card (`many` cards, multi-instance single cards) owns exactly its
 * one, or the instance the original card **binds** (single cards with exactly one
 * instance, a member card's i-th). The name is the effective name emitted by the engine;
 * the card face prefers it.
 */
export interface ParticipantInstance {
  /** Participant id before the split (when bound, this card's own id). */
  participant: string;
  ordinal: number;
  name?: string;
  /**
   * The original card binds instead of splitting: card id unchanged, label rules
   * unchanged (member cards keep `#i`, single cards unlabeled) — the runtime name gets
   * no visual marker. Absent = a split instance card, labeled `#ordinal`.
   */
  bound?: true;
}

export interface LiveParticipantView {
  /** Graph with participants and handoffs split per instance; without a run it is the input graph (reference-equal). */
  graph: WorkflowCausalityGraphData;
  /** Per-instance narrowed card statuses (member cards, instance cards); other cards collapse over steps. */
  participantStatuses: Record<string, StepRunStatus>;
  /** Instance-card id -> identity. */
  instances: Record<string, ParticipantInstance>;
}

/**
 * Live view.
 *
 *  - `many` cards: one card per actor instance that has appeared on the lane, hand-off
 *    edges copied from the original card to every instance card; while an instance has
 *    not appeared, keep the original card (status collapsed over steps).
 *  - Single card: exactly one instance on the lane -> the original card binds it (id
 *    unchanged, status still collapsed over steps, it just gains a name); more than one
 *    -> the same split path as `many` — runtime cardinality beats static cardinality.
 *  - Member cards (literal cardinality expansion): member i binds the i-th instance by
 *    ordinal order on the lane and its status reads only that instance's nodes; instance
 *    not yet present -> pending, unbound. Instances beyond `of` render no card.
 *  - Synthetic lanes such as workspace have no instances; cards stay untouched.
 *
 * Nodes narrow by `(siteId in the card's sites, actorSiteId === lane,
 * actorOrdinal === ordinal, the card's phase in phasesOf(node))`; the site is
 * `step.source ?? step.id` (may-set copies report the site id, the same correlation key
 * as run-status.ts). An instance whose sites have no nodes yet -> pending: the instance
 * is an observed fact that merely has not acted at this station (the collapse itself
 * only says undefined for the empty set; resolving absence is this layer's job).
 *
 * "Instance binding": the instances a card claims are no longer every instance on the
 * **whole lane** — when k phases re-enter one site, k cards share a lane, and claiming
 * by lane would be a broadcast (every station listing all 100). See
 * {@link instancesOfCard}.
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
   * Instances under this card: actors on the lane that left a node at **this card's
   * sites** whose stamp lands in this card's phase; actors with no node at those sites
   * yet (created but not asked, or not reached) are placed by their **own birth stamp**.
   * In stamp-less runs `phasesOf` is always every phase, so together these two rules are
   * exactly the old "by lane" — byte-identical for old runs.
   *
   * Uses the lane index instead of rescanning `run.nodes` per card: see {@link runIndex}.
   * Each lane sorts once, the same order as the old filter-then-sort — stable sort, and
   * filtering preserves order.
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
 * Keys join with `\0`, same reasoning as shared's `workflow-runs-actor-status.ts`: siteId
 * is an arbitrary engine string, and printable separators like `-` collide
 * ("a-1", 2) with ("a", "1-2").
 */
function actorKey(siteId: string, ordinal: number): string {
  return `${siteId}\0${ordinal}`;
}

interface RunIndex {
  /** `actorKey` -> the instance's nodes, in `run.nodes` order. */
  nodesByActor: ReadonlyMap<string, WorkflowRunState["nodes"][number][]>;
  /** Lane -> that lane's actors, sorted ascending by ordinal (claim order). */
  actorsBySite: ReadonlyMap<string, WorkflowRunState["actors"][number][]>;
}

/**
 * Two indexes built once per view. Without them every instance card would rescan
 * `run.nodes` to collect its status — the table bounds are 1024 instances x 1024 nodes,
 * i.e. a million comparisons per frame. With indexes, modeling is linear in actors + nodes.
 *
 * Nodes without an actor (world-read) and old payloads without ordinals are not indexed:
 * the original filter `node.actorSiteId === lane && node.actorOrdinal === ordinal` is
 * always false for them, so dropping them is equivalent.
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
