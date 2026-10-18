import type { FetchLike, AuthProvider } from "@modelcontextprotocol/client";
import type { Logger, McpOAuthConfig } from "@zcode/contracts";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import { isCanonicalTokenNearExpiry, loadCredentialPair } from "./oauth-credentials.js";
import { createInteractiveAuthorizationRequiredError } from "./oauth-errors.js";
import { refreshMcpOAuthTokensUnderLock } from "./oauth-refresh.js";

type McpAuthorizationCodeOAuthConfig = Extract<McpOAuthConfig, { type: "authorization_code" }>;

export interface CreateMcpOAuthTokenProviderInput {
  config: McpAuthorizationCodeOAuthConfig;
  credentialStore: SharedZCodeCredentialStore;
  fetchFn?: FetchLike;
  keyPrefix: string;
  logger?: Logger;
  serverName: string;
  serverUrl: string;
}

/**
 * Phase 1 runtime AuthProvider.
 *
 * Implements only token() and onUnauthorized(), deliberately NOT an OAuthClientProvider: transport
 * isOAuthClientProvider() then stays false and _oauthProvider stays empty
 * (client@2.0.0 index.mjs:4977-4980), so:
 *
 * - connect does no discovery, no DCR, no callback listener;
 * - 401 only calls our onUnauthorized() with one auto-retry; the SDK auth() path never runs and
 *   every refresh funnels into our cross-process single-flight lock.
 *
 * Never hand an OAuthClientProvider to the runtime transport: adaptOAuthProvider wraps it, 401 goes through
 * SDK handleOAuthUnauthorized -> auth(), bypassing the refresh lock; the concurrency bug returns immediately.
 */
export function createMcpOAuthTokenProvider(input: CreateMcpOAuthTokenProviderInput): AuthProvider {
  const refreshInput = {
    credentialStore: input.credentialStore,
    ...(input.fetchFn ? { fetchFn: input.fetchFn } : {}),
    keyPrefix: input.keyPrefix,
    ...(input.logger ? { logger: input.logger } : {}),
    serverName: input.serverName,
    serverUrl: input.serverUrl,
    ...(input.config.clientId ? { staticClientId: input.config.clientId } : {}),
  };

  return {
    async token(): Promise<string | undefined> {
      const pair = await loadCredentialPair(input.credentialStore, input.keyPrefix);
      // No token: return undefined, send anyway, get 401, classify once in onUnauthorized.
      if (!pair?.tokens) return undefined;
      if (!isCanonicalTokenNearExpiry(pair)) return pair.tokens.access_token;
      // Proactive near-expiry refresh. Without a refresh token ride the current value to 401; never fake a refresh.
      if (!pair.tokens.refresh_token) return pair.tokens.access_token;
      return await refreshMcpOAuthTokensUnderLock({ ...refreshInput, reactive: false });
    },

    async onUnauthorized(): Promise<void> {
      const pair = await loadCredentialPair(input.credentialStore, input.keyPrefix);
      if (!pair?.tokens?.refresh_token) {
        throw createInteractiveAuthorizationRequiredError({
          reason: pair?.tokens ? "no_refresh_token" : "no_credentials",
          serverName: input.serverName,
        });
      }
      // The contract is make the next token() usable; the SDK ignores the return value. Results are published to
      // canonical and the next token() re-reads.
      await refreshMcpOAuthTokensUnderLock({ ...refreshInput, reactive: true });
    },
  };
}
