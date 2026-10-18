/**
 * The execution engine's deterministic state machine (implements Boundary A, drives Boundary B
 * downward, reports upward via the sink).
 *
 * The core does no IO, reads no clock, uses no randomness: time/scheduling-dependent decisions
 * are either journaled or pinned by the deterministic "per-site ordinal + per-actor FIFO
 * actorSeq" rules, so first run and replay agree byte for byte.
 *
 * Key invariants:
 * - Instance identity = site id x per-site ordinal (nth ask#3 = ask#3@n). Actor identity =
 *   creating site x ordinal.
 * - Journal-first: every host call probes (siteId, ordinal); a hit short-circuits (no driver
 *   call) and defensibly re-checks inputHash - mismatch fails the run loudly (structured error,
 *   never a silent skew).
 * - Per-actor FIFO + actorSeq admission order + replay hold rules: scheduler.ts (this file
 *   delegates ask lifetime to it).
 *
 * This file owns run lifecycle: host API entries, usage accounting, run settlement, event
 * recording. User-facing artifacts, reports, world nodes, the import cache, and the three
 * terminal paths live in sibling modules (engine-artifacts.ts / engine-report.ts /
 * engine-world.ts / engine-settlement.ts), touching private state through engine-state.ts's
 * {@link EngineState} seam; this class keeps thin delegates only (split at the oxlint max-lines
 * cap of 400). The two birth-phase stamping helpers (events and ProviderStop) are pure functions
 * in engine-phase-stamp.ts, reading only this class's `instancePhases` table.
 */

import { ImportedWorldQueue, matchImportedActor } from "./imported-cache.js";
import type { ArtifactContentOp, ArtifactPresetOp } from "../facade/registry.js";
import { AskScheduler, type SchedulerHost } from "./scheduler.js";
import type { ArtifactIdState, EngineState, ReportTally, RunSettlement } from "./engine-state.js";
import { declarePresetArtifact, publishContentArtifact } from "./engine-artifacts.js";
import { publishReport } from "./engine-report.js";
import { closeImportCache, readWorld, recoverImportClosure } from "./engine-world.js";
import { ReplaySettleOrder } from "./replay-order.js";
import { restoreFromJournal } from "./engine-resume.js";
import { settleCompleted, settleFailed, settleStopped } from "./engine-settlement.js";
import type { EngineConfig } from "./engine-config.js";
import {
  HoleRegistry,
  fillHole as fillHoleBody,
  reachHole,
  type FilledHole,
  type FillHoleResult,
  type HoleFill,
  type OpenHole,
} from "./engine-holes.js";
import type {
  ActorId,
  ArtifactRef,
  AskProgress,
  AskSpec,
  AskStats,
  AskWaitInfo,
  Caps,
  ConcurrencyChange,
  ImportedRunCache,
  InstanceRef,
  JournalStorePort,
  PersonaSpec,
  RunEvent,
  RunStallInfo,
  RunStatus,
  RunStopReason,
  ValidateFn,
  WorkflowDriver,
  WorkflowHostApi,
  WorkflowReportSink,
  WorldReadOp,
} from "./types.js";
import { refToString, WorkflowError } from "./types.js";
import { normalizePersona } from "./persona.js";
import { runLaunchedEvent } from "./engine-launch.js";
import { enrichProviderStopPhase, stampBirthPhase } from "./engine-phase-stamp.js";

/** Engine construction config (defined in engine-config.ts; re-exported here). */
export type { EngineConfig } from "./engine-config.js";

/** The run's final settlement (defined on the settlement seam in engine-state.ts; re-exported here). */
export type { RunSettlement } from "./engine-state.js";

interface SettledDeferred {
  promise: Promise<RunSettlement>;
  resolve: (value: RunSettlement) => void;
}

