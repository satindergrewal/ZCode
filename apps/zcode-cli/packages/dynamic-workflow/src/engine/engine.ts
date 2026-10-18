/**
  * The execution engine deterministic state machine (Boundary A impl + driving Boundary B + the upward sink).
 *
  * The core does no IO, reads no clock, uses no randomness: time/scheduling-dependent decisions are either journaled or
  * pinned by deterministic rules (per-site ordinal + per-actor FIFO actorSeq), so first run and replay agree verbatim.
 *
  * Key invariants:
  * - Instance identity = site id x per-site ordinal (the nth of ask3 is ask3 at n). Actor identity = creation site x ordinal.
  * - Journaled decisions: every host call looks up (siteId, ordinal); a hit short-circuits (no driver call) and defensively
  *   validates the inputHash -- mismatch fails the whole run loudly (structured error, never a silent drift).
  * - Per-actor FIFO + actorSeq admission order + the replay hold rule: see scheduler.ts (ask lifetimes are delegated there).
 *
  * This file owns the run lifecycle: host API entries, usage accounting, run settlement and event recording. User-facing artifacts, report,
  * world nodes + import cache, and the three terminal paths live in siblings (engine-artifacts.ts / engine-report.ts /
  * engine-world.ts / engine-settlement.ts), reading/writing private state here via the EngineState seam in engine-state.ts;
  * this class keeps thin delegates (the 400-line cap). The two birth-phase stampers (events and ProviderStop) are pure
  * functions in engine-phase-stamp.ts, reading only the instancePhases table this class owns.
  * the instancePhases table.
 */

import { ImportedWorldQueue, matchImportedActor } from "./imported-cache.js";
import type { ArtifactContentOp, ArtifactPresetOp } from "../facade/registry.js";
import { AskScheduler, type SchedulerHost } from "./scheduler.js";
import type { ArtifactIdState, EngineState, RunSettlement } from "./engine-state.js";
import {
  declarePresetArtifact,
  publishContentArtifact,
  rememberArtifactRow,
} from "./engine-artifacts.js";
import { publishReport } from "./engine-report.js";
import { closeImportCache, readWorld, recoverImportClosure } from "./engine-world.js";
import { recoverSettleOrder, ReplaySettleOrder } from "./replay-order.js";
import { settleCompleted, settleFailed, settleStopped } from "./engine-settlement.js";
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
import { runLaunchedEvent, type RunLaunchConfig } from "./engine-launch.js";
import { enrichProviderStopPhase, stampBirthPhase } from "./engine-phase-stamp.js";

