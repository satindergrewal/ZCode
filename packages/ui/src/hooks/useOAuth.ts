/**
 * useOAuth — OAuth login flow hook.
 *
 * Owns login initiation and UI state only. The OAuth callback listener lives in the
 * resident Root/App layer, not here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { OAuthProviderId, OAuthProviderMeta } from "@zcode/shared";
import {
  BIGMODEL_PROVIDER_ID,
  isCredentialDecryptError,
  resolveSafeTelemetryHostname,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import { reportAppTelemetryEvent } from "@/lib/appTelemetry.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { LoginEntryPurpose } from "@/store/index.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { logger } from "../logger.js";
import { usePlatform } from "./usePlatform.js";
import { useServices } from "./useServices.js";

type OAuthStatus = "idle" | "waiting" | "error";

export function useOAuth() {
  const { oauthService } = useServices();
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const [status, setStatus] = useState<OAuthStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<OAuthProviderMeta[]>([]);
  const [activeProvider, setActiveProvider] = useState<OAuthProviderId | null>(null);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [pendingProvider, setPendingProvider] = useState<OAuthProviderId | null>(null);
  const loginAttemptRef = useRef(0);
  const setOAuthPollingActive = useZCodeStore((state) => state.setOAuthPollingActive);

  const refreshProviders = useCallback(async () => {
    try {
      setLoadingProviders(true);
      const providerList = await oauthService.getProviders();
      setProviders(providerList);

      try {
        const active = await oauthService.getActiveProvider();
        setActiveProvider(active);
      } catch (err) {
        // Only local OAuth credential-decrypt failures may downgrade to signed-out; RPC or
        // storage-permission errors must take the outer error path.
        if (!isCredentialDecryptError(err)) {
          throw err;
        }

        // The active provider is just the signed-in pointer; the service layer cleans up
        // OAuth credentials on decrypt failure. The provider list still works — never show
        // "no login methods".
        logger.warn(
          "[useOAuth] failed to load active provider credentials; treating as signed out:",
          err,
        );
        setActiveProvider(null);
      }
    } catch (err) {
      logger.error("[useOAuth] failed to load provider list:", err);
      setProviders([]);
      setActiveProvider(null);
    } finally {
      setLoadingProviders(false);
    }
  }, [oauthService]);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  const startLogin = useCallback(
    async (provider: OAuthProviderId, options: { purpose?: LoginEntryPurpose } = {}) => {
      const loginAttempt = ++loginAttemptRef.current;
      try {
        setStatus("waiting");
        setError(null);
        setPendingProvider(provider);

        const {
          authorizeUrl,
          state,
          provider: startedProvider,
        } = await oauthService.startOAuthWithPolling(provider);

        if (loginAttemptRef.current !== loginAttempt) {
          return;
        }

        platform.registerOAuthState({ state, provider: startedProvider });
        setOAuthPollingActive(
          startedProvider === ZAI_PROVIDER_ID || startedProvider === BIGMODEL_PROVIDER_ID,
        );
        platform.openExternal(authorizeUrl);
        void reportAppTelemetryEvent(
          platform,
          {
            elementName: "app_login_ck",
            eventRegion: "app",
            eventType: "ck",
            eventExtraDetail: {
              // The authorize URL carries state/credential params; telemetry takes the hostname only, while the browser still gets the full URL above.
              login_url: resolveSafeTelemetryHostname(authorizeUrl),
            },
          },
          "useOAuth",
        );

        logger.info("[useOAuth] OAuth flow started; awaiting browser callback", {
          provider: startedProvider,
          purpose: options.purpose ?? "app-login",
        });
      } catch (err) {
        // An old init's failure may land after a new login succeeded; it must not stop the
        // new flow's polling or overwrite the UI.
        if (loginAttemptRef.current !== loginAttempt) {
          return;
        }
        logger.error("[useOAuth] failed to start OAuth:", err);
        setOAuthPollingActive(false);
        setStatus("error");
        // A failed OAuth start is a failed login: never show the raw server/platform error.
        // The message renders via i18n so the login page stays free of provider/token-level
        // failure detail.
        setError(intl.formatMessage({ id: "login.oauth.loginFailure" }));
        setPendingProvider(null);
      }
    },
    [intl, oauthService, platform, setOAuthPollingActive],
  );

  const cancel = useCallback(
    async (provider?: OAuthProviderId) => {
      loginAttemptRef.current += 1;
      await oauthService.cancelPending(provider);
      setOAuthPollingActive(false);
      setStatus("idle");
      setError(null);
      setPendingProvider(null);
    },
    [oauthService, setOAuthPollingActive],
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
    setPendingProvider(null);
  }, []);

  /** Invoked by the Root/App-layer callback listener to update UI state. */
  const setOAuthError = useCallback((message: string) => {
    setStatus("error");
    setError(message);
    setPendingProvider(null);
  }, []);

  const setOAuthSuccess = useCallback(async () => {
    setStatus("idle");
    setError(null);
    setPendingProvider(null);
    await refreshProviders();
  }, [refreshProviders]);

  return {
    startLogin,
    cancel,
    reset,
    status,
    error,
    providers,
    activeProvider,
    loadingProviders,
    pendingProvider,
    refreshProviders,
    setOAuthError,
    setOAuthSuccess,
  };
}
