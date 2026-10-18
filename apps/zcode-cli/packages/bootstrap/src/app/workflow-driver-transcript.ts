// ============================================================
// AgentRuntime-backed WorkflowDriver: transcript orchestration (amend-resume's two driver-private pieces)
// ============================================================
// workflow-driver.ts hit the oxlint max-lines cap (400), so the driver-side transcript orchestration --
// diverged-actor transcript seeding (seedActorSession), ask-boundary accounting (countSessionTranscript) and write-back
// (journalAskMessageBoundary) -- moves here as free functions; public surface unchanged. The mechanics live in
// workflow-actor-transcript.ts (copy and count); this is just the driver's three call sites and their failure trade-offs,
// method bodies verbatim, `this.deps` / `this.journal` becoming explicitly passed deps.

import type { SessionId } from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import {
  refToString,
  WorkflowError,
  type ActorSessionSeed,
  type InstanceRef,
} from "@zcode/dynamic-workflow";
import { countActorTranscript, seedActorTranscript } from "./workflow-actor-transcript.js";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

/**
  * Diverged-actor transcript seeding (amend-resume): copy the source session's first N messages into the fresh session, then let the runtime
  * open on that context.
 *
  * The order is load-bearing; none of the three steps may swap:
  *   1. factory returned => the session row is persisted (`message.session_id` has an FK to `session(id)`; copying first would fail);
  *   2. copy into the **persistent layer**, not in-memory history -- two readers depend on the persisted copy: this run's rehydration,
  *      and **future revisions of this run** (the chain walk reads this session as a transcript source);
  *   3. rehydrate via the existing `resumeFromStore` (the same machinery as resume re-attach); never a second hydration path.
  *      Session row and messages are freshly persisted, so skip launch's `SessionNotFound -> brand-new`
  *      degradation branch: its cause is "session cleaned up", which here only means wiring is wrong -- fail loudly.
 *
  * Step 3's **condition**: anything copied => hydrate; zero copied plus the journal already recording this session id
  * means the runtime factory just re-attached via the resume path (launch's attachActorSession); hydrating again
  * would only emit an extra SessionResumed and rerun SessionStart hooks. When neither holds (skipped copy
  * and no journal record = the previous generation crashed between copy and putActor), still hydrate, or the runtime opens
  * a message-filled session on an empty context.
 *
  * The condition holds for **both** of {@link seedActorTranscript}' skips, no need to distinguish which: both key on
  * "the target session already has its own content", and `attachActorSession`'s re-attach decision uses the same predicate
  * (whether the journal has this actor's sessionId), so the two sides always agree.
 */
export async function seedActorSession(
  deps: AgentRuntimeWorkflowDriverDeps,
  input: {
    journaledSessionId: string | undefined;
    runtime: AgentRuntime;
    seed: ActorSessionSeed;
    sessionId: SessionId;
  },
): Promise<void> {
  const { journaledSessionId, runtime, seed, sessionId } = input;
  const store = deps.actorTranscriptStore;
  if (store === undefined) {
    throw new WorkflowError(
      "DriverError",
      `Subagent session ${sessionId} carries a transcript seed, but the driver has no ` +
        `transcript store (wiring error).`,
    );
  }
  const copied = await seedActorTranscript({
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    seed,
    store,
    targetSessionId: sessionId,
  });
  if (copied === undefined && journaledSessionId !== undefined) return;
  await runtime.resumeFromStore();
}

/** Counts this session's persisted messages; on failure give up the accounting (an absent boundary, not a wrong one). */
export async function countSessionTranscript(
  deps: AgentRuntimeWorkflowDriverDeps,
  state: SessionState,
  instance: InstanceRef,
): Promise<number | undefined> {
  const store = deps.actorTranscriptStore;
  if (store === undefined) return undefined;
  try {
    return await countActorTranscript(store, state.sessionId);
  } catch (error) {
    deps.logger?.warn?.("Dynamic workflow ask message boundary count failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "dynamic_workflow.ask.message_boundary.count_failed",
      instance: refToString(instance),
      module: "bootstrap.app",
      sessionId: state.sessionId,
    });
    return undefined;
  }
}

/**
  * Writes the message-count boundary into this ask's journal row (`NodeRecord.messageBoundary`).
 *
  * Same family as the stats backfill: the engine's settled record lacks this field (a driver-owned fact), so the same
  * read-modify-write applies -- `getNode` the just-settled record, add the boundary, `putNode`, touching nothing else
  * (status / result / actorSeq / inputHash / stats). After settlement is mandatory: the engine's settle is whole-row replacement;
  * written earlier it would be erased.
 *
  * Written for every ask, named/anonymous, revision or not: **anonymity is decided only at import time**, and any run
  * is a potential predecessor of a future revision. Cost: one small write per ask.
 *
  * The two early returns each have a reason: a missing record (run already cleaned) has nowhere to be written; a changed `currentInstance`
  * means the next ask already started on this session, so the length counted now no longer belongs to this exchange -- prefer an absent boundary
  * (the ask cannot be imported) over an oversized value (the truncation would carry the next ask's opening).
 */
export function journalAskMessageBoundary(
  deps: AgentRuntimeWorkflowDriverDeps,
  state: SessionState,
  instance: InstanceRef,
  boundary: number,
): void {
  const key = refToString(instance);
  if (state.currentInstance !== undefined && refToString(state.currentInstance) !== key) return;
  const runId = deps.runId ?? "run";
  try {
    const recorded = deps.journal.getNode(runId, instance.siteId, instance.ordinal);
    if (recorded === undefined) return;
    deps.journal.putNode({ ...recorded, messageBoundary: boundary });
  } catch (error) {
        // An accounting-write failure must not kill an already-settled ask (and this runs on a floating promise; a throw
        // would only become an unhandled rejection). Same cost as a count failure: the ask cannot be imported, the run cannot be a predecessor.
    deps.logger?.warn?.("Dynamic workflow ask message boundary write failed", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "dynamic_workflow.ask.message_boundary.write_failed",
      instance: key,
      module: "bootstrap.app",
      runId,
    });
  }
}