export class WorkflowEngine implements WorkflowHostApi, WorkflowReportSink {
  private readonly runId: string;
  private readonly driver: WorkflowDriver;
  private readonly journal: JournalStorePort;
  /**
   * This run's concurrency cap. **Mutable** (see {@link setMaxConcurrency}): a
   * max_concurrency-only amendment applies in place to the living run. Replaced whole, not
   * field-patched - copies already recorded in events and journal must stay as recorded (the
   * caller's object is likewise never written back).
   */
  private caps: Caps;
  /**
   * Per-ask-site static specs. **Mutable** (see {@link fillHole}): a fill swaps in the valid
   * script's table (a superset). Replaced whole, same discipline as caps.
   */
  private askSpecs: ReadonlyMap<string, AskSpec>;
  private readonly validate: ValidateFn;
  private readonly scheduler: AskScheduler;

  /** Per-site ordinal counters (ask / world-read / actor share them; site ids never collide). */
  private readonly ordinals = new Map<string, number>();
  /**
   * Phase entry counts, by name. **Deliberately not** the `ordinals` table: phase names are
   * arbitrary author strings, and a phase literally named `report#1` must not shift that
   * site's node ordinal (site-id stability), nor vice versa.
   */
  private readonly phaseOrdinals = new Map<string, number>();
  /**
   * Phase name control flow currently sits in (`enterPhase` maintains; undefined before the
   * first marker). Read only at mint - see {@link nextOrdinal}.
   */
  private currentPhase: string | undefined;
  /** Site -> lexical birth phase (see {@link EngineConfig.sitePhases}). Mutable; swapped like `askSpecs`. */
  private sitePhases: ReadonlyMap<string, string>;
  /** Parked holes and this life's fill memory (engine-holes.ts). */
  private readonly holes: HoleRegistry;
  /**
   * Instance (`siteId@ordinal`) -> its **birth-time** phase name. Written at mint, read in
   * {@link record}'s stamping funnel: the static causality graph copies sites per phase, so
   * runtime instances must carry the same coordinate, or one lane's instance is claimed by every
   * phase copy of that site (this bug's shape: 5 phases x 20 subagents, five cards x 100 each).
   */
  private readonly instancePhases = new Map<string, string>();

  /**
   * Claimed **non-empty valid actor names** in this run -> the claiming actor (failure messages
   * point at the first occurrence). See {@link createActor}'s dedup / replay notes.
   */
  private readonly actorNames = new Map<string, string>();

  /** The amend-resume import cache (plain data; absent = not an amend-resume). */
  private readonly importedCache?: ImportedRunCache;
  /** Consumption cursor of the world import queue (nth occurrence to nth entry). */
  private readonly importedWorld: ImportedWorldQueue;
  /**
   * Whether the import cache is **closed**: true from the first write, never reopened - a live
   * subagent is about to run a mutating tool (driver-reported askMutating) or a world.run
   * executes live. Once closed, world nodes and tool-bearing asks stop consulting the table
   * (hashes compare text; they cannot see workspace rewrites); pure asks (toolCalls 0) still hit.
   * Restored on resume from `import-cache-closed`; see {@link recoverImportClosure}.
   */
  private importClosed = false;
  /**
   * The replay settle-order gate
   * (docs/execution-engine.md "Replaying the settle order"): cache-hit settlements release in the
   * journal's **first-born settlement order**, not admission order - every post-join site ordinal
   * derives from it. Empty (everyone passes) outside resume.
   */
  private replaySettleOrder = ReplaySettleOrder.empty();
  /** Ask instances live before the crash, recovered from events on resume (`siteId@ordinal`); empty otherwise. */
  private liveAskInstances: ReadonlySet<string> = new Set();
  /** Instances whose admission preceded the gate close, recovered from event order; restores the in-flight-ask test. */
  private queuedBeforeImportClose: ReadonlySet<string> = new Set();

  /**
   * Published report count and item bytes of this run (counters for REPORT_CAPS' two run-level
   * caps). Recovered on resume from the journal's kind:"report" rows - run-level caps must count
   * continuously across resumes, else a repeatedly resumed run reports forever.
   */
  private reportTally: ReportTally = { count: 0, bytes: 0 };
  /**
   * Per-**user-facing-artifact**-id state. Recovered like `reportTally`: rebuilt on resume from
   * the journal's kind:"artifact" rows, in-memory after - the caps (32 ids / 16 versions per id)
   * and version numbers are run-level facts, continuous across resumes, else a repeatedly resumed
   * run publishes forever.
   *
   * ⚠ artifact = user-facing artifact, not `RunSettlement.artifact` (the top-level return).
   */
  private readonly artifacts = new Map<string, ArtifactIdState>();
  /** Cumulative token usage (observation: bookkeeping + broadcast only, never fails a run). */
  private spentTokens = 0;
  private runSettled = false;
  private runFailure?: WorkflowError;

