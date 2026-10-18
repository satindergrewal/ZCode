// ============================================================
// Model Protocol - provider-neutral model contracts
// ============================================================

import type { QueryId, SessionId, TraceId, TurnId } from "../interfaces/shared.js";
import type {
  ProviderNativeToolSpec,
  ToolExecutionMode,
  ToolPermissionSpec,
  ToolResultBudget,
} from "../tools/contract.js";
import type { TraceContext } from "../tracing/tracer.js";
import type {
  ModelApiCallObservation,
  ModelApiErrorPhase,
  ResolvedModelApiCallObservation,
} from "../telemetry/index.js";

export * from "./image-media.js";
export * from "./model.js";
export * from "./invocation-context.js";

export type JsonSchema = Record<string, unknown>;

export type ModelProviderId = string & { readonly __brand: "ModelProviderId" };
export type ModelId = string & { readonly __brand: "ModelId" };

export const ModelRequestSessionType = {
  Main: "main",
  Other: "other",
  SideChat: "side_chat",
  Subagent: "subagent",
} as const;

/**
 * Retry budget tiers of a model request (runtime-only).
 * - `default`: maxAttempts resolved at adapter construction (10 retries by default).
 * - `unbounded`: **transient** failures retry without cap (same backoff curve, probing forever
 *   after the 60s ceiling); permanent failures still throw immediately. For workflow actors
 *   (taskType workflow_child / nested_workflow_child): a model error is never a workflow error;
 *   the only exit is user cancel.
 * - `single-attempt`: this request's maxAttempts collapses to 1; even transient failures do not
 *   retry - first failure throws. For execution-scope Selections carrying a selectionFallback
 *   declaration (e.g. the Highspeed card): on failure core falls back to the session model for
 *   the turn, and the adapter's default 10-retry backoff would only postpone the downgrade by
 *   minutes.
 */
export const ModelRetryBudget = {
  Default: "default",
  Unbounded: "unbounded",
  SingleAttempt: "single-attempt",
} as const;

export type ModelRetryBudget = (typeof ModelRetryBudget)[keyof typeof ModelRetryBudget];

/**
 * Admission ticket of one model-request attempt (runtime-only).
 *
 * It is also the status-event sink of **this attempt**: the runner feeds the attempt's
 * ModelNetworkStatus events (`model_request_started` / `model_request_completed` /
 * `model_request_failed` / `model_retry_scheduled`) straight into it, and the governor decides
 * the request's outcome (success / throttled / transient failure / terminal) from them, so the
 * runner need not restate the outcome on every failure branch. `release()` is the backstop:
 * however the attempt ends (success, throw, consumer abandoning the stream) the runner calls it
 * once in finally; no terminal event means treated as terminal. **Idempotent**.
 */
export interface ModelRequestAdmissionTicket extends ModelStatusSink {
  release(): void;
}

/**
 * Admission port for model requests (runtime-only). Before **every attempt** the runner tries the
 * synchronous fast path `tryAcquire`, and on miss queues via `acquire`; the request goes out only
 * once the ticket is held; `release` as soon as the attempt ends - no ticket during backoff
 * sleeps - so the process-level concurrency caps what the provider actually sees in flight. When
 * `signal` aborts, `acquire` rejects with `signal.reason`.
 *
 * A `tryAcquire` miss is the runner's only basis for emitting `model_request_queued` /
 * `model_request_admitted`: without a fast path the runner cannot tell "queued" from "admitted
 * immediately" and emits neither.
 *
 * The port binds to the runtime's model factory: every model handle the runtime hands out - turn
 * step, in-tool model calls, compaction, title sidecar - carries it; absent means no gate
 * (runner behavior verbatim unchanged). The main agent gets the governor's observer impl:
 * `tryAcquire` always hits, signals only.
 */
export interface ModelRequestAdmission {
  /** Synchronous fast path: ticket when the gate is open and nobody queues; else undefined and the runner falls to `acquire`, reporting queued. */
  tryAcquire?(input: { model: ModelRequestTarget }): ModelRequestAdmissionTicket | undefined;
  acquire(input: {
    model: ModelRequestTarget;
    signal?: AbortSignal;
  }): Promise<ModelRequestAdmissionTicket>;
}

