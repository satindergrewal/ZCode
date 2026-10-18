// ============================================================
// The two jobs of actor-session transcripts: boundary counting and seed-truncation copy (amend-resume)
// ============================================================
//
// They must share one module because they share a single **load-bearing** invariant:
//
//   boundary N => copying the source's first N messages yields exactly the transcript up to that ask.
//
// It holds for one reason only: counting and copying use the **same access face** ({@link ActorTranscriptStore.messages}),
// the very one core's `resumeFromStore` reads when rehydrating (core/src/runtime/methods/resume.ts).
// If even one of the three readers changed criteria (active-branch only, or per-part counts), the boundary
// becomes two different lengths and the copied transcript is off by one -- exactly how "the model's context" and
// "the journal's boundary" drift apart silently. Therefore: **change the counting criteria in all three places at once**.
//
// The key property of a count offset (vs an id range) is **invariance under prefix-copy**: after copying, ids change,
// counts do not, so the copied ask's boundary stays valid in the new session as-is -- the very foundation of chained
// revisions (B copies A, then C copies B).

import {
  createMessageId,
  createPartId,
  type Logger,
  type MessageId,
  type MessageInfo,
  type MessagePart,
  type MessageWithParts,
  type PartId,
  type SessionId,
} from "@zcode/contracts";
import { cloneMessageForFork, clonePartForFork } from "@zcode/core";
import { WorkflowError, type ActorSessionSeed } from "@zcode/dynamic-workflow";

/**
  * The session-transcript access face the driver needs: read a session's messages, write one message / one part.
 *
  * Structurally a proper subset of {@link import("@zcode/contracts").SessionStorePort}, so production passes the
  * session store directly. Narrowed for the same reason as the run service's journal / task-link ports: the driver
  * needs these three methods; declaring the whole store would make "driver depends on all of session storage" true.
 */
export interface ActorTranscriptStore {
  messages(input: { sessionID: SessionId }): Promise<MessageWithParts[]>;
  saveMessage(input: MessageInfo): Promise<void>;
  savePart(input: MessagePart): Promise<void>;
}

/**
  * A session's currently **persisted** message count (the ask-boundary accounting value).
 *
  * Persisted ones only: the driver asks at exchange end, and the runtime has already awaited message persistence
  * within the turn (core persistMessage / persistPart), so the persisted count is the exchange's full output.
 */
export async function countActorTranscript(
  store: ActorTranscriptStore,
  sessionId: SessionId,
): Promise<number> {
  return (await store.messages({ sessionID: sessionId })).length;
}

/**
  * Copies the source session's first `seed.messageCount` messages (with their parts) into the target.
 *
  * Three properties:
 *
  * 1. **Predecessors read-only**. Every copied message/part mints new ids -- `message.id` / `part.id` are store-wide keys,
  *    and saveMessage's upsert rewrites `session_id` on id conflict (adapters' messages.ts).
  *    Copying ids verbatim is not a copy, it is **moving** the predecessor's transcript. Re-issued ids require remapping `parentID`
  *    and in-part anchors -- exactly what core's fork cloners {@link cloneMessageForFork} /
  *    {@link clonePartForFork} already do right (fork and this are the same operation: copy a transcript span by value into another
  *    session, the child continuing on local ids), so reuse them instead of writing a second copy.
  * 2. **Idempotent, and never writes into a started session**. Two skip rules, both required:
 *
  *    - target already has >= messageCount messages => skip entirely: the resume-after-crashed-revision case -- the session id
  *      is purely derived from (runId, actorRef), so re-attach finds it already holding "copied + newly produced" content;
  *      copying again doubles the context.
  *    - any target message that is **not** this session's seed id (see {@link seededMessageId}) => skip too.
  *      A session holding only seed messages is a half-copied prefix -- complete it; a session holding anything else has its own
  *      history, untouchable.
 *
  *    The second rule guards **re-copy after the boundary grows**: `inFlight.messageBoundary` is
  *    the predecessor's current message count, the only number in the import cache that is not a journal fact (see
  *    dynamic-workflow-import.ts's header). When it grows between builds (the predecessor was resumed and wrote
  *    more rounds, or a late background notice landed), a revision run's plain "stop -> resume" calls here
  *    again with the larger M; if the target already has live messages but fewer than M, the old rule would re-copy
  *    0..M-1 -- 0..N-1 upsert seed ids (harmless) while N..M-1 are **new ids**, appending the predecessor's messages
  *    after this session's own history (`message.sequence` takes max+1 on insert, adapters']
  *    messages.ts) -- a read-out-of-order, foreign context, silently.
  *    "Act only when all ids are seed ids" kills this once at the **copy point**, and holds for any future non-journal fact --
  *    no need to prove each one cannot grow.
  * 3. **Missing sources fail loudly**. A missing source session (empty read) or one shorter than the boundary means the
  *    seed the service built from journal facts is not deliverable by this store -- corruption-grade, not degradable (the
  *    degradable half is gated service-side: candidates lacking chain sessions are discarded there).
 *
  * @returns the count actually copied; `undefined` = skipped (both rules map to this one return, because the caller
  *          treats them alike: no second hydration -- see workflow-driver-transcript.ts seedActorSession).
 */
