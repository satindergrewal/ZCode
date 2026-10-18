import type { TextStreamPart, ToolSet } from "ai";
import type { Logger, ModelStatusSink, ModelStreamEvent } from "@zcode/contracts";
import {
  ModelErrorCode,
  ModelFailureReason as ModelFailureReasonValue,
  ModelProtocolError,
  ModelRetryReason,
  ModelTransportKind as ModelTransportKindValue,
  type ModelRetryBudget,
} from "@zcode/contracts";
import {
  classifyModelFailure,
  findProviderBusinessError,
  inspectProviderFailure,
  type ClassifiedModelFailure,
} from "./failure-classifier.js";
import { resolveAnthropicRequestMetadataUserId } from "./anthropic-request-metadata.js";
import {
  getErrorCode,
  getHttpResponseStatus,
  getResponseHeaders,
  unwrapRetryError,
} from "./failure-inspection.js";
import { offPeakTicketExpiredMessage, resolveOffPeakFailureDecision } from "./offpeak-retry.js";
import { isRetrySafePreludeStreamEvent } from "./stream-retry-boundary.js";
import {
  createLinkedAbortController,
  isModelStreamIdleTimeoutError,
  readNextWithStreamIdleTimeout,
  resolveModelStreamIdleTimeoutMs,
} from "./stream-idle-timeout.js";
import {
  createStreamDiagnostics,
  isZeroOutputModelCompletion,
  isSuspiciousStreamDiagnostics,
  logIgnoredStreamChunk,
  logStreamDiagnostics,
  logStreamFailureDiagnostics,
  recordStreamChunkDiagnostic,
} from "./runner-diagnostics.js";
import { canRetryEmptyCompletion, scheduleEmptyCompletionRetry } from "./empty-completion-retry.js";
import { createStreamTextOptions } from "./runner-options.js";
import {
  isDevelopmentModelIOEnv,
  recordStreamTextDebug,
  shouldRecordModelIO,
} from "./runner-debug.js";
import { sanitizeModelNetworkHeaders } from "./runner-network-headers.js";
import { admitAttempt, type AttemptAdmission } from "./request-admission.js";
import {
  retryAttemptLoopContinues,
  retryBudgetAllows,
  retryBudgetMaxAttempts,
} from "./retry-budget.js";
import { toModelStreamEvent } from "./runner-normalization.js";
import type { EnvRecord } from "./model-execution.js";
import { detectProviderBusinessFinishError } from "./provider-finish-business-error.js";
import {
  calculateRetryDelay,
  logRetryDelayDecision,
  sleep,
  TerminalStreamChunkError,
  toAdapterError,
} from "./runner-retry.js";
import {
  admissionWaitPublishers,
  createAttemptStatusContext,
  createStatusContext,
  publishModelStatus,
  publishModelTelemetryMilestone,
} from "./runner-status.js";
import { StreamingToolCallAssembler } from "./streaming-tool-call-assembler.js";
import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";
import type {
  AiSdkStreamTextResult,
  AiSdkModelRuntime,
  AiSdkModelTextRequest,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";
import { resolveModelForAttempt, RuntimeHeadersRefreshError } from "./runner-runtime-headers.js";
import { retryAllowedByFailurePolicy } from "./workflow-model-failure-policy.js";
import {
  modelFailureStatusFields,
  providerRequestIdFromHeaders,
  readModelFailureErrorPhase,
} from "./runner-telemetry.js";
import { repairReasoningHistoryAfterSignatureRejection } from "./reasoning-history-normalization.js";

type StreamFailurePhase = "request_setup" | "response_body";

const STREAM_ATTEMPT_CLEANUP_TIMEOUT_MS = 1_000;

export async function* runStreamText(input: {
  debugDir?: string;
  env: EnvRecord;
  logger?: Logger;
  request: AiSdkModelTextRequest;
  resolveModel: () => ResolvedAiSdkModel;
  resolved: ResolvedAiSdkModel;
  retry: ResolvedAiSdkModelRetryOptions;
  runtime: AiSdkModelRuntime;
  statusSink?: ModelStatusSink;
  streamIdleTimeoutMs: number;
  modelIoFullRetentionEnabled: boolean;
}): AsyncGenerator<ModelStreamEvent> {
  // Retry budget tier: only relaxes the give-up conditions for transient failures;
  // the no-retry-after-emittedRetryBoundaryEvent rule stands. Status events use maxAttempts 0 for unbounded.
  const retryBudget = input.request.modelRetryBudget;
  const statusMaxAttempts = (extraAttempts: number): number =>
    retryBudgetMaxAttempts(retryBudget, input.retry.maxAttempts + extraAttempts);
  const baseStatusContext = createStatusContext({
    maxAttempts: statusMaxAttempts(0),
    request: input.request,
    resolved: input.resolved,
    transport: ModelTransportKindValue.Sse,
  });
  const recordModelIO = shouldRecordModelIO(input.env);
  const isDev = isDevelopmentModelIOEnv(input.env);
  let requestMessages = input.request.messages;
  let signatureRepairAttempted = false;
  let emptyCompletionRetryCount = 0;

  for (
    let attempt = 1;
    retryAttemptLoopContinues(
      retryBudget,
      attempt,
      input.retry.maxAttempts + Number(signatureRepairAttempted),
    );
    attempt += 1
  ) {
    const retryBudgetAttempt =
      attempt - Number(signatureRepairAttempted);
    const startedAt = Date.now();
    // Retries after an SSE idle timeout must not reuse the first-request window or the same silent provider
    // window keeps interrupting; core recovery and adapter retries add 30s per attempt.
    const streamIdleTimeoutMs = resolveModelStreamIdleTimeoutMs({
      baseTimeoutMs: input.streamIdleTimeoutMs,
      retryNumber: (input.request.streamIdleTimeoutRetryNumber ?? 0) + retryBudgetAttempt - 1,
    });
    let emittedEvent = false;
    let emittedRetryBoundaryEvent = false;
    let emittedError = false;
    let retryScheduledFromStreamChunk = false;
    let offPeakQueueHoldFromStreamChunk = false;
    const pendingRetrySafeEvents: ModelStreamEvent[] = [];
    const diagnostics = createStreamDiagnostics();
    const attemptAbortController = createLinkedAbortController(input.request.abortSignal);
    const attemptRequest = {
      ...input.request,
      abortSignal: attemptAbortController.signal,
      messages: requestMessages,
    };
    let statusContext = createAttemptStatusContext(
      {
        ...baseStatusContext,
        maxAttempts: statusMaxAttempts(
          Number(signatureRepairAttempted),
        ),
      },
      attempt,
    );
    const toolCallAssembler = new StreamingToolCallAssembler({ logger: input.logger });
    let streamIterator: AsyncIterator<TextStreamPart<ToolSet>> | undefined;
    let streamReachedNaturalEnd = false;
    let attemptFailed = false;
    let awaitIteratorClose = false;
    let terminalStatusPublished = false;
    // Hoisted above try so the catch branch can log the failing model-io with options/result.
    let options: ReturnType<typeof createStreamTextOptions> | undefined;
    let result: AiSdkStreamTextResult | undefined;
    let requestHeaders: Record<string, string> = {};
    let requestHeaderCount = 0;
    let resolved = input.resolved;
    let timeToFirstProviderEventMs: number | undefined;
    let timeToFirstContentMs: number | undefined;
    let timeToFirstTextMs: number | undefined;
    let streamMaxIdleMs = 0;
    let streamStallCount = 0;
    let streamOutputCommitted = false;
    const repairThinkingSignatureRejection = (error: unknown): boolean => {
      if (signatureRepairAttempted || resolved.providerKind !== "anthropic") {
        return false;
      }
      const repairedMessages = repairReasoningHistoryAfterSignatureRejection(
        requestMessages,
        error,
      );
      if (!repairedMessages) return false;

      // Signatures are valid only for the thinking block that produced them. While the stream has not committed output, replace
      // only this request's copy and grant one physical retry with a fresh requestId outside the normal budget;
      // never write cleanup results back into canonical history.
      signatureRepairAttempted = true;
      requestMessages = repairedMessages;
      input.logger?.warn("Retrying model stream after thinking signature rejection", {
        attempt,
        event: "model.reasoning_signature_repair.retry",
        maxAttempts: input.retry.maxAttempts + 1,
        nextAttempt: attempt + 1,
        requestId: statusContext.requestId,
        status: "waiting",
      });
      return true;
    };
    const publishVisibleMilestones = async (observation: {
      contentMs?: number;
      textMs?: number;
    }): Promise<void> => {
      if (timeToFirstContentMs === undefined && observation.contentMs !== undefined) {
        timeToFirstContentMs = observation.contentMs;
        await publishModelTelemetryMilestone(
          {
            ...statusContext,
            attempt,
            elapsedMs: observation.contentMs,
            timestamp: new Date(startedAt + observation.contentMs).toISOString(),
            type: "model_first_content",
          },
          { logger: input.logger, statusSink: input.statusSink },
        );
      }
      if (timeToFirstTextMs === undefined && observation.textMs !== undefined) {
        timeToFirstTextMs = observation.textMs;
        await publishModelTelemetryMilestone(
          {
            ...statusContext,
            attempt,
            elapsedMs: observation.textMs,
            timestamp: new Date(startedAt + observation.textMs).toISOString(),
            type: "model_first_text",
          },
          { logger: input.logger, statusSink: input.statusSink },
        );
      }
    };

    // Process-level admission: wait for a slot before issuing each attempt;
    // the token returns when the attempt ends (success/failure/throw/consumer abandon via finally; before the backoff sleep).
    // Cancel while waiting follows the same path as cancelled sleep: record a connect-stage cancelled failure and throw.
    let admission: AttemptAdmission;
    try {
      admission = await admitAttempt({
        admission: input.request.modelRequestAdmission,
        model: { providerId: String(resolved.providerId), modelId: String(resolved.modelId) },
        signal: input.request.abortSignal,
        ...admissionWaitPublishers(statusContext, attempt, statusPublishOptions(input)),
      });
    } catch (admitError) {
      attemptAbortController.cleanup();
      const admitFailure = classifyModelFailure(admitError, input.request.abortSignal);
      await publishModelStatus(
        {
          ...statusContext,
          attempt,
          durationMs: Date.now() - startedAt,
          message: admitFailure.message,
          reason: admitFailure.reason,
          requestHeaderCount,
          requestHeaders,
          retryable: false,
          statusCode: admitFailure.statusCode,
          streamOutputCommitted,
          ...modelFailureStatusFields(admitError, admitFailure, "connect"),
          timestamp: new Date().toISOString(),
          type: "model_request_failed",
        },
        {
          ...statusPublishOptions(input),
          failureError: unwrapRetryError(admitError),
        },
      );
      throw toAdapterError(admitError, admitFailure, statusContext, attempt, {
        errorPhase: "connect",
      });
    }

    try {
      resolved = await resolveModelForAttempt({
        attempt,
        request: attemptRequest,
        resolveModel: input.resolveModel,
      });
      const anthropicMetadataUserId = await resolveAnthropicRequestMetadataUserId({
        env: input.env,
        providerKind: resolved.providerKind,
        sessionId: statusContext.sessionId,
      });
      options = createStreamTextOptions({
        anthropicMetadataUserId,
        env: input.env,
        includeModelIO: recordModelIO,
        request: attemptRequest,
        resolved,
        statusContext,
      });
      requestHeaders = sanitizeModelNetworkHeaders(options.headers);
      requestHeaderCount = Object.keys(requestHeaders).length;
      await publishModelStatus(
        {
          ...statusContext,
          attempt,
          requestHeaderCount,
          requestHeaders,
          timestamp: new Date(startedAt).toISOString(),
          type: "model_request_started",
        },
        statusPublishOptions(input, admission),
      );
      const streamResult = input.runtime.streamText(options);
      result = streamResult;
      streamIterator = streamResult.fullStream[Symbol.asyncIterator]();

      while (true) {
        const next = await readNextWithStreamIdleTimeout(streamIterator, {
          abortController: attemptAbortController.controller,
          onTimeout: async (error) => {
            streamStallCount += 1;
            streamMaxIdleMs = Math.max(streamMaxIdleMs, error.idleMs);
            await publishModelStatus(
              {
                ...statusContext,
                attempt,
                idleMs: error.idleMs,
                message: error.message,
                requestHeaderCount,
                requestHeaders,
                timeoutMs: error.timeoutMs,
                timestamp: new Date().toISOString(),
                type: "model_stream_stalled",
              },
              statusPublishOptions(input, admission),
            );
          },
          timeoutMs: streamIdleTimeoutMs,
        });
        if (next.done) {
          streamReachedNaturalEnd = true;
          break;
        }
        if (timeToFirstProviderEventMs === undefined) {
          timeToFirstProviderEventMs = Date.now() - startedAt;
          await publishModelTelemetryMilestone(
            {
              ...statusContext,
              attempt,
              elapsedMs: timeToFirstProviderEventMs,
              timestamp: new Date(startedAt + timeToFirstProviderEventMs).toISOString(),
              type: "model_first_provider_event",
            },
            { logger: input.logger, statusSink: input.statusSink },
          );
        }

        let event: Awaited<ReturnType<typeof handleStreamChunk>>;
        try {
          event = await handleStreamChunk({
            admission,
            attempt,
            chunk: next.value,
            diagnostics,
            emittedRetryBoundaryEvent,
            input,
            pendingRetrySafeEvents,
            requestHeaderCount,
            requestHeaders,
            repairThinkingSignatureRejection,
            retryBudgetAttempt,
            startedAt,
            statusContext,
            toolCallAssembler,
          });
        } catch (error) {
          const directToolCommit = compactDirectToolCallCommitEvent(input.request, next.value);
          if (directToolCommit) {
            // A complete direct tool-call is already a provider event; name/input validation failures
            // must not make the adapter treat it as pre-first-event failure and replay SSE.
            emittedRetryBoundaryEvent = true;
            for (const pendingEvent of pendingRetrySafeEvents.splice(0)) {
              emittedEvent = true;
              yield pendingEvent;
            }
            // Providers without raw message-block provenance may deliver a complete tool-call.
            // Hand the inferred block stop to the hidden collector before propagating the validation error, avoiding an HTTP replay.
            emittedEvent = true;
            yield directToolCommit;
          }
          throw error;
        }
        const shouldHoldEmptyCompletionEvents =
          !event.emittedError &&
          event.visibleEvents.some((visibleEvent) => visibleEvent.type === "finish") &&
          input.request.preserveProviderStreamBoundaries !== true &&
          isZeroOutputModelCompletion({
            finishReason: diagnostics.finishReason,
            reasoningLength: diagnostics.reasoningDeltaChars,
            textLength: diagnostics.textDeltaChars,
            toolCallCount: diagnostics.toolCallCount,
            usage: diagnostics.usage,
          }) &&
          canRetryEmptyCompletion({
            abortSignal: input.request.abortSignal,
            attempt,
            maxAttempts: input.retry.maxAttempts,
            retryCount: emptyCompletionRetryCount,
          });
        if (shouldHoldEmptyCompletionEvents) {
          // finish flushes the cached start to core; buffer until natural EOF and confirm the generic-empty
          // case before retrying, so attempt one's finish/start never leak to the UI.
          event.visibleEvents.length = 0;
        }
        emittedError = emittedError || event.emittedError;
        emittedEvent = emittedEvent || event.emittedEvent;
        emittedRetryBoundaryEvent = emittedRetryBoundaryEvent || event.emittedRetryBoundaryEvent;

        if (event.retryScheduled) {
          // Retrying on an SSE error chunk is normal control flow, not the catch path;
          // without an explicit failure mark, finally would skip the old attempt's iterator/tee cleanup.
          // The next physical request may start only after this round's abort and bounded cleanup.
          attemptFailed = true;
          awaitIteratorClose = true;
          retryScheduledFromStreamChunk = true;
          offPeakQueueHoldFromStreamChunk = event.offPeakQueueHold;
          break;
        }
        if (event.terminalError) {
          throw event.terminalError;
        }
        if (event.visibleEvents.length > 0) {
          for (const visibleEvent of event.visibleEvents) {
            const observation = observeVisibleStreamEvent(visibleEvent, Date.now() - startedAt);
            await publishVisibleMilestones(observation);
            streamOutputCommitted = streamOutputCommitted || observation.outputCommitted;
            yield visibleEvent;
          }
        }
      }

      if (retryScheduledFromStreamChunk) {
        if (offPeakQueueHoldFromStreamChunk) {
          // Queue waits burn no retry budget: rewind the counter so the for-loop retries in place.
          attempt -= 1;
        }
        continue;
      }

      const flushedEvents = applyStreamEventsToRetryBoundary({
        emittedRetryBoundaryEvent,
        events: toolCallAssembler.flush(),
        pendingRetrySafeEvents,
        preserveProviderStreamBoundaries: input.request.preserveProviderStreamBoundaries,
      });
      emittedEvent = emittedEvent || flushedEvents.emittedEvent;
      emittedRetryBoundaryEvent =
        emittedRetryBoundaryEvent || flushedEvents.emittedRetryBoundaryEvent;
      if (flushedEvents.visibleEvents.length > 0) {
        for (const visibleEvent of flushedEvents.visibleEvents) {
          const observation = observeVisibleStreamEvent(visibleEvent, Date.now() - startedAt);
          await publishVisibleMilestones(observation);
          streamOutputCommitted = streamOutputCommitted || observation.outputCommitted;
          yield visibleEvent;
        }
      }

      for (const pendingEvent of pendingRetrySafeEvents.splice(0)) {
        emittedEvent = true;
        const observation = observeVisibleStreamEvent(pendingEvent, Date.now() - startedAt);
        await publishVisibleMilestones(observation);
        streamOutputCommitted = streamOutputCommitted || observation.outputCommitted;
        yield pendingEvent;
      }

      if (!emittedError) {
        // Business errors synthesized after natural EOF leave via TerminalStreamChunkError, outside the outer catch;
        // compact context is empty on the normal main path, so the stream stage must be recorded at the synthesis site.
        // Classify provider business errors before generic-empty, or quota-style
        // HTTP 200 empty streams would be misread as retryable transient empties.
        const hiddenProviderBusinessError = detectProviderBusinessFinishError({
          providerId: String(statusContext.providerId),
          providerKind: statusContext.providerKind,
          source:
            diagnostics.lastFinishChunk ??
            ({
              type: "finish",
              finishReason: diagnostics.finishReason,
              rawFinishReason: diagnostics.rawFinishReason,
            } satisfies Record<string, unknown>),
        });
        if (hiddenProviderBusinessError) {
          const failure = classifyModelFailure(
            hiddenProviderBusinessError,
            input.request.abortSignal,
          );
          throw new TerminalStreamChunkError(
            toAdapterError(hiddenProviderBusinessError, failure, statusContext, attempt, {
              ...compactStreamFailureContext(
                input.request.preserveProviderStreamBoundaries,
                "response_body",
              ),
              errorPhase: "stream",
            }),
          );
        }

        if (isSuspiciousStreamDiagnostics(diagnostics)) {
          // Business errors like 403 JSON sometimes surface no error chunk and the stream ends with an empty completion;
          // without an adapter-level termination core reports Model returned no text.
          const streamEndedWithoutOutputError = detectProviderBusinessFinishError({
            providerId: String(statusContext.providerId),
            providerKind: statusContext.providerKind,
            source: diagnostics.lastErrorChunk ?? diagnostics.lastFinishChunk,
          });
          if (streamEndedWithoutOutputError) {
            const failure = classifyModelFailure(
              streamEndedWithoutOutputError,
              input.request.abortSignal,
            );
            throw new TerminalStreamChunkError(
              toAdapterError(streamEndedWithoutOutputError, failure, statusContext, attempt, {
                ...compactStreamFailureContext(
                  input.request.preserveProviderStreamBoundaries,
                  "response_body",
                ),
                errorPhase: "stream",
              }),
            );
          }

          if (
            input.request.preserveProviderStreamBoundaries !== true &&
            isZeroOutputModelCompletion({
              finishReason: diagnostics.finishReason,
              reasoningLength: diagnostics.reasoningDeltaChars,
              textLength: diagnostics.textDeltaChars,
              toolCallCount: diagnostics.toolCallCount,
              usage: diagnostics.usage,
            }) &&
            canRetryEmptyCompletion({
              abortSignal: input.request.abortSignal,
              attempt,
              maxAttempts: input.retry.maxAttempts,
              retryCount: emptyCompletionRetryCount,
            })
          ) {
            const responseHeaders = await resolveStreamResponseHeaders(streamResult);
            const completedAt = Date.now();
            // finish flushes retry-safe preliminaries as visible events; an empty completion must enter one
            // adapter retry before the flush so core does not treat attempt one as final.
            logStreamDiagnostics({
              attempt,
              diagnostics,
              durationMs: completedAt - startedAt,
              emittedError,
              emittedEvent,
              logger: input.logger,
              outboundHeaders: resolved.headers,
              statusContext,
            });
            emptyCompletionRetryCount += 1;
            await scheduleEmptyCompletionRetry({
              abortSignal: input.request.abortSignal,
              attempt,
              completedAt,
              errorPhase: "stream",
              logger: input.logger,
              requestHeaders,
              requestStatusSink: input.request.statusSink,
              responseHeaders,
              retry: input.retry,
              retryBudgetAttempt,
              startedAt,
              statusContext,
              statusSink: input.statusSink,
              streamOutputCommitted: false,
            });
            continue;
          }
        }
      }

      logStreamDiagnostics({
        attempt,
        diagnostics,
        durationMs: Date.now() - startedAt,
        emittedError,
        emittedEvent,
        logger: input.logger,
        outboundHeaders: resolved.headers,
        statusContext,
      });
      if (!emittedError) {
        const completedAt = Date.now();
        const responseHeaders = await resolveStreamResponseHeaders(streamResult);
        await publishModelStatus(
          {
            ...statusContext,
            attempt,
            durationMs: completedAt - startedAt,
            requestHeaderCount,
            requestHeaders,
            responseHeaderCount: Object.keys(responseHeaders).length,
            responseHeaders,
            providerRequestId: providerRequestIdFromHeaders(responseHeaders),
            finishReason: diagnostics.finishReason,
            usage: diagnostics.usage,
            timeToFirstProviderEventMs,
            timeToFirstContentMs,
            timeToFirstTextMs,
            streamMaxIdleMs: streamMaxIdleMs || undefined,
            streamStallCount,
            streamOutputCommitted,
            timestamp: new Date(completedAt).toISOString(),
            type: "model_request_completed",
          },
          statusPublishOptions(input, admission),
        );
        terminalStatusPublished = true;
      }
      if (recordModelIO && options) {
        await recordStreamTextDebug({
          modelIoFullRetentionEnabled: input.modelIoFullRetentionEnabled,
          attempt,
          debugDir: input.debugDir,
          isDev,
          normalizedToolCalls: toolCallAssembler.snapshotNormalizedToolCalls(),
          options,
          recordModelIO,
          request: attemptRequest,
          requestId: statusContext.requestId,
          resolved,
          result: streamResult,
          startedAt,
        });
      }
      return;
    } catch (error) {
      attemptFailed = true;
      if (recordModelIO && options) {
        await recordStreamTextDebug({
          modelIoFullRetentionEnabled: input.modelIoFullRetentionEnabled,
          attempt,
          debugDir: input.debugDir,
          error,
          isDev,
          normalizedToolCalls: toolCallAssembler.snapshotNormalizedToolCalls(),
          options,
          recordModelIO,
          request: attemptRequest,
          requestId: statusContext.requestId,
          resolved,
          result,
          startedAt,
        });
      }
      if (error instanceof TerminalStreamChunkError) {
        awaitIteratorClose = true;
        throw error.adapterError;
      }
      if (
        error instanceof ModelProtocolError &&
        error.code === ModelErrorCode.ModelRequestAuthMissing
      ) {
        // stream resolved request auth inside the attempt try, re-normalizing typed pre-flight
        // auth errors into generic request failures; generate keeps the raw protocol error.
        throw error;
      }

      const completedAt = Date.now();
      const retryWithRepairedHistory =
        !emittedRetryBoundaryEvent && repairThinkingSignatureRejection(error);
      if (retryWithRepairedHistory) {
        statusContext = {
          ...statusContext,
          maxAttempts: statusMaxAttempts(1),
        };
      }
      const classified = classifyModelFailure(error, input.request.abortSignal);
      if (error instanceof RuntimeHeadersRefreshError) {
        classified.message = error.message;
        classified.retryable = false;
      }
      // off-peak special case (idle plan providers only): queued 429 retries exempt from budget; 3102 marks defeat and triggers resume.
      const offPeak = resolveOffPeakFailureDecision({
        offPeak: resolved.accountAccess?.mode === "off-peak",
        failure: classified,
        error: unwrapRetryError(error),
      });
      const failure: ClassifiedModelFailure =
        offPeak?.kind === "ticketExpired"
          ? {
              ...classified,
              retryable: false,
              message: offPeakTicketExpiredMessage(classified.message),
            }
          : offPeak?.kind === "queued"
            ? {
                ...classified,
                retryable: true,
                retryReason: ModelRetryReason.OffpeakQueued,
              }
            : classified;
      const errorPhase =
        readModelFailureErrorPhase(error) ?? (streamIterator === undefined ? "prepare" : "stream");
      awaitIteratorClose = failure.reason !== ModelFailureReasonValue.Cancelled;
      const responseHeaders = sanitizeModelNetworkHeaders(
        getResponseHeaders(unwrapRetryError(error)),
      );
      const failureDecision = resolveStreamFailureDecision({
        attempt: retryBudgetAttempt,
        emittedRetryBoundaryEvent,
        error,
        failure,
        maxAttempts: input.retry.maxAttempts,
        preserveProviderStreamBoundaries: input.request.preserveProviderStreamBoundaries,
        responseHeaders,
        retryBudget,
        streamIteratorCreated: streamIterator !== undefined,
        streamErrorChunkObserved: Boolean(
          diagnostics.lastErrorChunk || diagnostics.lastFinishChunk,
        ),
      });
      // off-peak queued-429 budget exemption: does not consume maxAttempts; the visible-output boundary still applies.
      if (offPeak?.kind === "queued" && !emittedRetryBoundaryEvent) {
        failureDecision.canRetry = true;
      }
      if (retryWithRepairedHistory) {
        failureDecision.canRetry = true;
      }

      logStreamFailureDiagnostics({
        attempt,
        canRetry: failureDecision.canRetry,
        diagnostics,
        durationMs: completedAt - startedAt,
        emittedError,
        emittedEvent,
        emittedRetryBoundaryEvent,
        error,
        failure,
        logger: input.logger,
        statusContext,
      });
      await publishModelStatus(
        {
          ...statusContext,
          attempt,
          durationMs: completedAt - startedAt,
          message: failure.message,
          reason: failure.reason,
          requestHeaderCount,
          requestHeaders,
          responseHeaderCount: Object.keys(responseHeaders).length,
          responseHeaders,
          retryable: failureDecision.canRetry,
          statusCode: failure.statusCode,
          streamOutputCommitted,
          ...modelFailureStatusFields(error, failure, errorPhase),
          timestamp: new Date(completedAt).toISOString(),
          type: "model_request_failed",
        },
        {
          ...statusPublishOptions(input, admission),
          failureError: unwrapRetryError(error),
        },
      );
      terminalStatusPublished = true;

      if (retryWithRepairedHistory) {
        await publishRetryScheduledStatus(
          input,
          statusContext,
          attempt,
          0,
          {
            ...failure,
            retryReason: ModelRetryReason.ReasoningSignatureRepair,
          },
          requestHeaders,
          responseHeaders,
          admission,
        );
        continue;
      }

      if (!failureDecision.canRetry) {
        logRetryDelayDecision({
          attempt,
          canRetry: failureDecision.canRetry,
          failure,
          logger: input.logger,
          responseHeaders,
          statusContext,
        });
        throw toAdapterError(error, failure, statusContext, attempt, {
          ...failureDecision.context,
          errorPhase,
        });
      }

      const delayMs =
        offPeak?.kind === "queued"
          ? offPeak.delayMs
          : calculateRetryDelay(input.retry, retryBudgetAttempt, failure.retryAfterMs);
      logRetryDelayDecision({
        attempt,
        canRetry: failureDecision.canRetry,
        delayMs,
        failure,
        logger: input.logger,
        responseHeaders,
        statusContext,
      });

      await publishRetryScheduledStatus(
        input,
        statusContext,
        attempt,
        delayMs,
        failure,
        requestHeaders,
        responseHeaders,
        admission,
      );
      // No token during backoff: free the slot for others, re-admit on retry.
      admission.release();
      try {
        await sleep(delayMs, input.request.abortSignal);
      } catch (sleepError) {
        const sleepFailure = classifyModelFailure(sleepError, input.request.abortSignal);
        await publishModelStatus(
          {
            ...statusContext,
            attempt,
            durationMs: Date.now() - startedAt,
            message: sleepFailure.message,
            reason: sleepFailure.reason,
            requestHeaderCount,
            requestHeaders,
            retryable: false,
            statusCode: sleepFailure.statusCode,
            streamOutputCommitted,
            ...modelFailureStatusFields(sleepError, sleepFailure, "connect"),
            timestamp: new Date().toISOString(),
            type: "model_request_failed",
          },
          {
            // Token already returned during backoff: this cancellation belongs to no attempt, do not forward it.
            ...statusPublishOptions(input),
            failureError: unwrapRetryError(sleepError),
          },
        );
        terminalStatusPublished = true;
        throw toAdapterError(sleepError, sleepFailure, statusContext, attempt, {
          errorPhase: "connect",
        });
      }
      if (offPeak?.kind === "queued") {
        // Queue waits burn no retry budget: rewind the counter so the for-loop retries in place, probing unbounded.
        attempt -= 1;
      }
    } finally {
      if (
        !streamReachedNaturalEnd &&
        (attemptFailed || input.request.preserveProviderStreamBoundaries === true)
      ) {
        // Without this cleanup branch, a failed 429 retry on the normal stream path would leave the
        // AI SDK fullStream tee holding the old provider request, stalling later physical requests before send.
        // Failed attempts must be aborted and released unconditionally; normal consumer early-end keeps its semantics.
        if (!attemptAbortController.signal.aborted) {
          attemptAbortController.controller.abort(
            new Error("Model stream attempt ended before natural EOF."),
          );
        }
        if (!attemptFailed && !terminalStatusPublished && !emittedError) {
          // Consumer-side validation failures only trigger AsyncIteratorClose, never the catch above;
          // settle the started physical request as cancelled to avoid a dangling started state before fallback.
          const completedAt = Date.now();
          await publishModelStatus(
            {
              ...statusContext,
              attempt,
              durationMs: completedAt - startedAt,
              message: "Model stream consumer closed before natural EOF.",
              reason: ModelFailureReasonValue.Cancelled,
              requestHeaderCount,
              requestHeaders,
              retryable: false,
              errorCode: "model_request_cancelled",
              errorPhase: "stream",
              exceptionType: "AbortError",
              streamOutputCommitted,
              timestamp: new Date(completedAt).toISOString(),
              type: "model_request_failed",
            },
            statusPublishOptions(input, admission),
          );
        }
        if (attemptFailed && awaitIteratorClose) {
          await closeStreamIteratorBestEffort(streamIterator, {
            attempt,
            logger: input.logger,
            result,
          });
        } else {
          void closeStreamIteratorBestEffort(streamIterator, {
            attempt,
            logger: input.logger,
          });
        }
      } else if (attemptAbortController.signal.aborted) {
        // The normal main path keeps its lifecycle: close the iterator best-effort only when caller/idle already aborted.
        void closeStreamIteratorBestEffort(streamIterator, {
          attempt,
          logger: input.logger,
        });
      }
      attemptAbortController.cleanup();
      // Fallback release (success/throw/consumer early-return); the normal failure path released before sleep, idempotent.
      admission.release();
    }
  }
}

async function closeStreamIteratorBestEffort(
  streamIterator: AsyncIterator<TextStreamPart<ToolSet>> | undefined,
  options: { attempt: number; logger?: Logger; result?: AiSdkStreamTextResult },
): Promise<void> {
  const cleanupOperations: Array<{ name: string; promise: Promise<unknown> }> = [];
  if (streamIterator?.return) {
    cleanupOperations.push({
      name: "iterator.return",
      promise: Promise.resolve().then(() => streamIterator.return?.()),
    });
  }
  if (options.result?.consumeStream) {
    cleanupOperations.push({
      name: "result.consumeStream",
      // The AI SDK fullStream getter tees and parks one branch in baseStream;
      // awaiting only iterator.return() can still leak the underlying reader/connection slot.
      promise: Promise.resolve().then(() => options.result?.consumeStream()),
    });
  }
  if (cleanupOperations.length === 0) return;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    Promise.allSettled(cleanupOperations.map((operation) => operation.promise)).then((results) => ({
      results,
      type: "settled" as const,
    })),
    new Promise<{ type: "timed_out" }>((resolve) => {
      timeout = setTimeout(() => resolve({ type: "timed_out" }), STREAM_ATTEMPT_CLEANUP_TIMEOUT_MS);
    }),
  ]);
  if (timeout !== undefined) clearTimeout(timeout);

  if (outcome.type === "timed_out") {
    options.logger?.warn("Model stream attempt cleanup timed out", {
      attempt: options.attempt,
      cleanupOperations: cleanupOperations.map((operation) => operation.name),
      event: "model.stream_attempt_cleanup.timeout",
      status: "waiting",
      timeoutMs: STREAM_ATTEMPT_CLEANUP_TIMEOUT_MS,
    });
    return;
  }

  const failures = outcome.results.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          {
            errorMessage:
              result.reason instanceof Error ? result.reason.message : String(result.reason),
            operation: cleanupOperations[index]?.name,
          },
        ]
      : [],
  );
  if (failures.length > 0) {
    // Async cleanup failure or timeout downgrades to a warning; never mask the original provider/retry error.
    options.logger?.warn("Model stream attempt cleanup failed", {
      attempt: options.attempt,
      event: "model.stream_attempt_cleanup.failed",
      failures,
      status: "failed",
    });
  }
}

