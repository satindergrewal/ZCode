/**
 * The amend-resume import cache's CONSUMPTION state.
 *
 * The injected ImportedRunCache is caller-built read-only data - the run service derives it from
 * the predecessor journal, and crash-resume rebuilds the same table via the same pure function.
 * Consumption progress therefore cannot write back into that table; it must be engine state: this
 * module is that state, plus every verdict around it (hit / diverge / seed).
 *
 * Split from scheduler.ts/engine.ts for the usual reason: focus, readability, the per-file cap.
 */

import { canonicalJson } from "./hash.js";
import { personaIdentity } from "./persona.js";
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
 * Per-attached-candidate import state: consumption cursor + divergence flag.
 *
 * Divergence is monotonic: once true, never consult the cache again; the suffix is dropped for good.
 */
export class ImportedActorState {
  /** Consumed entries = next hittable actorSeq (also the transcript-truncate bound + 1). */
  private consumed = 0;
  private diverged = false;
  /**
   * The seq continuing a predecessor's in-flight ask (absent if none). At most one: continuing is
   * itself divergence, and divergence is monotonic - never a second.
   */
  private carriedSeq?: number;

  constructor(private readonly candidate: ImportedActorCandidate) {}

  /**
   * A fresh ask queries at seq: hit returns the entry (advancing the cursor); miss diverges, undefined.
   *
   * Both misses equal: hash mismatch (instructions changed) and seq beyond entries (the new script
   * added asks). Divergence cascades free and dynamically - an upstream ask going live changes
   * results, downstream interpolated hashes change, downstream diverges; no explicit propagation.
   *
   * Called only while the cache is OPEN (closed path: takeIfPure), so a miss may still continue.
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
   * Post-close query: only PURE entries (predecessor recorded worldToolCalls === 0) hit. A pure
   * ask depends on instruction + transcript prefix - both inside the hash chain - not the
   * workspace, so the closed gate cannot change its answer. Touched-external entries stay
   * unhittable at equal hash: their workspace view may be stale; the ask goes live, the actor
   * diverges (transcript forks; suffix entries dead). Entries without stats, or without the key,
   * count as touched (conservative).
   *
   * After close, no continuing of in-flight asks either: that half-transcript is predecessor
   * observations of the OLD workspace - same reasoning as tool-bearing entries.
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

  /**
   * Was this seq's answer read from the predecessor transcript? The holding session, else undefined.
   *
   * True iff not yet diverged and the cursor is past seq - monotonic divergence + ascending
   * admission makes that exactly consumed-by-import. Both paths ask right after their verdict: a
   * fresh ask after a take hit; an amended resume after reconcileRecorded (the settle-order gate
   * may defer events until later rows diverged - asking then mislabels an imported row as self-run).
   */
  sourceSessionAt(seq: number): string | undefined {
    return !this.diverged && seq < this.consumed
      ? this.candidate.transcriptSourceSessionId
      : undefined;
  }

  /** Did this seq continue a predecessor in-flight ask? (scheduler: worldToolCalls in stats or not) */
  carriedAt(seq: number): boolean {
    return this.carriedSeq === seq;
  }

