/**
  * In-memory {@link JournalStorePort}: the phase-one stand-in for fake-driver tests and replay/resume.
  * Pure memory, synchronous; deep-copies in and out so caller-held references are never mutated by later writes (a simulated storage boundary).
  * The production implementation sits on the zcode session store's node:sqlite (DatabaseSync, synchronous), sharing JournalStorePort;
  * transactionality is not on the port face -- the driver composes journal+session writes.
 */

import type {
  ActorRecord,
  Caps,
  JournalStorePort,
  ListEventsOptions,
  NodeRecord,
  RunEvent,
  RunRecord,
  RunSettlementRecord,
  RunStatus,
  StoredEvent,
} from "./types.js";

/** Structured deep copy: isolates references across the storage boundary. Values are JSON-like pure data (or a PersonaSpec). */
function clone<T>(value: T): T {
  return structuredClone(value);
}

/** The composite key of actor / node rows. */
function key(siteId: string, ordinal: number): string {
  return `${siteId}@${ordinal}`;
}

export class InMemoryJournalStore implements JournalStorePort {
    // Bucketed by runId, matching the one-store-many-runs storage semantics.
  private readonly runs = new Map<string, RunRecord>();
  private readonly actors = new Map<string, Map<string, ActorRecord>>();
  private readonly nodes = new Map<string, Map<string, NodeRecord>>();
  private readonly events = new Map<string, StoredEvent[]>();

  createRun(record: RunRecord): void {
    if (this.runs.has(record.runId)) {
      throw new Error(`journal: run ${record.runId} already exists`);
    }
    this.runs.set(record.runId, clone(record));
    this.actors.set(record.runId, new Map());
    this.nodes.set(record.runId, new Map());
    this.events.set(record.runId, []);
  }

  getRun(runId: string): RunRecord | undefined {
    const r = this.runs.get(runId);
    return r === undefined ? undefined : clone(r);
  }

  updateRunStatus(runId: string, status: RunStatus, settlement?: RunSettlementRecord): void {
    const r = this.runs.get(runId);
    if (r === undefined) throw new Error(`journal: unknown run ${runId}`);
    r.status = status;
    if (status === "pending" || status === "running") {
            // Non-terminal = no settlement: when resume flips the run back to running, the previous epoch's residue must clear, else
            // the orphan-convergence failure_json would coexist with running (the journal snapshot read would report both
            // running and failed). A contradictory settlement bag (non-terminal yet carrying failure/result) clears likewise.
      delete r.failure;
      delete r.result;
      delete r.stopReason;
      delete r.supersededBy;
      return;
    }
        // The failure triple (failure / stopReason / supersededBy) is **rewritten whole**: the settlement bag is the entire truth of
        // this failure; absence means no failure. Under the old absent-means-untouched semantics, an externally written
        // failed+interrupted would survive a later completed settlement, the row claiming both completed
        // and interrupted (the SQLite side is the same coalesce; both implementations share semantics).
    if (settlement?.stopReason === undefined) delete r.stopReason;
    else r.stopReason = settlement.stopReason;
    if (settlement?.supersededBy === undefined) delete r.supersededBy;
    else r.supersededBy = settlement.supersededBy;
    if (settlement?.failure === undefined) delete r.failure;
    else r.failure = clone(settlement.failure);
        // Artifacts are the opposite: an absent key means untouched, so a re-settlement without artifacts never erases settled ones.
        // A null result is a legal artifact; only undefined counts as absent.
    if (settlement?.result !== undefined) r.result = clone(settlement.result);
  }

  updateRunUsage(runId: string, spentTokens: number): void {
    const r = this.runs.get(runId);
    if (r === undefined) throw new Error(`journal: unknown run ${runId}`);
    r.spentTokens = spentTokens;
  }

  updateRunCaps(runId: string, caps: Caps): void {
    const r = this.runs.get(runId);
    if (r === undefined) throw new Error(`journal: unknown run ${runId}`);
        // Deep-copied like every write (no shared references across the storage boundary): a caller's caps object replaced
        // later must not silently edit the persisted row.
    r.caps = clone(caps);
  }

  putActor(record: ActorRecord): void {
    const bucket = this.requireActorBucket(record.runId);
    bucket.set(key(record.siteId, record.ordinal), clone(record));
  }

  getActor(runId: string, siteId: string, ordinal: number): ActorRecord | undefined {
    const a = this.actors.get(runId)?.get(key(siteId, ordinal));
    return a === undefined ? undefined : clone(a);
  }

  listActors(runId: string): ActorRecord[] {
    const bucket = this.actors.get(runId);
    return bucket === undefined ? [] : [...bucket.values()].map(clone);
  }

  putNode(record: NodeRecord): void {
    const bucket = this.requireNodeBucket(record.runId);
    bucket.set(key(record.siteId, record.ordinal), clone(record));
  }

  getNode(runId: string, siteId: string, ordinal: number): NodeRecord | undefined {
    const n = this.nodes.get(runId)?.get(key(siteId, ordinal));
    return n === undefined ? undefined : clone(n);
  }

  listNodes(runId: string): NodeRecord[] {
    const bucket = this.nodes.get(runId);
    return bucket === undefined ? [] : [...bucket.values()].map(clone);
  }

  appendEvent(runId: string, event: RunEvent): StoredEvent {
        // Orphan events (run not yet created) break the contract like putActor/putNode: silently creating a bucket
        // writes events belonging to no run; SQLite has FKs, the memory side has this check.
    const list = this.events.get(runId);
    if (list === undefined) throw new Error(`journal: unknown run ${runId}`);
        // Appended-at matches SQLite's dwf_event time-created (one contract test for both): every how-long-ago
        // in the event log derives from it; a reader taking Date.now would label the whole cold-replayed history as just now.
    const stored: StoredEvent = {
      sequence: list.length,
      event: clone(event),
      timeCreated: Date.now(),
    };
    list.push(stored);
    return clone(stored);
  }

  listEvents(runId: string, opts?: ListEventsOptions): StoredEvent[] {
    const list = this.events.get(runId);
    if (list === undefined) return [];
        // sequence equals the array index here (appendEvent allocates list length), but compare by
        // sequence, not index offset: the cursor means strictly-greater-than that sequence, and SQLite uses
        // the same greater-than predicate. One contract test for both; semantics must be verbatim-equal.
    const after = opts?.afterSequence;
    const filtered = after === undefined ? list : list.filter((e) => e.sequence > after);
    const limited =
      opts?.limit === undefined ? filtered : filtered.slice(0, Math.max(0, opts.limit));
    return limited.map(clone);
  }

  private requireActorBucket(runId: string): Map<string, ActorRecord> {
    const bucket = this.actors.get(runId);
    if (bucket === undefined) throw new Error(`journal: unknown run ${runId}`);
    return bucket;
  }

  private requireNodeBucket(runId: string): Map<string, NodeRecord> {
    const bucket = this.nodes.get(runId);
    if (bucket === undefined) throw new Error(`journal: unknown run ${runId}`);
    return bucket;
  }
}
