import {
  CoreErrorType,
  SessionEventType,
  createCoreError,
  createModelUsageSummaryFromEvents,
  isCoreError,
  traceContextToLogContext,
} from "../deps.js";
import type { SessionEvent, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  ErrorPayloadRole,
  projectExecutionErrorPayload,
  withErrorPayloadRole,
} from "../../errors/error-payload.js";
import { isModelContextExceededError } from "./model-errors.js";

export { projectExecutionErrorPayload } from "../../errors/error-payload.js";

interface TurnAbortScope {
  dispose: () => void;
  signal: AbortSignal;
}

const EXTERNAL_TURN_FAULT_MARKER = "zcode.externalTurnFault";

interface ExternalTurnFaultError extends Error {
  code: string;
  zcodeTurnFault: typeof EXTERNAL_TURN_FAULT_MARKER;
}

/** Narrow host entry to abort a turn while making core persist a TurnError, not a user cancellation. */
export function createExternalTurnFaultError(code: string, message = code): Error {
  return Object.assign(new Error(message), {
    code,
    zcodeTurnFault: EXTERNAL_TURN_FAULT_MARKER as typeof EXTERNAL_TURN_FAULT_MARKER,
  }) satisfies ExternalTurnFaultError;
}

function findExternalTurnFault(error: unknown): ExternalTurnFaultError | null {
  let current = error;
  const seen = new WeakSet<object>();
  for (let depth = 0; depth <= 6; depth += 1) {
    if (!current || typeof current !== "object" || seen.has(current)) return null;
    seen.add(current);
    const record = current as Record<string, unknown>;
    if (
      record.zcodeTurnFault === EXTERNAL_TURN_FAULT_MARKER &&
      typeof record.code === "string" &&
      current instanceof Error
    ) {
      return current as ExternalTurnFaultError;
    }
    current = record.cause;
  }
  return null;
}

export function createTurnAbortScope(parentSignal?: AbortSignal): TurnAbortScope {
  const controller = new AbortController();

  const abortTurn = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal?.reason);
    }
  };

  if (parentSignal?.aborted) {
    abortTurn();
    return { dispose: () => {}, signal: controller.signal };
  }

  parentSignal?.addEventListener("abort", abortTurn, { once: true });

  return {
    dispose: () => {
      parentSignal?.removeEventListener("abort", abortTurn);
    },
    signal: controller.signal,
  };
}

export function throwIfTurnAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw createTurnCancelledError(signal.reason);
}

export function createTurnFailureError(
  error: unknown,
  abortSignal: AbortSignal | undefined,
  fallbackMessage: string,
) {
  const externalFault = findExternalTurnFault(abortSignal?.reason) ?? findExternalTurnFault(error);
  if (externalFault) {
    return createCoreError(CoreErrorType.UnknownError, externalFault.message, {
      cause: externalFault,
      recoverable: true,
    });
  }
  if (isTurnCancellationError(error, abortSignal)) {
    return createTurnCancelledError(error);
  }

  if (
    isCoreError(error) &&
    (error.type === CoreErrorType.ModelContextExceeded ||
      (fallbackMessage === "Turn execution failed" && error.type === CoreErrorType.ModelError))
  ) {
    return error;
  }

  if (isModelContextExceededError(error)) {
    return createCoreError(
      CoreErrorType.ModelContextExceeded,
      "Model request exceeded the provider context window.",
      { cause: error instanceof Error ? error : undefined, recoverable: true, retryable: true },
    );
  }

  return createCoreError(CoreErrorType.UnknownError, fallbackMessage, {
    cause: error instanceof Error ? error : undefined,
    // A turn-level UnknownError is only a lifecycle wrapper; the UI/error payload
    // must show the user-readable root cause from the underlying provider/tool, not let generic copy take the summary.
    context: withErrorPayloadRole(undefined, ErrorPayloadRole.Wrapper),
  });
}

export function createTurnCancelledError(error: unknown) {
  if (isCoreError(error) && error.type === CoreErrorType.TurnCancelled) {
    return error;
  }

  return createCoreError(CoreErrorType.TurnCancelled, "Turn was cancelled.", {
    cause: error instanceof Error ? error : undefined,
    recoverable: true,
  });
}

