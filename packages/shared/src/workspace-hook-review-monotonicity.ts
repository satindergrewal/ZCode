/**
 * The single adjudicator of review monotonicity.
 *
 * Background: "reviewFlowId/generation are monotonic within one Runtime controller", if re-implemented in the
 * product projection (event replay), prompt-turn observer (live monitor), and renderer
 * review store (binding display), mechanically diverges on comments alone. This module collapses the verdict into a pure function;
 * application policy (drop/defer/accept-new) stays with each consumer. New mirror consumers must use it, never hand-roll compares.
 * consumers. New mirror consumers must use it, never hand-roll compares.
 */

/** The review triple identity: only these three fields; no other payload field participates. */
export interface WorkspaceHookReviewIdentity {
  reviewFlowId: string;
  generation: number;
  interactionId: string;
}

/**
 * - no_current: no authority yet, candidate takes over;
 * - same_flow_advance: same flow, higher generation, accept (supersede);
 * - same_flow_replay: same flow/generation/interactionId, idempotent replay, ignore;
 * - same_flow_conflict: same flow/generation, different interactionId, violates controller
 *   monotonicity, ignore;
 * - same_flow_stale: same flow, lower generation, late event, ignore;
 * - cross_flow: different flow (Runtime generation change), generations incomparable; the caller decides on its own
 *   epoch evidence (projection drop / prompt-turn defer / store accepts new authority).
 */
export type WorkspaceHookReviewMonotonicityVerdict =
  | "no_current"
  | "same_flow_advance"
  | "same_flow_replay"
  | "same_flow_conflict"
  | "same_flow_stale"
  | "cross_flow";

export function verdictWorkspaceHookReviewRequest(
  current: WorkspaceHookReviewIdentity | undefined,
  candidate: WorkspaceHookReviewIdentity,
): WorkspaceHookReviewMonotonicityVerdict {
  if (!current) return "no_current";
  if (candidate.reviewFlowId !== current.reviewFlowId) return "cross_flow";
  if (candidate.generation > current.generation) return "same_flow_advance";
  if (candidate.generation < current.generation) return "same_flow_stale";
  return candidate.interactionId === current.interactionId
    ? "same_flow_replay"
    : "same_flow_conflict";
}
