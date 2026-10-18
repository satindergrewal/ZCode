import type { StepRunStatus } from "@/components/workflow-graph/types.js";
import type { TimelinePill, TimelineStation } from "./timeline-model.js";

/**
 * Phase roster: once a station's participants pass the threshold, the pill column
 * becomes "a few pinned pills + the rest". Only the pure partition lives here — who is pinned, who is rest, counts per status — one rule for card, run-tail summary,
 * approval dialog and side panel (invariant 1). The card folds "the rest" into one "n more" row (see the note "five pills and a door",
 * `rosterMore`); the side panel treats that same row as the door, behind it the list grouped by status (see the note "a door and a roll", `rosterRoll`).
 *
 * Subagents the bound cannot list (`station.unlisted`) have no pills, yet the threshold, totals, counts and "n more" must include
 * them: a station's numbers must not shrink as its subagents leave the table; only rows get fewer.
 */

/** Up to this many participants it is still a pill column (six = 222 px, already taller than the roster). */
export const ROSTER_THRESHOLD = 6;
/** Pinned pills on the card: five + one "n more" row = the height of six pills. */
export const ROSTER_PINS_CARD = 5;
/** Pinned pills on the side panel (fill the column, room to name a few more). */
export const ROSTER_PINS_PANE = 5;
/** Faces stacked onto the "n more" row. */
export const ROSTER_DECK = 3;

export type RosterCounts = Record<StepRunStatus, number>;

/**
 * The off-table ones (`station.unlisted`): subagents the reduction cannot list; no pill, no face, no row.
 * The roster only **counts** them — a station's numbers must not shrink as its subagents leave the table. `settled` is the known-finished subset,
 * `failed ⊆ settled`; the remaining `actors − settled` are still running.
 */
export interface RosterUnlisted {
  actors: number;
  settled: number;
  failed: number;
}

const NO_UNLISTED: RosterUnlisted = { actors: 0, failed: 0, settled: 0 };

export interface StationRoster {
  /** Pinned pills: asking -> running -> failed -> participant order; slots never empty. */
  pinned: TimelinePill[];
  /** The rest (unpinned participants), participant order. Off-table ones are not here — they have no pills. */
  rest: TimelinePill[];
  /** All participants (pinned and off-table) counted per status; static pills count as pending. */
  counts: RosterCounts;
  /** The off-table ones; zero when none were lost. */
  unlisted: RosterUnlisted;
  total: number;
}

/** Static (run-less) is pixel-identical to pending, and counts in the same class. */
export function pillStatusOf(pill: Pick<TimelinePill, "status">): StepRunStatus {
  return pill.status ?? "pending";
}

/** Instance key (`siteId@ordinal`): pending questions attach to their asker by it; synthetic lanes have none. */
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
 * Fold the off-table ones into a count: only the `settled` subset has an outcome (failures into failed, the rest done); the remainder
 * is still running, into pending. Subagents rejected at birth or evicted while queued are in `actors` too — recording them as done
 * is the one false sentence the bound must never tell. The count row and the station's counts share this helper; the two always agree.
 */
function addUnlisted(counts: RosterCounts, unlisted: RosterUnlisted): RosterCounts {
  counts.done += unlisted.settled - unlisted.failed;
  counts.failed += unlisted.failed;
  counts.pending += Math.max(0, unlisted.actors - unlisted.settled);
  return counts;
}

/** Attention order: the "n more" face stack shows the most important first; the list's groups follow it too. */
export const ATTENTION_ORDER: readonly StepRunStatus[] = ["failed", "running", "pending", "done"];
const ATTENTION_RANK: Record<StepRunStatus, number> = {
  failed: 0,
  running: 1,
  pending: 2,
  done: 3,
};

/** Stable attention sort: within a tier, keep participant order. */
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
 * Pin order asking -> running -> failed -> participant order: running pills are uncapped, however many run they all pin. Within a bucket
 * participant order holds, so a running pill gives up its slot only when it itself stops — one swap per pin, never a whole-column flip. In a finished
 * run there are neither asking nor running pills, so the order degenerates to failed -> participant order on its own; no extra liveness input needed.
 */
export function stationRoster(
  pills: readonly TimelinePill[],
  options: { pins: number; unlisted?: RosterUnlisted },
): StationRoster | undefined {
  const unlisted = options.unlisted ?? NO_UNLISTED;
  // The threshold judges on **listed + unlisted**: four pills with three hundred evicted behind them is still a roster — else, once that row
  // disappears, three hundred subagents cease to exist on screen.
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
 * A station's roster: the off-chart slot comes from the station (`station.unlisted`), so card and side panel read the same value
 * and neither has to dig through `run.unlistedByPhase` itself.
 */
export function stationRosterOf(
  station: Pick<TimelineStation, "pills" | "unlisted">,
  pins: number,
): StationRoster | undefined {
  return stationRoster(station.pills, {
    pins,
    // `nodesSettled` on the station slot counts nodes; the roster counts people: it feeds fraction only, not this.
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

/** The count row while the door is closed: everything behind it — the listed rest, plus the pill-less off-table ones. */
export function rosterRestCounts(roster: StationRoster): RosterCounts {
  return addUnlisted(rosterCounts(roster.rest), roster.unlisted);
}

/** Content of the card's "n more" row. */
export interface RosterMore {
  /** Unpinned participant count (off-table included — they stand behind this row too). */
  count: number;
  /** Stacked faces: the first few of the rest by attention order (failed -> running -> pending -> done). The off-table have no faces. */
  deck: TimelinePill[];
  /** Failed hidden behind this row (pinned excluded, off-table failures included) — the only status this row tells on the card. */
  failed: number;
}

export function rosterMore(roster: StationRoster, deck: number = ROSTER_DECK): RosterMore {
  const pinnedFailed = roster.pinned.filter((pill) => pillStatusOf(pill) === "failed").length;
  return {
    count: roster.rest.length + roster.unlisted.actors,
    deck: byAttention(roster.rest).slice(0, deck),
    // `counts.failed` already includes off-table failures; subtract the pinned to get "how many still hidden behind this row".
    failed: roster.counts.failed - pinnedFailed,
  };
}

/** One group of the side panel list: the rest sharing a status, participant order. */
export interface RollGroup {
  status: StepRunStatus;
  pills: TimelinePill[];
}

/** The list behind the door: the rest grouped by status, group order = attention order, empty groups absent. */
export function rosterRoll(roster: StationRoster): RollGroup[] {
  return ATTENTION_ORDER.map((status) => ({
    pills: roster.rest.filter((pill) => pillStatusOf(pill) === status),
    status,
  })).filter((group) => group.pills.length > 0);
}
