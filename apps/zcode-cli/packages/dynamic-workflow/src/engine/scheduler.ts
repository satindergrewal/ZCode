/**
 * The ask scheduler: per-actor FIFO + the hold rule + capped dispatch + ask settlement, split from the engine body
 * so both files stay focused (and under the per-file line cap). The engine injects dependencies via SchedulerHost
 * (driver, caps, ordinals, run-level failure); the scheduler owns ask lifetimes, never run lifetimes.
 *
 * Key rules documented atop engine.ts: hit short-circuit, actorSeq admission order, the replay hold rule, serial actors.
 *
 * Internal types and SchedulerHost live in scheduler-types.ts; submit/turn upward reports in scheduler-submit.ts
 * (the 400-line cap). SchedulerHost re-exports here in place; import paths unchanged.
 */

import { inputHash } from "./hash.js";
import { importedAskRecord, type ImportedActorState } from "./imported-cache.js";
import {
  defer,
  drainActorAdmission,
  hashMismatch,
  describeCause,
  headOfInstructions,
  type Actor,
  type AskNode,
  type Deferred,
  type SchedulerHost,
} from "./scheduler-types.js";
import { handleSubmitAttempted, handleTurnEnded, type SubmitSeam } from "./scheduler-submit.js";
import type {
  ActorId,
  ActorRef,
  AskMessage,
  AskSpec,
  AskStats,
  InstanceRef,
  JournalStorePort,
  NodeRecord,
  PersonaSpec,
  SessionRef,
} from "./types.js";
import { NUDGE_ATTEMPTS, refToString, REPAIR_ATTEMPTS, WorkflowError } from "./types.js";

export { hashMismatch } from "./scheduler-types.js";
export type { SchedulerHost } from "./scheduler-types.js";

export class AskScheduler {
  private readonly actors = new Map<ActorId, Actor>();
  private readonly actorOrder: Actor[] = [];
  private readonly liveNodes = new Map<string, AskNode>();
  /**
   * Ask instances whose transcript predates their dispatch: resumed in-flight asks, and
   * re-dispatches from running rows. Their journaled stats drop the world tool count; see journaledStats.
   * Not cleared at settlement -- late stats backfill still consults it.
   */
  private readonly priorTranscriptAsks = new Set<string>();
  private activeAsks = 0;

  /** The seam scheduler-submit free functions use to find live nodes and settle by result (see SubmitSeam). */
  private readonly submitSeam: SubmitSeam;

  constructor(private readonly host: SchedulerHost) {
    this.submitSeam = {
      host,
      liveNode: (instance) => this.liveNodes.get(refToString(instance)),
      settleOk: (node, artifact) => this.settleOk(node, artifact),
      settleFailed: (node, error) => this.settleFailed(node, error),
    };
  }

  private get journal(): JournalStorePort {
    return this.host.driver.journal;
  }

  hasActor(id: ActorId): boolean {
    return this.actors.has(id);
  }

  /**
   * Register an actor (creation site x ordinal). The imported candidate is amend-resume: the engine already
   * matched effective name + normalized persona in createActor; the scheduler only consumes it.
   */
  registerActor(
    ref: ActorRef,
    id: ActorId,
    name: string | undefined,
    persona: PersonaSpec,
    imported?: ImportedActorState,
  ): Actor {
    const recordedCount = this.journal
      .listNodes(this.host.runId)
      .filter(
        (n) => n.kind === "ask" && n.actorSiteId === ref.siteId && n.actorOrdinal === ref.ordinal,
      ).length;
    const actor: Actor = {
      ref,
      id,
      persona,
      name,
      recordedCount,
      nextAdmitSeq: 0,
      pendingRecorded: new Map(),
      pendingLive: [],
      liveQueue: [],
      ...(imported === undefined ? {} : { imported }),
    };
    // Do not pre-resolve the journal session id into the actor session/promise to
    // let post-resume ensureSession skip the driver create call. The production session table
    // fills only inside createActorSession, and startAsk consults it -- so every resume
    // re-dispatch would fail as unknown-session. Pure replay (zero dispatches) and fake drivers
    // (startAsk not consulting the table) never expose it. Session identity is driver-owned (minted purely from run+actor,
    // the same id on reattach); the journal session column is a record, not authority -- never
    // short-circuit sessions from the journal; the first dispatch always creates via the driver (see ensureSession).
    this.actors.set(id, actor);
    this.actorOrder.push(actor);
    return actor;
  }

