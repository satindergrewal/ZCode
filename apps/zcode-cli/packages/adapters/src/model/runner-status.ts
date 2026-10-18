import type {
  Logger,
  ModelRequestObservationStatusEvent,
  ModelNetworkStatusEvent,
  ModelReasoningCallHint,
  ModelStatusSink,
  ModelTransportKind,
  ModelRequestSessionType as ModelRequestSessionTypeValue,
  QueryId,
  ResolvedModelApiCallObservation,
  TraceId,
} from "@zcode/contracts";
import {
  ModelFailureReason as ModelFailureReasonValue,
  createTraceId,
  resolveModelApiCallObservation,
} from "@zcode/contracts";
import { UNBOUNDED_RETRY_MAX_ATTEMPTS } from "./retry-budget.js";
// Request-attribution headers live in runner-attribution.ts (max-lines split); the public surface still exports here,
// so existing importers keep their paths.
import { resolveModelRequestSessionType } from "./runner-attribution.js";
import type { AiSdkModelTextRequest, ResolvedAiSdkModel } from "./runner-runtime.js";
import type { ModelRequestObservationSource } from "./request-security.js";
import { stringMetadata } from "./runner-record.js";

export {
  createModelRequestAttributionHeaders,
  normalizeModelSessionIdForAttribution,
  resolveModelRequestSessionType,
} from "./runner-attribution.js";

export interface ModelStatusContext {
  traceId: TraceId;
  queryId?: QueryId;
  sessionId?: ModelNetworkStatusEvent["sessionId"];
  turnId?: ModelNetworkStatusEvent["turnId"];
  parentSessionId?: ModelNetworkStatusEvent["parentSessionId"];
  toolCallId?: string;
  spanId?: string;
  parentSpanId?: string;
  querySource?: string;
  requestId: string;
  providerId: ResolvedAiSdkModel["providerId"];
  modelId: ResolvedAiSdkModel["modelId"];
  modelRequestSessionType: ModelRequestSessionTypeValue;
  baseURL?: string;
  providerKind?: string;
  transport: ModelTransportKind;
  maxAttempts: number;
  streamRecovery?: ModelNetworkStatusEvent["streamRecovery"];
  modelCall: ResolvedModelApiCallObservation;
}

export function createStatusContext(input: {
  maxAttempts: number;
  request: AiSdkModelTextRequest;
  resolved: ResolvedAiSdkModel;
  transport: ModelTransportKind;
}): ModelStatusContext {
  const metadata = input.request.metadata ?? {};
  const querySource = stringMetadata(metadata.querySource);
  const resolvedModelCall = resolveModelApiCallObservation(querySource, input.request.modelCall);
  return {
    baseURL: input.resolved.baseURL,
    maxAttempts: input.maxAttempts,
    providerId: input.resolved.providerId,
    modelId: input.resolved.modelId,
    modelRequestSessionType: resolveModelRequestSessionType(
      input.request.modelRequestSessionType,
      resolvedModelCall,
    ),
    requestId: stringMetadata(metadata.requestId) ?? crypto.randomUUID(),
    sessionId: (input.request.traceContext?.sessionId ??
      stringMetadata(metadata.sessionId)) as ModelStatusContext["sessionId"],
    spanId: input.request.traceContext?.spanId ?? stringMetadata(metadata.spanId),
    parentSpanId:
      input.request.traceContext?.parentSpanId ??
      stringMetadata(metadata.parentSpanId) ??
      stringMetadata(metadata.parentId),
    querySource,
    queryId: (input.request.traceContext?.queryId ?? stringMetadata(metadata.queryId)) as
      | QueryId
      | undefined,
    traceId: (input.request.traceContext?.traceId ??
      stringMetadata(metadata.traceId) ??
      createTraceId()) as TraceId,
    providerKind: input.resolved.providerKind,
    streamRecovery: input.request.streamRecovery,
    transport: input.transport,
    turnId: (input.request.traceContext?.turnId ??
      stringMetadata(metadata.turnId)) as ModelStatusContext["turnId"],
    parentSessionId: stringMetadata(metadata.parentSessionId) as
      | ModelStatusContext["parentSessionId"]
      | undefined,
    toolCallId: stringMetadata(metadata.toolCallId),
    modelCall: {
      ...resolvedModelCall,
      agentName: resolvedModelCall.agentName ?? stringMetadata(metadata.agentName),
      operationId:
        resolvedModelCall.operationId ??
        input.request.traceContext?.spanId ??
        stringMetadata(metadata.spanId),
      stepIndex:
        resolvedModelCall.stepIndex ??
        (typeof metadata.stepIndex === "number"
          ? metadata.stepIndex
          : typeof metadata.iteration === "number"
            ? metadata.iteration
            : undefined),
      reasoning: initialReasoningObservation(resolvedModelCall.reasoning, undefined),
    },
  };
}

