// ============================================================
// Making room when the table is full: who yields, when a seat is taken, and how evicted entries stay countable
// ============================================================
// Eviction is a pure function: no clock reads, no I/O. Staged counting of off-table entries lives in workflow-runs-unlisted.ts.
//
// Why evict at all. The legacy over-cap semantics were **reject new**, while the read surface draws "which subagents are running right now"--
// so after a wide-fan-out run passed 1024, no new subagent could enter, and the run card and site roster froze on the earliest
// batch of **already finished** entries, erasing the very reason this feature exists. Eviction inverts it: terminal entries yield.
//
// Rejecting-new alone is not enough: a phase may fire
// **all** actor-created and **all** node-queued within the first seconds, filling both tables with the first 1024 still queued and zero terminal,
// so the next 976 subagents, persons and jobs, are all rejected; the scheduler then dispatches FIFO, and from the 1025th on every
// **running** subagent is off-table. A subagent matters from the moment it is **dispatched**, not enqueued--
// hence `node-dispatched` is also a seating opportunity (activation below).
//
// In-table priority, high to low, by what the subagent is doing **right now**: **running** (a node in dispatched /
// executing / waiting / repairing / nudged) > **idle** (nothing running but still has queued: waiting for a slot) > **finished** (all settled).
// Three invariants constrain who may yield, each with a visible consequence:
//   1. Running entries never yield--the running ones are exactly what we keep;
//   2. An actor never outlives its last **listed** node: the actor tri-state derives from its nodes
//      (workflow-runs-actor-status.ts); a nodeless actor derives as waiting, a pending badge
//      that never moves. So departures are whole-group (actor + all its nodes), and a finished actor that cannot bring its
//      own node simply never enters the table (orphan rule);
//   3. Yielded entries **stay countable**: beyond the two run-level counters (workflow-runs-caps.ts), one more cell is recorded by
//      **birth phase** (workflow-runs-unlisted.ts)--the read surface is drawn per site.

import {
  WORKFLOW_RUNS_LIMITS,
  type WorkflowRunActor,
  type WorkflowRunNode,
  type WorkflowRunState,
} from "./workflow-runs.js";
import { addToUnlistedBucket, withUnlistedBuckets } from "./workflow-runs-unlisted.js";

/**
 * The three entry-capacity bounds used by the reduction; defaults to {@link WORKFLOW_RUNS_LIMITS}.
 // Eviction and counting rules apply to whatever bounds the caller passes.
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

/** A candidate victim: the two keys for intra-class ordering plus its table index. */
interface Candidate {
  index: number;
  phaseName: string | undefined;
  failed: boolean;
}

/** A **non-live group**: one actor plus all its listed nodes (indices), and its class. */
interface Group extends Candidate {
  nodeIndexes: number[];
  /// All owned nodes settled: this subagent's work is done.
  finished: boolean;
  /// Nothing running but still queued: this subagent waits for a slot, work not started.
  idle: boolean;
  /// Not a single listed node: never asked, or its settle was a cache hit without an actor.
  zeroNode: boolean;
}

/** The delta a departing subagent leaves in its cell (`phaseName` is its **birth** phase). */
interface EvictedAgent {
  phaseName: string | undefined;
  actors: number;
  actorsSettled?: number;
  actorsFailed?: number;
}

/** Seating result of one node event. */
export interface WorkflowNodeSeating {
  /// Room was made (possibly evicting entries) and the actor is in place.
  run: WorkflowRunState;
  /// May this instance enter the node table (false = keep rejecting; the caller counts the rejection).
  admitNew: boolean;
  /// This call put an **off-table** instance back into the node table (the caller decrements nodesUnlisted).
  activated: boolean;
}

function sameInstance(left: InstanceRef, right: InstanceRef): boolean {
  return left.siteId === right.siteId && left.ordinal === right.ordinal;
}

function isFailed(node: WorkflowRunNode): boolean {
  return node.outcome === "failed" || node.outcome === "cancelled";
}

