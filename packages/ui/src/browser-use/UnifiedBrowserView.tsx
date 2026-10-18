/* oxlint-disable eslint(max-lines) -- UnifiedBrowserView centralizes navigation, events and guest lifecycle for the stable webview; the horizontal-scroll chain moved to its own hook. */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type {
  BrowserViewScreenshotSurfacePreparePayload,
  EmbeddedBrowserViewportPreference,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWebElementPicker } from "@/hooks/useWebElementPicker.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { BrowserToolbar } from "@/EmbeddedBrowserPaneParts.js";
import { BrowserViewportSurface } from "@/browser-use/BrowserViewportSurface.js";
import { BrowserViewportToolbar } from "@/browser-use/BrowserViewportToolbar.js";
import { useBrowserResizeOperationWarning } from "@/browser-use/useBrowserResizeOperationWarning.js";
import { useBrowserScreenshotSurfaceReady } from "@/browser-use/useBrowserScreenshotSurfaceReady.js";
import { useEmbeddedBrowserWheelChain } from "@/browser-use/useEmbeddedBrowserWheelChain.js";
import { useDesktopZoomFactor } from "@/browser-use/useDesktopZoomFactor.js";
import { useResponsiveBrowserViewportControl } from "@/browser-use/useResponsiveBrowserViewportControl.js";
import type { HumanBrowserViewportPreferenceChangeSource } from "@/browser-use/useResponsiveBrowserViewportControl.js";
import {
  DEFAULT_BROWSER_URL,
  INITIAL_BROWSER_STATE,
  displayBrowserUrl,
  isDefaultBrowserOpenableUrl,
  isRecoverableBrowserGuestExitReason,
  normalizeBrowserUrl,
  safeWebviewCall,
  type BrowserState,
} from "@/embeddedBrowserHelpers.js";

type PendingGuestNavigationCompletion = {
  resolve: () => void;
  url: string;
};

/**
 * UnifiedBrowserView - the unified browser view (`<webview>` + CDP-on-guest architecture).
 *
 * Page pixels are rendered by the `<webview>` guest inside the renderer (composited in-DOM, coverable by DOM overlays,
 * fully solving WebContentsView native layers covering menus). Human navigation/back-forward/refresh/element-picking
 * call webview methods directly (low latency, no handshake); chrome state is driven by webview events.
 *
 * On did-attach the guest webContentsId is reported to main (browserViewAttachGuest) so
 * main can attach CDP (webContents.debugger) and the agent can control this tab via the protocol.
 *
 * Chrome reuses the EmbeddedBrowserPaneParts BrowserToolbar;
 * URL normalization / unmounted fallback reuse embeddedBrowserHelpers.
 */
