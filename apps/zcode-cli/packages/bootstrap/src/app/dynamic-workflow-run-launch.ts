// ============================================================
// The launch executor of a Dynamic Workflow Run (shared half-body of submit and resume)
// ============================================================
// submit (new runId) and resume (existing runId, engine's resume branch) are isomorphic across
// "assemble driver -> runWorkflowScript"; that shared half lives here:
// one copy per entry would eventually forget the sequence-slice or actor re-hydration on one side.
//
// This file owns three things:
//   1. journal sequence capture (the emit side grabs the just-appended event's sequence);
//   2. RunEvent -> session event payload (bounding + two derived fields);
//   3. actor runtime admission: fresh (session row + task link) or re-hydrated (resumeFromStore).

import { randomUUID } from "node:crypto";
import {
  boundDynamicWorkflowRunEventPayload,
  CoreErrorType,
  ZCODE_DWF_CHILD_COMMAND,
  type CreateSessionTaskLinkInput,
  type DynamicWorkflowRunEvent,
  type DynamicWorkflowRunProgressPayload,
  type SessionId,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import { parseModelPickerValue, type ModelSelection } from "@zcode/shared/model-selection";
import {
  type ActorSubmitProfile,
  refToString,
  validate,
  type ActorRef,
  type AskSpec,
  type Caps,
  type ImportedRunCache,
  type JournalStorePort,
  type JsonSchema,
  type RunEvent,
  type RunSettlement,
  type ValidateFn,
} from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "@zcode/dynamic-workflow-runtime";
import { createJournalSequenceCapture } from "./dynamic-workflow-run-sequence-capture.js";
import { isResumableSettlement } from "./dynamic-workflow-run-observation.js";
import {
  readRunLaunchAnchor,
  readRunSubagentModel,
  type RunLaunch,
} from "./dynamic-workflow-run-launch-anchor.js";
import { resolveWorkflowConcurrencyCeiling } from "./workflow-concurrency-ceiling.js";
import type { ActorSessionQuiescence } from "./workflow-driver-quiescence.js";
import { createAgentRuntimeWorkflowDriver, mintActorSessionId } from "./workflow-driver.js";
import type { WorkflowEscalationRegistry } from "./workflow-escalation-registry.js";
import type { WorkflowRunControl } from "./workflow-run-control.js";
import { createWorkflowRunSeatGate } from "./workflow-seat-gate.js";
import type { DynamicWorkflowRunServiceDeps } from "./dynamic-workflow-run-service.js";

/** Adapts the package validator to the engine's ValidateFn contract (launch is runWorkflowScript's only call site). */
const validateFn: ValidateFn = (schema, value) => validate(schema as JsonSchema, value);

/** All artifacts of one compilation. Four consumers share one ts.Program (compile once; run service invariant 2). */
export interface CompiledDynamicWorkflowScript {
  lowered: string;
  scriptHash: string;
  askSpecs: Map<string, AskSpec>;
  /** Approved command set for world.run (compile-time literal collection). */
  declaredRunCommands: ReadonlySet<string>;
  /** Submit profile per actor site. */
  actorSubmitProfiles: ReadonlyMap<string, ActorSubmitProfile>;
}

interface LaunchDynamicWorkflowRunInput {
  caps: Caps;
  compiled: CompiledDynamicWorkflowScript;
  cwd: string;
  deps: DynamicWorkflowRunServiceDeps;
  /** Display name of the run (CreateWorkflow's optional input.name); persisted to dwf_run.name with EngineConfig at createRun. */
  name?: string;
  /**
   * This run's validated arguments (the saved workflow's arg bag). Two destinations: dwf_run.args_json
   * via EngineConfig, and the spawn payload's `args` global injected into the sandbox.
   *
   * The resume branch passes the copy read back from the journal, never a caller-supplied one —
   * see the run service's resume note.
   */
  args?: Record<string, unknown>;
  parentSessionId?: string;
  runId: string;
  scriptText: string;
  signal: AbortSignal;
  toolCallId?: string;
  /**
   * Lineage pointer (dwf_run.resumed_from) and import cache of an amendment continuation; they
   * travel in pairs: the pointer is row-level fact (the UI's "continued from run X", crash-recover
   * rebuilds from it), the cache is this execution's accelerator.
   *
   * Same road as the other metadata — launch -> harness -> EngineConfig, zero reprocessing en
   * route. Building (reading the predecessor journal, walking resumed_from, resolving transcript
   * sources) happens entirely in the run service: this is already the execution side, and building
   * here would mean resume and submit each build once (they must be two calls of one pure function).
   */
  resumedFrom?: string;
  importedCache?: ImportedRunCache;
  /**
   * Usage baseline at run creation: spentTokens after the predecessor settles.
   * Same road as the lineage pointer — launch -> harness -> EngineConfig, zero reprocessing;
   // provided by amend, absent for fresh submit and resume (the latter restores usage from the
   // existing row).
   */
  inheritedTokens?: number;
  /**
   * Anchor of the turn that launched this run. The submit path supplies it (the engine records
   * `run-launched` in the creating generation); resume lacks it and this function reads it back
   // from the journal — both paths derive launchInputId for `actor-created`/`run-settled` progress
   // events from the same value. The submit path also carries the script's phase table (phaseNames)
   // and this run's subagent model (subagentModel, the canonical picker string); all three persist
   // only in the creating generation's journal, and resume reads them back from that event.
   */
  launch?: RunLaunch;
  /**
   * The parking registry for escalation questions. The run service holds one across all its
   * in-flight runs, and both entries (submit/resume) pass the same object — it indexes by full qid;
   // one registry per entry would leave post-resume runs unable to answer their own questions.
   */
  escalationRegistry: WorkflowEscalationRegistry;
  /**
   * This run's live control plane, built by the run service per registry entry (submit/amend/
   * resume all do); this function wires both ends: harness does bind(engine), we do bindSeatGate.
   *
   * Absent = this launch has no control plane (snippet execution): the run completes, its bounds
   * just can't change mid-flight.
   */
  control?: WorkflowRunControl;
  /**
   * Receives the session-quiescence probe of the driver built by this launch
   * (workflow-driver-quiescence.ts). All three entries pass the same instruction: hang it on this
   * run's registry entry so a future amend can ask "has the predecessor's session gone quiet".
   // Passed through untouched; this file never reads it.
   */
  onQuiescenceProbe?: (probe: ActorSessionQuiescence) => void;
}

/**
 * Launch (or resume) a run: sequence capture -> emit hooks -> real driver -> runWorkflowScript.
 * Fire-and-forget semantics belong to the caller (this returns only the settlement promise; no
 * registry bookkeeping).
 */
export function launchDynamicWorkflowRun(
  input: LaunchDynamicWorkflowRunInput,
): Promise<RunSettlement> {
  const {
    args,
    caps,
    compiled,
    control,
    cwd,
    deps,
    escalationRegistry,
    importedCache,
    name,
    parentSessionId,
    resumedFrom,
    runId,
    scriptText,
    signal,
    toolCallId,
  } = input;
  const childSpawn = dynamicWorkflowChildSpawn();
  // The SECOND enforcement point of this run's own bounds: the scheduler decides whether another
  // ask may be dispatched; the gate decides whether already-running ones may send their next
  // request. The baseline is this launch's caps (submit: the clamped request; resume: the journal
  // row), so a never-retuned run always takes the gate's fast path — no event, no ticket, byte
  // identical to before.
  const seatGate = createWorkflowRunSeatGate({ limit: caps.maxConcurrency });
  control?.bindSeatGate(seatGate);
  // Anchor: from submit (this run's creation) or the journal (resume). Pre-upgrade runs have
  // neither -> absent, progress events carry no launchInputId and subagents don't report.
  const launch = input.launch ?? readRunLaunchAnchor(deps.journal, runId);
  // Lineage pointer: given by submit/amend params; on resume the param is absent (createRun wrote
  // it long ago) so it's read from the journal row — keeping run-started payloads identical.
  const lineageFrom = resumedFrom ?? deps.journal.getRun(runId)?.resumedFrom;
  // Concurrency ceiling: the second host-derived field of the run-started payload. Computed once
  // per launch, not per event — it's a process fact (core count never changes mid-run) and
  // availableParallelism() is a syscall.
  const concurrencyCeiling = resolveWorkflowConcurrencyCeiling(deps.availableParallelism);
  // Subagent model: from submit (rides with the anchor) or the journal (resume reads the same
  // run-launched). Same argument as the anchor, so both paths agree; pre-upgrade runs have neither
  // -> absent = run on the session model.
  const subagentModel = input.launch?.subagentModel ?? readRunSubagentModel(deps.journal, runId);
  // String -> selection, parsed once per launch. Progress payloads carry the raw string (toProgressPayload
  // below); the actor runtime factory wants the structured selection (with reasoning tier — the
  // pinned two-part identity can't carry it).
  const runSubagentModel =
    subagentModel === undefined ? undefined : parseModelPickerValue(subagentModel);

  // Only appendEvent knows an event's journal sequence, and the engine calls driver.emit(...)
  // synchronously right after journal.appendEvent(...) inside record(), discarding the StoredEvent
  // (engine.ts). So wrap the journal here to capture the assigned sequence: what emit sees is
  // exactly the event just appended. Alternatives are worse — a local counter drifts wholesale on
  // resume (sequence continues from the existing max), and re-querying the journal per event is
  // wasted IO.
  // The "append immediately followed by emit, one-to-one" premise is pinned by tests: the sequence
  // sequence the hook sees must equal listEvents' output item by item.
  const sequenceCapture = createJournalSequenceCapture(deps.journal);

  const makeDriver = createAgentRuntimeWorkflowDriver({
    journal: sequenceCapture.journal,
    emit: (event) => {
      // Event fan-out must never kill the run: hooks are observers; swallow exceptions at this
      // boundary and log.
      try {
        if (deps.onRunEvent === undefined) return;
        deps.onRunEvent(
          toProgressPayload({
            event,
            runId,
            sequence: sequenceCapture.sequenceOf(event),
            ...(toolCallId === undefined ? {} : { toolCallId }),
            ...(launch === undefined ? {} : { launchInputId: launch.inputId }),
            ...(lineageFrom === undefined ? {} : { resumedFrom: lineageFrom }),
            concurrencyCeiling,
            ...(subagentModel === undefined ? {} : { subagentModel }),
          }),
          // Routing and payload are separate: the event must land in the session that LAUNCHED the
          // run, and parentSessionId is the only way to tell whether it is that session.
          parentSessionId === undefined ? {} : { parentSessionId },
        );
      } catch (error) {
        deps.logger?.warn?.("Dynamic workflow run event hook failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "dynamic_workflow.run_event.hook_failed",
          module: "bootstrap.app",
          runId,
        });
      }
    },
    executionPort: deps.executionPort,
    fileSystemPort: deps.fileSystemPort,
    escalationRegistry,
    cwd,
    // Where user-facing artifacts land. The session scope is THIS service's parent session (= this
    // app's session), not the optional parentSessionId launch param: in production they're equal
    // (run start passes the runtime's own sessionId), but only the former is required, and "which
    // session's directory gets the bytes" must not have an undefined branch. With no store, the
    // whole pair is omitted and the driver's ArtifactStoreUnavailable rejection is loud.
    ...(deps.artifactStore === undefined
      ? {}
      : {
          artifactStore: deps.artifactStore,
          parentSessionId: deps.parentSessionId as SessionId,
        }),
    declaredRunCommands: compiled.declaredRunCommands,
    // Which submit_result flavor each actor site gets (typed/generic/none) is decided at compile time.
    actorSubmitProfiles: compiled.actorSubmitProfiles,
    runId,
    // Boundary accounting and seed copies read/write the actor session's messages (driver side; see
    // workflow-driver.ts's header).
    ...(deps.actorTranscriptStore === undefined
      ? {}
      : { actorTranscriptStore: deps.actorTranscriptStore }),
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    // Narrow port of the process-wide concurrency governor: when present, the driver hands every
    // actor runtime a per-request admission port (the runtimeFactory passes it through below);
    // absent, actors are ungated.
    ...(deps.concurrency === undefined ? {} : { concurrency: deps.concurrency }),
    // This run's seat gate: the driver wraps each actor's admission port in it and feeds it ask
    // start/end (startAsk and the engine's node-settled).
    seatGate,
    // Test-injected driver clock (fault matrix); absent in production, real time.
    ...(deps.driverClock === undefined ? {} : { clock: deps.driverClock }),
    // Backfill port of the session-quiescence probe (see the param's doc): the driver calls once at construction.
    ...(input.onQuiescenceProbe === undefined
      ? {}
      : { onQuiescenceProbe: input.onQuiescenceProbe }),
    runtimeFactory: async ({
      sessionId,
      actor,
      persona,
      escalatePort,
      seed,
      submitPort,
      submitProfile,
      modelRequestAdmission,
    }) => {
      const runtime = deps.createActorRuntime({
        runId,
        sessionId,
        actor,
        persona,
        submitPort,
        // The factory decides port injection and typed declaration from the profile (create-app.ts's
        // createActorRuntime).
        submitProfile,
        // Per-request admission port travels with the two tool ports into runtime deps.
        ...(modelRequestAdmission === undefined ? {} : { modelRequestAdmission }),
        // The escalation port rides with the submit port: core's registration gate keys on the
        // port's existence, so always pass it.
        escalatePort,
        // Resume pin: which model this actor ran on last time. Read BEFORE building the runtime,
        // because journalActorResolvedModel below writes this round's resolution into the same
        // field.
        //
        // A seed-carried pin is inheritance (amend-resume): on the amended run's first dispatch this
        // run's journal has no resolution yet, so the pin can only come from the predecessor — under
        // transcript continuation, a silent model switch is exactly the identity mutation the pin
        // prevents. When both exist (amended run resumed after a crash), this run's record wins: it
        // is what this actor actually ran on IN THIS RUN, more specific than the predecessor's, and
        // the two should be equal anyway. Malformed pins fail loudly per the existing
        // WorkflowActorPinnedModelError path; no fork here.
        pinnedModel:
          pinnedActorModel({ actor, journal: deps.journal, runId }) ?? seed?.resolvedModel,
        // This run's subagent model: ABOVE the pin (workflow-actor-model.ts's precedence table). It
        // is the user's explicit statement for this run (AmendWorkflow with subagent_model IS the
        // explicit "switch model on resume"); the pin only guards the implicit default without it.
        // Unlike the pin it carries the reasoning tier all the way down — the journal's pin records
        // only the two-part identity.
        ...(runSubagentModel === undefined ? {} : { runSubagentModel }),
      });
      // Which model a persona's tier resolved to — only the built runtime knows for sure (tier
      // mapping in workflow-actor-model.ts). Persist before attaching to the session: a failed
      // session persistence fails this ask, but the audit fact "which model was chosen" stays in
      // the journal. The rehydrate path writes too — with no pin (pre-upgrade run) this is the
      // first resolution on record.
      journalActorResolvedModel({
        actor,
        journal: deps.journal,
        selection: requireActorModelSelection(runtime, actor),
        runId,
      });
      const attached = await attachActorSession({
        actor,
        deps,
        runId,
        runtime,
        sessionId,
      });
      if (attached === "rehydrated") return runtime;
      await persistActorSession({
        actor,
        deps,
        parentSessionId,
        runId,
        runtime,
        sessionId,
      });
      return runtime;
    },
  });

  return runWorkflowScript({
    askSpecs: compiled.askSpecs,
    caps,
    // Under SEA the spawn strategy must change; non-SEA passes nothing.
    ...(childSpawn === undefined ? {} : { childSpawn }),
    cwd,
    lowered: compiled.lowered,
    makeDriver,
    // When the entry file can't be written into the project .zcode/, the harness falls back to the
    // OS temp dir and says so — the run still starts, but this log is the only clue to "why is there
    // no workflow-runs archive in the project".
    onWarning: (warning) => {
      deps.logger?.warn?.("Dynamic workflow entry file fell back to the OS temp dir", {
        event: "dynamic_workflow.entry_file.fallback",
        module: "bootstrap.app",
        runId,
        ...warning,
      });
    },
    // name rides the same metadata road as scriptText: the harness passes it to EngineConfig
    // unchanged (on resume the journal hit short-circuits createRun; harmless and keeps both launch
    // inputs shape-equal).
    ...(name === undefined ? {} : { name }),
    // Args ride the same metadata road as name/scriptText, plus one destination: the harness both
    // passes them to EngineConfig (args_json) and puts them into the spawn payload for the sandbox.
    ...(args === undefined ? {} : { args }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    runId,
    // Persist the author's original text and its hash, not the lowered function body (resume's
    // comparison basis is the original).
    scriptHash: compiled.scriptHash,
    scriptText,
    // The association anchor persists with the run: after restart, tool-card join and resume
    // notices can only be reconstructed from dwf_run.
    ...(toolCallId === undefined ? {} : { toolCallId }),
    // Amendment continuation: the lineage pointer persists (createRun writes it once) and the
    // import cache is injected into the engine (pure data, zero core IO).
    ...(resumedFrom === undefined ? {} : { resumedFrom }),
    ...(importedCache === undefined ? {} : { importedCache }),
    // Usage baseline rides with the cache: the engine writes it as spent_tokens' initial value at
    // createRun, ignored when the row already exists.
    ...(input.inheritedTokens === undefined ? {} : { inheritedTokens: input.inheritedTokens }),
    // The anchor persists only in the creating generation's journal (engine-side gate); passing it
    // on resume is harmless.
    ...(launch === undefined ? {} : { launch }),
    signal,
    // Control plane and signal share one seam: that one is "stop this run", this one "change one
    // setting of this run". The harness binds in the same synchronous slice the engine is
    // constructed (harness.ts), so the run is amendable from its first event.
    ...(control === undefined ? {} : { control }),
    validate: validateFn,
  });
}

/**
 * Spawn strategy for the sandbox child: under SEA, self-re-exec via a hidden subcommand; otherwise
 * no opinion (harness default `node --max-old-space-size=… <entry>`).
 *
 * A SEA single-file binary does not interpret Node CLI flags, so the harness-default argv's
 * `--max-old-space-size` lands verbatim in the CLI's strict parseArgs and the child exits with an
 * error — under SEA every workflow run would fail. Same fix as the official plugin host
 * (official-plugin-runtime.ts's `officialPluginHostPrefixArgs`).
 *
 * SEA detection stays in bootstrap, not harness: harness is app-free (only @zcode/dynamic-workflow
 * and node builtins), sees no contracts subcommand constants, and shouldn't know how it's packaged.
 * Injectable isSea exists for tests only — the default probe is always false in test processes, so
 * "non-SEA must not carry argsPrefix" is an assertable fact.
 */
export function dynamicWorkflowChildSpawn(
  isSea: boolean = isSeaRuntime(),
): { argsPrefix: readonly string[] } | undefined {
  return isSea ? { argsPrefix: [ZCODE_DWF_CHILD_COMMAND] } : undefined;
}

/** SEA runtime probe (local mirror of official-plugin-runtime.ts's private same-named helper; deliberately not shared). */
function isSeaRuntime(): boolean {
  const getBuiltinModule = process.getBuiltinModule as
    | ((id: "node:sea") => { isSea(): boolean })
    | undefined;
  try {
    return getBuiltinModule?.("node:sea").isSea() === true;
  } catch {
    return false;
  }
}

/**
 * Resume re-hydration: the journal recorded the actor's session id => a re-attach (session row and
 * messages already persisted; mintActorSessionId is pure-deterministic so the sessionId IS the
 * old one; the driver side cross-checks too).
 * resumeFromStore rebuilds messageHistory from persisted message/part rows — interrupted tool calls
 * get pinned by the hydrator as "[Tool execution was interrupted before resume]", the correct
 * semantics for a killed ask.
 *
 * SessionNotFound (session row pruned) is not an error but a recorded exception: fall back to the
 * fresh-persist path, actor restarts empty — more honest than stalling the whole run.
 * Everything else rethrows (lower layers don't swallow; house rule).
 */
async function attachActorSession(input: {
  actor: ActorRef;
  deps: DynamicWorkflowRunServiceDeps;
  runId: string;
  runtime: AgentRuntime;
  sessionId: SessionId;
}): Promise<"fresh" | "rehydrated"> {
  const { actor, deps, runId, runtime } = input;
  const journaledSessionId = deps.journal.getActor(runId, actor.siteId, actor.ordinal)?.sessionId;
  if (journaledSessionId === undefined) return "fresh";
  try {
    await runtime.resumeFromStore();
    // Session row and task link were persisted in the previous generation (both upserts); a re-attach
    // rebuilds neither.
    return "rehydrated";
  } catch (error) {
    if (!isSessionNotFound(error)) throw error;
    deps.logger?.warn?.("Dynamic workflow actor session pruned; starting fresh", {
      actor: refToString(actor),
      event: "dynamic_workflow.actor.rehydrate_fallback",
      module: "bootstrap.app",
      runId,
      sessionId: input.sessionId,
    });
    return "fresh";
  }
}

/** Structural check for core's SessionNotFound (never branch on error text). */
function isSessionNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { type?: unknown }).type === CoreErrorType.SessionNotFound
  );
}

