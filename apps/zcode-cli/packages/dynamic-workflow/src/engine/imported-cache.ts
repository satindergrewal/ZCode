/**
 * The **consumption state** of the amend-resume import cache.
 *
 * The injected ImportedRunCache is caller-built read-only data -- the run service derives it from the predecessor journal,
 * and a post-crash resume rebuilds the same table with the same pure function. So the consumption cursor cannot be written back in place;
 * it must be engine-owned state: this module, plus every judgment around it (hit / diverge / seed).
 *
 * Split from scheduler.ts and engine.ts for the reason scheduler left engine: focus, readability, and the per-file line cap.
 */

import { canonicalJson } from "./hash.js";
import type {
  ActorRef,
  ActorSessionSeed,
  ImportedActorCandidate,
  ImportedAskEntry,
  ImportedRunCache,
  ImportedWorldEntry,
  InstanceRef,
  NodeRecord,
  PersonaSpec,
} from "./types.js";

/**
 * Import-consumption state of an actor with an attached candidate: the cursor plus the diverged flag.
 *
 * **Divergence is monotonic**: once true, never consult the cache again; the suffix is discarded, not revived.
 */
export class ImportedActorState {
  /** Consumed entry count = the next hittable actorSeq (also the transcript-truncation boundary index + 1). */
  private consumed = 0;
  private diverged = false;
  /**
   * The seq of the resumed-in-flight-predecessor ask (absent when none). At most one: resuming is itself divergence,
   * divergence is monotonic, so there is no second.
   */
  private carriedSeq?: number;

  constructor(private readonly candidate: ImportedActorCandidate) {}

  /**
   * A fresh ask consults the cache by seq: a hit returns the entry (and advances the cursor), else flags divergence and returns undefined.
   *
   * Both misses equal: hash mismatch (the instruction changed) or seq past the entries (the new script added
   *   asks for this actor). Divergence **cascades for free**, dynamically -- an upstream ask turning live yields new results, the downstream
   * interpolated instruction hash changes, and the downstream diverges; no explicit propagation.
   *
   * Called only while the cache is **open** (after closing, takeIfPure), so a miss may still mean resume-the-in-flight.
   */
  take(seq: number, hash: string): ImportedAskEntry | undefined {
    if (this.diverged) return undefined;
    const entry = this.candidate.entries[seq];
    if (entry === undefined || entry.inputHash !== hash) {
      this.diverge(seq, hash, true);
      return undefined;
    }
    this.consumed = seq + 1;
    return entry;
  }

  /**
      * The post-close form: only **pure** entries (predecessor recorded zero world tool calls) still hit. A pure ask depends on
    *   instructions and the transcript prefix -- both inside the hash chain -- not the workspace, so closing does not affect its answer.
      * Entries that touched the world are withheld even at equal hash: the workspace they read may have been rewritten;
      * the ask goes live and the actor diverges (the transcript no longer matches the predecessor; suffix entries are not revived).
      * Entries without stats, or without this key in stats, count as touched (conservative).
      // After closing, no resuming of in-flight asks either: that half-transcript is the predecessor observing the **old** workspace,
   */
  takeIfPure(seq: number, hash: string): ImportedAskEntry | undefined {
    if (this.diverged) return undefined;
    const entry = this.candidate.entries[seq];
    if (entry === undefined || entry.inputHash !== hash || entry.stats?.worldToolCalls !== 0) {
      this.diverge(seq, hash, false);
      return undefined;
    }
    this.consumed = seq + 1;
    return entry;
  }

  /** Whether this seq resumed the predecessor in-flight ask (the scheduler uses it to decide recording worldToolCalls). */
  carriedAt(seq: number): boolean {
    return this.carriedSeq === seq;
  }

  /**
   * Re-derive divergence from one **recorded** ask (used when an amended run resumes after a crash).
   *
   *   Divergence is not persisted, and an amended resume rebuilds the cache wholesale. Without re-deriving the divergence point from journal rows,
   *   an actor that diverged at seq k in the original run could have a later fresh ask accidentally match an entry hash and be
   *   **wrongly imported** -- stuffing back history unrelated to this run actual transcript. Comparing each recorded inputHash
   *   against the entries rebuilds the original decision exactly (admission is seq-ascending; the hold rule ensures it),
   *   not a conservative approximation. wasLive covers the hash-invisible live case
   *   (a tool-bearing ask after the close; see the scheduler tryImportedSettle).
   *
   *   The queued-before-close flag is the resume half of the fact: the resume verdict and the ask node-queued land in the same
   *   synchronous slice at admission, so gate-open-then iff this node-queued precedes the first cache-closed event
   *   (recoverImportClosure in engine-world.ts). Precision matters -- a wrong resume would have seedActorTranscript
   *   copy predecessor messages into an **already diverged** session (the driver idempotence test only checks target length).
   */
  reconcileRecorded(
    seq: number,
    recordedHash: string,
    wasLive: boolean,
    queuedBeforeClose: boolean,
  ): void {
    if (this.diverged) return;
    // After the close, a tool-bearing actor ask is live-run even at an equal hash --
    // counting it consumed by hash would take the seed boundary from the predecessor entry, while this session
    // real transcript at that point is not those messages. Liveness is an event fact (node-queued),
    // not hash-derivable.
    if (wasLive) {
      this.diverge(seq, recordedHash, queuedBeforeClose);
      return;
    }
    const entry = this.candidate.entries[seq];
    if (entry === undefined || entry.inputHash !== recordedHash) {
      // A never-live row cannot be a resume (a resumed ask was dispatched, hence has node-queued).
      this.diverged = true;
      return;
    }
    this.consumed = Math.max(this.consumed, seq + 1);
  }

