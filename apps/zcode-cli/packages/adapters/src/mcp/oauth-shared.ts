import type { OAuthDiscoveryState } from "@modelcontextprotocol/client";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";
import { isRecord, mcpOAuthCredentialKey } from "./oauth-credentials.js";

export const MCP_OAUTH_DISCOVERY_STATE_KEY = "discovery_state";
export const MCP_OAUTH_DISCOVERY_FETCHED_AT_KEY = "discovery_state_fetched_at";

/** discovery metadata cache lifetime; re-discover after expiry so stale endpoints never stick. */
export const MCP_OAUTH_DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;

export interface McpOAuthAuthorizationContext {
  authorizationUrl: string;
  redirectUrl: string;
  serverName: string;
}

/**
 * The discovery record timestamp lives under its own key, not wrapped inside discovery_state.
 *
 * discovery_state must remain a bare OAuthDiscoveryState: CLI and desktop upgrade independently but share one
 * credential file; a {fetched_at, state} wrapper would hand un-upgraded readers an object without
 * authorizationServerUrl, silently killing the discovery cache. A separate optional key is the
 * backward-compatible shape.
 */
export async function saveDiscoveryRecord(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  state: OAuthDiscoveryState,
  now = Date.now(),
): Promise<void> {
  await credentialStore.saveMany({
    [mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_DISCOVERY_STATE_KEY)]: JSON.stringify(state),
    [mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_DISCOVERY_FETCHED_AT_KEY)]: String(now),
  });
}

/**
 * Read an unexpired discovery record.
 *
 * Missing timestamp (legacy write) or expired both return undefined so the caller re-discovers; the next save
 * backfills the timestamp. Self-healing.
 */
export async function loadDiscoveryRecord(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  options: { expectedIssuer?: string; now?: number; ttlMs?: number } = {},
): Promise<OAuthDiscoveryState | undefined> {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? MCP_OAUTH_DISCOVERY_TTL_MS;
  const stateKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_DISCOVERY_STATE_KEY);
  const fetchedAtKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_DISCOVERY_FETCHED_AT_KEY);
  const values = await credentialStore.loadMany([stateKey, fetchedAtKey]);
  const raw = values[stateKey];
  if (!raw) return undefined;

  const fetchedAt = Number(values[fetchedAtKey]);
  if (!Number.isFinite(fetchedAt) || now - fetchedAt >= ttlMs) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed.authorizationServerUrl !== "string") return undefined;

  const state = parsed as unknown as OAuthDiscoveryState;
  if (options.expectedIssuer && !issuersMatch(state, options.expectedIssuer)) {
    // canonical issuer differs from the cache: the AS changed, invalidate the cache.
    return undefined;
  }
  return state;
}

function issuersMatch(state: OAuthDiscoveryState, expectedIssuer: string): boolean {
  const cachedIssuer = state.authorizationServerMetadata?.issuer ?? state.authorizationServerUrl;
  if (!cachedIssuer) return false;
  return normalizeIssuer(cachedIssuer) === normalizeIssuer(expectedIssuer);
}

function normalizeIssuer(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