/**
 * May this event introduce a **new key** into the table--and equivalently, add a step to `nodesUsed`?
 *
 * **Only overflowed runs (`truncated`) tighten**; `live` is that tightened condition (a watermark-raising birth
 * event, or an activation below). Below the cap everything passes, verbatim as before the eviction rework.
 *
 * Why tighten: eviction is the first thing that **shrinks** the table, so a freed seat may readmit an instance already counted in
 * `nodesUnlisted` (a replayed event, or an intermediate phase arriving after its `queued` was rejected), making that instance
 * both listed and counted--the total would lie.
 *
 * Why not tighten for every run: the reduction **applies as usual** to below-watermark events (it merely refuses to pull the watermark back),
 * and the CLI's cold materialization feeds journal replay and live events into the same reduction. If live events truly opened a run first,
 * its entire journal prefix is below the watermark--blanket tightening would leave that run's card empty. Both holes presuppose
 * "a rejection or eviction happened before", i.e. `truncated`; so gate on it and leave every below-cap path untouched.
 */
export function admitsNewEntry(run: WorkflowRunState, live: boolean): boolean {
  return run.truncated !== true || live;
}

/**
 * When the actor table is full, make room for a **live newcomer** by evicting one finished group. Returns as-is when the table
 * is not full, the newcomer is already present, or no finished group exists (the caller upserts as usual; over cap still rejects new).
 *
 * Birth can only squeeze **finished** entries: why should a still-queued newcomer bump another still-queued one--neither has
 * started; either row is equally uninformative. Idle groups yield only to activation (work actually started).
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
 * Seating one node event: the single entry point for eviction, the B2 rejection, and dispatch-with-birth-facts (activation).
 *
 // The reduction main file therefore hands the event over untouched, never judging "should this seat" itself--that predicate has three arms,
 // each with a reason that exists only after overflow.
 */
export function seatWorkflowNode(
  run: WorkflowRunState,
  seat: {
    eventType: string;
    ref: InstanceRef;
    actorRef: InstanceRef | null;
    /// Present only on `node-dispatched` with birth facts: the actor entry minted from them.
    actor: WorkflowRunActor | null;
    /// This event is the instance's birth event (`node-queued`, or a cache-hit `node-settled`).
    born: boolean;
    advancesWaterMark: boolean;
  },
  limits: WorkflowRunEntryLimits = WORKFLOW_RUNS_LIMITS,
): WorkflowNodeSeating {
  const byBirth = admitsNewEntry(run, seat.born && seat.advancesWaterMark);
  if (!seat.advancesWaterMark) return { run, admitNew: byBirth, activated: false };
  // Replayed events neither make room nor take a seat: both arms below presuppose a watermark raise.
  if (seat.eventType === "node-dispatched" && seat.actor !== null && run.truncated === true) {
    return activateInstance(run, seat.ref, seat.actor, limits);
  }
  if (seat.eventType !== "node-queued") return { run, admitNew: byBirth, activated: false };
  // B2: in an overflowed run, a queued event whose owner cannot be recognized should not even occupy a seat--it cannot draw a badge
  // (pills filter by run.actors), and the work dispatched next needs that seat. Orphan nodes (world-read) are exempt.
  if (
    run.truncated === true &&
    seat.actorRef !== null &&
    !run.actors.some((actor) => sameInstance(actor, seat.actorRef!))
  ) {
    return { run, admitNew: false, activated: false };
  }
  return {
    run: withRoomForNode(run, seat.ref, seat.actorRef, limits),
    admitNew: byBirth,
    activated: false,
  };
}