export function createAttemptStatusContext(
  statusContext: ModelStatusContext,
  attempt: number,
): ModelStatusContext {
  if (attempt <= 1) {
    return statusContext;
  }

  return {
    ...statusContext,
    // An adapter retry starts a new physical provider request;
    // reusing the first requestId would cross-wire upstream logs and retry-after diagnostics.
    requestId: crypto.randomUUID(),
  };
}

function initialReasoningObservation(
  hint: ModelReasoningCallHint | undefined,
  modelVariant: string | undefined,
): ResolvedModelApiCallObservation["reasoning"] {
  const explicit = hint?.explicit;
  return {
    capability: "unknown",
    requestedControl: explicit?.controlType ?? "provider_default",
    requestedState: explicit?.state ?? "provider_default",
    requestedLevel: hint?.requestedLevel ?? modelVariant,
    effectiveControl: explicit?.controlType ?? "unknown",
    effectiveState: explicit?.state ?? "unknown",
    effectiveLevel:
      explicit?.effectiveLevel ?? (explicit?.state === "disabled" ? "disabled" : "unknown"),
    ...(explicit?.effectiveBudgetTokens !== undefined
      ? { effectiveBudgetTokens: explicit.effectiveBudgetTokens }
      : {}),
  };
}

/**
 * Status events at both admission ends: tryAcquire miss emits queued, a granted token emits
 * admitted (with queue time). No token exists yet, so delivery skips the ticket; the governor needs neither.
 */
export function admissionWaitPublishers(
  statusContext: ModelStatusContext,
  attempt: number,
  publishOptions: Parameters<typeof publishModelStatus>[1],
): {
  onQueued: () => Promise<void>;
  onAdmitted: (queuedMs: number) => Promise<void>;
} {
  return {
    onQueued: () =>
      publishModelStatus(
        {
          ...statusContext,
          attempt,
          timestamp: new Date().toISOString(),
          type: "model_request_queued",
        },
        publishOptions,
      ),
    onAdmitted: (queuedMs) =>
      publishModelStatus(
        {
          ...statusContext,
          attempt,
          queuedMs,
          timestamp: new Date().toISOString(),
          type: "model_request_admitted",
        },
        publishOptions,
      ),
  };
}

export async function publishModelStatus(
  event: ModelNetworkStatusEvent,
  options: {
    /**
     * This attempt's admission token: the attempt-private
     * status-event sink the governor reads results from. Same delivery discipline as request/telemetry sinks (warn on failure).
     */
    admissionTicket?: ModelStatusSink;
    requestObservations?: ModelRequestObservationSource;
    failureError?: unknown;
    logger?: Logger;
    requestStatusSink?: ModelStatusSink;
    statusSink?: ModelStatusSink;
  },
): Promise<void> {
  logStatusEvent(event, options.logger);
  await publishRequestObservations(event, options);

  const deliveries: Array<() => void | Promise<void>> = [];
  if (options.admissionTicket) {
    const ticket = options.admissionTicket;
    deliveries.push(() => ticket.publish(event));
  }
  if (options.statusSink) {
    const statusSink = options.statusSink;
    if (options.requestStatusSink && options.requestStatusSink !== options.statusSink) {
      deliveries.push(() => options.requestStatusSink!.publish(event));
    }
    deliveries.push(() =>
      event.type === "model_request_failed" &&
      options.failureError !== undefined &&
      statusSink.publishFailure
        ? statusSink.publishFailure(event, options.failureError)
        : statusSink.publish(event),
    );
  } else if (options.requestStatusSink) {
    deliveries.push(() => options.requestStatusSink!.publish(event));
  }
  if (deliveries.length === 0) return;

  const results = await Promise.allSettled(
    deliveries.map((deliver) => Promise.resolve().then(deliver)),
  );
  for (const result of results) {
    if (result.status === "rejected") {
      options.logger?.warn("Model status sink failed", {
        ...modelStatusLogContext(event),
        errorMessage:
          result.reason instanceof Error ? result.reason.message : String(result.reason),
        event: "model.status_sink.failed",
        status: "failed",
      });
    }
  }
}

/**
 * Before the attempt's terminal state, take the signer's staged signature observations by requestId and emit them only to the process-level Telemetry Sink.
 // Must preceder the terminal event: once the recorder sees a terminal state it frees that attempt's span writer.
 // The local log already wrote at the fetch layer; no duplicate here.
 */
async function publishRequestObservations(
  event: ModelNetworkStatusEvent,
  options: {
    requestObservations?: ModelRequestObservationSource;
    logger?: Logger;
    statusSink?: ModelStatusSink;
  },
): Promise<void> {
  if (event.type !== "model_request_completed" && event.type !== "model_request_failed") return;
  const store = options.requestObservations;
  if (!store) return;
  const observations = store.take(event.requestId);
  if (observations.length === 0 || !options.statusSink) return;
  for (const observation of observations) {
    const observationEvent: ModelRequestObservationStatusEvent = {
      ...event,
      observation,
      type: "model_request_observation",
    };
    try {
      await options.statusSink.publish(observationEvent);
    } catch (error) {
      options.logger?.warn("Model request observation sink failed", {
        ...modelStatusLogContext(event),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "model.request_observation.sink_failed",
        status: "failed",
      });
    }
  }
}