/**
 * Materialize the actor session: session row + task link (legacy-path exemplar in
 * script-workflow-runtime.ts).
 *
 * Order is payload-bearing: session_task_link.child_session_id has an FK to session(id), so the
 * session row must land before the link; hence ActorRuntimeFactory may return a Promise.
 *
 * This does NOT subscribe to actor runtime events: the live channel is installed at child-runtime
 * CONSTRUCTION (script-workflow-child-runtime.ts's eventSink -> the parent runtime's sink set). The
 * legacy subscribeEvents channel, installed after ensureSessionPersistedForExternalActivity below,
 * would write SessionTitleUpdated as sequenceNumber 1 — the v4 gateway drains contiguous seq, so a
 * subscription from seq 2 would wait forever for a seq 1 that never comes: permanent blank transcript.
 */
async function persistActorSession(input: {
  actor: ActorRef;
  deps: DynamicWorkflowRunServiceDeps;
  parentSessionId?: string;
  runId: string;
  runtime: AgentRuntime;
  sessionId: SessionId;
}): Promise<void> {
  const { actor, deps, parentSessionId, runId, runtime, sessionId } = input;
  const title = `workflow subagent ${refToString(actor)}`;

  await runtime.ensureSessionPersistedForExternalActivity(title);

  if (deps.taskLinkStore) {
    await deps.taskLinkStore.createSessionTaskLink({
      childSessionId: sessionId,
      id: `tasklink_${randomUUID()}`,
      // rootWorkflowRunId is deliberately empty. VERIFIED fact, not a guess: the column is declared
      // `root_workflow_run_id text references workflow_run(id)` (migration 0007, the
      // session_task_link DDL), pointing at the LEGACY workflow_run table while workflow run
      // records live in dwf_run; the migration runner keeps pragma foreign_keys = on. Probed
      // against a real store: with a workflow runId -> `FOREIGN KEY constraint failed`; without ->
      // ok. So run identity travels in the FK-less path column below. Don't "fix" it back.
      //
      // path is a mini-contract: `dwf/<runId>/<siteId>@<ordinal>`. runId is charset-safe; the siteId
      // segment keeps raw `#`/`@` (free-text column; the sanitized form already lives in the session
      // id). NOTHING parses it today — it serves human reading and possible future prefix scans
      // ("all actor sessions of this run"). Indexing by run id later needs a migration rebuilding
      // session_task_link to re-point or drop the FK.
      path: `dwf/${runId}/${refToString(actor)}`,
      ...(parentSessionId === undefined ? {} : { parentSessionId: parentSessionId as SessionId }),
      // Deliberately distinct from legacy "workflow_agent" (script-workflow-runtime.ts), not reused:
      // different populations. Legacy rows' root_workflow_run_id points at workflow_run non-empty;
      // dwf rows keep it empty with run identity in path. A shared role value would hand consumers
      // that "select by role then dereference root_workflow_run_id" a null from dwf rows. The column
      // is `text not null` with no CHECK, no enum, and no contract-side zod (verified) — new value legal.
      role: "workflow_actor",
      status: "running",
    } satisfies CreateSessionTaskLinkInput);
  }
}

