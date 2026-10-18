import type { ModelRequestSessionType, ModelRetryBudget } from "@zcode/contracts";
import {
  CoreErrorType,
  createCoreError,
  getCurrentModelInvocationContext,
  runWithModelInvocationContext,
  type Model,
  type ModelInvocationContext,
  type ModelRequest,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeModelFactoryInput } from "../types.js";
import {
  resolveModelRequestSessionTypeFromTaskType,
  resolveModelRetryBudgetFromTaskType,
} from "./model-request-session-type.js";

export function createRuntimeModel(
  runtime: AgentRuntimeInternal,
  input: Omit<RuntimeModelFactoryInput, "selection"> & {
    selection: RuntimeModelFactoryInput["selection"] | undefined;
    scope?: "session" | "workspace";
    /**
     * Overrides the taskType-derived retry budget, bound to this handle only; never enters the Factory input.
     * Today only execution-scoped Selections with a declared selectionFallback use single-attempt.
     */
    retryBudget?: ModelRetryBudget;
  },
): Model {
  const { retryBudget, scope = "session", ...factoryInput } = input;
  // No Session bound, no restorable history; only the execution entry rejects a missing choice.
  if (!factoryInput.selection) {
    throw createCoreError(CoreErrorType.ConfigurationError, "Select a model before continuing", {
      recoverable: true,
    });
  }
  return withRuntimeInvocationLayer(
    runtime,
    runtime.modelFactory({ ...factoryInput, selection: factoryInput.selection }),
    scope === "workspace"
      ? "other"
      : resolveModelRequestSessionTypeFromTaskType(runtime.config.taskType),
    retryBudget,
  );
}

/**
 * The runtime-layer invocation context.
 *
 * Admission port and retry budget answer who-calls (which governor, how many retries), not
 * why-calls (agent step / web_search / compact / title). Design gap: injected only at the turn step,
 * the nine why-only sites (WebSearch / WebFetch / compact / title sidecar…) bypassed the gate —
 * in the field the governor missed two-thirds of 429s. Both fields now bind on the handle
 * factory once; `withModelInvocationContext` puts this layer over call sites, no per-call opt-out:
 * a runtime wanting no gate ships without an admission port.
 */
function withRuntimeInvocationLayer(
  runtime: AgentRuntimeInternal,
  model: Model,
  sessionType: ModelRequestSessionType,
  retryBudget?: ModelRetryBudget,
): Model {
  const layer: ModelInvocationContext = {
    // Why: title, Memory, and tool calls used to override other per purpose, losing the host's classification.
    // Session kind is bound to the handle; workspace-standalone requests keep other even when borrowing the session runtime.
    modelRequestSessionType: sessionType,
    // Handles with a declared fallback pass single-attempt explicitly; the rest keep the taskType default budget.
    modelRetryBudget: retryBudget ?? resolveModelRetryBudgetFromTaskType(runtime.config.taskType),
    ...(runtime.modelRequestAdmission === undefined
      ? {}
      : { modelRequestAdmission: runtime.modelRequestAdmission }),
  };
  return withModelInvocationContext(model, () => layer);
}

export function withModelInvocationContext(
  model: Model,
  createContext: (request: ModelRequest) => ModelInvocationContext,
): Model {
  const wrapped: Model = {
    providerId: model.providerId,
    modelId: model.modelId,
    displayName: model.displayName,
    properties: model.properties,
    optionSpecs: model.optionSpecs,
    options: model.options,
    bind(options) {
      return withModelInvocationContext(model.bind(options), createContext);
    },
    generateText(request) {
      return runWithModelInvocationContext(
        { ...getCurrentModelInvocationContext(), ...createContext(request) },
        () => model.generateText(request),
      );
    },
    streamText(request) {
      return runWithModelInvocationContext(
        { ...getCurrentModelInvocationContext(), ...createContext(request) },
        () => model.streamText(request),
      );
    },
  };
  return Object.freeze(wrapped);
}
