// ============================================================
// Dynamic Workflow Run Service: the three entry points (submit / amend / resume) and "compile
// once".
//
// dynamic-workflow-run-service.ts hit oxlint's max-lines (400), so the submit/resume entries plus
// their shared compileOnce/mintRunId moved here; the public surface still exports from
// dynamic-workflow-run-service.ts. The two entries face opposite directions and never share a gate
// (that file's header invariant 1), but they share one registry, one parking table, and one
// settlement bookkeeping — all passed in explicitly via {@link DynamicWorkflowRunEntryContext};
// this file holds no state of its own.

import { createHash, randomUUID } from "node:crypto";
import type {
  DynamicWorkflowRunAmendRequest,
  DynamicWorkflowRunAmendResult,
  DynamicWorkflowRunResumeResult,
  DynamicWorkflowRunSubmitRequest,
  DynamicWorkflowRunSubmitResult,
  TraceContext,
} from "@zcode/contracts";
import {
  buildAskSpecs,
  collectDiagnostics,
  collectSites,
  collectWorldRunCommands,
  createWorkflowProgram,
  deriveActorSubmitProfilesFor,
  lowerWorkflow,
  synthesizeAskSchemas,
  type Caps,
  type CompileDiagnostic,
  type ImportedRunCache,
  type RunSettlement,
  type WorkflowProgram,
} from "@zcode/dynamic-workflow";
import { formatModelPickerValue } from "@zcode/shared/model-selection";
import type { ModelSelection } from "@zcode/shared/model-selection";
import {
  buildImportedCache,
  preflightAmendImport,
  rebuildImportedCacheForResume,
} from "./dynamic-workflow-import.js";
import {
  launchDynamicWorkflowRun,
  type CompiledDynamicWorkflowScript,
} from "./dynamic-workflow-run-launch.js";
import {
  readRunLaunchAnchor,
  readRunScriptPath,
  readRunSubagentModel,
  resolveLaunchAnchor,
  type RunLaunch,
} from "./dynamic-workflow-run-launch-anchor.js";
import { isResumableRecord, type RunRegistryEntry } from "./dynamic-workflow-run-observation.js";
import type { DynamicWorkflowRunServiceDeps } from "./dynamic-workflow-run-service.js";
import type { WorkflowEscalationRegistry } from "./workflow-escalation-registry.js";
import { createWorkflowRunControl } from "./workflow-run-control.js";

/**
 * Service-internal state both entries need. All references, never copies: the registry and parking
 * table ARE the service's; trackSettlement is its settlement bookkeeping (terminal into entry,
 * failure normalization, settlement notify); caps is the submit-path bound from the live
 * concurrency probe (resume keeps the journal's caps, bypassing this).
 */