/**
 * Model identity as the admission port sees it: the minimal fact of the quota key. Neither a
 * Selection (execution intent) nor Active Model (full config) - the treaty needs only
 * provider/model.
 */
export interface ModelRequestTarget {
  providerId: string;
  modelId: string;
}

export type ModelRequestSessionType =
  (typeof ModelRequestSessionType)[keyof typeof ModelRequestSessionType];

export const ModelErrorCode = {
  InvalidModelSelection: "invalid_model_selection",
  ModelConfigMissing: "model_config_missing",
  ProviderNotFound: "provider_not_found",
  ProviderNotConfigured: "provider_not_configured",
  ModelNotFound: "model_not_found",
  InvalidModelRequest: "invalid_model_request",
  InvalidModelResponse: "invalid_model_response",
  ModelRequestFailed: "model_request_failed",
  ModelRequestAuthMissing: "model_request_auth_missing",
  ModelRequestCancelled: "model_request_cancelled",
  ModelRequestTimeout: "model_request_timeout",
  ModelRateLimited: "model_rate_limited",
  ModelContextExceeded: "model_context_exceeded",
} as const;

export type ModelErrorCode = (typeof ModelErrorCode)[keyof typeof ModelErrorCode];

export const ModelTransportKind = {
  Http: "http",
  Sse: "sse",
  WebSocket: "websocket",
} as const;

export type ModelTransportKind = (typeof ModelTransportKind)[keyof typeof ModelTransportKind];

export const ModelRetryReason = {
  RateLimited: "rate_limited",
  ProviderOverloaded: "provider_overloaded",
  ServerError: "server_error",
  NetworkError: "network_error",
  Timeout: "timeout",
  StreamIdleTimeout: "stream_idle_timeout",
  StaleConnection: "stale_connection",
  AuthRefresh: "auth_refresh",
  /** After Anthropic explicitly rejects a historical thinking signature: clean the request copy and retry once immediately. */
  ReasoningSignatureRepair: "reasoning_signature_repair",
  /** Off-peak idle queueing (429/3105+Retry-After): exempt from retry budget, probe without cap (idle-plan providers only). */
  OffpeakQueued: "offpeak_queued",
} as const;

export type ModelRetryReason = (typeof ModelRetryReason)[keyof typeof ModelRetryReason];

export const ModelFailureReason = {
  ...ModelRetryReason,
  AuthFailed: "auth_failed",
  Cancelled: "cancelled",
  ContextExceeded: "context_exceeded",
  InvalidRequest: "invalid_request",
  ProviderNotConfigured: "provider_not_configured",
  ProxyError: "proxy_error",
  TlsError: "tls_error",
  Unknown: "unknown",
} as const;

export type ModelFailureReason = (typeof ModelFailureReason)[keyof typeof ModelFailureReason];

interface ModelNetworkStatusBase {
  timestamp: string;
  traceId: TraceId;
  queryId?: QueryId;
  sessionId?: SessionId;
  turnId?: TurnId;
  parentSessionId?: SessionId;
  toolCallId?: string;
  spanId?: string;
  parentSpanId?: string;
  querySource?: string;
  requestId: string;
  providerId: ModelProviderId;
  modelId: ModelId;
  baseURL?: string;
  providerKind?: string;
  transport: ModelTransportKind;
  attempt: number;
  /**
   * Total attempts allowed by this request's retry budget (first included). **`0` = unbounded**
   * (`ModelRetryBudget.Unbounded`): `Infinity` is not serializable and 0 collides with no legal
   * value. Consumers rendering "n/N" or deriving maxRetries must special-case 0.
   */
  maxAttempts: number;
  streamRecovery?: ModelStreamRecoveryStatus;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestHeaderCount?: number;
  responseHeaderCount?: number;
  modelCall?: ResolvedModelApiCallObservation;
}

export interface ModelStreamRecoveryStatus {
  attemptId: string;
  retryNumber: number;
  maxRetries: number;
  recoveredFromRequestId?: string;
  anchorId?: string;
}