/**
 * When the node table is full, make room for a **live newcomer**: first evict one settled orphan node (world-read belongs to no group;
 // evicting it just loses a row), else one finished group. Likewise returns as-is when no room can be made.
 *
 * `owner` is the actor the new node belongs to. **Its own group is never the victim**: a subagent on its fourth ask
 // sees its first three asks as a "finished" group at the full table; evicting it would strip this **currently dispatched** subagent
 // from the actor table--the new node stays, pointing at an off-table actor, badge-less.
 // A group that just got work is by definition not finished.
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
 * **Dispatch is seating.** A `node-dispatched` carrying birth facts (the engine re-emits, at dispatch, the same facts its
 // `node-queued` and the subagent's `actor-created` carried) readmits the off-table instance into the node table,
 // and its subagent into the actor table when needed.
 *
 // Order is "actor seat first, node seat second", each judged on its own: evicting a **group** for the actor seat frees at least
 // one node row, while evicting a **zero-node** actor frees none--so the second step re-checks the table length regardless.
 // No room means reject the whole event (the earlier eviction is undone; the run returns as-is), **not** node-only admission--
 // a node pointing at an off-table actor is exactly what this rule exists to prevent.
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
    // Order: own oldest settled node > settled orphan node > someone else's group. Own history goes first
    // because losing it costs one row and the actor stays (badge intact)--a subagent gives up its own row
    // before taking someone else's. Without this, a k-ask subagent would be blocked off-table by **its own**
    // finished work: neither an evictable group (own group is never victim) nor seat-free.
    const own = ownSettledNodes(next, actor)[0];
    if (own !== undefined) next = evictSingleNode(next, own, limits);
    else {
      const loose = pickVictim(looseSettledNodes(next));
      if (loose !== undefined) next = evictSingleNode(next, loose, limits);
      else {
        // A zero-node actor cannot help here (it frees an actor seat, not a node seat), so it may not be the victim.
        const victim = pickGroupVictim(next, actor, false);
        if (victim === undefined) return { run, admitNew: false, activated: false };
        next = evictGroup(next, victim, limits);
      }
    }
  }
  if (!actorListed) {
    // A readmitted subagent is subtracted from its cell (workflow-runs-unlisted.ts): it is no longer off-table.
    next = withUnlistedBuckets(
      { ...next, actors: [...next.actors, actor] },
      addToUnlistedBucket(next.unlistedByPhase, actor.phaseName, { actors: -1 }, limits.maxPhases),
    );
  }
  return { run: next, admitNew: true, activated: !nodeListed };
}

/**
 * A **rejected** `actor-created`: run level has no actor counter; its only trace is its own cell.
 * That cell may later grow or shrink--it means "subagents currently off-table", not a historical total.
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
 * A **born-settled** node rejected off-table (a cache-hit `node-settled`, itself the birth event):
 // record it in its birth-phase cell and, per the orphan rule, strip its actor that has no listed node at all.
 *
 * When the actor was never on the table, record **only** the node cell: the subagent is already counted as `actors` in **its own** birth
 // phase, and the node's phase stamp may differ; worse, a subagent with two cache hits would be counted finished twice.
 // A misattributed count is worse than none--it remains an unlisted subagent, drawn pending until it re-enters the table.
 // The two run-level counters are not touched here--that is `countUnlistedInstance`'s job; adding in both places would double.
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
    // Orphans are attributable and happen once: the actor is right there in the table, its birth phase the one it carries.
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
 * The two tables of a new life. **Overflowed runs restart from empty tables**: re-arming re-emits the whole script prefix, and only
 // empty tables let every instance be listed or counted exactly once this life. Keeping a once-truncated table double-counts--the
 // evicted prefix instance entered `nodesUnlisted`, then lands back in the table on re-emission.
 *
 * Never-overflowed runs are kept as-is (not even the reference): a plain resume's history must not be wiped.
 */
export function workflowRunTablesForNewLife(run: WorkflowRunState): {
  actors: WorkflowRunActor[];
  nodes: WorkflowRunNode[];
} {
  if (run.truncated !== true) return { actors: run.actors, nodes: run.nodes };
  return { actors: [], nodes: [] };
}

/**
 * The group victim of one activation: finished group > idle group > zero-node actor. The `owner` group is always excluded.
 *
 * `allowZeroNode` is passed only by the **actor-seat** arm: removing a zero-node actor frees an actor seat and no node row;
 // spending it on the node seat would make the caller believe a seat was freed while the node still cannot enter.
 */
function pickGroupVictim(
  run: WorkflowRunState,
  owner: InstanceRef | null,
  allowZeroNode: boolean,
): Group | undefined {
  const groups = spareGroups(run, owner);
  return (
    pickVictim(groups.filter((group) => group.finished)) ??
    // The idle victim is the **latest** in the table: under FIFO the last-created is last dispatched; its seat is needed least urgently.
    groups.filter((group) => group.idle).at(-1) ??
    // The zero-node actor likewise takes the latest, and the last class: no nodes, no score, no history in the table;
    // evicting it is invisible to readers, and it returns with facts on its next dispatch. Without this class, a
    // post-resume wide fan-out deadlocks--empty-table restart, the prefix re-creates 2000 actors, cache-hit
    // settles carry no actor, and a table full of zero-node actors blocks every eviction, so every dispatch is rejected.
    (allowZeroNode ? groups.filter((group) => group.zeroNode).at(-1) : undefined)
  );
}