  private readonly settledDeferred: SettledDeferred;
  /** Seam for sibling free-functions to touch private state (arrow-closure wired in the constructor; engine-state.ts). */
  private readonly state: EngineState;

  constructor(config: EngineConfig) {
    this.runId = config.runId;
    this.driver = config.driver;
    this.journal = config.driver.journal;
    // Keep our own copy: the caller's (harness / run service) object must survive a retune unwritten.
    this.caps = { maxConcurrency: config.caps.maxConcurrency };
    this.askSpecs = config.askSpecs;
    this.validate = config.validate;
    this.sitePhases = config.sitePhases ?? new Map();
    this.holes = new HoleRegistry(config.now ?? Date.now);
    this.importedCache = config.importedCache;
    this.importedWorld = new ImportedWorldQueue(config.importedCache?.world ?? new Map());

    let resolve!: (value: RunSettlement) => void;
    const promise = new Promise<RunSettlement>((res) => {
      resolve = res;
    });
    this.settledDeferred = { promise, resolve };

    this.state = {
      runId: this.runId,
      driver: this.driver,
      journal: this.journal,
      artifacts: this.artifacts,
      importedCache: this.importedCache,
      importedWorld: this.importedWorld,
      isRunSettled: () => this.runSettled,
      runError: () => this.runError(),
      failRun: (error) => this.failRun(error),
      record: (event) => this.record(event),
      nextOrdinal: (siteId) => this.nextOrdinal(siteId),
      holdForReplay: (instance, release) => {
        this.replaySettleOrder.hold(instance, release);
      },
      reportTally: () => this.reportTally,
      countReport: (bytes) => {
        this.reportTally = {
          count: this.reportTally.count + 1,
          bytes: this.reportTally.bytes + bytes,
        };
      },
      importClosed: () => this.importClosed,
      closeImport: () => {
        this.importClosed = true;
      },
      markSettled: (failure) => {
        this.runSettled = true;
        if (failure !== undefined) this.runFailure = failure;
        // The gate opens permanently at settlement: release actions still on the order table are
        // dropped, else the script side's promises never resolve (the sandbox shuts down, but the
        // same-process rig running the script would hang).
        this.replaySettleOrder.open();
      },
      abortInFlight: (error, emitCancelled) => {
        this.scheduler.abortInFlight(error, emitCancelled);
        // Branches parked at holes share the in-flight asks' single rejection: nothing fills them post-settlement.
        this.holes.rejectAll(error);
      },
      resolveSettled: (settlement) => this.settledDeferred.resolve(settlement),
    };

    // caps are read live by the scheduler: setMaxConcurrency swaps this.caps whole, and the
    // dispatch test must see the new value (see SchedulerHost.caps). Arrow closure, not an
    // object literal's this - the latter is the literal itself.
    const readCaps = (): Caps => this.caps;

    const host: SchedulerHost = {
      runId: this.runId,
      get caps(): Caps {
        return readCaps();
      },
      driver: this.driver,
      validate: this.validate,
      nextOrdinal: (siteId) => this.nextOrdinal(siteId),
      holdForReplay: (instance, release) => {
        this.replaySettleOrder.hold(instance, release);
      },
      record: (event) => this.record(event),
      isRunSettled: () => this.runSettled,
      runError: () => this.runError(),
      failRun: (error) => this.failRun(error),
      importCacheClosed: () => this.importClosed,
      wasLiveBeforeResume: (instance) => this.liveAskInstances.has(refToString(instance)),
      wasQueuedBeforeImportClose: (instance) =>
        this.queuedBeforeImportClose.has(refToString(instance)),
    };
    this.scheduler = new AskScheduler(host);

    const existing = this.journal.getRun(this.runId);
    // Metadata lands once, at createRun; the script and session fields are kept for recovery and
    // script_hash checks. name is later-arriving display metadata on the same path. Absent keys stay
    // absent (never undefined-valued).
    // Args ride the same metadata path as scriptText, written once at createRun: resume reads
    // them back for replay and never accepts caller-supplied new args.
    if (existing === undefined) {
      // Amended runs start from the predecessor's cumulative total; fresh runs absent = 0.
      // Normalization (non-finite/negative as absent, floors fractions) happens right here: the
      // number lands in the spent_tokens column and the protocol schema wants a non-negative
      // integer, while it is plain data past the harness - one NaN poisons column and projection
      // patch alike, so dirty values die before the write, not in the patch validation.
      const inherited = config.inheritedTokens ?? 0;
      this.spentTokens = Number.isFinite(inherited) ? Math.max(0, Math.floor(inherited)) : 0;
      this.journal.createRun({
        runId: this.runId,
        caps: this.caps,
        spentTokens: this.spentTokens,
        status: "running",
        // Metadata lands once, at createRun; script and session fields kept for recovery and
        // script_hash checks. name is later-arriving display metadata on the same path. Absent
        // keys stay absent (never undefined-valued).
        ...(config.scriptText === undefined ? {} : { scriptText: config.scriptText }),
        // Args ride the same metadata path as scriptText, written once at createRun: resume
        // replays these and never accepts caller-supplied new args.
        ...(config.args === undefined ? {} : { args: config.args }),
        ...(config.name === undefined ? {} : { name: config.name }),
        ...(config.scriptHash === undefined ? {} : { scriptHash: config.scriptHash }),
        ...(config.parentSessionId === undefined
          ? {}
          : { parentSessionId: config.parentSessionId }),
        ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
        ...(config.toolCallId === undefined ? {} : { toolCallId: config.toolCallId }),
        // lineage is written once at createRun: amendment is supersede (a new run); the
        // predecessor row is untouched.
        ...(config.resumedFrom === undefined ? {} : { resumedFrom: config.resumedFrom }),
      });
    } else {
      // Resume precondition: the script must equal createRun's byte for byte. A hash mismatch
      // means the caller reused the runId for a different script - site ids are journal keys;
      // continuing would match the new script's sites to the old results. Refuse this resume
      // (throw) rather than accept-then-failRun: that stamps failed over a record still
      // resumable with the right script.
      if (
        existing.scriptHash !== undefined &&
        config.scriptHash !== undefined &&
        existing.scriptHash !== config.scriptHash
      ) {
        throw new WorkflowError(
          "ScriptHashMismatch",
          `Cannot resume run ${this.runId}: its script changed (recorded hash ${existing.scriptHash}, ` +
            `got ${config.scriptHash}). Resume needs the byte-identical script; to run a revised ` +
            `script, start a new run with resume_from instead.`,
          { mismatch: { expected: existing.scriptHash, got: config.scriptHash } },
        );
      }
      // resume: order gate, per-actor ask counts, report counters, artifact state - from the journal (engine-resume.ts).
      ({ replaySettleOrder: this.replaySettleOrder, reportTally: this.reportTally } =
        restoreFromJournal(this.state, this.scheduler));
      // Usage recovers from the record (continuous across lifecycles).
      this.spentTokens = existing.spentTokens;
      // Amended-run crash recovery: the import table rebuilds wholesale, but gate-closed-ness
      // is not stored - recover it exactly from events.
      if (this.importedCache !== undefined) {
        const recovered = recoverImportClosure(this.journal, this.runId);
        this.liveAskInstances = recovered.live;
        this.queuedBeforeImportClose = recovered.queuedBeforeClose;
        this.importClosed = recovered.closed;
      }
      this.journal.updateRunStatus(this.runId, "running");
    }
    this.record({ type: "run-started", runId: this.runId, caps: this.caps });
    if (existing === undefined && config.launch !== undefined) {
      this.record(runLaunchedEvent(config.launch, config));
    }
    // noise every fresh run pays: the reset already said zero; another event is noise every
    // fresh run pays.
    if (this.spentTokens > 0) this.record({ type: "usage-updated", spentTokens: this.spentTokens });
  }

