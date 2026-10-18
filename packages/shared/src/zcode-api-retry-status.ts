import type { ZCodeApiRetryStatus } from "./zcode-task-types-core.js";

export function normalizeZCodeApiRetryStatus(
  value: unknown,
): ZCodeApiRetryStatus | null | undefined {
  if (value === null) {
    return null;
  }
  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return undefined;
  }
  const attempt =
    positiveIntegerValue(record.attempt) ??
    Math.max((positiveIntegerValue(record.nextAttempt) ?? 2) - 1, 1);
  const maxRetries = Math.max(
    nonNegativeIntegerValue(record.maxRetries) ??
      (positiveIntegerValue(record.maxAttempts) ?? attempt + 1) - 1,
    attempt,
  );
  return {
    kind: "api_retry",
    attempt,
    maxRetries,
    retryDelayMs:
      nonNegativeIntegerValue(record.retryDelayMs) ?? nonNegativeIntegerValue(record.delayMs) ?? 0,
    errorStatus:
      nonNegativeIntegerValue(record.errorStatus) ??
      nonNegativeIntegerValue(record.statusCode) ??
      null,
    error:
      stringValue(record.error) ??
      stringValue(record.message) ??
      stringValue(record.reason) ??
      "Model retry scheduled",
  };
}

export function zcodeApiRetryFromModelNetworkStatusPayload(
  payload: Record<string, unknown>,
): ZCodeApiRetryStatus | null | undefined {
  const type = stringValue(payload.type);
  if (type === "model_retry_scheduled") {
    return normalizeZCodeApiRetryStatus(payload);
  }
  if (type === "model_request_started") {
    const streamRecoveryRetry = zcodeApiRetryFromStreamRecoveryPayload(payload.streamRecovery);
    if (streamRecoveryRetry !== undefined) {
      return streamRecoveryRetry;
    }
    if ((positiveIntegerValue(payload.attempt) ?? 1) <= 1) {
      return null;
    }
    // A plain adapter retry's request_started only means the next request began,
    // not recovery; stay undefined and let the projection clear retry state on the first real model progress.
  }
  if (type === "model_request_completed") {
    return null;
  }
  if (type === "model_request_failed" && payload.retryable !== true) {
    return null;
  }
  return undefined;
}

export function isZCodeModelRetryRecoveryProgressPayload(
  payload: Record<string, unknown>,
): boolean {
  const kind = stringValue(payload.kind);
  if (kind === "text_delta" || kind === "reasoning_delta") {
    return Boolean(stringValue(payload.delta));
  }
  const toolCallId = stringValue(payload.toolCallId);
  if (!toolCallId) {
    return false;
  }
  if (kind === "tool_input_start" || kind === "tool_input_end" || kind === "tool_call") {
    return true;
  }
  if (kind === "tool_input_delta") {
    return Boolean(stringValue(payload.delta));
  }
  return false;
}

export function zcodeApiRetryFromStreamRecoveryPayload(
  value: unknown,
): ZCodeApiRetryStatus | undefined {
  const record = asRecord(value);
  const attempt = positiveIntegerValue(record.retryNumber);
  if (attempt === undefined) {
    return undefined;
  }
  // In core stream recovery every new request is adapter attempt=1, which legacy UIs read as cleared;
  // display streamRecovery.retryNumber instead (1/10, 2/10...).
  return {
    kind: "api_retry",
    attempt,
    maxRetries: Math.max(nonNegativeIntegerValue(record.maxRetries) ?? attempt, attempt),
    retryDelayMs: 0,
    errorStatus: null,
    error: stringValue(record.message) ?? "Model stream recovery retry started",
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonNegativeIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function positiveIntegerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}
