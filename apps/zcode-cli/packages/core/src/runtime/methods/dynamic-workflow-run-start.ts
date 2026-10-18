import { randomUUID } from "node:crypto";
import {
  CREATE_WORKFLOW_TOOL_NAME,
  boundWorkflowLaunchMeta,
  createWorkflowPhaseAlongside,
  createWorkflowPhaseNames,
  type SavedWorkflowScope,
  type TraceContext,
} from "@zcode/contracts";
import type { CompileDiagnostic } from "@zcode/dynamic-workflow";
import {
  resolveSavedWorkflow,
  validateWorkflowArgs,
} from "../../tool/handlers/saved-workflows/index.js";
import {
  boundGraphOfAnalysis,
  displayOfAnalysis,
} from "../../tool/handlers/workflow-analysis-display.js";
import { writeWorkflowDraft } from "../../tool/handlers/workflow-drafts.js";
import { analyzeScript } from "../../tool/handlers/workflow-script-analysis.js";
import { bindScriptModels } from "../../tool/handlers/workflow-script-models.js";
import type { ExecutableToolCall } from "../../tool/types.js";
import { uuidv7 } from "@zcode/shared";
import { createMessageId, traceContextToLogContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { emitControlOnlyUserTurn, persistWorkflowLaunchUserMessage } from "./control-only-turn.js";
import { activateDynamicWorkflowTools } from "./dynamic-workflow-activation.js";

/**
 // * Structured result of startSavedWorkflowRun. Success carries the run's two linkage keys (runId == backgroundTaskId ==
 // * cancelBackgroundWork's workId; toolCallId links the tool card -> detail page); failure keys on reason
 // * (house rule: decide on codes, not text), message carrying the human-readable cause for inline GUI display.
 */
export type StartSavedWorkflowRunResult =
  | { ok: true; runId: string; toolCallId: string }
  | {
      ok: false;
      reason:
        | "invalid_name"
        | "not_found"
        | "invalid_args"
        | "compile_failed"
        | "session_busy"
        | "start_failed";
      message?: string;
    };

/** Bound of the merged compile diagnostics (about 2KB): diagnostics travel in the ACK message; oversized stacks are not readable. */
const COMPILE_DIAGNOSTICS_MAX_CHARS = 2_000;

/**
 // * The hub directly launching a saved workflow.
 *
 // * It is port.submit's SECOND caller, isomorphic to the CreateWorkflow tool path: the same saved normalization
 // * (resolveSavedWorkflow + validateWorkflowArgs, not copied), the same background tracker
 // * (trackExternalBackgroundTask feeding a synthetic CreateWorkflow descriptor); the resulting run is indistinguishable for
 // * notify/cancel/resume/detail. The only differences: no ToolExecutor.execute (skips permission checks + alwaysAsk --
 // * the whole point: clicking in the hub IS the consent), and a controlOnly launch turn records the user's
 // * real action into the session (the model first hears of the run on completion/question notification).
 *
 // * Fixed order; steps (1)(2) fail BEFORE any persistence (no run, message, event or task); failures after (4) only log,
 // * no rollback (the run is in flight, cancellable from the panel), still returning ok.
 */
export async function startSavedWorkflowRun(
  this: AgentRuntimeInternal,
  input: {
    name: string;
    scope?: SavedWorkflowScope;
    args?: Record<string, unknown>;
    traceContext?: TraceContext;
  },
): Promise<StartSavedWorkflowRunResult> {
  const traceContext = input.traceContext ?? this.rootTraceContext;

  // (0) Reject busy sessions. This method only makes sense for a fresh empty session; queueing a launch into the active turn needs controlOnly
  // turns coordinated with provider grammar (future "join this session" work). The GUI only sends it for empty sessions, so normally untriggered.
  if (this.hasActiveOrQueuedTurnWork()) {
    return { ok: false, reason: "session_busy" };
  }

  const cwd = this.workingDirectory;

  // (1) Parse + args validation: reuse create-workflow-source's normalization (second caller, not copied).
  const found = resolveSavedWorkflow({ cwd, name: input.name, scope: input.scope });
  if (!found.ok) {
    if (found.reason === "invalid_name") {
      return {
        ok: false,
        reason: "invalid_name",
        message: `'${input.name}' is not a usable workflow name: ${found.detail}`,
      };
    }
    if (found.reason === "not_found") {
      return {
        ok: false,
        reason: "not_found",
        message:
          input.scope === undefined
            ? `No saved workflow named '${input.name}' in this project or globally.`
            : `No ${input.scope} workflow named '${input.name}'.`,
      };
    }
    // parse_error / read_error: file exists but broken. Same next step as not-found for the GUI and the user (this name won't
    // run), so normalize to not_found; but the message says file problem, not name problem, so the user fixes the file not the name.
    return {
      ok: false,
      reason: "not_found",
      message: `The saved workflow '${input.name}' at ${found.path} could not be read: ${found.detail}`,
    };
  }

  const validated = validateWorkflowArgs(found.meta.args, input.args);
  if (!validated.ok) {
    return {
      ok: false,
      reason: "invalid_args",
      message: [
        `The arguments for saved workflow '${found.name}' are not valid:`,
        ...validated.errors.map((error) => `- ${error}`),
      ].join("\n"),
    };
  }

  // (2) Compile. Any diagnostic rejects -- the same principle as CreateWorkflow for non-compiling scripts (launching a
  // doomed run only delays the same error). Diagnostics go into message, bounded.
  const analysis = analyzeScript(found.script);
  // Script-named models resolve through the same code as CreateWorkflow (docs/dynamic-workflow/launch.md, "Models the script
  // names"); unbound names are 9011, rejected as compile_failed together with the diagnostics.
  const models = analysis.ok ? bindScriptModels(analysis, this.modelCatalogPort) : undefined;
  const diagnostics = [...analysis.diagnostics, ...(models?.unbound ?? [])];
  if (!analysis.ok || diagnostics.length > 0) {
    return {
      ok: false,
      reason: "compile_failed",
      message: boundedCompileDiagnostics(
        `The saved workflow '${found.name}' has errors:`,
        diagnostics,
      ),
    };
  }
  const modelSelections = models?.selections;

  // ---- Up to here: zero side effects: no run, message, event or task. ----

  const port = this.dynamicWorkflowRunPort;
  if (port === undefined) {
    // Port absent (stub / unit-test hosts): the GUI gets the capability-unsupported surface. Never degrade into "pretend launched".
    return { ok: false, reason: "start_failed", message: "dynamic workflow port unavailable" };
  }

  // Init context and persist the parent session BEFORE submitting. An actor's session_task_link references
  // the parent via parent_session_id; without the parent row the first actor creation fails on the FK.
  // The parent session titles itself with the workflow name; later launch turns reuse it idempotently. On submit failure the GUI
  // reclaims the empty session via deleteSession after the rejected ACK.
  await this.ensureContextInitialized(traceContext);
  await this.ensureSessionPersisted(found.name, traceContext);
  // Direct launch activates the tool surface (launch.md, "On demand: activation"): post-launch notifications want the model to call
  // GetWorkflowRun; after persistence, so the entry has a session to hang on.
  await activateDynamicWorkflowTools.call(this, { source: "run_control", traceContext });

  // (3) toolCallId: launch- prefix, distinguishable in logs/tool cards from model tool calls (tool_*) and resume re-arms.
  const toolCallId = `launch-${randomUUID()}`;
  const hasArgs = Object.keys(validated.args).length > 0;
  // Launch anchor: a direct launch has no user turn; mint a UUID v7 serving as both
  // the run's run-launched.inputId and the controlOnly launch turn's inputId -- the launch turn's run card and the subagents'
  // agent_step therefore hang under one message.
  const launchInputId = uuidv7();
  // The declared phase table reads the same "analysis -> bounded display graph" projection as the launch turn display
  // (phases come from the control-flow layer; the causality graph alone has none), then the same createWorkflowPhaseNames -- one script, one sidebar track, both roads.
  const launchGraph = boundGraphOfAnalysis(analysis);
  const phaseNames = createWorkflowPhaseNames(launchGraph);
  // The concurrently-running table indexes into phaseNames, so it must come from the same graph, the same projection.
  const phaseAlongside =
    phaseNames === undefined ? undefined : createWorkflowPhaseAlongside(launchGraph);

  // (3b) Working copy. Hub-direct and CreateWorkflow's saved source are the same thing, so copy by the same
  // rule: byte-for-byte (metadata block included), the saved definition untouched. Failure = no scriptPath; the run still starts,
  // the terminal notification just has no editable file to point to.
  const draft = await writeWorkflowDraft({ cwd, name: found.name, source: found.source });

  // (4) Submit the launch. Submit failure (rejected/thrown) exits before the launch turn -- never swallow into a success-with-runId.
  let runId: string;
  try {
    const submitted = await port.submit({
      scriptText: found.script,
      cwd,
      name: found.name,
      ...(hasArgs ? { args: validated.args } : {}),
      parentSessionId: this.sessionId,
      toolCallId,
      launchInputId,
      ...(phaseNames === undefined ? {} : { phaseNames }),
      ...(phaseAlongside === undefined ? {} : { phaseAlongside }),
      ...(modelSelections === undefined ? {} : { modelBindings: modelSelections }),
      ...(draft === undefined ? {} : { scriptPath: draft.path }),
      trace: traceContext,
    });
    runId = submitted.runId;
  } catch (error) {
    return { ok: false, reason: "start_failed", message: describeError(error) };
  }

  const launchText = buildLaunchMessageText(found.name, found.scope, runId, validated.args);
  // Graph and script ride the launch turn: the run detail panel and turn-end run card locate the origin row by toolCallId and read display.causalityGraph
  // and input.script; a direct launch has no tool row, so hang the same display and script on the launch metadata
  // (else the direct-launched run's panel has no graph/script). display uses the same analysis->display-graph
  // projection as CreateWorkflow, all three tiers (sites/phases/subagent cards) present -- this used to hand-assemble args with only the causality graph,
  // leaving sites without phases or agent cards, the panel a bare spine.
  const display = displayOfAnalysis(analysis);
  const meta = boundWorkflowLaunchMeta({
    runId,
    toolCallId,
    name: found.name,
    scope: found.scope,
    path: found.path,
    ...(hasArgs ? { args: validated.args } : {}),
    description: found.meta.description,
    ...(display?.kind === "create_workflow" ? { display } : {}),
    script: found.script,
  });

  // Post-(4) failures log without rollback: the run is in flight and cancellable; withdrawing it would mint an ownerless orphan.
  try {
    // (5) Launch turn: user-visible message (synthetic + workflowLaunch metadata) + history + controlOnly turn
    // boundary; session title = workflow name (ensureSessionPersisted titles by first input).
    const messageId = createMessageId();
    await emitControlOnlyUserTurn.call(this, {
      messageId,
      titleInput: found.name,
      historyText: launchText,
      turnInput: launchText,
      traceContext,
      inputId: launchInputId,
      inputSource: "workflow_launch",
      workflowLaunch: meta,
      persistMessage: () =>
        persistWorkflowLaunchUserMessage.call(this, {
          messageID: messageId,
          text: launchText,
          meta,
          traceContext,
        }),
    });

    // (6) Background tracking: synthesize a CreateWorkflow descriptor through the executor's own trackBackgroundTask
    // (runtime-task registry = reclaim guard, BackgroundTaskStarted, terminal waiter, settlement notify).
    // input.name feeds the notification subject (workflowTaskSubject); name: CreateWorkflow puts per-tool lifecycle
    // dispatch under "workflow" -- notify/cancel/resume/detail untouched.
    const toolCall: ExecutableToolCall = {
      id: toolCallId,
      name: CREATE_WORKFLOW_TOOL_NAME,
      input: {
        name: found.name,
        saved: {
          name: found.name,
          scope: found.scope,
          ...(hasArgs ? { args: validated.args } : {}),
        },
      },
    };
    await this.executor.trackExternalBackgroundTask(
      toolCall,
      { backgroundTaskId: runId, status: "backgrounded" },
      traceContext,
      undefined,
    );
  } catch (error) {
    this.logger?.error(
      "Saved workflow launched but post-submit bookkeeping failed",
      error instanceof Error ? error : new Error(String(error)),
      {
        ...traceContextToLogContext(traceContext),
        event: "dynamic_workflow.launch.post_submit_failed",
        module: "core.runtime",
        runId,
        toolCallId,
      },
    );
  }

  return { ok: true, runId, toolCallId };
}

/**
 // * The launch turn's model-facing sentence (English, not localized -- it enters the provider transcript, what the model reads next turn).
 // * With args, attach them as a JSON block; the last sentence always discourages relaunching (the run is in flight; progress returns via notifications).
 */
function buildLaunchMessageText(
  name: string,
  scope: SavedWorkflowScope,
  runId: string,
  args: Record<string, unknown>,
): string {
  const lines = [
    `Started the saved workflow "${name}" (${scope}) from the workflows hub as run ${runId}.`,
  ];
  if (Object.keys(args).length > 0) {
    lines.push("", "Arguments:", "```json", JSON.stringify(args, null, 2), "```");
  }
  lines.push("", "Progress and results arrive as background notifications; do not start it again.");
  return lines.join("\n");
}

/**
 // * Merge compile diagnostics into one bounded text (L{line}:C{column} {message} per item). Shared by hub launch and GUI "configure":
 // * both hand diagnostics to the GUI's bounded mono block via the ACK message.
 */
export function boundedCompileDiagnostics(
  heading: string,
  diagnostics: readonly CompileDiagnostic[],
): string {
  const body = [
    heading,
    ...diagnostics.map(
      (diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`,
    ),
  ].join("\n");
  return body.length > COMPILE_DIAGNOSTICS_MAX_CHARS
    ? `${body.slice(0, COMPILE_DIAGNOSTICS_MAX_CHARS - 1)}…`
    : body;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
