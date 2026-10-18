// ============================================================
// The launch executor of a Dynamic Workflow Run (shared half-body of submit and resume)
// ============================================================
// submit (new runId) and resume (existing runId, engine's resume branch) are isomorphic across
// "assemble driver -> runWorkflowScript"; that shared half lives here:
// one copy per entry would eventually forget the sequence-slice or actor re-hydration on one side.
//
// This file owns three things:
//   1. journal sequence capture (the emit side grabs the just-appended event's sequence);
//   2. RunEvent -> session event payload (bounding + derived fields; see dynamic-workflow-run-progress-payload.ts);
//   3. actor runtime admission: fresh (session row + task link) or re-hydrated (resumeFromStore).

import { randomUUID } from "node:crypto";
import {
  CoreErrorType,
  ZCODE_DWF_CHILD_COMMAND,
  type CreateSessionTaskLinkInput,
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
  type RunSettlement,
  type ValidateFn,
} from "@zcode/dynamic-workflow";
import { runWorkflowScript } from "@zcode/dynamic-workflow-runtime";
import { createJournalSequenceCapture } from "./dynamic-workflow-run-sequence-capture.js";
import type { CompiledHole } from "./dynamic-workflow-run-holes.js";
import { toProgressPayload } from "./dynamic-workflow-run-progress-payload.js";
import {
  readRunLaunchAnchor,
  readRunModelBindings,
  readRunSubagentModel,
  readRunSubagentPermissionMode,
  type RunLaunch,
} from "./dynamic-workflow-run-launch-anchor.js";
import { resolveWorkflowDefaultConcurrency } from "./workflow-default-concurrency.js";
import type { ActorSessionQuiescence } from "./workflow-driver-quiescence.js";
import { resolveActorPersonaModel } from "./workflow-actor-model.js";
import { createAgentRuntimeWorkflowDriver } from "./workflow-driver.js";
import type { WorkflowEscalationRegistry } from "./workflow-escalation-registry.js";
import { runBoundTarget, type WorkflowRunControl } from "./workflow-run-control.js";
import { createWorkflowRunSeatGate } from "./workflow-seat-gate.js";
import type { DynamicWorkflowRunServiceDeps } from "./dynamic-workflow-run-service.js";

export { toProgressPayload, toProtocolEvent } from "./dynamic-workflow-run-progress-payload.js";

/** Adapts the package validator to the engine's ValidateFn contract (launch is runWorkflowScript's only call site). */
const validateFn: ValidateFn = (schema, value) => validate(schema as JsonSchema, value);

