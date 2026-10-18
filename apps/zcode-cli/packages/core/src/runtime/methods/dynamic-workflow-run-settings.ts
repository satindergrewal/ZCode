import { randomUUID } from "node:crypto";
import {
  AMEND_WORKFLOW_TOOL_NAME,
  boundWorkflowLaunchMeta,
  createWorkflowPhaseAlongside,
  createWorkflowPhaseNames,
  type DynamicWorkflowRunRetuneResult,
  type TraceContext,
  type WorkflowSettingsAmendMeta,
} from "@zcode/contracts";
import {
  resolveAmendMaxConcurrency,
  resolveAmendSubagentModelChoice,
} from "../../tool/handlers/amend-workflow-resolve.js";
import { resolveKeptScriptFile } from "../../tool/handlers/amend-workflow-source.js";
import { parseWorkflowSubagentModel } from "../../tool/handlers/model-reference.js";
import {
  boundGraphOfAnalysis,
  displayOfAnalysis,
} from "../../tool/handlers/workflow-analysis-display.js";
import {
  resolveWorkflowDraftName,
  writeWorkflowDraft,
} from "../../tool/handlers/workflow-drafts.js";
import { analyzeScript } from "../../tool/handlers/workflow-script-analysis.js";
import { bindScriptModels } from "../../tool/handlers/workflow-script-models.js";
import type { ExecutableToolCall } from "../../tool/types.js";
import { traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { boundedCompileDiagnostics } from "./dynamic-workflow-run-start.js";
import { activateDynamicWorkflowTools } from "./dynamic-workflow-activation.js";
import {
  buildSettingsMessageText,
  enqueueSettingsTurn,
  fromTo,
  runSettingsOfSnapshot,
  type RunSettings,
} from "./dynamic-workflow-run-settings-turn.js";

export { buildSettingsMessageText } from "./dynamic-workflow-run-settings-turn.js";

/**
 // * The GUI "configure" request (docs/dynamic-workflow/launch.md, "The command"). Both settings keep the tool's tri-state:
 // * omit = keep, null = back to default (session model / default concurrency), value = set.
 */
export interface AmendWorkflowRunSettingsInput {
  runId: string;
  subagentModel?: string | null;
  maxConcurrency?: number | null;
  traceContext?: TraceContext;
}

/** The rejection vocabulary, verbatim equal to shared's workflowRunSettingsRejectionReasonSchema. */
export type AmendWorkflowRunSettingsRejection =
  | "not_found"
  | "not_configurable"
  | "unchanged"
  | "script_missing"
  | "model_unavailable"
  | "compile_failed"
  | "missing_boundaries"
  | "start_failed";

export type AmendWorkflowRunSettingsResult =
  | { ok: true; runId: string; toolCallId: string; supersededRunId?: string }
  | { ok: false; reason: AmendWorkflowRunSettingsRejection; message?: string };

/**
 // * GUI "configure": revise a run with the same script and new settings.
 *
 // * The SECOND caller of port.amend and port.retuneConcurrency, isomorphic to the AmendWorkflow tool:
 // * the same tri-state normalization (resolveAmendSubagentModelChoice / resolveAmendMaxConcurrency, not copied), the same
 // * routing, compile and background tracker (synthesizing an AmendWorkflow descriptor). Differences: no model turn, no
 // * confirm dialog (clicking Apply in the sheet IS consent, and the script is the approved one), args inherit the predecessor
 // * (inheritArgs), and a queued controlOnly settings turn records it into the session.
 *
 // * Concurrency-only changes on an in-flight run take effect IN PLACE at the fork below: same runId, no stop, no successor.
 *
 // * Fixed order: every step before port.amend / port.retuneConcurrency fails side-effect-free -- the old run
 // * keeps running, no new row, no messages.
 */
export async function amendWorkflowRunSettings(
  this: AgentRuntimeInternal,
  input: AmendWorkflowRunSettingsInput,
): Promise<AmendWorkflowRunSettingsResult> {
  const traceContext = input.traceContext ?? this.rootTraceContext;
  const port = this.dynamicWorkflowRunPort;
  if (port === undefined || typeof port.amend !== "function") {
    // The capability registers only when the port has amend and getScript; missing here = wiring fault, not user input.
    return { ok: false, reason: "start_failed", message: "dynamic workflow amend unavailable" };
  }

  // (1) The run must exist and belong to this session -- a command sent to a session amends only that session's runs.
  const snapshot = await port.getTask(input.runId);
  if (snapshot === undefined || snapshot.parentSessionId !== this.sessionId) {
    return { ok: false, reason: "not_found" };
  }
  // (2) A completed run replays every ask from cache; new settings have nowhere to land. A superseded run lives on in its successor.
  if (snapshot.runStatus === "completed" || snapshot.supersededBy !== undefined) {
    return { ok: false, reason: "not_configurable" };
  }
  // (3)(4) Tri-state normalization for both settings, the same code as the tool.
  const current = runSettingsOfSnapshot(snapshot);
  const model = resolveAmendSubagentModelChoice(
    input.subagentModel,
    current.subagentModel,
    this.modelCatalogPort,
  );
  if (!model.ok) {
    // The no-catalog message is written for the model ("omit subagent_model"); the GUI wants the reason code; with a catalog, the
    // resolution diagnostics (candidate names etc.) help humans too and ride in message.
    return {
      ok: false,
      reason: "model_unavailable",
      ...(this.modelCatalogPort === undefined ? {} : { message: model.message }),
    };
  }
  const defaultConcurrency = port.defaultConcurrency?.();
  const bound = resolveAmendMaxConcurrency(input.maxConcurrency, current.maxConcurrency);
  // A bound equal to the default IS "no own bound": the snapshot carries maxConcurrency only when != default; one reading on both sides
  // keeps "unchanged" comparisons true (the sheet sends null even with the stepper parked on default; this also catches callers passing numbers). Above-default
  // bounds are this run's own, same as below-default.
  const nextBound =
    bound.max_concurrency === undefined || bound.max_concurrency === defaultConcurrency
      ? undefined
      : bound.max_concurrency;
  const next: RunSettings = {
    ...(model.canonical === undefined ? {} : { subagentModel: model.canonical }),
    ...(nextBound === undefined ? {} : { maxConcurrency: nextBound }),
  };
  // (5) Nothing changed -> no new run: an amendment stops the in-flight run; no reason to pay that for a zero diff.
  const modelChanged = next.subagentModel !== current.subagentModel;
  const boundChanged = next.maxConcurrency !== current.maxConcurrency;
  if (!modelChanged && !boundChanged) return { ok: false, reason: "unchanged" };

  // (6) The fork (docs/dynamic-workflow/launch.md, "On the agent"): only a concurrency change on an in-flight run applies
  // in place -- same runId, no stop, no successor, no import cache. A not_live from the port (settled, or pending but engine
  // not yet built) walks the table below into today's-style amendment.
  if (boundChanged && !modelChanged && typeof port.retuneConcurrency === "function") {
    // The sheet's null passes to the port verbatim: only the port knows the default number; never guess twice. Absent can only mean
    // "given equals default" (folded above), where the intent is precisely back-to-default.
    const answer = await port.retuneConcurrency({
      runId: input.runId,
      maxConcurrency: input.maxConcurrency ?? null,
    });
    if (answer.ok) {
      // An in-place retune also counts as "this session uses workflows" (launch.md, "On demand: activation"): post-settings
      // notifications want GetWorkflowRun. retunedSettings settles synchronously; activate before it.
      await activateDynamicWorkflowTools.call(this, { source: "run_control", traceContext });
      return retunedSettings.call(this, {
        answer,
        name: displayNameOfSnapshot(snapshot),
        runId: input.runId,
        traceContext,
      });
    }
    if (answer.reason === "unchanged") return { ok: false, reason: "unchanged" };
  }

  // (7) The carried-over script ("Keeping the predecessor's script", same read road). Read AFTER the fork: an in-place
  // retune keeps the same script, so a run without an archived script or with an uncompilable one can still retune its bound.
  const script =
    typeof port.getScript === "function" ? await port.getScript(input.runId) : undefined;
  if (script === undefined || script.length === 0) {
    return { ok: false, reason: "script_missing" };
  }

  // (8) Compile. The stored script may predate the current facade; on failure stop here, old run untouched.
  const analysis = analyzeScript(script);
  if (!analysis.ok || analysis.diagnostics.length > 0) {
    return {
      ok: false,
      reason: "compile_failed",
      message: boundedCompileDiagnostics(
        `The stored script of run ${input.runId} has errors:`,
        analysis.diagnostics,
      ),
    };
  }
  // (8b) Script-named models: this run reruns ITS OWN script, every name bound at launch; keep that table
  // and re-resolve against the catalog (docs/dynamic-workflow/launch.md, "On the agent"). A since-vanished model stops here --
  // same reason code as an unresolvable sheet selection; old run untouched.
  const models = bindScriptModels(analysis, this.modelCatalogPort, snapshot.modelBindings);
  if (models.unbound.length > 0) {
    return {
      ok: false,
      reason: "model_unavailable",
      message: boundedCompileDiagnostics(
        `The models named in the script of run ${input.runId} cannot be used now:`,
        models.unbound,
      ),
    };
  }
  const modelSelections = models.selections;

  // ---- Up to here: zero side effects. ----

  // The new run's script file, same rule and same code as the tool's script carry-over:
  // if the predecessor's script file still holds these bytes, keep recording it; otherwise write a fresh draft as "not from a file".
  // Without it, the model's only later road to amend this run is re-inlining the whole script. Best effort: failure
  // = absent, the run starts anyway. This is the only pre-amend persistence; worst case an unreferenced draft file.
  const graph = boundGraphOfAnalysis(analysis);
  const keptFile = await resolveKeptScriptFile({
    cwd: this.workingDirectory,
    scriptPath: snapshot.scriptPath,
    script,
  });
  const scriptPath =
    keptFile?.path ??
    (
      await writeWorkflowDraft({
        cwd: this.workingDirectory,
        name: resolveWorkflowDraftName(snapshot.name, graph),
        source: script,
      })
    )?.path;

  // (8) Amend. The settings- prefix distinguishes logs/cards from model tool calls (tool_*) and hub launches (launch-).
  const toolCallId = `settings-${randomUUID()}`;
  const phaseNames = createWorkflowPhaseNames(graph);
  const phaseAlongside = phaseNames === undefined ? undefined : createWorkflowPhaseAlongside(graph);
  const subagentModel = parseWorkflowSubagentModel(next.subagentModel);
  let amended: Awaited<ReturnType<NonNullable<typeof port.amend>>>;
  try {
    amended = await port.amend({
      scriptText: script,
      cwd: this.workingDirectory,
      predecessorRunId: input.runId,
      parentSessionId: this.sessionId,
      toolCallId,
      ...(phaseNames === undefined ? {} : { phaseNames }),
      ...(phaseAlongside === undefined ? {} : { phaseAlongside }),
      ...(next.maxConcurrency === undefined ? {} : { maxConcurrency: next.maxConcurrency }),
      ...(subagentModel === undefined ? {} : { subagentModel }),
      ...(modelSelections === undefined ? {} : { modelBindings: modelSelections }),
      ...(scriptPath === undefined ? {} : { scriptPath }),
      // Rerunning the predecessor's own script reads exactly the predecessor's launch args.
      inheritArgs: true,
      trace: traceContext,
    });
  } catch (error) {
    return {
      ok: false,
      reason: "start_failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  if (!amended.ok) {
    return {
      ok: false,
      reason: amended.reason === "run_not_found" ? "not_found" : "missing_boundaries",
    };
  }

  // The name comes from the run's own only: an unnamed run carries none; cards/panels/notifications fall back like any unnamed run.
  // This used to fall back to run <id>, making the settings card and panel titles a run id,
  // and the fake name propagated down the amendment chain.
  const name = displayNameOfSnapshot(snapshot);
  const amend: WorkflowSettingsAmendMeta = {
    predecessorRunId: input.runId,
    ...(modelChanged ? { subagentModel: fromTo(current.subagentModel, next.subagentModel) } : {}),
    ...(boundChanged
      ? { maxConcurrency: fromTo(current.maxConcurrency, next.maxConcurrency) }
      : {}),
    // Wire name ceiling predates "default concurrency", kept for old clients; it carries the default D.
    ...(defaultConcurrency === undefined ? {} : { ceiling: defaultConcurrency }),
  };

  // Post-(9)(10) failures log without rollback: the new run is in flight, stoppable from the panel; withdrawing it mints an orphan.
  try {
    // Background tracking: synthesize an AmendWorkflow descriptor through the executor's registry (terminal waiter,
    // settlement notify included). input.name feeds the notification subject; the tool name routes dispatch under "workflow".
    const toolCall: ExecutableToolCall = {
      id: toolCallId,
      name: AMEND_WORKFLOW_TOOL_NAME,
      input: { run_id: input.runId, ...(name === undefined ? {} : { name }) },
    };
    await this.executor.trackExternalBackgroundTask(
      toolCall,
      { backgroundTaskId: amended.runId, status: "backgrounded" },
      traceContext,
      undefined,
    );
    // Success activates the tool surface (launch.md, "On demand: activation"): the new run's notifications want GetWorkflowRun.
    await activateDynamicWorkflowTools.call(this, { source: "run_control", traceContext });
    enqueueSettingsTurn.call(this, {
      text: buildSettingsMessageText({
        ...(name === undefined ? {} : { name }),
        previous: input.runId,
        runId: amended.runId,
        superseded: amended.supersededRunId !== undefined,
        amend,
      }),
      meta: boundWorkflowLaunchMeta({
        runId: amended.runId,
        toolCallId,
        ...(name === undefined ? {} : { name }),
        ...(() => {
          const display = displayOfAnalysis(analysis);
          return display?.kind === "create_workflow" ? { display } : {};
        })(),
        amend,
      }),
      // The session is persisted by now (it owns a run); the title seed would go unused; an honest value suffices.
      titleInput: name ?? input.runId,
      traceContext,
    });
  } catch (error) {
    this.logger?.error(
      "Workflow settings amended but post-amend bookkeeping failed",
      error instanceof Error ? error : new Error(String(error)),
      {
        ...traceContextToLogContext(traceContext),
        event: "dynamic_workflow.settings.post_amend_failed",
        module: "core.runtime",
        runId: amended.runId,
        toolCallId,
      },
    );
  }

  return {
    ok: true,
    runId: amended.runId,
    toolCallId,
    ...(amended.supersededRunId === undefined ? {} : { supersededRunId: amended.supersededRunId }),
  };
}

/**
 // * The in-place settlement (the fork row of launch.md "On the agent"): same runId, no
 // * supersededRunId, and NO second background task -- this run is already tracked; re-registering would clear the
 // * settlement surface of a never-stopped run per AmendWorkflow's rearm rule.
 *
 // * The settings turn still records, but amend carries no predecessorRunId: absent = applied in place; the renderer draws one line,
 // * no run card (two cards for one run read as two runs). No display either -- this road does not compile.
 */
function retunedSettings(
  this: AgentRuntimeInternal,
  options: {
    answer: Extract<DynamicWorkflowRunRetuneResult, { ok: true }>;
    name: string | undefined;
    runId: string;
    traceContext: TraceContext;
  },
): AmendWorkflowRunSettingsResult {
  const { answer, name, runId, traceContext } = options;
  const toolCallId = `settings-${randomUUID()}`;
  // The default-equal end IS "default", so the whole field drops -- same reading as the amendment road (the sheet's
  // null at default vs the port's always-absolute answer; the fold happens here). Wire key ceiling carries D.
  const amend: WorkflowSettingsAmendMeta = {
    maxConcurrency: fromTo(
      answer.previous === answer.defaultConcurrency ? undefined : answer.previous,
      answer.maxConcurrency === answer.defaultConcurrency ? undefined : answer.maxConcurrency,
    ),
    ceiling: answer.defaultConcurrency,
  };
  try {
    enqueueSettingsTurn.call(this, {
      text: buildSettingsMessageText({
        ...(name === undefined ? {} : { name }),
        previous: runId,
        runId,
        superseded: false,
        amend,
      }),
      meta: boundWorkflowLaunchMeta({
        runId,
        toolCallId,
        ...(name === undefined ? {} : { name }),
        amend,
      }),
      titleInput: name ?? runId,
      traceContext,
    });
  } catch (error) {
    // Log and move on: the bound HAS taken effect; rolling back a line does not restore it, nor is undoing the retune what the user asked.
    this.logger?.error(
      "Workflow run retuned but the settings turn could not be queued",
      error instanceof Error ? error : new Error(String(error)),
      {
        ...traceContextToLogContext(traceContext),
        event: "dynamic_workflow.settings.post_retune_failed",
        module: "core.runtime",
        runId,
        toolCallId,
      },
    );
  }
  return { ok: true, runId, toolCallId };
}

/** The run's own name (absent when unnamed): both the settings turn and synthetic tracking follow this; never a run id as title. */
function displayNameOfSnapshot(snapshot: { name?: string }): string | undefined {
  const trimmed = snapshot.name?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}