export interface DynamicWorkflowRunEntryContext {
  deps: DynamicWorkflowRunServiceDeps;
  runs: Map<string, RunRegistryEntry>;
  escalations: WorkflowEscalationRegistry;
  /**
   * This launch's caps. The param is the REQUESTED concurrency bound (CreateWorkflow/AmendWorkflow's
   * max_concurrency, normalized by the tool layer to a number or absent): absent = ceiling; given,
   * clamped to [1, ceiling].
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
 * The order IS the semantics:
 *   1. Precheck the predecessor (exists AND boundaries intact) — on rejection nothing moved; it
 *      keeps running.
 *   2. Mint the new id.
 *   3. If the predecessor is in flight, cancel with `{ superseded: newRunId }` and AWAIT its own
 *      settlement promise — not a timeout, not journal polling; the predecessor thus settles as
 *      stopped(superseded, supersededBy).
 *   4. Boundedly wait for aborted turns to finish writing their tails, then ask "which sessions
 *      are safe to count now" — only in-flight asks' continuations are affected; completed-prefix
 *      boundaries are journal fact (full argument in the note below).
 *   5. Build the cache from the settled predecessor — precheck passed; a rejection here is a host
 *      fault, rethrown.
 *   6. Launch via the same road as fresh submit, with resumedFrom and the cache.
 *
 * The legacy flow made submit({resumeFrom}) answer not_amendable for an in-flight predecessor,
 // forcing TaskStop -> poll stopped -> resubmit; this method folds stop+settlement-wait into the
 // service and the race disappears.
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

  // In-flight is judged against THIS process's registry, not journal state: journal says running
  // but the registry lacks it -> another (or dead) process's run; this service can't stop or wait
  // for it — treat as settled and let the import builder's terminal gate speak (non-terminal
  // throws; see below).
  const live = runs.get(request.predecessorRunId);
  let supersededRunId: string | undefined;
  if (live !== undefined && live.terminal === undefined) {
    live.controller.abort({ superseded: runId });
    // Await the predecessor's own settlement promise (the same one waitForTask uses; trackSettlement
    // guarantees it never rejects).
    await live.settlement;
    supersededRunId = request.predecessorRunId;
    deps.logger?.info?.("Dynamic workflow run superseded by an amendment", {
      event: "dynamic_workflow.amend.superseded",
      module: "bootstrap.app",
      predecessorRunId: request.predecessorRunId,
      runId,
    });
  }

  // Quiescence gate.
  //  // Root cause: dispose() is synchronous and merely attaches state.turn.then(close, close) for
  // sessions with in-flight turns, without waiting; the engine settles right after cancelAsk kills
  // the turn. So the await live.settlement above guarantees "the run settled", NOT "the aborted
  // turn finished writing its tail". Counting the predecessor's messages now may miss one or count
  // a part-less message — and that count becomes the continuation point (inFlight.messageBoundary)
  // the driver truncates the copy with. Completed prefixes are exempt: their boundaries were
  // journaled at ask settlement — fact, not present observation.
  //  // So ask the driver once which sessions are quiet, and speak continuation only for quiet ones.
  // This is NOT a papering timeout: a session still unsettled at the deadline simply doesn't get an
  // inFlight — exactly the pre-feature behavior (whole in-flight transcript discarded, ask restarts
  // from the completed prefix). Rather lose one optimization than truncate a transcript with a
  // moving count.
  //  // Two cases skip the wait entirely, neither having a suspicious count:
  //   - No live entry for this predecessor in this process (already terminal, or a dead process's
  //     row) -> no driver, nothing writing its session.
  //   - The assembly has no transcript access -> counts are impossible, inFlight can't exist (the
  //     builder needs messageCount to speak continuation too); waiting is pure waste.
  // Both collapse to "absent = all quiet" (AmendImportOptions.quietSessions).
  const quietSessions =
    deps.actorTranscriptStore === undefined ? undefined : await live?.quiescence?.quietSessions();

  const built = await buildImportedCache(
    deps,
    request.predecessorRunId,
    quietSessions === undefined ? undefined : { quietSessions },
  );
  if (!built.ok) {
    // Precheck just passed: run exists, boundaries intact; a rejection now leaves only
    // "predecessor non-terminal" — registry says not in flight while journal says running (another
    // process holds it). Not a model-fixable input; throw as a wiring fault.
    throw new Error(
      `dynamic workflow amend could not import from run ${request.predecessorRunId} after preflight: ${built.reason}`,
    );
  }

  // Usage baseline: read the row AGAIN after the predecessor settles. The preflight copy predates
  // the stop and would miss the final turns' spend — amending a running run is this path's most
  // common use. Missing row -> 0 (predecessor just pruned).
  const settledPredecessor = deps.journal.getRun(request.predecessorRunId);
  const inheritedTokens = settledPredecessor?.spentTokens ?? 0;
  // Args carry over only when the caller says so (the GUI's "configure" reruns the predecessor's
  // own script; see the port field note); the tool path passes none, amendments stay arg-less. No
  // predecessor args (inline script/old row) -> whole field absent.
  const inheritedArgs =
    request.inheritArgs === true && settledPredecessor?.args !== undefined
      ? settledPredecessor.args
      : undefined;

  startNewRun(ctx, {
    runId,
    scriptText: request.scriptText,
    cwd: request.cwd,
    inheritedTokens,
    // Display name inherits the predecessor: an amendment is the next version of the same work; a
    // different name in cards/notifications reads as a different workflow.
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
    // already normalized by AmendWorkflow's resolveInput into a number or absent (absent = ceiling).
    // A second inheritance in the port would make "unbounded" (null) unreachable here.
    ...(request.maxConcurrency === undefined ? {} : { maxConcurrency: request.maxConcurrency }),
    // Subagent model doesn't inherit either, same argument as the bound above: "omit = keep
    // predecessor" is the tool surface's tri-state, normalized by resolveInput into a selection or
    // absent (absent = back to the session model). A port-level inheritance would make "back to
    // session model" (null) unreachable here.
    ...(request.subagentModel === undefined ? {} : { subagentModel: request.subagentModel }),
    // Script file NEVER inherits: the amendment records which file THIS revision's script came from
    // (a path submit is that file; an inline submit is the just-written draft). Keeping the
    // predecessor's path would send future edits to the old script.
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
  /** Requested concurrency bound; absent = ceiling. Clamped in {@link DynamicWorkflowRunEntryContext.caps}. */
  maxConcurrency?: number;
  /**
   * This run's subagent model; absent = subagents on the session model. A structured selection
   * comes in and is normalized to the picker string before persistence — see the startNewRun note.
   */
  subagentModel?: ModelSelection;
  /**
   * Absolute path of this run's script file; absent = no editable script file. Pure model-surface
   * metadata: no execution role, no resume-validation role.
   */
  scriptPath?: string;
  /** "Running simultaneously" table aligned with phaseNames; indices point at that table, they come and go together. */
  phaseAlongside?: number[][];
  trace: TraceContext;
  /**
   * This run's usage baseline (spentTokens after the predecessor settles). Amend supplies it; fresh
   * submit leaves it absent (= 0).
   */
  inheritedTokens?: number;
  /** amend path: lineage pointer and import cache, always in pairs. */
  imported?: { cache: ImportedRunCache; resumedFrom: string };
}