function spareGroups(run: WorkflowRunState, owner: InstanceRef | null): Group[] {
  const groups = listedGroups(run);
  if (owner === null) return groups;
  return groups.filter((group) => !sameInstance(run.actors[group.index]!, owner));
}

/**
 * Intra-class order: non-failed first (failure is the one settled fact readers still want), then the class with
 // the most candidates (spend the cap where entries crowd), then the earliest in the table. Pure, so cold replay evicts the same set.
 */
function pickVictim<T extends Candidate>(candidates: readonly T[]): T | undefined {
  if (candidates.length === 0) return undefined;
  const unfailed = candidates.filter((candidate) => !candidate.failed);
  const pool = unfailed.length > 0 ? unfailed : candidates;
  const crowd = new Map<string, number>();
  // A phase name is never the empty string (schema min(1)), so "" is a collision-free key for the "no phase" cell.
  for (const candidate of pool) {
    const key = candidate.phaseName ?? "";
    crowd.set(key, (crowd.get(key) ?? 0) + 1);
  }
  let best = pool[0]!;
  let bestCrowd = crowd.get(best.phaseName ?? "") ?? 0;
  for (const candidate of pool) {
    const size = crowd.get(candidate.phaseName ?? "") ?? 0;
    // Swap only on **strictly** more crowded, so ties keep the earliest entry in the table.
    if (size > bestCrowd) {
      best = candidate;
      bestCrowd = size;
    }
  }
  return best;
}

/**
 * Every **non-live** group in the table, in actor-table order. At least one listed node is the grouping precondition--an actor
 // that never got work is nobody's candidate (its `node-queued` may still be in flight).
 *
 * Two classes, by what the subagent is doing **now**: no queued node at all = work done (finished);
 // any queued node = waiting for a slot (idle); extra settled asks do not change that. A k-ask subagent
 // after ask one, with ask two queued, is exactly idle--classified by "all nodes queued", it becomes
 // a group neither live nor evictable, and a table full of such groups locks out actually-running newcomers,
 // precisely the symptom this scheme exists to kill (generated engine-shaped event streams would lose 2-4 running subagents per run).
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
      // No listed node at all: only activation's actor-seat arm takes it as victim (see pickGroupVictim);
      // both birth paths accept only `finished`, so this class changes nothing below the cap.
      zeroNode: bucket === undefined,
    });
  });
  return groups;
}

/** Orphan node: a listed node with no actor (world-read). Only settled ones are candidates. */
function looseSettledNodes(run: WorkflowRunState): Candidate[] {
  const candidates: Candidate[] = [];
  run.nodes.forEach((node, index) => {
    if (node.actorSiteId !== undefined || node.phase !== "settled") return;
    candidates.push({ index, phaseName: node.phaseName, failed: isFailed(node) });
  });
  return candidates;
}

/**
 * The newcomer's **own** settled nodes, in table order (earliest = the oldest ask).
 *
 * Not via {@link pickVictim}: within this class the question is not "who should go" but "which history is oldest", and the oldest
 // is the one readers are least likely to revisit. The whole group is still never the victim--rows go, not the person.
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

/** Whole-group departure: the actor and all its nodes leave both tables in the **same** reduction; other entries keep their order. */
function evictGroup(
  run: WorkflowRunState,
  group: Group,
  limits: WorkflowRunEntryLimits,
): WorkflowRunState {
  const actor = run.actors[group.index]!;
  const dropped = new Set(group.nodeIndexes);
  const evicted = group.nodeIndexes.map((index) => run.nodes[index]!);
  // A finished group's departure carries "this subagent has ended"; an idle group merely yields--its work has not started and it
  // returns to the table at its own dispatch (activation), so no actorsSettled is recorded.
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
 * A single node row departs: a settled orphan node, or the newcomer's own oldest settled node.
 *
 * One ledger for both, since neither touches the **people** accounts: no actor leaves, so only the three node entries
 // (the two run-level counters + this node's birth-phase `settled` cell).
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
 * Evicted entries are recorded into the two run-level counters and their birth-phase cells.
 *
 * `nodesUnlisted` grows by **every** evicted node, `nodesUnlistedSettled` only by the **settled** ones:
 // an idle group leaves with still-queued nodes, not yet settled; counting them would inflate completion.
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