/** All artifacts of one compilation. Four consumers share one ts.Program (compile once; run service invariant 2). */
export interface CompiledDynamicWorkflowScript {
  lowered: string;
  scriptHash: string;
  askSpecs: Map<string, AskSpec>;
  /** Submit profile per actor site. */
  actorSubmitProfiles: ReadonlyMap<string, ActorSubmitProfile>;
  /** Site -> lexical birth phase name (docs/execution-engine.md, "Identity: sites, ordinals, phases"). */
  sitePhases: ReadonlyMap<string, string>;
  /**
   //   * Filled hole body text per site (site id -> `(async () => { ... })`; docs/execution-engine.md, "The text
   //   * that runs"). The fill service hands holeBodies[siteId] to the engine as that hole's code.
   */
  holeBodies: Readonly<Record<string, string>>;
  /** Per-hole compile-time facts (open and filled, source order): source of type/line for snapshot and progress payload. */
  holes: readonly CompiledHole[];
  /**
   //   * Phase table from the control-flow projection plus indices of its open holes (collectPhaseNames). The fill service feeds them to the engine's
   //   * fillHole phaseNames/holes; the launch declaration table still comes from the submitter (the tool layer computes from the same projection).
   */
  phases: { phaseNames: string[]; holes: number[] };
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
   * The amend-continuation lineage pointer (dwf_run.resumed_from) and the import cache. They appear PAIRED:
   //   * the pointer is a row-level fact (the UI's "continued from run X"; crash resume rebuilds from it), the cache is this execution's accelerator.
   *
   //   * Same road as the rest of the metadata -- launch -> harness -> EngineConfig, zero rework en route. Building (reading the predecessor journal,
   //   * walking resumed_from, resolving the transcript source) all happens in the run service: this is already the execution side; building here too
   //   * would mean resume and submit each build once (and they must be two calls of one pure function).
   */
  resumedFrom?: string;
  importedCache?: ImportedRunCache;
  /**
   //   * Usage baseline at run creation: spentTokens after the predecessor settles.
   //   * Same road as the lineage pointer -- launch -> harness -> EngineConfig, zero rework; present on amend,
   //   * absent on fresh submit and resume (the latter restores usage from the existing row).
   */
  inheritedTokens?: number;
  /**
   //   * Anchor: the turn that launched the run. Present on submit (the engine records
   //   * run-launched for that life); absent on resume, where this fn reads it from the journal -- both paths feed the same value into
   //   * deriving launchInputId for actor-created / run-settled progress events. Submit also carries the script-declared
   //   * phase table (phaseNames) and this run's subagent model (subagentModel, canonical picker string); all three likewise
   //   * journal only in the creation life; resume reads them back from that event.
   */
  launch?: RunLaunch;
  /**
   * The parking registry for escalation questions. The run service holds one across all its
   * in-flight runs, and both entries (submit/resume) pass the same object — it indexes by full qid;
   // one registry per entry would leave post-resume runs unable to answer their own questions.
   */
  escalationRegistry: WorkflowEscalationRegistry;
  /**
   //   * This run's live control surface (docs/dynamic-workflow/concurrency.md, "The control path"). The run
   //   * service builds it from the REGISTRY ENTRY (all three entries do); this fn wires its
   //   * two ends: harness does bind(engine), this does bindSeatGate.
   *
   //   * Absent = this launch has no control surface (snippet, integration tests) -- the run finishes fine, the bound just cannot change mid-flight.
   */
  control?: WorkflowRunControl;
  /**
   //   * Catches the session-quiet probe of the driver built by this launch (workflow-driver-quiescence.ts).
   //   * All three entries pass the same thing: hang it on this run's registry entry so a future amend
   //   * can ask "has the predecessor's session finished writing". Passed through untouched; this file never reads it.
   */
  onQuiescenceProbe?: (probe: ActorSessionQuiescence) => void;
  /**
   //   * A hole's type-argument source text (the progress payload fills type on hole-reached; docs/execution-engine.md,
   //   * "Holes"). A function, not a table: one fill swaps the effective script, nested in-function holes appear,
   //   * the table changes over the run's life -- the caller (run service) points it at the entry's current table. Absent = no fill.
   */
  holeTypeOf?: (siteId: string) => string | undefined;
}

