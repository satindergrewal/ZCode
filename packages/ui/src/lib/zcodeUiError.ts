import type { ZCodeError, TraceId } from "@zcode/shared";
import { errorAttributionSchema, type ErrorAttribution } from "@zcode/shared/zcode-protocol-v4";

export interface ZCodeUiError extends ZCodeError {
  attribution?: ErrorAttribution;
  detail?: string;
  underlyingErrorMessage?: string;
  underlyingErrorDetail?: string;
}

interface NormalizeZCodeUiErrorOptions {
  fallbackCode?: string;
  fallbackMessage?: string;
  traceId?: TraceId;
  taskId?: string;
}

const GENERIC_ZCODE_UI_ERROR_MESSAGES = new Set([
  "Internal error",
  "Turn execution failed",
  "Compact failed",
  "Rewind failed",
  "ZCode session failed",
]);

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function tryParseJsonString(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function readValueByPath(record: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = record;
  for (const segment of path) {
    if (!isObjectRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function collectMessageCandidatesFromRecord(record: Record<string, unknown>): string[] {
  const result: string[] = [];
  const push = (value: unknown) => {
    const normalized = normalizeString(value);
    if (!normalized || result.includes(normalized)) {
      return;
    }
    result.push(normalized);
  };

  const messagePaths: Array<readonly string[]> = [
    ["message"],
    ["detail"],
    ["data", "message"],
    ["data", "detail"],
    // ZCode Agent often puts the readable reason in data.details (plural); reading detail only
    // left the UI with Internal error, dropping the actionable hint.
    ["data", "details"],
    ["data", "reason"],
    ["data", "error", "message"],
    ["data", "error", "detail"],
    ["data", "error", "details"],
    // zcode-cli puts model/network error summaries under data.zcode.error.
    // The UI read data.error only, so the structured provider root cause stayed covered by Internal error.
    ["data", "zcode", "error", "message"],
    ["data", "zcode", "error", "detail"],
    ["data", "zcode", "error", "details"],
  ];
  for (const path of messagePaths) {
    push(readValueByPath(record, path));
  }

  return result;
}

function collectMessageCandidates(error: unknown): string[] {
  const result: string[] = [];
  const push = (value: unknown) => {
    const normalized = normalizeString(value);
    if (!normalized || result.includes(normalized)) {
      return;
    }
    result.push(normalized);
  };

  if (error instanceof Error) {
    push(error.message);
  }

  if (typeof error === "string") {
    const parsed = tryParseJsonString(error);
    if (isObjectRecord(parsed)) {
      for (const candidate of collectMessageCandidatesFromRecord(parsed)) {
        push(candidate);
      }
      if (result.length > 0) {
        return result;
      }
    }
    // task_error is usually a JSON string; surface its message/detail first,
    // falling back to the whole raw string only when nothing structured parses.
    push(error);
    return result;
  }

  if (isObjectRecord(error)) {
    for (const candidate of collectMessageCandidatesFromRecord(error)) {
      push(candidate);
      const parsed = tryParseJsonString(candidate);
      if (isObjectRecord(parsed)) {
        for (const nestedCandidate of collectMessageCandidatesFromRecord(parsed)) {
          push(nestedCandidate);
        }
      }
    }
    return result;
  }

  push(String(error));
  return result;
}

function readFirstStringFromPaths(
  error: unknown,
  paths: Array<readonly string[]>,
): string | undefined {
  const record = isObjectRecord(error)
    ? error
    : typeof error === "string"
      ? tryParseJsonString(error)
      : null;
  if (!isObjectRecord(record)) {
    return undefined;
  }

  for (const path of paths) {
    const value = normalizeString(readValueByPath(record, path));
    if (value) {
      return value;
    }
  }
  return undefined;
}

function readFirstAttributionFromPaths(error: unknown): ErrorAttribution | undefined {
  const record = isObjectRecord(error)
    ? error
    : typeof error === "string"
      ? tryParseJsonString(error)
      : null;
  if (!isObjectRecord(record)) {
    return undefined;
  }

  const paths: Array<readonly string[]> = [
    ["attribution"],
    ["data", "attribution"],
    ["data", "error", "attribution"],
    ["data", "zcode", "error", "attribution"],
  ];
  for (const path of paths) {
    const parsed = errorAttributionSchema.safeParse(readValueByPath(record, path));
    if (parsed.success) {
      return parsed.data;
    }
  }
  return undefined;
}

export function normalizeZCodeUiError(
  error: unknown,
  options: NormalizeZCodeUiErrorOptions = {},
): ZCodeUiError {
  const candidates = collectMessageCandidates(error);
  // zcode-cli already puts provider/network root causes in detail or data.zcode.error;
  // outer layers may still wrap generic Internal error copy. Prefer the least-generic candidate so the root cause shows.
  const primaryMessage =
    candidates.find((candidate) => !GENERIC_ZCODE_UI_ERROR_MESSAGES.has(candidate)) ??
    candidates[0] ??
    options.fallbackMessage ??
    "Internal error";
  const detailMessage = candidates.find(
    (candidate) => candidate !== primaryMessage && !GENERIC_ZCODE_UI_ERROR_MESSAGES.has(candidate),
  );
  const codeFromError = readFirstStringFromPaths(error, [
    ["code"],
    ["providerCode"],
    ["data", "code"],
    ["data", "error", "code"],
    ["data", "zcode", "error", "code"],
    // turn-errors put the provider business code in summary.code; some paths still fill only context.providerCode.
    ["data", "zcode", "error", "context", "providerCode"],
    ["data", "error", "context", "providerCode"],
    ["context", "providerCode"],
  ]);
  const detailFromError = readFirstStringFromPaths(error, [
    ["detail"],
    ["data", "detail"],
    ["data", "error", "detail"],
    ["data", "zcode", "error", "detail"],
  ]);
  const underlyingErrorMessage = readFirstStringFromPaths(error, [
    ["underlyingErrorMessage"],
    ["data", "underlyingErrorMessage"],
    ["data", "error", "underlyingErrorMessage"],
    ["data", "zcode", "error", "underlyingErrorMessage"],
  ]);
  const underlyingErrorDetail = readFirstStringFromPaths(error, [
    ["underlyingErrorDetail"],
    ["data", "underlyingErrorDetail"],
    ["data", "error", "underlyingErrorDetail"],
    ["data", "zcode", "error", "underlyingErrorDetail"],
  ]);
  const providerCodeFromDetail = detailFromError?.match(/provider_code=([0-9]+)/)?.[1];
  const traceIdFromError = readFirstStringFromPaths(error, [
    ["traceId"],
    ["data", "traceId"],
    ["data", "error", "traceId"],
    ["data", "zcode", "error", "traceId"],
  ]) as TraceId | undefined;
  const taskIdFromError = readFirstStringFromPaths(error, [
    ["taskId"],
    ["data", "taskId"],
    ["data", "error", "taskId"],
    ["data", "zcode", "error", "taskId"],
  ]);
  const attribution = readFirstAttributionFromPaths(error);

  return {
    // Some upstream errors wrap code as a bare PROVIDER_BUSINESS_ERROR;
    // the real GLM / zcode-plan business code hides in detail provider_code=xxxx.
    // Business codes must reach the unified error classifier, or the ChatView quota banner never matches.
    code: providerCodeFromDetail ?? codeFromError ?? options.fallbackCode ?? "UNKNOWN",
    message: primaryMessage,
    detail: detailMessage,
    ...(underlyingErrorMessage ? { underlyingErrorMessage } : {}),
    ...(underlyingErrorDetail ? { underlyingErrorDetail } : {}),
    traceId: options.traceId ?? traceIdFromError,
    taskId: options.taskId ?? taskIdFromError,
    ...(attribution ? { attribution } : {}),
  };
}