  /** Admit one ask: finished hits short-circuit (hold rule); running hits or misses go live. */
  admitAsk(
    siteId: string,
    actorId: ActorId,
    instructions: string,
    spec: AskSpec,
  ): Promise<unknown> {
    const actor = this.actors.get(actorId)!;
    const ordinal = this.host.nextOrdinal(siteId);
    const instance: InstanceRef = { siteId, ordinal };
    const hash = inputHash(instructions);
    const deferred = defer<unknown>();

    const recorded = this.journal.getNode(this.host.runId, siteId, ordinal);
    if (recorded !== undefined) {
      // A hit defensively re-validates the inputHash -- a mismatch means the purity contract broke; the run fails loudly.
      if (recorded.inputHash !== hash) {
        const err = hashMismatch(instance, recorded.inputHash, hash);
        this.host.failRun(err);
        return Promise.reject(err);
      }
      const seq = recorded.actorSeq ?? 0;
      const reconcile = (): void =>
        actor.imported?.reconcileRecorded(
          seq,
          recorded.inputHash,
          this.host.wasLiveBeforeResume(instance),
          this.host.wasQueuedBeforeImportClose(instance),
        );
      if (recorded.status === "running") {
        // Crashed mid-execution: re-live at the recorded actorSeq position (the hold rule preserves admission order).
        // Its transcript already holds the earlier rounds messages, so stats count as transcript-predating.
        actor.pendingRecorded.set(seq, () => {
          reconcile();
          this.admitLive(instance, actor, seq, instructions, hash, spec, deferred, true);
        });
      } else {
        // completed / failed: short-circuit settlement, no driver call.
        actor.pendingRecorded.set(seq, () => {
          reconcile();
          this.releaseCachedAsk(instance, recorded, deferred);
        });
      }
      this.drainAdmission(actor);
      return deferred.promise;
    }

    // Miss (fresh): register pendingLive; admitted in arrival order once record nodes drain, with a new actorSeq.
    // After the seq, ask the import cache (amend-resume): a hit settles cached, never live.
    actor.pendingLive.push(() => {
      const seq = actor.nextAdmitSeq++;
      if (this.tryImportedSettle(instance, actor, seq, hash, deferred)) return;
      // Only after a miss is resume-the-in-flight decided -- inside take, together with divergence.
      const carried = actor.imported?.carriedAt(seq) === true;
      this.admitLive(instance, actor, seq, instructions, hash, spec, deferred, carried);
    });
    this.drainAdmission(actor);
    this.pumpAll();
    return deferred.promise;
  }

  /**
   * Admit an ask as a live node: build it, persist running at admission, enqueue, emit.
   *
   * priorTranscript marks not-starting-from-empty (a resumed in-flight ask, or a re-dispatch from a running
   * row) -- it only shapes how stats persist; see journaledStats.
   */
  private admitLive(
    instance: InstanceRef,
    actor: Actor,
    seq: number,
    instructions: string,
    hash: string,
    spec: AskSpec,
    deferred: Deferred<unknown>,
    priorTranscript = false,
  ): void {
    if (priorTranscript) this.priorTranscriptAsks.add(refToString(instance));
    // The instruction head lands with the birth event: instructions here are still
    // the author verbatim -- driver quality/schema footnotes append in startAsk, so the digest stays engine-free.
    // Computed once onto the node: dispatch repeats birth facts; both events must carry the same string.
    const instructionsHead = headOfInstructions(instructions);
    const node: AskNode = {
      instance,
      actor,
      actorSeq: seq,
      instructions,
      hash,
      spec,
      deferred,
      repairsRemaining: REPAIR_ATTEMPTS,
      nudgesRemaining: NUDGE_ATTEMPTS,
      settled: false,
      dispatched: false,
      ...(instructionsHead === undefined ? {} : { instructionsHead }),
    };
    this.liveNodes.set(refToString(instance), node);
    // Admission persists running (with actorSeq + inputHash): a node crashed mid-execution re-dispatches from it.
    this.journal.putNode({
      runId: this.host.runId,
      siteId: instance.siteId,
      ordinal: instance.ordinal,
      kind: "ask",
      actorSiteId: actor.ref.siteId,
      actorOrdinal: actor.ref.ordinal,
      actorSeq: seq,
      inputHash: hash,
      status: "running",
    });
    actor.liveQueue.push(node);
    this.host.record({
      type: "node-queued",
      instance,
      kind: "ask",
      actor: actor.ref,
      actorSeq: seq,
      ...(instructionsHead === undefined ? {} : { instructionsHead }),
    });
    // Turning live does **not** close the import cache. It once did: any live ask
    // meant the workspace might be rewritten -- a clock in place of dependency: every sibling after the first miss in one
    // Promise.all was invalidated with no dependency between them (a 50-way fan-out lost 6 hits, a 5-way its only one).
    // Now the **first write** closes: the driver reports a mutating tool about to run, or a world.run goes live; until then
    // the world equals what the predecessor left, and cache hits hold.
  }

