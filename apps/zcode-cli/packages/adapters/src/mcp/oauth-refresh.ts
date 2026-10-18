import { dirname, join } from "node:path";
import {
  discoverOAuthServerInfo,
  OAuthError,
  OAuthErrorCode,
  refreshAuthorization,
  selectResourceURL,
  type AuthorizationServerMetadata,
  type FetchLike,
  type OAuthDiscoveryState,
} from "@modelcontextprotocol/client";
import type { Logger } from "@zcode/contracts";
import { isZCodeFileLockTimeoutError } from "@zcode/shared";
import { withFileLock } from "@zcode/shared/node";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import {
  invalidateCanonicalCredentials,
  loadCredentialPair,
  publishCanonicalCredentials,
  type CredentialPairSnapshot,
} from "./oauth-credentials.js";
import {
  createInteractiveAuthorizationRequiredError,
  createTemporaryRefreshFailureError,
} from "./oauth-errors.js";
import { sanitizeKeyPrefix } from "./oauth-lease.js";
import { loadDiscoveryRecord, saveDiscoveryRecord } from "./oauth-shared.js";

/**
 * Refresh-lock acquisition budget.
 *
 * Must cover the in-lock network budget (one discovery + one token request) or waiters time out before the
 * winner publishes. withFileLock's default is 8s (privateFilePersistence.ts:9), not enough.
 */
const REFRESH_LOCK_MAX_WAIT_MS = 45_000;

interface RefreshMcpOAuthTokensInput {
  credentialStore: SharedZCodeCredentialStore;
  fetchFn?: FetchLike;
  keyPrefix: string;
  logger?: Logger;
  /**
   * reactive = triggered by the 401 `onUnauthorized` path.
   *
   * Decides failure semantics: proactive (early refresh) may fail soft with the current value, since that token
   * was not yet rejected; reactive may not: it was just rejected, so returning it forces a second 401 and
   * ClientHttpAuthentication, and misreads transient AS outages as interactive-grant-required.
   */
  reactive: boolean;
  serverName: string;
  serverUrl: string;
  /** Statically configured clientId. When present, invalid_client cannot self-heal via interactive grant. */
  staticClientId?: string;
}

interface ResolvedAsMetadata {
  authorizationServerUrl: string;
  metadata?: AuthorizationServerMetadata;
  resource?: URL;
}

/**
 * Refresh the access token under a cross-process single-flight lock; returns a usable access token.
 *
 * The concurrency problem: several CLI processes share one credential file, and withFileLock covers only
 * credential IO, not the network token exchange. On expiry they all refresh with the same refresh token, tripping
 * the AS rotation reuse-detection, revoking the whole token family down to a re-grant.
 */
export async function refreshMcpOAuthTokensUnderLock(
  input: RefreshMcpOAuthTokensInput,
): Promise<string> {
  const observedGeneration = (await loadCredentialPair(input.credentialStore, input.keyPrefix))
    ?.generation;
  const lockPath = resolveRefreshLockPath(input.credentialStore.filePath, input.keyPrefix);

  try {
    return await withFileLock(
      lockPath,
      async () => await refreshLocked(input, observedGeneration),
      {
        lockMaxWaitMs: REFRESH_LOCK_MAX_WAIT_MS,
      },
    );
  } catch (error) {
    if (!isZCodeFileLockTimeoutError(error)) throw error;
    // Lock-wait timeout is not refresh failure: the winner may have published. Re-read first; a fresh generation with a token wins.
    const current = await loadCredentialPair(input.credentialStore, input.keyPrefix);
    if (current?.tokens && current.generation !== observedGeneration) {
      return current.tokens.access_token;
    }
    throw createTemporaryRefreshFailureError({ cause: error, serverName: input.serverName });
  }
}

async function refreshLocked(
  input: RefreshMcpOAuthTokensInput,
  observedGeneration: string | undefined,
): Promise<string> {
  const current = await loadCredentialPair(input.credentialStore, input.keyPrefix);

  // Merge: if someone refreshed while we waited, reuse it, zero extra requests. Key to rotation reuse-detection.
  if (current?.tokens && current.generation !== observedGeneration) {
    return current.tokens.access_token;
  }
  if (!current?.tokens) {
    // Generation changed but the winner left no token (e.g. it got invalid_grant): not absence of credentials;
    // fall through to interactive grant.
    throw createInteractiveAuthorizationRequiredError({
      reason: "no_credentials",
      serverName: input.serverName,
    });
  }
  const refreshToken = current.tokens.refresh_token;
  const clientInformation = current.clientInformation;
  if (!refreshToken || !clientInformation) {
    throw createInteractiveAuthorizationRequiredError({
      reason: "no_refresh_token",
      serverName: input.serverName,
    });
  }

  let resolved: ResolvedAsMetadata;
  try {
    resolved = await resolveAsMetadata(input, current);
  } catch (error) {
    // Discovery failure is never grant invalidation.
    return failSoft(input, current, error);
  }

  try {
    const next = await refreshAuthorization(resolved.authorizationServerUrl, {
      clientInformation,
      refreshToken,
      ...(resolved.metadata ? { metadata: resolved.metadata } : {}),
      ...(resolved.resource ? { resource: resolved.resource } : {}),
      ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    });
    const published = await publishCanonicalCredentials(input.credentialStore, input.keyPrefix, {
      clientInformation,
      ...(current.issuer ? { issuer: current.issuer } : {}),
      publishedBy: `refresh:${input.keyPrefix}`,
      tokens: next,
    });
    input.logger?.info("MCP OAuth access token refreshed", {
      event: "mcp.oauth.refresh.completed",
      credentialKeyPrefix: input.keyPrefix,
      mcpServerName: input.serverName,
      processId: process.pid,
      publishedGeneration: published.generation.slice(0, 12),
      reactive: input.reactive,
      refreshTokenRotated: next.refresh_token !== refreshToken,
      status: "completed",
    });
    return next.access_token;
  } catch (error) {
    return await handleRefreshFailure(input, current, error);
  }
}

