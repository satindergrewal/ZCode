import { createHash, randomBytes } from "node:crypto";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthTokens,
} from "@modelcontextprotocol/client";
import type { Logger, McpOAuthConfig } from "@zcode/contracts";
import {
  createLocalhostOAuthCallbackServer,
  type LocalhostOAuthCallbackServer,
} from "../auth/localhost-callback.js";
import {
  createSharedZCodeCredentialStore,
  type SharedZCodeCredentialStore,
} from "../auth/shared-credentials.js";
import {
  deriveCredentialPair,
  isCanonicalCredentials,
  isRecord,
  MCP_OAUTH_CANONICAL_CREDENTIALS_KEY,
  MCP_OAUTH_SUPPORTED_CREDENTIAL_VERSIONS,
  publishCanonicalCredentials,
  type McpOAuthCanonicalCredentials,
} from "./oauth-credentials.js";
import { createInteractiveAuthorizationRequiredError } from "./oauth-errors.js";
import {
  loadDiscoveryRecord,
  saveDiscoveryRecord,
  type McpOAuthAuthorizationContext,
} from "./oauth-shared.js";

const DEFAULT_MCP_OAUTH_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

interface CredentialSnapshot<T> {
  raw: string;
  value: T;
}

interface StoredCredentialPair {
  clientInformation?: OAuthClientInformationMixed;
  source: "canonical" | "legacy";
  tokens?: OAuthTokens;
}

type TransactionClientSource = "canonical" | "legacy" | "registered";
type McpAuthorizationCodeOAuthConfig = Extract<McpOAuthConfig, { type: "authorization_code" }>;

export type { McpOAuthAuthorizationContext };

export interface McpOAuthRuntimeOptions {
  authorizationTimeoutMs?: number;
  credentialStore?: SharedZCodeCredentialStore;
  onAuthorizationRequired?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
  openAuthorizationUrl?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
}

export interface McpOAuthSession {
  close(): Promise<void>;
  readonly provider: OAuthClientProvider;
  readonly timeoutMs: number;
  hasPendingAuthorization(): boolean;
  waitForAuthorizationCallback(): Promise<URLSearchParams>;
}

export async function createMcpAuthorizationCodeOAuthSession(input: {
  adapterInstanceId?: string;
  config: McpAuthorizationCodeOAuthConfig;
  logger?: Logger;
  options?: McpOAuthRuntimeOptions;
  serverName: string;
  serverUrl: string;
}): Promise<McpOAuthSession> {
  const state = randomBytes(24).toString("base64url");
  const callbackPath = normalizeCallbackPath(input.config.redirectPath, input.serverName);
  const callbackServer = await createLocalhostOAuthCallbackServer({
    callbackPath,
    state,
  });
  const credentialStore = input.options?.credentialStore ?? createSharedZCodeCredentialStore();
  const keyPrefix = createCredentialKeyPrefix(input.serverName, input.serverUrl, input.config);
  const provider = new ZCodeMcpAuthorizationCodeProvider({
    adapterInstanceId: input.adapterInstanceId,
    callbackServer,
    config: input.config,
    credentialStore,
    keyPrefix,
    logger: input.logger,
    onAuthorizationRequired: input.options?.onAuthorizationRequired,
    openAuthorizationUrl: input.options?.openAuthorizationUrl,
    serverName: input.serverName,
    state,
  });

  return {
    close: async () => {
      await callbackServer.close();
      await provider.close();
    },
    provider,
    timeoutMs: input.options?.authorizationTimeoutMs ?? DEFAULT_MCP_OAUTH_CALLBACK_TIMEOUT_MS,
    hasPendingAuthorization: () => provider.hasPendingAuthorization(),
    waitForAuthorizationCallback: async () => {
      const callback = await callbackServer.waitForCallback();
      return new URL(callback.url).searchParams;
    },
  };
}

class ZCodeMcpAuthorizationCodeProvider implements OAuthClientProvider {
  private readonly adapterInstanceId?: string;
  private readonly callbackServer: LocalhostOAuthCallbackServer;
  private readonly config: McpAuthorizationCodeOAuthConfig;
  private readonly credentialStore: SharedZCodeCredentialStore;
  private readonly keyPrefix: string;
  private readonly logger?: Logger;
  private readonly onAuthorizationRequired?: (
    context: McpOAuthAuthorizationContext,
  ) => Promise<void> | void;
  private readonly openAuthorizationUrl?: (
    context: McpOAuthAuthorizationContext,
  ) => Promise<void> | void;
  private readonly serverName: string;
  private readonly stateValue: string;
  private readonly transactionId: string;
  private canonicalSnapshot?: CredentialSnapshot<McpOAuthCanonicalCredentials>;
  private credentialSnapshotsLoaded = false;
  private legacyClientSnapshot?: CredentialSnapshot<OAuthClientInformationMixed>;
  private legacyTokensSnapshot?: CredentialSnapshot<OAuthTokens>;
  private storedCredentialPair?: StoredCredentialPair;
  private storedCredentialPairLoaded = false;
  private pendingAuthorization = false;
  private transactionClientInformation?: OAuthClientInformationMixed;
  private transactionClientSource?: TransactionClientSource;
  private verifierPersisted = false;

