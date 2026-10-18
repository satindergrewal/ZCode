import type { SessionEvent } from "@zcode/contracts";
import type { TuiCopy } from "@zcode/i18n";
import React from "react";
import { applySessionEventToState } from "./app-events.js";
import { describeSessionEvent } from "./state.js";
import { isSubagentToolMirror } from "./app-subagent-events.js";

type SessionEventHandlers = Parameters<typeof applySessionEventToState>[1];

/**
 * Bounded memory of applied event ids.
 *
 * Why: the cross-turn subscription and per-turn `onEvent` deliver the same event **concurrently**. The mirror is
 * immune to duplicates (shared reducer returns null for the just-reduced event), but the transcript is not --
 * `assistant_message` and friends append unconditionally, so double delivery would paint the reply twice.
 *
 * Bounded is enough: both sinks fire back-to-back on the same emit, so duplicates are always adjacent; no need to
 * remember the whole session.
 */
const MAX_REMEMBERED_EVENT_IDS = 2_048;

/**
 * Let only **main-session** events into the transcript.
 *
 * Why filter: raw actor/sub-session events reach the **same external sink set of the parent runtime** via
 * `notifyExternalChildSessionEvent`, **keeping the child's own sessionId** (the protocol layer routes detached
 * live sessions to desktop by it). The TUI sink hangs off that set, and per-turn onEvent too, so unfiltered
 * actor streaming deltas, tool calls, submit_result, and turn_complete would all paint into the main transcript.
 *
 * dwf progress events are themselves **parent-session** events (`session.events.ts:134` "appended to parent"),
 * so the tool card and the settled completion turn are unaffected -- they remain the only two workflow surfaces in the TUI.
 *
 * When the main sessionId is unavailable, let events through: better a little extra rendering than a blank transcript
 * over one missing id.
 */
function isMainSessionEvent(event: SessionEvent, mainSessionId: string | undefined): boolean {
  // Tool mirrors deliberately carry the parent's sessionId. They are activity
  // metadata, not parent transcript/tool/usage facts.
  if (isSubagentToolMirror(event)) return false;
  if (!mainSessionId) return true;
  const eventSessionId = typeof event.sessionId === "string" ? event.sessionId : undefined;
  if (eventSessionId === undefined) return true;
  return eventSessionId === mainSessionId;
}

type SessionEventApplierInput = SessionEventHandlers & {
  subscribeSessionEvents?: (sink: (event: SessionEvent) => void) => () => void;
  observeSessionEvent?: (event: SessionEvent) => void;
  copy: TuiCopy;
  getMainSessionId?: () => string | undefined;
  setLastEvent: (event: string) => void;
};

/**
 * Full intake pipeline: session gate -> dedup -> apply to state.
 *
 * Exported as a pure function (caller owns the seen-set) instead of living only in the hook so the **effects** are
 * testable: regressions like "actor turn_complete must not fall into the transcript via the fallback append" can
 * only be proven at pipeline level, not at predicate level. Returns whether the event was actually applied.
 *
 * The gate runs before dedup: foreign events must not occupy dedup-window slots (the window is bounded; evicting
 * entries for actor events would let main-session duplicates through).
 */
function applyMainSessionEvent(
  event: SessionEvent,
  applied: Set<string>,
  input: SessionEventApplierInput,
): boolean {
  if (!isMainSessionEvent(event, input.getMainSessionId?.())) return false;
  if (!rememberSessionEvent(applied, event)) return false;
  input.setLastEvent(describeSessionEvent(event));
  applySessionEventToState(event, input, input.copy);
  return true;
}

export function useSessionEventApplier(
  input: SessionEventApplierInput,
): (event: SessionEvent) => void {
  const appliedEventIdsRef = React.useRef<Set<string>>(new Set());
  const applyEvent = React.useCallback(
    (event: SessionEvent) => {
      input.observeSessionEvent?.(event);
      applyMainSessionEvent(event, appliedEventIdsRef.current, input);
    },
    [input],
  );
  useSessionEventSubscription(input.subscribeSessionEvents, applyEvent);
  return applyEvent;
}

/** A stable subscription survives renders; both event sources share the applier. */
function useSessionEventSubscription(
  subscribe: ((sink: (event: SessionEvent) => void) => () => void) | undefined,
  applyEvent: (event: SessionEvent) => void,
): void {
  const latest = React.useRef(applyEvent);
  latest.current = applyEvent;
  React.useEffect(() => subscribe?.((event) => latest.current(event)), [subscribe]);
}

/**
 * Record this event; returning false means it was already applied (caller should skip it entirely).
 *
 * Events without an id always pass: better a duplicate render than silently dropping an event over a missing key.
 */
function rememberSessionEvent(applied: Set<string>, event: SessionEvent): boolean {
  const eventId = typeof event.id === "string" && event.id.length > 0 ? event.id : undefined;
  if (eventId === undefined) return true;
  if (applied.has(eventId)) return false;
  applied.add(eventId);
  if (applied.size > MAX_REMEMBERED_EVENT_IDS) {
    // Set keeps insertion order; oldest entries leave first.
    const excess = applied.size - MAX_REMEMBERED_EVENT_IDS;
    let removed = 0;
    for (const id of applied) {
      applied.delete(id);
      removed += 1;
      if (removed >= excess) break;
    }
  }
  return true;
}