async function handleRefreshFailure(
  input: RefreshMcpOAuthTokensInput,
  current: CredentialPairSnapshot,
  error: unknown,
): Promise<never | string> {
  const oauthErrorCode = error instanceof OAuthError ? error.code : undefined;
  input.logger?.warn("MCP OAuth access token refresh failed", {
    event: "mcp.oauth.refresh.failed",
    credentialKeyPrefix: input.keyPrefix,
    credentialSource: current.source,
    mcpServerName: input.serverName,
    oauthErrorCode,
    processId: process.pid,
    reactive: input.reactive,
    status: "failed",
  });

  if (oauthErrorCode === OAuthErrorCode.InvalidGrant) {
    // Deterministic invalidation: refresh token revoked or expired. CAS-clear tokens, keep client as re-grant seed.
    if (current.raw) {
      await invalidateCanonicalCredentials(
        input.credentialStore,
        input.keyPrefix,
        current.raw,
        "tokens",
      );
    }
    throw createInteractiveAuthorizationRequiredError({
      cause: error,
      reason: "invalid_grant",
      serverName: input.serverName,
    });
  }

  if (
    oauthErrorCode === OAuthErrorCode.InvalidClient ||
    oauthErrorCode === OAuthErrorCode.UnauthorizedClient
  ) {
    if (input.staticClientId) {
      // invalid_client with a statically configured client cannot self-heal: Phase 2 would reuse the same client
      // and loop. Report as misconfiguration.
      throw new Error(
        `MCP server ${input.serverName} OAuth client was rejected by the authorization server (invalid_client). ` +
          `The configured clientId is not usable; fix the MCP oauth configuration.`,
        { cause: error },
      );
    }
    if (current.raw) {
      await invalidateCanonicalCredentials(
        input.credentialStore,
        input.keyPrefix,
        current.raw,
        "all",
      );
    }
    throw createInteractiveAuthorizationRequiredError({
      cause: error,
      reason: "invalid_client",
      serverName: input.serverName,
    });
  }

  return failSoft(input, current, error);
}

/**
 * Non-deterministic failures (network, 5xx, server_error).
 *
 * proactive returns the current value: not yet rejected, let the request proceed; the 401 path keeps final judgment.
 * reactive must throw a temporary error: the current value was just rejected, returning it re-401s for sure.
 */
function failSoft(
  input: RefreshMcpOAuthTokensInput,
  current: CredentialPairSnapshot,
  error: unknown,
): string {
  if (input.reactive || !current.tokens) {
    throw createTemporaryRefreshFailureError({ cause: error, serverName: input.serverName });
  }
  return current.tokens.access_token;
}

/**
 * Resolve AS metadata and the validated resource.
 *
 * The discovery record is TTL'd and shared with Phase 2; `resource` must be resolved and sent on refresh (RFC 8707).
 * The SDK's own refresh sends it; bypassing `auth()` means we must add it ourselves or audience binding is lost.
 */
async function resolveAsMetadata(
  input: Pick<
    RefreshMcpOAuthTokensInput,
    "credentialStore" | "fetchFn" | "keyPrefix" | "serverUrl"
  >,
  current: Pick<CredentialPairSnapshot, "issuer">,
): Promise<ResolvedAsMetadata> {
  const cached = await loadDiscoveryRecord(input.credentialStore, input.keyPrefix, {
    ...(current.issuer ? { expectedIssuer: current.issuer } : {}),
  });
  const discovered: OAuthDiscoveryState =
    cached ??
    (await discoverOAuthServerInfo(input.serverUrl, {
      ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    }));
  if (!cached) {
    await saveDiscoveryRecord(input.credentialStore, input.keyPrefix, discovered);
  }

  const resource = await selectResourceURL(
    input.serverUrl,
    // selectResourceURL reads only provider.validateResourceURL; with no provider a stub suffices.
    {} as never,
    discovered.resourceMetadata,
  );
  return {
    authorizationServerUrl: discovered.authorizationServerUrl,
    ...(discovered.authorizationServerMetadata
      ? { metadata: discovered.authorizationServerMetadata }
      : {}),
    ...(resource ? { resource } : {}),
  };
}

/**
 * Refresh lock file path.
 *
 * Must differ from the credentials file: inside the lock we call publishCanonicalCredentials, which locks
 * credentials.json itself; the same path would self-deadlock. Basename: hash and hyphen only (Windows forbids colons).
 * forbids colons).
 */
function resolveRefreshLockPath(credentialsFilePath: string, keyPrefix: string): string {
  return join(dirname(credentialsFilePath), `${sanitizeKeyPrefix(keyPrefix)}.refresh`);
}
