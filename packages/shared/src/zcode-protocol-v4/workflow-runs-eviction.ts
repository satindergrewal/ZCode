// ============================================================
// Eviction on a full table: who yields, when seating happens, and how the evicted stay countable
// ============================================================
// Lives outside the reduction main file, same reason as workflow-runs-caps.ts/-concurrency.ts/
// -phases.ts/-started.ts (the main file's max-lines gate) and the same discipline: pure functions,
// no clock, no I/O. Bucket add/subtract lives in sibling workflow-runs-unlisted.ts.
//
// Why evict at all. The old over-cap semantics were reject-new, while the UI paints who is running
// right now: a wide-fan-out run past 1024 admits no new subagent, and the run card plus roster
// freeze on the earliest finished batch, defeating the feature. Eviction inverts it: terminal
// entries yield.
//
// Eviction alone is not enough; the 2026-09-20 incident (5 x 2000 subagents, concurrency 13) was
// exactly the other half: one phase emitted every actor-created and node-queued within seconds, the
// first 1024 queued entries filled both tables with no terminal at all, and the remaining 976 were
// rejected whole; the scheduler then dispatched FIFO, so from 1025 on no running subagent was in
// any table. A subagent matters when it is GIVEN work, not when it queues, so node-dispatched is
// also a seating opportunity (activation below).
//
// In-table priority, high to low, by what the subagent is doing right now: running (a node in
// dispatched/executing/waiting/repairing/nudged) > idle (none running, some queued: waiting for a
// slot) > finished (all settled). Three invariants bound who may yield, each with a visible
// consequence:
//   1. Running entries never yield; those are exactly what we keep.
//   2. An actor never outlives its last LISTED node: the actor trichotomy derives from its nodes
//      (workflow-runs-actor-status.ts) and a node-less actor derives waiting, a never-moving
//      pending badge in the UI. So departure is whole-group (actor + all its nodes), and a finished
//      actor that cannot carry into its own node never enters the table (orphan rule).
//   3. Evicted entries stay countable: beyond the two run-level counters (workflow-runs-caps.ts),
//      one more bucket per birth phase (workflow-runs-unlisted.ts); the UI is drawn per site.

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunActor,
  type WorkflowRunNode,
  type WorkflowRunState,
} from "./workflow-runs.js";
import { addToUnlistedBucket, withUnlistedBuckets } from "./workflow-runs-unlisted.js";

/**
 * The three entry bounds the reduction needs. Defaults are {@link WORKFLOW_RUNS_LIMITS}; a separate
 * interface exists so tests can inject tiny bounds, since 1024 needs thousands of events to hit and
 * these rules are independent of bound size.
 */
export interface WorkflowRunEntryLimits {
  readonly maxActors: number;
  readonly maxNodes: number;
  readonly maxPhases: number;
}

interface InstanceRef {
  siteId: string;
  ordinal: number;
}

/** One candidate victim: the two intra-class sort keys plus its table index. */
interface Candidate {
  index: number;
  phaseName: string | undefined;
  failed: boolean;
}

/** One non-live group: an actor plus all its listed nodes (indices), and its class. */
interface Group extends Candidate {
  nodeIndexes: number[];
  /** All nodes settled: this subagent's work is done. */
  finished: boolean;
  /** Nothing running but some queued: waiting for a slot, work not started. */
  idle: boolean;
  /** No listed nodes at all: never asked, or its settle is an old-journal cache hit without an actor. */
  zeroNode: boolean;
}

/** A departing subagent's bucket delta (phaseName is its birth phase). */
interface EvictedAgent {
  phaseName: string | undefined;
  actors: number;
  actorsSettled?: number;
  actorsFailed?: number;
}

/** Seating result for one node event. */
export interface WorkflowNodeSeating {
  /** The run after eviction (entries may be gone) with the actor seated. */
  run: WorkflowRunState;
  /** May this instance enter the node table? false = reject-new as before; caller counts the rejection. */
  admitNew: boolean;
  /** An off-table instance was seated this time (caller decrements nodesUnlisted). */
  activated: boolean;
}

function sameInstance(left: InstanceRef, right: InstanceRef): boolean {
  return left.siteId === right.siteId && left.ordinal === right.ordinal;
}