export interface ModelRequestStartedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_started";
}

/**
 * The two ends of admission waiting: a `tryAcquire` miss emits `queued`, a held ticket emits
 * `admitted` (with queue time). Runtime observability - drivers report "waiting for a slot" and
 * tool executors pause tool timeouts on them; they never enter the provider request. Protocol
 * consumers enumerating status kinds ignore them explicitly.
 */
export interface ModelRequestQueuedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_queued";
}

export interface ModelRequestAdmittedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_admitted";
  queuedMs: number;
}

export interface ModelRequestCompletedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_completed";
  durationMs: number;
  finishReason?: string;
  usage?: ModelUsage;
  providerRequestId?: string;
  timeToFirstProviderEventMs?: number;
  timeToFirstContentMs?: number;
  timeToFirstTextMs?: number;
  streamMaxIdleMs?: number;
  streamStallCount?: number;
  streamOutputCommitted?: boolean;
}

export interface ModelRequestFailedStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_failed";
  durationMs?: number;
  reason: ModelFailureReason;
  retryable: boolean;
  message: string;
  statusCode?: number;
  errorCode?: ModelErrorCode;
  providerErrorCode?: string;
  providerErrorMessage?: string;
  providerRequestId?: string;
  retryAfterMs?: number;
  errorPhase?: ModelApiErrorPhase;
  exceptionType?: string;
  streamOutputCommitted?: boolean;
}

export interface ModelRetryScheduledStatusEvent extends ModelNetworkStatusBase {
  type: "model_retry_scheduled";
  delayMs: number;
  nextAttempt: number;
  reason: ModelRetryReason;
  message: string;
  statusCode?: number;
  errorCode?: ModelErrorCode;
  providerErrorCode?: string;
  providerErrorMessage?: string;
  providerRequestId?: string;
  retryAfterMs?: number;
}

export interface ModelStreamStalledStatusEvent extends ModelNetworkStatusBase {
  type: "model_stream_stalled";
  idleMs: number;
  timeoutMs: number;
  message: string;
}

/**
 * Provider milestones for the live-observation sink only. They stay out of SessionEvent/replay
 * protocols, keeping the product state surface from growing for trace events.
 */
export interface ModelTelemetryMilestoneStatusEvent extends ModelNetworkStatusBase {
  type: "model_first_provider_event" | "model_first_content" | "model_first_text";
  elapsedMs: number;
}

/** Delivered only to the in-process telemetry statusSink, never into request UI events; fields must carry no credentials or user content. */
export type ModelRequestObservation = Readonly<{
  kind: string;
  [field: string]: string | number | boolean | undefined;
}>;

export interface ModelRequestObservationStatusEvent extends ModelNetworkStatusBase {
  type: "model_request_observation";
  observation: ModelRequestObservation;
}

export type ModelNetworkStatusEvent =
  | ModelRequestQueuedStatusEvent
  | ModelRequestAdmittedStatusEvent
  | ModelRequestObservationStatusEvent
  | ModelRequestStartedStatusEvent
  | ModelRequestCompletedStatusEvent
  | ModelRequestFailedStatusEvent
  | ModelRetryScheduledStatusEvent
  | ModelStreamStalledStatusEvent
  | ModelTelemetryMilestoneStatusEvent;

export interface ModelStatusSink {
  publish(event: ModelNetworkStatusEvent): void | Promise<void>;
  /**
   * Transport-captured failures may hand the raw exception straight to the process-level
   * observation sink. Product SessionEvents/logs still consume only
   * publish(event), keeping raw exception objects and message bodies out of persisted domain state.
   */
  publishFailure?(event: ModelRequestFailedStatusEvent, error: unknown): void | Promise<void>;
}

export class ModelProtocolError extends Error {
  readonly code: ModelErrorCode;
  readonly context?: Record<string, unknown>;

  constructor(code: ModelErrorCode, message: string, context?: Record<string, unknown>) {
    super(message);
    this.name = "ModelProtocolError";
    this.code = code;
    this.context = context;
  }
}

