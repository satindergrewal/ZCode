// ============================================================
// The situation snapshot's **event index**: one pass over journal events yields every "how long ago"
// ============================================================
// The phase-table, subagent-roster, and health read faces
// share one time source -- `StoredEvent.timeCreated`, when the event hit the journal. Node rows
// (`NodeRecord`) carry no time columns, so "when did this ask start" / "when did it last move"
// can only come from the event track.
//
// This module is that scan, and only that scan: pure, no I/O, no port types. Its three consumers
// (-roster-phases / -roster-subagents / -roster) share its product, so one getRunDetail
// reads events once -- this read gets pricier with run length; reading twice pays double for nothing.

import type { StoredEvent } from "@zcode/dynamic-workflow";

/**
 * Event types that **count** for "still moving": the script advanced, or some ask did.
 *
 * `phase-entered` and `log` count: they are the **script's** motion -- a script running world reads
 * between asks emits no ask events; excluding them would misreport that span as stalled.
 *
 * `node-waiting` deliberately does **not** count: waiting for a slot/backoff is the stall itself; counting it as progress
 * means `stalledSince` never appears -- the most typical stall shape. `concurrency-changed` and
 * `run-stalled` likewise: observations **about not-moving**, not motion.
 */
const PROGRESS_EVENT_TYPES: ReadonlySet<string> = new Set([
  "node-queued",
  "node-dispatched",
  "node-executing",
  "node-settled",
  "node-progress",
  "phase-entered",
  "log",
  "report",
  "artifact-published",
  "usage-updated",
]);

/**
 * Node **lifecycle** events (phase transitions). `node-progress` is not one -- a round resolving is no lifecycle
 * transition, verbatim the reducer-side discipline; subagents' `waiting` verdict is thus never interrupted by progress.
 */
const NODE_LIFECYCLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "node-queued",
  "node-dispatched",
  "node-executing",
  "node-waiting",
  "node-repairing",
  "node-nudged",
  "node-settled",
]);

/** Instance key: `siteId@ordinal`, the engine's `refToString` shape. */
export function instanceKey(siteId: string, ordinal: number): string {
  return `${siteId}@${ordinal}`;
}

/** What the current ask waits for (the last `node-waiting` observation + when this wait began). */
export interface RosterWaitTrace {
  cause: "slot" | "backoff";
  reason?: string;
  retryAfterMs?: number;
  since?: number;
}

/** One node instance's track record on the event stream. */
export interface RosterNodeTrace {
  /** This generation's last `node-dispatched` instant (`node-queued` clears it: a requeue is a new generation). */
  dispatchedAt?: number;
  /** Last lifecycle event type; the subagent `waiting` verdict only checks for `node-waiting`. */
  lastLifecycleType?: string;
  /** Present only while currently waiting (any other lifecycle event clears it). */
  wait?: RosterWaitTrace;
  /** The instant of the last `node-progress` that carried lastTool. */
  lastToolAt?: number;
  /** The instant of this instance's last progress-like event. */
  lastActivityAt?: number;
}

/** A phase's most recent entry and exit instants. */
export interface RosterPhaseTrace {
  enteredAt?: number;
  exitedAt?: number;
}

/** One node settlement, in event order; the health face's failure streak and cache-hit accounting derive from it. */
export interface RosterSettlement {
  key: string;
  outcome: string;
  cached: boolean;
}

/** The full product of one scan. */
export interface RosterEventIndex {
  nodes: ReadonlyMap<string, RosterNodeTrace>;
  phases: ReadonlyMap<string, RosterPhaseTrace>;
  settlements: readonly RosterSettlement[];
  /** The run-wide last progress-like event instant. */
  lastProgressAt?: number;
  /** The last `run-stalled` instant with no progress-like event after it; else absent. */
  stalledSince?: number;
  /** The last `concurrency-changed` reason and instant (the numeric cap comes from the reducer side). */
  concurrencyReason?: string;
  concurrencySince?: number;
}

/**
 * One pass; yields every instant the situation snapshot needs.
 *
 * `now` is this read's instant, an upper **clamp** only: journals travel across machines, and an instant later
 * than "now" renders as a negative age -- reading like a broken tool, not a skewed clock. Events without timestamps (legacy in-memory
 * journal doubles) leave the field absent, never backfilled from `now`: that would stamp a week of history "just now".
 */