  /** Run settlement promise; resolves on complete/fail/cancel. */
  get settled(): Promise<RunSettlement> {
    return this.settledDeferred.promise;
  }

  /** Current run state. */
  status(): RunStatus {
    return this.journal.getRun(this.runId)?.status ?? "running";
  }

  // ——————————————————————————————— Boundary A ———————————————————————————————

  /**
   * Create one actor. The **effective name** is spec.name after normalizePersona (persona.name
   * beats the name argument); non-empty must be unique in this run - duplicates fail the run
   * loudly (DuplicateActorName).
   *
   * Why run-level failure, not rename/warn: named actors are the amend-resume cache-import
   * identity keys, and any run is a potential future amendment's predecessor; duplicates there
   * make import matching ambiguous. The rule binds all runs, not just amended ones. Anonymous
   * (absent/empty) never checks; any number legal - the ruled tradeoff: no cache eligibility.
   *
   * **Replay safety**: the dedup table is purely in-memory, born with the engine instance. A
   * resume of a byte-identical script reruns the same createActor sequence in a **brand-new**
   * engine, so each name registers exactly once - no self-collision with the previous life. Also
   * why it cannot be journaled: a stored table would collide with itself on resume.
   *
   * **Import-cache attach happens here too** (amend-resume): look up the effective name in
   * importedCache.actors; attach the candidate to the scheduler's actor state once the normalized
   * persona matches. Comparing at runtime, not statically diffing two scripts at submit: name and
   * persona are runtime values (agent() args may be dynamic); a static diff is a second source of
   * truth, what this package avoids everywhere (imported-cache.ts's matchImportedActor).
   */
  createActor(siteId: string, name?: string, persona?: string | PersonaSpec): ActorId {
    this.assertRunning("createActor");
    const ordinal = this.nextOrdinal(siteId);
    const ref = { siteId, ordinal };
    const id = refToString(ref);
    const spec = normalizePersona(name, persona);
    const effectiveName = spec.name;
    if (effectiveName !== undefined && effectiveName !== "") {
      const claimed = this.actorNames.get(effectiveName);
      if (claimed !== undefined) {
        const err = new WorkflowError(
          "DuplicateActorName",
          `Subagent name "${effectiveName}" is used twice in this run (${claimed} and ${id}). ` +
            `A named subagent is the identity an amended re-run matches its cache by, so names must ` +
            `be unique; give this one its own name or drop the name to make it anonymous.`,
        );
        this.failRun(err);
        throw err;
      }
      this.actorNames.set(effectiveName, id);
      // compile artifacts stitched). A `?? { typed: false }` fallback would silently downgrade a
      // typed ask to untyped: no submit_result registered, last-turn text as result, schema
      // validation gone - a type system degraded to "always valid" is worse than none, so fail
      // the run loudly instead.
      this.actorNames.set(effectiveName, id);
    }
    this.scheduler.registerActor(ref, id, name, spec, matchImportedActor(this.importedCache, spec));
    // putActor replaces the record whole, while sessionId / resolvedModel are driver-owned
    // (ensureSession writes the former, the host-side runtime factory the latter). Carry the
    // existing values through, or a replay hit on the same (siteId, ordinal) wipes them empty.
    const existing = this.journal.getActor(this.runId, siteId, ordinal);
    this.journal.putActor({
      siteId,
      runId: this.runId,
      ordinal,
      name,
      persona: spec,
      sessionId: existing?.sessionId,
      resolvedModel: existing?.resolvedModel,
    });
    this.record({ type: "actor-created", actor: ref, name, persona: spec });
    return id;
  }