export function createModelProviderId(providerId: string): ModelProviderId {
  const normalized = providerId.trim();
  if (normalized.length === 0) {
    throw new ModelProtocolError(
      ModelErrorCode.InvalidModelSelection,
      "Model provider id is empty",
    );
  }
  return normalized as ModelProviderId;
}

export function createModelId(modelId: string): ModelId {
  const normalized = modelId.trim();
  if (normalized.length === 0) {
    throw new ModelProtocolError(ModelErrorCode.InvalidModelSelection, "Model id is empty");
  }
  return normalized as ModelId;
}

export type ModelMessageRole = "system" | "user" | "assistant" | "tool";

export interface ModelToolCall {
  id: string;
  name: string;
  input: unknown;
  providerExecuted?: boolean;
}

export type AttachmentKind = "local_file" | "resource" | "inline";

export interface AttachmentRef {
  id: string;
  kind: AttachmentKind;
  uri?: string;
  path?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  placeholder?: string;
}

export interface ModelTextContentBlock {
  type: "text";
  text: string;
}

export interface ModelReasoningContentBlock {
  type: "reasoning";
  text: string;
  providerOptions?: Record<string, unknown>;
}

export interface ModelImageContentBlock {
  type: "image";
  mediaType: string;
  dataUrl: string;
  detail?: "auto" | "low" | "high" | "original";
  source?: AttachmentRef;
}

export interface ModelFileContentBlock {
  type: "file";
  mediaType: string;
  name?: string;
  uri?: string;
  dataUrl?: string;
  text?: string;
  source?: AttachmentRef;
}

/** Video input content block (provider-neutral, same shape as image; base64 dataUrl only). */
export interface ModelVideoContentBlock {
  type: "video";
  mediaType: string;
  dataUrl: string;
  source?: AttachmentRef;
}

export interface ModelResourceLinkContentBlock {
  type: "resource_link";
  uri: string;
  name?: string;
  title?: string;
}

export type ModelMessageContentBlock =
  | ModelTextContentBlock
  | ModelReasoningContentBlock
  | ModelImageContentBlock
  | ModelVideoContentBlock
  | ModelFileContentBlock
  | ModelResourceLinkContentBlock;

export type ModelMessageContent = string | ModelMessageContentBlock[];

export interface ModelCacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h";
  scope?: "global" | "org";
}

export interface ModelInputMessage {
  role: ModelMessageRole;
  content: ModelMessageContent;
  cacheControl?: ModelCacheControl;
  toolCalls?: ModelToolCall[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  providerId?: ModelProviderId;
  modelId?: ModelId;
}

export function modelMessageContentToText(content: ModelMessageContent): string {
  if (typeof content === "string") return content;

  return content.map(modelMessageContentBlockToText).filter(Boolean).join("\n\n");
}

export function modelMessageContentBlockToText(block: ModelMessageContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "reasoning":
      return "";
    case "image":
      return attachmentPlaceholder("Attached", block.mediaType, block.source?.placeholder);
    case "video":
      return attachmentPlaceholder("Attached", block.mediaType, block.source?.placeholder);
    case "file":
      if (block.text !== undefined && block.text.length > 0) return block.text;
      return attachmentPlaceholder(
        "Attached",
        block.mediaType,
        block.name ?? block.source?.placeholder,
      );
    case "resource_link":
      return `[Resource: ${block.title ?? block.name ?? block.uri}]`;
  }
}

function attachmentPlaceholder(prefix: string, mediaType: string, name?: string): string {
  return name && name.length > 0 ? `[${prefix} ${mediaType}: ${name}]` : `[${prefix} ${mediaType}]`;
}

export interface ModelToolExecutionContext {
  toolCallId: string;
  abortSignal?: AbortSignal;
  traceId?: string;
  metadata?: Record<string, unknown>;
}

export type ModelToolSideEffectScope =
  | "none"
  | "workspace"
  | "git"
  | "network"
  | "system"
  | "session"
  | "userInteraction";

