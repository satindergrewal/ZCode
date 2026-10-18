import { InsufficientScopeError, SdkErrorCode, UnauthorizedError } from "@modelcontextprotocol/client";

/**
 * Stable identity for interactive-grant-required.
 *
 * Registered via `Symbol.for` in the global registry: with bundler dual-installs or version skew two adapter
 * copies may coexist in one process, and both resolve to the same symbol, which instanceof cannot do. The SDK
 * uses the same trick at the transport auth seam (`Symbol.for("mcp.authSeamEscape")`), and `markAuthSeamEscape()`
 * is identity-preserving, so our brand survives the SDK bubble up to the orchestrator.
 */
const INTERACTIVE_REQUIRED_BRAND = Symbol.for("zcode.mcp.oauth.interactiveAuthorizationRequired");
const TEMPORARY_REFRESH_FAILURE_BRAND = Symbol.for("zcode.mcp.oauth.temporaryRefreshFailure");

export const MCP_OAUTH_INTERACTIVE_REQUIRED_ERROR_CODE = "MCP_OAUTH_INTERACTIVE_REQUIRED";
export const MCP_OAUTH_TEMPORARY_REFRESH_FAILURE_ERROR_CODE =
  "MCP_OAUTH_TEMPORARY_REFRESH_FAILURE";

export type McpOAuthInteractiveRequiredReason =
  | "no_credentials"
  | "no_refresh_token"
  | "invalid_grant"
  | "invalid_client"
  | "insufficient_scope"
  | "unauthorized"
  | "legacy_provider_seam";

export interface McpOAuthInteractiveRequiredError extends Error {
  code: typeof MCP_OAUTH_INTERACTIVE_REQUIRED_ERROR_CODE;
  reason: McpOAuthInteractiveRequiredReason;
  requiredScope?: string;
  resourceMetadataUrl?: string;
}

export interface McpOAuthTemporaryRefreshFailureError extends Error {
  code: typeof MCP_OAUTH_TEMPORARY_REFRESH_FAILURE_ERROR_CODE;
}

export function createInteractiveAuthorizationRequiredError(input: {
  cause?: unknown;
  reason: McpOAuthInteractiveRequiredReason;
  requiredScope?: string;
  resourceMetadataUrl?: string;
  serverName: string;
}): McpOAuthInteractiveRequiredError {
  const error = new Error(
    `MCP server ${input.serverName} requires interactive OAuth authorization (${input.reason})`,
    input.cause === undefined ? undefined : { cause: input.cause },
  ) as McpOAuthInteractiveRequiredError;
  Object.defineProperty(error, INTERACTIVE_REQUIRED_BRAND, {
    configurable: true,
    value: true,
  });
  error.code = MCP_OAUTH_INTERACTIVE_REQUIRED_ERROR_CODE;
  error.reason = input.reason;
  if (input.requiredScope) error.requiredScope = input.requiredScope;
  if (input.resourceMetadataUrl) error.resourceMetadataUrl = input.resourceMetadataUrl;
  return error;
}

/**
 * Network/5xx failures of reactive refresh.
 *
 * Must stay distinct from `interactiveRequired`: a transient AS outage does not invalidate the grant, and
 * misrouting it to interactive grant needlessly interrupts the user, while returning a token already rejected by
 * the resource server just produces a second 401.
export function createTemporaryRefreshFailureError(input: {
  cause?: unknown;
  serverName: string;
}): McpOAuthTemporaryRefreshFailureError {
  const error = new Error(
    `MCP server ${input.serverName} OAuth token refresh failed temporarily`,
    input.cause === undefined ? undefined : { cause: input.cause },
  ) as McpOAuthTemporaryRefreshFailureError;
  Object.defineProperty(error, TEMPORARY_REFRESH_FAILURE_BRAND, {
    configurable: true,
    value: true,
  });
  error.code = MCP_OAUTH_TEMPORARY_REFRESH_FAILURE_ERROR_CODE;
  return error;
}

export function isInteractiveAuthorizationRequiredError(
  error: unknown,
): error is McpOAuthInteractiveRequiredError {
  return hasBrand(error, INTERACTIVE_REQUIRED_BRAND);
}

export function isTemporaryRefreshFailureError(
  error: unknown,
): error is McpOAuthTemporaryRefreshFailureError {
  return hasBrand(error, TEMPORARY_REFRESH_FAILURE_BRAND);
}

export interface InteractiveAuthorizationTrigger {
  reason: McpOAuthInteractiveRequiredReason;
  requiredScope?: string;
  resourceMetadataUrl?: string;
}

/**
 * Classify connection/runtime errors as interactive-grant-required.
 *
 * Under a pure AuthProvider the SDK can only surface these deterministic auth errors:
 * - our own `interactiveRequired` (missing token, invalid_grant, invalid_client);
 * - `SdkHttpError(ClientHttpAuthentication)` after retry;
 * - `UnauthorizedError` when no `onUnauthorized` is set (defensive path);
 * - `InsufficientScopeError` from Streamable HTTP 403 (with requiredScope).
 *
 * `temporaryRefreshFailure` is deliberately excluded: it must keep credentials and fail as-is.
 */
export function classifyInteractiveAuthorizationTrigger(
  error: unknown,
): InteractiveAuthorizationTrigger | undefined {
  if (isTemporaryRefreshFailureError(error)) return undefined;
  if (isInteractiveAuthorizationRequiredError(error)) {
    return {
      reason: error.reason,
      ...(error.requiredScope ? { requiredScope: error.requiredScope } : {}),
      ...(error.resourceMetadataUrl ? { resourceMetadataUrl: error.resourceMetadataUrl } : {}),
    };
  }
  if (error instanceof InsufficientScopeError) {
    return {
      reason: "insufficient_scope",
      ...(error.requiredScope ? { requiredScope: error.requiredScope } : {}),
      ...(error.resourceMetadataUrl
        ? { resourceMetadataUrl: String(error.resourceMetadataUrl) }
        : {}),
    };
  }
  if (error instanceof UnauthorizedError) return { reason: "unauthorized" };
  if (isSdkAuthenticationHttpError(error)) return { reason: "unauthorized" };
  // cause chain: the SDK wraps errors at several seams; classification cannot look only at the outermost.
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  if (cause !== undefined && cause !== error) {
    return classifyInteractiveAuthorizationTrigger(cause);
  }
  return undefined;
}

/** 401 after retry: `SdkHttpError(SdkErrorCode.ClientHttpAuthentication)`. Compare codes, no instanceof. */
function isSdkAuthenticationHttpError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return code === SdkErrorCode.ClientHttpAuthentication;
}

function hasBrand(error: unknown, brand: symbol): boolean {
  return (
    (typeof error === "object" && error !== null) ||
    typeof error === "function"
      ? (error as Record<symbol, unknown>)[brand] === true
      : false
  );
}
