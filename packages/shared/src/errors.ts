function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeErrorCode(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  return undefined;
}

function getErrorCandidate(error: unknown): unknown {
  if (!isRecord(error) || !("error" in error) || !isRecord(error.error)) {
    return error;
  }

  if ("message" in error.error || "code" in error.error) {
    return error.error;
  }

  return error;
}

export interface NormalizedUnknownError {
  message: string;
  code?: string;
}

export const ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE = "ZCODE_FILE_LOCK_TIMEOUT" as const;

export function stringifyUnknownValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }

  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Some protocol error objects carry cyclic references.
    // Swallow JSON serialization failures here; never mint a second error while presenting the first.
  }

  return String(value);
}

export function normalizeUnknownError(error: unknown): NormalizedUnknownError {
  const candidate = getErrorCandidate(error);
  if (candidate instanceof Error) {
    const errorWithCode = candidate as Error & { code?: unknown };
    return {
      // Some runtimes leave Error.message empty.
      // Fall back message -> name -> String so the frontend always has displayable text.
      message: candidate.message || candidate.name || String(candidate),
      code: normalizeErrorCode(errorWithCode.code),
    };
  }

  if (isRecord(candidate)) {
    const code = "code" in candidate ? normalizeErrorCode(candidate.code) : undefined;
    const message =
      "message" in candidate
        ? stringifyUnknownValue(candidate.message)
        : stringifyUnknownValue(candidate);

    return {
      message:
        message !== "undefined" && message.length > 0 ? message : stringifyUnknownValue(candidate),
      code,
    };
  }

  return {
    message: stringifyUnknownValue(candidate),
  };
}

export function isZCodeFileLockTimeoutError(error: unknown): boolean {
  return normalizeUnknownError(error).code === ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE;
}

/**
 * Non-auto-retryable workspace ZCode Agent warmup error patterns.
 *
 * These are deterministic configuration/install/auth failures; retrying does not improve them.
 * Also the MCP-fallback downgrade test: on match, no MCP downgrade -- the error is not MCP's.
 */
export const NON_RETRYABLE_WORKSPACE_PREPARE_ERROR_PATTERNS = [
  "binary 未找到",
  "未正确安装",
  "binary not found",
  "not installed",
  "initialize 前进程已退出",
  "initialize 超时",
  "进程启动失败",
  "optional dependency was not installed",
  "Cannot find package '@openai/codex-",
  "Missing optional dependency @openai/codex-",
  "Missing Codex runtime files",
  "Gemini API key is missing or not configured",
  "Please fix the configuration file(s)",
  "Expected property name or '}' in JSON",
  "已暂停自动重试",
] as const;

/**
 * Extra error patterns excluded from MCP fallback.
 *
 * A session/new timeout is the agent's own startup/login stall; MCP is unrelated and downgrading is useless.
 */
export const NON_MCP_FALLBACK_EXTRA_ERROR_PATTERNS = ["session/new 超时"] as const;

const OPENCODE_RUNTIME_CRASH_ERROR_PATTERNS = [
  "opencode runtime 崩溃",
  "opencode runtime crashed",
  "bun has crashed",
  "segmentation fault",
  "panic(main thread)",
  "code=3221226505",
] as const;

/**
 * Whether the error message is a deterministic failure that must not auto-retry the workspace ZCode Agent warmup.
 */
export function isNonRetryableWorkspacePrepareError(errorMessage: string): boolean {
  const normalizedMessage = errorMessage.toLowerCase();
  return NON_RETRYABLE_WORKSPACE_PREPARE_ERROR_PATTERNS.some((pattern) =>
    normalizedMessage.includes(pattern.toLowerCase()),
  );
}

/**
 * Whether the error matches OpenCode's Bun/runtime-crash class.
 *
 * Unlike missing config, a quick process rebuild may recover -- but repeated hits stop the auto-retry, sparing the
 * user a generic connection closed and a meaningless 5/5 wait.
 */
export function isOpenCodeRuntimeCrashError(errorMessage: string): boolean {
  const normalizedMessage = errorMessage.toLowerCase();
  return OPENCODE_RUNTIME_CRASH_ERROR_PATTERNS.some((pattern) =>
    normalizedMessage.includes(pattern.toLowerCase()),
  );
}