  ask(siteId: string, actorId: ActorId, instructions: string): Promise<unknown> {
    if (this.runSettled) return Promise.reject(this.runError());
    if (!this.scheduler.hasActor(actorId)) {
      // Unknown actor: the script/lowering contract broke; fail the run loudly.
      const err = new WorkflowError("UnknownActor", `Unknown subagent handle: ${actorId}.`);
      this.failRun(err);
      return Promise.reject(err);
    }
    const spec = this.askSpecs.get(siteId);
    if (spec === undefined) {
      // Site table and schema synth come from one compilation, so a miss is a wiring bug (two
      // artifacts stitched). A ?? { typed: false } fallback would silently downgrade a typed ask:
      // no submit_result, last-turn text as result, validation gone - a type system degraded to
      // always-valid is worse than none; fail the run loudly instead.
      const err = new WorkflowError(
        "MissingAskSpec",
        `Ask site ${siteId} has no spec: askSpecs is incomplete (compile output mismatch).`,
      );
      this.failRun(err);
      return Promise.reject(err);
    }
    return this.scheduler.admitAsk(siteId, actorId, instructions, spec);
  }

  /** World nodes (world-read / world-run): body in engine-world.ts's readWorld. */
  worldRead(siteId: string, op: WorldReadOp, args: unknown[]): Promise<unknown> {
    return readWorld(this.state, siteId, op, args);
  }

