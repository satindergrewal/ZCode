import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/client";
import type { SharedZCodeCredentialStore } from "../auth/shared-credentials.js";

export const MCP_OAUTH_CANONICAL_CREDENTIALS_KEY = "authorization_credentials";
export const MCP_OAUTH_LEGACY_CLIENT_KEY = "client_information";
export const MCP_OAUTH_LEGACY_TOKENS_KEY = "tokens";
export const MCP_OAUTH_CREDENTIALS_VERSION = 2;
export const MCP_OAUTH_SUPPORTED_CREDENTIAL_VERSIONS = new Set([1, MCP_OAUTH_CREDENTIALS_VERSION]);

/**
 * canonical credential pair。
 *
 * `generation`, `obtained_at`, `expires_at` and `issuer` are optional additive fields, no version bump:
 * appending optional fields is backward compatible (old readers ignore unknown keys), while a bump makes
 * un-upgraded CLI/desktop treat new records as unknown versions, fall back to the legacy mirror and lose pair guarantees.
 */
export interface McpOAuthCanonicalCredentials {
  client_information: OAuthClientInformationMixed;
  /** Absolute expiry derived from `expires_in` and `obtained_at` (epoch ms). */
  expires_at?: number;
  /**
   * Random id, unique per publication.
   *
   * Never reuse `published_by`: it is an OAuth-state-derived transaction id, unchanged across refreshes of the same
   * transaction, unfit for generation observation or invalidation CAS. The random id also breaks ABA.
   */
  generation?: string;
  /** Authorization server issuer. Retained only; not part of the credential key. */
  issuer?: string;
  /** Token acquisition time (epoch ms). `OAuthTokens` has only `expires_in`; without this the real expiry is unknowable cross-process. */
  obtained_at?: number;
  published_by: string;
  tokens: OAuthTokens;
  version: 1 | typeof MCP_OAUTH_CREDENTIALS_VERSION;
}

export interface CanonicalCredentialSnapshot {
  clientInformation: OAuthClientInformationMixed;
  expiresAt?: number;
  generation: string;
  issuer?: string;
  obtainedAt?: number;
  /** Raw JSON, for compare-and-delete. */
  raw: string;
  tokens: OAuthTokens;
}

export function mcpOAuthCredentialKey(keyPrefix: string, name: string): string {
  return `${keyPrefix}:${name}`;
}

export function createCredentialGeneration(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Migration baseline: legacy records lack `generation`; substitute a stable hash of the canonical raw content.
 * Content change implies generation change, enough for the follower's generation check.
 */
export function resolveCredentialGeneration(
  canonical: McpOAuthCanonicalCredentials,
  raw: string,
): string {
  if (typeof canonical.generation === "string" && canonical.generation.length > 0) {
    return canonical.generation;
  }
  return `legacy-${createHash("sha256").update(raw).digest("hex").slice(0, 32)}`;
}

export function isCanonicalCredentials(value: unknown): value is McpOAuthCanonicalCredentials {
  if (
    !isRecord(value) ||
    typeof value.version !== "number" ||
    !MCP_OAUTH_SUPPORTED_CREDENTIAL_VERSIONS.has(value.version)
  ) {
    return false;
  }
  if (typeof value.published_by !== "string" || value.published_by.length === 0) return false;
  if (!isRecord(value.client_information) || !isRecord(value.tokens)) return false;
  return (
    typeof value.client_information.client_id === "string" &&
    typeof value.tokens.access_token === "string" &&
    typeof value.tokens.token_type === "string"
  );
}

/**
 * Read only the canonical pair, no legacy derivation.
 *
 * Phase 2 baseline generation and Phase 1 refresh need canonical only; legacy-mirror interleave
 * compat stays in the provider.
 */
export async function loadCanonicalCredentials(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
): Promise<CanonicalCredentialSnapshot | undefined> {
  const key = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_CANONICAL_CREDENTIALS_KEY);
  const raw = await credentialStore.load(key);
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isCanonicalCredentials(parsed)) return undefined;
  return {
    clientInformation: parsed.client_information,
    ...(parsed.expires_at === undefined ? {} : { expiresAt: parsed.expires_at }),
    generation: resolveCredentialGeneration(parsed, raw),
    ...(parsed.issuer === undefined ? {} : { issuer: parsed.issuer }),
    ...(parsed.obtained_at === undefined ? {} : { obtainedAt: parsed.obtained_at }),
    raw,
    tokens: parsed.tokens,
  };
}