/**
 * Shared launch tail of submit and amend: compile -> anchor -> registry entry -> fire-and-forget
 * launch. Returns the runId (synchronously: the registry entry exists before this returns; see
 * below).
 */
function startNewRun(ctx: DynamicWorkflowRunEntryContext, input: StartNewRunInput): string {
  const { deps, runs, escalations } = ctx;
  const { imported, runId } = input;
  const compiled = compileOnce(input.scriptText);
  // The clamped bound is computed ONCE: it both persists to dwf_run.caps_max_concurrency via
  // EngineConfig and serves as the registry entry's gap copy (the only place getTask/getRunDetail
  // can read before the journal row exists). Computing twice lets the two read surfaces disagree
  // for one instant when the ceiling changes.
  const caps = ctx.caps(input.maxConcurrency);
  // Canonical string form (providerId/modelId[$reasoningLevel]). The port takes a structured
  // selection while journal events, both read surfaces, and progress payloads want a string —
  // normalize once here, relay everywhere downstream.
  const subagentModel =
    input.subagentModel === undefined ? undefined : formatModelPickerValue(input.subagentModel);

  // Launch anchor: amendments inherit the predecessor, direct starts use the explicit value, chats
  // the active turn; none -> mint one. The engine records it as run-launched in the creating
  // generation. The script's phase table and this run's subagent model merge alongside the anchor:
  // amendments keep the predecessor's inputId but use the NEW script's phases and never inherit the
  // model, so neither goes through resolveLaunchAnchor.
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
    // Subagent model rides alongside the phase table (also outside resolveLaunchAnchor: amendments
    // never inherit the predecessor's model). Zero SQL — it lives in this event; dwf_run has no
    // column for it (no migration, deliberately).
    ...(subagentModel === undefined ? {} : { subagentModel }),
    // Script file rides alongside the subagent model (also outside resolveLaunchAnchor: the
    // amendment records the NEW script's file). Zero SQL — it lives in this event; no dwf_run column.
    ...(input.scriptPath === undefined ? {} : { scriptPath: input.scriptPath }),
    ...(input.phaseAlongside === undefined ? {} : { phaseAlongside: input.phaseAlongside }),
  };

  // Register before launching: cancellation can arrive any time after submit returns, and the
  // background tracker starts polling snapshots immediately — the registry is the only synchronous
  // "run exists" fact (the journal's dwf_row waits for engine construction, a few microtasks later).
  const controller = new AbortController();
  // Live control plane and AbortController are created together and enter the entry together (see
  // RunRegistryEntry.control): "stop this run" and "change one setting" must both be available from
  // the same instant, and both must exist before launch — a retune can arrive in any microtask
  // after submit returns.
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
    // Effective concurrency bound (= the persisted one). Same gap argument: AmendWorkflow's
    // resolveInput reads getTask to decide "what to keep", and amending a just-started run lands
    // exactly in that gap.
    maxConcurrency: caps.maxConcurrency,
    // Gap copy of the subagent model, same rule as the bound (see RunRegistryEntry.subagentModel).
    // The ONLY "structured selection -> canonical string" normalization point: run-launched records
    // it, both read surfaces and the run-started payload read it — the format cannot fork across
    // the three sites.
    ...(subagentModel === undefined ? {} : { subagentModel }),
    // Gap copy of the script path, same rule as the subagent model (see RunRegistryEntry.scriptPath).
    ...(input.scriptPath === undefined ? {} : { scriptPath: input.scriptPath }),
    ...(imported === undefined ? {} : { resumedFrom: imported.resumedFrom }),
    // Gap copy of the usage baseline, same rule as the bound: before the journal row lands, the two
    // read surfaces can only get usage from the entry — and amending a just-started lands in
    // exactly those microtasks; reporting 0 would tell the detail view "this lineage spent nothing".
    ...(input.inheritedTokens === undefined ? {} : { inheritedTokens: input.inheritedTokens }),
    // The real settlement promise replaces this below; a placeholder keeps types and synchronous
    // visibility happy.
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
      // Lineage pointer and cache table pass together (launch -> harness -> EngineConfig): the
      // former lands in dwf_run.resumed_from (written once at createRun), the latter lives only in
      // this execution.
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
  // Runs superseded by an amendment get their own reason: again a different action for the caller
  // (inspect the successor vs give up).
  if (record.status === "stopped" && record.stopReason === "superseded") {
    return { ok: false, reason: "superseded" };
  }
  if (!isResumableRecord(record)) return { ok: false, reason: "not_resumable" };
  // scriptText persistence began with workflow-live-run; older records have no rerunnable script.
  if (record.scriptText === undefined) return { ok: false, reason: "script_missing" };

  // An old run's journal text was written against the THEN-current facade and may fail typecheck
  // after refactors. compileOnce hard-fails dirty scripts (that channel is for wiring errors), but
  // in resume it's a user-expected branch — structured rejection + bounded diagnostics, pointing
  // UI/TUI/tools at AmendWorkflow instead of a generic "execution failed". Diagnostics share the
  // Program with the subsequent compile: still compile-once.
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
  // Server-side precheck (the engine re-validates at construction; defense in depth): when the
  // record was rewritten by outside forces (scriptText vs scriptHash inconsistent), build no
  // registry entry and don't start — a synchronous engine-side throw would book the entry as
  // terminal-failed, hiding that the record is still repairable.
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

  // Amendment's resume: rebuild the import cache. Consumed hits are real rows in this run's journal
  // and replay-short-circuit as usual; unconsumed imports live only in memory — without rebuild
  // they'd become live reruns in this continuation. Rebuild uses the same pure function over the
  // same predecessor journal as at submit, so determinism holds — the engine re-derives the divergence
  // point from this run's record row (imported-cache.ts reconcileRecorded); the two sides cannot
  // disagree.
  //
  // Rebuild failure NEVER kills the resume: the predecessor journal is a liveness dependency of the
  // amended run, but only an accelerator — losing it costs time, not correctness. Without it the
  // run starts cache-less as usual and unconsumed imports degrade to live re-execution, while this
  // run's own journal rows still replay one by one.
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
  const resumedScriptPath = readRunScriptPath(deps.journal, runId);
  const controller = new AbortController();
  // Same rule as the submit path: new entry = new AbortController + new control plane. The previous
  // generation's handles bind the already-settled engine; keeping them lets retune talk to a dead
  // engine.
  const control = createWorkflowRunControl();
  const entry: RunRegistryEntry = {
    controller,
    control,
    startedAt: new Date(),
    // This run's effective bound: resume trusts the journal ROW (an in-place retune already wrote
    // the new value into caps_max_concurrency, so the row's value is what this generation runs
    // under). Copying into the entry leaves retuneConcurrency and both read surfaces one rule:
    // entry when present.
    maxConcurrency: record.caps.maxConcurrency,
    ...(record.toolCallId === undefined ? {} : { toolCallId: record.toolCallId }),
    ...(record.parentSessionId === undefined ? {} : { parentSessionId: record.parentSessionId }),
    // Gap metadata for the enumeration surface (see RunRegistryEntry): resume's authority is the
    // journal record; this is the same fact's in-memory copy. cwd matches the launch value below.
    cwd: record.cwd ?? process.cwd(),
    ...(record.name === undefined ? {} : { name: record.name }),
    scriptText: record.scriptText,
    // Subagent model: read the event header once into the entry (see RunRegistryEntry.subagentModel).
    // The value was pinned on run-launched in the creating generation and never changes, so the
    // copy cannot diverge from the event; afterwards both read surfaces keep one rule — entry when
    // present, event scan only for cold rows.
    ...(resumedSubagentModel === undefined ? {} : { subagentModel: resumedSubagentModel }),
    // Script path: same read and same argument as the model (pinned in the creating generation,
    // never changes, copy can't diverge). Post-resume read surfaces keep "entry when present".
    ...(resumedScriptPath === undefined ? {} : { scriptPath: resumedScriptPath }),
    settlement: Promise.resolve<RunSettlement>({ status: "stopped", reason: "user" }),
  };
  runs.set(runId, entry);

  entry.settlement = ctx.trackSettlement(
    runId,
    entry,
    launchDynamicWorkflowRun({
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
      // The subagent model isn't passed down either: it lives in run-launched with the anchor,
      // pinned in the creating generation; the launch side reads it back from the journal event
      // header (the same read the entry copy used). Same discipline as caps/args — a run's identity
      // includes the model it ran on; replay the stored one, never accept new.
      ...(record.parentSessionId === undefined ? {} : { parentSessionId: record.parentSessionId }),
      // Both entries share the parking table (see the field's doc above).
      escalationRegistry: escalations,
      // Unlike the parking table, EACH entry builds its own control plane (bound to this
      // generation's engine and seat gate).
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
 * Compile once: one ts.Program feeds the site table, schema synthesis, and lowering.
 *
 * Dirty scripts hard-fail here WITHOUT creating a run: the handler calls submit only on ok, so a
 * dirty script here is a wiring error. The defensive check reads the same compilation's program
 * diagnostics — never a second Program (that would break compile-once). resume recompiles the
 * journal's original text through the same function: a byte-identical script necessarily passes
 * the same checks.
 */
function compileOnce(scriptText: string): CompiledDynamicWorkflowScript {
  return compileProgram(scriptText, createWorkflowProgram(scriptText));
}

/** Diagnostic cap inside resume-rejection text (same magnitude as the hub's compile_failed). */
const RESUME_DIAGNOSTICS_MAX_CHARS = 2000;

/** Human-readable compile_failed diagnostics: one `L:C message` per line, bounded overall. */
function boundedResumeDiagnostics(runId: string, diagnostics: CompileDiagnostic[]): string {
  const body = [
    `The stored script of run ${runId} no longer compiles against the current workflow facade:`,
    ...diagnostics.map(
      (diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`,
    ),
  ].join("\n");
  return body.length > RESUME_DIAGNOSTICS_MAX_CHARS
    ? `${body.slice(0, RESUME_DIAGNOSTICS_MAX_CHARS - 1)}…`
    : body;
}

/**
 * compileOnce's second half: site table / schema synthesis / lowering over the BUILT Program.
 * resume takes diagnostics from the same Program first, then hands it here — still compile-once
 * (the Program caches its own diagnostics; re-reads are free).
 */
function compileProgram(
  scriptText: string,
  workflow: WorkflowProgram,
): CompiledDynamicWorkflowScript {
  const diagnostics = [
    ...workflow.program.getSyntacticDiagnostics(),
    ...workflow.program.getSemanticDiagnostics(),
  ];
  if (diagnostics.length > 0) {
    throw new Error(
      `dynamic workflow submit received a script that does not typecheck (${diagnostics.length} diagnostics); no run was created`,
    );
  }

  const table = collectSites(workflow);
  const { diagnostics: schemaDiagnostics, schemas } = synthesizeAskSchemas(workflow, table);
  if (schemaDiagnostics.length > 0) {
    throw new Error(
      `dynamic workflow submit received a script with unsupported ask result types: ${schemaDiagnostics
        .map((diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  // world.run's command set is collected in the same compilation (the authorization surface:
  // compile-time literals + confirmation-window display + driver re-verification). Non-literal cmds
  // were already bounced in the handler's analyze phase; one here is a wiring error — hard fail, no run.
  const worldRun = collectWorldRunCommands(workflow, table);
  if (worldRun.diagnostics.length > 0) {
    throw new Error(
      `dynamic workflow submit received a script with non-literal world.run commands (${worldRun.diagnostics.length} diagnostics); no run was created`,
    );
  }

  // buildAskSpecs is the only correct construction of askSpecs: untyped sites record {typed:false}
  // explicitly. Building from schemas' keys would drop untyped sites entirely, and the engine
  // hard-fails on absence as a wiring error.
  const askSpecs = buildAskSpecs(table, schemas);

  return {
    askSpecs,
    // Per-actor-site submit profile: interpretation + site-graph projection on the SAME Program
    // (analyzeWorkflowScript already ran both over this text in the handler's analyze phase) —
    // still compile-once. resume recomputes for byte-identical text via the same function;
    // determinism holds.
    actorSubmitProfiles: deriveActorSubmitProfilesFor(workflow, table, askSpecs),
    declaredRunCommands: new Set(worldRun.commands),
    lowered: lowerWorkflow(workflow, table).code,
    // scriptHash ownership lives HERE, not in the harness. The harness takes both scriptText and
    // lowered and deliberately never checks their consistency — checking means compiling again,
    // exactly the pass compile-once exists to skip (harness.ts makes it a caller invariant). So the
    // hash must be over the author's original: were the harness to hash "the text it sees", the
    // lowered path would persist the lowered body's hash while resume compares the original — the
    // comparison basis would silently misalign. This function emits lowered and hash from one
    // compilation, consistent by construction.
    scriptHash: createHash("sha256").update(scriptText, "utf8").digest("hex"),
  };
}

/**
 * The run id. Charset-safe by necessity: it enters actor session ids, URLs, file paths, and logs —
 * `[A-Za-z0-9-]` only (randomUUID's alphabet), never `#`/`@`/`/`.
 */
function mintRunId(): string {
  return `dwfrun-${randomUUID()}`;
}