  log(message: string): void {
    if (this.runSettled) return;
    this.record({ type: "log", message });
  }

  /**
   * Control flow passed a phase("...") marker (Boundary A's enterPhase). log's posture: sync, no
   * return, no-op after settlement, no journal row - a marker is not a site; no dwf_node exists.
   *
   * Ordinals count per name in their own table (phaseOrdinals): phase names and site ids never
   * consume each other's sequences (site-id stability).
   * Emitted on every evaluation: round two of for { phase("B"); ask } is B's second entry; a
   * same-as-current skip loses single-phase loops. Resume re-emits the prefix - deliberately
   * not deduped (that needs reading events); reducers fold via rounds = max(rounds, ordinal).
   */
  enterPhase(name: string): void {
    if (this.runSettled) return;
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    const ordinal = (this.phaseOrdinals.get(trimmed) ?? 0) + 1;
    this.phaseOrdinals.set(trimmed, ordinal);
    // Instances minted hereafter are born in this phase.
    this.currentPhase = trimmed;
    this.record({ type: "phase-entered", name: trimmed, ordinal });
  }

  /** The script reached an unfilled hole (Boundary A's hole): body in engine-holes.ts's reachHole. */
  hole(siteId: string, name: string, prompt?: string): Promise<{ code: string }> {
    return reachHole(this.state, this.holes, siteId, name, prompt);
  }

  /**
   * The main agent fills one hole (docs/execution-engine.md "The engine's part"): one sync step
   * swapping the spec and phase tables, writing back the valid script, recording hole-filled,
   * remembering the code, releasing every parked branch. Body: engine-holes.ts's fillHole; the
   * two no-ops (not_waiting / settled) write and emit nothing.
   */
  fillHole(fill: HoleFill): FillHoleResult {
    return fillHoleBody(this.state, this.holes, fill, (askSpecs, sitePhases) => {
      this.askSpecs = askSpecs;
      this.sitePhases = sitePhases;
    });
  }

  /** Holes still waiting (snapshot: ask the engine beyond events; after a process death no promise waits). */
  openHoles(): OpenHole[] {
    return this.holes.open();
  }

  /** Holes filled this life. */
  filledHoles(): FilledHole[] {
    return this.holes.filledList();
  }

  /** Publish one intermediate result (Boundary A's report): body in engine-report.ts's publishReport. */
  report(siteId: string, item: unknown, artifactId?: string): void {
    publishReport(this.state, siteId, item, artifactId);
  }

  /**
   * Publish a content artifact (artifact.file / artifact.markdown): body in
   * engine-artifacts.ts's publishContentArtifact.
   */
  publishArtifact(siteId: string, op: ArtifactContentOp, args: unknown[]): Promise<ArtifactRef> {
    return publishContentArtifact(this.state, siteId, op, args);
  }

  /**
   * Declare a preset artifact (artifact.chart / table / metrics / board): body in
   * engine-artifacts.ts's declarePresetArtifact.
   */
  declareArtifact(siteId: string, op: ArtifactPresetOp, args: unknown[]): void {
    declarePresetArtifact(this.state, siteId, op, args);
  }

  // ———————— externally driven run lifecycle ————————

  /** The sandbox script returned the top-level artifact; settle completed: engine-settlement.ts's settleCompleted. */