export async function seedActorTranscript(input: {
  logger?: Logger;
  seed: ActorSessionSeed;
  store: ActorTranscriptStore;
  targetSessionId: SessionId;
}): Promise<number | undefined> {
  const { logger, seed, store, targetSessionId } = input;
  const existing = await store.messages({ sessionID: targetSessionId });
  if (existing.length >= seed.messageCount) return undefined;
  if (!holdsOnlySeedMessages(existing, targetSessionId)) {
        // Note: reaching here means the seed boundary grew; this is the only place that can see it.
    logger?.warn?.("Dynamic workflow actor session already has its own history; seeding skipped", {
      event: "dynamic_workflow.actor.seed_skipped_live_session",
      existingMessageCount: existing.length,
      messageCount: seed.messageCount,
      module: "bootstrap.app",
      sessionId: targetSessionId,
    });
    return undefined;
  }

  const source = await store.messages({ sessionID: seed.sourceSessionId as SessionId });
  if (source.length < seed.messageCount) {
    throw new WorkflowError(
      "DriverError",
      `Cannot seed the subagent transcript: source session ${seed.sourceSessionId} has only ` +
        `${source.length} messages, but the boundary requires the first ${seed.messageCount}.`,
      { mismatch: { expected: String(seed.messageCount), got: String(source.length) } },
    );
  }

    // old id -> new id: the assistant's parentID and in-part anchors remap through it. The prefix is contiguous,
    // so every earlier message a row references is already in the table (indices strictly increase).
  const messageIds = new Map<MessageId, MessageId>();
  for (let index = 0; index < seed.messageCount; index++) {
    const message = source[index]!;
    const nextMessageId = seededMessageId(targetSessionId, index);
    const cloned = cloneMessageForFork(message.info, {
      forkedSessionId: targetSessionId,
      messageIdMap: messageIds,
      nextMessageId,
    });
    messageIds.set(message.info.id, nextMessageId);
    await store.saveMessage(cloned);
    for (const [partIndex, part] of message.parts.entries()) {
      await store.savePart(
        clonePartForFork(part, {
          forkedSessionId: targetSessionId,
          messageIdMap: messageIds,
          nextMessageId,
          nextPartId: seededPartId(targetSessionId, index, partIndex),
        }),
      );
    }
  }
  return seed.messageCount;
}

/**
  * Whether the target holds **only** this session's seed copies (item i is exactly {@link seededMessageId}' i-th).
 *
  * The criterion is ids, not counts or times: seed ids are pure in (target session, index), so "was this message copied
  * by me" has an answer needing no clock and nothing beyond read order. Empty sessions count as true (nothing
  * copied yet, so copying is fine). `messages()` returns ascending `sequence` and seeds were written in index order, so index = position.
 */
function holdsOnlySeedMessages(
  existing: readonly MessageWithParts[],
  targetSessionId: SessionId,
): boolean {
  return existing.every(
    (message, index) => message.info.id === seededMessageId(targetSessionId, index),
  );
}

/**
  * A seed copy's id: pure in (target session, prefix index).
 *
  * What determinism buys is **repairability of half-copies**: a crash mid-copy is healed on re-attach by upserting existing rows under the same id,
  * instead of growing a duplicate alongside. The session id already contains runId and actorRef, so different targets' copies never collide.
 */
function seededMessageId(targetSessionId: SessionId, index: number): MessageId {
  return createMessageId(`${targetSessionId}-seed-${index}`);
}

function seededPartId(targetSessionId: SessionId, index: number, partIndex: number): PartId {
  return createPartId(`${targetSessionId}-seed-${index}-${partIndex}`);
}