export function indexRosterEvents(events: readonly StoredEvent[], now: number): RosterEventIndex {
  const nodes = new Map<string, RosterNodeTrace>();
  const phases = new Map<string, RosterPhaseTrace>();
  const settlements: RosterSettlement[] = [];
  let lastProgressAt: number | undefined;
  let stalledAt: number | undefined;
  let stalledPending = false;
  let concurrencyReason: string | undefined;
  let concurrencySince: number | undefined;
  let lastPhaseName: string | undefined;

  for (const stored of events) {
    const { event } = stored;
    const at = timeOf(stored, now);

    if (PROGRESS_EVENT_TYPES.has(event.type)) {
      lastProgressAt = laterOf(lastProgressAt, at);
      // Any progress after the stall observation ends the stall -- even an untimestamped one:
      // "it moved again" and "when it moved" are two questions; the former needs no clock.
      stalledPending = false;
    }

    if (event.type === "run-stalled") {
      stalledAt = at;
      stalledPending = true;
      continue;
    }
    if (event.type === "concurrency-changed") {
      concurrencyReason = event.reason;
      concurrencySince = at;
      continue;
    }
    if (event.type === "phase-entered") {
      lastPhaseName = trackPhase(phases, event.name, lastPhaseName, at);
      continue;
    }
    if (!("instance" in event)) continue;

    const key = instanceKey(event.instance.siteId, event.instance.ordinal);
    const trace = nodes.get(key) ?? {};
    if (PROGRESS_EVENT_TYPES.has(event.type)) {
      trace.lastActivityAt = laterOf(trace.lastActivityAt, at);
    }
    if (NODE_LIFECYCLE_EVENT_TYPES.has(event.type)) {
      trackLifecycle(trace, event.type, at);
    }
    if (event.type === "node-waiting") {
      // Already waiting -> keep the **entry** instant: the backoff ladder emits several node-waiting, and the reader asks
      // "how long stuck", not "when was the last observation". Reason and retry interval take the latest.
      const since = trace.wait?.since ?? at;
      trace.wait = {
        cause: event.cause,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
        ...(event.retryAfterMs === undefined ? {} : { retryAfterMs: event.retryAfterMs }),
        ...(since === undefined ? {} : { since }),
      };
    }
    if (event.type === "node-progress" && event.lastTool !== undefined && at !== undefined) {
      trace.lastToolAt = at;
    }
    if (event.type === "node-settled") {
      settlements.push({ key, outcome: event.outcome, cached: event.cached === true });
    }
    nodes.set(key, trace);
  }

  return {
    nodes,
    phases,
    settlements,
    ...(lastProgressAt === undefined ? {} : { lastProgressAt }),
    ...(stalledPending && stalledAt !== undefined ? { stalledSince: stalledAt } : {}),
    ...(concurrencyReason === undefined ? {} : { concurrencyReason }),
    ...(concurrencySince === undefined ? {} : { concurrencySince }),
  };
}

/**
 * Records a `phase-entered`: it opens its own span and closes the previous differently-named phase.
 * A same-name re-entry (a back edge) only moves the entry instant, never counts as leaving itself. Returns the new last-entered name.
 */
function trackPhase(
  phases: Map<string, RosterPhaseTrace>,
  name: string,
  lastPhaseName: string | undefined,
  at: number | undefined,
): string {
  if (lastPhaseName !== undefined && lastPhaseName !== name && at !== undefined) {
    const previous = phases.get(lastPhaseName);
    if (previous !== undefined) previous.exitedAt = at;
  }
  // The latest entry, not the first: a phase circled three times is asked "how long into this lap".
  // Re-entry clears the previous lap's exit -- it is open again.
  phases.set(name, at === undefined ? {} : { enteredAt: at });
  return name;
}

/** Records one lifecycle event: a requeue clears the previous generation's dispatch instant; any non-waiting event clears the wait. */
function trackLifecycle(trace: RosterNodeTrace, type: string, at: number | undefined): void {
  trace.lastLifecycleType = type;
  if (type !== "node-waiting") trace.wait = undefined;
  if (type === "node-queued") trace.dispatchedAt = undefined;
  if (type === "node-dispatched" && at !== undefined) trace.dispatchedAt = at;
}

/**
 * The event's persisted instant. Absent, non-finite, and non-positive all read "no clock" -- `0` is 1970,
 * only ever a missed fill-in, never a real instant.
 */
function timeOf(stored: StoredEvent, now: number): number | undefined {
  const time = stored.timeCreated;
  if (typeof time !== "number" || !Number.isFinite(time) || time <= 0) return undefined;
  return Math.min(time, now);
}

/** The later of two absentable instants. */
export function laterOf(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.max(left, right);
}