  /**
   * The diverged actor session seed: source session, copy count, inherited model pin.
   *
   * The boundary is the **last consumed** entry ledger value: diverging at seq k means 0..k-1 settled via the cache;
   * the new session continues right after those k complete exchanges (their repair / nudge turns included).
   * Zero consumed, no seed -- fresh session, fresh model resolution, no pin: the pin exists for no-silent-model-swap-under-continuation;
   * no continuation, no use.
   *
   * **Resuming is the exception**: the boundary becomes the in-flight messageBoundary (the predecessor whole session), so there is
   *   a seed even with zero consumed -- exactly the amended-mid-first-fan-out shape.
   */
  seed(): ActorSessionSeed | undefined {
    const inFlight = this.candidate.inFlight;
    if (this.carriedSeq !== undefined && inFlight !== undefined) {
      return this.seedAt(inFlight.messageBoundary);
    }
    if (this.consumed === 0) return undefined;
    const last = this.candidate.entries[this.consumed - 1];
    if (last === undefined) return undefined;
    return this.seedAt(last.messageBoundary);
  }

  /**
   * Flag divergence, and here also decide whether this miss is **resume-the-in-flight**.
   *
   * All four resume conditions must hold: not yet diverged (else this actor transcript is no longer the predecessor line), seq exactly
   *   after the prefix (the in-flight slot), the whole prefix consumed, and the instruction hash matching the in-flight ask. cacheOpen
   *   is the fifth: after closing, that half-transcript is only observation of the old workspace, no better than a cached world read.
   */
  private diverge(seq: number, hash: string, cacheOpen: boolean): void {
    const inFlight = this.candidate.inFlight;
    if (
      cacheOpen &&
      inFlight !== undefined &&
      seq === this.candidate.entries.length &&
      this.consumed === seq &&
      inFlight.inputHash === hash
    ) {
      this.carriedSeq = seq;
    }
    this.diverged = true;
  }

  private seedAt(messageCount: number): ActorSessionSeed {
    const seed: ActorSessionSeed = {
      sourceSessionId: this.candidate.transcriptSourceSessionId,
      messageCount,
    };
    if (this.candidate.resolvedModel !== undefined)
      seed.resolvedModel = this.candidate.resolvedModel;
    return seed;
  }
}

/**
 * World-node import-queue consumption: one cursor per content hash (nth occurrence vs nth record).
 * As with the actor state, the cursor is engine state; the injected queues stay read-only.
 */
export class ImportedWorldQueue {
  private readonly cursors = new Map<string, number>();

  constructor(private readonly world: ReadonlyMap<string, ImportedWorldEntry[]>) {}

  /** The next record for this content hash; undefined when exhausted or never recorded (caller goes live). */
  take(hash: string): ImportedWorldEntry | undefined {
    const queue = this.world.get(hash);
    if (queue === undefined) return undefined;
    const cursor = this.cursors.get(hash) ?? 0;
    const entry = queue[cursor];
    if (entry === undefined) return undefined;
    this.cursors.set(hash, cursor + 1);
    return entry;
  }
}

/**
 * Find the import candidate for a just-created actor: look up by **effective name**, accept only on a normalized-persona match.
 *
 * The persona compare uses canonicalJson -- it skips undefined members and sorts keys, exactly the wanted
 * normalization (a name-only object equals one with an extra undefined). A mismatch discards the **whole candidate**;
 * the actor runs fresh: under full-fidelity transcript that is doubly right -- an old-system-prompt transcript under a new persona is identity drift,
 * and I-fixed-my-persona intends a rerun anyway.
 *
 * Anonymous actors never attach: the name is the cache identity key; nameless, no coordinate to match (the cost was adjudicated).
 * Why compare at **runtime** instead of statically pairing the two scripts: name and persona are runtime values
 * (agent arguments may be dynamic expressions); a static compare is a second truth -- what this package avoids everywhere.
 */
export function matchImportedActor(
  cache: ImportedRunCache | undefined,
  spec: PersonaSpec,
): ImportedActorState | undefined {
  if (cache === undefined) return undefined;
  const name = spec.name;
  if (name === undefined || name === "") return undefined;
  const candidate = cache.actors.get(name);
  if (candidate === undefined) return undefined;
  if (canonicalJson(spec) !== canonicalJson(candidate.persona)) return undefined;
  return new ImportedActorState(candidate);
}

/**
 * The **real** dwf_node row a cached ask hit persists (new siteId, copied result / stats / boundary).
 *
 * The boundary must be copied too, or **this** run could no longer be amended -- chained amendments rely on count offsets
 * surviving prefix copies.
 */
export function importedAskRecord(
  runId: string,
  instance: InstanceRef,
  actor: ActorRef,
  seq: number,
  hash: string,
  entry: ImportedAskEntry,
): NodeRecord {
  const record: NodeRecord = {
    runId,
    siteId: instance.siteId,
    ordinal: instance.ordinal,
    kind: "ask",
    actorSiteId: actor.siteId,
    actorOrdinal: actor.ordinal,
    actorSeq: seq,
    inputHash: hash,
    status: "completed",
    result: entry.result,
    messageBoundary: entry.messageBoundary,
  };
  if (entry.stats !== undefined) record.stats = entry.stats;
  return record;
}