export interface PublishCanonicalCredentialsInput {
  clientInformation: OAuthClientInformationMixed;
  issuer?: string;
  obtainedAt?: number;
  publishedBy: string;
  tokens: OAuthTokens;
}

export interface PublishedCanonicalCredentials {
  canonical: McpOAuthCanonicalCredentials;
  generation: string;
  legacyClientRaw: string;
  legacyTokensRaw: string;
  raw: string;
}

/**
 * Publish canonical pair and legacy mirror atomically.
 *
 * Client and refresh tokens must come from one grant, so all three keys are written inside a single cross-process
 * read-modify-write critical section of the shared credential store; separate writes could pair a client and token
 * from different transactions. The legacy mirror is maintained during the compat window for un-upgraded CLI/Desktop.
 */
export async function publishCanonicalCredentials(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  input: PublishCanonicalCredentialsInput,
): Promise<PublishedCanonicalCredentials> {
  const obtainedAt = input.obtainedAt ?? Date.now();
  const expiresAt =
    typeof input.tokens.expires_in === "number" && Number.isFinite(input.tokens.expires_in)
      ? obtainedAt + input.tokens.expires_in * 1000
      : undefined;
  const generation = createCredentialGeneration();
  const canonical: McpOAuthCanonicalCredentials = {
    client_information: input.clientInformation,
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
    generation,
    ...(input.issuer === undefined ? {} : { issuer: input.issuer }),
    obtained_at: obtainedAt,
    published_by: input.publishedBy,
    tokens: input.tokens,
    version: MCP_OAUTH_CREDENTIALS_VERSION,
  };
  const raw = JSON.stringify(canonical);
  const legacyClientRaw = JSON.stringify(input.clientInformation);
  const legacyTokensRaw = JSON.stringify(input.tokens);
  await credentialStore.saveMany({
    [mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_CANONICAL_CREDENTIALS_KEY)]: raw,
    [mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_LEGACY_CLIENT_KEY)]: legacyClientRaw,
    [mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_LEGACY_TOKENS_KEY)]: legacyTokensRaw,
  });
  return { canonical, generation, legacyClientRaw, legacyTokensRaw, raw };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Safety margin for access-token expiry checks. */
export const MCP_OAUTH_EXPIRY_SKEW_MS = 30_000;

/**
 * Whether the token needs refreshing before it goes into request headers.
 *
 * Without `expires_at` (legacy record, or server sent no `expires_in`) always treat as near-expiry:
 * `OAuthTokens` carries no acquisition time, so take the lock and try one refresh rather than send a possibly stale token.
 */
export function isCanonicalTokenNearExpiry(
  snapshot: Pick<CanonicalCredentialSnapshot, "expiresAt">,
  now = Date.now(),
  skewMs = MCP_OAUTH_EXPIRY_SKEW_MS,
): boolean {
  if (snapshot.expiresAt === undefined) return true;
  return now >= snapshot.expiresAt - skewMs;
}

export type CanonicalInvalidationScope = "tokens" | "all";

/**
 * Conditional invalidation against the canonical snapshot.
 *
 * Deletes only while canonical still equals `expectedRaw`; if another transaction already published a new pair,
 * this invalidation aborts entirely and never kills the winner. `tokens` keeps the legacy client as re-grant seed; `all` is for
 * `invalid_client`, where client and token must be dropped as a pair.
 */
export async function invalidateCanonicalCredentials(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
  expectedRaw: string,
  scope: CanonicalInvalidationScope,
): Promise<boolean> {
  const canonicalKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_CANONICAL_CREDENTIALS_KEY);
  const keysToDelete = [
    canonicalKey,
    mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_LEGACY_TOKENS_KEY),
  ];
  if (scope === "all") {
    keysToDelete.push(mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_LEGACY_CLIENT_KEY));
  }
  return await credentialStore.deleteManyIfValue(canonicalKey, expectedRaw, keysToDelete);
}

export interface CredentialPairSnapshot {
  clientInformation?: OAuthClientInformationMixed;
  expiresAt?: number;
  /** canonical generation when available; content-derived for legacy-only, still usable to observe generations. */
  generation?: string;
  issuer?: string;
  obtainedAt?: number;
  /** canonical raw JSON; undefined for legacy-only (no canonical CAS possible). */
  raw?: string;
  source: "canonical" | "legacy";
  tokens?: OAuthTokens;
}