export interface ModelToolContract {
  name: string;
  description?: string;
  capability?: string;
  executionMode?: ToolExecutionMode;
  providerNative?: ProviderNativeToolSpec;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  /** See ToolContractDeclaration.strict: strict-mode eligibility declaration, landed per provider/model by the adapter. */
  strict?: boolean;
  readOnly?: boolean;
  destructive?: boolean;
  concurrentSafe?: boolean;
  requiresUserInteraction?: boolean;
  maxOutputBytes?: number;
  timeoutMs?: number;
  needsApproval?: boolean;
  sideEffectScope?: ModelToolSideEffectScope;
  permission?: ToolPermissionSpec;
  resultBudget?: ToolResultBudget;
  execute?: (input: unknown, context: ModelToolExecutionContext) => Promise<unknown> | unknown;
}

export type ModelToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
      type: "tool";
      toolName: string;
    };

export interface ModelServerToolUsage {
  webSearchRequests?: number;
  webFetchRequests?: number;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  serverToolUse?: ModelServerToolUsage;
}

export interface ModelUsageSummary {
  source: "provider";
  modelRequestCount: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  webSearchRequests: number;
  webFetchRequests: number;
}

export function getModelUsageTotalTokens(usage?: ModelUsage): number {
  if (!usage) return 0;
  const inputTokens =
    usage.inputTokens ?? (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  return usage.totalTokens ?? inputTokens + (usage.outputTokens ?? 0);
}

export function getModelUsageContextTokens(usage?: ModelUsage): number | undefined {
  if (!usage) return undefined;

  const inputTokens = getModelUsageInputWindowTokens(usage);
  const outputTokens = nonNegativeInteger(usage.outputTokens) ?? 0;
  const contextTokens = (inputTokens ?? 0) + outputTokens;
  if (contextTokens > 0) {
    return contextTokens;
  }

  const totalTokens = positiveInteger(usage.totalTokens);
  return totalTokens;
}

export function getModelUsageInputWindowTokens(usage?: ModelUsage): number | undefined {
  if (!usage) return undefined;

  const inputTokens = positiveInteger(usage.inputTokens);
  if (inputTokens !== undefined) {
    // AI SDK v6's Anthropic inputTokens is already total input: plain input + cache read/write.
    // Adding cacheReadTokens again would inflate the context meter and the compact threshold.
    return inputTokens;
  }

  const totalTokens = positiveInteger(usage.totalTokens);
  if (totalTokens !== undefined) {
    const outputTokens = nonNegativeInteger(usage.outputTokens) ?? 0;
    return Math.max(0, totalTokens - outputTokens);
  }

  const cacheTokens =
    (nonNegativeInteger(usage.cacheReadTokens) ?? 0) +
    (nonNegativeInteger(usage.cacheWriteTokens) ?? 0);
  return cacheTokens > 0 ? cacheTokens : undefined;
}

export function hasModelUsage(usage?: ModelUsage): boolean {
  if (!usage) return false;
  return (
    usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.totalTokens !== undefined ||
    usage.cacheReadTokens !== undefined ||
    usage.cacheWriteTokens !== undefined ||
    usage.reasoningTokens !== undefined ||
    usage.serverToolUse?.webSearchRequests !== undefined ||
    usage.serverToolUse?.webFetchRequests !== undefined
  );
}

function positiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function nonNegativeInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer >= 0 ? integer : undefined;
}

export function createModelUsageSummary(
  usages: readonly ModelUsage[],
): ModelUsageSummary | undefined {
  const realUsages = usages.filter(hasModelUsage);
  if (realUsages.length === 0) return undefined;

  return realUsages.reduce<ModelUsageSummary>(
    (summary, usage) => ({
      source: "provider",
      modelRequestCount: summary.modelRequestCount + 1,
      inputTokens: summary.inputTokens + (usage.inputTokens ?? 0),
      outputTokens: summary.outputTokens + (usage.outputTokens ?? 0),
      totalTokens: summary.totalTokens + getModelUsageTotalTokens(usage),
      cacheReadTokens: summary.cacheReadTokens + (usage.cacheReadTokens ?? 0),
      cacheWriteTokens: summary.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
      reasoningTokens: summary.reasoningTokens + (usage.reasoningTokens ?? 0),
      webFetchRequests: summary.webFetchRequests + (usage.serverToolUse?.webFetchRequests ?? 0),
      webSearchRequests: summary.webSearchRequests + (usage.serverToolUse?.webSearchRequests ?? 0),
    }),
    {
      source: "provider",
      modelRequestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      webFetchRequests: 0,
      webSearchRequests: 0,
    },
  );
}