function isFailed(node: WorkflowRunNode): boolean {
  return node.outcome === "failed" || node.outcome === "cancelled";
}

/**
 * May this event insert a NEW key, and equivalently add a nodesUsed step?
 *
 * Only overflowed runs (truncated) tighten; live receives the tightened predicate (a birth event
// beyond the watermark, or activation below). Below the cap everything passes, verbatim as before
// eviction existed.
 *
 * Why tighten: eviction is the first thing that SHRINKS the table, so a freed slot may re-admit an
 * instance already counted in nodesUnlisted (a replayed event, or a mid-phase arriving after its
 * queued was rejected); then it is both listed and counted and the totals lie.
 *
 * Why not tighten everywhere: the reduction still applies below-watermark events (it merely refuses
 * to lower the watermark), and CLI cold materialization feeds journal replays and live events into
// the same reduction. If live events started a run first, its whole journal prefix is below the
 * watermark and blanket tightening would blank that run's card. Both holes presuppose a prior
 * rejection or eviction, i.e. truncated, so the gate keys on that and touches nothing below the cap.
 */
export function admitsNewEntry(run: WorkflowRunState, live: boolean): boolean {
  return run.truncated !== true || live;
}

/**
 * Frees an actor slot for a LIVE newcomer by evicting one finished group. Returns the run unchanged
 * when the table is not full, the newcomer is already present, or no finished group exists (the
 * caller upserts as before; over cap still reject-new).
 *
 * Birth can only push aside FINISHED actors: why would one queued newcomer displace another? Both
 * idle, either record is equally uninformative. Idle groups yield only to activation (real work
 * started).
 */
export function withRoomForActor(
  run: WorkflowRunState,
  ref: InstanceRef,
  limits: WorkflowRunEntryLimits = WORKFLOW_RUNS_LIMITS,
): WorkflowRunState {
  if (run.actors.length < limits.maxActors) return run;
  if (run.actors.some((actor) => sameInstance(actor, ref))) return run;
  const victim = pickVictim(listedGroups(run).filter((group) => group.finished));
  return victim === undefined ? run : evictGroup(run, victim, limits);
}

/**
 * Seats one node event: the single entry point for eviction, the B2 rejection, and birth-carrying
 * dispatch (activation).
 *
 * The reduction main file just hands the event over; the should-this-seat predicate has three arms,
 * each with a reason that exists only past the cap.
 */
export function seatWorkflowNode(
  run: WorkflowRunState,
  seat: {
    eventType: string;
    ref: InstanceRef;
    actorRef: InstanceRef | null;
    /** Only on birth-fact-carrying node-dispatched: the actor entry minted from those facts. */
    actor: WorkflowRunActor | null;
    /** This event is the instance's birth (node-queued, or a cache-hit node-settled). */
    born: boolean;
    advancesWaterMark: boolean;
  },
  limits: WorkflowRunEntryLimits = WORKFLOW_RUNS_LIMITS,
): WorkflowNodeSeating {
  const byBirth = admitsNewEntry(run, seat.born && seat.advancesWaterMark);
  if (!seat.advancesWaterMark) return { run, admitNew: byBirth, activated: false };
  // Replays neither evict nor seat: both arms below presuppose beyond-the-watermark.
  if (seat.eventType === "node-dispatched" && seat.actor !== null && run.truncated === true) {
    return activateInstance(run, seat.ref, seat.actor, limits);
  }
  // B2: on an overflowed run, an owner-less birth should not occupy a slot at all. It cannot draw
  // a badge (pills filter by run.actors) and later dispatched work needs the slot. Both births
  // count: node-queued, and the cache settle that re-carries birth facts. Admitting the latter
  // deadlocks: a node naming an actor is not orphaned, and groups are built from listed actors, so
  // it is no victim class and can never be evicted. Orphan nodes (world-read) are exempt.
  if (
    seat.born &&
    run.truncated === true &&
    seat.actorRef !== null &&
    !run.actors.some((actor) => sameInstance(actor, seat.actorRef!))
  ) {
    return { run, admitNew: false, activated: false };
  }
  // Born-settled cache hits never evict (never ran, no in-flight state to show); eviction serves
  // live newcomers only.
  if (seat.eventType !== "node-queued") return { run, admitNew: byBirth, activated: false };
  return {
    run: withRoomForNode(run, seat.ref, seat.actorRef, limits),
    admitNew: byBirth,
    activated: false,
  };
}