async function handleStreamChunk(input: {
  /** Admission of this attempt: returned before the error-branch backoff sleep. */
  admission: AttemptAdmission;
  attempt: number;
  chunk: TextStreamPart<ToolSet>;
  diagnostics: ReturnType<typeof createStreamDiagnostics>;
  emittedRetryBoundaryEvent: boolean;
  input: {
    logger?: Logger;
    request: AiSdkModelTextRequest;
    resolved: ResolvedAiSdkModel;
    retry: ResolvedAiSdkModelRetryOptions;
    statusSink?: ModelStatusSink;
  };
  pendingRetrySafeEvents: ModelStreamEvent[];
  repairThinkingSignatureRejection: (error: unknown) => boolean;
  retryBudgetAttempt: number;
  requestHeaderCount: number;
  requestHeaders: Record<string, string>;
  startedAt: number;
  statusContext: ReturnType<typeof createStatusContext>;
  toolCallAssembler: StreamingToolCallAssembler;
}): Promise<{
  emittedError: boolean;
  emittedEvent: boolean;
  emittedRetryBoundaryEvent: boolean;
  retryScheduled: boolean;
  /** off-peak queued retry: the outer for freezes the attempt budget. */
  offPeakQueueHold: boolean;
  terminalError?: TerminalStreamChunkError;
  visibleEvents: ModelStreamEvent[];
}> {
  recordStreamChunkDiagnostic(input.diagnostics, input.chunk);
  const providerEventObserved =
    input.input.request.preserveProviderStreamBoundaries === true &&
    isRawProviderRetryBoundaryEvent(input.chunk);
  const providerBoundaryEvent = input.input.request.preserveProviderStreamBoundaries
    ? toProviderStreamBoundaryEvent(input.chunk)
    : undefined;
  const emittedRetryBoundaryEvent = input.emittedRetryBoundaryEvent || providerEventObserved;
  const providerBusinessFinishError = detectProviderBusinessFinishError({
    providerId: String(input.statusContext.providerId),
    providerKind: input.statusContext.providerKind,
    source: input.chunk,
  });
  if (providerBusinessFinishError) {
    return handleStreamErrorEvent(
      { ...input, emittedRetryBoundaryEvent },
      providerBusinessFinishError,
    );
  }
  const event = toModelStreamEvent(input.chunk);
  if (event?.type === "error") {
    return handleStreamErrorEvent({ ...input, emittedRetryBoundaryEvent }, event.error);
  }
  if (!event) {
    if (providerEventObserved) {
      // The raw provider event only ends the compact SSE retry; it is not visible
      // content. Project only response/block/stop semantic boundaries and flush the buffered synthetic start.
      return applyStreamEventsToRetryBoundary({
        emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
        events: providerBoundaryEvent ? [providerBoundaryEvent] : [],
        pendingRetrySafeEvents: input.pendingRetrySafeEvents,
        providerEventObserved: true,
        preserveProviderStreamBoundaries: true,
      });
    }
    logIgnoredStreamChunk({
      attempt: input.attempt,
      chunk: input.chunk,
      logger: input.input.logger,
      statusContext: input.statusContext,
    });
    return streamChunkResult();
  }

  return applyStreamEventsToRetryBoundary({
    emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
    events: input.toolCallAssembler.handle(event),
    pendingRetrySafeEvents: input.pendingRetrySafeEvents,
    providerEventObserved,
    preserveProviderStreamBoundaries: input.input.request.preserveProviderStreamBoundaries,
  });
}