  /**
   * Ask the import cache once at fresh-ask admission (amend-resume). A hit means cached settle, returning true
   * (the caller does not go live); the verdict and divergence bookkeeping live in ImportedActorState.
   *
   * A hit writes one **real** node row and emits only the cached settled event -- the same posture as the replay-hit
   * release: no queued/dispatched events, no live queue, no session, no current slot.
   */
  private tryImportedSettle(
    instance: InstanceRef,
    actor: Actor,
    seq: number,
    hash: string,
    deferred: Deferred<unknown>,
  ): boolean {
    // Cache closed => only **pure** asks pass (predecessor recorded zero tool calls): they depend on instructions and the
    // transcript prefix, not the workspace, so an old-world answer holds for the new; tool-bearing entries go live even at equal hash --
    // the workspace they read may have been rewritten. The going-live ask diverges the actor (transcripts drift); the consumed prefix
    // stays the seed-boundary basis.
    const entry = this.host.importCacheClosed()
      ? actor.imported?.takeIfPure(seq, hash)
      : actor.imported?.take(seq, hash);
    if (entry === undefined) return false;
    this.journal.putNode(importedAskRecord(this.host.runId, instance, actor.ref, seq, hash, entry));
    this.host.record({ type: "node-settled", instance, outcome: "ok", cached: true });
    deferred.resolve(entry.result);
    return true;
  }

  // ----------------------------- upward reports -----------------------------

  /** submit_result arrival: the body lives in scheduler-submit handleSubmitAttempted. */
  submitAttempted(instance: InstanceRef, payload: unknown): void {
    handleSubmitAttempted(this.submitSeam, instance, payload);
  }

  /** Turn end without submit: the body lives in scheduler-submit handleTurnEnded. */
  turnEnded(instance: InstanceRef, finalText: string): void {
    handleTurnEnded(this.submitSeam, instance, finalText);
  }

  noteStats(instance: InstanceRef, stats: AskStats): void {
    const node = this.liveNodes.get(refToString(instance));
    if (node !== undefined) {
      node.lastStats = stats;
      return;
    }
    // The node left liveNodes -- the typed-accept-dominated path: submit ends the turn and persists at settle, while the real
    // actor usage is known only after turn resolution (after submit), so stats arrive post-settlement. Backfill the settled
    // journal row: stats only, preserving status/result/actorSeq/inputHash/error/kind/actor identity.
    // Best effort and idempotent; budget decrement stays in the engine askStats (here, journal completeness only).
    const recorded = this.journal.getNode(this.host.runId, instance.siteId, instance.ordinal);
    if (recorded === undefined) return;
    this.journal.putNode({ ...recorded, stats: this.journaledStats(instance, stats) });
  }

  /**
   * Journaled stats: transcript-predating asks drop the world tool count.
   *
   * Root cause: the driver tool counter is in-memory, zeroed per ask, so an ask continuing a transcript counts
   * only its own rounds -- none of the transcript calls. Undercounting is not an accounting bug (that is tokens)
   * but polluted **purity criteria**: a zero-reporting ask counts as pure in a later amendment and settles from cache
   * after the close -- though it touched the workspace. A missing key already means touched (conservative); dropping is honest.
   * tokens / toolCalls / turns persist as-is: usage, not purity claims.
   */
  private journaledStats(instance: InstanceRef, stats: AskStats): AskStats {
    if (!this.priorTranscriptAsks.has(refToString(instance))) return stats;
    const { worldToolCalls: _unreliable, ...rest } = stats;
    return rest;
  }