/**
 * Frees a node slot for a LIVE newcomer: first a settled orphan node (world-read belongs to no
 * group; evicting it costs one row), else a finished group. Also returns unchanged when nothing
 * frees up.
 *
 * owner is the actor the new node belongs to. Its own group is never the victim: on a fourth ask
 * against a full table, the first-three group looks finished, and evicting it removes the
// currently-dispatched subagent from the actor table; the new node stays, pointing at an absent
// actor, badge-less. A group that just got work is not finished, by definition.
 */
function withRoomForNode(
  run: WorkflowRunState,
  ref: InstanceRef,
  owner: InstanceRef | null,
  limits: WorkflowRunEntryLimits,
): WorkflowRunState {
  if (run.nodes.length < limits.maxNodes) return run;
  if (run.nodes.some((node) => sameInstance(node, ref))) return run;
  const loose = pickVictim(looseSettledNodes(run));
  if (loose !== undefined) return evictSingleNode(run, loose, limits);
  const victim = pickVictim(spareGroups(run, owner).filter((group) => group.finished));
  return victim === undefined ? run : evictGroup(run, victim, limits);
}

/**
 * Dispatch seats. A node-dispatched carrying birth facts (the engine re-sends, at dispatch, the
 * same facts its node-queued and the subagent's actor-created once carried) returns the off-table
 * instance to the node table and, when needed, its subagent to the actor table.
 *
// Eviction order is actor-slot then node-slot, each judged on its own: evicting a group for the
 * actor slot frees at least one node row, while evicting a zero-node actor frees none, so step two
 * rechecks the table length. If no slot frees, reject the whole event (the earlier eviction is
 * undone; the run returns as-was) and do NOT seat the node alone: a node pointing at an off-table
 * actor is exactly what this rule exists to prevent.
 */
function activateInstance(
  run: WorkflowRunState,
  ref: InstanceRef,
  actor: WorkflowRunActor,
  limits: WorkflowRunEntryLimits,
): WorkflowNodeSeating {
  const nodeListed = run.nodes.some((node) => sameInstance(node, ref));
  const actorListed = run.actors.some((listed) => sameInstance(listed, actor));
  if (nodeListed && actorListed) return { run, admitNew: true, activated: false };
  let next = run;
  if (!actorListed && next.actors.length >= limits.maxActors) {
    const victim = pickGroupVictim(next, null, true);
    if (victim === undefined) return { run, admitNew: false, activated: false };
    next = evictGroup(next, victim, limits);
  }
  if (!nodeListed && next.nodes.length >= limits.maxNodes) {
    // Order: own oldest settled node > settled orphan > another's group. Own history goes first
    // because it costs one row and the actor stays (badge intact): a subagent surrenders its own
    // row before taking someone else's. Without this, a k-ask subagent is blocked by its own
    // finished work: not an evictable group (own group is never victim) yet occupying slots.
    const own = ownSettledNodes(next, actor)[0];
    if (own !== undefined) next = evictSingleNode(next, own, limits);
    else {
      const loose = pickVictim(looseSettledNodes(next));
      if (loose !== undefined) next = evictSingleNode(next, loose, limits);
      else {
        // A zero-node actor cannot help here (it frees an actor slot, not a node row), so it is
        // not a victim.
        const victim = pickGroupVictim(next, actor, false);
        if (victim === undefined) return { run, admitNew: false, activated: false };
        next = evictGroup(next, victim, limits);
      }
    }
  }
  if (!actorListed) {
    // A returning subagent is subtracted from its bucket (workflow-runs-unlisted.ts): no longer off-table.
    next = withUnlistedBuckets(
      { ...next, actors: [...next.actors, actor] },
      addToUnlistedBucket(next.unlistedByPhase, actor.phaseName, { actors: -1 }, limits.maxPhases),
    );
  }
  return { run: next, admitNew: true, activated: !nodeListed };
}

/**
 * A rejected actor-created: no run-level actor counter exists, so its only trace is its own bucket.
 * The bucket later goes up and down; it counts subagents off-table now, not history.
 */
