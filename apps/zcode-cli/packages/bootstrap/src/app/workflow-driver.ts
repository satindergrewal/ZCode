// ============================================================
// AgentRuntime-backed WorkflowDriver（Boundary B）
// ============================================================
// Lands the dynamic-workflow engine core's downward side-effect port WorkflowDriver onto the real ZCode AgentRuntime:
// one **persistent** child runtime per actor (repeated executeTurn accumulates messageHistory), one executeTurn per
// ask, with a typed ask's result bridged back to the engine verdict via the session-level WorkflowSubmitPort.
//
// The other two halves of Boundary B - `executeWorldRead` and `executeArtifactPublish` - live in
// workflow-world-read.ts and workflow-artifact-publish.ts; this file only forwards. Neither shares
// state with this file (no session, turn, or submit-bridge touching), so after the split this file does one thing:
// session and turn orchestration.
//
// Three sequences (this file's core invariants):
//   1. accept: the model calls submit_result -> the handler blocks on port.respond -> this driver reports
//      askSubmitAttempted -> the engine validates -> respondToSubmit(accept) -> resolves the deferred to {accept:true}
//      -> the handler returns success (hanging turnControl stops the turn) -> executeTurn resolves -> only askStats is
//      reported (no askTurnEnded: the engine already settled the ask).
//   2. reject (repair within the turn): respondToSubmit(reject, violations) -> resolves the deferred to
//      {accept:false, violations} -> the handler throws -> error tool_result (no turnControl) -> the same turn
//      continues -> the model retries -> another respond -> another deferred. On repair-budget exhaustion the engine
//      calls cancelAsk instead.
//   3. nudge (turn ended without submission): executeTurn resolves unaccepted -> report askTurnEnded -> the engine
//      decides to nudge -> respondToSubmit(nudge) (no parked deferred at this point; the turn ended) -> a brand-new
//      executeTurn starts on the same persistent runtime (the nudge prompt).
// Three-value to two-value verdict mapping (the engine SubmitVerdict is ternary; contracts WorkflowSubmitPort binary):
//   accept -> {accept:true}; reject -> {accept:false, violations} (Violation mapped 1:1); nudge -> no deferred,
//   start a new turn. See respondToSubmit.
// The fourth sequence (escalation Q&A) sits at the **same layer** as the three above:
//   4. escalate: the model calls escalate -> the handler blocks on escalatePort -> the driver mints a qid, parks a
//      deferred, registers the question in the escalation registry, and dual-writes escalation-raised (journal + emit)
//      -> the main agent looks the answer up via the run service's resolveQuestion -> driver.respondToEscalation
//      resolves the deferred and emits escalation-resolved -> the tool result is the answer text -> the actor's turn
//      continues in place and the ask settles normally.
//      The engine core is **unaware**: escalation happens inside the driver's ask boundary (same layer as
//      repair/nudge rounds) and writes no dwf_node row. The escape hatch is cancelAsk - it rejects along with the
//      parked escalation deferred.
// workflow-driver-transcript.ts）：
// amend-resume adds two driver-private duties, both
// transcript-only, so the machinery lives in workflow-actor-transcript.ts and this file orchestrates (the three
//   - **ask boundary accounting**: once an exchange ends (repair / nudge rounds and post-submit tail messages
//     included), write the actor session's persisted message count into that ask's journal row. Every ask writes -
//     any run is a potential predecessor of a future amendment.
//   - **transcript truncation**: when `createActorSession` carries a seed, copy the source session's first N messages
//     into the freshly minted session and rehydrate.
// This round adds a third, also transcript-only, also in its own module (workflow-driver-quiescence.ts):
//   - **session quiescence registry**: at dispose, record per session whether a turn is still writing. When
//     amending an in-flight predecessor, amend needs it to decide whether the message count taken now is trustworthy
//     - the precondition for continuing the unfinished ask.