  failed(instance: InstanceRef, error: WorkflowError): void {
    const node = this.liveNodes.get(refToString(instance));
    if (node === undefined || node.settled) return;
    this.settleFailed(node, error);
  }

  /** Still an in-flight (admitted, unsettled) live ask -- throttle observations mean anything only for those. */
  isLive(instance: InstanceRef): boolean {
    const node = this.liveNodes.get(refToString(instance));
    return node !== undefined && !node.settled;
  }

  /** Effective name of the subagent owning the in-flight ask (named in close events); undefined when none. */
  liveActorName(instance: InstanceRef): string | undefined {
    const node = this.liveNodes.get(refToString(instance));
    return node === undefined || node.settled ? undefined : node.actor.persona.name;
  }

  /** Abort every in-flight ask: on run cancel/failure. With the flag, the cancelled settled event is emitted. */
  abortInFlight(error: WorkflowError, emitCancelled: boolean): void {
    for (const node of this.liveNodes.values()) {
      if (node.settled) continue;
      node.settled = true;
      if (node.dispatched) this.host.driver.cancelAsk(node.instance);
      if (emitCancelled) {
        this.host.record({ type: "node-settled", instance: node.instance, outcome: "cancelled" });
      }
      node.deferred.reject(error);
    }
    this.liveNodes.clear();
    this.activeAsks = 0;
  }

  // ----------------------- internal: admission / dispatch -----------------------

  private drainAdmission(actor: Actor): void {
    drainActorAdmission(actor);
    this.pumpActor(actor);
  }

  /**
   * Journal-recorded asks: released in the **recorded settlement order**. The hold rule orders admission within one actor;
   * cross-actor completion order needs this gate -- every post-await journal call in a fan-out is numbered by it.
   */
  private releaseCachedAsk(
    instance: InstanceRef,
    recorded: NodeRecord,
    deferred: Deferred<unknown>,
  ): void {
    this.host.holdForReplay(instance, () => this.settleCachedAsk(instance, recorded, deferred));
  }

  private settleCachedAsk(
    instance: InstanceRef,
    recorded: NodeRecord,
    deferred: Deferred<unknown>,
  ): void {
    if (recorded.status === "completed") {
      this.host.record({ type: "node-settled", instance, outcome: "ok", cached: true });
      deferred.resolve(recorded.result);
    } else {
      // A recorded failure short-circuits too: the script may have caught it and branched; replay must reenact the rejection.
      this.host.record({
        type: "node-settled",
        instance,
        outcome: "failed",
        cached: true,
        error: recorded.error,
      });
      deferred.reject(WorkflowError.fromJSON(recorded.error!));
    }
  }

  /**
   * Rescan every actor pending queue. Public for exactly one caller: the engine, after raising this run concurrency cap.
   * The cap itself is
   * read fresh per dispatch in the pump, but no other event triggers a rescan -- queued asks
   * would otherwise wait for the next settlement; more-runs-right-after-raising is what this command buys.
   */
  pumpAll(): void {
    for (const actor of this.actorOrder) this.pumpActor(actor);
  }

  private pumpActor(actor: Actor): void {
    if (this.host.isRunSettled()) return;
    if (actor.current !== undefined) return;
    if (actor.liveQueue.length === 0) return;
    if (this.activeAsks >= this.host.caps.maxConcurrency) return;
    const node = actor.liveQueue.shift()!;
    actor.current = node;
    this.activeAsks++;
    void this.dispatch(node);
  }