export function absorbRefusedActor(
  run: WorkflowRunState,
  phaseName: string | undefined,
  limits: WorkflowRunEntryLimits = WORKFLOW_RUNS_LIMITS,
): WorkflowRunState {
  return withUnlistedBuckets(
    run,
    addToUnlistedBucket(run.unlistedByPhase, phaseName, { actors: 1 }, limits.maxPhases),
  );
}

/**
 * A born-settled node rejected off-table (cache-hit node-settled, itself the birth): record its
 * birth-phase bucket and, per the orphan rule, drop its actor if the actor has no listed nodes.
 *
 * When the actor is already off-table, record ONLY the node bucket: the subagent was already counted
 * as actors in its own birth phase, the node's phase stamp may differ, and a twice-cache-hit
 * subagent would be counted finished twice. An imprecise attribution is worse than none; it remains
 * an unlisted subagent, pending in the UI, until re-listed. The run-level counters are not added
 * here; that is countUnlistedInstance's job, and doubling would inflate.
 */
export function absorbRefusedSettledNode(
  run: WorkflowRunState,
  node: WorkflowRunNode,
  limits: WorkflowRunEntryLimits = WORKFLOW_RUNS_LIMITS,
): WorkflowRunState {
  let buckets = addToUnlistedBucket(
    run.unlistedByPhase,
    node.phaseName,
    { settled: 1 },
    limits.maxPhases,
  );
  const owner =
    node.actorSiteId === undefined || node.actorOrdinal === undefined
      ? null
      : { siteId: node.actorSiteId, ordinal: node.actorOrdinal };
  const index = owner === null ? -1 : run.actors.findIndex((actor) => sameInstance(actor, owner));
  const actor = index < 0 ? undefined : run.actors[index]!;
  const orphan = actor !== undefined && !ownsListedNode(run, actor);
  if (orphan) {
    // The orphan is attributable and happens once: the actor is in the table, its birth phase its own.
    buckets = addToUnlistedBucket(
      buckets,
      actor.phaseName,
      { actors: 1, actorsSettled: 1, actorsFailed: isFailed(node) ? 1 : 0 },
      limits.maxPhases,
    );
  }
  return withUnlistedBuckets(
    orphan ? { ...run, actors: run.actors.filter((_, position) => position !== index) } : run,
    buckets,
  );
}

/**
 * Both tables for the new generation. An overflowed run RESTARTS EMPTY: re-arming re-sends the whole
// script prefix, and only empty tables give every instance exactly one of listed-or-counted this
// generation. Keeping a once-truncated table double-counts: the evicted prefix entry is already in
// nodesUnlisted and returns to the table on the resend.
 *
 * An never-overflowed run is kept as-is (not even a new reference): plain-resume history must survive.
 */
export function workflowRunTablesForNewLife(run: WorkflowRunState): {
  actors: WorkflowRunActor[];
  nodes: WorkflowRunNode[];
} {
  if (run.truncated !== true) return { actors: run.actors, nodes: run.nodes };
  return { actors: [], nodes: [] };
}

/**
 * Group victim for one activation: finished > idle > zero-node actor. The owner's group is always
 * excluded.
 *
 * allowZeroNode is passed only by the actor-slot arm: a zero-node actor's exit frees an actor slot
 * and no node row; offering it for the node slot would look like success while the node still
 * cannot enter.
 */
function pickGroupVictim(
  run: WorkflowRunState,
  owner: InstanceRef | null,
  allowZeroNode: boolean,
): Group | undefined {
  const groups = spareGroups(run, owner);
  return (
    pickVictim(groups.filter((group) => group.finished)) ??
    // Idle groups: take the LAST listed. Under FIFO the newest actor is dispatched last; its slot is
    // least urgent.
    groups.filter((group) => group.idle).at(-1) ??
    // Zero-node actors: likewise the last listed, and the last resort. No nodes, no score, no
    // history; evicting one is invisible to readers, and it returns with facts on its next
    // dispatch. Without this tier a post-resume wide fan-out deadlocks: empty restart, the prefix
    // re-creates 2000 actors, their first asks unanswered (old-journal cache settles carry no
    // actor), the table is all zero-node actors with nothing evictable, and every dispatch is
    // rejected.
    (allowZeroNode ? groups.filter((group) => group.zeroNode).at(-1) : undefined)
  );
}

