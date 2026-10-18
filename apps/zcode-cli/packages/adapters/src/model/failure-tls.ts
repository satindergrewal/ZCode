const MODEL_TLS_VALIDATION_ERROR_CODE = "MODEL_TLS_VALIDATION_FAILED";

class ModelTlsValidationError extends Error {
  readonly code = MODEL_TLS_VALIDATION_ERROR_CODE;

  constructor(cause: unknown) {
    super("TLS validation failed for the provider request.", { cause });
    this.name = "ModelTlsValidationError";
  }
}

export function normalizeModelTlsFailure(error: unknown): unknown {
  if (error instanceof ModelTlsValidationError || !hasTlsFailureCode(error)) {
    return error;
  }

  // The AI SDK adapter may forward only the outer error, losing Node's TLS cause.code;
  // promote to a stable code at the provider fetch boundary so classification never depends on English copy.
  return new ModelTlsValidationError(error);
}

export function isTlsFailure(code?: string): boolean {
  const normalized = code?.toUpperCase();
  return Boolean(
    normalized?.includes("CERT") ||
    normalized?.includes("TLS") ||
    normalized === "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  );
}

function hasTlsFailureCode(error: unknown, seen = new WeakSet<object>()): boolean {
  if (error === null || typeof error !== "object" || seen.has(error)) {
    return false;
  }
  seen.add(error);

  const record = error as Record<string, unknown>;
  if (isTlsFailure(typeof record.code === "string" ? record.code : undefined)) {
    return true;
  }

  return hasTlsFailureCode(record.cause, seen);
}