export interface ModelRequestSettings {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stopSequences?: string[];
  seed?: number;
}

export interface ModelTextRequest extends ModelRequestSettings {
  messages: ModelInputMessage[];
  tools?: ModelToolContract[];
  toolChoice?: ModelToolChoice;
  responseJsonSchema?: JsonSchema;
  providerOptions?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  /**
   * Runtime-only hook for propagating model transport status to UI/session layers.
   * This is intentionally omitted from the JSON schema below because it is not serializable.
   */
  statusSink?: ModelStatusSink;
  /**
   * Runtime-only trace context. Serialized requests should pass trace ids through metadata.
   */
  traceContext?: TraceContext;
  /** Runtime-only, strongly-typed model API call classification; never enters the provider request. */
  modelCall?: ModelApiCallObservation;
  /**
   * Runtime-only coarse classification of the hosting session. The adapter writes it into a
   * controlled attribution header; callers may not override it via provider static headers.
   */
  modelRequestSessionType?: ModelRequestSessionType;
  /**
   * Runtime-only retry budget tier (see {@link ModelRetryBudget}). Same family as
   * modelRequestSessionType: not in the JSON schema, not in the provider request. Default `default`.
   */
  modelRetryBudget?: ModelRetryBudget;
  /**
   * Runtime-only admission port (see {@link ModelRequestAdmission}): when present the runner
   * acquires per attempt and releases at the end. Same family as statusSink: not in the JSON
   * schema, not in the provider request.
   */
  modelRequestAdmission?: ModelRequestAdmission;
  /**
   * Runtime-only SSE idle-timeout increment ordinal. 0/undefined = first request; each retry adds
   * 30000ms on top of the adapter base timeout.
   */
  streamIdleTimeoutRetryNumber?: number;
  /** Runtime-only recovery attribution; status/telemetry only, never sent to the provider. */
  streamRecovery?: ModelStreamRecoveryStatus;
  /**
   * Runtime-only provider stream boundary switch. The compact-hiding stream uses it to keep the
   * first real provider event and content-block provenance; tool-input commit is not gated by it -
   * all requests wait for the AI SDK end.
   */
  preserveProviderStreamBoundaries?: boolean;
}