function applyStreamEventsToRetryBoundary(input: {
  emittedRetryBoundaryEvent: boolean;
  events: ModelStreamEvent[];
  pendingRetrySafeEvents: ModelStreamEvent[];
  providerEventObserved?: boolean;
  preserveProviderStreamBoundaries?: boolean;
}): ReturnType<typeof streamChunkResult> {
  let emittedEvent = false;
  let emittedRetryBoundaryEvent = input.emittedRetryBoundaryEvent;
  const visibleEvents: ModelStreamEvent[] = [];

  if (input.providerEventObserved && !emittedRetryBoundaryEvent) {
    visibleEvents.push(...input.pendingRetrySafeEvents.splice(0));
    emittedRetryBoundaryEvent = true;
  }

  for (const event of input.events) {
    emittedEvent = true;
    // The AI SDK start is synthesized locally before reading the provider stream and must not pose as the first provider event;
    // compact stops SSE retry once any real event arrives, then core's block commit decides HTTP fallback.
    const retrySafePrelude =
      isRetrySafePreludeStreamEvent(event) &&
      (!input.preserveProviderStreamBoundaries || event.type === "start");
    if (retrySafePrelude && !emittedRetryBoundaryEvent) {
      input.pendingRetrySafeEvents.push(event);
      continue;
    }

    if (!emittedRetryBoundaryEvent) {
      visibleEvents.push(...input.pendingRetrySafeEvents.splice(0));
    }
    visibleEvents.push(event);
    emittedRetryBoundaryEvent = true;
  }

  return streamChunkResult({
    emittedEvent,
    emittedRetryBoundaryEvent,
    visibleEvents,
  });
}