/**
 * Read canonical and legacy mirror and derive one usable pair per compat rules.
 */
export async function loadCredentialPair(
  credentialStore: SharedZCodeCredentialStore,
  keyPrefix: string,
): Promise<CredentialPairSnapshot | undefined> {
  const canonicalKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_CANONICAL_CREDENTIALS_KEY);
  const legacyClientKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_LEGACY_CLIENT_KEY);
  const legacyTokensKey = mcpOAuthCredentialKey(keyPrefix, MCP_OAUTH_LEGACY_TOKENS_KEY);
  const values = await credentialStore.loadMany([canonicalKey, legacyClientKey, legacyTokensKey]);
  return deriveCredentialPair({
    canonicalRaw: values[canonicalKey] ?? undefined,
    legacyClientRaw: values[legacyClientKey] ?? undefined,
    legacyTokensRaw: values[legacyTokensKey] ?? undefined,
  });
}

/**
 * Pair derivation under the compat window (pure function, no I/O).
 *
 * Pure so callers already holding raw snapshots (needing them for compare-and-delete) reuse the same
 * rules instead of re-reading the credential file; duplicating these interleave branches always diverges.
 *
 * Background: during the window CLI and desktop may be different versions; old processes write only the legacy key,
 * new ones write canonical+mirror. The question: can a legacy change be proven to belong to the same grant
 * without a generation?
 */
export function deriveCredentialPair(input: {
  canonicalRaw?: string;
  legacyClientRaw?: string;
  legacyTokensRaw?: string;
}): CredentialPairSnapshot | undefined {
  const canonicalParsed = parseJson<unknown>(input.canonicalRaw);
  const canonical =
    canonicalParsed !== undefined && isCanonicalCredentials(canonicalParsed)
      ? canonicalParsed
      : undefined;
  const legacyClient = parseJson<OAuthClientInformationMixed>(input.legacyClientRaw);
  const legacyTokens = parseJson<OAuthTokens>(input.legacyTokensRaw);

  if (canonical && input.canonicalRaw) {
    const canonicalSnapshot: CredentialPairSnapshot = {
      clientInformation: canonical.client_information,
      ...(canonical.expires_at === undefined ? {} : { expiresAt: canonical.expires_at }),
      generation: resolveCredentialGeneration(canonical, input.canonicalRaw),
      ...(canonical.issuer === undefined ? {} : { issuer: canonical.issuer }),
      ...(canonical.obtained_at === undefined ? {} : { obtainedAt: canonical.obtained_at }),
      raw: input.canonicalRaw,
      source: "canonical",
      tokens: canonical.tokens,
    };
    if (canonical.version === 1) {
      const canAdoptLegacyTokens =
        legacyTokens !== undefined &&
        (!legacyClient || isDeepStrictEqual(legacyClient, canonical.client_information));
      if (canAdoptLegacyTokens) {
        return {
          clientInformation: legacyClient ?? canonical.client_information,
          source: "legacy",
          tokens: legacyTokens,
        };
      }
      // v1 publish deletes the legacy mirror, so no mirror is a steady state; applying v2 mirror-invalidation
      // rules would drop a still-valid canonical token and force every upgraded user to re-grant.
      return canonicalSnapshot;
    }
    if (!legacyTokens) {
      // After a legacy provider invalidates tokens the invalid state must persist; never resurrect from canonical.
      return { clientInformation: legacyClient, source: "legacy" };
    }
    if (isDeepStrictEqual(legacyTokens, canonical.tokens)) {
      return legacyClient ? canonicalSnapshot : { source: "legacy", tokens: legacyTokens };
    }
    if (legacyClient && isDeepStrictEqual(legacyClient, canonical.client_information)) {
      // Unchanged client proves the legacy token is an older refresh of the same identity.
      return { clientInformation: legacyClient, source: "legacy", tokens: legacyTokens };
    }
    // Client and token both changed with no generation: same-transaction cannot be proven. Keep the client for
    // re-grant and never guess-splice credentials.
    return { clientInformation: legacyClient, source: "legacy" };
  }

  if (!legacyClient && !legacyTokens) return undefined;
  return {
    clientInformation: legacyClient,
    source: "legacy",
    ...(legacyTokens ? { tokens: legacyTokens } : {}),
  };
}

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}
