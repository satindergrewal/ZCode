import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import type { TimelinePill, TimelineStation } from "./timeline-model.js";

/**
 * Phase roster: past the threshold, a station's pill column becomes pinned pills plus the rest. Pure
 * partitioning only, who is pinned, who is rest, counts per state; one rule for card, turn-end summary, confirm
 * dialog and side pane (invariant 1). The card folds the rest into one N-more row (rosterMore); the side pane
 * treats that row as a gate with the state-grouped roster behind it (rosterRoll).
 *
 * Subagents beyond the display cap (station.unlisted) get no pill but count toward threshold, totals, counts
 * and N-more: a station's numbers never shrink because its subagents left the table, only the row does.
 */

/** Up to this many participants stays a pill column (six = 222px, already taller than a roster). */
export const ROSTER_THRESHOLD = 6;
/** Pinned pills on the card: five plus an N-more row = six pill heights. */
export const ROSTER_PINS_CARD = 5;
/** Pinned pills on the side pane: fill the column, room to name a few more. */
export const ROSTER_PINS_PANE = 5;
/** Faces stacked on the N-more row. */
export const ROSTER_DECK = 3;

export type RosterCounts = Record<StepRunStatus, number>;

/**
 * The unlisted (station.unlisted): subagents the reduction leaves off the table, no pill, no face, no row.
 * The roster only COUNTS them; a station's numbers must not shrink when its subagents leave. settled is the
 * known-finished part, failed a subset; actors minus settled still owes runs.
 */
export interface RosterUnlisted {
  actors: number;
  settled: number;
  failed: number;
}

const NO_UNLISTED: RosterUnlisted = { actors: 0, failed: 0, settled: 0 };

export interface StationRoster {
  /** Pinned pills: asking, running, failed, then participant-order backfill; a slot never sits empty. */
  pinned: TimelinePill[];
  /** The rest (unpinned) in participant order; unlisted absent, they have no pills. */
  rest: TimelinePill[];
  /** All participants (pinned and unlisted) counted by state; static pills count pending. */
  counts: RosterCounts;
  /** The unlisted; zero when none went missing. */
  unlisted: RosterUnlisted;
  total: number;
}

/** Static (run-less) is pixel-identical to pending and counts the same. */
export function pillStatusOf(pill: Pick<TimelinePill, "status">): StepRunStatus {
  return pill.status ?? "pending";
}

/** Instance key siteId@ordinal; pending questions hang off it; synthesized lanes none. */
export function pillInstanceKey(pill: Pick<TimelinePill, "instance">): string | undefined {
  return pill.instance === undefined
    ? undefined
    : `${pill.instance.siteId}@${pill.instance.ordinal}`;
}

export function rosterCounts(pills: readonly TimelinePill[]): RosterCounts {
  const counts: RosterCounts = { done: 0, failed: 0, pending: 0, running: 0 };
  for (const pill of pills) counts[pillStatusOf(pill)] += 1;
  return counts;
}

/**
 * Folding unlisted into a count: only the settled part has outcomes (failed into failed, rest done), the
 * remainder is still owed and counts pending. Subagents rejected at birth or evoked-then-evicted while queued
 * also sit in actors; calling them done is the one lie the UI must not tell. The count row and the station
 * total share this path so the two can never disagree.
 */
function addUnlisted(counts: RosterCounts, unlisted: RosterUnlisted): RosterCounts {
  counts.done += unlisted.settled - unlisted.failed;
  counts.failed += unlisted.failed;
  counts.pending += Math.max(0, unlisted.actors - unlisted.settled);
  return counts;
}

/** Attention order: the N-more stack shows the most important first; roster groups sort by it too. */
export const ATTENTION_ORDER: readonly StepRunStatus[] = ["failed", "running", "pending", "done"];
const ATTENTION_RANK: Record<StepRunStatus, number> = {
  failed: 0,
  running: 1,
  pending: 2,
  done: 3,
};