  complete(artifact: unknown): void {
    settleCompleted(this.state, artifact);
  }
  /**
   * External stop: abort in-flight asks (deferreds reject Cancelled, node-settled(cancelled)
   * emitted), settle stopped(reason); settled journal rows remain (resumable). One path for all
   * four reasons: user / model (cancel entry's initiator), interrupted (harness sandbox failure),
   * provider (deterministic model-side error via driver stopRun). error only on the last two.
   * First-wins once settled. Body: engine-settlement.ts settleStopped.
   */
  stop(reason: RunStopReason, error?: WorkflowError, supersededBy?: string): void {
    settleStopped(this.state, reason, error, supersededBy);
  }

  /**
   * External failure: complete's failure dual. The harness classifies child
   * {complete, ok:false, error} (script throw), child crashes, wall-clock timeouts, NDJSON parse
   * failures and the like as run failures, not disguised cancels - else journal failure and the
   * caller's view diverge. Internal failRun path: first-wins (vs complete/cancel/internal),
   * driver-side abort of in-flight asks, journal failed + failure_json, a run-failure event,
   * settled failed.
   */
  fail(error: WorkflowError): void {
    this.failRun(error);
  }

  /**
   * Change this run's OWN concurrency cap in place
   * (docs/dynamic-workflow/concurrency.md "Two bounds on a run"). A max_concurrency-only
   * amendment on the living run: same runId, no successor, no supersede, not one in-flight ask
   * lost - the whole difference from AmendWorkflow, and the only reason this exists.
   *
   * Returns whether anything changed. Both no-ops return false, no write, no event: already
   * settled (host liveness race - callers fall back to a real amend), or equal value.
   * (cont)
    //
    // Post-settlement straggler stats (a real actor's usage is known only at turn resolution; the
    // last ask's stats often arrive after complete/cancel) must not emit events - they would land
    // after run-settled, which downstream projections do not expect (run-settled must be the
    // stream's last). After settlement: bookkeeping only (the usage row and noteStats' node
    // backfill are journal row updates, not events). The books still balance: a resumable run's
    // usage is continuous across lifecycles.
   * Clamping to [1, ceiling] is the caller's job - the ceiling is host fact (machine parallelism),
   * invisible to the engine. Storage normalization only here, the constructor inheritedTokens
   * discipline: the number lands in caps_max_concurrency (integer not null).
   */
  setMaxConcurrency(maxConcurrency: number): boolean {
    if (this.runSettled) return false;
    if (!Number.isFinite(maxConcurrency)) return false;
    const previous = this.caps;
    const next = Math.max(1, Math.floor(maxConcurrency));
    if (next === previous.maxConcurrency) return false;
    const caps: Caps = { maxConcurrency: next };
    this.caps = caps;
    this.journal.updateRunCaps(this.runId, caps);
    this.record({ type: "run-caps-changed", runId: this.runId, caps, previous });
    if (next > previous.maxConcurrency) this.scheduler.pumpAll();
    return true;
  }

  // —————————— Boundary B (upward reports) ——————————
  askSubmitAttempted(instance: InstanceRef, payload: unknown): void {
    this.scheduler.submitAttempted(instance, payload);
  }

  // The adaptive-concurrency pure observations: the engine only records,
  // deciding nothing from them. Calls after the run / node settled are ignored - late
  // observations; journaling them would grow a settled run a tail.

  askTurnEnded(instance: InstanceRef, finalText: string): void {
    this.scheduler.turnEnded(instance, finalText);
  }

  /**
   * In-ask progress observation: pure passthrough,
   * askStats -> usage-updated's posture - no scheduling change, not in inputHash, untested by
   * replay. Like usage, post-settlement stragglers drop only the event (no ledger here), never
   * growing the settled run a tail.
   */
  askProgress(instance: InstanceRef, progress: AskProgress): void {
    if (this.runSettled) return;
    this.record({ type: "node-progress", instance, ...progress });
  }