export interface ModelSource {
  type: "source";
  sourceType: "url" | "document";
  id?: string;
  url?: string;
  title?: string;
  mediaType?: string;
  filename?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface ModelToolResult {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  providerExecuted?: boolean;
  providerMetadata?: Record<string, unknown>;
}

export interface ModelTextResult {
  text: string;
  finishReason: string;
  usage: ModelUsage;
  reasoning?: ModelReasoningContentBlock[];
  toolCalls?: ModelToolCall[];
  toolResults?: ModelToolResult[];
  sources?: ModelSource[];
  providerMetadata?: Record<string, unknown>;
}

export type ModelStreamEvent =
  | {
      type: "start";
    }
  | {
      /**
       * Compact-only replay boundary. The adapter distills the real boundary from the raw
       * provider stream; a direct tool-call validation failure without raw provenance may add an
       * inferred commit. The event carries no provider bodies and never enters session/UI streaming.
       */
      type: "compact_stream_boundary";
      boundary: "provider_response_start" | "inferred_content_block_stop";
    }
  | {
      type: "compact_stream_boundary";
      boundary: "provider_content_block_start";
      blockType: string | null;
      index: number | null;
    }
  | {
      /** Raw delta carries provenance type only, never body text. */
      type: "compact_stream_boundary";
      boundary: "provider_content_block_delta";
      deltaType: string | null;
      index: number | null;
    }
  | {
      type: "compact_stream_boundary";
      boundary: "provider_content_block_stop";
      index: number | null;
    }
  | {
      /** Each provider message_delta overwrites the current stop reason; a later null clears the previous value. */
      type: "compact_stream_boundary";
      boundary: "provider_stop_reason";
      present: boolean;
    }
  | {
      type: "text_start";
      id: string;
    }
  | {
      type: "text_delta";
      id?: string;
      text: string;
    }
  | {
      type: "text_end";
      id: string;
    }
  | {
      type: "reasoning_start";
      id: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "reasoning_delta";
      id?: string;
      text: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "reasoning_end";
      id: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "tool_input_start";
      id: string;
      toolName: string;
      providerExecuted?: boolean;
    }
  | {
      type: "tool_input_delta";
      id: string;
      delta: string;
    }
  | {
      type: "tool_input_end";
      id: string;
    }
  | {
      type: "tool_call";
      toolCall: ModelToolCall;
    }
  | {
      type: "finish";
      finishReason: string;
      providerMetadata?: Record<string, unknown>;
      usage: ModelUsage;
    }
  | {
      type: "error";
      error: unknown;
    };

export const modelSelectionJsonSchema = {
  type: "object",
  required: ["providerId", "modelId"],
  additionalProperties: false,
  properties: {
    providerId: { type: "string", minLength: 1 },
    modelId: { type: "string", minLength: 1 },
    options: {
      type: "object",
      additionalProperties: false,
      properties: {
        reasoningLevel: { type: "string", minLength: 1 },
        maxOutputTokens: { type: "number", minimum: 1 },
      },
    },
  },
} satisfies JsonSchema;

const attachmentRefJsonSchema = {
  type: "object",
  required: ["id", "kind"],
  additionalProperties: false,
  properties: {
    id: { type: "string", minLength: 1 },
    kind: { enum: ["local_file", "resource", "inline"] },
    uri: { type: "string" },
    path: { type: "string" },
    mimeType: { type: "string" },
    sizeBytes: { type: "number" },
    sha256: { type: "string" },
    placeholder: { type: "string" },
  },
} satisfies JsonSchema;

const modelMessageContentBlockJsonSchema = {
  oneOf: [
    {
      type: "object",
      required: ["type", "text"],
      additionalProperties: false,
      properties: {
        type: { enum: ["text"] },
        text: { type: "string" },
      },
    },
    {
      type: "object",
      required: ["type", "text"],
      additionalProperties: false,
      properties: {
        type: { enum: ["reasoning"] },
        text: { type: "string" },
        providerOptions: { type: "object" },
      },
    },
    {
      type: "object",
      required: ["type", "mediaType", "dataUrl"],
      additionalProperties: false,
      properties: {
        type: { enum: ["image"] },
        mediaType: { type: "string", minLength: 1 },
        dataUrl: { type: "string", minLength: 1 },
        detail: { enum: ["auto", "low", "high", "original"] },
        source: attachmentRefJsonSchema,
      },
    },
    {
      type: "object",
      required: ["type", "mediaType", "dataUrl"],
      additionalProperties: false,
      properties: {
        type: { enum: ["video"] },
        mediaType: { type: "string", minLength: 1 },
        dataUrl: { type: "string", minLength: 1 },
        source: attachmentRefJsonSchema,
      },
    },
    {
      type: "object",
      required: ["type", "mediaType"],
      additionalProperties: false,
      properties: {
        type: { enum: ["file"] },
        mediaType: { type: "string", minLength: 1 },
        name: { type: "string" },
        uri: { type: "string" },
        dataUrl: { type: "string" },
        text: { type: "string" },
        source: attachmentRefJsonSchema,
      },
    },
    {
      type: "object",
      required: ["type", "uri"],
      additionalProperties: false,
      properties: {
        type: { enum: ["resource_link"] },
        uri: { type: "string", minLength: 1 },
        name: { type: "string" },
        title: { type: "string" },
      },
    },
  ],
} satisfies JsonSchema;

const modelMessageContentJsonSchema = {
  oneOf: [
    { type: "string" },
    {
      type: "array",
      items: modelMessageContentBlockJsonSchema,
    },
  ],
} satisfies JsonSchema;

export const modelInputMessageJsonSchema = {
  type: "object",
  required: ["role", "content"],
  additionalProperties: false,
  properties: {
    role: { enum: ["system", "user", "assistant", "tool"] },
    content: modelMessageContentJsonSchema,
    cacheControl: {
      type: "object",
      required: ["type"],
      additionalProperties: false,
      properties: {
        type: { enum: ["ephemeral"] },
        ttl: { enum: ["5m", "1h"] },
        scope: { enum: ["global", "org"] },
      },
    },
    toolCalls: { type: "array" },
    toolCallId: { type: "string" },
    toolName: { type: "string" },
    isError: { type: "boolean" },
    providerId: { type: "string", minLength: 1 },
    modelId: { type: "string", minLength: 1 },
  },
} satisfies JsonSchema;

const modelToolChoiceJsonSchema = {
  oneOf: [
    { enum: ["auto", "none", "required"] },
    {
      type: "object",
      required: ["type", "toolName"],
      additionalProperties: false,
      properties: {
        type: { enum: ["tool"] },
        toolName: { type: "string", minLength: 1 },
      },
    },
  ],
} satisfies JsonSchema;

export const modelTextRequestJsonSchema = {
  type: "object",
  required: ["messages"],
  additionalProperties: false,
  properties: {
    messages: { type: "array", items: modelInputMessageJsonSchema },
    tools: { type: "array" },
    toolChoice: modelToolChoiceJsonSchema,
    temperature: { type: "number" },
    maxOutputTokens: { type: "number" },
    topP: { type: "number" },
    topK: { type: "number" },
    presencePenalty: { type: "number" },
    frequencyPenalty: { type: "number" },
    stopSequences: { type: "array", items: { type: "string" } },
    seed: { type: "number" },
    responseJsonSchema: { type: "object" },
    providerOptions: { type: "object" },
    metadata: { type: "object" },
  },
} satisfies JsonSchema;

export const modelNetworkStatusEventJsonSchema = {
  type: "object",
  required: [
    "type",
    "timestamp",
    "traceId",
    "requestId",
    "model",
    "transport",
    "attempt",
    "maxAttempts",
  ],
  additionalProperties: true,
  properties: {
    type: {
      enum: [
        "model_request_started",
        "model_request_completed",
        "model_request_failed",
        "model_retry_scheduled",
        "model_stream_stalled",
      ],
    },
    timestamp: { type: "string", minLength: 1 },
    traceId: { type: "string", minLength: 1 },
    sessionId: { type: "string", minLength: 1 },
    turnId: { type: "string", minLength: 1 },
    querySource: { type: "string", minLength: 1 },
    requestId: { type: "string", minLength: 1 },
    model: modelSelectionJsonSchema,
    transport: { enum: Object.values(ModelTransportKind) },
    attempt: { type: "number", minimum: 1 },
    // 0 = unbounded retry budget, hence the lower bound 0 not 1.
    maxAttempts: { type: "number", minimum: 0 },
    delayMs: { type: "number", minimum: 0 },
    durationMs: { type: "number", minimum: 0 },
    idleMs: { type: "number", minimum: 0 },
    nextAttempt: { type: "number", minimum: 1 },
    reason: { enum: Object.values(ModelFailureReason) },
    retryable: { type: "boolean" },
    message: { type: "string" },
    statusCode: { type: "number" },
    requestHeaders: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    responseHeaders: {
      type: "object",
      additionalProperties: { type: "string" },
    },
    requestHeaderCount: { type: "number", minimum: 0 },
    responseHeaderCount: { type: "number", minimum: 0 },
    streamRecovery: {
      type: "object",
      required: ["attemptId", "retryNumber", "maxRetries"],
      additionalProperties: false,
      properties: {
        attemptId: { type: "string", minLength: 1 },
        retryNumber: { type: "number", minimum: 1 },
        maxRetries: { type: "number", minimum: 0 },
        recoveredFromRequestId: { type: "string", minLength: 1 },
        anchorId: { type: "string", minLength: 1 },
      },
    },
    timeoutMs: { type: "number", minimum: 0 },
  },
} satisfies JsonSchema;

// Re-export for backwards compatibility with code using ToolCall
export type { ModelToolCall as ToolCall };

export * from "./content-protection.js";
