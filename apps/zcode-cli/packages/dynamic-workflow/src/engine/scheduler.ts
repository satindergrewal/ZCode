/* oxlint-disable eslint(max-lines) -- ask lifetime (FIFO, hold rules, caps, settlement) stays one file by design; reflow grew the count. */
/**
 * The ask scheduler: splits per-actor FIFO + hold rules + capped dispatch + ask settlement out of
 * the engine core so both files stay focused (and under the per-file line cap). The engine injects
 * its dependencies via {@link SchedulerHost} (driver, caps, ordinal minting, run-level failure);
 * the scheduler owns ask lifetime only, never run lifetime.
 *
 * Key rules in engine.ts's header: hit short-circuit, actorSeq admission order, replay hold rules, serial actors.
 *
 * Internal types and SchedulerHost: scheduler-types.ts; submit/turn upward reports:
 * scheduler-submit.ts (the 400-line cap again). SchedulerHost re-exported here, import paths unchanged.
 * The replay hash-mismatch error {@link hashMismatch}: hash-mismatch.ts (same reason).
 */

import { cachedAskFacts, headOfInstructions, type CachedAskFacts } from "./cached-ask-facts.js";
import { inputHash } from "./hash.js";
import { hashMismatch } from "./hash-mismatch.js";
import { importedAskRecord, type ImportedActorState } from "./imported-cache.js";
import {
  defer,
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

export type { SchedulerHost } from "./scheduler-types.js";

export class AskScheduler {
  private readonly actors = new Map<ActorId, Actor>();
  private readonly actorOrder: Actor[] = [];
  private readonly liveNodes = new Map<string, AskNode>();
  /**
   * Ask instances whose transcript predates this dispatch (`siteId@ordinal`): continued
   * predecessors' in-flight asks and resume re-dispatches from running rows. Their journaled stats
   * drop `worldToolCalls` - see {@link journaledStats}. Not cleared at settlement: late stats
   * backfill still consults it.
   */
  private readonly priorTranscriptAsks = new Set<string>();
  /**
   * Per-actor count of already-recorded ask rows (siteId@ordinal -> count), built in one pass from
   * the ask rows the resume branch already reads ({@link seedRecordedAsks}). Why fixed: registerActor
   * used to read the whole node table per actor and filter - O(actors x rows) decodes of every ask
   * answer and report item on wide fans. One build is correct: an actor registers before its first
   * ask, so rows visible then belong to earlier lives; fresh runs empty.
   */
  private readonly recordedAsks = new Map<string, number>();
  private activeAsks = 0;

  /** How scheduler-submit.ts's free functions probe live nodes and settle by result (see {@link SubmitSeam}). */
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

  /** Resume feeds this run's stored ask rows (results optional) to build {@link recordedAsks}. */
  seedRecordedAsks(askRows: readonly NodeRecord[]): void {
    for (const row of askRows) {
      if (row.kind !== "ask" || row.actorSiteId === undefined || row.actorOrdinal === undefined) {
        continue;
      }
      const actorKey = refToString({ siteId: row.actorSiteId, ordinal: row.actorOrdinal });
      this.recordedAsks.set(actorKey, (this.recordedAsks.get(actorKey) ?? 0) + 1);
    }
  }

  hasActor(id: ActorId): boolean {
    return this.actors.has(id);
  }

  /**
   * Register one actor (creating site x ordinal). imported is the amend-resume candidate: the engine matched effective name + normalized persona in createActor; the scheduler only consumes it.
   */
  registerActor(
    ref: ActorRef,
    id: ActorId,
    name: string | undefined,
    persona: PersonaSpec,
    imported?: ImportedActorState,
  ): Actor {
    const recordedCount = this.recordedAsks.get(refToString(ref)) ?? 0;
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
    // Do NOT preresolve the journal's sessionId into actor.session/sessionPromise to let
    // ensureSession skip driver.createActorSession after resume: the production driver's session
    // map fills only inside createActorSession and startAsk looks up by map - every resume
    // re-dispatch would fail unknown-session. Pure replay (no dispatch) and fake drivers
    // (startAsk without lookup) hide the bug. Session identity is driver-owned (the production
    // minter is pure over (runId, actorRef), reminting the same id); dwf_actor.session_id is a
    // record, not authority - never short-circuit sessions from the journal; first dispatch always
    // goes through driver.createActorSession (ensureSession).
    this.actors.set(id, actor);
    this.actorOrder.push(actor);
    return actor;
  }

  /** Admit one ask: completed hits short-circuit (via hold rules); running hits and misses dispatch live. */
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
      // Hits defensively recheck inputHash - mismatch means the purity contract broke; fail the run loudly.
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
        // Crashed mid-execution: re-dispatch live at the recorded actorSeq position (hold rules keep admission order).
        // Its transcript already holds the prior life's messages, so stats record prior-transcript.
        actor.pendingRecorded.set(seq, () => {
          reconcile();
          this.admitLive(instance, actor, seq, instructions, hash, spec, deferred, true);
        });
      } else {
        // completed/failed: short-circuit settle, no driver call. Birth facts taken at once after reconcile
        // (whether the answer came from a predecessor transcript depends on import-consumption now; events may be deferred by the settle-order gate).
        actor.pendingRecorded.set(seq, () => {
          reconcile();
          this.releaseCachedAsk(
            instance,
            recorded,
            deferred,
            cachedAskFacts(actor.ref, seq, instructions, actor.imported),
          );
        });
      }
      this.drainAdmission(actor);
      return deferred.promise;
    }

    // Miss (fresh): register into pendingLive; after recorded nodes drain, admit in arrival order with a fresh actorSeq.
    // After the seq, consult the import cache (amend-resume): hit = cached settle, not live.
    actor.pendingLive.push(() => {
      const seq = actor.nextAdmitSeq++;
      if (this.tryImportedSettle(instance, actor, seq, hash, instructions, deferred)) return;
      // Only after the miss do we learn it continues a predecessor's in-flight ask - decided in take, with the divergence tally.
      const carried = actor.imported?.carriedAt(seq) === true;
      this.admitLive(instance, actor, seq, instructions, hash, spec, deferred, carried);
    });
    this.drainAdmission(actor);
    this.pumpAll();
    return deferred.promise;
  }

  /**
   * Admit one ask as a live node: mint, persist running at admission, enqueue, emit.
   *
   * priorTranscript: this ask does not start from an empty transcript (continued predecessor, or resume re-dispatch) - affects stats persistence only, see journaledStats.
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
    // The instruction head rides the birth events (docs/execution-engine.md Events): instructions
    // here are still the author's verbatim - the driver's quality/schema footnotes attach in
    // startAsk, so the summary never mixes in engine words. Computed once onto the node: dispatch
    // repeats birth facts; both events must carry the same string.
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
    // running persists at admission (actorSeq + inputHash): crash-resume re-dispatches from it.
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
    // Going live does NOT close the import cache. It used to: any live ask meant the workspace
    // might have changed - clock instead of dependency; sibling asks after the first miss in one
    // Promise.all were all invalidated despite no dependency (measured: 50-wide fan lost 6 hits, a
    // 5-wide fan its only one). The first write closes it now: driver-reported askMutating before a
    // mutating tool, or a live world.run; until then the world equals the predecessor's and hits hold.
  }

  /**
   * On fresh admission, consult the import cache (amend-resume). Hit = cached settle, return true (caller not live); the test and divergence ledger live in ImportedActorState.
   *
   * A hit writes a real dwf_node row and emits only node-settled cached:true - like replay hits',
   * {@link releaseCachedAsk}'s posture: no node-queued/node-dispatched, no liveQueue, no session,
   * no actor.current. That settlement doubles as the birth event: it re-emits birth facts and names
   * the predecessor session holding the exchange ({@link cachedAskFacts}).
   */
  private tryImportedSettle(
    instance: InstanceRef,
    actor: Actor,
    seq: number,
    hash: string,
    instructions: string,
    deferred: Deferred<unknown>,
  ): boolean {
    // Cache closed => only PURE asks pass (predecessor recorded toolCalls === 0): they depend on
    // instruction + transcript prefix, not the workspace, so an old-world answer holds in the new
    // one; tool-bearing entries go live even at equal hash - their workspace may have changed. The
    // going-live ask forks the actor's transcript; the consumed prefix remains the seed boundary.
    const entry = this.host.importCacheClosed()
      ? actor.imported?.takeIfPure(seq, hash)
      : actor.imported?.take(seq, hash);
    if (entry === undefined) return false;
    this.journal.putNode(importedAskRecord(this.host.runId, instance, actor.ref, seq, hash, entry));
    const facts = cachedAskFacts(actor.ref, seq, instructions, actor.imported);
    this.host.record({ type: "node-settled", instance, outcome: "ok", cached: true, ...facts });
    deferred.resolve(entry.result);
    return true;
  }

  // —————————————— upward reports ——————————————

  /** submit_result arrived: body in scheduler-submit.ts's handleSubmitAttempted. */
  submitAttempted(instance: InstanceRef, payload: unknown): void {
    handleSubmitAttempted(this.submitSeam, instance, payload);
  }

  /** Turn ended without submit: body in scheduler-submit.ts's handleTurnEnded. */
  turnEnded(instance: InstanceRef, finalText: string): void {
    handleTurnEnded(this.submitSeam, instance, finalText);
  }

  noteStats(instance: InstanceRef, stats: AskStats): void {
    const node = this.liveNodes.get(refToString(instance));
    if (node !== undefined) {
      node.lastStats = stats;
      return;
    }
    // The node left liveNodes - the typed-accept-dominated path: submit ends the turn and settles,
    // while the real actor's usage is known only after turn resolution (post-submit), so stats
    // arrive after settlement. Backfill the settled journal row: stats only, preserving
    // status/result/actorSeq/inputHash/error/kind/actor identity. Best effort, idempotent; budget
    // stays in engine.askStats (this repairs journal completeness only).
    const recorded = this.journal.getNode(this.host.runId, instance.siteId, instance.ordinal);
    if (recorded === undefined) return;
    this.journal.putNode({ ...recorded, stats: this.journaledStats(instance, stats) });
  }

  /**
   * Journaled stats: prior-transcript asks drop worldToolCalls.
   *
   * Why: the driver's tool counter is in-memory, zeroed per ask, so an ask continuing a transcript
   * counts only its own turns, none of the transcript's earlier calls. Undercounting does not skew
   * the ledger (tokens' job) but poisons the purity test: a zero-reporting ask would be treated as
   * pure by a later amendment and cache-settle after the gate closed despite touching the
   * workspace. Absent key already means touched (conservative read), so dropping is the honest record.
   * tokens/toolCalls/turns stay: usage, not purity claims.
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

  /** Whether the instance is still a live (admitted, unsettled) ask - throttle observations only make sense for such nodes. */
  isLive(instance: InstanceRef): boolean {
    const node = this.liveNodes.get(refToString(instance));
    return node !== undefined && !node.settled;
  }

  /** The live ask's subagent effective name (named in gate-close events); undefined when not live. */
  liveActorName(instance: InstanceRef): string | undefined {
    const node = this.liveNodes.get(refToString(instance));
    return node === undefined || node.settled ? undefined : node.actor.persona.name;
  }

  /** Abort every live ask: run cancel/fail. emitCancelled adds node-settled(cancelled). */
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

  // —————————————— internal: admission / dispatch ——————————————

  private drainAdmission(actor: Actor): void {
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
    this.pumpActor(actor);
  }

  /**
   * Hit-recorded asks release in the journal's recorded settlement order
   * (docs/execution-engine.md "Replaying the settle order"). Hold rules order admission within one
   * actor; cross-actor completion order needs this gate - every post-await journal call in a fan
   * branch is numbered by it.
   */
  private releaseCachedAsk(
    instance: InstanceRef,
    recorded: NodeRecord,
    deferred: Deferred<unknown>,
    facts: CachedAskFacts,
  ): void {
    this.host.holdForReplay(instance, () =>
      this.settleCachedAsk(instance, recorded, deferred, facts),
    );
  }

  private settleCachedAsk(
    instance: InstanceRef,
    recorded: NodeRecord,
    deferred: Deferred<unknown>,
    facts: CachedAskFacts,
  ): void {
    if (recorded.status === "completed") {
      this.host.record({ type: "node-settled", instance, outcome: "ok", cached: true, ...facts });
      deferred.resolve(recorded.result);
    } else {
      // Recorded failures short-circuit too: the script may have caught and branched on them; replay must re-raise the same rejection.
      this.host.record({
        type: "node-settled",
        instance,
        outcome: "failed",
        cached: true,
        error: recorded.error,
        ...facts,
      });
      deferred.reject(WorkflowError.fromJSON(recorded.error!));
    }
  }

  /**
   * Rescan every actor's pending queue. One public caller: the engine, after raising this run's
   * concurrency cap (docs/dynamic-workflow/concurrency.md "Two bounds on a run"). The cap is read
   * live per dispatch in {@link pumpActor}, but nothing else triggers a rescan - queued asks would
   * wait for the next settlement; "run more right after raising" is what this command buys.
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
      // Fold cause text into message: WorkflowError.toJSON persists code/message only; cause never
      // reaches journal or logs, turning session-creation failures into undiagnosable black boxes
      // (in the field: session_task_link FOREIGN KEY constraint failed).
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
    // node-dispatched fires once the session is ready
    // (docs/dynamic-workflow/concurrency.md "Two bounds on a run"). The process-level gate is not
    // here: it admits per model request, living in the runtime deps below the driver (decisions
    // 34/38); the scheduler guards only the per-run ask cap (decision 17).
    // This event repeats the instance's birth facts (types.ts node-dispatched): the scheduler's
    // fields share the source of its node-queued; both birth phase names are stamped by the engine
    // in record, from the same mint table.
    this.host.record({
      type: "node-dispatched",
      instance: node.instance,
      kind: "ask",
      actor: node.actor.ref,
      ...(node.actor.name === undefined ? {} : { actorName: node.actor.name }),
      ...(node.actor.persona.model === undefined
        ? {}
        : { actorPersonaModel: node.actor.persona.model }),
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
    // The seed is known only at the divergence point (found at runtime), so it must be handed to
    // the driver here, engine-side: the engine owns import state, the driver the session store -
    // this signature is their minimal meeting point.
    const seed = actor.imported?.seed();
    const promise = this.host.driver
      .createActorSession(actor.ref, actor.persona, seed)
      .then((session) => {
        actor.session = session;
        // resolvedModel is written by the host-side runtime factory INSIDE createActorSession (only
        // it knows which model "lite" means). putActor replaces the record whole, so this write must
        // read the just-written value back through, or it would be erased - losing the tier-resolution
        // audit and the resume basis.
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

  // —————————————— internal: settlement ——————————————

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
    // Settle-failures must be journaled (over the admission running row): failure is completion,
    // and the script may have observed the rejection and branched; replay must reproduce it -
    // journaling failures is a hard replay-correctness requirement, not optional.
    this.journal.putNode(this.nodeRecordFor(node, { status: "failed", error: error.toJSON() }));
    this.host.record({
      type: "node-settled",
      instance: node.instance,
      outcome: "failed",
      error: error.toJSON(),
    });
    this.finishLiveNode(node);
    // A node failure rejects only that ask, never the run (the script may catch).
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

/** cause -> one bounded line (Error message, else String(); placeholder when empty). */
function describeCause(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  const trimmed = text.trim();
  if (trimmed.length === 0) return "unknown error";
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}
