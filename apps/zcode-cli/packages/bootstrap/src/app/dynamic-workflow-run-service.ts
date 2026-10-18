// ============================================================
// Dynamic Workflow Run Service (the production DynamicWorkflowRunPort).
//
// This service:
// compiles once -> registers the AbortController -> starts the engine (fire-and-forget; executor
// in dynamic-workflow-run-launch.ts) -> hands the run's observation surface (snapshot/wait/cancel/
// resume/enumeration/event paging) out through narrow ports.
//
// Seven invariants; violating any manifests far from its cause, hence the header:
//
//   1. The ENGINE owns createRun. This service never pre-inserts dwf_run rows: a pre-existing row
//      flips the engine constructor into its resume branch (engine.ts) — node counts recomputed
//      from completed records, budget restored from the record, status overwritten by
//      updateRunStatus. A fresh run taking the resume branch doesn't error; it silently "resumes"
//      from an empty journal. resume depends on exactly this in reverse: it re-launches an existing
//      runId so the engine hits the existing row. Opposite directions; never share a gate.
//   2. Compile EXACTLY once. One ts.Program feeds site table, schema synthesis, and lowering;
//      scriptHash is computed by this service (the harness deliberately doesn't — hashing "the
// text it sees" would persist the lowered body's hash and silently misalign resume's comparison).
//   3. No journal, no service. Durability is a run's precondition: a run silently losing
//      persistence is worse than no run (no resume basis, no detail source, no record after
// cancel). On narrowing failure {@link createDynamicWorkflowRunService}'s caller gets undefined
// and CreateWorkflow falls back to the placeholder-diagnosis path — a visible degradation, not a
// broken feature.
//   4. Reconcile THIS session's orphan runs at construction, and only this session's. See
//      {@link reconcileOrphanRuns}: dead-process running rows are decidable only at this instant,
//      and "this session" is the only safe scope. Reconciled as stopped(interrupted) (with the
//      Interrupted failure code), recoverable like any other stopped.
//   5. resume replaces the registry entry BEFORE launching. waitForTask answers journal snapshot
//      directly for runIds not in the registry — a late entry has the re-armed notice watcher
//      settle against the stale terminal row.
//   6. Every launch registers as resident-blocking work in the same synchronous slice as the
//      launch. The engine lives in the parent session App's closure, outside the runtime task
//      registry; the resident pool would see only "registry retired" and idle-close an App with a
//      live engine (10 min), then resume spins a second engine. One registration point —
//      {@link trackSettlement}, shared by submit/amend/resume — counted in launch's synchronous
//      slice, released in settlement's finally.
//   7. close stops every run this service owns, and the row is written by the engine. On App close
//      this service aborts every in-flight entry with "interrupted" and AWAITS settlement (no
//      timeout, no polling); the harness normalizes that reason via engine.stop("interrupted",
//      Interrupted), so the row lands as recoverable stopped(interrupted) through the engine's
//      normal finishRun tail. The service never writes terminal rows itself: bypassing the engine
//      mints a second dwf_run writer (invariant 1's argument) and the journal gets no run-settled.
//      After close, submit/amend/resume throw — the resident-pool close gate already blocks
//      commands, so reaching here is a wiring error; don't widen contracts' rejection enum for it
//      (invariant 1's argument).

