/* oxlint-disable eslint(max-lines) */
/**
 * WelcomeScreen — OAuth / API key login entry.
 *
 * OAuth flow driven by the useOAuth hook.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Loader2Icon, LoaderIcon, TriangleAlertIcon } from "lucide-react";
import {
  type OAuthProviderMeta,
  BIGMODEL_PROVIDER_ID,
  TID_LOGIN_USE_API_KEY_BUTTON,
  TID_OAUTH_CANCEL,
  TID_OAUTH_ERROR,
  TID_OAUTH_LOGIN_BUTTON,
  ZAI_PROVIDER_ID,
  testId,
} from "@zcode/shared";
import { Alert, AlertDescription } from "./components/ui/alert.js";
import { Button } from "./components/ui/button.js";
import { ZCodeAboutLogo } from "@/components/ui/ZCodeAboutLogo.js";
import { useOAuth } from "./hooks/useOAuth.js";
import { useZCodeIntl } from "./i18n/IntlProvider.js";
import { LoginApiKeyForm } from "./login/LoginApiKeyForm.js";
import { renderOAuthProviderIcon } from "./lib/oauthProviderIcon.js";
import { ThemeHeroVisual } from "./openWorkspacePageThemeHero.js";
import { useZCodeStore } from "./store/StoreProvider.js";

/**
 * Login screen mode:
 * - "startup": first-run / provider gate — API-key (custom provider) form only,
 *   no OAuth provider buttons. Other logins live in Settings → Model settings.
 * - "login-entry": explicitly opened from a settings/agent login entry — full
 *   provider list + API-key toggle (legacy behavior).
 */
export type LoginScreenMode = "startup" | "login-entry";

interface WelcomeScreenProps {
  mode: LoginScreenMode;
  onComplete: (reason: LoginCompleteReason) => void | Promise<void>;
}

export type LoginCompleteReason = "oauth" | "apiKey" | "skip";

export function WelcomeScreen({ mode, onComplete }: WelcomeScreenProps) {
  return (
    <main className="relative flex h-full min-h-dvh items-center justify-center overflow-hidden bg-background px-4 py-6 text-foreground sm:px-6">
      <ThemeHeroVisual className="absolute inset-0" />
      <div className="pointer-events-none absolute left-0 top-0 right-0 z-10 flex h-12 w-full items-center [app-region:drag]" />
      <section className="relative z-10 w-full flex flex-col gap-10 max-w-sm rounded-2xl border border-popover-border bg-background p-8 text-ui-base/relaxed shadow-md sm:p-10">
        <LoginPanel mode={mode} active onComplete={onComplete} />
      </section>
    </main>
  );
}

interface LoginPanelProps {
  mode: LoginScreenMode;
  active: boolean;
  onComplete: (reason: LoginCompleteReason) => void | Promise<void>;
}

interface ActiveLoginEntryAttempt {
  id: number;
  providerId: OAuthProviderMeta["id"];
}

function shouldCompleteProviderLoginAttempt(params: {
  attempt: ActiveLoginEntryAttempt | null;
  successProvider: OAuthProviderMeta["id"] | null;
}): boolean {
  return !params.attempt || params.successProvider === params.attempt.providerId;
}

function shouldCompleteLoginFromExistingUser(params: {
  hasUser: boolean;
  attempt: ActiveLoginEntryAttempt | null;
}): boolean {
  return params.hasUser && !params.attempt;
}