/**
 * Writes which model the actor actually ran on into the journal (ActorRecord.resolvedModel, the
 * dwf_actor.resolved_model column).
 *
 * Why read-modify-write: putActor replaces the whole record, and its other fields (name/persona/
 * sessionId) aren't this function's; writing a record with only resolvedModel would erase the
 * frozen persona the engine just wrote.
 *
 * Why driver-side: which model a subagent runs on is host fact (the parent session's choice at
 * that moment), invisible when the engine persists the persona in createActor. The engine's two
 * putActor sites carry the field through verbatim — see dynamic-workflow's engine.ts/scheduler.ts.
 */
export function journalActorResolvedModel(input: {
  actor: ActorRef;
  journal: JournalStorePort;
  selection: ModelSelection;
  runId: string;
}): void {
  const { actor, journal, selection, runId } = input;
  const existing = journal.getActor(runId, actor.siteId, actor.ordinal);
  journal.putActor({
    ...(existing ?? { runId, siteId: actor.siteId, ordinal: actor.ordinal }),
    resolvedModel: formatActorResolvedModel(selection),
  });
}

/** journal spelling of `resolvedModel`: `providerId/modelId`; inverse of the pin reader (workflow-actor-model.ts). */
function formatActorResolvedModel(selection: ModelSelection): string {
  return `${selection.providerId}/${selection.modelId}`;
}