import type { SessionId, WorkflowEscalatePort } from "@zcode/contracts";
import type { TurnResult } from "@zcode/core";
import {
  GENERIC_SUBMIT_PROFILE,
  refToString,
  WorkflowError,
  type ActorRef,
  type ActorSessionSeed,
  type ArtifactPublishRequest,
  type ArtifactVersionRecord,
  type AskMessage,
  type InstanceRef,
  type JournalStorePort,
  type PersonaSpec,
  type RunEvent,
  type SessionRef,
  type SubmitVerdict as EngineSubmitVerdict,
  type WorkflowDriver,
  type WorkflowReportSink,
  type WorldReadOp,
} from "@zcode/dynamic-workflow";
import { executeArtifactPublish } from "./workflow-artifact-publish.js";
import { qualityEpilogue } from "./workflow-ask-epilogue.js";
import { ensureSubmitProfileFits } from "./workflow-driver-submit-profile.js";
import { executeWorldRead } from "./workflow-world-read.js";
import {
  createActorModelActivity,
  createRunStallClock,
  type RunStallClock,
} from "./workflow-driver-concurrency.js";
import { handleModelTurnFailure, type ModelFailureHost } from "./workflow-driver-model-failure.js";
import {
  createActorSessionQuiescence,
  releaseActorSessions,
  type ActorSessionQuiescenceLedger,
} from "./workflow-driver-quiescence.js";
import {
  makeSessionEscalatePort,
  respondToParkedEscalation,
  withdrawSessionEscalations,
  type EscalationHost,
} from "./workflow-driver-escalation.js";
import {
  NUDGE_PROMPT,
  TYPED_TOOL_EPILOGUE,
  effectiveActorName,
  isTurnCancelled,
  mapViolations,
  mintActorSessionId,
  reportTurnObservations,
  schemaEpilogue,
  toWorkflowError,
} from "./workflow-driver-helpers.js";
import { makeSessionSubmitPort, type SubmitBridgeHost } from "./workflow-driver-submit-bridge.js";
import {
  countSessionTranscript,
  journalAskMessageBoundary,
  seedActorSession,
} from "./workflow-driver-transcript.js";
import type { AgentRuntimeWorkflowDriverDeps, SessionState } from "./workflow-driver-types.js";

/**
 * The real WorkflowDriver. Constructed via {@link createAgentRuntimeWorkflowDriver} (binds deps, backfills the sink).
 */
class AgentRuntimeWorkflowDriver implements WorkflowDriver {
  readonly journal: JournalStorePort;
  readonly emit: (event: RunEvent) => void;