  constructor(input: {
    adapterInstanceId?: string;
    callbackServer: LocalhostOAuthCallbackServer;
    config: McpAuthorizationCodeOAuthConfig;
    credentialStore: SharedZCodeCredentialStore;
    keyPrefix: string;
    logger?: Logger;
    onAuthorizationRequired?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
    openAuthorizationUrl?: (context: McpOAuthAuthorizationContext) => Promise<void> | void;
    serverName: string;
    state: string;
  }) {
    this.adapterInstanceId = input.adapterInstanceId;
    this.callbackServer = input.callbackServer;
    this.config = input.config;
    this.credentialStore = input.credentialStore;
    this.keyPrefix = input.keyPrefix;
    this.logger = input.logger;
    this.onAuthorizationRequired = input.onAuthorizationRequired;
    this.openAuthorizationUrl = input.openAuthorizationUrl;
    this.serverName = input.serverName;
    this.stateValue = input.state;
    this.transactionId = createHash("sha256").update(input.state).digest("hex");
  }

  get redirectUrl(): string {
    return this.callbackServer.callbackUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.config.clientName ?? `ZCode ${this.serverName}`,
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [this.redirectUrl],
      response_types: ["code"],
      ...(this.config.clientSecret ? { token_endpoint_auth_method: "client_secret_basic" } : {}),
      ...(this.config.scope ? { scope: this.config.scope } : {}),
    };
  }

  state(): string {
    return this.stateValue;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.config.clientId) {
      return {
        client_id: this.config.clientId,
        ...(this.config.clientSecret ? { client_secret: this.config.clientSecret } : {}),
      };
    }
    if (this.transactionClientInformation) {
      return this.transactionClientInformation;
    }

    const storedPair = await this.loadStoredCredentialPair();
    if (storedPair?.clientInformation) {
      this.transactionClientInformation = storedPair.clientInformation;
      this.transactionClientSource = storedPair.source;
      return this.transactionClientInformation;
    }

    // Why (transition seam of root cause 2): returning undefined makes the SDK do a dynamic registration at once, while DCR's
    // ownership moved wholly to Phase 2. No client means no refresh token anyway — only interactive auth is possible —
    // so throw interactiveRequired here, never leaving an unused registration on the authorization server.
    throw createInteractiveAuthorizationRequiredError({
      reason: "no_credentials",
      serverName: this.serverName,
    });
  }

  async saveClientInformation(clientInformation: OAuthClientInformationMixed): Promise<void> {
    // Why: the MCP SDK re-reads the provider during the authorization code exchange.
    // The dynamic-registration result must pin to the provider instance of this state; also write the legacy client first
    // as the recovery seed after provider rebuild. The rest of this transaction reads memory only, safe from concurrent registrations.
    await this.credentialStore.save(
      this.key("client_information"),
      JSON.stringify(clientInformation),
    );
    this.transactionClientInformation = clientInformation;
    this.transactionClientSource = "registered";
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    return (await this.loadStoredCredentialPair())?.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const clientInformation = await this.clientInformation();
    if (!clientInformation) {
      throw new Error(`Missing MCP OAuth client information for ${this.serverName}`);
    }
    const previousTokens = this.storedCredentialPair?.tokens;
    // Published via the shared helper so Phase 2 and this provider write the exact canonical shape
    // (including a per-publication generation). Client and refresh token must come from one authorization;
    // all three keys write atomically inside one cross-process read-modify-write critical section.
    const published = await publishCanonicalCredentials(this.credentialStore, this.keyPrefix, {
      clientInformation,
      publishedBy: this.transactionId,
      tokens,
    });
    this.canonicalSnapshot = { raw: published.raw, value: published.canonical };
    this.legacyClientSnapshot = { raw: published.legacyClientRaw, value: clientInformation };
    this.legacyTokensSnapshot = { raw: published.legacyTokensRaw, value: tokens };
    this.credentialSnapshotsLoaded = true;
    this.storedCredentialPair = {
      clientInformation,
      source: "legacy",
      tokens,
    };
    this.storedCredentialPairLoaded = true;
    this.transactionClientSource = "canonical";
    // Why: neither authorization nor refresh used to emit success-side events; logs showed only authorization.required,
    // leaving it unknowable whether a refresh ever succeeded. Log safe identifiers and shapes only, never token material.
    this.logger?.info("MCP OAuth credentials published", {
      event: "mcp.oauth.credentials.published",
      ...this.logContext(),
      clientIdHash: hashIdentifier(clientInformation.client_id),
      grantKind: previousTokens ? "refresh" : "authorization_code",
      hasRefreshToken: Boolean(tokens.refresh_token),
      publishedGeneration: published.generation.slice(0, 12),
      refreshTokenRotated: Boolean(
        previousTokens?.refresh_token &&
        tokens.refresh_token &&
        previousTokens.refresh_token !== tokens.refresh_token,
      ),
      status: "completed",
      tokenExpiresInSeconds: tokens.expires_in,
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.pendingAuthorization = true;
    // Why (transition seam of root cause 2): this provider reuses the persisted DCR client, whose redirect_uris
    // are pinned to the random port at registration; `authorizationUrl` may thus carry "old client_id + new redirect_uri".
    // Per RFC 6749 4.1.2.1 the server forbids the redirect and renders an error page; the callback never arrives and retries never heal.
    // So no longer project that URL nor open a browser: throw interactiveRequired and let the adapter orchestration
    // enter Phase 2's fresh-DCR authorization transaction (docs/mcp-oauth-two-phase.md 4.7).
    this.logger?.warn("MCP OAuth authorization handed off to interactive transaction", {
      event: "mcp.oauth.authorization.handoff",
      ...this.logContext(),
      callbackPort: Number(new URL(this.redirectUrl).port),
      status: "cancelled",
    });
    void authorizationUrl;
    throw createInteractiveAuthorizationRequiredError({
      reason: "legacy_provider_seam",
      serverName: this.serverName,
    });
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await this.credentialStore.save(this.verifierKey(), codeVerifier);
    this.verifierPersisted = true;
  }

  async codeVerifier(): Promise<string> {
    const codeVerifier = await this.credentialStore.load(this.verifierKey());
    if (!codeVerifier) {
      throw new Error(`Missing MCP OAuth PKCE verifier for ${this.serverName}`);
    }
    this.verifierPersisted = true;
    return codeVerifier;
  }

  async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
    // Share one timestamped discovery record with Phase 2; otherwise one side refreshes AS metadata while
    // the other may still use a TTL-less stale cache.
    await saveDiscoveryRecord(this.credentialStore, this.keyPrefix, state);
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return await loadDiscoveryRecord(this.credentialStore, this.keyPrefix);
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    // Why: refresh failures used to classify only inside the SDK, invisible to ZCode, so token expiry, revocation,
    // client mismatch, and transient server errors were indistinguishable afterwards (the observability gap in docs/analysis).
    // The SDK does not surface the OAuth error code to the provider, but the invalidation scope maps one-to-one:
    // tokens ← invalid_grant；client/all ← invalid_client / unauthorized_client。
    this.logger?.warn("MCP OAuth credentials invalidated", {
      event: "mcp.oauth.credentials.invalidated",
      ...this.logContext(),
      invalidationScope: scope,
      status: "failed",
    });
    if (scope === "all" || scope === "client" || scope === "tokens") {
      await this.invalidateCredentialSnapshot(scope);
    }
    if (scope === "all" || scope === "verifier") {
      await this.clearVerifier();
    }
    if (scope === "all" || scope === "discovery") {
      await this.credentialStore.delete(this.key("discovery_state"));
    }
  }

  hasPendingAuthorization(): boolean {
    return this.pendingAuthorization;
  }

  async close(): Promise<void> {
    // Why: the PKCE verifier belongs to this state alone. On adapter timeout/shutdown, clean up this transaction only,
    // never the verifier another concurrent authorization over the same MCP config waits on. Cleanup is best-effort:
    // once the exchange succeeded, a lock timeout or corrupt file must not flip the main path into a connection failure.
    try {
      await this.clearVerifier();
    } catch (error) {
      this.logger?.warn("MCP OAuth verifier cleanup failed", {
        event: "mcp.oauth.verifier.cleanup_failed",
        adapterInstanceId: this.adapterInstanceId,
        error: error instanceof Error ? error.message : String(error),
        mcpServerName: this.serverName,
        oauthStateId: this.transactionId.slice(0, 16),
        processId: process.pid,
        status: "failed",
      });
    }
    this.transactionClientInformation = undefined;
    this.transactionClientSource = undefined;
    this.resetCredentialSnapshots();
  }

  private async invalidateCredentialSnapshot(scope: "all" | "client" | "tokens"): Promise<void> {
    await this.loadCredentialSnapshots();
    const canonicalSnapshot = this.canonicalSnapshot;
    const expectedValues: Record<string, string> = {};
    if (canonicalSnapshot) {
      expectedValues[this.key(MCP_OAUTH_CANONICAL_CREDENTIALS_KEY)] = canonicalSnapshot.raw;
    }
    if ((scope === "all" || scope === "client") && this.legacyClientSnapshot) {
      expectedValues[this.key("client_information")] = this.legacyClientSnapshot.raw;
    }
    if (
      (scope === "all" || scope === "client" || scope === "tokens") &&
      this.legacyTokensSnapshot
    ) {
      expectedValues[this.key("tokens")] = this.legacyTokensSnapshot.raw;
    }
    const deleted = await this.credentialStore.deleteIfValues(expectedValues);
    const canonicalDeleted = canonicalSnapshot
      ? deleted[this.key(MCP_OAUTH_CANONICAL_CREDENTIALS_KEY)]
      : undefined;
    this.logger?.warn("MCP OAuth credential snapshot invalidation resolved", {
      event: "mcp.oauth.credentials.invalidate_snapshot",
      ...this.logContext(),
      canonicalDeleted,
      // canonicalDeleted=false means compare-and-delete lost: another transaction published a newer pair,
      // and this invalidation must keep the winner. A normal concurrent-settlement outcome, not an error.
      hadCanonicalSnapshot: Boolean(canonicalSnapshot),
      invalidationScope: scope,
      legacyClientDeleted: deleted[this.key("client_information")],
      legacyTokensDeleted: deleted[this.key("tokens")],
      status: canonicalDeleted === false ? "cancelled" : "completed",
    });

    if (scope === "all" || scope === "client") {
      this.transactionClientInformation = undefined;
      this.transactionClientSource = undefined;
    } else if (
      this.transactionClientSource === "canonical" ||
      (canonicalSnapshot && this.transactionClientSource === "legacy")
    ) {
      if (canonicalDeleted === false) {
        // Why: when the snapshot was replaced by another process, the loser must not delete the new pair; clear the local cache
        // so the SDK's same retry re-reads the winning transaction's client/tokens.
        this.transactionClientInformation = undefined;
        this.transactionClientSource = undefined;
      } else if (canonicalDeleted === true) {
        // The token is dead but the dynamic client still serves this provider's re-authorization.
        this.transactionClientSource = "registered";
      }
    }

    this.resetCredentialSnapshots();
  }

  private async loadCredentialSnapshots(): Promise<void> {
    if (this.credentialSnapshotsLoaded) return;
    const canonicalKey = this.key(MCP_OAUTH_CANONICAL_CREDENTIALS_KEY);
    const legacyClientKey = this.key("client_information");
    const legacyTokensKey = this.key("tokens");
    const values = await this.credentialStore.loadMany([
      canonicalKey,
      legacyClientKey,
      legacyTokensKey,
    ]);
    const parsedCanonicalSnapshot = await this.parseJsonSnapshot<McpOAuthCanonicalCredentials>(
      canonicalKey,
      values[canonicalKey],
    );
    let canonicalSnapshot: CredentialSnapshot<McpOAuthCanonicalCredentials> | undefined;
    if (
      parsedCanonicalSnapshot &&
      isRecord(parsedCanonicalSnapshot.value) &&
      typeof parsedCanonicalSnapshot.value.version === "number" &&
      !MCP_OAUTH_SUPPORTED_CREDENTIAL_VERSIONS.has(parsedCanonicalSnapshot.value.version)
    ) {
      // Why: CLI and desktop upgrade independently yet share the credential file. Older versions must skip unknown versions,
      // never deleting a newer canonical pair as corrupt data.
    } else if (parsedCanonicalSnapshot && !isCanonicalCredentials(parsedCanonicalSnapshot.value)) {
      await this.credentialStore.deleteIfValue(canonicalKey, parsedCanonicalSnapshot.raw);
    } else {
      canonicalSnapshot = parsedCanonicalSnapshot;
    }
    const legacyClientSnapshot = await this.parseJsonSnapshot<OAuthClientInformationMixed>(
      legacyClientKey,
      values[legacyClientKey],
    );
    const legacyTokensSnapshot = await this.parseJsonSnapshot<OAuthTokens>(
      legacyTokensKey,
      values[legacyTokensKey],
    );

    // Why: shared-credential reads may throw on lock timeout or transient I/O. Publish cache and the loaded flag
    // only after a full snapshot succeeds, so the same provider's next call retries.
    this.canonicalSnapshot = canonicalSnapshot;
    this.legacyClientSnapshot = legacyClientSnapshot;
    this.legacyTokensSnapshot = legacyTokensSnapshot;
    this.credentialSnapshotsLoaded = true;
  }

  private async parseJsonSnapshot<T>(
    key: string,
    raw: string | null | undefined,
  ): Promise<CredentialSnapshot<T> | undefined> {
    if (!raw) return undefined;
    try {
      return { raw, value: JSON.parse(raw) as T };
    } catch {
      await this.credentialStore.deleteIfValue(key, raw);
      return undefined;
    }
  }

  private async loadStoredCredentialPair(): Promise<StoredCredentialPair | undefined> {
    if (this.storedCredentialPairLoaded) return this.storedCredentialPair;
    await this.loadCredentialSnapshots();
    // Delegated to the shared pure function: the canonical/legacy interleaving-compat rules must exist once; written twice they diverge.
    // Derive from the already-read snapshot, no extra credential read; the snapshot stays in this class because
    // compare-and-delete needs the initiator's original values.
    const pair = deriveCredentialPair({
      canonicalRaw: this.canonicalSnapshot?.raw,
      legacyClientRaw: this.legacyClientSnapshot?.raw,
      legacyTokensRaw: this.legacyTokensSnapshot?.raw,
    });
    this.storedCredentialPair = pair
      ? {
          ...(pair.clientInformation ? { clientInformation: pair.clientInformation } : {}),
          source: pair.source,
          ...(pair.tokens ? { tokens: pair.tokens } : {}),
        }
      : undefined;
    this.storedCredentialPairLoaded = true;
    return this.storedCredentialPair;
  }

  private resetCredentialSnapshots(): void {
    this.canonicalSnapshot = undefined;
    this.credentialSnapshotsLoaded = false;
    this.legacyClientSnapshot = undefined;
    this.legacyTokensSnapshot = undefined;
    this.storedCredentialPair = undefined;
    this.storedCredentialPairLoaded = false;
  }

  private async loadJson<T>(name: string): Promise<T | undefined> {
    const raw = await this.credentialStore.load(this.key(name));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      await this.credentialStore.deleteIfValue(this.key(name), raw);
      return undefined;
    }
  }

  private async saveJson(name: string, value: unknown): Promise<void> {
    await this.credentialStore.save(this.key(name), JSON.stringify(value));
  }

  private key(name: string): string {
    return `${this.keyPrefix}:${name}`;
  }

  /** Concurrency diagnostics logs allow safe identifiers only: PID, adapter id, credential key prefix, state short-hash. */
  private logContext(): Record<string, unknown> {
    return {
      adapterInstanceId: this.adapterInstanceId,
      credentialKeyPrefix: this.keyPrefix,
      mcpServerName: this.serverName,
      oauthStateId: this.transactionId.slice(0, 16),
      processId: process.pid,
    };
  }

  private verifierKey(): string {
    return this.key(`code_verifier:${this.stateValue}`);
  }

  private async clearVerifier(): Promise<void> {
    if (!this.verifierPersisted) return;
    await this.credentialStore.delete(this.verifierKey());
    this.verifierPersisted = false;
  }
}

/** Log-safe digest: identifiers like client_id recorded as hash prefixes, never raw. */
function hashIdentifier(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function normalizeCallbackPath(value: string | undefined, serverName: string): string {
  const fallback = `/oauth/callback/mcp/${encodeURIComponent(serverName)}`;
  if (!value) return fallback;
  return value.startsWith("/") ? value : `/${value}`;
}

export function createCredentialKeyPrefix(
  serverName: string,
  serverUrl: string,
  config: McpAuthorizationCodeOAuthConfig,
): string {
  // OAuth tokens and dynamic client registration depend on grant semantics: any scope/client/redirect change re-grants.
  const hash = createHash("sha256")
    .update(
      [
        serverName,
        serverUrl,
        config.clientId ?? "",
        config.scope ?? "",
        config.redirectPath ?? "",
      ].join("\n"),
    )
    .digest("hex")
    .slice(0, 24);
  return `mcp:oauth:${hash}`;
}