function spareGroups(run: WorkflowRunState, owner: InstanceRef | null): Group[] {
  const groups = listedGroups(run);
  if (owner === null) return groups;
  return groups.filter((group) => !sameInstance(run.actors[group.index]!, owner));
}

/**
 * Intra-class order: non-failed first (failure is the one settled fact readers still want back),
 * then the phase with the most candidates (spend the cap where entries crowd), then lowest table
 * index. Pure, so cold replays evict the same set.
 */
function pickVictim<T extends Candidate>(candidates: readonly T[]): T | undefined {
  if (candidates.length === 0) return undefined;
  const unfailed = candidates.filter((candidate) => !candidate.failed);
  const pool = unfailed.length > 0 ? unfailed : candidates;
  const crowd = new Map<string, number>();
  // Phase names are never empty (schema min(1)), so the empty string is a collision-free key for
  // the no-phase bucket.
  for (const candidate of pool) {
    const key = candidate.phaseName ?? "";
    crowd.set(key, (crowd.get(key) ?? 0) + 1);
  }
  let best = pool[0]!;
  let bestCrowd = crowd.get(best.phaseName ?? "") ?? 0;
  for (const candidate of pool) {
    const size = crowd.get(candidate.phaseName ?? "") ?? 0;
    // Switch victims only on strictly larger crowding; ties keep the lowest table index.
    if (size > bestCrowd) {
      best = candidate;
      bestCrowd = size;
    }
  }
  return best;
}

/**
 * Every non-live group in the table, in actor-table order. At least one listed node is the price of
 * admission: an actor never given work is nobody's candidate (its node-queued may be in flight).
 *
 * Two classes, by what the subagent is doing now: no queued node = finished; any queued node = idle
// (waiting for a slot), however many of its asks already settled. A thrice-asking subagent between
// ask one done and ask two queued is idle: classify it by any-queued or it becomes a non-live group
// nobody can evict, and a table full of those locks out running newcomers, the exact symptom this
// scheme kills (the generated engine-shape stream lost 2-4 running subagents per run to it).
 */
function listedGroups(run: WorkflowRunState): Group[] {
  const owned = new Map<
    string,
    { nodeIndexes: number[]; live: boolean; queued: boolean; failed: boolean }
  >();
  run.nodes.forEach((node, index) => {
    if (node.actorSiteId === undefined || node.actorOrdinal === undefined) return;
    const key = instanceKey({ siteId: node.actorSiteId, ordinal: node.actorOrdinal });
    const bucket = owned.get(key) ?? { nodeIndexes: [], live: false, queued: false, failed: false };
    bucket.nodeIndexes.push(index);
    if (node.phase === "queued") bucket.queued = true;
    else if (node.phase !== "settled") bucket.live = true;
    if (isFailed(node)) bucket.failed = true;
    owned.set(key, bucket);
  });
  const groups: Group[] = [];
  run.actors.forEach((actor, index) => {
    const bucket = owned.get(instanceKey(actor));
    if (bucket?.live === true) return;
    groups.push({
      index,
      phaseName: actor.phaseName,
      failed: bucket?.failed ?? false,
      nodeIndexes: bucket?.nodeIndexes ?? [],
      finished: bucket !== undefined && !bucket.queued,
      idle: bucket?.queued === true,
      // No listed nodes: only activation's actor-slot arm takes it as victim (see pickGroupVictim);
      // both birth paths require finished, so below the cap this tier changes nothing.
      zeroNode: bucket === undefined,
    });
  });
  return groups;
}

/** Orphan node: a listed node with no actor (world-read, or an old-journal cache hit). Only settled ones are candidates. */
function looseSettledNodes(run: WorkflowRunState): Candidate[] {
  const candidates: Candidate[] = [];
  run.nodes.forEach((node, index) => {
    if (node.actorSiteId !== undefined || node.phase !== "settled") return;
    candidates.push({ index, phaseName: node.phaseName, failed: isFailed(node) });
  });
  return candidates;
}