  private readonly sink: WorkflowReportSink;
  private readonly deps: AgentRuntimeWorkflowDriverDeps;
  private readonly sessions = new Map<string, SessionState>();
  /// refToString(instance) -> owning session, for respondToSubmit / cancelAsk reverse lookup.
  private readonly instanceToSession = new Map<string, SessionState>();
  /// qid -> parking session, for respondToEscalation lookup (same family as instanceToSession).
  private readonly qidToSession = new Map<string, SessionState>();
  /// Per-run monotonic escalation counter; the second segment of a qid. With runId it forms a collision-free id.
  private escalationSeq = 0;
  /// dispose idempotence gate (the engine contract is exactly-once, but the gate is cheaper and sturdier here).
  private disposed = false;
  /// This run's subscription to governor cap changes (once per run; unsubscribed at dispose).
  private readonly concurrencyUnsubscribe?: () => void;
  /**
   * Host face for the escalation bridge (workflow-driver-escalation.ts): both tables shared by reference, counter and
   * record reach this class via closure - no private state leaks, and the bridge functions need not know the class shape.
   */
  private readonly escalationHost: EscalationHost;
  /// Host face for model-side failure containment (workflow-driver-model-failure.ts): the same share-by-reference pattern.
  private readonly modelFailureHost: ModelFailureHost;
  /// Host face for the submit bridge (workflow-driver-submit-bridge.ts): ditto, both by reference.
  private readonly submitHost: SubmitBridgeHost;
  /// Run-level stall clock: every actor's success / retry cadence feeds this one ledger.
  private readonly stallClock: RunStallClock;
  /**
   * Session quiescence ledger (workflow-driver-quiescence.ts): at dispose, per session, whether a turn was still
   * writing. Sole reader: amend - before continuing a predecessor's in-flight ask it must confirm the session went
   * quiet.
  private readonly quiescence: ActorSessionQuiescenceLedger;

  constructor(deps: AgentRuntimeWorkflowDriverDeps, sink: WorkflowReportSink) {
    this.deps = deps;
    this.sink = sink;
    this.journal = deps.journal;
    // The engine's record() calls driver.emit immediately for **every** event (engine.ts), so this is the only place
    // the driver sees an ask endpoint: `node-settled` is the common exit of the three settle paths (settleOk /
    // settleFailed / abortInFlight) - exactly the this-one-stopped-working signal the seat gate awaits.
    //
    // Why not judge from driver state: `state.currentInstance` is never cleared, and after an untyped ask settles via
    // askTurnEnded on the engine side `live()` stays true - vacating by it would never vacate, and FIFO would wait
    // forever.
    // What is handed down **must be the same object reference**: the launch side's sequence capture checks sequence
    // by reference equality (createJournalSequenceCapture in dynamic-workflow-run-launch.ts).
    this.emit =
      deps.seatGate === undefined
        ? deps.emit
        : (event) => {
            if (event.type === "node-settled") deps.seatGate?.askSettled(event.instance);
            deps.emit(event);
          };
    this.escalationHost = {
      deps,
      sessions: this.sessions,
      qidToSession: this.qidToSession,
      nextEscalationSeq: () => ++this.escalationSeq,
      record: (event) => this.record(event),
    };
    this.submitHost = { sessions: this.sessions, sink };
    this.modelFailureHost = {
      deps,
      sink,
      isDisposed: () => this.disposed,
      runTurn: (state, instance, input, epilogueStart) =>
        this.runTurn(state, instance, input, epilogueStart),
    };
    this.stallClock = createRunStallClock({
      ...(deps.clock?.now === undefined ? {} : { now: deps.clock.now }),
      ...(deps.clock?.schedule === undefined ? {} : { schedule: deps.clock.schedule }),
      ...(deps.clock?.stallAfterMs === undefined ? {} : { afterMs: deps.clock.stallAfterMs }),
      onStalled: (info) => this.sink.runStalled(info),
    });
    this.quiescence = createActorSessionQuiescence({
      ...(deps.clock === undefined ? {} : { clock: deps.clock }),
      ...(deps.clock?.quiesceMs === undefined ? {} : { quiesceMs: deps.clock.quiesceMs }),
    });
    // The probe is handed over at **construction**: the run service must hang it on the entry, and amend may arrive at
    // any moment of this run's life. After dispose is too late - the service is already counting sessions.
    deps.onQuiescenceProbe?.(this.quiescence);
    if (deps.concurrency !== undefined) {
    // Fan-out reaches only runs with in-flight/queued requests on the key, so subscribing once at construction is fine.
      this.concurrencyUnsubscribe = deps.concurrency.subscribe(deps.runId ?? "run", (change) => {
        this.stallClock.noteCap(change.next);
        this.sink.concurrencyChanged(change);
      });
    }
  }

  async createActorSession(
    actor: ActorRef,
    persona: PersonaSpec,
    seed?: ActorSessionSeed,
  ): Promise<SessionRef> {
    const sessionId = mintActorSessionId(this.deps.runId ?? "run", actor);
    // Resume session-identity cross-check: the journal's dwf_actor.session_id is the **record**; the minting function
    // is the authority (pure over (runId, actorRef); a re-attach necessarily mints the same id). A mismatch means the
    // minting rules drifted (renamed/second implementation) - the consequences (rehydration reading the wrong session,
    // details page opening a nonexistent one) are far from the cause, so fail loudly at the first re-attach step with
    // a structured mismatch (same shape as the two hash-mismatch errors).
      this.deps.runId ?? "run",
      actor.siteId,
      actor.ordinal,
    )?.sessionId;
    if (journaled !== undefined && journaled !== sessionId) {
      throw new WorkflowError(
        "DriverError",
        `Subagent session identity mismatch for ${refToString(actor)}: the journaled session ` +
          `id and the minted one differ.`,
        { mismatch: { expected: journaled, got: sessionId } },
      );
    }
    const ref: SessionRef = { id: sessionId };
    // Session-level submit port (implementation in workflow-driver-submit-bridge.ts, clause-for-clause symmetric with
    // the escalation port below): the closure binds this session, so the model cannot override routing identity
    // (instance taken from currentInstance).
    // The escalation port is isomorphic: also closure-bound per session, also always injected (see the
// ActorRuntimeFactory field notes). The persona joins the closure too: the effective name is **frozen** (the engine
// fixes it at createActor and never changes), so computing it once here is cheaper than per-escalate lookups and
// cannot rename mid-flight.
    // Model-activity surface: the admission port rides down via runtime deps (every runner attempt gates first);
    // waiting / executing observations report only while an ask is in flight and not yet settled/cancelled by the
    // engine - late observations are meaningless for a settled ask, and the engine side re-gates anyway. `state` is
    // built below, hence late-bound via closure.
    const live = (): InstanceRef | undefined =>
      state === undefined ||
      state.currentInstance === undefined ||
      state.accepted ||
      state.cancelled
        ? undefined
        : state.currentInstance;
    const modelActivity = createActorModelActivity({
      port: this.deps.concurrency,
      runId: this.deps.runId ?? "run",
      live,
      // The seat gate keys by **actor**, not ask instance: per-actor FIFO means at most one in-flight ask per actor,
      // so working-subagent and in-flight-ask are the same count - and the admission port was built per actor session
      // anyway.
      ...(this.deps.seatGate === undefined
        ? {}
        : { seat: { gate: this.deps.seatGate, key: refToString(actor) } }),
      handlers: {
        // The subagent's first workspace write => the engine closes the import cache.
        onMutating: (instance) => this.sink.askMutating(instance),
        onWaiting: (info) => {
          const instance = live();
          if (instance !== undefined) this.sink.askWaiting(instance, info);
        },
        onExecuting: () => {
          const instance = live();
          if (instance !== undefined) this.sink.askExecuting(instance);
        },
        // The run-level stall clock's two cadences: any actor's success resets, any retry arms.
        onRequestCompleted: () => this.stallClock.noteSuccess(),
        onRetryScheduled: (reason) => this.stallClock.noteRetryScheduled(reason),
      },
    });
    // Submit profile looked up by actor **site**: every ordinal of a site (each fan-out lane) runs the same ask set,
    // hence the same profile. Absent = generic.
    const submitProfile =
      this.deps.actorSubmitProfiles?.get(actor.siteId) ?? GENERIC_SUBMIT_PROFILE;
    // await: the production factory persists the session and creates the task link before returning (the FK needs the
    // session row first). The engine's ensureSession awaits this, so persistence completes before the first ask
    // dispatch.
      sessionId,
      actor,
      persona,
      submitPort,
      submitProfile,
      escalatePort,
      ...(seed === undefined ? {} : { seed }),
      ...(modelActivity.admission === undefined
        ? {}
        : { modelRequestAdmission: modelActivity.admission }),
    });
    if (seed !== undefined) {
      await seedActorSession(this.deps, {
        journaledSessionId: journaled,
        runtime,
        seed,
        sessionId,
      });
    }
    state = {
      ref,
      sessionId,
      runtime,
      submitProfile,
      currentTyped: false,
      accepted: false,
      cancelled: false,
      turnGeneration: 0,
      pendingEscalations: new Map(),
      escalationsUsed: 0,
      modelActivity,
      actor,
      actorName: effectiveActorName(persona),
      transientAttempts: 0,
    };
    modelActivity.observe(runtime, sessionId);
    this.sessions.set(sessionId, state);
    return ref;
  }

  startAsk(session: SessionRef, instance: InstanceRef, message: AskMessage): void {
    const state = this.sessions.get(session.id);
    if (state === undefined) {
    // Cannot theoretically happen (the engine creates the session before asking); normalize to DriverError and report
    // instead of staying silent.
        instance,
        new WorkflowError("DriverError", `Unknown subagent session: ${session.id}`),
      );
      return;
    }
    // If the previous ask left parked items on an abnormal path (interrupted other than by turn abort), withdraw them
    // here: once the new ask runs, nobody will ever read those answers, and leftover registry entries make snapshots
    // lie.
    state.currentInstance = instance;
    state.currentTyped = message.typed;
    state.accepted = false;
    state.cancelled = false;
    state.pendingSubmit = undefined;
    // Per-ask budget reset (nudge goes through runTurn, not here - a nudge is still the same ask).
    state.escalationsUsed = 0;
    state.abortController = new AbortController();
    // The previous ask's waiting / executing phases and tool counts must not leak into this ask; same for the
    // transient redrive counter.
    // The ask start feeds the seat gate (the end is recognized via `node-settled` in emit): from this moment the
    // subagent counts as working, so its next turn step passes the seat. Re-joining for the same actor's next ask is an
    // idempotent join - it never stopped working in between.
    this.deps.seatGate?.askStarted(refToString(state.actor), instance);
    state.transientAttempts = 0;
    state.cancelRedrive?.();
    state.cancelRedrive = undefined;
    this.instanceToSession.set(refToString(instance), state);

    // The quality epilogue applies to typed and untyped alike; the schema epilogue only to typed. Both append after the
    // scheduler computed inputHash, so neither enters the cache identity.
    // The typed-ask schema epilogue branches on the submit profile: a mono subagent's schema lives in the tool
    // declaration, leaving a one-liner; generic keeps embedding the full schema. The guard runs first: on a static-
    // profile mismatch it downgrades the session to generic (or fails the ask), and what is read below is the
    // corrected shape.
      return;
    }
    const input = message.typed
      ? `${message.instructions}${qualityEpilogue(message.schema)}${
          state.submitProfile.kind === "mono" ? TYPED_TOOL_EPILOGUE : schemaEpilogue(message.schema)
        }`
      : `${message.instructions}${qualityEpilogue(undefined)}`;
    // Epilogue boundary: the GUI folds the epilogue into a disclosure. Everything after the instruction body is engine
    // text, so the boundary is the body length; the model still receives the full text, and so does the persisted
    // text part.
    // Fire-and-forget: never await turn completion inside startAsk (the Boundary B contract).
  }

  respondToSubmit(instance: InstanceRef, verdict: EngineSubmitVerdict): void {
    const state = this.instanceToSession.get(refToString(instance));
    if (state === undefined) return;
    switch (verdict.kind) {
      case "accept": {
        // Mark accepted: the ask's turn resolve no longer reports askTurnEnded (the engine settleOk'd).
        state.accepted = true;
        const deferred = state.pendingSubmit;
        state.pendingSubmit = undefined;
        deferred?.resolve({ accept: true });
        return;
      }
      case "reject": {
        // Repair within the turn: the handler throws on {accept:false} -> error tool_result -> the model retries.
        const deferred = state.pendingSubmit;
        state.pendingSubmit = undefined;
        deferred?.resolve({ accept: false, violations: mapViolations(verdict.violations) });
        return;
      }
      case "nudge": {
        // Turn ended, no parked deferred: start a brand-new turn on the same persistent runtime to prompt submission.
        // A nudge is engine text end to end: boundary 0.
        this.runTurn(state, instance, NUDGE_PROMPT, 0);
        return;
      }
    }
  }

  cancelAsk(instance: InstanceRef): void {
    const state = this.instanceToSession.get(refToString(instance));
    if (state === undefined) return;
    // Engine-initiated cancellation (repair/nudge budgets gone, run cancelled/failed): abort the in-flight turn and
    // resolve any parked submit deferred so handlers never block forever; mark cancelled so the turn rejection stops
    // reporting askFailed.
    const deferred = state.pendingSubmit;
    state.pendingSubmit = undefined;
    deferred?.reject(new WorkflowError("Cancelled", "The ask was cancelled by the engine."));
    // Parked escalation Q&As get the **same treatment** as the submit deferred: reject them too, else the `escalate`
    // handler blocks forever inside an already-cancelled ask. This is the no-answer-equals-forever-block escape hatch
    // (no timeout, by design): run cancel and CLI process death therefore behave byte-identically to today - the ask
    // rejects Cancelled, the run turns Interrupted, and after resume the ask reruns, the actor asks anew and gets a
    // fresh qid.
    // Also withdraw redrive alarms mid-backoff: the ask is settled; another round would only burn tokens against a
    // node nobody listens to.
    state.cancelRedrive = undefined;
    state.abortController?.abort(new Error("workflow ask cancelled"));
  }

  /**
   * Resource release after the run settles (the engine calls exactly once after run-settled; see WorkflowDriver.dispose).
   *
   * Runs the app's close-session chain **verbatim** for every actor runtime - `closeBrowserSession` internally
   * beginShutdown, node_repl session release, browser session close, in order. A separate subagent close chain would
   * drift. Execution / MCP / the session store are not closed: subagents do not own them. Sessions with in-flight
   * turns wait for them to land before closing (see SessionState.turn); close failures only warn - settlement never
   * throws because of one. All three tables clear afterwards.
   * This method is **synchronous** and deliberately does not wait for in-flight turns - the engine contract is
   * release-immediately-after-settlement. The price: settled-promise-resolved does not imply the aborted turn finished
   * writing its tail, so while releasing, each session's current in-flight turn is recorded into the quiescence
   * ledger for amend to judge count trustworthiness. The orchestration of the two lives in
   * {@link releaseActorSessions} (full argument in the workflow-driver-quiescence.ts header).
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stallClock.dispose();
    releaseActorSessions(this.deps, this.sessions.values(), this.quiescence);
    this.concurrencyUnsubscribe?.();
    this.sessions.clear();
    this.instanceToSession.clear();
    this.qidToSession.clear();
  }

  /**
   * Settle one parked escalation Q&A (the run service calls in via the registry). Implementation in
   * workflow-driver-escalation.ts ({@link respondToParkedEscalation}); pure delegation here.
   */
  respondToEscalation(qid: string, answer: string): boolean {
    return respondToParkedEscalation(this.escalationHost, qid, answer);
  }