/**
 * A built actor runtime must already have a model selection: the child inherits the parent
 * session's current one (script-workflow-child-runtime.ts), and without it the child cannot even
 * send its first model request. Fail loudly here rather than persisting an empty pin.
 */
function requireActorModelSelection(runtime: AgentRuntime, actor: ActorRef): ModelSelection {
  const selection = runtime.getSessionModelSelection();
  if (selection === undefined) {
    throw new Error(
      `actor session has no model selection; cannot record resolvedModel: ${actor.siteId}#${actor.ordinal}`,
    );
  }
  return selection;
}

/**
 * Resume pin read: the `resolvedModel` (providerId/modelId) this actor recorded in the journal.
 *
 * Only resume finds a value: the engine's createActor replay carry-forwards the field; a fresh run
 * has no resolution at factory time — absent by construction. Read BEFORE building the runtime:
 * journalActorResolvedModel writes this round's resolution into the same field next, and a late
 * read would mistake this round's result for the previous pin. Pin vs this run's subagentModel
 // precedence: workflow-actor-model.ts (run selection above; the pin only guards the default when
 // no run selection exists — the persisted half of the frozen-persona invariant).
 */
function pinnedActorModel(input: {
  actor: ActorRef;
  journal: JournalStorePort;
  runId: string;
}): string | undefined {
  return input.journal.getActor(input.runId, input.actor.siteId, input.actor.ordinal)
    ?.resolvedModel;
}