function LoginPanel({ mode, active, onComplete }: LoginPanelProps) {
  const { intl } = useZCodeIntl();
  const {
    startLogin,
    cancel,
    reset,
    status,
    error,
    providers,
    loadingProviders,
    pendingProvider,
    refreshProviders,
  } = useOAuth();
  const user = useZCodeStore((s) => s.user);
  const oauthError = useZCodeStore((s) => s.oauthError);
  const setOAuthError = useZCodeStore((s) => s.setOAuthError);
  const oauthSuccessSeq = useZCodeStore((s) => s.oauthSuccessSeq);
  const lastOAuthSuccessProvider = useZCodeStore((s) => s.lastOAuthSuccessProvider);
  const loginEntryRequest = useZCodeStore((s) => s.loginEntryRequest);
  const clearLoginEntryRequest = useZCodeStore((s) => s.clearLoginEntryRequest);
  const markLoginEntryAttemptStatus = useZCodeStore((s) => s.markLoginEntryAttemptStatus);
  const [loginMode, setLoginMode] = useState<"providers" | "apiKey">("providers");
  const wasActiveRef = useRef(active);
  const consumedLoginRequestRef = useRef<number | null>(null);
  const observedOAuthSuccessSeqRef = useRef(oauthSuccessSeq);
  const lastAttemptProviderRef = useRef<OAuthProviderMeta["id"] | null>(null);
  const activeLoginEntryAttemptRef = useRef<ActiveLoginEntryAttempt | null>(null);

  const finishActiveLoginEntryAttempt = useCallback(
    (status: "succeeded" | "cancelled" | "failed") => {
      const attempt = activeLoginEntryAttemptRef.current;
      if (!attempt) {
        return;
      }
      activeLoginEntryAttemptRef.current = null;
      markLoginEntryAttemptStatus(attempt.id, status);
    },
    [markLoginEntryAttemptStatus],
  );

  const startTrackedLogin = useCallback(
    (
      provider: OAuthProviderMeta["id"],
      options?: Parameters<typeof startLogin>[1],
      loginEntryAttemptId?: number,
    ) => {
      const activeAttempt = activeLoginEntryAttemptRef.current;
      if (activeAttempt && activeAttempt.id !== loginEntryAttemptId) {
        // When the user starts another login flow on the unified screen, a stale purchase intent must not keep waiting.
        finishActiveLoginEntryAttempt("cancelled");
      }
      // A leftover store oauthError from the previous failure, if not cleared, shows the failure
      // and waiting hints together once the new flow waits (e.g. closing the login entry after a
      // failure, then auto-resuming from settings).
      setOAuthError(null);
      if (loginEntryAttemptId !== undefined) {
        activeLoginEntryAttemptRef.current = {
          id: loginEntryAttemptId,
          providerId: provider,
        };
        markLoginEntryAttemptStatus(loginEntryAttemptId, "waiting");
      }
      lastAttemptProviderRef.current = provider;
      return startLogin(provider, options);
    },
    [finishActiveLoginEntryAttempt, markLoginEntryAttemptStatus, setOAuthError, startLogin],
  );

  const providerNameMap = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider.displayName])),
    [providers],
  );

  const pendingProviderName = pendingProvider
    ? (providerNameMap.get(pendingProvider) ?? pendingProvider)
    : null;
  const visibleProviders = useMemo(() => resolveVisibleLoginProviders(providers), [providers]);

  useEffect(() => {
    if (active) {
      void refreshProviders();
    }
  }, [active, refreshProviders]);

  useEffect(() => {
    if (
      !active ||
      !loginEntryRequest?.providerId ||
      consumedLoginRequestRef.current === loginEntryRequest.id
    ) {
      return;
    }

    consumedLoginRequestRef.current = loginEntryRequest.id;
    clearLoginEntryRequest(loginEntryRequest.id);
    // Model Provider login/connect entries used to fire OAuth directly, bypassing the unified
    // login screen, so waiting/cancel/error states were invisible. When WelcomeScreen opens, start
    // the requested provider automatically, reusing the entry's loading flow, with a request id
    // guarding double-start under React StrictMode.
    void startTrackedLogin(
      loginEntryRequest.providerId,
      {
        purpose: loginEntryRequest.purpose,
      },
      loginEntryRequest.id,
    );
  }, [active, clearLoginEntryRequest, loginEntryRequest, startTrackedLogin]);

  // On OAuth callback failure the Root layer writes oauthError into Zustand; this screen shows it.
  useEffect(() => {
    if (oauthError && active) {
      finishActiveLoginEntryAttempt("failed");
      reset(); // reset useOAuth's waiting state
      // oauthError already in the store; the UI below reads and shows it
    }
  }, [active, finishActiveLoginEntryAttempt, oauthError, reset]);

  useEffect(() => {
    if (active && status === "error") {
      finishActiveLoginEntryAttempt("failed");
    }
  }, [active, finishActiveLoginEntryAttempt, status]);

  // On OAuth success the Root layer sets user and this screen closes automatically.
  useEffect(() => {
    if (
      active &&
      shouldCompleteLoginFromExistingUser({
        hasUser: Boolean(user),
        attempt: activeLoginEntryAttemptRef.current,
      })
    ) {
      // A pre-existing global user may come from another provider; do not mistake the just-started
      // purchase login for success. The provider-specific attempt completes only via its matching
      // OAuth success.
      reset();
      setOAuthError(null);
      void onComplete("oauth");
    }
  }, [active, finishActiveLoginEntryAttempt, onComplete, reset, setOAuthError, user]);

  useEffect(() => {
    if (!active) {
      observedOAuthSuccessSeqRef.current = oauthSuccessSeq;
      return;
    }

    if (oauthSuccessSeq > observedOAuthSuccessSeqRef.current) {
      observedOAuthSuccessSeqRef.current = oauthSuccessSeq;
    } else {
      return;
    }

    if (
      status === "waiting" &&
      shouldCompleteProviderLoginAttempt({
        attempt: activeLoginEntryAttemptRef.current,
        successProvider: lastOAuthSuccessProvider,
      })
    ) {
      // Provider connection reuses the login screen's visuals but never writes the App user on
      // success; close via Root's success signal to keep the interaction unchanged.
      finishActiveLoginEntryAttempt("succeeded");
      reset();
      setOAuthError(null);
      void onComplete("oauth");
    }
  }, [
    active,
    finishActiveLoginEntryAttempt,
    lastOAuthSuccessProvider,
    oauthSuccessSeq,
    onComplete,
    reset,
    setOAuthError,
    status,
  ]);

  const resetApiKeyForm = useCallback(() => {
    setLoginMode("providers");
  }, []);

  useEffect(() => {
    if (active) {
      wasActiveRef.current = true;
      return;
    }

    if (!wasActiveRef.current) {
      return;
    }
    wasActiveRef.current = false;

    if (status === "waiting") {
      void cancel(pendingProvider ?? undefined);
    }
    finishActiveLoginEntryAttempt("cancelled");
    reset();
    setOAuthError(null);
    clearLoginEntryRequest();
    resetApiKeyForm();
  }, [
    active,
    cancel,
    clearLoginEntryRequest,
    finishActiveLoginEntryAttempt,
    pendingProvider,
    reset,
    resetApiKeyForm,
    setOAuthError,
    status,
  ]);

  return (
    <>
      <LoginPanelHeader
        title={intl.formatMessage({ id: "login.title" })}
        description={intl.formatMessage({ id: "login.description" })}
      >
        {null}
      </LoginPanelHeader>

      <div className="space-y-6">
        {/* Once Root writes oauthError (poll/callback failure) the effect resets useOAuth to idle;
            gating on status==="idle" alone would show the failure block and provider buttons
            together, states entangled. While failing, the failure block below owns the flow
            (retry/cancel); the provider list returns once the error clears. */}
        {status === "idle" &&
          !oauthError &&
          loginMode === "providers" &&
          mode === "login-entry" && (
          <div className="space-y-4">
            {loadingProviders ? (
              <div className="flex items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 py-6 text-ui-base text-foreground-subtle">
                <Loader2Icon className="size-4 animate-spin" />
                {intl.formatMessage({ id: "login.oauth.loadingProviders" })}
              </div>
            ) : null}

            {!loadingProviders && providers.length === 0 ? (
              <Alert
                variant="warning"
                className="flex items-center justify-center gap-2 text-center"
                data-testid={TID_OAUTH_ERROR}
              >
                <TriangleAlertIcon className="size-4" />
                <AlertDescription className="text-center">
                  {intl.formatMessage({ id: "login.oauth.noProviders" })}
                </AlertDescription>
              </Alert>
            ) : null}

            {!loadingProviders ? (
              <div className="space-y-2">
                {visibleProviders.map((provider) => (
                  <Button
                    key={provider.id}
                    variant="default"
                    className="h-10 w-full text-ui-base"
                    size="lg"
                    data-testid={
                      provider.id === BIGMODEL_PROVIDER_ID
                        ? TID_OAUTH_LOGIN_BUTTON
                        : testId(TID_OAUTH_LOGIN_BUTTON, provider.id)
                    }
                    onClick={() => void startTrackedLogin(provider.id)}
                  >
                    {renderOAuthProviderIcon(provider.id, "size-4")}
                    <span className="min-w-0 truncate">
                      {intl.formatMessage(
                        { id: getLoginOAuthButtonMessageId(provider.id) },
                        { provider: provider.displayName },
                      )}
                    </span>
                    <LoginOAuthRegionTag providerId={provider.id} />
                  </Button>
                ))}
                <Button
                  variant="outline"
                  className="h-10 w-full text-ui-base"
                  size="lg"
                  data-testid={TID_LOGIN_USE_API_KEY_BUTTON}
                  onClick={() => {
                    setLoginMode("apiKey");
                  }}
                >
                  {intl.formatMessage({ id: "login.useApiKey" })}
                </Button>
              </div>
            ) : null}
          </div>
        )}

        {status === "idle" && loginMode === "apiKey" && mode === "login-entry" ? (
          <LoginApiKeyForm
            onCancel={() => setLoginMode("providers")}
            onSaved={() => {
              resetApiKeyForm();
              return onComplete("apiKey");
            }}
            onSkipped={() => {
              resetApiKeyForm();
              return onComplete("skip");
            }}
          />
        ) : null}

        {/* Startup variant: API-key / custom-provider setup only, no OAuth buttons and no
            Cancel (there is no provider list to return to). Other logins are added later
            from Settings → Model settings, or the user stays unconnected via Skip. */}
        {status === "idle" && !oauthError && mode === "startup" ? (
          <LoginApiKeyForm
            allowCancel={false}
            onSaved={() => {
              resetApiKeyForm();
              return onComplete("apiKey");
            }}
            onSkipped={() => {
              resetApiKeyForm();
              return onComplete("skip");
            }}
          />
        ) : null}

        {status === "waiting" && (
          <div className="space-y-4">
            <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-surface p-2 text-ui-base text-foreground-subtle">
              <LoaderIcon className="size-4 animate-spin" />
              {intl.formatMessage(
                { id: "login.oauth.waiting" },
                { provider: pendingProviderName ?? "OAuth" },
              )}
            </div>
            <Button
              variant="outline"
              className="h-10 w-full text-ui-base"
              size="lg"
              data-testid={TID_OAUTH_CANCEL}
              onClick={() => {
                // Cancel during OAuth waiting only cancels the browser authorization wait; it must
                // not close the whole login entry, or switching methods requires reopening it.
                finishActiveLoginEntryAttempt("cancelled");
                void cancel(pendingProvider ?? undefined);
              }}
            >
              {intl.formatMessage({ id: "login.oauth.cancel" })}
            </Button>
          </div>
        )}

        {(status === "error" || oauthError) && (
          <div className="space-y-4">
            <Alert
              variant="warning"
              className="flex items-center justify-center gap-2 text-center"
              data-testid={TID_OAUTH_ERROR}
            >
              <TriangleAlertIcon className="size-4" />
              <AlertDescription className="text-center">
                {/* Login failure is usually retryable/switchable, not destructive; red would
                    misread as fatal. Use warning semantics, centered to match the panel's rhythm. */}
                {oauthError || error}
              </AlertDescription>
            </Alert>
            <Button
              className="h-10 w-full text-ui-base"
              size="lg"
              onClick={() => {
                const retryProvider = resolveLoginRetryProvider({
                  pendingProvider,
                  lastAttemptProvider: lastAttemptProviderRef.current,
                  providers,
                });
                if (!retryProvider) {
                  return;
                }
                // OAuth callback failure triggers reset(), clearing pendingProvider. Retry must
                // reuse the provider that just failed, not fall back to providers[0] (BigModel) by
                // declaration order. Leftover store errors are cleared by startTrackedLogin.
                void startTrackedLogin(retryProvider);
              }}
            >
              {intl.formatMessage({ id: "login.oauth.retry" })}
            </Button>
            <Button
              variant="outline"
              className="h-10 w-full text-ui-base"
              size="lg"
              data-testid={TID_OAUTH_CANCEL}
              onClick={() => {
                // The failure state must not offer only "retry" on the same provider; switching
                // meant closing and reopening the entry, re-failing on the same path. Align with
                // the waiting state's cancel semantics: end this failed attempt back to the
                // provider list without closing the entry.
                finishActiveLoginEntryAttempt("cancelled");
                setOAuthError(null);
                void cancel(pendingProvider ?? undefined);
              }}
            >
              {intl.formatMessage({ id: "login.oauth.cancel" })}
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

function LoginPanelHeader({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <header className="flex flex-col items-center gap-3 text-center">
      <LoginPanelLogo />
      <div className="flex flex-col items-center gap-1 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="text-ui-base/relaxed text-foreground-subtle">{description}</p>
      </div>
      {children}
    </header>
  );
}

function LoginPanelLogo() {
  return (
    // The login logo shell is fixed dark; a theme-following border gets too heavy in light mode.
    <div
      className="relative mb-1 flex size-16 items-center justify-center rounded-2xl bg-[linear-gradient(180deg,#000000_0%,#151718_100%)] text-[#ffffff] shadow-lg/20 before:pointer-events-none before:absolute before:inset-0 before:rounded-2xl before:border before:border-[rgba(255,255,255,0.1)]"
      aria-label="ZCode"
      role="img"
    >
      <ZCodeAboutLogo className="h-auto w-10" />
    </div>
  );
}

function getLoginOAuthButtonMessageId(providerId: string): string {
  switch (providerId) {
    case ZAI_PROVIDER_ID:
      return "login.oauth.button.zai";
    case BIGMODEL_PROVIDER_ID:
      return "login.oauth.button.bigmodel";
    default:
      return "login.oauth.button";
  }
}

function getLoginOAuthRegionTagMessageId(providerId: string): string | null {
  switch (providerId) {
    case ZAI_PROVIDER_ID:
      return "login.oauth.regionTag.zai";
    case BIGMODEL_PROVIDER_ID:
      return "login.oauth.regionTag.bigmodel";
    default:
      return null;
  }
}

function LoginOAuthRegionTag({ providerId }: { providerId: string }) {
  const { intl } = useZCodeIntl();
  const messageId = getLoginOAuthRegionTagMessageId(providerId);

  if (!messageId) {
    return null;
  }

  return (
    <span className="ml-1 inline-flex h-5 shrink-0 items-center rounded-full border border-primary-foreground/30 px-2 text-ui-xs font-medium leading-none text-primary-foreground/60">
      {intl.formatMessage({ id: messageId })}
    </span>
  );
}

function getProviderPriority(provider: OAuthProviderMeta): number {
  switch (provider.id) {
    // On the Windows login entry, z.ai must sort first; when BigModel ranked higher, users saw
    // the secondary entry first. Adjust sort weight only — display order, not the OAuth provider
    // config source.
    case ZAI_PROVIDER_ID:
      return 0;
    case BIGMODEL_PROVIDER_ID:
      return 1;
    default:
      return 10 + provider.order;
  }
}

function resolveVisibleLoginProviders(providers: OAuthProviderMeta[]): OAuthProviderMeta[] {
  // ZAI and BigModel now share the App login source of truth; when logged out, the entry must
  // show both. Hiding BigModel temporarily would leave no way to choose it as the active provider.
  return [...providers].sort((left, right) => {
    return getProviderPriority(left) - getProviderPriority(right);
  });
}

function resolveLoginRetryProvider({
  pendingProvider,
  lastAttemptProvider,
  providers,
}: {
  pendingProvider: OAuthProviderMeta["id"] | null;
  lastAttemptProvider: OAuthProviderMeta["id"] | null;
  providers: OAuthProviderMeta[];
}): OAuthProviderMeta["id"] | null {
  return pendingProvider ?? lastAttemptProvider ?? providers[0]?.id ?? null;
}