  private async dispatch(node: AskNode): Promise<void> {
    let session: SessionRef;
    try {
      session = await this.ensureSession(node.actor);
    } catch (cause) {
      if (this.host.isRunSettled() || node.settled) return;
      // Carry the cause text into the message: the error JSON keeps only code/message, the cause never journaling,
      // so actor-session-creation failure is an undiagnosable black box in GUI/journal
      // (in the field the underlying cause is a foreign-key constraint failure).
      this.settleFailed(
        node,
        new WorkflowError(
          "DriverError",
          `Failed to create the subagent session: ${describeCause(cause)}`,
          { cause },
        ),
      );
      return;
    }
    if (this.host.isRunSettled() || node.settled) return;
    // node-dispatched after the session is ready. The process-level concurrency gate
    // is not here: it admits per **model request**, living in the runtime deps below the driver; the scheduler guards
    // only the per-run ask-level cap.
    // This repeats the instance birth facts (the same-named event in types.ts): what the scheduler has at hand
    // shares a source with its queued event; both birth phase names are stamped by the engine from one mint table.
    this.host.record({
      type: "node-dispatched",
      instance: node.instance,
      kind: "ask",
      actor: node.actor.ref,
      ...(node.actor.name === undefined ? {} : { actorName: node.actor.name }),
      ...(node.instructionsHead === undefined ? {} : { instructionsHead: node.instructionsHead }),
    });
    node.dispatched = true;
    const message: AskMessage = {
      instructions: node.instructions,
      typed: node.spec.typed,
      schema: node.spec.schema,
    };
    this.host.driver.startAsk(session, node.instance, message);
  }

  private ensureSession(actor: Actor): Promise<SessionRef> {
    if (actor.sessionPromise !== undefined) return actor.sessionPromise;
    // The seed is known only at the divergence point (found at runtime), so it is handed over here, engine-side --
    // the engine holds the import state, the driver the session store; this signature is their minimal meeting point.
    const seed = actor.imported?.seed();
    const promise = this.host.driver
      .createActorSession(actor.ref, actor.persona, seed)
      .then((session) => {
        actor.session = session;
        // The resolved model is written inside the driver create by the host-side runtime factory (only it knows
        // which model a tier maps to). putActor replaces the whole row, so this write must read the just-written value back
        // and carry it, else it is erased -- losing the tier-resolution audit and the resume basis.
        const resolvedModel = this.journal.getActor(
          this.host.runId,
          actor.ref.siteId,
          actor.ref.ordinal,
        )?.resolvedModel;
        this.journal.putActor({
          runId: this.host.runId,
          siteId: actor.ref.siteId,
          ordinal: actor.ref.ordinal,
          name: actor.name,
          persona: actor.persona,
          sessionId: session.id,
          resolvedModel,
        });
        return session;
      });
    actor.sessionPromise = promise;
    return promise;
  }

  // ----------------------------- internal: settlement -----------------------------

  private settleOk(node: AskNode, artifact: unknown): void {
    if (node.settled) return;
    node.settled = true;
    this.journal.putNode(this.nodeRecordFor(node, { status: "completed", result: artifact }));
    this.host.record({ type: "node-settled", instance: node.instance, outcome: "ok" });
    this.finishLiveNode(node);
    node.deferred.resolve(artifact);
  }

  private settleFailed(node: AskNode, error: WorkflowError): void {
    if (node.settled) return;
    node.settled = true;
    // A settled failure must persist (over the admission running): failure is an ending, and the script may have
    // observed the rejection and branched; replay must reenact it -- journalized failures are a hard replay rule, not optional.
    this.journal.putNode(this.nodeRecordFor(node, { status: "failed", error: error.toJSON() }));
    this.host.record({
      type: "node-settled",
      instance: node.instance,
      outcome: "failed",
      error: error.toJSON(),
    });
    this.finishLiveNode(node);
    // A node failure rejects only that ask, never the run (the script can catch).
    node.deferred.reject(error);
  }

  private finishLiveNode(node: AskNode): void {
    this.liveNodes.delete(refToString(node.instance));
    if (node.actor.current === node) {
      node.actor.current = undefined;
      this.activeAsks--;
    }
    this.pumpAll();
  }

  private nodeRecordFor(
    node: AskNode,
    outcome:
      | { status: "completed"; result: unknown }
      | { status: "failed"; error: NodeRecord["error"] },
  ): NodeRecord {
    const record: NodeRecord = {
      runId: this.host.runId,
      siteId: node.instance.siteId,
      ordinal: node.instance.ordinal,
      kind: "ask",
      actorSiteId: node.actor.ref.siteId,
      actorOrdinal: node.actor.ref.ordinal,
      actorSeq: node.actorSeq,
      inputHash: node.hash,
      status: outcome.status,
    };
    if (outcome.status === "completed") record.result = outcome.result;
    else record.error = outcome.error;
    if (node.lastStats !== undefined)
      record.stats = this.journaledStats(node.instance, node.lastStats);
    return record;
  }
}
