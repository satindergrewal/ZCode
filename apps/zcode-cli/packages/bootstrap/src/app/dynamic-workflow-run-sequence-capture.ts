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
  /** The stamp set when the same event was persisted (`StoredEvent.timeCreated`); with unequal references, no guess — return `undefined`. */
  timeCreatedOf: (event: RunEvent) => number | undefined;
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
    // The fill writes the valid script back to the run row (docs/execution-engine.md "Holes"); forwarded verbatim like every other write.
    updateRunScript: (runId, scriptText, scriptHash) =>
      journal.updateRunScript(runId, scriptText, scriptHash),
    putActor: (record) => journal.putActor(record),
    getActor: (runId, siteId, ordinal) => journal.getActor(runId, siteId, ordinal),
    // Read-face options must be forwarded verbatim (docs/execution-engine.md "Reading the journal"): TS allows an implementation's
    // params to be narrower than the signature, so `(runId) => journal.listNodes(runId, <fixed options>)` compiles fine while silently
    // replacing the caller's filter, degrading the engine's narrow read to a full-table scan.
    listActors: (runId, opts) => journal.listActors(runId, opts),
    putNode: (record) => journal.putNode(record),
    getNode: (runId, siteId, ordinal, opts) => journal.getNode(runId, siteId, ordinal, opts),
    listNodes: (runId, opts) => journal.listNodes(runId, opts),
    countNodes: (runId, kind) => journal.countNodes(runId, kind),
    sumResultBytes: (runId, kind) => journal.sumResultBytes(runId, kind),
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
    // Same fallback as sequenceOf: the in-memory journal deep-copies events at the store boundary (unequal references), and "just
    // appended = being emitted" is the engine record() contract, so stamp by the last append.
    timeCreatedOf: () => lastStored?.timeCreated,
  };
}
