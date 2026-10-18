// ============================================================
// The actor's `sessionId`: the conversation holding this subagent's transcript (a workflowRuns reduction rule)
// ============================================================
// Lives outside the reducer main file, same reason as workflow-runs-actor-status.ts (the max-lines gate),
// same discipline: pure, clockless, no IO.
//
// Why sessionId moves (docs/dynamic-workflow/presentation.md, Subagent transcripts):
// `actor-created` carries the run-service-minted session, but an amended run whose answer came entirely from an
// imported hit never built that session -- hits create no sessions; those exchanges live in the predecessor's.
// The transcript panel subscribes by `sessionId`; a nonexistent session leaves only error plus retry. So the field
// follows where the transcript is now, never the minted id.

import type { WorkflowRunActor } from "./workflow-runs.js";
import { boundedSessionId } from "./workflow-runs-entries.js";

interface ActorRef {
  siteId: string;
  ordinal: number;
}

/**
 * After a node event: the actor row of the named subagent (unchanged means the same reference).
 *
 * Only two ask events say where this subagent's transcript lives:
 *   - **cache-hit settlement**: a payload `sourceSessionId` = the answer read from the predecessor's session (import hit,
 *     or a replay of an imported row during amend-run resume); without it, the answer arose in this run -- the envelope's `actorSessionId`
 *     (this run's session) is it;
 *   - **dispatch**: the subagent runs live; this run's session exists by now -- imported prefixes already seeded.
 *
 * The last event wins. Asks settle in order and import divergence is monotonic: hits first, pointing at the
 * predecessor; from the first live dispatch the run's session holds everything, imported prefix included. Other events,
 * events without an actor ref (world-read), payloads with neither id readable, off-table subagents: untouched.
 */
export function actorsWithTranscriptSession(
  actors: WorkflowRunActor[],
  eventType: string,
  payload: Record<string, unknown>,
  actorRef: ActorRef | null,
  envelopeSessionId: string | undefined,
): WorkflowRunActor[] {
  if (actorRef === null) return actors;
  const sessionId =
    eventType === "node-settled" && payload.cached === true
      ? (boundedSessionId(payload.sourceSessionId) ?? boundedSessionId(envelopeSessionId))
      : eventType === "node-dispatched"
        ? boundedSessionId(envelopeSessionId)
        : undefined;
  if (sessionId === undefined) return actors;
  const index = actors.findIndex(
    (actor) => actor.siteId === actorRef.siteId && actor.ordinal === actorRef.ordinal,
  );
  // Unchanged rows keep their reference: key-level deltas test by reference first (workflow-runs-delta.ts).
  if (index < 0 || actors[index]!.sessionId === sessionId) return actors;
  const next = actors.slice();
  next[index] = { ...actors[index]!, sessionId };
  return next;
}