/**
 * The newcomer's OWN settled nodes, table order (lowest index = oldest ask).
 *
 * Not pickVictim: the choice here is oldest-history, not most-dispensable, and the oldest is the
 * least revisitable. The whole group still never exits; rows go, people stay.
 */
function ownSettledNodes(run: WorkflowRunState, owner: InstanceRef): Candidate[] {
  const candidates: Candidate[] = [];
  run.nodes.forEach((node, index) => {
    if (node.actorSiteId !== owner.siteId || node.actorOrdinal !== owner.ordinal) return;
    if (node.phase !== "settled") return;
    candidates.push({ index, phaseName: node.phaseName, failed: isFailed(node) });
  });
  return candidates;
}

function ownsListedNode(run: WorkflowRunState, actor: WorkflowRunActor): boolean {
  return run.nodes.some(
    (node) => node.actorSiteId === actor.siteId && node.actorOrdinal === actor.ordinal,
  );
}

function instanceKey(ref: InstanceRef): string {
  return `${ref.siteId}\0${ref.ordinal}`;
}

/** Whole-group exit: actor and all its nodes leave both tables in the same reduction; others keep order. */
function evictGroup(
  run: WorkflowRunState,
  group: Group,
  limits: WorkflowRunEntryLimits,
): WorkflowRunState {
  const actor = run.actors[group.index]!;
  const dropped = new Set(group.nodeIndexes);
  const evicted = group.nodeIndexes.map((index) => run.nodes[index]!);
  // A finished group's exit carries this-subagent-is-done; an idle group merely yields, its work
  // not started, and it returns via activation when dispatched, so no actorsSettled.
  return {
    ...withUnlistedEvictions(
      run,
      evicted,
      {
        phaseName: actor.phaseName,
        actors: 1,
        ...(group.finished ? { actorsSettled: 1, actorsFailed: group.failed ? 1 : 0 } : {}),
      },
      limits,
    ),
    actors: run.actors.filter((_, index) => index !== group.index),
    nodes: run.nodes.filter((_, index) => !dropped.has(index)),
    truncated: true,
  };
}

/**
 * Single-row node exit: a settled orphan, or the newcomer's own oldest settled node.
 *
 * One ledger for both, because neither touches the people-account: no actor leaves, so only the
 * node's three entries (two run-level counters + the settled bucket of the node's birth phase).
 */
function evictSingleNode(
  run: WorkflowRunState,
  candidate: Candidate,
  limits: WorkflowRunEntryLimits,
): WorkflowRunState {
  const node = run.nodes[candidate.index]!;
  return {
    ...withUnlistedEvictions(run, [node], undefined, limits),
    nodes: run.nodes.filter((_, index) => index !== candidate.index),
    truncated: true,
  };
}

/**
 * Records evicted entries into the two run-level counters and per-birth-phase buckets.
 *
 * nodesUnlisted counts ALL evicted nodes; nodesUnlistedSettled only the settled ones: an idle group
 * leaves queued nodes behind unsettled, and counting those would inflate completion.
 */
function withUnlistedEvictions(
  run: WorkflowRunState,
  nodes: readonly WorkflowRunNode[],
  agent: EvictedAgent | undefined,
  limits: WorkflowRunEntryLimits,
): WorkflowRunState {
  let buckets = run.unlistedByPhase;
  if (agent !== undefined) {
    const { phaseName, ...delta } = agent;
    buckets = addToUnlistedBucket(buckets, phaseName, delta, limits.maxPhases);
  }
  let settledCount = 0;
  for (const node of nodes) {
    if (node.phase !== "settled") continue;
    settledCount += 1;
    buckets = addToUnlistedBucket(buckets, node.phaseName, { settled: 1 }, limits.maxPhases);
  }
  const settledTotal = (run.usage.nodesUnlistedSettled ?? 0) + settledCount;
  return withUnlistedBuckets(
    {
      ...run,
      usage: {
        ...run.usage,
        nodesUnlisted: (run.usage.nodesUnlisted ?? 0) + nodes.length,
        // At zero the whole key is absent (same rule as workflow-runs-caps.ts).
        ...(settledTotal > 0 ? { nodesUnlistedSettled: settledTotal } : {}),
      },
    },
    buckets,
  );
}
