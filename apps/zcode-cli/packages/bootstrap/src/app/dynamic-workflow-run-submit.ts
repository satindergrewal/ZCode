// ============================================================
// Dynamic Workflow Run Service: the three launch entries (submit / amend / resume) and "compile once".
// ============================================================
// dynamic-workflow-run-service.ts hits oxlint's max-lines cap (400), so the submit/
// resume entries and their shared mintRunId move here (compileOnce lives in dynamic-workflow-run-compile.ts); the public surface still
// exports from dynamic-workflow-run-service.ts. The two entries point opposite ways and never share a gate (invariant 1 in that header),
// but they share one registry, one stall table and one settlement ledger -- all three passed in explicitly
// via {@link DynamicWorkflowRunEntryContext}; this file holds no state of its own.

import { randomUUID } from "node:crypto";
import type {
  DynamicWorkflowRunAmendRequest,
  DynamicWorkflowRunAmendResult,
  DynamicWorkflowRunResumeResult,
  DynamicWorkflowRunSubmitRequest,
  DynamicWorkflowRunSubmitResult,
  TraceContext,
} from "@zcode/contracts";
import {
  collectDiagnostics,
  createWorkflowProgram,
  type Caps,
  type ImportedRunCache,
  type RunSettlement,
} from "@zcode/dynamic-workflow";
import { formatModelPickerValue } from "@zcode/shared/model-selection";
import type { ModelSelection } from "@zcode/shared/model-selection";
import {
  buildImportedCache,
  preflightAmendImport,
  rebuildImportedCacheForResume,
} from "./dynamic-workflow-import.js";
import {
  boundedResumeDiagnostics,
  compileOnce,
  compileProgram,
} from "./dynamic-workflow-run-compile.js";
import {
  openHoleIndexes,
  phaseNamesFromEvents,
  readRunHoleEvents,
} from "./dynamic-workflow-run-holes.js";
import { launchDynamicWorkflowRun } from "./dynamic-workflow-run-launch.js";
import {
  readRunLaunchAnchor,
  readRunModelBindings,
  readRunScriptPath,
  readRunSubagentModel,
  resolveLaunchAnchor,
  type RunLaunch,
} from "./dynamic-workflow-run-launch-anchor.js";
import { isResumableRecord, type RunRegistryEntry } from "./dynamic-workflow-run-observation.js";
import type { DynamicWorkflowRunServiceDeps } from "./dynamic-workflow-run-service.js";
import { workflowSubagentPermissionModeField } from "./workflow-actor-permission.js";
import type { WorkflowEscalationRegistry } from "./workflow-escalation-registry.js";
import { createWorkflowRunControl } from "./workflow-run-control.js";

/**
 // * Service-internal state the two entries need. All REFERENCES, never copies: registry and stall table are the service's own,
* trackSettlement is the service settlement ledger (terminal into entry, failure normalization, settlement notify); caps is the submit-side
 // * bound computed from the live concurrency probe (resume keeps the caps recorded in journal, not this).
 */
export interface DynamicWorkflowRunEntryContext {
  deps: DynamicWorkflowRunServiceDeps;
  runs: Map<string, RunRegistryEntry>;
  escalations: WorkflowEscalationRegistry;
  /**
   * This launch caps. The input is the REQUESTED bound (CreateWorkflow / AmendWorkflow
   * max_concurrency, normalized by the tool layer to a number or absent): absent = default; given -> floor, min 1, no ceiling.
   */
  caps: (requestedMaxConcurrency?: number) => Caps;
  trackSettlement: (
    runId: string,
    entry: RunRegistryEntry,
    launched: Promise<RunSettlement>,
  ) => Promise<RunSettlement>;
}