function isRawProviderRetryBoundaryEvent(chunk: TextStreamPart<ToolSet>): boolean {
  if (chunk.type !== "raw") {
    return false;
  }
  const rawValue = chunk.rawValue;
  return !(
    rawValue !== null &&
    typeof rawValue === "object" &&
    (rawValue as { type?: unknown }).type === "ping"
  );
}

function toProviderStreamBoundaryEvent(
  chunk: TextStreamPart<ToolSet>,
): ModelStreamEvent | undefined {
  if (chunk.type !== "raw" || chunk.rawValue === null || typeof chunk.rawValue !== "object") {
    return undefined;
  }
  const rawEvent = chunk.rawValue as {
    content_block?: { type?: unknown };
    delta?: { stop_reason?: unknown; type?: unknown };
    index?: unknown;
    type?: unknown;
  };
  if (rawEvent.type === "message_start") {
    return {
      boundary: "provider_response_start",
      type: "compact_stream_boundary",
    };
  }
  if (rawEvent.type === "content_block_start") {
    return {
      blockType:
        typeof rawEvent.content_block?.type === "string" ? rawEvent.content_block.type : null,
      boundary: "provider_content_block_start",
      index: typeof rawEvent.index === "number" ? rawEvent.index : null,
      type: "compact_stream_boundary",
    };
  }
  if (rawEvent.type === "content_block_delta") {
    return {
      boundary: "provider_content_block_delta",
      deltaType: typeof rawEvent.delta?.type === "string" ? rawEvent.delta.type : null,
      index: typeof rawEvent.index === "number" ? rawEvent.index : null,
      type: "compact_stream_boundary",
    };
  }
  if (rawEvent.type === "content_block_stop") {
    return {
      boundary: "provider_content_block_stop",
      index: typeof rawEvent.index === "number" ? rawEvent.index : null,
      type: "compact_stream_boundary",
    };
  }
  if (rawEvent.type === "message_delta") {
    const stopReason = rawEvent.delta?.stop_reason;
    return {
      boundary: "provider_stop_reason",
      present: Boolean(stopReason),
      type: "compact_stream_boundary",
    };
  }
  return undefined;
}

