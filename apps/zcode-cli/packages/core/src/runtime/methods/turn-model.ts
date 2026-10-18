import {
  ModelRetryBudget,
  SESSION_ENTRY_MODEL_SELECTION,
  type Model,
  type ModelSelection,
  type TraceContext,
  type TurnInputIntentMetadata,
} from "@zcode/contracts";
import { getCurrentModelInvocationContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { cloneModelSelection } from "../model-selection.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { createRuntimeModel, withModelInvocationContext } from "./runtime-model.js";
import { applyRuntimeExecutionState } from "../execution-state.js";

/**
 * An execution handle with a fallback declaration whose Selection points at the declared provider gets exactly one physical request: on failure core falls back to the session model
 * to finish the turn; adapter-level retries on the default budget would only postpone the downgrade by minutes (spec 2.2, "speed-up requests retry 0 times").
 * Other handles return undefined and keep the taskType-derived default budget.
 */
export function resolveExecutionModelRetryBudget(input: {
  selection: ModelSelection | undefined;
  selectionFallback: import("../types.js").ModelExecutionContext["selectionFallback"];
}): ModelRetryBudget | undefined {
  if (!input.selection || !input.selectionFallback) return undefined;
  return input.selection.providerId === input.selectionFallback.providerId
    ? ModelRetryBudget.SingleAttempt
    : undefined;
}

export function createTurnModel(
  runtime: AgentRuntimeInternal,
  options: {
    selection?: ModelSelection;
    requestDependencies?: import("@zcode/contracts").ModelRequestDependencies;
    retryBudget?: ModelRetryBudget;
  } = {},
): Model {
  const selection = options.selection ?? runtime.getSessionModelSelection();
  const model = createRuntimeModel(runtime, {
    selection,
    requestDependencies: options.requestDependencies,
    retryBudget: options.retryBudget,
  });
  return withModelInvocationContext(model, (request) => ({
    refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(runtime, {
      abortSignal: request.abortSignal,
      model,
      traceContext: getCurrentModelInvocationContext()?.traceContext ?? runtime.rootTraceContext,
    }),
  }));
}

/**
 * Its execution config applies at real Submission start or when a Guide is consumed by the next model step.
 * The choice affects newly created Models only; Models held by other Loops stay untouched.
 */
export async function applySubmissionExecutionState(
  runtime: AgentRuntimeInternal,
  intent: TurnInputIntentMetadata | undefined,
  traceContext: TraceContext,
  modelExecution?: import("../types.js").ModelExecutionContext,
  preparedModel?: Model,
): Promise<Model | undefined> {
  const selection = intent?.modelSelection;
  const previousSelection = runtime.getSessionModelSelection();
  let model = preparedModel;

  if (selection) {
    model ??= createTurnModel(runtime, {
      selection,
      requestDependencies: modelExecution?.requestDependencies,
      retryBudget: resolveExecutionModelRetryBudget({
        selection,
        selectionFallback: modelExecution?.selectionFallback,
      }),
    });
    if (modelExecution?.selectionScope !== "execution") {
      const appliedSelection = cloneModelSelection(selection);
      runtime.setSessionModelSelection(appliedSelection);
      await persistRuntimeModelSelection(runtime, appliedSelection);
      if (!sameModelSelection(previousSelection, appliedSelection)) {
        await runtime.emitModelSelected({
          model,
          modelSelection: appliedSelection,
          effectiveReasoningLevel: model.options.reasoningLevel,
          previousModelSelection: previousSelection,
          supportedThoughtLevels: model.optionSpecs.reasoningLevel.values,
          traceContext,
        });
      }
    }
  }

  if (intent?.mode !== undefined || intent?.planEnabled !== undefined) {
    await applyRuntimeExecutionState(runtime, intent, { source: "command", traceContext });
  }

  return model;
}

export function sameModelSelection(
  left: ModelSelection | undefined,
  right: ModelSelection,
): boolean {
  return (
    left?.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.options?.reasoningLevel === right.options?.reasoningLevel
  );
}

export async function persistRuntimeModelSelection(
  runtime: AgentRuntimeInternal,
  selection: ModelSelection,
): Promise<void> {
  if (!runtime.sessionStore?.saveSessionEntry) return;
  const timestamp = Date.now();
  try {
    await runtime.sessionStore.saveSessionEntry({
      id: `${runtime.sessionId}:runtime-model-selection`,
      sessionID: runtime.sessionId,
      type: SESSION_ENTRY_MODEL_SELECTION,
      touchSession: false,
      time: { created: timestamp, updated: timestamp },
      data: selection,
    });
  } catch (error) {
    runtime.logger?.warn("Session model selection persistence failed", {
      error: error instanceof Error ? error.message : String(error),
      event: "session.model_selection.persist_failed",
      modelId: selection.modelId,
      module: "core.runtime",
      providerId: selection.providerId,
      status: "failed",
      thoughtLevel: selection.options?.reasoningLevel,
    });
  }
}