/** Body of DynamicWorkflowRunPort.submit: a brand-new run, no predecessor, no cache. */
export async function submitDynamicWorkflowRun(
  ctx: DynamicWorkflowRunEntryContext,
  request: DynamicWorkflowRunSubmitRequest,
): Promise<DynamicWorkflowRunSubmitResult> {
  const runId = startNewRun(ctx, {
    runId: mintRunId(),
    scriptText: request.scriptText,
    cwd: request.cwd,
    ...(request.name === undefined ? {} : { name: request.name }),
    ...(request.args === undefined ? {} : { args: request.args }),
    ...(request.parentSessionId === undefined ? {} : { parentSessionId: request.parentSessionId }),
    ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
    ...(request.launchInputId === undefined ? {} : { launchInputId: request.launchInputId }),
    ...(request.phaseNames === undefined ? {} : { phaseNames: request.phaseNames }),
    ...(request.maxConcurrency === undefined ? {} : { maxConcurrency: request.maxConcurrency }),
    ...(request.subagentModel === undefined ? {} : { subagentModel: request.subagentModel }),
    ...(request.modelBindings === undefined ? {} : { modelBindings: request.modelBindings }),
    // Script file rides with the subagent model, passed through verbatim; the port infers nothing —
    // whether a draft was written is tool-side fact; absent means really no file.
    ...(request.scriptPath === undefined ? {} : { scriptPath: request.scriptPath }),
    ...(request.phaseAlongside === undefined ? {} : { phaseAlongside: request.phaseAlongside }),
    trace: request.trace,
  });
  return { ok: true, runId };
}

/**
 * Body of DynamicWorkflowRunPort.amend.
 *
 // * The order is the whole semantics:
*   1. PRECHECK the predecessor (exists AND boundaries complete) -- on rejection nothing is touched, the predecessor keeps running;
 // *   2. mint the new id;
 // *   3. cancel an in-flight predecessor with { superseded: newRunId } and AWAIT its own settlement promise -- not a timeout,
 // *      not journal polling; the predecessor thus settles as stopped(superseded, supersededBy);
 // *   4. boundedly wait for the aborted turn's tail writes, then ask which sessions are safe to count -- only that affects the in-flight
 // *      ask continuation; the completed prefix's boundary is a journal fact (full argument in the comment below);
 // *   5. build the cache from the settled predecessor -- precheck passed, so a rejection here is a host failure and propagates;
 // *   6. launch through the same path as a fresh submit, carrying resumedFrom and the cache.
 *
 // * The legacy flow made submit({resumeFrom}) return not_amendable for an in-flight predecessor, forcing the model into
 // * TaskStop -> poll stopped -> resubmit; this method folds stop and settlement-wait into the service, killing the race.
 */