/**
 * Provider streaming milestones go only to the process-level telemetry sink, never into SessionEvent:
 * requestStatusSink is conversation product state and must stay unpolluted by pure observability.
 */
export async function publishModelTelemetryMilestone(
  event: Extract<
    ModelNetworkStatusEvent,
    {
      type: "model_first_provider_event" | "model_first_content" | "model_first_text";
    }
  >,
  options: {
    logger?: Logger;
    statusSink?: ModelStatusSink;
  },
): Promise<void> {
  logStatusEvent(event, options.logger);
  if (!options.statusSink) return;
  try {
    await options.statusSink.publish(event);
  } catch (error) {
    options.logger?.warn("Model telemetry milestone sink failed", {
      ...modelStatusLogContext(event),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "model.telemetry_milestone.failed",
      status: "failed",
    });
  }
}

export function modelStatusContextToLogContext(
  statusContext: ModelStatusContext | ModelNetworkStatusEvent,
  attempt: number,
): Record<string, unknown> {
  return {
    attempt,
    baseURL: statusContext.baseURL,
    maxAttempts: statusContext.maxAttempts,
    // maxAttempts 0 means unbounded: express maxRetries as 0 too, not the accidental max(0, -1).
    maxRetries:
      statusContext.maxAttempts === UNBOUNDED_RETRY_MAX_ATTEMPTS
        ? UNBOUNDED_RETRY_MAX_ATTEMPTS
        : Math.max(0, statusContext.maxAttempts - 1),
    modelId: statusContext.modelId,
    parentSpanId: statusContext.parentSpanId,
    providerId: statusContext.providerId,
    providerKind: statusContext.providerKind,
    queryId: statusContext.queryId,
    querySource: statusContext.querySource,
    requestId: statusContext.requestId,
    sessionId: statusContext.sessionId,
    spanId: statusContext.spanId,
    traceId: statusContext.traceId,
    transport: statusContext.transport,
    turnId: statusContext.turnId,
  };
}

function modelStatusLogContext(event: ModelNetworkStatusEvent): Record<string, unknown> {
  return modelStatusContextToLogContext(event, event.attempt);
}

function logStatusEvent(event: ModelNetworkStatusEvent, logger?: Logger): void {
  switch (event.type) {
    case "model_request_queued":
      logger?.debug("Model request queued for admission", {
        ...modelStatusLogContext(event),
        event: "model.request.queued",
        status: "waiting",
      });
      return;

    case "model_request_admitted":
      logger?.debug("Model request admitted", {
        ...modelStatusLogContext(event),
        event: "model.request.admitted",
        queuedMs: event.queuedMs,
        status: "started",
      });
      return;

    case "model_request_started":
      logger?.debug("Model request attempt started", {
        ...modelStatusLogContext(event),
        event: "model.request.started",
        status: "started",
      });
      return;

    case "model_request_completed":
      logger?.info("Model request completed", {
        ...modelStatusLogContext(event),
        durationMs: event.durationMs,
        event: "model.request.completed",
        finishReason: event.finishReason,
        status: "completed",
      });
      return;

    case "model_retry_scheduled":
      logger?.warn("Model request retry scheduled", {
        ...modelStatusLogContext(event),
        delayMs: event.delayMs,
        event: "model.retry.scheduled",
        nextAttempt: event.nextAttempt,
        reason: event.reason,
        status: "waiting",
        statusCode: event.statusCode,
        statusMessage: event.message,
      });
      return;

    case "model_request_failed":
      logger?.warn("Model request attempt failed", {
        ...modelStatusLogContext(event),
        durationMs: event.durationMs,
        event: "model.request.failed",
        reason: event.reason,
        retryable: event.retryable,
        status: event.reason === ModelFailureReasonValue.Cancelled ? "cancelled" : "failed",
        statusCode: event.statusCode,
        statusMessage: event.message,
      });
      return;

    case "model_stream_stalled":
      logger?.warn("Model stream stalled", {
        ...modelStatusLogContext(event),
        event: "model.stream.stalled",
        idleMs: event.idleMs,
        status: "waiting",
        statusMessage: event.message,
        timeoutMs: event.timeoutMs,
      });
      return;

    case "model_first_provider_event":
    case "model_first_content":
    case "model_first_text":
      logger?.debug("Model telemetry milestone observed", {
        ...modelStatusLogContext(event),
        elapsedMs: event.elapsedMs,
        event: event.type,
        status: "completed",
      });
      return;

    case "model_request_observation":
      // The fetch layer already wrote the local log; this only delivers telemetry.
      return;
  }
}