function compactDirectToolCallCommitEvent(
  request: AiSdkModelTextRequest,
  chunk: TextStreamPart<ToolSet>,
): ModelStreamEvent | undefined {
  if (!request.preserveProviderStreamBoundaries || chunk.type !== "tool-call") {
    return undefined;
  }
  return {
    boundary: "inferred_content_block_stop",
    type: "compact_stream_boundary",
  };
}

async function handleStreamErrorEvent(
  input: Parameters<typeof handleStreamChunk>[0],
  error: unknown,
): Promise<Awaited<ReturnType<typeof handleStreamChunk>>> {
  const retryWithRepairedHistory =
    !input.emittedRetryBoundaryEvent && input.repairThinkingSignatureRejection(error);
  const statusContext = retryWithRepairedHistory
    ? {
        ...input.statusContext,
        maxAttempts: retryBudgetMaxAttempts(
          input.input.request.modelRetryBudget,
          input.input.retry.maxAttempts + 1,
        ),
      }
    : input.statusContext;
  const classified = classifyModelFailure(error, input.input.request.abortSignal);
  // off-peak special case: a queued 429 on the first SSE chunk (no visible output yet) is also budget-exempt.
  const offPeak = resolveOffPeakFailureDecision({
    offPeak: input.input.resolved.accountAccess?.mode === "off-peak",
    failure: classified,
    error: unwrapRetryError(error),
  });
  const failure: ClassifiedModelFailure =
    offPeak?.kind === "ticketExpired"
      ? {
          ...classified,
          retryable: false,
          message: offPeakTicketExpiredMessage(classified.message),
        }
      : offPeak?.kind === "queued"
        ? {
            ...classified,
            retryable: true,
            retryReason: ModelRetryReason.OffpeakQueued,
          }
        : classified;
  const responseHeaders = sanitizeModelNetworkHeaders(getResponseHeaders(unwrapRetryError(error)));
  const failureDecision = resolveStreamFailureDecision({
    attempt: input.retryBudgetAttempt,
    emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
    error,
    failure,
    maxAttempts: input.input.retry.maxAttempts,
    preserveProviderStreamBoundaries: input.input.request.preserveProviderStreamBoundaries,
    responseHeaders,
    retryBudget: input.input.request.modelRetryBudget,
    streamErrorChunkObserved: true,
  });
  // off-peak queued-429 budget exemption: does not consume maxAttempts; the visible-output boundary still applies.
  if (offPeak?.kind === "queued" && !input.emittedRetryBoundaryEvent) {
    failureDecision.canRetry = true;
  }
  if (retryWithRepairedHistory) {
    failureDecision.canRetry = true;
  }
  await publishModelStatus(
    {
      ...statusContext,
      attempt: input.attempt,
      durationMs: Date.now() - input.startedAt,
      message: failure.message,
      reason: failure.reason,
      requestHeaderCount: input.requestHeaderCount,
      requestHeaders: input.requestHeaders,
      responseHeaderCount: Object.keys(responseHeaders).length,
      responseHeaders,
      retryable: failureDecision.canRetry,
      statusCode: failure.statusCode,
      streamOutputCommitted: input.emittedRetryBoundaryEvent,
      ...modelFailureStatusFields(error, failure, "stream"),
      timestamp: new Date().toISOString(),
      type: "model_request_failed",
    },
    {
      ...statusPublishOptions(input.input, input.admission),
      failureError: unwrapRetryError(error),
    },
  );

  if (retryWithRepairedHistory) {
    await publishRetryScheduledStatus(
      input.input,
      statusContext,
      input.attempt,
      0,
      {
        ...failure,
        retryReason: ModelRetryReason.ReasoningSignatureRepair,
      },
      input.requestHeaders,
      responseHeaders,
      input.admission,
    );
    return streamChunkResult({
      emittedError: true,
      retryScheduled: true,
    });
  }

  if (!failureDecision.canRetry) {
    logRetryDelayDecision({
      attempt: input.attempt,
      canRetry: failureDecision.canRetry,
      failure,
      logger: input.input.logger,
      responseHeaders,
      statusContext,
    });
    return streamChunkResult({
      emittedError: true,
      terminalError: new TerminalStreamChunkError(
        toAdapterError(error, failure, statusContext, input.attempt, {
          ...failureDecision.context,
          errorPhase: "stream",
        }),
      ),
    });
  }

  const delayMs =
    offPeak?.kind === "queued"
      ? offPeak.delayMs
      : calculateRetryDelay(input.input.retry, input.retryBudgetAttempt, failure.retryAfterMs);
  logRetryDelayDecision({
    attempt: input.attempt,
    canRetry: failureDecision.canRetry,
    delayMs,
    failure,
    logger: input.input.logger,
    responseHeaders,
    statusContext,
  });

  await publishRetryScheduledStatus(
    input.input,
    statusContext,
    input.attempt,
    delayMs,
    failure,
    input.requestHeaders,
    responseHeaders,
    input.admission,
  );
  // No token during backoff: this attempt ends here, free the slot.
  input.admission.release();
  // Note: AI SDK can surface pre-output APICallError as an error chunk;
  // retry it here so protocol clients still receive the normal apiRetry status updates.
  try {
    await sleep(delayMs, input.input.request.abortSignal);
  } catch (sleepError) {
    const sleepFailure = classifyModelFailure(sleepError, input.input.request.abortSignal);
    // The SSE error chunk waits inside the helper; on cancellation the iterator still exists,
    // so keying on the iterator alone would misrecord stream. Write the connect fact at the real wait boundary.
    throw toAdapterError(sleepError, sleepFailure, statusContext, input.attempt, {
      errorPhase: "connect",
    });
  }
  return streamChunkResult({
    emittedError: true,
    retryScheduled: true,
    offPeakQueueHold: offPeak?.kind === "queued",
  });
}

