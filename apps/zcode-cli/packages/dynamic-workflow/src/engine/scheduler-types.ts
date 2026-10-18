/**
  * scheduler.ts sat at oxlint's max-lines cap (400); the scheduler's internal types (Deferred /
  * AskNode / Actor) and the engine-injected dependency face SchedulerHost moved here; the public surface still exports from scheduler.ts
  * (SchedulerHost re-exported there in place; engine.ts's import path unchanged).
 *
  * Not merely line count: the free functions in scheduler-submit.ts also need AskNode / SchedulerHost;
  // importing from here spares both sides a reverse import of the scheduler itself.
 */

import { INSTRUCTIONS_HEAD_MAX_CHARS, refToString, WorkflowError } from "./types.js";
import type { ImportedActorState } from "./imported-cache.js";
import type {
  ActorId,
  ActorRef,
  AskSpec,
  AskStats,
  Caps,
  InstanceRef,
  PersonaSpec,
  RunEvent,
  SessionRef,
  ValidateFn,
  WorkflowDriver,
} from "./types.js";

/** A promise resolvable from outside. */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** The dependency face the engine injectes into the scheduler. */
export interface SchedulerHost {
  readonly runId: string;
  /**
      * This run's concurrency cap. **Read fresh before every dispatch**, not copied at construction: setMaxConcurrency replaces the engine's caps
      * wholesale
      * and the scheduler's admission test must see the new value; hence a getter on the engine side.
   */
  readonly caps: Caps;
  readonly driver: WorkflowDriver;
  readonly validate: ValidateFn;
    /** Assign the site's next execution ordinal (counter shared with world-read/actor). */
  nextOrdinal(siteId: string): number;
  /**
      * Release one cache hit under replay-settlement-order constraints.
      * Non-resume, or the instance absent from the order table: release immediately.
   */
  holdForReplay(instance: InstanceRef, release: () => void): void;
    /** Persist the event and fan it out (Boundary C). */
  record(event: RunEvent): void;
  isRunSettled(): boolean;
    /** The error to reject with once the run has settled. */
  runError(): WorkflowError;
    /** Run-level failure. */
  failRun(error: WorkflowError): void;
  /**
      * Whether the import cache has closed (amend-resume). The engine closes it itself
      * (driver-reported askMutating, or a live world-run); the scheduler only reads the bit -- an ask turning live
      * does **not** close it: it has changed nothing yet.
   */
  importCacheClosed(): boolean;
    /** Whether this row ran live before the crash (engine restores from events on resume; always false otherwise). */
  wasLiveBeforeResume(instance: InstanceRef): boolean;
  /**
      * Whether this row's admission preceded the import-cache closing (restored in event order; see
      * recoverImportClosure in engine-world.ts). Needed to restore exactly which predecessor asks were in flight on resume; always false otherwise.
   */
  wasQueuedBeforeImportClose(instance: InstanceRef): boolean;
}

/** A live (to-be-dispatched) ask node. */
export interface AskNode {
  instance: InstanceRef;
  actor: Actor;
  actorSeq: number;
  instructions: string;
  hash: string;
  spec: AskSpec;
  deferred: Deferred<unknown>;
  repairsRemaining: number;
  nudgesRemaining: number;
  settled: boolean;
  dispatched: boolean;
  lastStats?: AskStats;
  /**
      * Instruction head computed at admission (the first chars of {@link AskNode.instructions}). Stored on the node rather than
      * computed twice: node-queued and node-dispatched must carry the **same** string (dispatch repeats birth facts,
      * see types.ts's node-dispatched); storing makes that true by construction, not by two sites staying in sync.
   */
  instructionsHead?: string;
}

/** Actor runtime state held by the scheduler. */
export interface Actor {
  ref: ActorRef;
  id: ActorId;
  persona: PersonaSpec;
  name?: string;
    /** Ask nodes already recorded for this actor -- on replay, live nodes wait until all are admitted. */
  recordedCount: number;
    /** The next actorSeq to admit. */
  nextAdmitSeq: number;
    /** Arrived record-node releases parked by actorSeq (the hold rule). */
  pendingRecorded: Map<number, () => void>;
    /** Arrived live-node releases waiting for record nodes to drain, in arrival order. */
  pendingLive: Array<() => void>;
    /** Admitted, not-yet-dispatched live nodes (FIFO = admission order). */
  liveQueue: AskNode[];
    /** The executing live node (actors are serial; at most one). */
  current?: AskNode;
    /** Lazily created session, promise cached (once per actor). */
  sessionPromise?: Promise<SessionRef>;
  session?: SessionRef;
  /**
      * This amend-resume's import-consumption state (attached in createActor after the name+persona match; see
      * matchImportedActor in imported-cache.ts). Absent: the actor runs fresh.
   */
  imported?: ImportedActorState;
}

// Expanded under current formatting this would pass the scheduler's 400-line cap; the pure helpers live here beside defer, behavior unchanged.
/** Replay hit with a mismatching inputHash -- the purity contract broke; the run fails loudly. */
export function hashMismatch(instance: InstanceRef, expected: string, got: string): WorkflowError {
  return new WorkflowError(
    "InputHashMismatch",
    `Replay hit at ${refToString(instance)} but inputHash differs (expected ${expected}, got ` +
      `${got}): the script is not deterministic, so the journal cannot be replayed.`,
        // Structured mismatch, aligned with ScriptHashMismatch: both hash-mismatch errors share the field,
        // so readers never re-parse the hash from message text.
    { mismatch: { expected, got } },
  );
}

/** cause -> one bounded line (an Error's message, else String(); a placeholder when empty). */
export function describeCause(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  const trimmed = text.trim();
  if (trimmed.length === 0) return "unknown error";
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

/**
  * The head of the author's instructions ({@link INSTRUCTIONS_HEAD_MAX_CHARS} chars, trimmed, **no ellipsis**).
  * Empty instructions return undefined: an absent key is more honest than an empty string -- readers fall back to unknown-briefing.
 */
export function headOfInstructions(instructions: string): string | undefined {
  const trimmed = instructions.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= INSTRUCTIONS_HEAD_MAX_CHARS
    ? trimmed
    : trimmed.slice(0, INSTRUCTIONS_HEAD_MAX_CHARS);
}

/** Drain the actor's queue in admission order; dispatch remains the scheduler's alone. */
export function drainActorAdmission(actor: Actor): void {
  let progressed = true;
  while (progressed) {
    progressed = false;
    const release = actor.pendingRecorded.get(actor.nextAdmitSeq);
    if (release !== undefined) {
      actor.pendingRecorded.delete(actor.nextAdmitSeq);
      actor.nextAdmitSeq++;
      release();
      progressed = true;
      continue;
    }
    if (actor.nextAdmitSeq >= actor.recordedCount && actor.pendingLive.length > 0) {
      const admit = actor.pendingLive.shift()!;
      admit();
      progressed = true;
    }
  }
}
