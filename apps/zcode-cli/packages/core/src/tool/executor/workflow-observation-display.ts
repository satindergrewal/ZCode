/**
 * Result-card display builders for the workflow tools: the observation five (GetWorkflowRun / ListWorkflowRuns /
 * EvalWorkflowSnippet / ListSavedWorkflows / ListModels) plus the ResumeWorkflowRun restore card.
 *
 * A separate file rather than result-display.ts (already 500 lines): these builders share one skeleton --
 * "safeParse the output schema -> display-side bound -> truncated flag over limit" -- kin to
 * createCreateWorkflowDisplay but its own block.
 */

import {
  CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS,
  CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS,
  EVAL_WORKFLOW_SNIPPET_TOOL_NAME,
  EvalWorkflowSnippetOutputSchema,
  GET_WORKFLOW_RUN_TOOL_NAME,
  GetWorkflowRunOutputSchema,
  LIST_MODELS_TOOL_NAME,
  ListModelsOutputSchema,
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  ListSavedWorkflowsOutputSchema,
  LIST_WORKFLOW_RUNS_TOOL_NAME,
  ListWorkflowRunsOutputSchema,
  RESUME_WORKFLOW_RUN_TOOL_NAME,
  ResumeWorkflowRunOutputSchema,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_ACTORS,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_MODELS,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_PHASES,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_RESULT_CHARS,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_SUBAGENTS,
  type GetWorkflowRunOutput,
  type GetWorkflowRunToolResultDisplayPayload,
  type ToolResultDisplayPayload,
} from "@zcode/contracts";

import { boundDisplayText } from "./display-text.js";

export function createWorkflowObservationDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  return (
    createGetWorkflowRunDisplay(toolName, output) ??
    createListWorkflowRunsDisplay(toolName, output) ??
    createEvalWorkflowSnippetDisplay(toolName, output) ??
    createSavedWorkflowListDisplay(toolName, output) ??
    createListModelsDisplay(toolName, output) ??
    createResumeWorkflowRunDisplay(toolName, output)
  );
}

function createGetWorkflowRunDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== GET_WORKFLOW_RUN_TOOL_NAME) return undefined;
  const parsed = GetWorkflowRunOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;

  const data = parsed.data;
  let truncated = false;

  const actors = data.actors.slice(0, WORKFLOW_OBSERVATION_DISPLAY_MAX_ACTORS);
  if (actors.length < data.actors.length) truncated = true;

  // Take the tail: logTail's value is "latest progress"; cut from the head, keep the tail.
  const droppedLogEntries = Math.max(
    0,
    data.logTail.length - WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES,
  );
  const logTail = data.logTail.slice(-WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES).map((entry) => {
    const bounded = boundDisplayText(entry.message, WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS);
    if (bounded.truncated) truncated = true;
    // `at` rides the card verbatim (present or absent): card log age and model-side `<log_tail>` share one ruler.
    return {
      sequence: entry.sequence,
      message: bounded.value,
      ...(entry.at === undefined ? {} : { at: entry.at }),
    };
  });
  if (droppedLogEntries > 0) truncated = true;

  let result: string | undefined;
  if (data.result !== undefined) {
    const bounded = boundDisplayText(data.result, WORKFLOW_OBSERVATION_DISPLAY_MAX_RESULT_CHARS);
    if (bounded.truncated) truncated = true;
    result = bounded.value;
  }

  // Card errors carry code/message only.
  // The output-side `providerStop` is model-channel diagnostic detail; it stays in tool text/output while the
  // renderer strict-validates every frame against the packages/shared mirror schema -- one extra display key
  // rejects the whole row. This used to pass data.error through and stuck a desktop session on
  // fault.subscription.recoveryFailed; display also lands in tool-part metadata, so one mistake replays every cold start.
  const error =
    data.error === undefined ? undefined : { code: data.error.code, message: data.error.message };

  // Situation section: phase table and roster have their own card bounds (display bypasses the result budget);
  // anything clipped merges into the single truncated flag -- the card shows only what it actually drew.
  // These fields are optional in the schema (so pre-launch persisted payloads still validate) but the builder
  // **fills them every time**: optional is a door for old data, not a gap for new calls.
  const phases = data.phases?.slice(0, WORKFLOW_OBSERVATION_DISPLAY_MAX_PHASES);
  if (phases !== undefined && phases.length < data.phases!.length) truncated = true;
  const subagents = data.subagents.slice(0, WORKFLOW_OBSERVATION_DISPLAY_MAX_SUBAGENTS);
  if (subagents.length < data.subagents.length || data.subagentsTruncated === true)
    truncated = true;

  return {
    kind: "get_workflow_run",
    runId: data.runId,
    label: data.label,
    status: data.status,
    ...(data.stopReason === undefined ? {} : { stopReason: data.stopReason }),
    ...(data.possiblyInterrupted === true ? { possiblyInterrupted: true } : {}),
    summary: data.summary,
    generatedAt: data.generatedAt,
    usage: data.usage,
    ...(phases === undefined || phases.length === 0 ? {} : { phases }),
    subagents: subagents.map(toDisplaySubagent),
    health: data.health,
    actors,
    logTail,
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * Model-side nested subagents -> one flat card row. The currentAsk facts are this row's second half; free-text
 wait reasons stay off the card (it needs only "waiting for slot / backing off" and the ETA); every other
 field: absent means absent -- "0 tool calls" and "unknown" are different facts.
 */
function toDisplaySubagent(
  subagent: GetWorkflowRunOutput["subagents"][number],
): NonNullable<GetWorkflowRunToolResultDisplayPayload["subagents"]>[number] {
  const ask = subagent.currentAsk;
  return {
    siteId: subagent.siteId,
    ordinal: subagent.ordinal,
    ...(subagent.name === undefined ? {} : { name: subagent.name }),
    state: subagent.state,
    ...(subagent.phaseName === undefined ? {} : { phaseName: subagent.phaseName }),
    ...(ask?.instructionsHead === undefined ? {} : { instructionsHead: ask.instructionsHead }),
    ...(ask?.startedAt === undefined ? {} : { startedAt: ask.startedAt }),
    ...(ask?.turn === undefined ? {} : { turn: ask.turn }),
    ...(ask?.toolCalls === undefined ? {} : { toolCalls: ask.toolCalls }),
    ...(ask?.lastTool === undefined ? {} : { lastTool: ask.lastTool }),
    ...(subagent.wait === undefined
      ? {}
      : {
          waitCause: subagent.wait.cause,
          ...(subagent.wait.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: subagent.wait.retryAfterMs }),
          ...(subagent.wait.since === undefined ? {} : { waitSince: subagent.wait.since }),
        }),
    ...(subagent.parkedOn === undefined ? {} : { parkedOn: subagent.parkedOn }),
    stepsSettled: subagent.stepsSettled,
    stepsFailed: subagent.stepsFailed,
    tokens: subagent.tokens,
    ...(subagent.lastProgressAt === undefined ? {} : { lastProgressAt: subagent.lastProgressAt }),
  };
}

function createListWorkflowRunsDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== LIST_WORKFLOW_RUNS_TOOL_NAME) return undefined;
  const parsed = ListWorkflowRunsOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;

  // Every run-row field is a small number or short bounded text (label <=80, name <=64) and limit caps at 50:
  // pass through -- truncation semantics live in the output's own truncated flag.
  return {
    kind: "list_workflow_runs",
    runs: parsed.data.runs,
    ...(parsed.data.truncated === true ? { truncated: true } : {}),
  };
}

function createEvalWorkflowSnippetDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== EVAL_WORKFLOW_SNIPPET_TOOL_NAME) return undefined;
  const parsed = EvalWorkflowSnippetOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;

  const data = parsed.data;
  let truncated = false;

  // Diagnostics bounded like createCreateWorkflowDisplay: count slice + per-message char cap.
  const diagnostics = data.diagnostics
    .slice(0, CREATE_WORKFLOW_DISPLAY_MAX_DIAGNOSTICS)
    .map((diagnostic) => ({
      line: diagnostic.line,
      column: diagnostic.column,
      code: diagnostic.code,
      message: diagnostic.message.slice(0, CREATE_WORKFLOW_DISPLAY_MAX_MESSAGE_CHARS),
    }));
  if (diagnostics.length < data.diagnostics.length) truncated = true;

  // Logs take the tail: snippet logs are arrival-ordered, latest at the end.
  const droppedLogs = Math.max(0, data.logs.length - WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES);
  const logs = data.logs.slice(-WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_ENTRIES).map((entry) => {
    const bounded = boundDisplayText(entry, WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS);
    if (bounded.truncated) truncated = true;
    return bounded.value;
  });
  if (droppedLogs > 0) truncated = true;

  const boundedResponse = boundDisplayText(
    data.response,
    WORKFLOW_OBSERVATION_DISPLAY_MAX_RESULT_CHARS,
  );
  if (boundedResponse.truncated) truncated = true;

  return {
    kind: "eval_workflow_snippet",
    ok: data.ok,
    diagnostics,
    logs,
    response: boundedResponse.value,
    durationMs: data.durationMs,
    ...(truncated ? { truncated: true } : {}),
  };
}

function createSavedWorkflowListDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== LIST_SAVED_WORKFLOWS_TOOL_NAME) return undefined;
  const parsed = ListSavedWorkflowsOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;

  const data = parsed.data;
  let truncated = false;

  const boundMeta = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const bounded = boundDisplayText(value, WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS);
    if (bounded.truncated) truncated = true;
    return bounded.value;
  };

  const workflows = data.workflows.map((entry) => ({
    name: entry.name,
    description: boundMeta(entry.description),
    whenToUse: boundMeta(entry.whenToUse),
    scope: entry.scope,
    path: entry.path,
    // Args keep names only: declaration detail (types/description/defaults) belongs to the save-confirm dialog.
    argNames: entry.args === undefined ? [] : Object.keys(entry.args),
  }));

  const invalid = data.invalid?.map((entry) => ({
    path: entry.path,
    reason: boundMeta(entry.reason),
  }));

  return {
    kind: "saved_workflow_list",
    workflows,
    ...(invalid !== undefined && invalid.length > 0 ? { invalid } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * The ListModels result card.
 *
 * Catalog rows are short ids and small numbers -- pass through. providerLabel/disabledReason are free text
 from the registry -> boundDisplayText. Rows cap at 100: the tool's model channel has a 24k budget, display
 does not, and a machine with aggregator providers can list thousands. When cut, say "not all shown", never a
 number: a catalog card's counts must be rows it actually drew.
 */
function createListModelsDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== LIST_MODELS_TOOL_NAME) return undefined;
  const parsed = ListModelsOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;

  const data = parsed.data;
  let truncated = false;

  const boundMeta = (value: string | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const bounded = boundDisplayText(value, WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS);
    if (bounded.truncated) truncated = true;
    return bounded.value;
  };

  const models = data.models.slice(0, WORKFLOW_OBSERVATION_DISPLAY_MAX_MODELS).map((model) => {
    const providerLabel = boundMeta(model.providerLabel);
    const disabledReason = boundMeta(model.disabledReason);
    return {
      id: model.id,
      providerId: model.providerId,
      modelId: model.modelId,
      ...(providerLabel === undefined ? {} : { providerLabel }),
      reasoningLevels: [...model.reasoningLevels],
      ...(model.defaultReasoningLevel === undefined
        ? {}
        : { defaultReasoningLevel: model.defaultReasoningLevel }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(disabledReason === undefined ? {} : { disabledReason }),
    };
  });
  if (models.length < data.models.length) truncated = true;

  return {
    kind: "list_models",
    // Absent when no catalog entry is current (as in the tool output: the session's choice may reference a removed provider).
    ...(data.current === undefined ? {} : { current: data.current }),
    models,
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * The ResumeWorkflowRun result card. Payload deliberately minimal {runId} -- the card's whole message is
 * "which run continues in the background"; response guidance copy belongs to the model channel and the UI
 * has its own localization. Unbounded face, so no truncated semantics.
 */
function createResumeWorkflowRunDisplay(
  toolName: string,
  output: unknown,
): ToolResultDisplayPayload | undefined {
  if (toolName !== RESUME_WORKFLOW_RUN_TOOL_NAME) return undefined;
  const parsed = ResumeWorkflowRunOutputSchema.safeParse(output);
  if (!parsed.success) return undefined;
  return { kind: "resume_workflow_run", runId: parsed.data.runId };
}