/**
 * RunEvent -> protocol event mapping (THIS COMMENT IS THE CONTRACT): `type` is the event's
 * discriminant; `payload` is the same event object minus `type`, bounded via
 * {@link boundDynamicWorkflowRunEventPayload}. Field names deliberately unreshaped — the reader
 * (detail-page event log) interprets payloads per kind, and the engine's vocabulary IS that schema.
 *
 * Kinds the engine actually emits: run-started / actor-created / node-queued / node-dispatched /
 * node-repairing / node-nudged / node-settled / usage-updated / log / report / phase-entered /
 * run-settled.
 * (`executing` is not an observable event; `compaction` v1 never fires.) Two more come from the
 * DRIVER over the same rails: escalation-raised / escalation-resolved (workflow-driver.ts's
 * escalation bridge).
 *
 * Adding a kind is zero-change HERE — that's what "don't reshape field names" buys: type from the
 * discriminant, payload the rest, no per-kind branch to miss. But downstream DOES have a per-kind
 * switch: zcode-protocol-v4/product-projection.ts's applyWorkflowRunEvent reduces per kind with an
 * eventType param typed `string`, not RunEvent["type"] — a missed branch is tsc-silent. When adding
 * kinds, read that switch; don't trust the compiler.
 */
export function toProtocolEvent(sequence: number, event: RunEvent): DynamicWorkflowRunEvent {
  const { type, ...rest } = event;
  const { payload, truncated } = boundDynamicWorkflowRunEventPayload(
    rest as Record<string, unknown>,
  );
  return { sequence, type, payload, ...(truncated ? { truncated } : {}) };
}

