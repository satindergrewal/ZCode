// Delivery-profile filtering, pure.
// First stage of the channel flush pipeline: filter -> coalesce -> frame. Recovery replay runs the same
// function ("profile-filter, then coalesce"), guaranteeing deterministic redelivery on reconnect.
//
// Closeout invariant (golden-tested): an event filtered by a profile must eventually be closed out by an unfilterable one--
// after row.delta(inputText) is filtered, the row.upserted at input finalization must carry the full inputText,
// or replayable subscribers end missing data. Any reducer change breaking this hits
// the "both profiles' final states byte-identical" test.
import type { DeliveryProfile } from "./core.js";
import type { ConversationDelta } from "./delta.js";
import type { ConversationRow } from "./rows.js";

export function filterConversationRowsForProfile(
  rows: readonly ConversationRow[],
  _profile: DeliveryProfile,
): ConversationRow[] {
  // HookInvocationRow has converged to the desktop/mobile client-safe summary; no profile-specific full row today,
  // the pure-function boundary kept for future controlled rows.
  return [...rows];
}

/**
 * Filter a delta sequence by the profile's streamPaths switches.
 * row.delta filters by streaming capability; structurally complete rows keep the same product facts in both profiles.
 * Pure, inputs unmodified; output keeps authoritative log order.
 */
export function filterConversationDeltasForProfile(
  deltas: readonly ConversationDelta[],
  profile: DeliveryProfile,
): ConversationDelta[] {
  return deltas.filter((delta) => {
    if (delta.op === "row.delta") return profile.streamPaths[delta.path];
    return true;
  });
}