  askStats(instance: InstanceRef, stats: AskStats): void {
    this.scheduler.noteStats(instance, stats);
    this.spentTokens += stats.tokens;
    // Usage cannot be written once at createRun(0): without write-back resume restores zero.
    // Persist right after accumulating, before the event - payload and column are produced in the
    // same synchronous step and never diverge.
    this.journal.updateRunUsage(this.runId, this.spentTokens);
    // Post-settlement stragglers (real actor usage known only at turn resolution; the last ask's
    // stats often land after complete/cancel) must not emit - events after run-settled are
    // unexpected (it must be the stream's last). Bookkeeping only (the usage row and noteStats
    // node backfill are journal row updates, not events). Books still balance: a resumable run's
    // usage is continuous across lifecycles.
    if (this.runSettled) return;
    this.record({ type: "usage-updated", spentTokens: this.spentTokens });
  }

  askFailed(instance: InstanceRef, error: WorkflowError): void {
    this.scheduler.failed(instance, error);
  }

  /**
   * A deterministic model-side error: no node settlement; the whole run stops as
   * stopped(provider). Post-settlement calls are ignored by stop's first-wins.
   */
  stopRun(error: WorkflowError): void {
    this.stop("provider", enrichProviderStopPhase(error, this.instancePhases));
  }

  /** Run-level stall observation: record only; ignored once settled. */
  /** Run-level stall observation: record only; ignored once the run settled. */
  runStalled(info: RunStallInfo): void {
    if (this.runSettled) return;
    this.record({ type: "run-stalled", ...info });
  }

  // The adaptive-concurrency pure observations: record only, no decisions from them.
  // Post run/node-settlement calls are ignored - late observations; journaling grows a tail.
  askWaiting(instance: InstanceRef, info: AskWaitInfo): void {
    if (this.runSettled || !this.scheduler.isLive(instance)) return;
    this.record({ type: "node-waiting", instance, ...info });
  }
  askExecuting(instance: InstanceRef): void {
    if (this.runSettled || !this.scheduler.isLive(instance)) return;
    this.record({ type: "node-executing", instance });
  }

  /**
   * The one driver observation the engine decides from: an in-flight ask's subagent is about to
   * mutate the workspace => close the import cache. Late ones (run/node settled) ignored, as above.
   */
  askMutating(instance: InstanceRef): void {
    if (this.runSettled || !this.scheduler.isLive(instance)) return;
    closeImportCache(this.state, instance, "mutating-tool", this.scheduler.liveActorName(instance));
  }

  concurrencyChanged(change: ConcurrencyChange): void {
    if (this.runSettled) return;
    this.record({ type: "concurrency-changed", ...change });
  }

  // —————————————— internal ——————————————

  /** Run-level failure (first-wins): body in engine-settlement.ts's settleFailed. */
  private failRun(error: WorkflowError): void {
    settleFailed(this.state, error);
  }

  /**
   * The sole mint of site ordinals (createActor / admitAsk's first line / worldRead / report /
   * artifact all sync here), hence also the only recorder of a birth phase: this line runs in
   * the script call's tick; events may not - node-queued can be deferred past the next marker.
   */
  private nextOrdinal(siteId: string): number {
    const next = (this.ordinals.get(siteId) ?? 0) + 1;
    this.ordinals.set(siteId, next);
    // Lexical first, dynamic fallback: two concurrent futures with their own markers make
    // latest-marker timing's call; the compile-time table's phase is what the graph shows.
    const phase = this.sitePhases.get(siteId) ?? this.currentPhase;
    if (phase !== undefined) this.instancePhases.set(refToString({ siteId, ordinal: next }), phase);
    return next;
  }

  private assertRunning(op: string): void {
    if (this.runSettled)
      throw (
        this.runFailure ??
        new WorkflowError("Cancelled", `Run already settled; ${op} is no longer accepted.`)
      );
  }

  private runError(): WorkflowError {
    return this.runFailure ?? new WorkflowError("Cancelled", "Run already settled.");
  }

  /**
   * Every event lands in the journal (dwf_event, durable) and fans out via driver.emit (Boundary
   * C, live).
   *
   * The sole funnel of all events; birth phase is stamped here (stampBirthPhase). Both routes
   * must receive the same object: bootstrap's createJournalSequenceCapture checks sequence
   * identity by reference.
   */
  private record(event: RunEvent): void {
    const stamped = stampBirthPhase(event, this.instancePhases);
    this.journal.appendEvent(this.runId, stamped);
    this.driver.emit(stamped);
  }
}