function classifyStreamFailurePhase(input: {
  emittedRetryBoundaryEvent: boolean;
  httpResponseStatus?: number;
  responseHeaders: Record<string, string>;
  streamErrorChunkObserved?: boolean;
  streamIteratorCreated?: boolean;
}): StreamFailurePhase | undefined {
  if (input.streamIteratorCreated === false) {
    return "request_setup";
  }
  if (input.emittedRetryBoundaryEvent) {
    return "response_body";
  }

  const responseStatus = input.httpResponseStatus;
  if (responseStatus !== undefined) {
    if (responseStatus >= 200 && responseStatus < 300) {
      return "response_body";
    }
    if (responseStatus >= 300 && responseStatus < 600) {
      return "request_setup";
    }
  }

  if (input.streamErrorChunkObserved) {
    // An error chunk proves the stream body started; its ProviderBusinessError.statusCode
    // may be just a business class, not HTTP setup. Explicit transport status still wins in the branch above.
    return "response_body";
  }

  const contentType = readHeader(input.responseHeaders, "content-type")?.toLowerCase();
  if (contentType?.includes("text/event-stream")) {
    return "response_body";
  }
  return undefined;
}

function compactStreamFailureContext(
  preserveProviderStreamBoundaries: boolean | undefined,
  streamFailurePhase: StreamFailurePhase | undefined,
  httpResponseStatus?: number,
): Record<string, unknown> | undefined {
  if (preserveProviderStreamBoundaries !== true || !streamFailurePhase) {
    return undefined;
  }
  return {
    ...(httpResponseStatus !== undefined ? { httpResponseStatus } : {}),
    streamFailurePhase,
  };
}