  /// Withdraw every parked escalation Q&A of one session; implementation at {@link withdrawSessionEscalations}.
  private withdrawEscalations(state: SessionState): void {
    withdrawSessionEscalations(this.escalationHost, state);
  }

  /**
   * World-read: fully delegated to {@link executeWorldRead} (workflow-world-read.ts).
   *
   * Pure forwarding, because world-read shares **no state** with the rest of this file: it touches no actor session,
   * no turn, no submit bridge, and needs three things (two ports and a cwd). Split out, this file keeps only
   * session-and-turn orchestration while op arities, cap enforcement, and git's fixed argv live in one place.
   */
  async executeWorldRead(op: WorldReadOp, args: unknown[]): Promise<unknown> {
    return await executeWorldRead(this.deps, op, args);
  }

  /**
   * User-facing artifact publishing: fully delegated to {@link executeArtifactPublish}
   * (workflow-artifact-publish.ts), for verbatim the same reason as world-read - no shared state with this file;
   * it needs two ports, a cwd, and a session id.
   *
   * The method is **optional** on Boundary B (`executeArtifactPublish?`), yet this driver always implements it:
   * has-storage is an assembly fact expressed by deps' `artifactStore` and failed loudly there; re-expressing it via
   * method-presence would give one fact two failure shapes.
   */
  async executeArtifactPublish(request: ArtifactPublishRequest): Promise<ArtifactVersionRecord> {
    return await executeArtifactPublish(this.deps, request);
  }