import type { DwfRunSessionListItem } from "@zcode/adapters/storage";
import type {
  TraceContext,
  DynamicWorkflowRunEvent,
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunArtifactBytes,
  DynamicWorkflowRunArtifactItem,
  DynamicWorkflowRunArtifactItemPage,
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResult,
  DynamicWorkflowRunWorkspaceNodeResultQuery,
  DynamicWorkflowRunEventPage,
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
  DynamicWorkflowRunSubmitRequest,
  DynamicWorkflowRunSubmitResult,
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
import { WORKFLOW_RUNS_LIMITS } from "@zcode/shared/zcode-protocol-v4";
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
import type { ActorTranscriptStore } from "./workflow-actor-transcript.js";
import {
  clampRunConcurrency,
  resolveWorkflowConcurrencyCeiling,
} from "./workflow-concurrency-ceiling.js";
import type { WorkflowConcurrencyPort } from "./workflow-concurrency-governor.js";
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
   * Model-request admission port for this actor runtime: provided by the driver when the governor
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
   * It is the **orphan-reap and enumeration scope**, hence not optional: absent leaves two paths - a global sweep
   * (marking same-process sibling sessions' in-flight runs dead; both share one sqlite with separate in-memory
   * registries) or no reaping at all (the run-stuck-in-running-forever bug). Prefer the wiring error surfacing at
   * compile time.
   */
  parentSessionId: string;
  /** Filesystem port for world-read (files.glob / files.read / files.grep). */
  fileSystemPort: FileSystemPort;
  /** Child-process exec port for git.* world-read (cwd = the run's workspace). */
  executionPort: ExecutionPort;
  /**
   * Byte sink for user-facing artifacts (artifact.file / artifact.markdown), passed to the driver
   * verbatim. Note: artifact here means deliverable-to-the-user output, not the engine's internal
   * top-level return value.
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
   * When absent, boundary accounting is absent wholesale - the run still completes, it just **cannot serve as an
   * amendment predecessor** (the service's no-marker-predecessor-rejects gate blocks it). Optional not required,
   * because assemblies without a session store have no transcript to count in the first place; seeded session
   * creation fails loudly in the driver when absent.
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
   * Absent means the host has no residency concept (one-shot CLI, test assemblies): the run completes, just
   * does not block close.
   */
  registerResidencyBlockingWork?: (work: Promise<unknown>) => void;
  /**
   * The driver's clock and timers: run-level stall clock and transient-failure backoff redrive
   * read it. TEST INJECTION ONLY (the fault matrix compresses the 2s->60s redrive curve and the
   * 20-minute stall window to milliseconds); production never sets it — absent, real time.
   */
  driverClock?: AgentRuntimeWorkflowDriverDeps["clock"];
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
  /** Unsettled run count right now (registry entries with terminal === undefined). */
  countLiveRuns(): number;
  /**
   * Settlement subscription: exactly one notify per run reaching a terminal state (completed/
   * errored/stopped, incl. pre-launch failures), after bookkeeping (the count already excludes
   * it). Returns an unsubscribe. Listener throws are logged, never affecting settlement.
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
 * Build the workflow run service. Returns {@link DynamicWorkflowRunService}: the port implementation
 * plus two session-level lifecycle read facades (in-flight count, settlement subscription) that
 * stay out of the contracts port — they serve the host's registry safety boundary, not the
 * engine/tool layer.
 */
export function createDynamicWorkflowRunService(
  deps: DynamicWorkflowRunServiceDeps,
): DynamicWorkflowRunService {
  const runs = new Map<string, RunRegistryEntry>();
  /**
   * Parking table for escalation questions. ONE table across every in-flight run of this service:
   * qids are globally unique for exactly this reason - resolveQuestion takes one opaque token;
   * making the model pair up (runId, qid) under concurrency is a mismatch generator. Pure memory,
   * sharing the parked deferred's fate (cleared on process death; self-heals via the actor
   * re-asking after resume; a persisted pending table would only lie).
   */
  const escalations: WorkflowEscalationRegistry = createWorkflowEscalationRegistry();

  // Reconcile at construction: zero in-flight runs of this instance exist yet, so every
  // non-terminal row of this session is a dead process's relic.
  // Header invariant 4 and {@link reconcileOrphanRuns}.
  reconcileOrphanRuns(deps);

  /**
   * This process's concurrency ceiling.
   * Same resolver as the process governor's bucket ceiling: run caps and bucket ceiling always agree.
   *
   * Within this service it has four readers, all through this one function: a new run's caps baseline, the port's
   * {@link DynamicWorkflowRunPort.concurrencyCeiling} (the tool layer clamps and applies the not-worth-mentioning
   * test with it), both read sides' maxConcurrency gate, and the derived field on the run-started payload.
   */
  const concurrencyCeiling = (): number =>
    resolveWorkflowConcurrencyCeiling(deps.availableParallelism);

  // caps: concurrency bound only, no wall-clock timeout; cancellation is the only stop. The bound
  // STARTS at the ceiling and can only be pressed down, never up — absent = ceiling, given =
  // clamped to [1, ceiling].
  const caps = (requested?: number): Caps => {
    return { maxConcurrency: clampRunConcurrency(requested, concurrencyCeiling()) };
  };

  // Introspection wired by capability probes (those four queries aren't on the engine port). When
  // absent, the two OPTIONAL members below are unimplemented wholesale: consumers' typeof
  // port.listRuns === "function" probe is false and the tool layer normalizes to a business
  // failure "this session lacks the capability" — never a silent empty list.
  const introspection = supportsRunIntrospection(deps.journal) ? deps.journal : undefined;

  // Lifecycle bookkeeping (settlement / close / close gate / foreign-terminal rows; header
  // invariants 6, 7) lives in dynamic-workflow-run-lifecycle.ts: they borrow only this registry
  // and journal, via narrow injected deps.
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

    // The three entries' close gate. async only to turn this wiring error into a rejection instead
    // of a sync throw; no await between gate and delegation, so invariant 6's "register in launch's
    // synchronous slice" is unaffected.
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
     * This process's concurrency ceiling (port contract: {@link DynamicWorkflowRunPort.concurrencyCeiling}).
     * The SAME {@link concurrencyCeiling} as caps' baseline: the tool-clamped value must equal the
     * value the port persists, or the confirmation window displays a number that won't be the
     * effective one.
     */
    concurrencyCeiling,

    /**
     * Retune an in-flight run's own concurrency cap (port contract at
     * {@link DynamicWorkflowRunPort.retuneConcurrency}; implementation in dynamic-workflow-run-retune.ts).
     *
     * Deliberately **not behind the closed gate**: the three launch entries assertOpen because they spawn engines;
     * this one spawns nothing - with the service closing, every entry is settling and liveness itself reports
     * not_live.
     */
    async retuneConcurrency(
      request: DynamicWorkflowRunRetuneRequest,
    ): Promise<DynamicWorkflowRunRetuneResult> {
      return retuneRunConcurrency({ runs, journal: deps.journal, concurrencyCeiling }, request);
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
      // Live entries go to the summary too: the session enumeration shares the priority rule with
      // snapshot/list/detail (rule three), else this surface alone would show a foreign-terminated
      // run as dead.
      return rows.map((row) => toSessionSummary(row, runs.get(row.runId)));
    },

    async replayProgressForSession(input: {
      excludeRunIds: ReadonlySet<string>;
    }): Promise<DynamicWorkflowRunProgressPayload[]> {
      if (!supportsRunEnumeration(deps.journal)) return [];
      let rows: DwfRunSessionListItem[];
      try {
        // Same constant as the projection's eviction: cold state = what a long-lived process would
        // hold now.
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
      // Enumeration is newest-first; replay wants oldest-first so the reducer's eviction matches
      // live arrival order.
      for (const row of [...rows].reverse()) {
        // Runs whose events the caller already holds (ran in this process) and registry-in-flight
        // runs are not replayed: their events all live in the memory store; feeding again would let
        // run-started reset phases to the start.
        if (input.excludeRunIds.has(row.runId) || runs.has(row.runId)) continue;
        // Ceiling shares the live-side source: cold replay's run-started payload must be byte-equal
        // to the live one.
        payloads.push(...replayRunProgress(row, deps.journal, concurrencyCeiling()));
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
        concurrencyCeiling(),
      );
    },

    /**
     * The run's archived script (port contract: {@link DynamicWorkflowRunPort.getScript}). Registry
     * entry first: in the submit->createRun gap the journal has no row and the entry holds the same
     * bytes; the journal copy is also what resume's hash check reads - so AmendWorkflow's keep,
     * the script_unchanged precheck, and resume never get two answers about "what is this run
     * running".
     */
    async getScript(runId: string): Promise<string | undefined> {
      return runs.get(runId)?.scriptText ?? deps.journal.getRun(runId)?.scriptText;
    },

    async waitForTask(
      taskId: string,
      options?: { signal?: AbortSignal },
    ): Promise<DynamicWorkflowRunSnapshot | undefined> {
      const entry = runs.get(taskId);
      // Not in the registry: either a pre-this-process run (journal has it) or fully unknown;
      // neither is waitable.
      if (entry === undefined) {
        return snapshotOf(
          taskId,
          runs,
          deps.journal,
          escalations.pendingFor(taskId),
          concurrencyCeiling(),
        );
      }
      if (entry.terminal === undefined) await settleOrAbort(entry.settlement, options?.signal);
      // Parked entries re-project AFTER the wait: during it, questions may be answered or withdrawn
      // with the cancel.
      return snapshotOf(
        taskId,
        runs,
        deps.journal,
        escalations.pendingFor(taskId),
        concurrencyCeiling(),
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
    ): Promise<DynamicWorkflowRunEvent[]> {
      const page = deps.journal.listEvents(runId, {
        ...(options.afterSequence === undefined ? {} : { afterSequence: options.afterSequence }),
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
      return page.map((stored) => toProtocolEvent(stored.sequence, stored.event));
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
     * report entries of one preset artifact, paged ascending by journal sequence (the dashboard's feed).
     * An out-of-range cursor yields an empty page, not an error - reaching the end is a normal paging outcome.
     */
    async listArtifactItems(
      runId: string,
      artifactId: string,
      page: DynamicWorkflowRunArtifactItemPage,
    ): Promise<readonly DynamicWorkflowRunArtifactItem[]> {
      return listArtifactItemsFrom(deps.journal, runId, artifactId, {
        ...(page.afterSequence === undefined ? {} : { afterSequence: page.afterSequence }),
        limit: page.limit,
      });
    },

    /**
     * Read one artifact version's bytes. The authorization chain (run belongs to this session and the journal has
     * the version's completed row => use the row's uri) lives wholly in {@link readWorkflowArtifactBytes}, diagram
     * included.
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
          concurrencyCeiling,
        })),
  };
}