/** Stable attention sort: participant order within a tier. */
function byAttention(pills: readonly TimelinePill[]): TimelinePill[] {
  return pills
    .map((pill, index) => ({ index, pill }))
    .sort(
      (left, right) =>
        ATTENTION_RANK[pillStatusOf(left.pill)] - ATTENTION_RANK[pillStatusOf(right.pill)] ||
        left.index - right.index,
    )
    .map((entry) => entry.pill);
}

/**
 * Pin order asking, running, failed, participant-order: no cap on running, as many as run get pinned.
 * Within a tier participant order holds, so a running pin yields only when IT stops; one swap per change, never
 * a whole-column reshuffle. A finished run has no asking/running pills, the order degenerates to failed-then
 * -participant with no liveness input needed.
 */
export function stationRoster(
  pills: readonly TimelinePill[],
  options: { pins: number; unlisted?: RosterUnlisted },
): StationRoster | undefined {
  const unlisted = options.unlisted ?? NO_UNLISTED;
  // Threshold judges on-table PLUS unlisted: four pills left with three hundred evicted behind still is a
  // roster, or one vanished row erases three hundred subagents from the screen.
  const total = pills.length + unlisted.actors;
  if (total <= ROSTER_THRESHOLD) return undefined;
  const counts = addUnlisted(rosterCounts(pills), unlisted);

  const pinned: TimelinePill[] = [];
  const pin = (pill: TimelinePill) => {
    if (pinned.length < options.pins && !pinned.includes(pill)) pinned.push(pill);
  };
  for (const pill of pills) if (pill.asking === true) pin(pill);
  for (const pill of pills) if (pillStatusOf(pill) === "running") pin(pill);
  for (const pill of pills) if (pillStatusOf(pill) === "failed") pin(pill);
  for (const pill of pills) pin(pill);

  const rest = pills.filter((pill) => !pinned.includes(pill));
  return { counts, pinned, rest, total, unlisted };
}

/**
 * A station's roster: the unlisted cell comes off the station (station.unlisted), so card and side pane read
 * the same value and neither digs through run.unlistedByPhase itself.
 */
export function stationRosterOf(
  station: Pick<TimelineStation, "pills" | "unlisted">,
  pins: number,
): StationRoster | undefined {
  return stationRoster(station.pills, {
    pins,
    // The station cell's nodesSettled counts nodes; the roster counts people. It feeds fraction only, not here.
    ...(station.unlisted === undefined
      ? {}
      : {
          unlisted: {
            actors: station.unlisted.actors,
            failed: station.unlisted.failed,
            settled: station.unlisted.settled,
          },
        }),
  });
}

/** Rest counts plus unlisted folded in. */
export function rosterRestCounts(roster: StationRoster): RosterCounts {
  return addUnlisted(rosterCounts(roster.rest), roster.unlisted);
}

/** The card's N-more row (rosterMore). */
export interface RosterMore {
  /** Unpinned participants (unlisted too, they stand behind this row). */
  count: number;
  /** Stacked faces: attention-order head of the rest (failed, running, pending, done); unlisted have no faces. */
  deck: TimelinePill[];
  /** Failed hidden behind the row (unpinned; unlisted failures count), the row's only stated status. */
  failed: number;
}

export function rosterMore(roster: StationRoster, deck: number = ROSTER_DECK): RosterMore {
  const pinnedFailed = roster.pinned.filter((pill) => pillStatusOf(pill) === "failed").length;
  return {
    count: roster.rest.length + roster.unlisted.actors,
    deck: byAttention(roster.rest).slice(0, deck),
    // counts.failed already includes unlisted failures; minus pinned = hidden behind this row.
    failed: roster.counts.failed - pinnedFailed,
  };
}

/** One roll group: same-status rest in participant order. */
export interface RollGroup {
  status: StepRunStatus;
  pills: TimelinePill[];
}

/** The roll behind the gate: rest grouped by state, attention order, empty groups absent. */
export function rosterRoll(roster: StationRoster): RollGroup[] {
  return ATTENTION_ORDER.map((status) => ({
    pills: roster.rest.filter((pill) => pillStatusOf(pill) === status),
    status,
  })).filter((group) => group.pills.length > 0);
}
