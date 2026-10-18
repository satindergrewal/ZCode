import {
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
  STREAM_RECOVERY_DISCARDED_FINISH,
  SessionEventType,
  TurnMachineImpl,
  traceContextToLogContext,
} from "../deps.js";
import type { MessageId, Model, TraceContext } from "../deps.js";
import type { ModelSelection } from "@zcode/contracts";
import { isModelContextExceededError, projectExecutionErrorPayload } from "../helpers/index.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ModelExecutionContext } from "../types.js";
import { recordModelHistoryRound, type RegularTurnLoopState } from "./turn-loop-state.js";
import { createTurnModel } from "./turn-model.js";

type SelectionFallbackDeclaration = NonNullable<ModelExecutionContext["selectionFallback"]>;

export interface ExecutionSelectionFallbackMatch {
  reason: SelectionFallbackDeclaration["rules"][number]["reason"];
  providerErrorCode?: string;
  statusCode?: number;
}

export type ExecutionFallbackCandidateSource = "declared_target" | "session_selection";

export interface ExecutionFallbackCandidate {
  source: ExecutionFallbackCandidateSource;
  selection: ModelSelection;
}

export interface ExecutionSelectionFallbackResult {
  applied: boolean;
  settledAcceptedTools: boolean;
}

/**
 * Pure resolution: order fallback candidates by priority (docs/highspeed/highspeed-card-spec.md 2.2).
 * - Take the initiator-declared `target` first (the submission choice at card time, i.e. the session's original model), then the runtime's resident Selection.
 *   Root cause: the target used to rely only on the resident Selection, which lives in runtime memory — on cold restore, hitting the window where the Registry
 *   is ready but entitlements unresolved, validation failed without binding, later speed rounds never re-bound, and at 3402 the fallback silently skipped,
 *   failing the turn with a banner. The initiator knew the original model at card time; once it declares the target, stop betting on runtime state.
 * - A candidate may not be this turn's execution provider: falling back to the same failed endpoint just fails again.
 * - Deduplicate identical candidates so one target's resolution failure is not recorded twice.
 */