/**
 * RunEvent -> session event payload. `payload` shares one serialization with {@link toProtocolEvent};
 * derived fields live outside the payload, preserving the engine event verbatim.
 *
 * actorSessionId comes from the same generator the driver uses, so the renderer never re-implements
 * session-id rules. Both actor-created and actor-bearing node-dispatched gain the field, so a
 * running instance collected into the bounded table still links to its subagent session. Process
 * concurrency ceiling and subagent source are added per their event conditions below.
 */
export function toProgressPayload(input: {
  event: RunEvent;
  runId: string;
  sequence: number;
  toolCallId?: string;
  /** The run's anchor inputId; derived only on actor-created / run-settled (the two subagent-attribution moments). */
  launchInputId?: string;
  /** The amended run's predecessor; derived only on run-started (the card's "tuned from run X"). */
  resumedFrom?: string;
  /**
   * Process concurrency ceiling at payload mint time; derived on run-started and run-caps-changed.
   *
   * Engine events carry only their own caps.maxConcurrency; "is this number worth showing" needs
   * comparison against the ceiling — a host fact (machine cores) the engine can't and shouldn't
   * see. The projection records the run's own bound when caps.maxConcurrency < concurrencyCeiling;
   * the UI's concurrency chip takes min(shared cap, run bound).
   *
   * An in-place retune's run-caps-changed carries the NEW caps with the same test: below ceiling
   * writes the bound, equal clears it (= unbounded). Both events must see the same ceiling — this
   * one.
   */
  concurrencyCeiling?: number;
  /**
   * This run's subagent model (canonical picker string); derived only on run-started, present
   * only when set. Unlike concurrencyCeiling it needs no default comparison: the engine knows
   * nothing of it (the model surface is entirely host-side), so absent = subagents run on the
   * session model. Cold replay takes the same key from the same run-launched event, so both
   * payload sides are byte-equal.
   */
  subagentModel?: string;
}): DynamicWorkflowRunProgressPayload {
  const {
    event,
    runId,
    sequence,
    toolCallId,
    launchInputId,
    resumedFrom,
    concurrencyCeiling,
    subagentModel,
  } = input;
  const protocolEvent = toProtocolEvent(sequence, event);
  const actorRef = actorSessionRefOf(event);
  return {
    runId,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    sequence,
    eventType: protocolEvent.type,
    // run-settled carries one extra bit, resumable: the resume-gate predicate lives only in the CLI;
    // projection/UI just relay the bit, never re-deriving from status. Predicate = stopped AND not
    // superseded; cold replay gives orphan-converged rows the same key — two chains, one predicate
    // (isResumableSettlement). stopReason/supersededBy pass through in the payload.
    // run-started adds resumedFrom: engine events lack it (the engine doesn't read lineage) but the
    // card draws that edge. The same seam adds concurrencyCeiling: the engine emits only its own
    // caps; "is this bound the default" needs the host ceiling (field doc above). Independent of
    // each other; each absent when its source is.
    // run-caps-changed uses the SAME seam and ceiling: after an in-place retune, readers need it to
    // decide write-vs-clear of the new bound — without it the event is two numbers with no ruler.
    payload:
      event.type === "run-settled" && isResumableSettlement(event.status, event.stopReason)
        ? { ...protocolEvent.payload, resumable: true }
        : event.type === "run-started"
          ? {
              ...protocolEvent.payload,
              ...(resumedFrom === undefined ? {} : { resumedFrom }),
              ...(concurrencyCeiling === undefined ? {} : { concurrencyCeiling }),
              ...(subagentModel === undefined ? {} : { subagentModel }),
            }
          : event.type === "run-caps-changed"
            ? {
                ...protocolEvent.payload,
                ...(concurrencyCeiling === undefined ? {} : { concurrencyCeiling }),
              }
            : protocolEvent.payload,
    ...(protocolEvent.truncated ? { truncated: true } : {}),
    ...(actorRef === undefined ? {} : { actorSessionId: mintActorSessionId(runId, actorRef) }),
    // Third derived field: the telemetry fact layer needs the anchor on exactly these two events —
    // actor-created registers subagent ownership, run-settled settles the run's subagents.
    ...((event.type === "actor-created" || event.type === "run-settled") &&
    launchInputId !== undefined
      ? { launchInputId }
      : {}),
  };
}

/**
 * Names the subagent needing the actorSessionId backfill (that ref); unnamed -> undefined.
 *
 * Two kinds: actor-created (a subagent's birth) and actor-bearing node-dispatched (birth restated
 * at ask dispatch). world-read dispatches carry no actor, hence no backfill — no transcript to open.
 */
function actorSessionRefOf(event: RunEvent): ActorRef | undefined {
  if (event.type === "actor-created") return event.actor;
  if (event.type === "node-dispatched") return event.actor;
  return undefined;
}
