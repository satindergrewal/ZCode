// ============================================================
// Dynamic Workflow Run Service (the production DynamicWorkflowRunPort).
// ============================================================
// This service:
// compiles once -> registers the AbortController -> starts the engine (fire-and-forget; executor
// in dynamic-workflow-run-launch.ts) -> hands the run's observation surface (snapshot/wait/cancel/
// resume/enumeration/event paging) out through narrow ports.
//
// Seven invariants; violating any manifests far from its cause, hence the header:
//
//   1. The ENGINE owns createRun exclusively. This service never pre-inserts a dwf_run row: a pre-existing row flips the engine constructor into
//      its resume branch (engine.ts): node counts recompute from settled records, budget restores from the record, status is
//      overwritten by updateRunStatus. A fresh run taking the resume branch does not error -- it silently "recovers" from an empty journal.
//      resume depends on exactly this mechanism in reverse: it re-launches an existing runId so the engine hits the existing row.
//      The two entries point opposite ways and never share a gate.
//   2. COMPILE EXACTLY ONCE. One ts.Program feeds the site table, schema synthesis and lowering; scriptHash is
//      computed by this service (the harness deliberately does not: hashing "the text it sees" would persist the
//      lowered bodies' hash, and resume's comparison basis would silently be wrong).
//   3. NO JOURNAL, NO SERVICE. Durability is a run's premise: a run that silently loses persistence
//      is worse than no run (no resume basis, no detail source, no record after cancel). On narrowing failure
//      the {@link createDynamicWorkflowRunService} caller gets undefined and CreateWorkflow
//      falls back to the placeholder diagnostic path -- a visible degradation, not a broken feature.
//   4. CONVERGE THIS SESSION'S ORPHAN RUNS AT CONSTRUCTION, and only this session's. See {@link reconcileOrphanRuns}:
//      running rows left by dead processes are decidable only at this instant, and "this session" is the only safe scope.
//      Converge to stopped(interrupted) (with the Interrupted failure code), recoverable like every other stopped.
//   5. RESUME REPLACES THE REGISTRY ENTRY BEFORE LAUNCH. waitForTask answers a non-registered runId straight from the
//      journal snapshot -- one step late and the re-armed notification watcher settles against the stale terminal row.
//   6. EVERY LAUNCH REGISTERS RESIDENT-BLOCKING WORK IN LAUNCH'S OWN SYNCHRONOUS SLICE. The engine lives in the parent App's closure,
//      outside the runtime task registry; the resident pool then sees only "registry retired" and closes an App with in-flight engines
//      as idle (10 min), and resume starts a second engine. One registration point:
//      {@link trackSettlement}, shared by submit/amend/resume -- counted in launch's synchronous slice,
//      released in settlement's finally.
//   7. CLOSE STOPS EVERY RUN THIS SERVICE OWNS, AND THE ENGINE WRITES THAT ROW. On App close the service
//      aborts every in-flight entry with "interrupted" and AWAITS settlement (no timeout, no polling); the harness normalizes
//      the reason into engine.stop("interrupted", Interrupted), so rows land via the engine's normal finishRun
//      tail as resumable stopped(interrupted). The service never writes terminal rows itself: bypassing the engine creates
//      a second writer of dwf_run (invariant 1's argument) and no run-settled would exist in the journal.
//      After close, submit/amend/resume throw outright -- the resident-pool close gate already blocks commands, so reaching here is a
//      wiring error, not worth widening contracts' rejection enum (invariant 1's argument).