/**
 // * Launch (or resume) a run: sequence-snapshot assembly -> emit hook -> real driver -> runWorkflowScript.
 // * Fire-and-forget semantics belong to the caller (this returns the settlement promise only, no registry bookkeeping).
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
  // The SECOND enforcement point of this run's own bound (docs/dynamic-workflow/concurrency.md, "Two enforcement
  // points"): the scheduler says "may another ask be dispatched", the gate says "may the running ones' next request go out".
  // The start value is this launch's caps (submit: clamped requested value; resume: the journal row's), so a
  // never-retuned run always takes the gate's fast path -- no event, no ticket, byte-identical to before.
  const seatGate = createWorkflowRunSeatGate({ limit: caps.maxConcurrency });
  // The same bound also registers with the process governor (docs/dynamic-workflow/concurrency.md, "The governor"):
  // it raises the growth cap of the provider keys this run used -- the user asked for 40, the bucket cap must reach 40, else the
  // scheduler spawns 40 subagents, the governor grants 2D requests, and most stall "waiting for slot". Cleared at launch settlement.
  // retune lands here via the control surface, swapping the value at the same instant as the seat gate; scheduler, gate and governor never disagree.
  deps.concurrency?.setRunBound(runId, caps.maxConcurrency);
  control?.bindSeatGate(runBoundTarget(seatGate, deps.concurrency, runId));
  // Anchor: from submit (this run's creation) or the journal (resume). Pre-upgrade runs have
  // neither -> absent, progress events carry no launchInputId and subagents don't report.
  const launch = input.launch ?? readRunLaunchAnchor(deps.journal, runId);
  // Lineage pointer: given by submit/amend params; on resume the param is absent (createRun wrote
  // it long ago) so it's read from the journal row — keeping run-started payloads identical.
  const lineageFrom = resumedFrom ?? deps.journal.getRun(runId)?.resumedFrom;
  // Default concurrency: the second host-derived field on the run-started payload (wire name concurrencyCeiling). Computed once per
  // launch, not per event -- it is a process fact (core count does not change mid-run) and
  // availableParallelism() is a syscall.
  const defaultConcurrency = resolveWorkflowDefaultConcurrency(deps.availableParallelism);
  // Subagent model: from submit (riding with the anchor) or from the journal (resume reads the same run-launched).
  // Same argument as the anchor, so both paths are shaped alike; pre-upgrade runs have neither -> absent = session model.
  const subagentModel = input.launch?.subagentModel ?? readRunSubagentModel(deps.journal, runId);
  // String -> choice, parsed once per launch. Progress payloads keep the raw string (toProgressPayload below);
  // the actor runtime factory wants the structured choice (reasoning tier included; the pin's two-segment identity cannot carry it back).
  const runSubagentModel =
    subagentModel === undefined ? undefined : parseModelPickerValue(subagentModel);
  // Script-named model bindings: same source and road as the subagent model (from submit, or resume reads the same run-launched).
  // Names resolved once at launch, never re-resolved against the catalog -- a resumed run still runs the models the user approved.
  const modelBindings = input.launch?.modelBindings ?? readRunModelBindings(deps.journal, runId);
  // Subagent permission mode (docs/dynamic-workflow/launch.md, "Permissions inside a run"): what submit gives
  // is the session's mode at run creation; resume reads run-launched only, NEVER the session's current mode --
  // a mid-run switch to Full access must not open up a guarded/build run's subagents.
  const subagentPermissionMode =
    input.launch === undefined
      ? readRunSubagentPermissionMode(deps.journal, runId)
      : input.launch.subagentPermissionMode;

  // The event's journal sequence is known only to appendEvent, and the engine, inside record(),
  // calls journal.appendEvent(...) then SYNCHRONOUSLY driver.emit(...), discarding the returned
  // StoredEvent (engine.ts). So wrap the journal here to capture the assigned sequence:
  // emit always sees the very event just written. Alternatives are worse -- a local counter shifts wholesale on resume (sequence
  // continues from the prior max), and a per-event journal lookup is wasted IO.
  // The "append then emit, one-to-one" premise is test-pinned: the hook-seen sequence must equal
  // listEvents' output item by item.
  const sequenceCapture = createJournalSequenceCapture(deps.journal);

  const makeDriver = createAgentRuntimeWorkflowDriver({
    journal: sequenceCapture.journal,
    emit: (event) => {
      // Event fan-out must never sink the run: hooks are observers; swallow exceptions at this boundary and log.
      try {
        if (deps.onRunEvent === undefined) return;
        deps.onRunEvent(
          toProgressPayload({
            event,
            runId,
            sequence: sequenceCapture.sequenceOf(event),
            ...(toolCallId === undefined ? {} : { toolCallId }),
            // The hole-arrival's two host-derived fields: type from compile artifacts, arrival time from the journal's stamp on this event
            // (cold replay reads the same number from timeCreated, so both payloads are byte-identical).
            ...(input.holeTypeOf === undefined ? {} : { holeTypeOf: input.holeTypeOf }),
            ...(() => {
              const reachedAt = sequenceCapture.timeCreatedOf(event);
              return reachedAt === undefined ? {} : { reachedAt };
            })(),
            ...(launch === undefined ? {} : { launchInputId: launch.inputId }),
            ...(lineageFrom === undefined ? {} : { resumedFrom: lineageFrom }),
            concurrencyCeiling: defaultConcurrency,
            ...(subagentModel === undefined ? {} : { subagentModel }),
            ...(modelBindings === undefined ? {} : { modelBindings }),
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
    // Which submit_result flavor each actor site gets (typed/generic/none) is decided at compile time.
    actorSubmitProfiles: compiled.actorSubmitProfiles,
    runId,
    // Boundary accounting and seed copying both read/write actor session messages (driver side; see workflow-driver.ts's header).
    ...(deps.actorTranscriptStore === undefined
      ? {}
      : { actorTranscriptStore: deps.actorTranscriptStore }),
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    // The process governor's narrow port: present, the driver gives every
    // actor runtime a per-request admission port (passed through in runtimeFactory below); absent, actors run ungated.
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
        // The factory decides port injection and typedness from the profile (create-app.ts createActorRuntime).
        submitProfile,
        // Per-request admission port travels with the two tool ports into runtime deps.
        ...(modelRequestAdmission === undefined ? {} : { modelRequestAdmission }),
        // The escalate port travels with the submit port: core's registration gate is port presence, so always pass it.
        escalatePort,
        // The resume pin: which model this actor last ran on. Must read BEFORE constructing the runtime,
        // because journalActorResolvedModel below writes this round's resolution into the same field.
        //
        // A seed-carried pin is INHERITED (amend-resume): at the revised run's first dispatch its journal has no
        // resolution yet, so the pin can only come from the predecessor -- silently switching models under a continued transcript is exactly the identity change pins prevent. When both
        // exist (revised run resumed after crash) this run's record wins: it is the model this actor ACTUALLY
        // ran in THIS run, more specific than the predecessor's, and the two should be equal anyway. Malformed pins fail loudly per the existing
        // path (workflow-actor-model.ts WorkflowActorPinnedModelError); no fork here.
        pinnedModel:
          pinnedActorModel({ actor, journal: deps.journal, runId }) ?? seed?.resolvedModel,
        // This run's subagent model: ranks ABOVE the pin (workflow-actor-model.ts priority table). It is the user's explicit
        // statement for THIS run (AmendWorkflow with subagent_model is exactly the explicit
        // "switch models on resume"); the pin only guards the implicit default when it is absent. Unlike the pin it carries the reasoning tier all the way down --
        // the journal pin records only the two identity segments.
        ...(runSubagentModel === undefined ? {} : { runSubagentModel }),
        // The persona-named model (highest priority, workflow-actor-model.ts): resolve against this run's binding table into a full choice.
        // A missing name could only come from a type assertion bypassing 9010; throw here at session creation, failing the ask as DriverError.
        ...(() => {
          const actorModel = resolveActorPersonaModel(persona.model, modelBindings);
          return actorModel === undefined ? {} : { actorModel };
        })(),
        ...(subagentPermissionMode === undefined ? {} : { subagentPermissionMode }),
      });
      // Which model the persona's tier actually resolved to, only the built runtime can say (tier mapping in
      // workflow-actor-model.ts). Persist before attaching the session: a failed session persistence fails this ask,
      // but the audit fact "which model ran then" stays in the journal. The rehydrate path writes too:
      // with no pin (pre-upgrade runs) this round is the first resolution on record.
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

  const settlement = runWorkflowScript({
    askSpecs: compiled.askSpecs,
    sitePhases: compiled.sitePhases,
    caps,
    // Under SEA the spawn strategy must change; non-SEA passes nothing.
    ...(childSpawn === undefined ? {} : { childSpawn }),
    cwd,
    lowered: compiled.lowered,
    makeDriver,
    // When the entry file cannot be written into the project .zcode/, the harness falls back to the OS temp dir and logs once -- the run still starts,
    // but this line is the only clue for "why is there no workflow-runs archive in the project".
    onWarning: (warning) => {
      deps.logger?.warn?.("Dynamic workflow entry file fell back to the OS temp dir", {
        event: "dynamic_workflow.entry_file.fallback",
        module: "bootstrap.app",
        runId,
        ...warning,
      });
    },
    // name rides the same metadata road as scriptText: the harness passes it into EngineConfig verbatim (on resume the journal
    // hit short-circuits createRun; passing it is harmless and keeps submit/resume launch inputs shape-equal).
    ...(name === undefined ? {} : { name }),
    // Args ride the same metadata road as name/scriptText, plus one destination: the harness both
    // passes them to EngineConfig (args_json) and puts them into the spawn payload for the sandbox.
    ...(args === undefined ? {} : { args }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    runId,
    // Persist the author's original text and its hash, not the lowered bodies (resume's comparison basis is the original).
    scriptHash: compiled.scriptHash,
    scriptText,
    // The launch anchor persists with the run: after a restart, tool-card join and resume notifications can only restore it from dwf_run.
    ...(toolCallId === undefined ? {} : { toolCallId }),
    // Amend-continuation: the lineage pointer persists (once, at createRun) and the import cache injects into the engine (plain data, zero core IO).
    ...(resumedFrom === undefined ? {} : { resumedFrom }),
    ...(importedCache === undefined ? {} : { importedCache }),
    // The usage baseline rides with the cache: the engine writes it as spent_tokens' initial value at createRun, ignored when the row exists.
    ...(input.inheritedTokens === undefined ? {} : { inheritedTokens: input.inheritedTokens }),
    // The anchor journals only in the creation life (engine-side gate); harmless to pass on resume.
    ...(launch === undefined ? {} : { launch }),
    signal,
    // Control surface and signal share one seam: that one is "stop this run", this one "change one setting of this run".
    // The harness binds in the same synchronous slice the engine is constructed (harness.ts), so the run is amendable from its first event.
    ...(control === undefined ? {} : { control }),
    validate: validateFn,
  });
  // The governor bound ends with the launch: after settlement (including failure/cancel) this run raises no key's growth cap,
  // and caps above the new limit are pulled down on the spot (limit_lowered).
  return settlement.finally(() => deps.concurrency?.clearRunBound(runId));
}

/**
 * Spawn strategy for the sandbox child: under SEA, self-re-exec via a hidden subcommand; otherwise
 * `node --max-old-space-size=… <entry>`）。
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
 // * Resume rehydration: the journal already records the actor's session id => a re-attach (session row and messages long persisted;
 // * mintActorSessionId is pure so the sessionId IS the original one; driver-side cross-checks exist too).
 // * resumeFromStore rebuilds messageHistory from persisted message/part rows; an interrupted tool call is pinned by the
 // * hydrator as "[Tool execution was interrupted before resume]" -- exactly the right semantics for the killed ask.
 *
 // * SessionNotFound (session row cleaned) is not an error but a recorded exception: fall back to the fresh-persist path, the actor starts from an empty context -- more honest than deadlocking the run.
 // * Other exceptions propagate (low layers never swallow; house rule).
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
    // Session row and task link were persisted in the previous life (both upserts); a re-attach rebuilds neither.
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
 * script-workflow-runtime.ts）。
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
      // `root_workflow_run_id text references workflow_run(id)`（migration 0007，
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
 // * A built actor runtime must already have a model choice: the child inherits the parent's current selection (script-workflow-child-runtime.ts);
 // * without one it cannot even send its first model request. Fail loudly here rather than persisting an empty pin for "no model".
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
 // * Only resume reads a value: the engine's replay of createActor carry-forwards the field;
 // * a fresh run has no resolution at runtime-factory time, naturally absent. MUST read before building the runtime,
 // * because journalActorResolvedModel writes this round's resolution into the same field -- reading late would
 // * mistake this round's result for the previous pin. pin vs this run's subagentModel priority: workflow-actor-model.ts
 // * (run choice above; the pin only guards the default when no run choice exists -- the persisted half of the persona-freeze invariant).
 */
export function pinnedActorModel(input: {
  actor: ActorRef;
  journal: JournalStorePort;
  runId: string;
}): string | undefined {
  return input.journal.getActor(input.runId, input.actor.siteId, input.actor.ordinal)
    ?.resolvedModel;
}
