/* oxlint-disable eslint(max-lines) -- the Coding Plan webview container centralizes credential injection, purchase-complete callbacks, third-party payment navigation, and error fallbacks. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { usePlatform } from "@/hooks/usePlatform.js";
import { RENDERER_ZCODE_ENDPOINT_URLS } from "@/lib/rendererZCodeEndpoint.js";
import { logger } from "@/logger.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { EmbeddedWebsiteHeader } from "@/components/EmbeddedWebsiteHeader.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { normalizeThemePreference, resolveTheme } from "@/useTheme.js";
import type { CodingPlanProviderId } from "@/settings/model-provider-section/constants.js";
import type { CodingPlanFunnelContext } from "@/lib/codingPlanFunnelTelemetry.js";
import {
  buildCodingPlanEmbeddedWebviewUrl,
  buildCodingPlanEmbeddedReportContext,
  createCodingPlanAuthInjectionScript,
  createCodingPlanCredentialClearScript,
  createCodingPlanLangInjectionScript,
  createCodingPlanScrollbarHideScript,
  getCodingPlanCredentialKeys,
  isTrustedCodingPlanEmbeddedWebviewUrl,
  resolveCodingPlanEmbeddedOrigin,
  resolveCodingPlanWebsiteProvider,
  type CodingPlanEmbeddedCredentials,
  type CodingPlanEmbeddedTheme,
  type CodingPlanPurchaseAudience,
  CODING_PLAN_WEBVIEW_OVERRIDE_ENV_KEY,
} from "@/settings/model-provider-section/codingPlanEmbeddedWebview.js";
import {
  CodingPlanWebviewChannels,
  type CodingPlanPurchaseCompletePayload,
  ZCODE_ENV,
  ZCODE_VERSION,
} from "@zcode/shared";

interface CodingPlanEmbeddedWebviewDialogProps {
  credentialService: {
    load(key: string): Promise<string | null>;
  };
  onOpenChange: (open: boolean) => void;
  open: boolean;
  onOpenResult?: (opened: boolean) => void;
  providerId: CodingPlanProviderId;
  funnelContext?: CodingPlanFunnelContext | null;
  audience?: CodingPlanPurchaseAudience;
  teamPlanKey?: string | null;
  /**
   * Callback after a successful purchase on the official site.
   *
   * The page sends a zcode:coding-plan-purchase-complete channel message via the preload-injected
   * window.zcodeBridge.notifyPurchaseComplete({ provider}); this component recognizes that channel
   * in the webview's ipc-message event and invokes this callback (via onPurchaseCompleteRef to avoid
   * a stale closure). The parent (CodingPlanUpgradeDialog) refreshes entitlements/providers here and
   * closes the webview.
   */
  onPurchaseComplete?: () => void;
}

interface CodingPlanWebviewImportMetaEnv {
  DEV?: boolean;
  VITE_CODING_PLAN_WEBVIEW_ORIGIN?: string;
  VITE_ZCODE_E2E_STORE_BRIDGE?: string;
}

interface CodingPlanWebviewNavigationState {
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
}

function readCodingPlanWebviewImportMetaEnv(): CodingPlanWebviewImportMetaEnv {
  return ((import.meta as ImportMeta & { env?: CodingPlanWebviewImportMetaEnv }).env ??
    {}) as CodingPlanWebviewImportMetaEnv;
}