function resolveStreamFailureDecision(input: {
  attempt: number;
  emittedRetryBoundaryEvent: boolean;
  error: unknown;
  failure: ClassifiedModelFailure;
  maxAttempts: number;
  preserveProviderStreamBoundaries?: boolean;
  responseHeaders: Record<string, string>;
  retryBudget?: ModelRetryBudget;
  streamErrorChunkObserved?: boolean;
  streamIteratorCreated?: boolean;
}): { canRetry: boolean; context?: Record<string, unknown> } {
  const httpResponseStatus = input.preserveProviderStreamBoundaries
    ? resolveCompactHttpResponseStatus(input.error)
    : undefined;
  const streamFailurePhase = input.preserveProviderStreamBoundaries
    ? classifyStreamFailurePhase({
        emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
        httpResponseStatus,
        responseHeaders: input.responseHeaders,
        streamErrorChunkObserved: input.streamErrorChunkObserved,
        streamIteratorCreated: input.streamIteratorCreated,
      })
    : undefined;

  return {
    canRetry: canRetryStreamFailure({
      attempt: input.attempt,
      emittedRetryBoundaryEvent: input.emittedRetryBoundaryEvent,
      error: input.error,
      failure: input.failure,
      httpResponseStatus,
      maxAttempts: input.maxAttempts,
      preserveProviderStreamBoundaries: input.preserveProviderStreamBoundaries,
      retryBudget: input.retryBudget,
      streamFailurePhase,
    }),
    context: compactStreamFailureContext(
      input.preserveProviderStreamBoundaries,
      streamFailurePhase,
      httpResponseStatus,
    ),
  };
}