export async function amendDynamicWorkflowRun(
  ctx: DynamicWorkflowRunEntryContext,
  request: DynamicWorkflowRunAmendRequest,
): Promise<DynamicWorkflowRunAmendResult> {
  const { deps, runs } = ctx;
  const preflight = preflightAmendImport(deps.journal, request.predecessorRunId);
  if (!preflight.ok) {
    deps.logger?.info?.("Dynamic workflow amend refused", {
      event: "dynamic_workflow.amend.refused",
      module: "bootstrap.app",
      predecessorRunId: request.predecessorRunId,
      reason: preflight.reason,
    });
    return { ok: false, reason: preflight.reason };
  }
  const predecessor = preflight.run;
  const runId = mintRunId();

  // In-flight detection reads THIS process's registry, not the journal state: journal running + absent from the registry = another
  // process's (or dead process's) run; this service can neither stop nor wait for it -- treat as settled and let the import build's terminal gate speak
  // (non-terminal throws; see below).
  const live = runs.get(request.predecessorRunId);
  let supersededRunId: string | undefined;
  if (live !== undefined && live.terminal === undefined) {
    live.controller.abort({ superseded: runId });
    // Await the predecessor's own settlement promise (the same promise as waitForTask; trackSettlement guarantees it never rejects).
    await live.settlement;
    supersededRunId = request.predecessorRunId;
    deps.logger?.info?.("Dynamic workflow run superseded by an amendment", {
      event: "dynamic_workflow.amend.superseded",
      module: "bootstrap.app",
      predecessorRunId: request.predecessorRunId,
      runId,
    });
  }

  // The quiet gate (apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md, "What is imported").
  //
  // Root cause: dispose() is synchronous; for a session with an in-flight turn it only hangs state.turn.then(close, close)
  // without waiting; the engine settles immediately after cancelAsk aborts the turn. So the await live.settlement above
  // guarantees "the run settled", NOT "the aborted tail finished writing". Counting the predecessor session's messages
  // right now may miss one or catch a half-landed part -- and that count becomes the continuation point
  // (inFlight.messageBoundary) the driver truncates the copy to. Completed prefixes are exempt: their boundary was
  // journaled at ask settlement -- a fact, not a live observation.
  //
  // So ask the driver once which sessions are quiet, and negotiate continuation only for those. This is NOT masking a race with a timeout:
  // a session still landing at the deadline is not treated as quiet; it simply gets no inFlight -- exactly the
  // pre-feature behavior (drop the whole in-flight transcript, restart the ask from the complete prefix). Rather lose one optimization
  // than truncate a transcript with a moving count.
  //
  // Two shapes wait zero seconds, both having no suspicious count to speak of:
  //   - no live entry for this predecessor in this process (long terminal, or a row left by a dead process) -> no driver, nothing
  //     writing its sessions;
  //   - the whole assembly has no transcript access -> counts unreadable, no inFlight possible (the builder equally
  //     needs messageCount to negotiate); waiting would be pure waste.
  // Both land on "absent = all quiet" (see AmendImportOptions.quietSessions).
  const quietSessions =
    deps.actorTranscriptStore === undefined ? undefined : await live?.quiescence?.quietSessions();

  const built = await buildImportedCache(
    deps,
    request.predecessorRunId,
    quietSessions === undefined ? undefined : { quietSessions },
  );
  if (!built.ok) {
    // The precheck just passed: run exists, boundaries complete; a rejection here leaves only "predecessor non-terminal" --
    // registry says not in flight while journal says running (another process holds it). Not a model-fixable input; raise as a wiring fault.
    throw new Error(
      `dynamic workflow amend could not import from run ${request.predecessorRunId} after preflight: ${built.reason}`,
    );
  }

  // Usage baseline: read the row AGAIN after the predecessor settles. The precheck copy predates the stop and would miss the
  // last turns' spend -- revising an in-flight run is this path's most common use. Unreadable row counts as 0 (just cleaned up).
  const settledPredecessor = deps.journal.getRun(request.predecessorRunId);
  const inheritedTokens = settledPredecessor?.spentTokens ?? 0;
  // Args carry over only when the caller says so (the GUI "configure" reruns the predecessor's own script; see the port field docs); the tool path
  // passes none, so amendment stays arg-less. A predecessor without args (inline script / legacy row) leaves the whole field absent.
  const inheritedArgs =
    request.inheritArgs === true && settledPredecessor?.args !== undefined
      ? settledPredecessor.args
      : undefined;

  startNewRun(ctx, {
    runId,
    scriptText: request.scriptText,
    cwd: request.cwd,
    inheritedTokens,
    // Display name inherits the predecessor: an amendment is the next version of the same work; a new name in cards/notifications reads as a different workflow.
    ...(request.name !== undefined
      ? { name: request.name }
      : predecessor.name === undefined
        ? {}
        : { name: predecessor.name }),
    ...(inheritedArgs === undefined ? {} : { args: inheritedArgs }),
    ...(request.parentSessionId === undefined ? {} : { parentSessionId: request.parentSessionId }),
    ...(request.toolCallId === undefined ? {} : { toolCallId: request.toolCallId }),
    ...(request.phaseNames === undefined ? {} : { phaseNames: request.phaseNames }),
    // Concurrency bound does NOT inherit: "omit = keep predecessor" is a TOOL-SURFACE tri-state,
    // resolveInput has normalized it to a number or absent here (absent = default concurrency). If the port inherited again,
    // A second inheritance in the port would make "unbounded" (null) unreachable here.
    ...(request.maxConcurrency === undefined ? {} : { maxConcurrency: request.maxConcurrency }),
    // the subagent model likewise does not inherit from the predecessor, same argument as the bound above: "omit = keep predecessor" is a
    // TOOL-surface tri-state; AmendWorkflow's resolveInput normalized it to a choice or absent here (absent = back to the
    // session model). A second port-level inheritance would never let "back to the session model" (null) reach here.
    ...(request.subagentModel === undefined ? {} : { subagentModel: request.subagentModel }),
    // Script-named models likewise do not inherit via the port: "same-name keeps the predecessor's binding" is the tool surface's rule;
    // resolveInput has normalized it to a table here.
    ...(request.modelBindings === undefined ? {} : { modelBindings: request.modelBindings }),
    // The script file is NEVER inherited from the predecessor: the amendment records which file THIS revision's script came from (a path
    // submit is that file; an inline submit is the just-written draft). Keeping the predecessor's path would have the model edit the old script next time.
    ...(request.scriptPath === undefined ? {} : { scriptPath: request.scriptPath }),
    ...(request.phaseAlongside === undefined ? {} : { phaseAlongside: request.phaseAlongside }),
    trace: request.trace,
    imported: { cache: built.cache, resumedFrom: built.resumedFrom },
  });
  return { ok: true, runId, ...(supersededRunId === undefined ? {} : { supersededRunId }) };
}