  /**
   * Re-derive divergence from one RECORDED ask row (amended-run crash resume).
   *
   * Divergence is not persisted, and an amended resume rebuildS the import table wholesale. Without
   * re-deriving per row, an actor that diverged at seq k could have its seq k+n ask hash-match and
   * be WRONGLY imported - stuffing back history unrelated to this run's transcript. Comparing each
   * row's inputHash against the entries replays the original verdict exactly (admission is
   * seq-ascending; hold rules keep it so) - precise, not conservative. wasLive covers the one live
   * form hashes cannot see: tool-bearing asks after the gate closed (scheduler tryImportedSettle).
   *
   * queuedBeforeClose is half of the continue-verdict: continuing and the node-queued happen in the
   * same synchronous slice as admission, so gate-open-then == queued before the first
   * import-cache-closed (engine-world.ts recoverImportClosure). Must be exact - a wrong continue
   * has seedActorTranscript copy predecessor messages into an ALREADY forked session (the driver's
   * idempotence test only checks length).
   */
  reconcileRecorded(
    seq: number,
    recordedHash: string,
    wasLive: boolean,
    queuedBeforeClose: boolean,
  ): void {
    if (this.diverged) return;
    // After close, a tool-bearing actor's ask runs live even at equal hash - counting it consumed
    // by hash would take the seed boundary from predecessor entries, not this session's.
    // actual transcript there holds different messages. Live-or-not is event fact (node-queued),
    // not hash-derivable.
    if (wasLive) {
      this.diverge(seq, recordedHash, queuedBeforeClose);
      return;
    }
    const entry = this.candidate.entries[seq];
    if (entry === undefined || entry.inputHash !== recordedHash) {
      // A never-live row cannot be a continuation: continued asks were dispatched, hence have node-queued.
      this.diverged = true;
      return;
    }
    this.consumed = Math.max(this.consumed, seq + 1);
  }

  /**
   * The diverged actor's session seed: source session + message-copy count + inherited model pin.
   * The boundary takes the ledger values of the LAST CONSUMED entry: diverging at seq k means
   * 0..k-1 Q/A pairs settled via cache; the new session continues right after those k exchanges
   * (their repair/nudge turns included). Zero consumed => no seed: fresh session, fresh model
   * resolution, no pin - pins exist to not silently switch models mid-transcript; no continuation,
   * no use.
   *
   * EXCEPTION - continuation: the boundary takes inFlight.messageBoundary (the predecessor's whole
   * session), so even zero-consumed seeds - the amended-mid-first-fan-out shape.
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
   * Diverge, and verdict whether this miss continues a predecessor's in-flight ask.
   *
   * Four conditions, all required: not yet diverged (else the transcript already forked), seq just
   * after the prefix (the in-flight ask's slot), the whole prefix consumed, instruction hash equal
   * to the in-flight ask's. cacheOpen is the fifth: post-close, that half-transcript is old-world
   * observation, no better than a cached world read.
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
 * World-node import queue consumption: one cursor per content hash (nth occurrence to nth record).
 * As in ImportedActorState, the cursor is engine state; the injected queue stays read-only.
 */
export class ImportedWorldQueue {
  private readonly cursors = new Map<string, number>();

  constructor(private readonly world: ReadonlyMap<string, ImportedWorldEntry[]>) {}
  /** Next record for this content hash; exhausted/never-recorded undefined (caller goes live).
  /** Next record for this content hash; exhausted/never-recorded undefined (caller goes live). */
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
 * Match an import candidate for a fresh actor: by effective name, with the normalized persona
 * equal (canonicalJson: skips undefined members, sorts keys). Mismatch discards the WHOLE
 * candidate; the actor reruns fresh - under full-fidelity transcripts that is doubly right (an old
 * system prompt's transcript under a new persona is identity confusion, and fixing the persona IS
 * the intent to rerun). Anonymous actors never attach: names are the cache identity. Compared at
 * runtime, not by static script diff: name/persona are runtime values (agent() args may be
 * dynamic); static diffing is a second source of truth.
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
  if (canonicalJson(personaIdentity(spec)) !== canonicalJson(personaIdentity(candidate.persona))) {
    return undefined;
  }
  return new ImportedActorState(candidate);
}

/**
 * The REAL dwf_node row a cache hit lands (new siteId; copied result/stats/boundary).
 * The boundary must copy too, or THIS run could not later be amended - chained amendments rely
 * on the count offset's invariance under prefix-copy.

/**
 * The REAL dwf_node row a cache hit lands (new siteId; copied result/stats/boundary).
 * The boundary must copy too, or THIS run could not later be amended - chained amendments rely
 * on the count offset's invariance under prefix-copy.
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
