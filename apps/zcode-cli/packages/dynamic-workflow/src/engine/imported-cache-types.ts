// ============================================================
// The amend-resume import cache.
// ============================================================
// Split from engine/types.ts (at oxlint's max-lines cap): pure data; the run service builds it from the predecessor
// journal; the engine only looks it up.

import type { AskStats, NodeKind, PersonaSpec } from "./types.js";

/**
  * One importable finished ask: the result of the named actor nth Q&A in the predecessor run.
  * The array index is the actorSeq (see ImportedActorCandidate.entries), so no seq is stored here.
 */
export interface ImportedAskEntry {
    /** The predecessor-recorded inputHash (over the instruction body). Compared per record at runtime; a match hits. */
  inputHash: string;
  result: unknown;
  stats?: AskStats;
  /**
      * Message count of the source session after this ask settled (NodeRecord.messageBoundary). **Required**:
      * the run service no-marker-predecessors-rejected gate guarantees every importable entry carries a boundary, so the
      * engine needs no absent branch -- a seed truncation without a boundary is meaningless.
   */
  messageBoundary: number;
}

/**
  * The ask still in flight when the predecessor stopped (actorSeq equals the entries length; the running row right after the prefix).
 *
  * It has no result to import; what imports is **the transcript it already produced**: if the amendment re-issues the same instruction
  * at the same spot (matching inputHash), the new session continues from there instead of discarding the half-done exchange.
 */
export interface ImportedInFlightAsk {
    /** The predecessor-recorded inputHash (over the instruction body). Continuation presupposes a match with this ask hash. */
  inputHash: string;
  /**
      * Message count of the predecessor entire settled session (not one ask ledger boundary -- an unfinished ask has no boundary to record).
      * It includes the prefix completed exchanges plus this half-done one: exactly where the resume continues.
   */
  messageBoundary: number;
}

/**
  * The importable prefix of one named actor in the predecessor run. Built by the run service from the predecessor journal (pure, deterministic, rebuildable).
 */
export interface ImportedActorCandidate {
    /** The predecessor-recorded normalized persona -- compared at createActor time (a mismatch discards the candidate). */
  persona: PersonaSpec;
  /**
      * The longest all-completed ask prefix, indexed by actorSeq 0..n-1. **May be empty**: a candidate with an in-flight entry
      * often finished none (amended during the fan-out first round -- exactly this shape).
   */
  entries: ImportedAskEntry[];
  /**
      * The ask in flight at predecessor stop, if any. Imported only when the transcript source is the predecessor own row -- that half-exchange
      * exists only in the predecessor session; sources resolved from earlier ancestors carry complete prefixes only.
   */
  inFlight?: ImportedInFlightAsk;
  /**
      * The transcript source session id resolved along the resumed-from chain. The service guarantees presence -- a chain with no ancestor
      * holding this actor session is discarded service-side already (downgraded to a fresh actor), so not optional here.
   */
  transcriptSourceSessionId: string;
  /**
      * The model pin resolved by the predecessor, handed to the driver with the seed. **Effective only when a transcript is actually imported**: an
      * actor with zero hits resolves fresh, without the pin (see the scheduler ensureSession).
   */
  resolvedModel?: string;
}

/** One importable world node (world-read / world-run), matched by content + occurrence order. */
export interface ImportedWorldEntry {
  inputHash: string;
  kind: NodeKind;
  result: unknown;
}

/**
  * The import cache injected into the engine (the amend-resume accelerator). **Pure data**: the engine stays IO-free; the
  * run service builds the table from the predecessor journal.
  * Not a source of truth -- every hit persists a real dwf_node row; lost, it rebuilds from the resumed-from link.
 */
export interface ImportedRunCache {
    /** Key = the effective actor name (unique and non-empty within the predecessor). */
  actors: ReadonlyMap<string, ImportedActorCandidate>;
  /**
      * Key = inputHash of op+args; value = a queue in predecessor listNodes insertion order -- the nth occurrence of the same
      * op+args pairs with the nth record; the queue head is the next hit.
   */
  world: ReadonlyMap<string, ImportedWorldEntry[]>;
}

/**
  * The session seed: handed to WorkflowDriver.createActorSession at a diverged actor first live dispatch,
  * so the new session opens on the source session full-fidelity transcript prefix.
 */
export interface ActorSessionSeed {
    /** The transcript source session (this named actor session in the predecessor or an earlier ancestor). */
  sourceSessionId: string;
  /**
      * How many messages of the source session to copy = the last consumed ask messageBoundary.
      * Count offsets survive prefix copies, so this value applies directly at any session-holding ancestor along the chain.
   */
  messageCount: number;
    /** The inherited model pin (a silent model swap under transcript continuation is exactly the identity drift pins prevent). */
  resolvedModel?: string;
}