interface StartNewRunInput {
  runId: string;
  scriptText: string;
  cwd: string;
  name?: string;
  args?: Record<string, unknown>;
  parentSessionId?: string;
  toolCallId?: string;
  launchInputId?: string;
  /** Phase table declared by the script (both submit and amend pass it: amendments use the NEW script's phases). */
  phaseNames?: string[];
  /** Requested concurrency bound; absent = default. Normalized in {@link DynamicWorkflowRunEntryContext.caps}. */
  maxConcurrency?: number;
  /**
   * This run's subagent model; absent = subagents on the session model. A structured selection
   * comes in and is normalized to the picker string before persistence — see the startNewRun note.
   */
  subagentModel?: ModelSelection;
  /** Models the script names (name -> structured choice); normalized to canonical strings with the subagent model before persistence. Absent = none named. */
  modelBindings?: Record<string, ModelSelection>;
  /**
   * Absolute path of this run's script file; absent = no editable script file. Pure model-surface
   * metadata: no execution role, no resume-validation role.
   */
  scriptPath?: string;
  /** "Running simultaneously" table aligned with phaseNames; indices point at that table, they come and go together. */
  phaseAlongside?: number[][];
  trace: TraceContext;
  /**
   // * This run's usage baseline (spentTokens after the predecessor settles). Present on amend, absent on fresh submit (= 0).
   */
  inheritedTokens?: number;
  /** amend path: lineage pointer and import cache, always in pairs. */
  imported?: { cache: ImportedRunCache; resumedFrom: string };
}

/**
 // * Launch tail shared by submit and amend: compile -> anchor -> registry entry -> fire-and-forget launch.
 // * Returns runId (synchronously: the registry entry exists before this function returns; see below).
 */
