// Journal-sequence capture layer for engine events. A separate module rather than part of launch.ts: that file's job is "assemble and start a run", this one is
// "hand the sequence allocated by appendEvent to the emit immediately after" -- two complete concerns, and this one has a single consumer.
import type { JournalStorePort, RunEvent, StoredEvent } from "@zcode/dynamic-workflow";

/**
 * Wraps the journal for one reason: capture the sequence allocated by `appendEvent` for the emit immediately after.
 *
 * Invariant (guaranteed by the engine's `record()` and pinned by tests): every event is "appendEvent then synchronously
 * emit", one-to-one. So the last append's sequence is the sequence of the event currently being emitted.
 * As a safeguard, verify by object **reference equality**: a mismatch means the invariant broke; fall back to the last sequence instead of
 * guessing -- a silently wrong number is harder to debug than standing still, and tests catch it before production does.
 */
export function createJournalSequenceCapture(journal: JournalStorePort): {
  journal: JournalStorePort;
  sequenceOf: (event: RunEvent) => number;
} {
  let lastStored: StoredEvent | undefined;
  // Explicit per-method forwarding instead of `{...journal, appendEvent}`: both are class instances, and spreading copies only own properties,
  // dropping prototype methods (the engine's next getRun would TypeError). The forwarded surface is the engine port only:
  // orphan convergence and the narrow enum query deliberately stay out -- they happen service-side against deps.journal, not through this layer.
  const wrapped: JournalStorePort = {
    createRun: (record) => journal.createRun(record),
    getRun: (runId) => journal.getRun(runId),
    updateRunStatus: (runId, status, settlement) =>
      journal.updateRunStatus(runId, status, settlement),
    updateRunUsage: (runId, spentTokens) => journal.updateRunUsage(runId, spentTokens),
    updateRunCaps: (runId, caps) => journal.updateRunCaps(runId, caps),
    putActor: (record) => journal.putActor(record),
    getActor: (runId, siteId, ordinal) => journal.getActor(runId, siteId, ordinal),
    listActors: (runId) => journal.listActors(runId),
    putNode: (record) => journal.putNode(record),
    getNode: (runId, siteId, ordinal) => journal.getNode(runId, siteId, ordinal),
    listNodes: (runId) => journal.listNodes(runId),
    appendEvent: (runId, event) => {
      const stored = journal.appendEvent(runId, event);
      lastStored = stored;
      return stored;
    },
    listEvents: (runId, opts) => journal.listEvents(runId, opts),
  };
  return {
    journal: wrapped,
    sequenceOf: (event) =>
      lastStored?.event === event ? lastStored.sequence : (lastStored?.sequence ?? 0),
  };
}
