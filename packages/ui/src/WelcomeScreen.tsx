/* oxlint-disable eslint(max-lines) */
/**
 * WelcomeScreen: OAuth / API key sign-in.
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
import { DesktopOverlayWindowControls } from "@/DesktopOverlayWindowControls.js";

interface WelcomeScreenProps {
  mode: LoginScreenMode;
  onComplete: (reason: LoginCompleteReason) => void | Promise<void>;
}

/**
 * Login screen mode:
 * - "startup": first-run / provider gate — API-key (custom provider) form only,
 *   no OAuth provider buttons. Other logins live in Settings → Model settings.
 * - "login-entry": explicitly opened from a settings/agent login entry — full
 *   provider list + API-key toggle (legacy behavior).
 */
export type LoginScreenMode = "startup" | "login-entry";

export type LoginCompleteReason = "oauth" | "apiKey" | "skip";

export function WelcomeScreen({ mode, onComplete }: WelcomeScreenProps) {
  return (
    <main className="relative flex h-full min-h-dvh items-center justify-center overflow-hidden bg-background px-4 py-6 text-foreground sm:px-6">
      <ThemeHeroVisual className="absolute inset-0" />
      {/* Native drag hit-testing ignores pointer-events/z-index; the drag layer avoids window controls and declares before no-drag areas. */}
      <div className="pointer-events-none absolute left-0 top-0 right-0 z-10 flex h-12 items-center [app-region:drag] platform-windows-desktop:right-[134px] platform-linux-desktop:right-[134px]" />
      <DesktopOverlayWindowControls />
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

export function shouldCompleteProviderLoginAttempt(params: {
  attempt: ActiveLoginEntryAttempt | null;
  successProvider: OAuthProviderMeta["id"] | null;
}): boolean {
  return !params.attempt || params.successProvider === params.attempt.providerId;
}

export function shouldCompleteLoginFromExistingUser(params: {
  hasUser: boolean;
  attempt: ActiveLoginEntryAttempt | null;
}): boolean {
  return params.hasUser && !params.attempt;
}

export function LoginPanel({ mode, active, onComplete }: LoginPanelProps) {
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
        // A new login flow must not leave the previous purchase intent waiting.
        finishActiveLoginEntryAttempt("cancelled");
      }
      // A stale oauthError shows failure and waiting copy together once the
      // new flow waits (fail, close, then auto-resume from settings).
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
    // Provider entries used to bypass this page and fire OAuth directly, hiding
    // waiting/cancel/error states. On open, auto-start the requested provider through
    // the shared loading flow, with a request id guarding strict-mode double fires.
    void startTrackedLogin(
      loginEntryRequest.providerId,
      {
        purpose: loginEntryRequest.purpose,
      },
      loginEntryRequest.id,
    );
  }, [active, clearLoginEntryRequest, loginEntryRequest, startTrackedLogin]);

  // Root writes oauthError on callback failure; this page renders it.
  useEffect(() => {
    if (oauthError && active) {
      finishActiveLoginEntryAttempt("failed");
      reset(); // reset the useOAuth waiting state
      // oauthError is already in the store; the UI below renders it.
    }
  }, [active, finishActiveLoginEntryAttempt, oauthError, reset]);

  useEffect(() => {
    if (active && status === "error") {
      finishActiveLoginEntryAttempt("failed");
    }
  }, [active, finishActiveLoginEntryAttempt, status]);

  // Root sets user on OAuth success; the page closes itself.
  useEffect(() => {
    if (
      active &&
      shouldCompleteLoginFromExistingUser({
        hasUser: Boolean(user),
        attempt: activeLoginEntryAttemptRef.current,
      })
    ) {
      // A global user may come from another provider; never read a fresh purchase login
      // as success; only the matching provider attempt completes it.
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
      // Provider connection reuses the login visuals but never writes the App user;
      // close on Root's success signal, UX unchanged.
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
        {/* Bugfix: after Root writes oauthError an effect resets useOAuth to idle; keying on
            status===idle shows failure and channel list together. While failing, the failure
            block owns the flow (retry/cancel); channels return once the error clears. */}
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
                // Cancel inside the OAuth wait aborts the browser grant only,
                // not the page; closing it all forces a full reopen to switch methods.
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
                {/* Bugfix: login failure is retryable/switchable, not destructive; warning
                    semantics, centered to match the panel's rhythm. */}
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
                // OAuth callback failure fires reset(), clearing pendingProvider.
                // Retry reuses the failed channel, never the providers[0] order (BigModel).
                // startTrackedLogin clears residual store error before firing.
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
                // Failure offers more than same-channel retry; switching meant close+reopen,
                // a loop on one failing path. Waiting-cancel semantics: end this failed
                // attempt, return to the channel list, page stays open.
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
    // The logo shell is fixed-dark; theme borders weigh too heavy in light mode.
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
    // Windows: the z.ai entry stays topmost.
    // An older BigModel priority pushed a secondary entry first.
    // Display order only; provider config untouched.
    case ZAI_PROVIDER_ID:
      return 0;
    case BIGMODEL_PROVIDER_ID:
      return 1;
    default:
      return 10 + provider.order;
  }
}

export function resolveVisibleLoginProviders(providers: OAuthProviderMeta[]): OAuthProviderMeta[] {
  // Bugfix: ZAI/BigModel share one App-login truth; signed-out shows both entries.
  // The old temporary hide blocked choosing BigModel as the active provider.
  return [...providers].sort((left, right) => {
    return getProviderPriority(left) - getProviderPriority(right);
  });
}

export function resolveLoginRetryProvider({
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
