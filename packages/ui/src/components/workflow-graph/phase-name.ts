import { IMPLICIT_PHASE_ID, UNPHASED_PHASE_ID } from "./types.js";
import type { LaneNameFormatter } from "./lane-name.js";

/**
 * The single policy point for phase display names, isomorphic line-by-line with
 * lane-name.ts (one thing, one set of rules): author's own wording > localized fallback.
 *
 * The fallback must happen at render time: projections are memoized pure functions,
 * language-agnostic — baking copy in would go stale the moment the user switches
 * language mid-session. `unphased` is the only phase without a `name` — it is not an
 * author-written word but "the steps before the first stamp", so its name is always
 * localized.
 */

/** Everything needed to produce a phase display name — no identity beyond the id. */
export interface PhaseNaming {
  id: string;
  /** The name given by `phase("preflight")` in the script; `unphased` has none. */
  name?: string;
}

export function phaseDisplayName(phase: PhaseNaming, formatMessage: LaneNameFormatter): string {
  if (phase.name !== undefined) return phase.name;
  if (phase.id === UNPHASED_PHASE_ID) {
    return formatMessage({ id: "chat.toolCall.workflow.graph.phase.unphased" });
  }
  // The implicit single module of an unstamped script (participant-model.ts): the whole
  // script is one phase.
  if (phase.id === IMPLICIT_PHASE_ID) {
    return formatMessage({ id: "chat.toolCall.workflow.graph.phase.workflow" });
  }
  // Unreachable: every phase but `unphased` carries the author's wording. If it ever
  // happens, report the id (identity) rather than "ungrouped" — calling a named phase a
  // fallback is a lie; a bare id is at least diagnosable.
  return phase.id;
}

/**
 * Display phase names are truncated to this many characters by `boundGraphText`
 * (contracts' `CREATE_WORKFLOW_GRAPH_MAX_NAME_CHARS`); runtime names (entries, instance
 * birth stamps) carry the full name (the reducer truncates to the same bound).
 */
export const DISPLAY_PHASE_NAME_BOUND = 128;

/**
 * The only correlation rule between display and runtime phase names is exact match; the
 * prefix fallback applies only when the display name sits **exactly at the bound** — the
 * prefix path opens only when truncation really happened, otherwise "plan" would
 * mis-match "plan-repair". Shared by the timeline's entries, `currentPhase`, and
 * instance binding.
 *
 * Either side absent -> false: matching needs two names; "no name" is not a matchable
 * name. Pairing nameless display phases (`unphased` / implicit `workflow`) with
 * stamp-less instances is a separate rule handled explicitly by `phasesOf`.
 */
export function phaseNameMatches(
  displayName: string | undefined,
  runtimeName: string | undefined,
): boolean {
  if (displayName === undefined || runtimeName === undefined) return false;
  if (displayName === runtimeName) return true;
  return displayName.length >= DISPLAY_PHASE_NAME_BOUND && runtimeName.startsWith(displayName);
}