export function resolveExecutionFallbackCandidates(input: {
  declaredTarget: ModelSelection | undefined;
  executionProviderId: string;
  sessionSelection: ModelSelection | undefined;
}): ExecutionFallbackCandidate[] {
  const candidates: ExecutionFallbackCandidate[] = [];
  const seen = new Set<string>();
  const push = (
    source: ExecutionFallbackCandidateSource,
    selection: ModelSelection | undefined,
  ) => {
    if (!selection || selection.providerId === input.executionProviderId) return;
    const key = `${selection.providerId}/${selection.modelId}$${selection.options?.reasoningLevel ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ source, selection });
  };
  push("declared_target", input.declaredTarget);
  push("session_selection", input.sessionSelection);
  return candidates;
}

/**
 * Pure matching: does this model-request failure hit the execution Selection's fallback declaration (docs/highspeed/highspeed-card-spec.md 2.2)?
 * - Only when the step's actual model provider is the declared one; failures must attribute cleanly to that provider/network boundary.
 * - User cancel and context overflow are not fallback paths: cancel closes as a cancel; overflow goes to reactive compact (same model + same window would overflow again).
 * - Rules match in declaration order; a rule without providerErrorCode matches any upstream request failure; core never interprets provider error codes itself,
 *   nor hardcodes on provider id prefixes, model names, or error text.
 */
export function matchExecutionSelectionFallback(input: {
  error: unknown;
  executionProviderId: string;
  selectionFallback: ModelExecutionContext["selectionFallback"];
  turnAborted: boolean;
}): ExecutionSelectionFallbackMatch | undefined {
  const fallback = input.selectionFallback;
  if (!fallback || input.turnAborted) return undefined;
  if (input.executionProviderId !== fallback.providerId) return undefined;
  if (isModelContextExceededError(input.error)) return undefined;
  const attribution = projectExecutionErrorPayload(input.error).attribution;
  // Root cause: catch-all rules used to accept unattributed errors too, so a failed stream-event persist was misread as a provider
  // request failure and triggered a second model request. Only failures the adapter attributes to this turn's provider/network boundary may fall back.
  if (
    (attribution?.source !== "provider" && attribution?.source !== "network") ||
    attribution.providerId !== fallback.providerId
  ) {
    return undefined;
  }
  const providerErrorCode = attribution.providerErrorCode;
  const rule = fallback.rules.find(
    (candidate) =>
      candidate.providerErrorCode === undefined ||
      candidate.providerErrorCode === providerErrorCode,
  );
  if (!rule) return undefined;
  return {
    reason: rule.reason,
    ...(providerErrorCode !== undefined ? { providerErrorCode } : {}),
    ...(attribution?.statusCode !== undefined ? { statusCode: attribution.statusCode } : {}),
  };
}

/**
 * Fall back to the original model for this turn: keep committed history, swap only the remaining requests' model, and fall back at most once.
 * Even with nowhere to fall back, return the settlement facts of accepted tools so the caller keeps the original error termination without double-abandon.
 */
export async function applyExecutionSelectionFallback(
  runtime: AgentRuntimeInternal,
  state: RegularTurnLoopState,
  input: {
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    error: unknown;
    executionModel: Model;
    match: ExecutionSelectionFallbackMatch;
    modelTraceContext: TraceContext;
    streamingToolCoordinator: {
      settleForModelFallback(assistantCreatedAt: number): Promise<boolean>;
    };
  },
): Promise<ExecutionSelectionFallbackResult> {
  const executionModelSelection = {
    providerId: input.executionModel.providerId,
    modelId: input.executionModel.modelId,
  };
  const executionProviderId = String(executionModelSelection.providerId);
  const declaredTarget = state.selectionFallback?.target;
  const sessionSelection = runtime.getSessionModelSelection();
  // The fallback request uses the user's regular auth, so it no longer carries this execution's requestDependencies and the retry budget returns to default.
  const candidates = resolveExecutionFallbackCandidates({
    declaredTarget,
    executionProviderId,
    sessionSelection,
  });
  const skippedCandidates: Array<{
    source: ExecutionFallbackCandidateSource;
    providerId: string;
    modelId: string;
    error: string;
  }> = [];
  let resolved: { candidate: ExecutionFallbackCandidate; model: Model } | undefined;
  for (const candidate of candidates) {
    try {
      // When the target is unresolvable in the current Registry (e.g. provider unpublished) modeling throws: skip to the next candidate;
      // a modeling error must not replace the real speed-up failure reason.
      resolved = { candidate, model: createTurnModel(runtime, { selection: candidate.selection }) };
      break;
    } catch (error) {
      skippedCandidates.push({
        source: candidate.source,
        providerId: candidate.selection.providerId,
        modelId: candidate.selection.modelId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const failureAttribution = {
    ...(input.match.statusCode !== undefined ? { statusCode: input.match.statusCode } : {}),
    ...(input.match.providerErrorCode !== undefined
      ? { providerErrorCode: input.match.providerErrorCode }
      : {}),
    errorMessage: input.error instanceof Error ? input.error.message : String(input.error),
  };
  // Root cause: the old code settled tools only after target resolution succeeded; with no target and same-model recovery forbidden,
  // only abandon ran, losing real results and leaving durable ToolParts pending/running. Whether accepted tools close
  // and whether another model request may proceed are two decisions; the coordinator must commit live/durable/cold history first.
  const settledAcceptedTools = await input.streamingToolCoordinator.settleForModelFallback(
    input.assistantCreatedAt,
  );
  if (!resolved) {
    // With nowhere to fall back the turn fails on the real error, but leave a trace: this branch used to be silent, the user saw only a turn-failure banner,
    // and logs could not tell "no fallback" from "fell back, then the original model failed too".
    runtime.logger?.warn(
      "Execution model request failed but no fallback target could be resolved",
      {
        ...traceContextToLogContext(input.modelTraceContext),
        event: "model.execution_selection.fallback_unavailable",
        module: "core.runtime",
        status: "failed",
        reason: input.match.reason,
        fromProviderId: executionProviderId,
        fromModelId: String(executionModelSelection.modelId),
        hasDeclaredTarget: declaredTarget !== undefined,
        hasSessionSelection: sessionSelection !== undefined,
        skippedCandidates,
        ...failureAttribution,
      },
    );
    return { applied: false, settledAcceptedTools };
  }
  const fallbackSelection = resolved.candidate.selection;
  const fallbackModel = resolved.model;
  // Falling back masks real speed-up endpoint failures (e.g. a 401 from a missing Coding Plan header); keep one attributed warn so regressions
  // remain visible in logs. Record attribution fields only, never auth material or request bodies.
  runtime.logger?.warn("Execution model request failed; falling back to the original model", {
    ...traceContextToLogContext(input.modelTraceContext),
    event: "model.execution_selection.fallback",
    module: "core.runtime",
    status: "completed",
    reason: input.match.reason,
    fromProviderId: executionProviderId,
    fromModelId: String(executionModelSelection.modelId),
    toProviderId: fallbackSelection.providerId,
    toModelId: fallbackSelection.modelId,
    toSource: resolved.candidate.source,
    ...(skippedCandidates.length > 0 ? { skippedCandidates } : {}),
    ...failureAttribution,
  });
  await runtime.persistAssistantMessage(
    input.assistantMessageId,
    state.userMessageId,
    input.assistantCreatedAt,
    {
      completed: Date.now(),
      // Root cause: writing only completed let cold restore misread an exit before the fallback answer persisted as a success.
      // Reuse the unified discarded contract: this attempt is void, but the user request still awaits a later assistant.
      error: {
        name: STREAM_RECOVERY_DISCARDED_ERROR_NAME,
        data: {
          message:
            "Execution-model output was discarded before continuing with the fallback model.",
        },
      },
      finish: STREAM_RECOVERY_DISCARDED_FINISH,
    },
    input.modelTraceContext,
    input.executionModel,
  );
  const fallbackEvent = runtime.createEvent(
    SessionEventType.TurnExecutionModelFallback,
    {
      ...(state.inputId ? { inputId: state.inputId } : {}),
      reason: input.match.reason,
      fromModelSelection: executionModelSelection,
      toModelSelection: {
        providerId: fallbackSelection.providerId,
        modelId: fallbackSelection.modelId,
      },
    },
    state.turnTraceContext,
  );
  await runtime.appendEvent(fallbackEvent, state.turnTraceContext);
  state.events.push(fallbackEvent);
  state.model = fallbackModel;
  // Fall back at most once: if the post-fallback plain model fails too, the turn must fail on the real error.
  state.selectionFallback = undefined;
  if (!settledAcceptedTools) {
    state.modelResponse = "";
    state.modelStepCount += 1;
    recordModelHistoryRound(state);
    state.turnMachine = new TurnMachineImpl(state.turnMachine.receiveModelResponse(""));
    state.turnMachine = new TurnMachineImpl(state.turnMachine.aggregateResults());
  }
  return { applied: true, settledAcceptedTools };
}