/** Engine construction config. */
export interface EngineConfig {
  runId: string;
  driver: WorkflowDriver;
  caps: Caps;
  /**
      * Per-ask-site static spec (typed + schema). **Must cover every ask site in the script** -- table and schema synthesis
      * come from one compilation, so absence is a wiring bug and the engine hard-fails
      * (MissingAskSpec). Untyped sites are recorded explicitly as not-typed.
   */
  askSpecs: ReadonlyMap<string, AskSpec>;
    /** The injected schema validator (the core imports no schema implementation). */
  validate: ValidateFn;
    /** Run metadata (into dwf_run; written only at createRun, never overwritten on resume). */
  scriptText?: string;
  /**
      * The run display name (the optional CreateWorkflow name). Unread by the engine; persisted with the
      * script at createRun -- the host enumeration labels runs from it. See RunRecord name.
   */
  name?: string;
  /**
      * Hash of the script text. Compared at resume against the journal value: both present and different rejects the resume
      * (V1 resume is valid only for byte-identical scripts).
   */
  scriptHash?: string;
  /**
      * This run args (validated backfill). Unread by the engine; persisted with the script at createRun;
      * sandbox injection travels the harness spawn payload, not the engine. See RunRecord args.
   */
  args?: Record<string, unknown>;
  parentSessionId?: string;
  cwd?: string;
  /**
      * The CreateWorkflow tool-call id that launched the run (see RunRecord toolCallId).
      * Unread by the engine; persisted with the rest of the metadata at createRun.
   */
  toolCallId?: string;
  /**
      * The predecessor run this one amends (see RunRecord resumedFrom). Unread by the engine;
      * persisted with the rest at createRun -- import-cache building lives in the run service, not the core.
   */
  resumedFrom?: string;
  /**
      * The anchor of the launching turn. Unread by the engine; recorded once as run-launched right after the first
      * run-started, in the birth epoch only (the anchor is unique per lifetime; a resume hit re-records nothing).
      * phaseNames rides along: the script-declared phase table, also unread, journal only. phaseAlongside
      * is position-aligned with it (indices into the same table), same ride, same rule.
      * subagentModel likewise: this run subagent choice (canonical picker string), unread -- the whole model face
      * is host-side; the host reads it back from this event, zero SQL.
      * scriptPath, same ride: which file the script came from (absolute); unread, read back by the host for the model face.
    * read it back for the model face.
   */
  launch?: RunLaunchConfig;
  /**
      * Usage baseline: the predecessor spentTokens. Present on amend; absent on fresh submit (accounting from zero);
      * ignored on resume -- a hit restores usage from the row.
   *
      * Semantics: this run reports the whole-lineage spend -- each predecessor number is already cumulative, so chained
      * amendments sum by construction and nobody walks the resumed-from chain. A cache hit adds nothing (that cost is in
      * the inherited value); only live turns of this epoch add.
   */
  inheritedTokens?: number;
  /**
      * The amend-resume import cache (ImportedRunCache). **Pure data injection** -- the core stays a
      * zero-IO deterministic machine: reading the predecessor journal, walking resumed-from, resolving transcript sources all happen
      * in the run service; the engine gets a built table and matches by runtime identity (actor name + persona,
      * op+args content + occurrence order). Absent: not an amended resume.
   */
  importedCache?: ImportedRunCache;
}