export function UnifiedBrowserView({
  browserKey,
  isResidencyRestore = false,
  isVisible,
  isSelected = isVisible,
  isCurrentTask = isSelected,
  initialUrl,
  faviconUrl,
  navigationRequest,
  onUrlChange,
  onPageMetadataChange,
  onNavigationRequestHandled,
  workspacePath,
  workspaceIdentity,
  workspaceKey,
  remoteSessionId,
  sessionId,
  residencyGeneration,
  browserUseOperationUntil,
  browserResizeBaselineVersion,
  screenshotSurfaceRequest,
  deferEmptyGuest = false,
  initialHumanViewportPreference,
  onHumanViewportPreferenceChange,
}: {
  /** Controlled view key (= tab.id / sessionId; how the agent addresses this tab). */
  browserKey: string;
  /** On budget restore, revoke the bootstrap src right after guest creation; the first real navigation belongs to main. */
  isResidencyRestore?: boolean;
  /** Whether the pane is visible (active + expanded). Hiding removes it from the layout only, never unmounts the webview, keeping page and history. */
  isVisible: boolean;
  /** Tab-strip selection is orthogonal to panel visibility; collapsed still keeps selected. */
  isSelected?: boolean;
  /** This task tab, used for the main-side eviction tier. */
  isCurrentTask?: boolean;
  /** Initial/restored URL navigated on mount (human tab restore). */
  initialUrl?: string | null;
  /** Current tab-shell favicon; persisted with residency reports. */
  faviconUrl?: string | null;
  /** External request to navigate this tab to a URL ({id,url}); acknowledged via onNavigationRequestHandled. */
  navigationRequest?: { id: string; url: string } | null;
  /** URL change reports (human tab URL persistence). */
  onUrlChange?: (url: string) => void;
  /** Page title/favicon change reports (drives the tab label). */
  onPageMetadataChange?: (metadata: { title?: string; faviconUrl?: string | null }) => void;
  /** Acknowledgment after navigationRequest is consumed. */
  onNavigationRequestHandled?: (requestId: string) => void;
  /** Workspace path needed to add the element selection to chat (human branch; optional for agent). */
  workspacePath?: string;
  /** Workspace identity owning the element-pick context (human branch). */
  workspaceIdentity?: string;
  /** Identity scope frozen at browser-use tab creation; when present it wins over ambient workspace props. */
  workspaceKey?: string;
  remoteSessionId?: string;
  /** Conversation ownership frozen at tab creation; never backfilled from the active task at dom-ready. */
  sessionId?: string;
  residencyGeneration?: number;
  /** Operation deadline shared with the tab cursor icon; passed for browser-use tabs only. */
  browserUseOperationUntil?: number;
  browserResizeBaselineVersion?: number;
  /** Temporarily keep a background guest real layout for screenshots; never changes active/focus semantics. */
  screenshotSurfaceRequest?: BrowserViewScreenshotSurfacePreparePayload | null;
  /** Human blank tabs defer guest creation; agent/browser-use must keep creation-time attach. */
  deferEmptyGuest?: boolean;
  /** Passed by the human browser surface only; Agent Browser Use must keep it undefined. */
  initialHumanViewportPreference?: EmbeddedBrowserViewportPreference;
  /** Only human-initiated UI changes flow here; Agent viewport events must not call it. */
  onHumanViewportPreferenceChange?: (
    preference: EmbeddedBrowserViewportPreference,
    source: HumanBrowserViewportPreferenceChangeSource,
  ) => void;
}): React.JSX.Element {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const desktopZoomFactor = useDesktopZoomFactor();

  const [addressValue, setAddressValue] = useState("");
  const [browserState, setBrowserState] = useState<BrowserState>(INITIAL_BROWSER_STATE);
  const hasInitialNavigation = Boolean(initialUrl && initialUrl !== DEFAULT_BROWSER_URL);
  const [hasNavigated, setHasNavigated] = useState(hasInitialNavigation);
  const [webviewGeneration, setWebviewGeneration] = useState(0);
  const [webview, setWebview] = useState<ElectronWebviewTag | null>(null);
  const [guestAttachRetryNonce, setGuestAttachRetryNonce] = useState(0);
  useBrowserScreenshotSurfaceReady({
    request: screenshotSurfaceRequest ?? null,
    webview,
  });
  const shouldComposeSurface = Boolean(screenshotSurfaceRequest);
  const setGuestZoomFactor = useCallback((target: ElectronWebviewTag, targetZoomFactor: number) => {
    if (typeof target.setZoomFactor !== "function") return;
    safeWebviewCall(
      () => target.setZoomFactor(targetZoomFactor),
      undefined,
      (error) => {
        logger.debug("[browser-use] Skipping zoom sync for a webview that is not ready", {
          error: error instanceof Error ? error.message : String(error),
          targetZoomFactor,
        });
      },
    );
  }, []);
  const normalizeResponsiveGuestZoom = useCallback(() => {
    if (webview) setGuestZoomFactor(webview, 1);
  }, [setGuestZoomFactor, webview]);
  const {
    browserRegionRef,
    notifyBrowserViewportResize,
    prepareForAgentViewportChange,
    showResizeWarning,
  } = useBrowserResizeOperationWarning({
    browserKey,
    isVisible,
    operationUntil: browserUseOperationUntil,
    resizeBaselineVersion: browserResizeBaselineVersion,
  });
  const {
    isResponsiveMode,
    responsiveViewportSize,
    responsiveViewportZoom,
    setResponsiveViewportZoom,
    synchronizeInitialHumanViewport,
    toggleResponsiveMode,
    updateResponsiveViewportSize,
  } = useResponsiveBrowserViewportControl({
    browserKey,
    desktopZoomFactor,
    onAgentViewportChange: prepareForAgentViewportChange,
    onViewportSynchronized: normalizeResponsiveGuestZoom,
    onViewportResize: notifyBrowserViewportResize,
    initialHumanViewportPreference,
    onHumanViewportPreferenceChange,
    sessionId,
  });
  // MediaRecorder captures the WebView surface actually composited in the renderer. With the user Fit/50%
  // preview, the canvas could only upscale the low-res source. The recording lease therefore derives a 100% surface,
  // without touching the user free size, zoom choice or persisted state; React restores the preview after release.
  const forceUnscaledSurface = screenshotSurfaceRequest?.surfaceScaleMode === "unscaled";
  // A background tab fallback viewport can exceed the window; Fit alone does not engage the layout and
  // the webview can never become ready once shrunk under the placeholder. During screenshots, derive a request-sized responsive layout,
  // restore the user mode and size on release, write no preference and recreate no guest.
  const effectiveIsResponsiveMode = isResponsiveMode || Boolean(screenshotSurfaceRequest);
  const effectiveViewportSize = screenshotSurfaceRequest?.viewport ?? responsiveViewportSize;
  // Plain screenshots only change the layout temporarily; fallback-metrics guest zoom is managed by main.
  // Treating the temporary Fit as a user mode switch would wrongly restore desktop zoom on release, breaking later CDP coordinates.
  const shouldNormalizeGuestZoom = isResponsiveMode || forceUnscaledSurface;
  // Fixed 100%/200% previews do not shrink with the screenshot canvas; on Windows high-DPI the guest raster
  // can still be clipped to the host-visible area. Plain screenshots use temporary Fit and restore on release; recording stays unscaled.
  const effectiveViewportZoom = forceUnscaledSurface
    ? "100"
    : screenshotSurfaceRequest
      ? "fit"
      : responsiveViewportZoom;
  useEmbeddedBrowserWheelChain({
    browserRegionRef,
    isResponsiveMode: effectiveIsResponsiveMode,
    webview,
  });

  // Navigation URLs queued before dom-ready; loadURL them once ready (webview src only applies on first mount).
  const pendingUrlRef = useRef<string | null>(null);
  const lastRequestedUrlRef = useRef<string | null>(null);
  // Already-consumed initialUrl / navigationRequest, preventing duplicate navigation.
  const lastAppliedInitialUrlRef = useRef<string | null>(null);
  const lastHandledNavigationRequestIdRef = useRef<string | null>(null);
  const lastRestorableUrlRef = useRef<string | null>(
    initialUrl && initialUrl !== DEFAULT_BROWSER_URL ? initialUrl : null,
  );
  const guestRecoveryInProgressRef = useRef(false);
  // When a failed guest receives an external navigation, the acknowledgment must wait until the replacement guest actually takes over the loadURL.
  const pendingGuestNavigationCompletionRef = useRef<PendingGuestNavigationCompletion | null>(null);
  // guestId report dedup: did-attach and dom-ready fire back-to-back; re-report only on guest or active state change.
  const lastReportedGuestRef = useRef<{
    active: boolean;
    webContentsId: number;
    scopeFingerprint: string;
  } | null>(null);
  const wasResponsiveModeRef = useRef(false);
  // Guest-destruction attribution probe: before the production main-process UAF (EXC_BAD_ACCESS at
  // 0x10, a DevToolsSession in-flight notification touching a freed client), main logs only showed
  // "cdp still attached on destroyed guest", with no way to tell who unmounted the webview node:
  // residency shell swap / whole-parent-tree unmount / shouldMountWebview flip / generation bump.
  // ref(null) is the first scene of React unmounting the <webview> node; combined with the unmount probe
  // and pending-shell ack logs it pins down the destroyer and the ordering. Logged only once the webview existed; volume matches the tab lifecycle.
  const webviewTeardownProbeRef = useRef({
    browserKey: "",
    generation: 0,
    hasNavigated: hasInitialNavigation,
    hadWebview: false,
  });
  webviewTeardownProbeRef.current.browserKey = browserKey;
  webviewTeardownProbeRef.current.generation = webviewGeneration;
  webviewTeardownProbeRef.current.hasNavigated = hasNavigated;
  const logWebviewTeardown = useCallback((trigger: string) => {
    const probe = webviewTeardownProbeRef.current;
    logger.info("[browser-use] webview node left the DOM (guest will be destroyed)", {
      browserKey: probe.browserKey,
      generation: probe.generation,
      guestReported: lastReportedGuestRef.current,
      hasNavigated: probe.hasNavigated,
      trigger,
    });
  }, []);
  const onPageMetadataChangeRef = useRef(onPageMetadataChange);
  onPageMetadataChangeRef.current = onPageMetadataChange;
  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;

  const completePendingGuestNavigation = useCallback(
    (completion?: PendingGuestNavigationCompletion | null) => {
      const pendingCompletion =
        completion === undefined ? pendingGuestNavigationCompletionRef.current : completion;
      if (!pendingCompletion || pendingGuestNavigationCompletionRef.current !== pendingCompletion) {
        return;
      }
      pendingGuestNavigationCompletionRef.current = null;
      pendingCompletion.resolve();
    },
    [],
  );

  const waitForGuestNavigationTakeover = useCallback((url: string) => {
    // One view holds a single external navigation intent; if a future entry allows concurrency, a new request explicitly supersedes
    // the old one and settles the old acknowledgment first, so the overwritten Promise never dangles.
    const replacedCompletion = pendingGuestNavigationCompletionRef.current;
    pendingGuestNavigationCompletionRef.current = null;
    replacedCompletion?.resolve();
    return new Promise<void>((resolve) => {
      pendingGuestNavigationCompletionRef.current = { resolve, url };
    });
  }, []);

  useEffect(
    () => () => {
      // Closing the view is an explicit cancel; the upstream navigationRequest must not wait forever.
      completePendingGuestNavigation();
    },
    [completePendingGuestNavigation],
  );

  useEffect(
    () => () => {
      // Unmount means the <webview> inevitably leaves the DOM: residency shell swap / parent panel close /
      // whole-tree remount on session switch. The delta vs the ref-null probe separates a generation rebuild from a real unmount.
      if (webviewTeardownProbeRef.current.hadWebview || lastReportedGuestRef.current) {
        webviewTeardownProbeRef.current.hadWebview = false;
        logWebviewTeardown("component-unmount");
      }
    },
    [logWebviewTeardown],
  );

  const reportBrowserGuest = useCallback(
    (active: boolean) => {
      if (!webview) return;
      if (typeof webview.getWebContentsId !== "function") return;
      const webContentsId = safeWebviewCall(() => webview.getWebContentsId(), 0);
      if (webContentsId <= 0) return;
      const effectiveWorkspaceKey = workspaceKey ?? (workspaceIdentity?.trim() || workspacePath);
      const scopeFingerprint = JSON.stringify({
        active,
        webContentsId,
        workspaceKey: effectiveWorkspaceKey ?? "",
        remoteSessionId: remoteSessionId ?? "",
        sessionId: sessionId ?? "",
        residencyGeneration: residencyGeneration ?? null,
      });
      const lastReported = lastReportedGuestRef.current;
      if (lastReported?.scopeFingerprint === scopeFingerprint) {
        return;
      }
      lastReportedGuestRef.current = { active, webContentsId, scopeFingerprint };
      const attachRequest = platform.browserViewAttachGuest?.({
        key: browserKey,
        webContentsId,
        active,
        ...(effectiveWorkspaceKey ? { workspaceKey: effectiveWorkspaceKey } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(residencyGeneration === undefined ? {} : { residencyGeneration }),
      });
      if (!attachRequest) return;
      void attachRequest
        .then((result) => {
          // An old preload may still return only undefined; the successful-attach compat semantic is unchanged.
          if (!result || result.ok) {
            synchronizeInitialHumanViewport();
            return;
          }
          logger.warn("[browser-use] main rejected the guest attach; waiting for rebind by owner scope", {
            browserKey,
            reason: result.reason,
            recoveryRequested: result.recoveryRequested,
          });
          // main replays BrowserViewReady; clear the dedup mark so even the same webContentsId is reported again.
          if (result.recoveryRequested) {
            lastReportedGuestRef.current = null;
            setGuestAttachRetryNonce((current) => current + 1);
          }
        })
        .catch((error) => {
          logger.debug("[browser-use] Failed to report the guest webContentsId", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    [
      browserKey,
      platform,
      remoteSessionId,
      residencyGeneration,
      sessionId,
      synchronizeInitialHumanViewport,
      webview,
      workspaceKey,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const detachBrowserGuestBeforeReplacement = useCallback(async (): Promise<boolean> => {
    const lastReported = lastReportedGuestRef.current;
    // Until the guest is reported to main there is no native CDP session, and web exposes no such desktop capability.
    if (!lastReported || !platform.browserViewDetachGuest) return true;
    try {
      const detached = await platform.browserViewDetachGuest({
        key: browserKey,
        webContentsId: lastReported.webContentsId,
      });
      if (!detached) {
        logger.warn("[browser-use] main did not confirm the old guest CDP detach; canceling the webview rebuild", {
          browserKey,
          webContentsId: lastReported.webContentsId,
        });
      }
      return detached;
    } catch (error) {
      logger.warn("[browser-use] Failed to ask main to detach the old guest CDP; canceling the webview rebuild", {
        browserKey,
        error: error instanceof Error ? error.message : String(error),
        webContentsId: lastReported.webContentsId,
      });
      return false;
    }
  }, [browserKey, platform]);

  const {
    cancelPicking: cancelWebElementPicking,
    isPicking: isWebElementPicking,
    togglePicking: toggleWebElementPicking,
  } = useWebElementPicker({
    // Transport-agnostic outlet: <webview>.executeJavaScript(script, true) once ready;
    // null returns cancelled (a legitimate result) and stays a no-op.
    executeJs: (script) =>
      webview ? webview.executeJavaScript(script, true) : Promise.resolve({ status: "cancelled" }),
    workspacePath: workspacePath ?? "",
    workspaceIdentity: workspaceKey ?? workspaceIdentity,
  });

  // ---- Sync chrome state (url/back-forward/title) from the webview ----
  const syncBrowserState = useCallback((target: ElectronWebviewTag) => {
    // Before dom-ready / during navigation churn / mid-re-attach the guest is not attached and sync calls throw
    // "must be attached to the DOM"; route everything through safeWebviewCall so it never bubbles into window.onerror.
    const onDetached = (error: unknown) => {
      logger.debug("[browser-use] Skipping state sync for a webview that is not ready", {
        error: error instanceof Error ? error.message : String(error),
      });
    };
    const currentUrl =
      safeWebviewCall(() => target.getURL(), "", onDetached) || DEFAULT_BROWSER_URL;
    const canGoBack = safeWebviewCall(() => target.canGoBack(), false, onDetached);
    const canGoForward = safeWebviewCall(() => target.canGoForward(), false, onDetached);
    const title = safeWebviewCall(() => target.getTitle(), "", onDetached);
    if (currentUrl !== DEFAULT_BROWSER_URL) {
      lastRestorableUrlRef.current = currentUrl;
    }
    setAddressValue(displayBrowserUrl(currentUrl));
    setBrowserState((prev) => ({
      ...prev,
      canGoBack,
      canGoForward,
      currentUrl,
      isReady: true,
      title,
    }));
    onPageMetadataChangeRef.current?.({ title: title || undefined });
    // Page URLs are untrusted: display and tab persistence only, never an execution path.
    if (currentUrl !== DEFAULT_BROWSER_URL) {
      onUrlChangeRef.current?.(currentUrl);
    }
  }, []);

  // ---- webview event wiring + did-attach guestId report ----
  useEffect(() => {
    if (!webview) return;

    const handleDidAttach = () => {
      // navigationHistory.restore only works on a guest that has never loaded a page. Reporting at
      // dom-ready is too late: the default about:blank is already committed and it degrades to a URL reload; report right after attach
      // so main can restore the full Chromium pageState before the first navigation commits.
      if (isResidencyRestore) {
        // A <webview> needs src before its guest exists, but keeping the attribute re-commits
        // about:blank after attach and breaks the main history restore. Revoke the bootstrap src as soon as the guest exists.
        webview.removeAttribute("src");
      }
      reportBrowserGuest(isSelected);
    };

    const handleDomReady = () => {
      // Electron/Chromium propagate the host page zoom into the guest; compensating only the outer
      // transform still changes guest innerWidth/DPR. Free-size mode must pin the guest zoom to 1,
      // while normal mode keeps natural Electron propagation and never rewrites the page zoom.
      if (isResponsiveMode) setGuestZoomFactor(webview, 1);
      // did-attach is the earliest point for a full history restore; dom-ready stays as an Electron-version compat fallback.
      reportBrowserGuest(isSelected);

      // A <webview> src applies on first mount only; later navigation goes through imperative loadURL: consume queued URLs.
      const pending = pendingUrlRef.current;
      if (pending) {
        const pendingCompletion = pendingGuestNavigationCompletionRef.current;
        pendingUrlRef.current = null;
        setBrowserState((prev) => ({ ...prev, isReady: true }));
        void (async () => {
          try {
            await webview.loadURL(pending);
          } catch (loadError: unknown) {
            const message = loadError instanceof Error ? loadError.message : String(loadError);
            if (!message.includes("ERR_ABORTED")) {
              setBrowserState((prev) => ({
                ...prev,
                errorMessage: intl.formatMessage({ id: "browser.loadFailed" }, { message }),
                isLoading: false,
              }));
            }
          } finally {
            // Writing the external request into pendingUrl and acking is not enough: a failed guest never consumes it.
            // Only once the replacement guest reaches dom-ready and attempts one loadURL has it truly taken over the intent.
            completePendingGuestNavigation(pendingCompletion);
          }
        })();
        return;
      }
      guestRecoveryInProgressRef.current = false;
      syncBrowserState(webview);
    };

    const handleDidStartLoading = () => {
      void cancelWebElementPicking();
      setBrowserState((prev) => ({
        ...prev,
        errorMessage: null,
        loadErrorCode: null,
        isLoading: true,
      }));
    };

    const handleDidStopLoading = () => {
      guestRecoveryInProgressRef.current = false;
      setBrowserState((prev) => ({ ...prev, isLoading: false }));
      syncBrowserState(webview);
    };

    const handleNavigation = () => {
      syncBrowserState(webview);
    };

    const handleTitleUpdated = (event: ElectronWebviewTitleEvent) => {
      setBrowserState((prev) => ({ ...prev, title: event.title }));
      onPageMetadataChangeRef.current?.({ title: event.title || undefined });
    };

    const handleDidFailLoad = (event: ElectronWebviewDidFailLoadEvent) => {
      // Ignore subframe failures and -3 (ERR_ABORTED, interrupted by a later navigation).
      if (!event.isMainFrame || event.errorCode === -3) return;
      logger.warn("[browser-use] Page load failed", {
        errorCode: event.errorCode,
        errorDescription: event.errorDescription,
        url: event.validatedURL,
      });
      setBrowserState((prev) => ({
        ...prev,
        currentUrl: event.validatedURL || prev.currentUrl,
        errorMessage: intl.formatMessage(
          { id: "browser.loadFailed" },
          { message: event.errorDescription },
        ),
        loadErrorCode: event.errorCode,
        isLoading: false,
      }));
      setAddressValue(
        displayBrowserUrl(
          event.validatedURL || safeWebviewCall(() => webview.getURL(), "") || DEFAULT_BROWSER_URL,
        ),
      );
      guestRecoveryInProgressRef.current = false;
    };

    const handleRenderProcessGone = (event: ElectronWebviewRenderProcessGoneEvent) => {
      const { exitCode, reason } = event.details;
      if (!isRecoverableBrowserGuestExitReason(reason)) {
        logger.warn("[browser-use] Guest renderer crashed and cannot auto-recover", {
          browserKey,
          exitCode,
          reason,
        });
        setBrowserState((prev) => ({
          ...prev,
          errorMessage: intl.formatMessage(
            { id: "browser.loadFailed" },
            { message: `renderer ${reason} (${exitCode})` },
          ),
          // Once the renderer exits, the whole guest must be rebuilt; re-navigation alone cannot recover it.
          // guestFailure makes the UI offer the rebuild entry instead of the plain load-error retry.
          guestFailure: { exitCode, reason },
          isLoading: false,
          isReady: false,
        }));
        // If the replacement guest also fails to start, the outcome is a definite failure; settle the wait so upstream requests stop hanging.
        completePendingGuestNavigation();
        return;
      }
      if (guestRecoveryInProgressRef.current) return;

      guestRecoveryInProgressRef.current = true;
      const recoveryUrl = lastRestorableUrlRef.current;
      void cancelWebElementPicking();

      logger.warn("[browser-use] Guest renderer crashed; rebuilding in place and restoring the last URL", {
        browserKey,
        exitCode,
        reason,
        recoveryUrl,
      });
      void (async () => {
        const detached = await detachBrowserGuestBeforeReplacement();
        if (!detached) {
          guestRecoveryInProgressRef.current = false;
          setBrowserState((prev) => ({
            ...prev,
            errorMessage: null,
            loadErrorCode: null,
            guestFailure: { exitCode, reason },
            isLoading: false,
            isReady: false,
          }));
          completePendingGuestNavigation();
          return;
        }

        pendingUrlRef.current = recoveryUrl;
        lastRequestedUrlRef.current = null;
        lastAppliedInitialUrlRef.current = null;
        lastReportedGuestRef.current = null;
        setAddressValue(displayBrowserUrl(recoveryUrl ?? DEFAULT_BROWSER_URL));
        setHasNavigated(Boolean(recoveryUrl));
        setBrowserState((prev) => ({
          ...prev,
          canGoBack: false,
          canGoForward: false,
          currentUrl: recoveryUrl ?? DEFAULT_BROWSER_URL,
          errorMessage: null,
          loadErrorCode: null,
          guestFailure: null,
          isLoading: Boolean(recoveryUrl),
          isReady: false,
        }));
        // The renderer saw the guest exit, but main render-process-gone does not
        // always arrive first. Wait for the CDP detach ACK above before bumping the key; otherwise React unmounting the old
        // <webview> lets Electron DevToolsSession touch a freed client inside an in-flight notification.
        setWebviewGeneration((current) => current + 1);
      })();
    };

    webview.addEventListener("did-attach", handleDidAttach);
    webview.addEventListener("dom-ready", handleDomReady);
    webview.addEventListener("did-start-loading", handleDidStartLoading);
    webview.addEventListener("did-stop-loading", handleDidStopLoading);
    webview.addEventListener("did-navigate", handleNavigation);
    webview.addEventListener("did-navigate-in-page", handleNavigation);
    webview.addEventListener("page-title-updated", handleTitleUpdated);
    webview.addEventListener("did-fail-load", handleDidFailLoad);
    webview.addEventListener("render-process-gone", handleRenderProcessGone);

    return () => {
      webview.removeEventListener("did-attach", handleDidAttach);
      webview.removeEventListener("dom-ready", handleDomReady);
      webview.removeEventListener("did-start-loading", handleDidStartLoading);
      webview.removeEventListener("did-stop-loading", handleDidStopLoading);
      webview.removeEventListener("did-navigate", handleNavigation);
      webview.removeEventListener("did-navigate-in-page", handleNavigation);
      webview.removeEventListener("page-title-updated", handleTitleUpdated);
      webview.removeEventListener("did-fail-load", handleDidFailLoad);
      webview.removeEventListener("render-process-gone", handleRenderProcessGone);
    };
  }, [
    browserKey,
    cancelWebElementPicking,
    completePendingGuestNavigation,
    detachBrowserGuestBeforeReplacement,
    intl,
    isResidencyRestore,
    isSelected,
    platform,
    reportBrowserGuest,
    setGuestZoomFactor,
    syncBrowserState,
    webview,
  ]);

  useEffect(() => {
    if (!webview) return;
    const wasResponsiveMode = wasResponsiveModeRef.current;
    wasResponsiveModeRef.current = shouldNormalizeGuestZoom;

    if (shouldNormalizeGuestZoom) {
      setGuestZoomFactor(webview, 1);
    } else if (wasResponsiveMode) {
      // Restore the app zoom only when leaving free-size; normal browsing keeps natural Electron propagation.
      setGuestZoomFactor(webview, desktopZoomFactor);
    }
  }, [desktopZoomFactor, shouldNormalizeGuestZoom, setGuestZoomFactor, webview]);

  useEffect(() => {
    reportBrowserGuest(isSelected);
  }, [guestAttachRetryNonce, isSelected, reportBrowserGuest]);

  useEffect(() => {
    const effectiveWorkspaceKey = workspaceKey ?? (workspaceIdentity?.trim() || workspacePath);
    if (!effectiveWorkspaceKey || !sessionId) return;
    const restoreUrl =
      browserState.currentUrl && browserState.currentUrl !== DEFAULT_BROWSER_URL
        ? browserState.currentUrl
        : (lastRestorableUrlRef.current ?? null);
    void platform
      .browserViewReportResidency?.({
        tabId: browserKey,
        workspaceKey: effectiveWorkspaceKey,
        ...(remoteSessionId ? { remoteSessionId } : {}),
        sessionId,
        selected: isSelected,
        visible: isVisible,
        currentTask: isCurrentTask,
        loading: browserState.isLoading,
        restoreUrl,
        title: browserState.title || null,
        // A favicon must not live only in renderer tab state: once a residency report is missed,
        // suspended and cold-restored shells fall back to the globe icon.
        ...(faviconUrl === undefined ? {} : { faviconUrl }),
      })
      .catch((error) => {
        logger.debug("[browser-use] Failed to report tab residency", {
          error: error instanceof Error ? error.message : String(error),
          tabId: browserKey,
        });
      });
  }, [
    browserKey,
    browserState.currentUrl,
    browserState.isLoading,
    browserState.title,
    faviconUrl,
    isCurrentTask,
    isSelected,
    isVisible,
    platform,
    remoteSessionId,
    sessionId,
    workspaceKey,
    workspaceIdentity,
    workspacePath,
  ]);

  const rebuildBrowserGuest = useCallback(
    async (
      recoveryUrl: string | null,
      trigger: "address-navigation" | "external-navigation" | "manual-retry",
    ): Promise<boolean> => {
      guestRecoveryInProgressRef.current = true;
      void cancelWebElementPicking();

      const detached = await detachBrowserGuestBeforeReplacement();
      if (!detached) {
        guestRecoveryInProgressRef.current = false;
        return false;
      }

      pendingUrlRef.current = recoveryUrl;
      lastRequestedUrlRef.current = null;
      lastAppliedInitialUrlRef.current = null;
      lastReportedGuestRef.current = null;

      logger.warn("[browser-use] Explicit navigation triggered a rebuild of the failed guest renderer", {
        browserKey,
        recoveryUrl,
        trigger,
      });
      setAddressValue(displayBrowserUrl(recoveryUrl ?? DEFAULT_BROWSER_URL));
      setHasNavigated(Boolean(recoveryUrl));
      setBrowserState((prev) => ({
        ...prev,
        canGoBack: false,
        canGoForward: false,
        currentUrl: recoveryUrl ?? DEFAULT_BROWSER_URL,
        errorMessage: null,
        loadErrorCode: null,
        guestFailure: null,
        isLoading: Boolean(recoveryUrl),
        isReady: false,
      }));
      setWebviewGeneration((current) => current + 1);
      return true;
    },
    [browserKey, cancelWebElementPicking, detachBrowserGuestBeforeReplacement],
  );

  // ---- Navigation (human drives webview.loadURL directly; queued for dom-ready when not ready) ----
  const openUrl = useCallback(
    async (input: string, source: "toolbar" | "restore" | "request" = "toolbar") => {
      const nextUrl = normalizeBrowserUrl(input);
      if (!nextUrl) {
        setBrowserState((prev) => ({
          ...prev,
          errorMessage: intl.formatMessage({ id: "browser.invalidUrl" }),
          // An invalid address is unrelated to the previous network failure; without clearing, the error state keeps the old certificate guidance.
          loadErrorCode: null,
        }));
        return;
      }

      // An external request queued for a not-ready guest may be acked only once dom-ready actually takes over the loadURL;
      // address-bar/restored navigation has no upstream consumer and need not wait for that lifecycle signal.
      const navigationTakenOver =
        source === "request" && (!webview || !browserState.isReady)
          ? waitForGuestNavigationTakeover(nextUrl)
          : null;

      // After launch-failed, isReady=false: writing the address-bar URL into pendingUrl is not enough -
      // a dead guest never fires dom-ready again, so the failure state and the queued navigation would stick forever.
      if (browserState.guestFailure && (source === "toolbar" || source === "request")) {
        lastRestorableUrlRef.current = nextUrl;
        onUrlChange?.(nextUrl);
        const rebuilt = await rebuildBrowserGuest(
          nextUrl,
          source === "request" ? "external-navigation" : "address-navigation",
        );
        if (!rebuilt) completePendingGuestNavigation();
        if (navigationTakenOver) await navigationTakenOver;
        return;
      }

      // Dedup: an external request and a restore can land the same URL in the same tick; back-to-back loadURL triggers ERR_ABORTED(-3).
      if (
        nextUrl === lastRequestedUrlRef.current &&
        (pendingUrlRef.current === nextUrl || browserState.isLoading)
      ) {
        setAddressValue(displayBrowserUrl(nextUrl));
        setHasNavigated(true);
        if (navigationTakenOver) await navigationTakenOver;
        return;
      }

      setAddressValue(displayBrowserUrl(nextUrl));
      setHasNavigated(true);
      lastRestorableUrlRef.current = nextUrl;
      onUrlChange?.(nextUrl);
      setBrowserState((prev) => ({ ...prev, errorMessage: null, loadErrorCode: null }));
      lastRequestedUrlRef.current = nextUrl;

      if (!webview || !browserState.isReady) {
        pendingUrlRef.current = nextUrl;
        if (navigationTakenOver) await navigationTakenOver;
        return;
      }

      try {
        await webview.loadURL(nextUrl);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("ERR_ABORTED")) return;
        setBrowserState((prev) => ({
          ...prev,
          errorMessage: intl.formatMessage({ id: "browser.loadFailed" }, { message }),
          isLoading: false,
        }));
      }
    },
    [
      browserState.guestFailure,
      browserState.isLoading,
      browserState.isReady,
      completePendingGuestNavigation,
      intl,
      onUrlChange,
      rebuildBrowserGuest,
      waitForGuestNavigationTakeover,
      webview,
    ],
  );

  // ---- Navigate to the initial/restored URL on mount (human tab restore) ----
  useEffect(() => {
    if (!initialUrl || initialUrl === DEFAULT_BROWSER_URL) return;
    lastRestorableUrlRef.current = initialUrl;
    if (lastAppliedInitialUrlRef.current === initialUrl) return;
    if (browserState.currentUrl === initialUrl) {
      lastAppliedInitialUrlRef.current = initialUrl;
      setHasNavigated(true);
      setAddressValue(displayBrowserUrl(initialUrl));
      return;
    }
    lastAppliedInitialUrlRef.current = initialUrl;
    void openUrl(initialUrl, "restore");
  }, [browserState.currentUrl, initialUrl, openUrl]);

  // ---- External navigation requests ({id,url}): navigate, then acknowledge ----
  useEffect(() => {
    if (!navigationRequest) return;
    if (lastHandledNavigationRequestIdRef.current === navigationRequest.id) return;
    lastHandledNavigationRequestIdRef.current = navigationRequest.id;
    void openUrl(navigationRequest.url, "request").finally(() => {
      onNavigationRequestHandled?.(navigationRequest.id);
    });
  }, [navigationRequest, onNavigationRequestHandled, openUrl]);

  // ---- Toolbar/navigation buttons (isReady-gated + safeWebviewCall fallback for detach races at click time) ----
  const runWebviewAction = useCallback((action: () => void) => {
    safeWebviewCall(
      () => {
        action();
        return undefined;
      },
      undefined,
      (error) => {
        logger.debug("[browser-use] Skipping the action for a webview that is not ready", {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }, []);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void openUrl(addressValue);
    },
    [addressValue, openUrl],
  );

  const handleGoBack = useCallback(() => {
    if (!webview || !browserState.canGoBack) return;
    runWebviewAction(() => webview.goBack());
  }, [browserState.canGoBack, runWebviewAction, webview]);

  const handleGoForward = useCallback(() => {
    if (!webview || !browserState.canGoForward) return;
    runWebviewAction(() => webview.goForward());
  }, [browserState.canGoForward, runWebviewAction, webview]);

  const handleReload = useCallback(() => {
    if (!webview || !browserState.isReady) return;
    runWebviewAction(() => webview.reload());
  }, [browserState.isReady, runWebviewAction, webview]);

  const handleOpenDevTools = useCallback(() => {
    if (!webview || !browserState.isReady) return;
    runWebviewAction(() => webview.openDevTools());
  }, [browserState.isReady, runWebviewAction, webview]);

  const handleOpenExternal = useCallback(() => {
    if (!webview || !browserState.isReady) return;
    runWebviewAction(() => {
      const currentUrl = webview.getURL();
      // Security boundary: the system-browser entry allows only web and file URLs; inline protocols such as about/data stay forbidden.
      if (!isDefaultBrowserOpenableUrl(currentUrl)) return;
      platform.openExternal(currentUrl);
    });
  }, [browserState.isReady, platform, runWebviewAction, webview]);

  const handleTogglePicker = useCallback(() => {
    if (!webview || !browserState.isReady) return;
    void toggleWebElementPicking().catch((error: unknown) => {
      setBrowserState((prev) => ({
        ...prev,
        errorMessage: intl.formatMessage(
          { id: "browser.elementPickerFailed" },
          { message: error instanceof Error ? error.message : String(error) },
        ),
      }));
    });
  }, [browserState.isReady, intl, toggleWebElementPicking, webview]);

  const handleToggleResponsiveMode = useCallback(() => {
    toggleResponsiveMode();
  }, [toggleResponsiveMode]);

  const handleResponsiveViewportSizeChange = updateResponsiveViewportSize;

  const handleResponsiveViewportInput = useCallback(
    (viewportSize: typeof responsiveViewportSize) => {
      notifyBrowserViewportResize();
      updateResponsiveViewportSize(viewportSize);
    },
    [notifyBrowserViewportResize, updateResponsiveViewportSize],
  );

  const faviconListenerRef = useRef<{
    node: ElectronWebviewTag;
    listener: (event: ElectronWebviewFaviconEvent) => void;
  } | null>(null);
  const handleWebviewRef = useCallback(
    (node: ElectronWebviewTag | null) => {
      const current = faviconListenerRef.current;
      if (current?.node === node) return;
      if (current) {
        current.node.removeEventListener("page-favicon-updated", current.listener);
        faviconListenerRef.current = null;
      }
      if (node) {
        const listener = (event: ElectronWebviewFaviconEvent) => {
          onPageMetadataChangeRef.current?.({
            faviconUrl: event.favicons[0] ?? null,
          });
        };
        // favicon is a fire-once guest event; by the time a useEffect wires up, it may already
        // have fired between the webview ref commit and the effect run. Listening synchronously in the ref phase closes that window.
        node.addEventListener("page-favicon-updated", listener);
        faviconListenerRef.current = { node, listener };
      } else if (webviewTeardownProbeRef.current.hadWebview) {
        // A generation bump (controlled rebuild) and parent unmount both pass through here; a new node ref callback
        // right after means a rebuild, anything else a whole-tree/conditional unmount. See webviewTeardownProbeRef for the attribution probe.
        webviewTeardownProbeRef.current.hadWebview = false;
        logWebviewTeardown("ref-null");
      }
      if (node) webviewTeardownProbeRef.current.hadWebview = true;
      setWebview(node);
    },
    [logWebviewTeardown],
  );

  const handleRetryGuest = useCallback(() => {
    void rebuildBrowserGuest(lastRestorableUrlRef.current, "manual-retry");
  }, [rebuildBrowserGuest]);

  // A load failure only rejects this navigation; the guest is still alive: re-run openUrl, no rebuild needed.
  const handleRetryLoad = useCallback(() => {
    const retryUrl = lastRestorableUrlRef.current ?? browserState.currentUrl;
    if (!retryUrl) return;
    void openUrl(retryUrl, "toolbar");
  }, [browserState.currentUrl, openUrl]);

  // Once the addressValue draft counts as non-empty, merely typing without Enter
  // hides the empty state early and exposes the bare webview. The empty state keys off confirmed navigation and load/error state only.
  const isEmptyBrowserState =
    !hasNavigated && !browserState.isLoading && !browserState.errorMessage;
  const shouldMountWebview =
    !deferEmptyGuest || isResidencyRestore || hasNavigated || hasInitialNavigation;
  const prevShouldMountWebviewRef = useRef(shouldMountWebview);
  useEffect(() => {
    const previous = prevShouldMountWebviewRef.current;
    prevShouldMountWebviewRef.current = shouldMountWebview;
    if (previous && !shouldMountWebview && webviewTeardownProbeRef.current.hadWebview) {
      logWebviewTeardown("should-mount-flip");
    }
  }, [logWebviewTeardown, shouldMountWebview]);

  // display:none while inactive makes Electron keep the old compositor surface, and background screenshots tile that stale surface.
  // The flex during prepare is for compositing only; outer inert, pointer-events-none and aria-hidden isolate interaction and a11y.
  return (
    <div
      aria-hidden={!isVisible}
      data-browser-screenshot-webview-state={
        screenshotSurfaceRequest ? (webview ? "ready" : "missing") : undefined
      }
      className={cn(
        isVisible || shouldComposeSurface ? "flex" : "hidden",
        "h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background",
      )}
    >
      <BrowserToolbar
        addressValue={addressValue}
        browserState={browserState}
        formatMessage={intl.formatMessage}
        onAddressChange={setAddressValue}
        onGoBack={handleGoBack}
        onGoForward={handleGoForward}
        onOpenExternal={handleOpenExternal}
        onOpenDevTools={handleOpenDevTools}
        onPickElement={handleTogglePicker}
        onReload={handleReload}
        onToggleResponsiveMode={handleToggleResponsiveMode}
        onSubmit={handleSubmit}
        isElementPickerActive={isWebElementPicking}
        isResponsiveMode={isResponsiveMode}
      />
      {isResponsiveMode ? (
        <BrowserViewportToolbar
          isVisible={isVisible}
          onViewportSizeChange={handleResponsiveViewportInput}
          onZoomChange={setResponsiveViewportZoom}
          viewportSize={responsiveViewportSize}
          zoom={responsiveViewportZoom}
        />
      ) : null}
      <BrowserViewportSurface
        browserRegionRef={browserRegionRef}
        browserState={browserState}
        desktopZoomFactor={desktopZoomFactor}
        isResidencyRestore={isResidencyRestore}
        formatMessage={intl.formatMessage}
        isEmptyBrowserState={isEmptyBrowserState}
        isComposed={isVisible || shouldComposeSurface}
        isResponsiveMode={effectiveIsResponsiveMode}
        isViewportEmulated={
          effectiveIsResponsiveMode && screenshotSurfaceRequest?.viewportMode !== "natural"
        }
        onRetryGuest={handleRetryGuest}
        onRetryLoad={handleRetryLoad}
        onViewportResize={notifyBrowserViewportResize}
        onViewportSizeChange={handleResponsiveViewportSizeChange}
        onWebviewRef={handleWebviewRef}
        shouldMountWebview={shouldMountWebview}
        showResizeWarning={showResizeWarning}
        webviewGeneration={webviewGeneration}
        viewportSize={effectiveViewportSize}
        viewportZoom={effectiveViewportZoom}
      />
    </div>
  );
}