  // ------------------------------- internal: turn orchestration -------------------------------

  private runTurn(
    state: SessionState,
    instance: InstanceRef,
    input: string,
    epilogueStart: number,
  ): void {
    const abortSignal = state.abortController?.signal;
    state.turnGeneration++;
    state.turn = state.runtime
      .executeTurn(input, undefined, {
        ...(abortSignal ? { abortSignal } : {}),
        epilogueStart,
      })
      .then(
        (result) => this.onTurnResolved(state, instance, result),
        (error) => this.onTurnRejected(state, instance, error),
      );
  }

  private onTurnResolved(state: SessionState, instance: InstanceRef, result: TurnResult): void {
    // The two reports of one resolved turn (progress before usage); order and payload live in reportTurnObservations.
    reportTurnObservations(this.sink, state, instance, result);
    if (this.deps.actorTranscriptStore === undefined) {
      /// No transcript surface: the plain synchronous path, not one extra await (boundary accounting absent wholesale;
      /// see the deps field notes).
      return;
    }
    void this.settleExchange(state, instance, result);
  }

  /**
   * Report a turn's outcome and answer: is this ask's exchange over?
   *
   * Besides accept there is exactly one path: hand the final text to the engine (typed -> nudge or exhausted failure;
   * untyped -> settle accordingly). On nudge the engine starts a brand-new turn via respondToSubmit **within this
   * call stack**, so turnGeneration changed - precisely the exchange-not-over test (repair rounds do not apply: they
   * live inside one turn and never reach this method).
  private reportTurnOutcome(
    state: SessionState,
    instance: InstanceRef,
    result: TurnResult,
  ): boolean {
    // Submitted and engine-accepted: the ask settled; the turn end is a formality, no askTurnEnded.
    if (state.accepted) return true;
    const generation = state.turnGeneration;
    this.sink.askTurnEnded(instance, result.response);
    return state.turnGeneration === generation;
  }

  /**
   * An exchange's closing: count messages -> report outcome -> if the exchange truly ended, write the boundary into
   * the ask's journal row.
   * **Count before reporting**, the order is load-bearing: once reported, the engine may immediately dispatch this
   * actor's next ask on the same session (per-actor FIFO guarantees seriality, not a gap), and that round's messages
   * land in the same session, inflating this count. Counting first captures the length at the moment this exchange
   * ended.
  private async settleExchange(
    state: SessionState,
    instance: InstanceRef,
    result: TurnResult,
  ): Promise<void> {
    const boundary = await countSessionTranscript(this.deps, state, instance);
    const ended = this.reportTurnOutcome(state, instance, result);
    if (!ended || boundary === undefined) return;
    journalAskMessageBoundary(this.deps, state, instance, boundary);
  }

  private onTurnRejected(state: SessionState, instance: InstanceRef, error: unknown): void {
    // A dead turn has no reader for tool results: parked escalation Q&As must be withdrawn too, else they stay in the
    // snapshot's pendingQuestions forever, asking the main agent to answer a question with no audience.
    this.withdrawEscalations(state);
    if (state.cancelled || isTurnCancelled(error)) {
    // Engine-initiated cancellation (abort): the engine settled the ask; the driver does not double-report.
      return;
    }
    // Model-side error containment lives in workflow-driver-model-failure.ts (the policy table decides stop /
    // context_exceeded / transient redrive); anything not model-layer is a driver-side failure.
    if (handleModelTurnFailure(this.modelFailureHost, state, instance, error)) return;
    this.sink.askFailed(instance, toWorkflowError(error));
  }

// ------------------------------- internal: escalation Q&A bridge -------------------------------

  /**
   * Build a session-level escalation port; implementation in workflow-driver-escalation.ts
   * ({@link makeSessionEscalatePort}), alongside the clause-for-clause symmetry argument with {@link makeSessionSubmitPort}.
   */
  private makeEscalatePort(
    sessionId: SessionId,
    actor: ActorRef,
    persona: PersonaSpec,
  ): WorkflowEscalatePort {
    return makeSessionEscalatePort(this.escalationHost, sessionId, actor, persona);
  }

  /**
   /// Dual-write for one driver-side event: durable into `dwf_event`, real-time via emit fan-out.
   *
   /// Byte-shaped like the engine's record() (engine.ts), and the order is not negotiable: the launch side's sequence
   /// capture relies on appendEvent-then-synchronously-emit of the same event object to hand the freshly assigned
   /// sequence to emit (createJournalSequenceCapture in dynamic-workflow-run-launch.ts).
   */
  private record(event: RunEvent): void {
    this.journal.appendEvent(this.deps.runId ?? "run", event);
    this.emit(event);
  }
}

/**
 * Build a driver factory with deps bound, serving directly as the harness makeDriver. journal and emit come from deps;
 * the caller (tests/production) keeps the references for assertions and Boundary C fan-out.
 */
export function createAgentRuntimeWorkflowDriver(
  deps: AgentRuntimeWorkflowDriverDeps,
): (sink: WorkflowReportSink) => WorkflowDriver {
  return (sink) => new AgentRuntimeWorkflowDriver(deps, sink);
}

export { mintActorSessionId } from "./workflow-driver-helpers.js";
export type { ActorRuntimeFactory } from "./workflow-driver-types.js";