/* The run final settlement (defined with the settlement seam in engine-state.ts; re-exported here). */
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
      * This run concurrency cap. **Mutable** (see setMaxConcurrency): a max-concurrency-only amendment lands in place on a living run.
      // Replaced wholesale, never field-edited -- the caps already recorded into events/journal
      // must stay as recorded (the caller-passed object is likewise never written back).
   */
  private caps: Caps;
  private readonly askSpecs: ReadonlyMap<string, AskSpec>;
  private readonly validate: ValidateFn;
  private readonly scheduler: AskScheduler;

    /* Per-site ordinal counters (ask / world-read / actor share them; site ids are distinct). */
  private readonly ordinals = new Map<string, number>();
  /**
      * Phase entry counts, by name. A table of its own, not shared with ordinals: phase names are arbitrary author strings, and a phase
      * literally named report#1 must not shift that site node ordinals (site-id stability), nor the reverse.
    * site node ordinals (site-id stability), nor the reverse.
   */
  private readonly phaseOrdinals = new Map<string, number>();
  /**
      * The phase control flow is in (maintained by enterPhase; undefined before the first marker). Read only at the mint --
      * see nextOrdinal.
   */
  private currentPhase: string | undefined;
  /**
      * Instance (site at ordinal) -> phase name **at birth**. Written at the mint, read in the record stamping funnel: the static causal graph copies sites per phase,
      * so runtime instances must carry the same coordinate, else one lane instance is claimed by every phase copy of that site
      * (this bug shape: five phases x 20 subagents, five cards each showing 100).
   */
  private readonly instancePhases = new Map<string, string>();

  /**
      * Claimed **non-empty effective actor names** in this run -> the claiming actor (to name the earlier one in failures).
      * See the duplicate check and replay-safety note in createActor.
   */
  private readonly actorNames = new Map<string, string>();

    /* The amend-resume import cache (pure data; absent = not an amended resume). */
  private readonly importedCache?: ImportedRunCache;
    /* Consumption cursor of the world import queues (nth occurrence vs nth record). */
  private readonly importedWorld: ImportedWorldQueue;
  /**
      * Whether the import cache has **closed**: set before the first write, never reopened
      * -- a live subagent about to run a mutating tool (driver-reported), or a world.run going live.
      * After closing, world nodes and tool-bearing asks stop consulting the cache (a hash compares text, not workspace state);
      * pure asks still hit. Restored on resume from the cache-closed event; see recoverImportClosure.
   */
  private importClosed = false;
  /**
      * The replay settlement-order gate: cache-hit settlements release in the journal recorded **first-born order**, not admission
      * order -- every post-join site ordinal follows it. Always the open gate outside resume.
    * follow that order; always the open gate outside resume.
   */
  private replaySettleOrder = ReplaySettleOrder.empty();
    /* Ask instances live before the crash, restored from events on resume; empty otherwise. */
  private liveAskInstances: ReadonlySet<string> = new Set();
    /* Ask instances admitted before the close, restored in event order; the resume-in-flight verdict rebuilds from it. */
  private queuedBeforeImportClose: ReadonlySet<string> = new Set();

  /**
      * Reports published in this run (the caps counter). Restored on resume from the kind-report row count -- the cap is
      * run-level and must count continuously across resumes, else a resume-happy run reports forever.
    * resume-happy run could report forever.
   */
  private reportCount = 0;
  /**
      * Per-user-facing-artifact id state. Same restoration as the report count: rebuilt on resume from kind-artifact rows,
      * then maintained in memory -- the caps (32 ids / 16 versions each) and version numbers are run-level facts,
      continuous across resumes, else a resume-happy run publishes forever.
    * resume-happy run could publish forever.
   *
      * ⚠ Terminology: artifact = the user-facing deliverable, not RunSettlement.artifact (the top-level return).
   */
  private readonly artifacts = new Map<string, ArtifactIdState>();
    /* Cumulative token usage (observability: accounting and broadcast only, never fails a run). */
  private spentTokens = 0;
  private runSettled = false;
  private runFailure?: WorkflowError;

  private readonly settledDeferred: SettledDeferred;
    /* The seam sibling free functions use for private state (assembled with arrow closures in the constructor; see engine-state.ts). */
  private readonly state: EngineState;

  constructor(config: EngineConfig) {
    this.runId = config.runId;
    this.driver = config.driver;
    this.journal = config.driver.journal;
        // Keep our own copy: the caller-held object must not be rewritten by a retune.
    this.caps = { maxConcurrency: config.caps.maxConcurrency };
    this.askSpecs = config.askSpecs;
    this.validate = config.validate;
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
      reportCount: () => this.reportCount,
      countReport: () => {
        this.reportCount++;
      },
      importClosed: () => this.importClosed,
      closeImport: () => {
        this.importClosed = true;
      },
      markSettled: (failure) => {
        this.runSettled = true;
        if (failure !== undefined) this.runFailure = failure;
                // The gate opens forever at settlement: release parked on the order table are dropped, else script-side promises
                // never settle (the sandbox gets torn down, but in-process runners hang).
        this.replaySettleOrder.open();
      },
      abortInFlight: (error, emitCancelled) => this.scheduler.abortInFlight(error, emitCancelled),
      resolveSettled: (settlement) => this.settledDeferred.resolve(settlement),
    };

        // caps are **read fresh** by the scheduler: setMaxConcurrency replaces this.caps wholesale and the dispatch test must see it
        // (see SchedulerHost caps). Arrow closures, not this inside an object literal -- that would be the literal itself.
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
    if (existing === undefined) {
            // An amendment starts from the predecessor cumulative value;
            // fresh runs default to 0. Normalization lives here exactly once (non-finite/negative as absent, floor fractions): this number
            // lands in the spent-tokens column, the protocol schema wants a non-negative integer, and it is pure data past the harness
            // boundary -- a NaN would poison column and projection patch alike, so dirty values die before the write.
      const inherited = config.inheritedTokens ?? 0;
      this.spentTokens = Number.isFinite(inherited) ? Math.max(0, Math.floor(inherited)) : 0;
      this.journal.createRun({
        runId: this.runId,
        caps: this.caps,
        spentTokens: this.spentTokens,
        status: "running",
                // Metadata persists once, at creation; keep the passed script and session fields for restore and the hash check.
                // The display name joined the same path later. Absent fields stay absent (never undefined-valued keys).
        ...(config.scriptText === undefined ? {} : { scriptText: config.scriptText }),
                // Args ride the same metadata path, written once at creation: resume reads them back
                // for replay and never accepts new caller args.
        ...(config.args === undefined ? {} : { args: config.args }),
        ...(config.name === undefined ? {} : { name: config.name }),
        ...(config.scriptHash === undefined ? {} : { scriptHash: config.scriptHash }),
        ...(config.parentSessionId === undefined
          ? {}
          : { parentSessionId: config.parentSessionId }),
        ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
        ...(config.toolCallId === undefined ? {} : { toolCallId: config.toolCallId }),
                // The lineage also writes once: amendment is supersede (a new run); the predecessor row is untouched.
        ...(config.resumedFrom === undefined ? {} : { resumedFrom: config.resumedFrom }),
      });
    } else {
            // Resume precondition: the script must be byte-identical to creation. A hash
            // mismatch means the caller reused the runId for another script -- site ids are journal keys; continuing
            // would pair the new script sites with the old results. Reject **this resume** (throw synchronously), not accept-then-fail:
            // the latter would stamp failed over a record still resumable with the right script.
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
            // Resume: settlement order restores from this run own events (this gate is replay correctness, not observability:
            // ordinals follow arrival order, and fan-out arrival order is reproducible only by the first-born settlement order). Node rows read once;
            // the report count and artifact restore below share them.
      const nodes = this.journal.listNodes(this.runId);
      this.replaySettleOrder = recoverSettleOrder(this.journal, this.runId, nodes);
            // The report count restores from kind-report row counts; usage from the record (continuous across lifetimes).
      this.reportCount = nodes.filter((n) => n.kind === "report").length;
            // Artifact state restores alongside: id claims (kind, preset spec) and version counts all derive from journal rows, so
            // after crash recovery version 3 is still version 3, never recounted from 1.
      for (const node of nodes) {
        if (node.kind !== "artifact" || node.status !== "completed") continue;
        rememberArtifactRow(this.state, node.artifactId, node.result);
      }
      this.spentTokens = existing.spentTokens;
            // Amended-run crash recovery: the cache table rebuilds wholesale, and gate-closed is not persisted -- restored exactly from events.
      if (this.importedCache !== undefined) {
        const recovered = recoverImportClosure(this.journal, this.runId);
        this.liveAskInstances = recovered.live;
        this.queuedBeforeImportClose = recovered.queuedBeforeClose;
        this.importClosed = recovered.closed;
      }
      this.journal.updateRunStatus(this.runId, "running");
    }
    this.record({ type: "run-started", runId: this.runId, caps: this.caps });
        // The anchor is recorded in the birth epoch only, after run-started: projections treat run-started as the creating entry,
        // the anchor merely raising the watermark (the reducer default branch).
    if (existing === undefined && config.launch !== undefined) {
      this.record(runLaunchedEvent(config.launch, config));
    }
        // Inherited (amend) or restored (resume) usage is re-emitted here: projections treat run-started as
        // usage-reset (stripping the previous epoch settlement ghost), so without this the card shows 0
        // until the first live turn lands -- and this-run-has-not-spent is false. Worse with no live ask at all:
        // the projection stays 0 until a cold replay agrees with the row.
        // Zero emits nothing: the reset already said zero; another event is noise tax on every fresh run.
    if (this.spentTokens > 0) this.record({ type: "usage-updated", spentTokens: this.spentTokens });
  }

    /* The run settlement promise: fulfilled on complete/fail/cancel. */
  get settled(): Promise<RunSettlement> {
    return this.settledDeferred.promise;
  }

    /* The current run status. */
  status(): RunStatus {
    return this.journal.getRun(this.runId)?.status ?? "running";
  }

  // ——————————————————————————————— Boundary A ———————————————————————————————

  /**
      * Create an actor. The **effective name** is spec.name post-normalization (persona name beats the arg);
      * non-empty must be unique in this run -- duplicates fail the run loudly (DuplicateActorName).
   *
      * Why run-level failure, not rename/warn: named actors are the amend-resume cache-import identity key, and any
      * run is a future amendment potential predecessor; duplicates there make import matching ambiguous.
      * Hence the rule binds all runs, not only amended ones. Anonymous (absent/empty) is unchecked, any count legal --
      * the adjudicated cost: no cache eligibility.
   *
      * **Replay safety**: the claim table is pure memory, born with the engine instance. A resume of a byte-identical script re-runs
      * the same createActor sequence in a **fresh** engine, so each name registers exactly once -- the previous epoch own
      * registration is not a duplicate. Also why it cannot persist: a persisted table would collide with itself on resume.
   *
      * **Import-cache attachment happens here too** (amend-resume): look up importedCache actors by effective name,
      * attach the candidate to the scheduler actor state only on a normalized-persona match. Why at **runtime** and not
      * statically pairing the two scripts: name and persona are runtime values (agent args may be dynamic); a static compare is
      * a second truth -- what this package avoids (the verdict: matchImportedActor in imported-cache.ts).
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
                // Same synchronous surface as assertRunning: createActor has no promise to reject; it throws.
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
    }
    this.scheduler.registerActor(ref, id, name, spec, matchImportedActor(this.importedCache, spec));
        // putActor replaces the whole row, while sessionId / resolvedModel are **driver-owned** fields
        // (the former written by ensureSession, the latter by the host-side runtime factory). Existing values must ride along,
        // else a replay hit on the same pair erases both.
    const existing = this.journal.getActor(this.runId, siteId, ordinal);
    this.journal.putActor({
      runId: this.runId,
      siteId,
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
            // Unknown actor: the script/lowering contract broke; the whole run fails loudly.
      const err = new WorkflowError("UnknownActor", `Unknown subagent handle: ${actorId}.`);
      this.failRun(err);
      return Promise.reject(err);
    }
    const spec = this.askSpecs.get(siteId);
    if (spec === undefined) {
            // Site table and schema synthesis share one compilation, so a miss is a wiring bug (two compile products spliced).
            // A not-typed fallback would silently downgrade typed asks: no submit_result, final text as result, schema validation gone --
            // a type system degraded to always-valid is worse than none; fail the run loudly instead.
            // an always-valid type system is worse than none; fail the whole run loudly instead.
      const err = new WorkflowError(
        "MissingAskSpec",
        `Ask site ${siteId} has no spec: askSpecs is incomplete (compile output mismatch).`,
      );
      this.failRun(err);
      return Promise.reject(err);
    }
    return this.scheduler.admitAsk(siteId, actorId, instructions, spec);
  }

    /* World nodes (read/run): the body is readWorld in engine-world.ts. */
  worldRead(siteId: string, op: WorldReadOp, args: unknown[]): Promise<unknown> {
    return readWorld(this.state, siteId, op, args);
  }

  log(message: string): void {
    if (this.runSettled) return;
    this.record({ type: "log", message });
  }

  /**
      * Control flow passed a phase marker (the Boundary A enterPhase). The log posture: synchronous, no return,
      * no-op settled, **no journal row** -- a marker is not a site; no node row exists.
   *
      * Ordinals count by name, in their own table (phaseOrdinals): phase names and site ids never consume
      * each other ordinals (site-id stability).
      * **Emit on every evaluation**: the second loop round of a marker is its second entry; deduping
      * same-as-current would lose rounds. Resume re-emits the prefix -- deliberately (dedup needs event reads);
      * the reducer folds monotonically by rounds = max.
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

    /* Publish one intermediate result (Boundary A report): the body is publishReport in engine-report.ts. */
  report(siteId: string, item: unknown, artifactId?: string): void {
    publishReport(this.state, siteId, item, artifactId);
  }

  /**
      * Publish a **content artifact** (file/markdown): the body is publishContentArtifact in engine-artifacts.ts.
      * publishContentArtifact in engine-artifacts.ts.
   */
  publishArtifact(siteId: string, op: ArtifactContentOp, args: unknown[]): Promise<ArtifactRef> {
    return publishContentArtifact(this.state, siteId, op, args);
  }

  /**
      * Declare a **preset artifact** (chart/table/metrics/board): the body is declarePresetArtifact in engine-artifacts.ts.
      * engine-artifacts.ts declarePresetArtifact.
   */
  declareArtifact(siteId: string, op: ArtifactPresetOp, args: unknown[]): void {
    declarePresetArtifact(this.state, siteId, op, args);
  }

    // --------------- externally driven run lifecycle ---------------

    /* The sandbox script returned a top-level artifact: settle completed; the body is settleCompleted in engine-settlement.ts. */
  complete(artifact: unknown): void {
    settleCompleted(this.state, artifact);
  }

  /**
      * External stop: abort in-flight asks (deferred rejects cancelled, the settled event emitted), the run
      * settles stopped with reason; finished journal rows stay (resumable). All four reasons, one path:
      * user / model (the initiator the cancel entry passes), interrupted (a harness sandbox failure),
      * provider (a deterministic model-side error via stopRun). error present only for the last two.
      * First-wins: settled calls are ignored. The body is settleStopped in engine-settlement.ts.
   */
  stop(reason: RunStopReason, error?: WorkflowError, supersededBy?: string): void {
    settleStopped(this.state, reason, error, supersededBy);
  }

  /**
      * External failure: the failure dual of complete. The harness maps child complete-ok-false (a thrown script),
      * crashes, wall-clock timeouts, NDJSON parse failures here -- run failure, never disguised cancel,
      * else the journal failure and the caller-visible result diverge.
      * The internal failRun path: first-wins (over complete/cancel/internal), driver-side in-flight abort,
      * journal failed + failure json, the failure event, settled as failed.
   */
  fail(error: WorkflowError): void {
    this.failRun(error);
  }

  /**
      * Edit this run **own** concurrency cap in place.
      * A max-concurrency-only amendment on a living run: same runId, no successor minted, no supersede,
      * not one in-flight ask lost -- the whole difference from AmendWorkflow, and the reason it exists.
   *
      * Returns whether anything changed. Both no-ops return false, no write, no event: run settled (the race between the host
      * liveness check and this call -- callers fall back to a real amend), or equal value.
   *
      * On change, three things happen in one synchronous step, forever consistent: caps replaced wholesale (scheduler reads fresh),
      * the run caps column written (resume takes the row value; unwritten it would restore the old cap), and the
      * caps-changed event. A raise adds one pumpAll -- the cap is read pre-dispatch and nothing else triggers a rescan,
      * so queued asks would wait for the next settlement. Lowering never recalls in-flight asks: they run out; the cap governs
      * one-more-admission only.
   *
      * Clamping to [1, ceiling] is the caller -- the ceiling is host facts (machine cores), invisible and none of the engine business.
      // Here only persist-normalization, the same discipline as inheritedTokens: this number lands in
      // the caps column (integer not null); a NaN poisons column and dispatch alike.
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

    // ------------------------- Boundary B (upward) -------------------------

  askSubmitAttempted(instance: InstanceRef, payload: unknown): void {
    this.scheduler.submitAttempted(instance, payload);
  }

  askTurnEnded(instance: InstanceRef, finalText: string): void {
    this.scheduler.turnEnded(instance, finalText);
  }

  /**
      * In-ask progress observation: **pure passthrough**, the same posture as the usage event --
      // no scheduling change, not in the inputHash, unchecked on replay.
      // Like usage, late observations after settlement drop the event only (no ledger here), never tail a settled run.
   */
  askProgress(instance: InstanceRef, progress: AskProgress): void {
    if (this.runSettled) return;
    this.record({ type: "node-progress", instance, ...progress });
  }

  askStats(instance: InstanceRef, stats: AskStats): void {
    this.scheduler.noteStats(instance, stats);
    this.spentTokens += stats.tokens;
        // Usage cannot persist once at createRun(0): without write-back, resume restores zero.
        // Persist immediately after adding, before the event -- payload and column born in one synchronous step, forever equal.
    this.journal.updateRunUsage(this.runId, this.spentTokens);
        // Post-settlement straggler stats (real usage known after turn resolution; the last
        // ask stats often lands after complete/cancel) must not emit -- events after run-settled
        // are unexpected downstream (it must be last). After settlement, account only (the usage row and the
        // stats backfill are journal-row updates, not events); no more events. The ledger still enters: a resumable run usage
        // is continuous across lifetimes.
    if (this.runSettled) return;
    this.record({ type: "usage-updated", spentTokens: this.spentTokens });
  }

  askFailed(instance: InstanceRef, error: WorkflowError): void {
    this.scheduler.failed(instance, error);
  }

  /**
      * A deterministic model-side failure: no node settlement,
      * the whole run stops stopped-provider. Post-settlement calls are ignored by the stop first-wins.
   */
  stopRun(error: WorkflowError): void {
    this.stop("provider", enrichProviderStopPhase(error, this.instancePhases));
  }

    /* Run-level stall observation: record only; post-settlement calls ignored. */
  runStalled(info: RunStallInfo): void {
    if (this.runSettled) return;
    this.record({ type: "run-stalled", ...info });
  }

    // Three pure concurrency observations: the engine only records,
    // never decides on them. Post-settlement (run or node) calls are ignored -- late observations;
    // journaling them would grow a settled run a tail.
  askWaiting(instance: InstanceRef, info: AskWaitInfo): void {
    if (this.runSettled || !this.scheduler.isLive(instance)) return;
    this.record({ type: "node-waiting", instance, ...info });
  }

  askExecuting(instance: InstanceRef): void {
    if (this.runSettled || !this.scheduler.isLive(instance)) return;
    this.record({ type: "node-executing", instance });
  }

  /**
      * The one driver observation the engine decides on: a in-flight ask subagent
      // about to mutate the workspace => close the import cache. Late (settled) observations ignored, as above.
   */
  askMutating(instance: InstanceRef): void {
    if (this.runSettled || !this.scheduler.isLive(instance)) return;
    closeImportCache(this.state, instance, "mutating-tool", this.scheduler.liveActorName(instance));
  }

  concurrencyChanged(change: ConcurrencyChange): void {
    if (this.runSettled) return;
    this.record({ type: "concurrency-changed", ...change });
  }

    // ----------------------------- internal -----------------------------

    /* Run-level failure (first-wins): the body is settleFailed in engine-settlement.ts. */
  private failRun(error: WorkflowError): void {
    settleFailed(this.state, error);
  }

  /**
      * The **sole** ordinal mint (createActor / admitAsk first line / worldRead / report / artifact all
      * synchronously through it), hence also the sole birth-phase record point: this line always runs in the script call tick,
      * events need not -- a queued ask can be held past the next marker.
   */
  private nextOrdinal(siteId: string): number {
    const next = (this.ordinals.get(siteId) ?? 0) + 1;
    this.ordinals.set(siteId, next);
    if (this.currentPhase !== undefined)
      this.instancePhases.set(refToString({ siteId, ordinal: next }), this.currentPhase);
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
      * Every event persists (dwf_event, durable) and fans out via the driver (Boundary C, live).
   *
      * The single funnel of all events; birth phases stamp here. Both routes must receive the **same object**
      // the journal sequence capture checks identity by reference.
   */
  private record(event: RunEvent): void {
    const stamped = stampBirthPhase(event, this.instancePhases);
    this.journal.appendEvent(this.runId, stamped);
    this.driver.emit(stamped);
  }
}

/* Persona normalization: a string is the system prompt; the display name lives on the persona. */ function normalizePersona(
  name: string | undefined,
  persona: string | PersonaSpec | undefined,
): PersonaSpec {
  const base: PersonaSpec =
    typeof persona === "string" ? { system: persona } : persona ? { ...persona } : {};
  if (base.name === undefined && name !== undefined) base.name = name;
  return base;
}
