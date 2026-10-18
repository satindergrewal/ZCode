// Reading birth facts into actor entries under the protocol caps.
// Pure; no clock reads, no I/O.
//
// Names and phase names are script-generated and may exceed protocol length limits. Renderers validate every frame strictly, so
// over-long values could reject deltas and recovery snapshots alike. The producer therefore clips to the schema caps; full values stay in the journal.

import { WORKFLOW_RUNS_LIMITS, type WorkflowRunActor } from "./workflow-runs.js";

/**
 * Mint one actor entry. Both call sites must be **verbatim identical**: `actor-created`, and the birth-facts-bearing
 * `node-dispatched` (workflow-runs-eviction.ts activation)--the same subagent growing two entry shapes by arrival path
 * means two records that never reconcile in cold replay.
 *
 * `status` lands as a placeholder: the immediately following `withDerivedWorkflowActorStatuses` recomputes it from node and run terminality.
 */
export function workflowActorEntry(
  ref: { siteId: string; ordinal: number },
  name: unknown,
  phaseName: string | undefined,
  sessionId: string | undefined,
): WorkflowRunActor {
  const bounded = boundedActorName(nonEmptyString(name));
  return {
    siteId: ref.siteId,
    ordinal: ref.ordinal,
    ...(bounded === undefined ? {} : { name: bounded }),
    ...(sessionId ? { sessionId } : {}),
    ...(phaseName === undefined ? {} : { phaseName }),
    status: "waiting",
  };
}

/** Wire cap of the subagent display name (the subscription failure in the header). */
export function boundedActorName(name: string | undefined): string | undefined {
  return name === undefined ? undefined : name.slice(0, WORKFLOW_RUNS_LIMITS.maxActorNameLength);
}

/**
 * Wire cap of the instance birth-phase name. Kin of {@link boundedActorName}, same rationale, but **hard truncation, no ellipsis**--
 * this field is a correlation key, not prose; the UI's `phaseNameMatches` re-attaches truncated names to display phases by prefix.
 * the UI's `phaseNameMatches` re-attaches truncated names to display phases by prefix.
 */
export function boundedPhaseName(name: string | undefined): string | undefined {
  return name === undefined ? undefined : name.slice(0, WORKFLOW_RUNS_LIMITS.maxPhaseNameLength);
}

/** Empty string counts as absent: on the wire there are only "key present" and "key absent". */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