function startNewRun(ctx: DynamicWorkflowRunEntryContext, input: StartNewRunInput): string {
  const { deps, runs, escalations } = ctx;
  const { imported, runId } = input;
  const compiled = compileOnce(input.scriptText);
  // The normalized bound is computed ONCE: it must land in dwf_run.caps_max_concurrency via EngineConfig and also serve as the
  // entry's gap copy (the only place getTask/getRunDetail can read it before the journal row exists).
  // Computing it twice lets the two read surfaces disagree in the instant the default changes.
  const caps = ctx.caps(input.maxConcurrency);
  // Canonical string form (providerId/modelId[$reasoningLevel]). The port takes structured choices, while the journal
  // event, both read surfaces and progress payloads want a string -- normalize once here, carry downstream.
  const subagentModel =
    input.subagentModel === undefined ? undefined : formatModelPickerValue(input.subagentModel);
  // Same normalization point for the binding table: structured choice -> canonical string; the table recorded on run-launched and on the entry is the same one.
  const modelBindings = formatModelBindings(input.modelBindings);

  // Launch anchor: amend inherits the predecessor, direct launch uses the explicit value, chat uses the active turn;
  // none present -> mint one. The engine records it on run-launched for the entry's lifetime.
  // The script's phase table joins the run's subagent model and anchor: an amendment continues the predecessor's inputId
  // but uses the NEW script's phase table and never inherits its model, so neither goes into resolveLaunchAnchor.
  const launch: RunLaunch = {
    ...resolveLaunchAnchor({
      ...(input.launchInputId === undefined ? {} : { requested: input.launchInputId }),
      trace: input.trace,
      ...(deps.resolveLaunchInputId === undefined
        ? {}
        : { resolveLaunchInputId: deps.resolveLaunchInputId }),
      ...(imported === undefined
        ? {}
        : (() => {
            const predecessor = readRunLaunchAnchor(deps.journal, imported.resumedFrom);
            return predecessor === undefined ? {} : { predecessor };
          })()),
    }),
    ...(input.phaseNames === undefined ? {} : { phaseNames: input.phaseNames }),
    // The subagent model rides along with the phase table (also excluded from resolveLaunchAnchor: an amendment never inherits the predecessor's model).
    // Zero SQL -- it lives on this event; dwf_run has no column for it (no migration, deliberately).
    ...(subagentModel === undefined ? {} : { subagentModel }),
    // Script-named models ride along with the subagent model (also excluded from resolveLaunchAnchor). Zero SQL.
    ...(modelBindings === undefined ? {} : { modelBindings }),
    // Subagent permission mode: the session's mode AT RUN CREATION (docs/dynamic-workflow/launch.md, "Permissions
    // inside a run"). Not into resolveLaunchAnchor -- an amendment is a new run and never inherits; resume does not pass here.
    ...workflowSubagentPermissionModeField(deps.permissionMode?.()),
    // Script file rides alongside the subagent model (also outside resolveLaunchAnchor: the
    // amendment records the NEW script's file). Zero SQL — it lives in this event; no dwf_run column.
    ...(input.scriptPath === undefined ? {} : { scriptPath: input.scriptPath }),
    ...(input.phaseAlongside === undefined ? {} : { phaseAlongside: input.phaseAlongside }),
    // Which phase-table stops are open holes (docs/execution-engine.md, "Holes"): holes stand by name in the declarer's
    // table (9010 guarantees unique names), indexed by the compile artifacts' open hole names. No holes -> field absent.
    ...(() => {
      const holes = openHoleIndexes(input.phaseNames, compiled.holes);
      return holes === undefined ? {} : { holes };
    })(),
  };

  // Register before launching: cancellation can arrive any time after submit returns, and the
  // background tracker starts polling snapshots immediately — the registry is the only synchronous
  // "run exists" fact (the journal's dwf_row waits for engine construction, a few microtasks later).
  const controller = new AbortController();
  // The live control surface and AbortController are created together and enter the entry together (see RunRegistryEntry.control):
  // "stop this run" and "change one setting" must both be available from the same instant, and both must exist
  // before launch -- retune can arrive in any microtask after submit returns.
  const control = createWorkflowRunControl();
  const entry: RunRegistryEntry = {
    controller,
    control,
    startedAt: new Date(),
    ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
    ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
    // The only pre-row source of enumeration keys and labels (see RunRegistryEntry).
    cwd: input.cwd,
    ...(input.name === undefined ? {} : { name: input.name }),
    scriptText: input.scriptText,
    // The effective bound (= the persisted one). Same gap argument: AmendWorkflow's resolveInput reads
    // getTask to decide "what carries over", and revising a just-started run lands exactly in that gap.
    maxConcurrency: caps.maxConcurrency,
    // The subagent model's gap copy, same rule as the bound (see RunRegistryEntry.subagentModel). This is the ONLY
    // normalization point of "structured choice -> canonical string": run-launched records it, and both read surfaces and
    // the run-started payload read it, so the format cannot fork across the three.
    ...(subagentModel === undefined ? {} : { subagentModel }),
    // The binding table's gap copy, same rule as the subagent model (see RunRegistryEntry.modelBindings).
    ...(modelBindings === undefined ? {} : { modelBindings }),
    // Gap copy of the script path, same rule as the subagent model (see RunRegistryEntry.scriptPath).
    ...(input.scriptPath === undefined ? {} : { scriptPath: input.scriptPath }),
    ...(imported === undefined ? {} : { resumedFrom: imported.resumedFrom }),
    // Hole-facts and phase tables (see RunRegistryEntry.holes / phaseNames): one fill swaps both to the effective script's.
    holes: compiled.holes,
    ...(input.phaseNames === undefined ? {} : { phaseNames: input.phaseNames }),
    // Usage baseline gap copy, same rule as the bound: before the journal row lands, the read surfaces can read usage only from the entry,
    // and revising a just-started run lands in those microtasks -- reporting 0 would tell the detail view "this lineage spent nothing".
    ...(input.inheritedTokens === undefined ? {} : { inheritedTokens: input.inheritedTokens }),
    // The real settlement promise replaces this below; a placeholder keeps types happy (synchronously visible).
    settlement: Promise.resolve<RunSettlement>({ status: "stopped", reason: "user" }),
  };
  runs.set(runId, entry);

  // Fire-and-forget: never await settlement inside submit; the contract is "start and hand back the runId".
  entry.settlement = ctx.trackSettlement(
    runId,
    entry,
    launchDynamicWorkflowRun({
      caps,
      compiled,
      cwd: input.cwd,
      deps,
      // name rides the same metadata road as scriptText/cwd: launch -> harness passes it to
      // EngineConfig verbatim and the engine writes dwf_run.name at createRun. No second service-side
      // UPDATE — that would mint a second dwf_run writer (same argument as header invariant 1).
      ...(entry.name === undefined ? {} : { name: entry.name }),
      // Args ride the same metadata road: launch -> harness -> EngineConfig (args_json) + spawn
      // payload (the sandbox's args global). Inline scripts have no args; the field is absent whole.
      ...(input.args === undefined ? {} : { args: input.args }),
      ...(entry.parentSessionId === undefined ? {} : { parentSessionId: entry.parentSessionId }),
      escalationRegistry: escalations,
      control,
      runId,
      scriptText: input.scriptText,
      signal: controller.signal,
      ...(entry.toolCallId === undefined ? {} : { toolCallId: entry.toolCallId }),
      // Session-quiescence probe backfills onto the entry: a future amendment of this run will ask
      // it (dynamic-workflow-import.ts quietSessions). All three entries wire it — which run
      // becomes a predecessor is future knowledge.
      onQuiescenceProbe: (probe) => {
        entry.quiescence = probe;
      },
      // Hole types read the entry's CURRENT facts table: after a fill swaps the table, new holes inside function bodies get their type too.
      holeTypeOf: (siteId) => entry.holes?.find((hole) => hole.siteId === siteId)?.type,
      // lineage pointer and cache table travel together (launch -> harness -> EngineConfig): the former lands dwf_run's
      // resumed_from (written once at createRun), the latter lives only for this execution.
      ...(imported === undefined
        ? {}
        : { importedCache: imported.cache, resumedFrom: imported.resumedFrom }),
      // Usage baseline, same road (launch -> harness -> EngineConfig): the engine seeds spent_tokens from it.
      ...(input.inheritedTokens === undefined ? {} : { inheritedTokens: input.inheritedTokens }),
      // The subagent model takes no separate road: it lives in run-launched beside the anchor,
      // pinned at creating time; the launch side reads it back from the journal event header.
      launch,
    }),
  );

  return runId;
}