function canRetryStreamFailure(input: {
  attempt: number;
  emittedRetryBoundaryEvent: boolean;
  error: unknown;
  failure: ClassifiedModelFailure;
  httpResponseStatus?: number;
  maxAttempts: number;
  preserveProviderStreamBoundaries?: boolean;
  retryBudget?: ModelRetryBudget;
  streamFailurePhase?: StreamFailurePhase;
}): boolean {
  // Workflow traffic (unbounded budget) ignores the classifier retryable and reads the policy table: only deterministic
  // model-side errors go unretried; concurrency caps like 3008/3009/3010 retry here.
  const providerCode = inspectProviderFailure(input.error).providerErrorCode;
  // Never replay after visible output (core stream recovery handles it); the budget gate is always open when unbounded.
  if (
    input.emittedRetryBoundaryEvent ||
    !retryBudgetAllows(input.retryBudget, input.attempt, input.maxAttempts)
  ) {
    return false;
  }

  if (input.failure.reason === ModelFailureReasonValue.Cancelled) {
    return false;
  }

  if (
    input.preserveProviderStreamBoundaries === true &&
    isCompactStaleStreamFailure(input.error, input.httpResponseStatus)
  ) {
    // Compact requests retry EPIPE/ConnectionClosed; those are outside the generic
    // model-failure retryable set and must be judged before the generic gate.
    return true;
  }

  if (!retryAllowedByFailurePolicy(input.failure, input.retryBudget, providerCode)) {
    return false;
  }

  // Setup failures keep the existing adapter/API retry; compact SSE protocol/business body errors
  // are not replayed, and the post-exhaustion non-stream fallback is core's per commit boundary.
  return (
    input.preserveProviderStreamBoundaries !== true || input.streamFailurePhase !== "response_body"
  );
}

function resolveCompactHttpResponseStatus(error: unknown): number | undefined {
  const unwrapped = unwrapRetryError(error);
  // ProviderBusinessError.responseStatus is the transport status kept by the fetch layer; outer
  // APICallError/statusCode may already be overridden by business codes, so prefer this hard evidence.
  return findProviderBusinessError(unwrapped)?.responseStatus ?? getHttpResponseStatus(unwrapped);
}

function isCompactStaleStreamFailure(
  error: unknown,
  httpResponseStatus: number | undefined,
): boolean {
  const unwrapped = unwrapRetryError(error);
  if (isModelStreamIdleTimeoutError(unwrapped)) {
    return true;
  }

  if (isCompactStaleCode(getErrorCode(unwrapped))) {
    return true;
  }
  if (httpResponseStatus !== undefined) {
    return false;
  }

  const providerCode = findProviderBusinessError(unwrapped)?.providerCode;
  return isCompactStaleCode(typeof providerCode === "number" ? String(providerCode) : providerCode);
}

function isCompactStaleCode(value: string | undefined): boolean {
  const normalized = value?.trim().toUpperCase();
  return normalized === "ECONNRESET" || normalized === "EPIPE" || normalized === "CONNECTIONCLOSED";
}

function readHeader(headers: Record<string, string>, name: string): string | undefined {
  const normalizedName = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === normalizedName)?.[1];
}

function streamChunkResult(
  overrides: Partial<{
    emittedError: boolean;
    emittedEvent: boolean;
    emittedRetryBoundaryEvent: boolean;
    retryScheduled: boolean;
    /** off-peak queued retry: the outer for freezes the attempt budget. */
    offPeakQueueHold: boolean;
    terminalError?: TerminalStreamChunkError;
    visibleEvents: ModelStreamEvent[];
  }> = {},
) {
  return {
    emittedError: false,
    emittedEvent: false,
    emittedRetryBoundaryEvent: false,
    retryScheduled: false,
    offPeakQueueHold: false,
    visibleEvents: [],
    ...overrides,
  };
}

function statusPublishOptions(
  input: {
    logger?: Logger;
    request: AiSdkModelTextRequest;
    statusSink?: ModelStatusSink;
  },
  admission?: AttemptAdmission,
) {
  return {
    logger: input.logger,
    requestStatusSink: input.request.statusSink,
    statusSink: input.statusSink,
  // This attempt's admission token doubles as its status-event sink.
    ...(admission?.ticket === undefined ? {} : { admissionTicket: admission.ticket }),
  };
}

async function publishRetryScheduledStatus(
  input: {
    logger?: Logger;
    request: AiSdkModelTextRequest;
    retry: ResolvedAiSdkModelRetryOptions;
    statusSink?: ModelStatusSink;
  },
  statusContext: ReturnType<typeof createStatusContext>,
  attempt: number,
  delayMs: number,
  failure: ReturnType<typeof classifyModelFailure>,
  requestHeaders: Record<string, string>,
  responseHeaders: Record<string, string>,
  admission?: AttemptAdmission,
): Promise<void> {
  await publishModelStatus(
    {
      ...statusContext,
      attempt,
      delayMs,
      message: failure.message,
      nextAttempt: attempt + 1,
      reason: failure.retryReason,
      requestHeaderCount: Object.keys(requestHeaders).length,
      requestHeaders,
      responseHeaderCount: Object.keys(responseHeaders).length,
      responseHeaders,
      statusCode: failure.statusCode,
      errorCode: failure.code,
      retryAfterMs: failure.retryAfterMs,
      timestamp: new Date().toISOString(),
      type: "model_retry_scheduled",
    },
    statusPublishOptions(input, admission),
  );
}

function observeVisibleStreamEvent(
  event: ModelStreamEvent,
  elapsed: number,
): { contentMs?: number; textMs?: number; outputCommitted: boolean } {
  switch (event.type) {
    case "text_delta":
      return {
        contentMs: elapsed,
        textMs: event.text ? elapsed : undefined,
        outputCommitted: true,
      };
    case "reasoning_delta":
    case "tool_input_delta":
    case "tool_call":
      return { contentMs: elapsed, outputCommitted: true };
    case "text_start":
    case "reasoning_start":
    case "tool_input_start":
      return { contentMs: elapsed, outputCommitted: false };
    case "compact_stream_boundary":
      return {
        contentMs: event.boundary === "provider_content_block_start" ? elapsed : undefined,
        outputCommitted:
          event.boundary === "provider_content_block_stop" ||
          event.boundary === "inferred_content_block_stop",
      };
    default:
      return { outputCommitted: false };
  }
}

async function resolveStreamResponseHeaders(
  result: AiSdkStreamTextResult,
): Promise<Record<string, string>> {
  try {
    const response = await (result as unknown as { response?: Promise<unknown> }).response;
    return sanitizeModelNetworkHeaders((response as { headers?: unknown } | undefined)?.headers);
  } catch {
    return {};
  }
}