export function CodingPlanEmbeddedWebviewDialog({
  credentialService,
  onOpenChange,
  open,
  providerId,
  funnelContext,
  audience,
  teamPlanKey,
  onPurchaseComplete,
  onOpenResult,
}: CodingPlanEmbeddedWebviewDialogProps) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const theme = useZCodeStoreWithDefault((state) => state.theme, "zai-dark");
  const userId = useZCodeStoreWithDefault((state) => state.user?.id ?? null, null);
  const webviewRef = useRef<ElectronWebviewTag | null>(null);
  const onOpenResultRef = useRef(onOpenResult);
  onOpenResultRef.current = onOpenResult;
  // Current locale as the webview language hint / injected value; Locale is isomorphic to CodingPlanWebviewLocale.
  const webviewLocale = locale;
  const webviewCleanupRef = useRef<(() => void) | null>(null);
  // Whether the webview is dom-ready: executeJavaScript runs only after ready,
  // otherwise it throws "WebView must be attached to the DOM and dom-ready emitted".
  const webviewReadyRef = useRef(false);
  const frozenWebviewUrlRef = useRef<string | null>(null);
  const injectAuthRef = useRef<(webview: ElectronWebviewTag | null) => Promise<void>>(
    async () => {},
  );
  // onPurchaseComplete is read through a ref inside the ref callback / event listeners to avoid a
  // stale closure (handleWebviewRef uses useCallback([],) and binds events once, never depending
  // on the latest onPurchaseComplete).
  const onPurchaseCompleteRef = useRef<(() => void) | undefined>(onPurchaseComplete);
  useEffect(() => {
    onPurchaseCompleteRef.current = onPurchaseComplete;
  }, [onPurchaseComplete]);
  const [authError, setAuthError] = useState<string | null>(null);
  // loadError: fallback state for webview load failure/crash.
  // Per product decision, an unavailable webview only reports the error and points to the official
  // site for purchase; no fallback to the legacy dialog.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [navigationState, setNavigationState] = useState<CodingPlanWebviewNavigationState>({
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
  });
  const provider = resolveCodingPlanWebsiteProvider(providerId);
  const embeddedTheme: CodingPlanEmbeddedTheme =
    normalizeThemePreference(theme) === "zai-dark" || resolveTheme(theme) === "dark"
      ? "zai-dark"
      : "zai-light";
  const computedWebviewUrl = useMemo(() => {
    const env = readCodingPlanWebviewImportMetaEnv();
    const origin = resolveCodingPlanEmbeddedOrigin({
      dev: env.DEV === true,
      endpointOrigin: RENDERER_ZCODE_ENDPOINT_URLS.origin,
      e2eStoreBridgeEnabled: env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
      overrideOrigin: env.VITE_CODING_PLAN_WEBVIEW_ORIGIN,
      zcodeEnv: ZCODE_ENV,
    });
    // The ?lang= hint gives the official site the right language on first paint, avoiding an English flash before injection.
    // The ?theme= hint is sent too, preventing a first-frame flash of the site's SSR dark default under a light app theme.
    return buildCodingPlanEmbeddedWebviewUrl({
      origin,
      provider,
      locale: webviewLocale,
      theme: embeddedTheme,
      audience,
      teamPlanKey,
    });
  }, [audience, embeddedTheme, provider, teamPlanKey, webviewLocale]);
  if (open && frozenWebviewUrlRef.current === null) {
    // theme=system follows the OS; if src changed with it, an in-progress PayPal authorization page would reload.
    // One dialog open lifecycle pins the first-frame hint; runtime theme still reaches the site via the auth injection script.
    frozenWebviewUrlRef.current = computedWebviewUrl;
  } else if (!open && frozenWebviewUrlRef.current !== null) {
    frozenWebviewUrlRef.current = null;
  }
  const webviewUrl = frozenWebviewUrlRef.current ?? computedWebviewUrl;

  const injectAuth = useCallback(
    async (webview: ElectronWebviewTag | null = webviewRef.current) => {
      if (!webview) {
        return;
      }
      setAuthError(null);
      try {
        const env = readCodingPlanWebviewImportMetaEnv();
        const currentUrl = typeof webview.getURL === "function" ? webview.getURL() : "";
        if (
          !isTrustedCodingPlanEmbeddedWebviewUrl(currentUrl, {
            e2eStoreBridgeEnabled: env.VITE_ZCODE_E2E_STORE_BRIDGE === "1",
          })
        ) {
          // dom-ready fires again on later main-frame navigations; a trusted initial src does not
          // mean the current page is still the official purchase page. Off the trusted origin, only
          // same-origin cleanup is allowed, never App credential injection.
          await webview.executeJavaScript(createCodingPlanCredentialClearScript(), true);
          return;
        }
        const keys = getCodingPlanCredentialKeys(provider);
        const [values, deviceMid] = await Promise.all([
          Promise.all(keys.map((key) => credentialService.load(key))),
          Promise.resolve()
            .then(() => platform.getDeviceId())
            .catch(() => null),
        ]);
        const credentials: CodingPlanEmbeddedCredentials =
          provider === "zai"
            ? {
                zaiAccessToken: values[0],
                zcodeJwtToken: values[1],
              }
            : {
                bigmodelAccessToken: values[0],
                // The BigModel OAuth callback also persists the zcode JWT; the site uses it on the
                // zcode-plan origin to query billing/balance for Start Plan state.
                zcodeJwtToken: values[1],
              };
        const reportContext = buildCodingPlanEmbeddedReportContext({
          funnelContext,
          deviceMid,
          userId,
          appVersion: ZCODE_VERSION,
        });
        const script = createCodingPlanAuthInjectionScript({
          provider,
          credentials,
          theme: embeddedTheme,
          locale: webviewLocale,
          reportContext,
        });
        // The webview uses a persistent partition; on provider/account switches, stale tokens must not
        // linger in localStorage where the site's first-paint logic would read them. Clear sensitive
        // keys before writing the current credentials.
        await webview.executeJavaScript(
          `${createCodingPlanCredentialClearScript()};\n${script}`,
          true,
        );
      } catch (error) {
        // The webview and the App renderer use separate storage partitions; the site cannot read the
        // App credentialService directly. Injection failure must surface a retryable state, otherwise
        // the page stays signed-out/skeleton with no way to recover.
        setAuthError(error instanceof Error ? error.message : String(error));
        logger.warn("[CodingPlanEmbeddedWebviewDialog] Failed to inject purchase credentials", {
          provider,
          error,
        });
      }
    },
    [credentialService, embeddedTheme, funnelContext, platform, provider, userId, webviewLocale],
  );

  // When the App locale changes at runtime, inject the lang update script into a dom-ready webview so
  // the site switches languages seamlessly (a webviewUrl change reloads the whole page; this handles
  // "locale changed within the same page").
  // Skip while the webview is not dom-ready: the post-dom-ready auth injection script already carries
  // the latest locale, so no earlier injection is needed (an early executeJavaScript throws
  // attach/dom-ready errors).
  useEffect(() => {
    if (!open) return;
    if (!webviewReadyRef.current) return;
    const webview = webviewRef.current;
    if (!webview) return;
    const script = createCodingPlanLangInjectionScript(webviewLocale);
    void webview.executeJavaScript(script, true).catch(() => {
      // executeJavaScript rejects once the webview is destroyed; silence is fine.
    });
  }, [open, webviewLocale]);

  useEffect(() => {
    injectAuthRef.current = injectAuth;
  }, [injectAuth]);

  const syncNavigationState = useCallback((webview: ElectronWebviewTag | null) => {
    if (!webview) {
      setNavigationState({
        canGoBack: false,
        canGoForward: false,
        isLoading: false,
      });
      return;
    }
    try {
      setNavigationState((current) => ({
        ...current,
        canGoBack: webview.canGoBack(),
        canGoForward: webview.canGoForward(),
      }));
    } catch (error) {
      // During third-party payment navigation churn the webview may be briefly detached.
      // The nav buttons are auxiliary; a sync failure must not disturb the payment flow.
      logger.debug("[CodingPlanEmbeddedWebviewDialog] Failed to sync webview navigation state", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const handleGoBack = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview || !navigationState.canGoBack) return;
    webview.goBack();
    syncNavigationState(webview);
  }, [navigationState.canGoBack, syncNavigationState]);

  const handleGoForward = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview || !navigationState.canGoForward) return;
    webview.goForward();
    syncNavigationState(webview);
  }, [navigationState.canGoForward, syncNavigationState]);

  const handleReloadWebview = useCallback(() => {
    webviewRef.current?.reload();
  }, []);

  const handleWebviewRef = useCallback(
    (element: ElectronWebviewTag | null) => {
      webviewCleanupRef.current?.();
      webviewCleanupRef.current = null;
      webviewRef.current = element;
      if (!element) {
        webviewReadyRef.current = false;
        setNavigationState({
          canGoBack: false,
          canGoForward: false,
          isLoading: false,
        });
        return;
      }
      const handleDomReady = () => {
        // Mark ready, allowing later executeJavaScript injections on locale changes.
        webviewReadyRef.current = true;
        syncNavigationState(element);
        // The official site and payment pages inherit their own native scrollbars, which look jarring
        // next to the chromeless webview shell; hide the scrollbar without disabling page scrolling.
        void element
          .executeJavaScript(createCodingPlanScrollbarHideScript(), true)
          .catch((error) => {
            logger.debug("[CodingPlanEmbeddedWebviewDialog] Failed to hide webview scrollbars", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        void injectAuthRef.current(element);
        onOpenResultRef.current?.(true);
      };
      const handleDidStartLoading = () => {
        // New navigation started: reset ready so executeJavaScript never runs against an unready page.
        webviewReadyRef.current = false;
        setAuthError(null);
        setLoadError(null);
        setNavigationState((current) => ({ ...current, isLoading: true }));
      };
      const handleDidStopLoading = () => {
        setNavigationState((current) => ({ ...current, isLoading: false }));
        syncNavigationState(element);
      };
      const handleNavigation = () => {
        syncNavigationState(element);
      };
      // did-fail-load: main frame failed to load (network loss, DNS failure, connection refused, etc.).
      // Report main-frame failures only, so child resource failures do not error the whole webview.
      const handleDidFailLoad = (event: ElectronWebviewDidFailLoadEvent) => {
        if (!event.isMainFrame) {
          return;
        }
        const description = event.errorDescription || String(event.errorCode);
        logger.warn("[CodingPlanEmbeddedWebviewDialog] webview failed to load", {
          provider,
          errorCode: event.errorCode,
          errorDescription: event.errorDescription,
          validatedURL: event.validatedURL,
        });
        setLoadError(description);
        onOpenResultRef.current?.(false);
        setNavigationState((current) => ({ ...current, isLoading: false }));
      };
      // render-process-gone: renderer crashed/OOM/killed; the webview is unrecoverable, enter the error state too.
      const handleRenderProcessGone = (event: ElectronWebviewRenderProcessGoneEvent) => {
        logger.warn("[CodingPlanEmbeddedWebviewDialog] webview renderer process gone", {
          provider,
          reason: event.details.reason,
          exitCode: event.details.exitCode,
        });
        setLoadError(event.details.reason);
        onOpenResultRef.current?.(false);
      };
      // ipc-message: the official site reports purchase completion (zcode:coding-plan-purchase-complete)
      // via the preload's window.zcodeBridge.notifyPurchaseComplete.
      // Follows the ipc-message handler pattern of useEmbeddedBrowserWheelChain.ts.
      const handleIpcMessage = (event: ElectronWebviewIpcMessageEvent) => {
        if (event.channel !== CodingPlanWebviewChannels.PurchaseComplete) {
          return;
        }
        const raw = event.args[0] as CodingPlanPurchaseCompletePayload | undefined;
        if (raw?.provider !== "zai" && raw?.provider !== "bigmodel") {
          // Invalid payload: ignore, so forged or dirty data cannot trigger a refresh.
          logger.warn("[CodingPlanEmbeddedWebviewDialog] Received invalid purchase-complete payload", {
            channel: event.channel,
            args: event.args,
          });
          return;
        }
        logger.info("[CodingPlanEmbeddedWebviewDialog] Purchase-complete received from official site; triggering refresh", {
          provider: raw.provider,
          timestamp: raw.timestamp,
        });
        onPurchaseCompleteRef.current?.();
      };

      element.addEventListener("dom-ready", handleDomReady);
      element.addEventListener("did-start-loading", handleDidStartLoading);
      element.addEventListener("did-stop-loading", handleDidStopLoading);
      element.addEventListener("did-navigate", handleNavigation);
      element.addEventListener("did-navigate-in-page", handleNavigation);
      element.addEventListener("did-fail-load", handleDidFailLoad);
      element.addEventListener("render-process-gone", handleRenderProcessGone);
      element.addEventListener("ipc-message", handleIpcMessage);
      // React effect binding can land after the <webview>'s first dom-ready.
      // Binding the Electron events at ref mount guarantees executeJavaScript only ever runs post-dom-ready.
      webviewCleanupRef.current = () => {
        webviewReadyRef.current = false;
        element.removeEventListener("dom-ready", handleDomReady);
        element.removeEventListener("did-start-loading", handleDidStartLoading);
        element.removeEventListener("did-stop-loading", handleDidStopLoading);
        element.removeEventListener("did-navigate", handleNavigation);
        element.removeEventListener("did-navigate-in-page", handleNavigation);
        element.removeEventListener("did-fail-load", handleDidFailLoad);
        element.removeEventListener("render-process-gone", handleRenderProcessGone);
        element.removeEventListener("ipc-message", handleIpcMessage);
      };
    },
    [syncNavigationState],
  );

  useEffect(() => {
    return () => {
      const webview = webviewRef.current;
      if (webviewReadyRef.current && webview) {
        // On close, proactively clear the credential keys in the persistent partition to shrink the cross-account residue window.
        void webview.executeJavaScript(createCodingPlanCredentialClearScript(), true).catch(() => {
          // The webview may already be destroyed; the main-process clear-all-data cleans the partition as a backstop.
        });
      }
      webviewCleanupRef.current?.();
      webviewCleanupRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (open) {
      setAuthError(null);
      setLoadError(null);
      setNavigationState({
        canGoBack: false,
        canGoForward: false,
        isLoading: false,
      });
    }
  }, [open, webviewUrl]);

  // Open the official purchase page: when the webview is unavailable, guide the user to purchase there directly.
  const handleOpenWebsite = useCallback(() => {
    platform.openExternal(webviewUrl);
  }, [platform, webviewUrl]);

  if (!open) {
    return null;
  }

  const pageContentWidthClass = "max-w-5xl";

  return (
    <section
      data-testid="coding-plan-upgrade-surface"
      className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background pt-12 text-foreground"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <EmbeddedWebsiteHeader
          title={intl.formatMessage({ id: "settings.modelProvider.codingPlan.webview.title" })}
          loading={navigationState.isLoading}
          canGoBack={navigationState.canGoBack}
          canGoForward={navigationState.canGoForward}
          onBack={handleGoBack}
          onForward={handleGoForward}
          onReload={handleReloadWebview}
          onClose={() => onOpenChange(false)}
        />

        <main
          className={cn(
            "mx-auto flex w-full flex-1 flex-col px-6 pt-2 pb-8 max-sm:px-4 max-sm:pt-2 max-sm:pb-5",
            pageContentWidthClass,
          )}
        >
          {authError ? (
            <div className="mb-3 flex items-center justify-between gap-3 rounded-xl border border-border bg-surface p-3 text-ui-base text-foreground-subtle">
              <span>
                {intl.formatMessage({
                  id: "settings.modelProvider.codingPlan.webview.authInjectFailed",
                })}
              </span>
              <Button size="sm" variant="outline" onClick={() => void injectAuth()}>
                <RefreshCwIcon className="size-3.5" />
                {intl.formatMessage({
                  id: "settings.modelProvider.codingPlan.webview.retry",
                })}
              </Button>
            </div>
          ) : null}
          {loadError ? (
            <div
              className="mb-3 flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 text-ui-base text-foreground-subtle"
              data-testid="coding-plan-embedded-webview-load-error"
            >
              <span className="font-medium text-foreground">
                {intl.formatMessage({
                  id: "settings.modelProvider.codingPlan.webview.loadFailed",
                })}
              </span>
              <span className="text-ui-sm text-foreground-subtle">{loadError}</span>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={handleOpenWebsite}>
                  <ExternalLinkIcon className="size-3.5" />
                  {intl.formatMessage({
                    id: "settings.modelProvider.codingPlan.webview.openWebsite",
                  })}
                </Button>
                <Button size="sm" variant="ghost" onClick={handleReloadWebview}>
                  <RefreshCwIcon className="size-3.5" />
                  {intl.formatMessage({
                    id: "settings.modelProvider.codingPlan.webview.retry",
                  })}
                </Button>
              </div>
            </div>
          ) : null}
          <webview
            ref={handleWebviewRef}
            allowpopups={"" as unknown as boolean}
            partition="persist:zcode-coding-plan"
            src={webviewUrl}
            className={cn(
              "min-h-0 flex-1 bg-background [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              loadError && "hidden",
            )}
            data-testid="coding-plan-embedded-webview"
          />
        </main>
      </div>
    </section>
  );
}

export { CODING_PLAN_WEBVIEW_OVERRIDE_ENV_KEY };