/** Body of DynamicWorkflowRunPort.resume. */
export async function resumeDynamicWorkflowRun(
  ctx: DynamicWorkflowRunEntryContext,
  runId: string,
): Promise<DynamicWorkflowRunResumeResult> {
  const { deps, runs, escalations } = ctx;
  const record = deps.journal.getRun(runId);
  if (record === undefined) return { ok: false, reason: "not_found" };
  // In-process in-flight same runId: journal already says running, not resumable; a separate reason
  // because the caller's action differs from "unrecoverable terminal" (wait vs give up).
  const live = runs.get(runId);
  if (live !== undefined && live.terminal === undefined) {
    return { ok: false, reason: "already_running" };
  }
  // Runs replaced by an amendment get their own reason: for the caller it is a different action than an unrecoverable terminal (inspect successor vs give up).
  if (record.status === "stopped" && record.stopReason === "superseded") {
    return { ok: false, reason: "superseded" };
  }
  if (!isResumableRecord(record)) return { ok: false, reason: "not_resumable" };
  // scriptText persistence began with workflow-live-run; older records have no rerunnable script.
  if (record.scriptText === undefined) return { ok: false, reason: "script_missing" };

  // A legacy run's journal script was written against the facade of its time and may not typecheck after refactors.
  // compileOnce hard-fails on a dirty script (that is the wiring-error channel), but for resume it is a user-visible business branch:
  // structured rejection + bounded diagnostics, pointing UI/TUI/tool surface at AmendWorkflow
  // instead of a generic "execution failed". The diagnostics share one Program with the subsequent compile -- still "compile once".
  const workflow = createWorkflowProgram(record.scriptText);
  const diagnostics = collectDiagnostics(workflow.program);
  if (diagnostics.length > 0) {
    deps.logger?.warn?.("Dynamic workflow resume refused: stored script no longer compiles", {
      diagnosticCount: diagnostics.length,
      event: "dynamic_workflow.resume.compile_failed",
      module: "bootstrap.app",
      runId,
    });
    return {
      ok: false,
      reason: "compile_failed",
      message: boundedResumeDiagnostics(runId, diagnostics),
    };
  }
  const compiled = compileProgram(record.scriptText, workflow);
  // Server-side prior (the engine re-validates at construction; defense in depth): when the record was rewritten externally
  // (scriptText and scriptHash inconsistent) build no entry, do not start -- an engine-side synchronous throw would book the entry as a
  // failed terminal, masking the fact that the record is still repairable.
  if (record.scriptHash !== undefined && record.scriptHash !== compiled.scriptHash) {
    deps.logger?.warn?.("Dynamic workflow resume refused: script hash mismatch", {
      event: "dynamic_workflow.resume.script_hash_mismatch",
      expected: record.scriptHash,
      got: compiled.scriptHash,
      module: "bootstrap.app",
      runId,
    });
    return { ok: false, reason: "script_mismatch" };
  }

  // A revised run's resume: rebuild the import cache.
  // Consumed hits are real rows in this run's journal and short-circuit replay as always; unconsumed imports live only in memory,
  // and without rebuild this continuation becomes a live rerun. The rebuild is the same pure function over the same predecessor
  // journal as at commit, so determinism holds -- the re-derives the divergence point from this run's record row (imported-cache.ts's
  // reconcileRecorded), so the two sides cannot drift.
  //
  // A rebuild failure never sinks the resume: the predecessor journal is a liveness dependency but only an accelerator --
  // losing it costs money, never correctness. With the predecessor cleaned up or the boundary gate failing, start cache-less as always;
  // unconsumed imports degrade to live execution while the run's own journal rows still replay one by one.
  const rebuilt =
    record.resumedFrom === undefined
      ? undefined
      : await rebuildImportedCacheForResume(deps, {
          predecessorRunId: record.resumedFrom,
          runId,
        });

  // Replace the registry entry: same runId, new AbortController, new settlement promise — cancel
  // works again. Must precede launch (header invariant 5: the entry is the watcher's precondition).
  const resumedSubagentModel = readRunSubagentModel(deps.journal, runId);
  const resumedModelBindings = readRunModelBindings(deps.journal, runId);
  const resumedScriptPath = readRunScriptPath(deps.journal, runId);
  // The currently effective phase table: after a fill, the one on the last hole-filled; otherwise run-launched's declaration table.
  const resumedPhaseNames = phaseNamesFromEvents(readRunHoleEvents(deps.journal, runId));
  const controller = new AbortController();
  // Same rule as the submit path: new entry = new AbortController + new control surface. The previous life's handle binds the
  // already-settled engine; keeping it would let retune talk to a dead engine.
  const control = createWorkflowRunControl();
  const entry: RunRegistryEntry = {
    controller,
    control,
    startedAt: new Date(),
    // This run's effective bound: the RESUME path trusts the journal row (an in-place retune already wrote the new value into
    // caps_max_concurrency, so the row's value is the bound for this life). Copying into the entry leaves
    // retuneConcurrency and both read surfaces with one rule: entry present -> read the entry.
    maxConcurrency: record.caps.maxConcurrency,
    ...(record.toolCallId === undefined ? {} : { toolCallId: record.toolCallId }),
    ...(record.parentSessionId === undefined ? {} : { parentSessionId: record.parentSessionId }),
    // Gap metadata for the enumeration surface (see RunRegistryEntry): resume's authority is the
    // journal record; this is the same fact's in-memory copy. cwd matches the launch value below.
    cwd: record.cwd ?? process.cwd(),
    ...(record.name === undefined ? {} : { name: record.name }),
    scriptText: record.scriptText,
    // Subagent model: read the event header once into the entry (see RunRegistryEntry.subagentModel). The value was pinned on
    // run-launched at creation and never changes, so the copy cannot fork from the event; after copying, both read surfaces
    // keep one rule: entry present -> read it; only cold rows scan events.
    ...(resumedSubagentModel === undefined ? {} : { subagentModel: resumedSubagentModel }),
    // Binding table: same read and same argument as the subagent model.
    ...(resumedModelBindings === undefined ? {} : { modelBindings: resumedModelBindings }),
    // Script path: same read and same argument as the model (pinned in the creating generation,
    // never changes, copy can't diverge). Post-resume read surfaces keep "entry when present".
    ...(resumedScriptPath === undefined ? {} : { scriptPath: resumedScriptPath }),
    // Hole facts come from this compile of the row's (effective) script; the phase table reads back from the event (hole-filled's, once filled).
    holes: compiled.holes,
    ...(resumedPhaseNames === undefined ? {} : { phaseNames: resumedPhaseNames }),
    settlement: Promise.resolve<RunSettlement>({ status: "stopped", reason: "user" }),
  };
  runs.set(runId, entry);

  entry.settlement = ctx.trackSettlement(
    runId,
    entry,
    launchDynamicWorkflowRun({
      holeTypeOf: (siteId) => entry.holes?.find((hole) => hole.siteId === siteId)?.type,
      // caps from the journal record: spentTokens accumulated against these caps; recomputing
      // quietly moves the goalposts.
      caps: record.caps,
      compiled,
      cwd: record.cwd ?? process.cwd(),
      deps,
      ...(record.name === undefined ? {} : { name: record.name }),
      // resume REPLAYS the stored args, never accepts new ones: a run's identity includes its args,
      // the same discipline as "valid for byte-identical scripts only". The resume entry
      // deliberately has no args param, so the journal record is the only source; rows without the
      // column (absent -> sandbox reads {}). New args = a new run = a new confirmation window.
      ...(record.args === undefined ? {} : { args: record.args }),
      // The subagent model is not passed down either: it lives on run-launched with the anchor, pinned at creation; the launch side
      // reads it back from the event header itself (the same read that filled the entry). Same discipline as caps/args:
      // a run's identity includes which model it runs on; resume replays the recorded one and never accepts a new.
      ...(record.parentSessionId === undefined ? {} : { parentSessionId: record.parentSessionId }),
      // Both entries share the parking table (see the field's doc above).
      escalationRegistry: escalations,
      // Unlike the stall table, each entry builds its OWN control surface (bound to this life's engine and seat gates).
      control,
      runId,
      scriptText: record.scriptText,
      signal: controller.signal,
      ...(record.toolCallId === undefined ? {} : { toolCallId: record.toolCallId }),
      // Same as submit/amend: a resumed run can still become a future amendment's predecessor.
      onQuiescenceProbe: (probe) => {
        entry.quiescence = probe;
      },
      // resumedFrom not passed down: createRun pinned it at submit time; on resume the engine hits
      // the existing row and never runs createRun. Only the rebuilt cache goes down.
      ...(rebuilt === undefined ? {} : { importedCache: rebuilt }),
    }),
  );

  return {
    ok: true,
    runId,
    ...(record.toolCallId === undefined ? {} : { toolCallId: record.toolCallId }),
  };
}

/**
 * The run id. Charset-safe by necessity: it enters actor session ids, URLs, file paths, and logs —
 * `[A-Za-z0-9-]` only (randomUUID's alphabet), never `#`/`@`/`/`.
 */
function mintRunId(): string {
  return `dwfrun-${randomUUID()}`;
}

/** The binding table's only normalization point: structured choice -> canonical picker string. Empty table == absent (no empty-shell key). */
function formatModelBindings(
  bindings: Record<string, ModelSelection> | undefined,
): Record<string, string> | undefined {
  if (bindings === undefined) return undefined;
  const entries = Object.entries(bindings);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(
    entries.map(([name, selection]) => [name, formatModelPickerValue(selection)]),
  );
}