import type { DwfRunSessionListItem } from "@zcode/adapters/storage";
import type {
  CollaborationMode,
  TraceContext,
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunArtifactBytes,
  DynamicWorkflowRunArtifactItemPage,
  DynamicWorkflowRunArtifactItemsResult,
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResult,
  DynamicWorkflowRunWorkspaceNodeResultQuery,
  DynamicWorkflowRunEventPage,
  DynamicWorkflowRunEventsResult,
  DynamicWorkflowResolveQuestionResult,
  DynamicWorkflowRunPort,
  DynamicWorkflowRunProgressPayload,
  DynamicWorkflowRunResumeResult,
  DynamicWorkflowRunRetuneRequest,
  DynamicWorkflowRunRetuneResult,
  DynamicWorkflowRunSessionSummary,
  DynamicWorkflowRunSnapshot,
  DynamicWorkflowRunAmendRequest,
  DynamicWorkflowRunAmendResult,
  DynamicWorkflowRunCancelInitiator,
  DynamicWorkflowRunFillHoleRequest,
  DynamicWorkflowRunSubmitRequest,
  DynamicWorkflowRunSubmitResult,
  FillWorkflowHoleResult,
  ExecutionPort,
  FileSystemPort,
  Logger,
  SessionId,
  ModelRequestAdmission,
  ModelSelection,
  ToolArtifactStorePort,
  WorkflowEscalatePort,
  WorkflowSubmitPort,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import {
  WORKFLOW_RUN_EVENTS_PAGE_LIMITS,
  WORKFLOW_RUNS_LIMITS,
} from "@zcode/shared/zcode-protocol-v4";
import type {
  ActorSubmitProfile,
  ActorRef,
  Caps,
  JournalStorePort,
  PersonaSpec,
} from "@zcode/dynamic-workflow";
import { toProtocolEvent } from "./dynamic-workflow-run-launch.js";
import { readWorkflowArtifactBytes } from "./dynamic-workflow-run-artifact-read.js";
import { replayRunProgress } from "./dynamic-workflow-run-replay.js";
import { listArtifactItemsFrom } from "./dynamic-workflow-run-artifact-queries.js";
import {
  pageByCountOnly,
  supportsEventPages,
  supportsRunEnumeration,
  supportsRunIntrospection,
  type DynamicWorkflowTaskLinkStore,
} from "./dynamic-workflow-run-journal.js";
import { createRunIntrospectionMethods } from "./dynamic-workflow-run-introspection.js";
import { reconcileOrphanRuns } from "./dynamic-workflow-run-reconcile.js";
import {
  resumeDynamicWorkflowRun,
  amendDynamicWorkflowRun,
  submitDynamicWorkflowRun,
  type DynamicWorkflowRunEntryContext,
} from "./dynamic-workflow-run-submit.js";
import {
  listWorkspaceNodesFrom,
  readWorkspaceNodeResultFrom,
} from "./dynamic-workflow-run-workspace.js";
import {
  artifactsOf,
  settleOrAbort,
  snapshotOf,
  toSessionSummary,
  type RunRegistryEntry,
} from "./dynamic-workflow-run-observation.js";
import {
  createRunServiceLifecycle,
  type DynamicWorkflowRunSettledNotice,
} from "./dynamic-workflow-run-lifecycle.js";
import { retuneRunConcurrency } from "./dynamic-workflow-run-retune.js";
import { fillDynamicWorkflowHole } from "./dynamic-workflow-run-fill.js";
import { runHolesOf } from "./dynamic-workflow-run-holes.js";
import type { ActorTranscriptStore } from "./workflow-actor-transcript.js";
import {
  normalizeRunConcurrency,
  resolveWorkflowDefaultConcurrency,
} from "./workflow-default-concurrency.js";
import type { WorkflowConcurrencyPort } from "./workflow-concurrency-governor.js";
import type { WorkflowSubagentPermissionMode } from "./workflow-actor-permission.js";
import type { AgentRuntimeWorkflowDriverDeps } from "./workflow-driver-types.js";
import {
  createWorkflowEscalationRegistry,
  type WorkflowEscalationRegistry,
} from "./workflow-escalation-registry.js";

/** Default/cap count for listRunsForSession (bounded enumeration; never unbounded scans). */
const DEFAULT_LIST_RUNS_LIMIT = 16;
const MAX_LIST_RUNS_LIMIT = 64;

/** Actor runtime factory input. runId included: session id and task link are both run-scoped. */
export interface DynamicWorkflowActorRuntimeInput {
  runId: string;
  sessionId: SessionId;
  actor: ActorRef;
  persona: PersonaSpec;
  submitPort: WorkflowSubmitPort;
  /**
   * This actor's submit profile: untyped injects no submitPort (no tool), mono injects port +
   * typed declaration, generic port only. The factory is the single place this maps (same seam as
   * the subagent tool surface's fixed disallowlist).
   */
  submitProfile: ActorSubmitProfile;
  /**
   * Session-level escalation port: when injected, registers the `escalate` tool on that actor
   * session, isomorphic to submitPort. ALWAYS present, no opt-in — the actor most likely to hit an
   * unforeseen wall is precisely the one the author didn't mark.
   */
  escalatePort: WorkflowEscalatePort;
  /**
   * The model this actor resolved last time (journal resolvedModel, providerId/modelId); only
   * resume supplies it. Without {@link DynamicWorkflowActorRuntimeInput.runSubagentModel} the
   * factory must prefer it over the parent session model: see the pin's rationale in
   * workflow-actor-model.ts (persisted half of the frozen-persona invariant).
   */
  pinnedModel?: string;
  /**
   * This run's own subagent model (the subagent_model of CreateWorkflow / AmendWorkflow, parsed back from the
   * journal's run-launched event). The whole selection, reasoning level included.
   *
   * Precedence **highest**, above {@link DynamicWorkflowActorRuntimeInput.pinnedModel} and the parent session model
   * (workflow-actor-model.ts's workflowActorModelPolicy): this is the user's explicit statement for this run; the pin
   * only guards the implicit default absent it. Subagents only; the main agent untouched. Absent = pin or session model.
   */
  runSubagentModel?: ModelSelection;
  /**
   //   * The model this actor's persona names, resolved through this run's binding table (run-launched's modelBindings) into a full
   //   * choice (docs/dynamic-workflow/launch.md, "Models the script names"). Ranks above {@link runSubagentModel}:
   //   * it is the choice written for this one subagent. Absent = the persona named no model.
   */
  actorModel?: ModelSelection;
  /**
   //   * This run's subagent permission mode (the one on journal run-launched; docs/dynamic-workflow/launch.md
   //   * "Permissions inside a run"). The factory runs the actor in this mode (workflow-actor-permission.ts);
   //   * absent = YOLO.
   */
  subagentPermissionMode?: WorkflowSubagentPermissionMode;
  /**
   //   * This actor runtime's model-request admission port (docs/dynamic-workflow/concurrency.md, "One ticket per request attempt"):
   * port exists; the factory passes it into runtime deps verbatim. Absent = ungated.
   */
  modelRequestAdmission?: ModelRequestAdmission;
}

export interface DynamicWorkflowRunServiceDeps {
  /** Durable journal (dwf_* tables). Missing = no service; header invariant 3. */
  journal: JournalStorePort;
  /**
   * Launch-anchor resolution: the inputId of the parent runtime's active turn at submit time;
   * undefined when trace.turnId differs from the active turn or none is active (submit-side
   * fallback mints one). Absent = the host has no "current turn" notion (CLI, test rigs).
   */
  resolveLaunchInputId?: (trace: TraceContext) => string | undefined;
  /**
   * This service instance's parent session id (= this app's session; see create-app.ts).
   *
   //   * It is the SCOPE of orphan convergence and enumeration, hence not optional: absent leaves two paths -- a global sweep
   //   * (would kill sibling sessions' in-flight runs in the same process: one sqlite, separate in-memory registries) or no convergence
   //   * at all (the "run stuck running forever" bug). Prefer the wiring error surfacing at compile time.
   */
  parentSessionId: string;
  /**
   //   * The parent session's CURRENT permission mode (create-app hooks runtime.getMode()). Read once per creation life
   //   * (submit/amend), recorded on run-launched (docs/dynamic-workflow/launch.md,
   //   * "Permissions inside a run"); resume reads the event, never this. Lazy: the run service precedes the runtime.
   //   * Absent = the host has no mode concept (CLI test assemblies); subagents stay YOLO.
   */
  permissionMode?: () => CollaborationMode;
  /** Filesystem port for world-read (files.glob / files.read / files.grep). */
  fileSystemPort: FileSystemPort;
  /** Child-process exec port for git.* world-read (cwd = the run's workspace). */
  executionPort: ExecutionPort;
  /**
   //   * Byte destination for user-facing artifacts (artifact.file / artifact.markdown), passed to the driver verbatim. Note: artifact here means OUTPUT SHOWN TO THE
   //   * USER, not the engine's internal top-level return value.
   *
   * OPTIONAL: assemblies without a store (tests, minimal stubs) still run; content members just
   * reject with a named ArtifactStoreUnavailable — a script-catchable failure, not a silent
   * degradation. Session scope is this service's {@link DynamicWorkflowRunServiceDeps.parentSessionId}
   * (= this app's session, i.e. the parent).
   */
  artifactStore?: ToolArtifactStorePort;
  /** Builds an actor's child AgentRuntime (production wraps createScriptWorkflowAgentRuntime). */
  createActorRuntime: (input: DynamicWorkflowActorRuntimeInput) => AgentRuntime;
  /** Actor-session task-link persistence; absent -> skip the link (session row still persisted). */
  taskLinkStore?: DynamicWorkflowTaskLinkStore;
  /**
   * Transcript access surface for actor sessions (production: the session store itself). The driver uses it for
   * two things: ask-boundary accounting counts, and the transcript-truncation copy for amendment-diverged actors.
   *
   //   * Absent = no boundary accounting at all; the run still finishes, it just cannot be a revision's predecessor (the service's
   //   * "no-marker predecessors rejected wholesale" gate blocks it). Optional not required: assemblies without a session store have no
   //   * transcript to count anyway; seeded session creation fails loudly driver-side when absent.
   */
  actorTranscriptStore?: ActorTranscriptStore;
  /**
   * Engine event hook: hands over a **ready-to-append session event payload** (bounded payload + journal sequence +
   * two derived fields); the caller only appends it to the parent session (create-app wires the runtime record).
   *
   * Why prepared here rather than assembled by the caller: sequence and spentTokens are readable only from the
   * journal, which is this service's dependency; the actor session id can only be computed by its minting function.
   * Pushing all three to the caller would copy three contracts into a layer without the journal.
   *
   * The second argument is **routing** info, deliberately separate from the payload: parentSessionId decides which
   * session the event lands in, but is not payload (the event is already in that session; duplicating it is
   * redundant). Callers use it for the identity gate, see {@link createDynamicWorkflowRunProgressSink}.
   */
  onRunEvent?: (
    progress: DynamicWorkflowRunProgressPayload,
    routing: { parentSessionId?: string },
  ) => void;
  logger?: Logger;
  /** Injected concurrency probe; pins dual-core for caps-default tests (floor must be 1). */
  availableParallelism?: () => number;
  /**
   * Narrow port of the process-wide concurrency governor, relayed to the driver verbatim:
   * effective concurrency = min(run caps.maxConcurrency, the provider key's shared live cap).
   * Absent = per-run bound only (test rigs, governor-less hosts).
   */
  concurrency?: WorkflowConcurrencyPort;
  /**
   * Register one launch as the parent runtime's **residency-blocking work**.
   *
   * Engines live in the session App's closure, outside the runtime task registry, while the residency pool read
   * only the registry - a running run read as idle, App closed, resume spawning a second engine. Registration goes
   * through the runtime's single hook (trackResidencyBlockingWork), so the pool need not guess about sidecars.
   *
   //   * Absent = the host has no residency concept (one-shot CLI, test assemblies): the run finishes, it just never blocks close.
   */
  registerResidencyBlockingWork?: (work: Promise<unknown>) => void;
  /**
   * The driver's clock and timers: run-level stall clock and transient-failure backoff redrive
   * read it. TEST INJECTION ONLY (the fault matrix compresses the 2s->60s redrive curve and the
   * 20-minute stall window to milliseconds); production never sets it — absent, real time.
   */
  driverClock?: AgentRuntimeWorkflowDriverDeps["clock"];
  /**
   //   * Mint a draft by the inline rule (docs/dynamic-workflow/launch.md, "The draft after a fill"): when a fill
   //   * lands on a run without a draft, the effective script needs a home. The rule (slug, -2/-3 suffixes, exclusive-create, dir
   //   * .gitignore) has one implementation in the tool layer, injected at host assembly, never copied here. Returns undefined on failure
   //   * (never throws). Absent = no mint; the fill still succeeds, the reply just lacks a path.
   */
  writeWorkflowDraft?: (input: {
    cwd: string;
    name: string;
    source: string;
  }) => Promise<{ path: string } | undefined>;
}

export {
  isDynamicWorkflowTaskLinkStore,
  resolveDynamicWorkflowJournalStore,
  supportsRunIntrospection,
  type DynamicWorkflowTaskLinkStore,
} from "./dynamic-workflow-run-journal.js";

/**
 * The service's full surface: {@link DynamicWorkflowRunPort} (engine/tool layer) plus two
 * SESSION-level lifecycle read facades. Their only consumer is the host's provider-registry safety
 * boundary: subagents share the parent session's live adapter, so an in-flight run is an active
 * Loop of the parent session — registry replace must wait for settlement.
 */
interface DynamicWorkflowRunService extends DynamicWorkflowRunPort {
  /** Runs not yet settled (entries with `terminal === undefined` in the registry). */
  countLiveRuns(): number;
  /**
   //   * Settlement subscription: exactly one notify per run entering a terminal state (completed/errored/stopped, launch failures included),
   //   * after bookkeeping (the count already decremented). Returns an unsubscribe. Listener throws log only, never affect settlement.
   */
  subscribeRunSettled(listener: (notice: DynamicWorkflowRunSettledNotice) => void): () => void;
  /**
   * Stop every in-flight run this service owns and await settlement (header invariant 7). NOT on
   * the contracts {@link DynamicWorkflowRunPort}: it's the host App's lifecycle action, not an
   * engine/tool capability. Idempotent — a second call returns the same promise, aborting nothing.
   */
  close(): Promise<void>;
}

/**
 // * Build the workflow run service. Returns {@link DynamicWorkflowRunService}: the port impl + two session-level
 // * lifecycle read surfaces (in-flight count, settlement subscription) that stay OUT of contracts' narrow port -- they serve
 // * the host's registry safety boundary, not the engine or tool layer.
 */
export function createDynamicWorkflowRunService(
  deps: DynamicWorkflowRunServiceDeps,
): DynamicWorkflowRunService {
  const runs = new Map<string, RunRegistryEntry>();
  /**
   //   * The escalation Q&A stall table. ONE table across all in-flight runs of this service:
   //   * qid global uniqueness exists for this -- resolveQuestion takes one opaque token; making the model pair (runId, qid)
   * (runId, qid) pairing is a mismatch incubator. Purely in-memory, dying with the stalled deferred (cleared on process death; resume
   //   * heals by the actor re-asking; a persisted pending table would only lie).
   */
  const escalations: WorkflowEscalationRegistry = createWorkflowEscalationRegistry();
  /** Per-run fill serial chain (dynamic-workflow-run-fill.ts header); the key deletes when drained. */
  const fillQueues = new Map<string, Promise<unknown>>();

  // Converge at construction: this instance owns zero in-flight runs right now, so this session's non-terminal rows are all dead-process relics.
  // See header invariant 4 and {@link reconcileOrphanRuns}.
  reconcileOrphanRuns(deps);

  /**
   //   * This process's default concurrency D (docs/dynamic-workflow/concurrency.md, "Two bounds on a run").
   //   * One implementation shared with the governor's bucket seed (decision 30): a run's default bound and the bucket seed always agree.
   *
   //   * Four readers inside this service, all through this function: the default for a new run's caps, the port's
   //   * {@link DynamicWorkflowRunPort.defaultConcurrency} (the tool layer's "(default)" label and its not-worth-mentioning test),
   * test with it), both read sides' maxConcurrency gate, and the derived field on the run-started payload.
   */
  const defaultConcurrency = (): number =>
    resolveWorkflowDefaultConcurrency(deps.availableParallelism);

  // caps reduce to the concurrency bound (docs/dynamic-workflow/authoring.md: token budgets and node caps removed wholesale,
  // no wall-clock timeout; cancellation is the only stop). Absent = default; given, used as-is (floored, min 1),
  // above default too -- no ceiling (docs/dynamic-workflow/concurrency.md).
  const caps = (requested?: number): Caps => {
    return { maxConcurrency: normalizeRunConcurrency(requested, defaultConcurrency()) };
  };

  // Introspection surfaces attach by capability probe (those four queries are not on the engine port). When absent, the two OPTIONAL members
  // below are not implemented at all: the consumer's typeof port.listRuns === "function" probe reads false, and the tool layer normalizes it to
  // the business failure "this session lacks the capability" -- never a silent empty list.
  const introspection = supportsRunIntrospection(deps.journal) ? deps.journal : undefined;

  // The bodies of the lifecycle bookkeeping (settle / close / close gate / foreign-terminal row traces; header invariants 6, 7) live in
  // dynamic-workflow-run-lifecycle.ts: they borrow only this registry and journal, via narrow dependencies.
  const {
    countLiveRuns,
    subscribeRunSettled,
    trackSettlement,
    close,
    assertOpen,
    noteForeignTerminalRow,
  } = createRunServiceLifecycle({
    journal: deps.journal,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    parentSessionId: deps.parentSessionId,
    ...(deps.registerResidencyBlockingWork === undefined
      ? {}
      : { registerResidencyBlockingWork: deps.registerResidencyBlockingWork }),
    runs,
  });

  // Both entry implementations (submit/resume) live in dynamic-workflow-run-submit.ts: they borrow
  // only this registry, parking table, caps, and settlement bookkeeping, via ctx — no duplication here.
  const entryContext: DynamicWorkflowRunEntryContext = {
    deps,
    runs,
    escalations,
    caps,
    trackSettlement,
  };

  return {
    countLiveRuns,
    subscribeRunSettled,
    close,

    // The three entries' close gate. async only to turn this wiring error into a rejection instead of a sync throw; no await between the gate
    // and the delegation, so invariant 6's "register in launch's synchronous slice" is unaffected.
    async submit(
      request: DynamicWorkflowRunSubmitRequest,
    ): Promise<DynamicWorkflowRunSubmitResult> {
      assertOpen();
      return submitDynamicWorkflowRun(entryContext, request);
    },

    async amend(request: DynamicWorkflowRunAmendRequest): Promise<DynamicWorkflowRunAmendResult> {
      assertOpen();
      return amendDynamicWorkflowRun(entryContext, request);
    },

    /**
     //     * This process's default concurrency (port contract: {@link DynamicWorkflowRunPort.defaultConcurrency}).
     //     * The SAME {@link defaultConcurrency} as caps': the confirm dialog's "default N" must be the very number an
     //     * uncapped run would run with.
     */
    defaultConcurrency,

    /**
     * Retune an in-flight run's own concurrency cap (port contract at
     * {@link DynamicWorkflowRunPort.retuneConcurrency}; implementation in dynamic-workflow-run-retune.ts).
     *
     //     * Deliberately NOT behind the close gate: the three launch entries assertOpen because they start engines; this one starts nothing --
     //     * in a closing service every entry is settling and the liveness check reports not_live on its own.
     */
    async retuneConcurrency(
      request: DynamicWorkflowRunRetuneRequest,
    ): Promise<DynamicWorkflowRunRetuneResult> {
      return retuneRunConcurrency({ runs, journal: deps.journal, defaultConcurrency }, request);
    },

    async resume(runId: string): Promise<DynamicWorkflowRunResumeResult> {
      assertOpen();
      return resumeDynamicWorkflowRun(entryContext, runId);
    },

    async listRunsForSession(limit?: number): Promise<DynamicWorkflowRunSessionSummary[]> {
      if (!supportsRunEnumeration(deps.journal)) {
        // No enumeration query (in-memory journal): an empty list is the honest answer — in-memory
        // runs never outlive the process; post-restart discovery has nothing to restore.
        return [];
      }
      const capped = Math.max(1, Math.min(limit ?? DEFAULT_LIST_RUNS_LIMIT, MAX_LIST_RUNS_LIMIT));
      let rows: DwfRunSessionListItem[];
      try {
        rows = deps.journal.listRunsByParentSession(deps.parentSessionId, capped);
      } catch (error) {
        deps.logger?.warn?.("Dynamic workflow run enumeration failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "dynamic_workflow.run.list_failed",
          module: "bootstrap.app",
        });
        return [];
      }
      // The live entry joins the summary: the enumeration surface shares the priority rule with snapshot/list/detail (rule three),
      // or this surface alone would show a run killed by a foreign write.
      return rows.map((row) => toSessionSummary(row, runs.get(row.runId)));
    },

    async replayProgressForSession(input: {
      excludeRunIds: ReadonlySet<string>;
    }): Promise<DynamicWorkflowRunProgressPayload[]> {
      if (!supportsRunEnumeration(deps.journal)) return [];
      let rows: DwfRunSessionListItem[];
      try {
        // Same constant as the projection's eviction: cold state = what one long-lived process would hold right now.
        rows = deps.journal.listRunsByParentSession(
          deps.parentSessionId,
          WORKFLOW_RUNS_LIMITS.maxRuns,
        );
      } catch (error) {
        deps.logger?.warn?.("Dynamic workflow run replay enumeration failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "dynamic_workflow.run.replay_failed",
          module: "bootstrap.app",
        });
        return [];
      }
      const payloads: DynamicWorkflowRunProgressPayload[] = [];
      // Enumeration is newest-first; replay wants oldest-first so the reducer's eviction matches live arrival order.
      for (const row of [...rows].reverse()) {
        // Runs whose events the caller already holds in memory (ran in this process) and registry-in-flight runs do not replay:
        // their events all sit in memory stores; feeding them again would let run-started reset the phase to the start.
        if (input.excludeRunIds.has(row.runId) || runs.has(row.runId)) continue;
        // Default concurrency shares the source with the live side: the cold replay's run-started payload must be byte-identical to live's.
        payloads.push(...replayRunProgress(row, deps.journal, defaultConcurrency()));
      }
      return payloads;
    },

    async getTask(taskId: string): Promise<DynamicWorkflowRunSnapshot | undefined> {
      noteForeignTerminalRow(taskId);
      return snapshotOf(
        taskId,
        runs,
        deps.journal,
        escalations.pendingFor(taskId),
        defaultConcurrency(),
        // Holes and stalled questions are projected HERE under the same rule and passed in: waiting reads the engine's stall table (via the entry's control surface).
        runHolesOf(taskId, runs.get(taskId), deps.journal),
      );
    },

    /**
     //     * Fill a waiting hole's body (port contract {@link DynamicWorkflowRunPort.fillHole}; body in
     //     * dynamic-workflow-run-fill.ts). Like retuneConcurrency, deliberately NOT behind the close gate: it starts nothing,
     //     * and a closing service's engine rejects with settled on its own.
     */
    async fillHole(request: DynamicWorkflowRunFillHoleRequest): Promise<FillWorkflowHoleResult> {
      return fillDynamicWorkflowHole({ deps, runs, fillQueues }, request);
    },

    /**
     //     * The run's archived script (port contract {@link DynamicWorkflowRunPort.getScript}). Registry entry first:
     //     * in the submit -> createRun gap the journal has no row, and the entry holds the same bytes. The journal copy is also
     //     * what resume's hash check reads, so AmendWorkflow's carry-over, the script_unchanged precheck and resume
     //     * never hold two answers to "what is this run running".
     */
    async getScript(runId: string): Promise<string | undefined> {
      return runs.get(runId)?.scriptText ?? deps.journal.getRun(runId)?.scriptText;
    },

    async waitForTask(
      taskId: string,
      options?: { signal?: AbortSignal },
    ): Promise<DynamicWorkflowRunSnapshot | undefined> {
      const entry = runs.get(taskId);
      // Not in the registry: either a pre-process run (journaled) or entirely unknown; neither is waitable.
      if (entry === undefined) {
        return snapshotOf(
          taskId,
          runs,
          deps.journal,
          escalations.pendingFor(taskId),
          defaultConcurrency(),
          runHolesOf(taskId, undefined, deps.journal),
        );
      }
      if (entry.terminal === undefined) await settleOrAbort(entry.settlement, options?.signal);
      // Stall entries re-project AFTER the wait: during it the question may be answered or withdrawn with the cancel.
      return snapshotOf(
        taskId,
        runs,
        deps.journal,
        escalations.pendingFor(taskId),
        defaultConcurrency(),
        runHolesOf(taskId, entry, deps.journal),
      );
    },

    /**
     * Answer a blocking question escalated by an actor. Table lookup -> driver settle -> the escalate tool result
     * becomes this text and the actor's turn continues in place. **Run status never moves**: an escalation is a slow
     * tool call inside an ask, not a run lifecycle event (escalate deliberately never terminates/freezes a run).
     *
     * Discrimination and wording for the three structured refusals live in the registry (only it knows whether a qid
     * never existed, was answered, or was withdrawn with its ask). This method deliberately adds no second guess -
     * judging twice eventually yields different answers per layer for the same qid.
     */
    async resolveQuestion(
      qid: string,
      answer: string,
    ): Promise<DynamicWorkflowResolveQuestionResult> {
      return escalations.resolve(qid, answer);
    },

    async cancel(
      runId: string,
      initiator: DynamicWorkflowRunCancelInitiator = "user",
    ): Promise<boolean> {
      const entry = runs.get(runId);
      // Unknown (or settled) run: nothing to abort. Return false so the layer above normalizes to a structured
      // not_found instead of reporting a cancellation that did not happen.
      if (entry === undefined || entry.terminal !== undefined) return false;
      // abort is the harness's only true stop: abort the in-flight ask, kill child processes; the engine settles
      // stopped via stop(initiator) (completed journal entries kept -> resumable). The abort reason is the
      // initiator - the harness reads signal.reason to pick stopped(user) vs stopped(model), so the cause lands in
      // the journal instead of living only in the background task registry.
      entry.controller.abort(initiator);
      return true;
    },

    async listEvents(
      runId: string,
      options: DynamicWorkflowRunEventPage,
    ): Promise<DynamicWorkflowRunEventsResult> {
      // The audit surface wants the events byte-exact (report items included, trimmed by the payload bound on the wire), but a page's
      // count and bytes are both bounded (docs/execution-engine.md, "Reading the journal"): absent caller values take the protocol's
      // two caps. The gateway always sends both; the defaults here only stop other callers from issuing one unbounded read.
      const page = {
        ...(options.afterSequence === undefined ? {} : { afterSequence: options.afterSequence }),
        limit: options.limit ?? WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxEvents,
        maxBytes: options.maxBytes ?? WORKFLOW_RUN_EVENTS_PAGE_LIMITS.maxBytes,
      };
      const { events, hasMore } = supportsEventPages(deps.journal)
        ? deps.journal.listEventPage(runId, page)
        : pageByCountOnly(deps.journal, runId, page);
      return {
        events: events.map((stored) => toProtocolEvent(stored.sequence, stored.event)),
        hasMore,
      };
    },

    /**
     * This run's user-facing artifact listing. The durable read for UI cold-resume and the hub details view:
     * the workflowRuns.artifacts projection is memory-only and empty after restart; the version history's permanent
     * home has always been the journal's kind=artifact rows.
     *
     * The merge rules are reused wholesale from {@link artifactsOf} - the terminal snapshot (getTask) and this method
     * must agree on **one** list; two private merges eventually diverge on does-a-failed-row-count-as-a-version.
     *
     * Terminology: artifact here is what the script published to the user, not the port's output (the script
     * top-level return value, also called artifact inside the engine).
     *
     * Unknown runId and no-artifact-read-surface both return undefined: one business fact to the caller.
     */
    async listArtifacts(runId: string): Promise<readonly DynamicWorkflowRunArtifact[] | undefined> {
      return artifactsOf(runId, deps.journal).artifacts;
    },

    /**
     * Report items fed to a preset artifact, paged by ascending journal sequence (the board reader).
     * An out-of-range cursor yields an empty page, not an error - reaching the end is a normal paging outcome.
     */
    async listArtifactItems(
      runId: string,
      artifactId: string,
      page: DynamicWorkflowRunArtifactItemPage,
    ): Promise<DynamicWorkflowRunArtifactItemsResult> {
      return listArtifactItemsFrom(deps.journal, runId, artifactId, page);
    },

    /**
     * Read one artifact version's bytes. The authorization chain (run belongs to this session and the journal has
     * the version's completed row => use the row's uri) lives wholly in {@link readWorkflowArtifactBytes}, diagram
     *
     * parentSessionId is **this service's** (= this app's session), deliberately not a parameter: the instance is
     * constructed per parent session; letting callers pass any session opens a cross-session read hole - same
     * argument as listRunsForSession, enumeration there, bytes here.
     */
    async readArtifact(
      runId: string,
      artifactId: string,
      version: number,
    ): Promise<DynamicWorkflowRunArtifactBytes | undefined> {
      return readWorkflowArtifactBytes(
        {
          journal: deps.journal,
          parentSessionId: deps.parentSessionId,
          ...(deps.artifactStore === undefined ? {} : { artifactStore: deps.artifactStore }),
        },
        runId,
        artifactId,
        version,
      );
    },

    /**
     * Workspace transcript listing and bodies. Same authorization chain
     * as readArtifact (run belongs to this session); both paths - the listing's args are already paths and command
     * lines. All of it in dynamic-workflow-run-workspace.ts.
     */
    async listWorkspaceNodes(
      runId: string,
    ): Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined> {
      return listWorkspaceNodesFrom(
        { journal: deps.journal, parentSessionId: deps.parentSessionId },
        runId,
      );
    },

    async readWorkspaceNodeResult(
      runId: string,
      siteId: string,
      ordinal: number,
      query: DynamicWorkflowRunWorkspaceNodeResultQuery,
    ): Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined> {
      return readWorkspaceNodeResultFrom(
        { journal: deps.journal, parentSessionId: deps.parentSessionId },
        runId,
        siteId,
        ordinal,
        query,
      );
    },

    ...(introspection === undefined
      ? {}
      : createRunIntrospectionMethods({
          introspection,
          journal: deps.journal,
          parentSessionId: deps.parentSessionId,
          runs,
          escalations,
          defaultConcurrency,
        })),
  };
}
