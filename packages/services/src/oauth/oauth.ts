import type {
  OAuthCachedSessionRestoreResult,
  OAuthCallbackResult,
  OAuthProviderId,
  OAuthProviderMeta,
  OAuthStartResponse,
  UserInfo,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * OAuth auth service.
 *
 * Runs in the host process and owns all OAuth business logic:
 * provider management, state lifecycle, token exchange, credential storage.
 */
export interface IOAuthService {
  /** List available providers (enabled=true only) */
  getProviders(): Promise<OAuthProviderMeta[]>;

  /** The current active provider */
  getActiveProvider(): Promise<OAuthProviderId | null>;

  /** Restore the session display state from local cache at startup: returns user info, no remote token validation */
  restoreCachedSession(): Promise<UserInfo | null>;

  /** Restore local display state, distinguishing never-signed-in from expired-JWT-needs-reauth. */
  restoreCachedSessionState(): Promise<OAuthCachedSessionRestoreResult>;

  /** Explicitly validate the current provider session: user info on success, null on failure/expiry */
  restoreSession(): Promise<UserInfo | null>;

  /**
   * Start OAuth: pick the provider, mint state, return the authorize URL.
   // The renderer reports state to main for deep-link routing.
   */
  startOAuth(provider: OAuthProviderId): Promise<OAuthStartResponse>;

  /** Start OAuth via a backend short-lived flow; Z.AI only today, others keep the legacy flow. */
  startOAuthWithPolling(provider: OAuthProviderId): Promise<OAuthStartResponse>;

  /** Query the backend OAuth flow; null before poll time, while pending, or without a flow. */
  pollPendingOAuth(): Promise<OAuthCallbackResult | null>;

  /**
   * Handle the OAuth callback: verify state; with code, exchange and store; attribution-only params persist attribution.
   // Returns null when the callback was cancelled/superseded; callers ignore silently.
   * @param url - the full deep link URL
   */
  handleCallback(url: string): Promise<OAuthCallbackResult | null>;

  /**
   * Refresh the token.
   * @param provider - optional; defaults to the active provider
   */
  refreshToken(provider?: OAuthProviderId): Promise<void>;

  /**
   * Sign out a provider.
   * @param provider - optional; defaults to the active provider
   */
  logout(provider?: OAuthProviderId): Promise<void>;

  /** Sign out every provider */
  logoutAll(): Promise<void>;

  /**
   * Cancel the pending OAuth.
   * @param provider - optional; defaults to the current pending
   */
  cancelPending(provider?: OAuthProviderId): Promise<void>;
}

export const IOAuthService = createServiceDescriptor<IOAuthService>(ServiceChannels.OAuth);