// A user-interrupted turn (TurnCancelled) is a normal end, not an error. The three catch sites (turn/compact/rewind)
// used to emit TurnError unconditionally, which reducer/UI/desktop map to turn.failed (status:error plus an error message).
// Single funnel: cancellations emit TurnComplete(resultType:"cancelled") so state returns to idle cleanly; real errors emit TurnError.
// Callers still rethrow coreError and record usage.
export async function appendTurnOutcomeEvent(
  runtime: AgentRuntimeInternal,
  params: {
    coreError: ReturnType<typeof createTurnFailureError>;
    events: SessionEvent[];
    durationMs: number;
    turnPhase: string;
    inputId?: string;
    traceContext: TraceContext;
    fallbackMessage: string;
    logEvent: string;
    logLabel: string;
    preserveQueueAutoDrainOnCancel?: boolean;
    backgroundSubagentResultConsumed?: boolean;
    workflowResultConsumed?: boolean;
    historyRoundCount?: number;
  },
): Promise<void> {
  const { coreError, events, traceContext, turnPhase, inputId } = params;
  const cancelled = coreError.type === CoreErrorType.TurnCancelled;
  const externalFault = findExternalTurnFault(coreError);

  const outcomeEvent = cancelled
    ? runtime.createEvent(
        SessionEventType.TurnComplete,
        {
          response: "",
          tokenCount: 0,
          usage: createModelUsageSummaryFromEvents(events),
          toolCallCount: 0,
          historyRoundCount: params.historyRoundCount ?? 0,
          duration: params.durationMs,
          resultType: "cancelled",
          inputId,
          ...(params.backgroundSubagentResultConsumed
            ? { backgroundSubagentResultConsumed: true }
            : {}),
          ...(params.workflowResultConsumed ? { workflowResultConsumed: true } : {}),
          ...(params.preserveQueueAutoDrainOnCancel
            ? { preserveQueueAutoDrainOnCancel: true }
            : {}),
        },
        traceContext,
      )
    : runtime.createEvent(
        SessionEventType.TurnError,
        {
          error: {
            type: externalFault?.code ?? coreError.type,
            // coreError.message is often generic; the real provider/network cause hides in the cause chain,
            // so write readable payload fields, letting desktop and recovery paths show the root cause.
            ...projectExecutionErrorPayload(coreError, params.fallbackMessage),
            stack: coreError.stack,
          },
          turnPhase,
          inputId,
          ...(params.backgroundSubagentResultConsumed
            ? { backgroundSubagentResultConsumed: true }
            : {}),
          ...(params.workflowResultConsumed ? { workflowResultConsumed: true } : {}),
        },
        traceContext,
      );
  await runtime.appendEvent(outcomeEvent, traceContext);
  events.push(outcomeEvent);

  runtime.logger?.error(`${params.logLabel} failed`, coreError, {
    ...traceContextToLogContext(traceContext),
    event: params.logEvent,
    module: "core.runtime",
    status: cancelled ? "cancelled" : "failed",
    turnPhase,
  });
}

export function isTurnCancellationError(error: unknown, abortSignal?: AbortSignal): boolean {
  if (findExternalTurnFault(abortSignal?.reason) || findExternalTurnFault(error)) return false;
  if (abortSignal?.aborted) return true;

  let current = error;
  const seen = new WeakSet<object>();
  for (let depth = 0; depth <= 6; depth += 1) {
    if (current === undefined || current === null) return false;
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);

    if (isCoreError(current) && current.type === CoreErrorType.TurnCancelled) {
      return true;
    }

    const record = current as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : undefined;
    const code = typeof record.code === "string" ? record.code : undefined;
    const name = typeof record.name === "string" ? record.name : undefined;
    if (
      type === CoreErrorType.TurnCancelled ||
      code === CoreErrorType.TurnCancelled ||
      code === "MODEL_REQUEST_CANCELLED" ||
      code === "model_request_cancelled" ||
      code === "ABORT_ERR" ||
      name === "AbortError"
    ) {
      return true;
    }

    current = record.cause;
  }

  return false;
}
