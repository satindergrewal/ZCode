// ============================================================
// Reading birth facts: how script-authored strings land as an actor entry within the wire bounds
// ============================================================
// Split from workflow-runs-reducer.ts (the main file's max-lines gate), with -caps.ts / -eviction.ts /
// -started.ts: same precedent, same discipline -- pure, clockless, no IO.
//
// These bounds are **safety** bounds, not display budgets. Names and phase names are arbitrary script-author concatenations
// (`agent("reader-" + paths.join("+"))`, `phase("check " + file)`); the CLI does not validate outbound frames and
// renderers strictly validate every frame -- on 2026-09-04 one 131-char subagent name got every frame after that
// actor appeared (online / recovery / initial snapshot) rejected, the subscription permanently dead via
// `fault.subscription.recoveryFailed`. So producers trim to the schema bounds; the wire stays legal, full values live in the journal.

import { WORKFLOW_RUNS_LIMITS, type WorkflowRunActor } from "./workflow-runs.js";

/**
 * Mint one actor entry. Both callers must be **verbatim identical**: `actor-created`, and the birth-fact-bearing
 * `node-dispatched` (workflow-runs-eviction.ts activation) -- one subagent growing two entry shapes by arrival path
 * means two records that never reconcile in cold replay.
 *
 * `status` is a placeholder here: the following `withDerivedWorkflowActorStatuses` recomputes it from node and run terminal states.
 */
export function workflowActorEntry(
  ref: { siteId: string; ordinal: number },
  name: unknown,
  phaseName: string | undefined,
  sessionId: string | undefined,
  model: unknown,
): WorkflowRunActor {
  const bounded = boundedActorName(nonEmptyString(name));
  const canonical = boundedActorModel(nonEmptyString(model));
  return {
    siteId: ref.siteId,
    ordinal: ref.ordinal,
    ...(bounded === undefined ? {} : { name: bounded }),
    ...(sessionId ? { sessionId } : {}),
    ...(phaseName === undefined ? {} : { phaseName }),
    ...(canonical === undefined ? {} : { model: canonical }),
    status: "waiting",
  };
}

/**
 * Wire bound for the subagent model: over-bound **drops the whole value**, no truncation -- a truncated spec string is
 * another (nonexistent) model, and drawing it is a lie; absent just falls back to the run's own subagent model.
 */
function boundedActorModel(model: string | undefined): string | undefined {
  return model === undefined || model.length > WORKFLOW_RUNS_LIMITS.maxSubagentModelLength
    ? undefined
    : model;
}

/** Wire bound for the subagent display name (see the header's subscription incident). */
export function boundedActorName(name: string | undefined): string | undefined {
  return name === undefined ? undefined : name.slice(0, WORKFLOW_RUNS_LIMITS.maxActorNameLength);
}

/**
 * Wire bound for an instance's birth phase name (docs/dynamic-workflow/presentation.md). Same family and reason as
 * {@link boundedActorName}, but **truncated directly, no ellipsis** -- not display text, a join key:
 * the UI's `phaseNameMatches` re-associates truncated names onto display phases by prefix.
 */
export function boundedPhaseName(name: string | undefined): string | undefined {
  return name === undefined ? undefined : name.slice(0, WORKFLOW_RUNS_LIMITS.maxPhaseNameLength);
}

/**
 * Wire reading of a session id: in-bounds non-empty taken as-is, else absent. **Never truncated** -- as with the model
 * string, a cut id points at another session; better unrecognized.
 */
export function boundedSessionId(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  return text !== undefined && text.length <= WORKFLOW_RUNS_LIMITS.maxSessionIdLength
    ? text
    : undefined;
}

/** Empty string counts as absent: on the wire a key is present or absent, no third state. */
export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Isomorphic to the engine's `InstanceRef` / `ActorRef`: stop id x ordinal. Either missing => unlocatable, null. */
export function workflowInstanceRef(value: unknown): { siteId: string; ordinal: number } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const siteId = nonEmptyString(record.siteId);
  const ordinal = record.ordinal;
  if (siteId === undefined || typeof ordinal !== "number") return null;
  return { siteId, ordinal };
}
