/* oxlint-disable eslint(max-lines) -- UnifiedBrowserView owns stable-webview navigation, events and guest lifecycle; the horizontal-scroll chain moved to its own hook. */
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
import { BrowserSiteSettingsEntry } from "@/browser-use/BrowserSiteSettingsEntry.js";
import { BrowserToolbar } from "@/EmbeddedBrowserPaneParts.js";
import { EmbeddedBrowserPermissionPrompts } from "@/browser-use/EmbeddedBrowserPermissionPrompts.js";
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
 * UnifiedBrowserView, the unified browser view (`<webview>` plus CDP-on-guest architecture).
 *
 * Page pixels render in the renderer's own `<webview>` guest (composited in-DOM, coverable by DOM
 * overlays, ending the WebContentsView native-layer-over-menu problem). Human navigation/back/forward/
 * reload/element-pick call webview methods directly, low-latency with no handshake; chrome state follows
 * webview events.
 *
 * On did-attach the guest's webContentsId is reported to main (browserViewAttachGuest) so main can
 * attach CDP (webContents.debugger) and the agent can drive the tab over the protocol.
 *
 * Chrome reuses EmbeddedBrowserPaneParts' BrowserToolbar;
 * URL normalization and unmounted fallbacks come from embeddedBrowserHelpers.
 */
export function UnifiedBrowserView({
  browserKey,
  onOpenPermissionSettings,
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
  /** Address-bar site settings entry: opens the permission page for this site. */
  onOpenPermissionSettings?: (origin: string) => void;
  /** On budgeted restore the bootstrap src is revoked right after guest creation; the first real navigation belongs to main alone. */
  isResidencyRestore?: boolean;
  /** Pane visibility (active plus expanded). Hidden only removes it from layout, never unmounts the webview, preserving page and history. */
  isVisible: boolean;
  /** Tab-strip selection is orthogonal to panel display; collapsed keeps selected. */
  isSelected?: boolean;
  /** The active task's tab feeds main's eviction tier. */
  isCurrentTask?: boolean;
  /** Initial/restored URL navigated on mount (human tab restore). */
  initialUrl?: string | null;
  /** The tab shell's current favicon; persisted with the residency report. */
  faviconUrl?: string | null;
  /** External request to navigate this tab to a URL ({id,url}); acknowledged via onNavigationRequestHandled once consumed. */
  navigationRequest?: { id: string; url: string } | null;
  /** Current-URL changes reported up (human tab URL persistence). */
  onUrlChange?: (url: string) => void;
  /** Title/favicon changes reported up (drives the tab label). */
  onPageMetadataChange?: (metadata: { title?: string; faviconUrl?: string | null }) => void;
  /** Acknowledgement once a navigationRequest is consumed. */
  onNavigationRequestHandled?: (requestId: string) => void;
  /** Workspace path needed to add a picked element to chat (human branch; optional for agent). */
  workspacePath?: string;
  /** Workspace identity owning the element-pick context (human branch). */
  workspaceIdentity?: string;
  /** Identity scope frozen at browser-use tab creation; wins over ambient workspace props when present. */
  workspaceKey?: string;
  remoteSessionId?: string;
  /** Conversation ownership frozen at tab creation; never backfilled from the active task at dom-ready. */
  sessionId?: string;
  residencyGeneration?: number;
  /** Operation deadline shared with the tab cursor badge; browser-use tabs only. */
  browserUseOperationUntil?: number;
  browserResizeBaselineVersion?: number;
  /** Holds a background guest's real layout for the screenshot; touches no active/focus semantics. */
  screenshotSurfaceRequest?: BrowserViewScreenshotSurfacePreparePayload | null;
  /** Human blank tabs defer guest creation; agent/browser-use must attach at creation. */
  deferEmptyGuest?: boolean;
  /** Human Browser surface only; Agent Browser Use must leave undefined. */
  initialHumanViewportPreference?: EmbeddedBrowserViewportPreference;
  /** Human-initiated UI changes only; the Agent viewport event must not call this. */
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
  // Tab-ownership filter for the permission bubble: read the guest webContents id after attach/dom-ready;
  // unreadable stays undefined (the component renders requests lacking an owner id as fallback).
  const [permissionGuestWebContentsId, setPermissionGuestWebContentsId] = useState<
    number | undefined
  >(undefined);
  useEffect(() => {
    if (!webview || typeof webview.getWebContentsId !== "function") return;
    const id = safeWebviewCall(() => webview.getWebContentsId(), 0);
    setPermissionGuestWebContentsId(id > 0 ? id : undefined);
  }, [webview, browserState.isReady]);
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
        logger.debug("[browser-use] zoom sync skipped, webview not ready", {
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
  // MediaRecorder captures the WebView surface actually composited in the renderer. With the user's
  // Fit/50% preview, canvas could only upscale a low-res source. The recording lease therefore derives a
  // 100% surface without touching free-size, zoom or persisted state; React restores the preview on release.
  const forceUnscaledSurface = screenshotSurfaceRequest?.surfaceScaleMode === "unscaled";
  // A background tab's fallback viewport can exceed the window; Fit alone enables no layout and the
  // shrunken webview never readies. For the screenshot, derive a responsive layout at the requested size,
  // then restore the user's mode and size on release: no pref writes, no guest rebuild.
  const effectiveIsResponsiveMode = isResponsiveMode || Boolean(screenshotSurfaceRequest);
  const effectiveViewportSize = screenshotSurfaceRequest?.viewport ?? responsiveViewportSize;
  // A plain screenshot changes layout only; fallback-metrics guest zoom is main's business. Treating the
  // temporary Fit as a user-mode switch would restore desktop zoom on release and break later CDP coordinates.
  const shouldNormalizeGuestZoom = isResponsiveMode || forceUnscaledSurface;
  // Fixed 100%/200% previews do not shrink with the screenshot canvas, and on Windows high-DPI the guest
  // raster can still clip to the host's visible box. Plain screenshots take a temporary Fit and restore the
  // user scale on release; recording stays unscaled.
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

  // Navigation URLs queued before dom-ready; loadURL once ready (a webview src attribute only applies on first attach).
  const pendingUrlRef = useRef<string | null>(null);
  const lastRequestedUrlRef = useRef<string | null>(null);
  // Consumed initialUrl / navigationRequest, so nothing navigates twice.
  const lastAppliedInitialUrlRef = useRef<string | null>(null);
  const lastHandledNavigationRequestIdRef = useRef<string | null>(null);
  const lastRestorableUrlRef = useRef<string | null>(
    initialUrl && initialUrl !== DEFAULT_BROWSER_URL ? initialUrl : null,
  );
  const guestRecoveryInProgressRef = useRef(false);
  // When a failed guest receives an external navigation, acknowledge only once the replacement guest actually takes over the loadURL.
  const pendingGuestNavigationCompletionRef = useRef<PendingGuestNavigationCompletion | null>(null);
  // guestId report dedup: did-attach and dom-ready fire back to back; re-report only on guest or active change.
  const lastReportedGuestRef = useRef<{
    active: boolean;
    webContentsId: number;
    scopeFingerprint: string;
  } | null>(null);
  const wasResponsiveModeRef = useRef(false);
  // Guest-teardown attribution: before the field UAF (EXC_BAD_ACCESS at 0x10, DevToolsSession touching a
  // freed client mid-notification), main logs only cdp-still-attached-on-destroyed-guest and cannot tell
  // which path unmounted the webview: residency re-shell, parent unmount, a shouldMountWebview flip, or a
  // generation bump. ref(null) is the first scene of React removing the node; with the unmount marker and
  // suspended-shell ack logs it pins the destroyer and the ordering. Marked only after a webview existed,
  // so volume tracks the tab lifecycle.
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
    logger.info("[browser-use] webview node left the DOM; guest will be destroyed", {
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
    // One pending external navigation per view. Should a future entry point allow concurrency, the new
    // request explicitly supersedes: settle the old acknowledgement first so no promise dangles forever.
    const replacedCompletion = pendingGuestNavigationCompletionRef.current;
    pendingGuestNavigationCompletionRef.current = null;
    replacedCompletion?.resolve();
    return new Promise<void>((resolve) => {
      pendingGuestNavigationCompletionRef.current = { resolve, url };
    });
  }, []);

  useEffect(
    () => () => {
      // A closed view is an explicit cancel; the upstream navigationRequest must not wait forever.
      completePendingGuestNavigation();
    },
    [completePendingGuestNavigation],
  );

  useEffect(
    () => () => {
      // Unmount means the webview leaves the DOM for good: residency re-shell, parent panel close, or a
      // session-switch remount. The delta from the ref-null marker separates regeneration from a real
      // teardown.
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
          // Older preloads may return plain undefined; the successful-attach semantics stay compatible.
          if (!result || result.ok) {
            synchronizeInitialHumanViewport();
            return;
          }
          logger.warn("[browser-use] main rejected guest attach; awaiting owner-scope rebind", {
            browserKey,
            reason: result.reason,
            recoveryRequested: result.recoveryRequested,
          });
          // Main replays BrowserViewReady; clear the dedup mark so the same webContentsId can report again.
          if (result.recoveryRequested) {
            lastReportedGuestRef.current = null;
            setGuestAttachRetryNonce((current) => current + 1);
          }
        })
        .catch((error) => {
          logger.debug("[browser-use] failed to report guest webContentsId", {
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
    // Until the guest is reported to main there is no native CDP session; Web never sees this desktop capability either.
    if (!lastReported || !platform.browserViewDetachGuest) return true;
    try {
      const detached = await platform.browserViewDetachGuest({
        key: browserKey,
        webContentsId: lastReported.webContentsId,
      });
      if (!detached) {
        logger.warn(
          "[browser-use] main did not confirm old guest CDP detach; webview rebuild cancelled",
          {
            browserKey,
            webContentsId: lastReported.webContentsId,
          },
        );
      }
      return detached;
    } catch (error) {
      logger.warn(
        "[browser-use] failed to ask main to detach old guest CDP; webview rebuild cancelled",
        {
          browserKey,
          error: error instanceof Error ? error.message : String(error),
          webContentsId: lastReported.webContentsId,
        },
      );
      return false;
    }
  }, [browserKey, platform]);

  const {
    cancelPicking: cancelWebElementPicking,
    isPicking: isWebElementPicking,
    togglePicking: toggleWebElementPicking,
  } = useWebElementPicker({
    // Transport-agnostic exit: on a ready webview, <webview>.executeJavaScript(script, true); while null,
    // return cancelled (a legitimate selection outcome) and stay a no-op.
    executeJs: (script) =>
      webview ? webview.executeJavaScript(script, true) : Promise.resolve({ status: "cancelled" }),
    workspacePath: workspacePath ?? "",
    workspaceIdentity: workspaceKey ?? workspaceIdentity,
  });

  // ---- Sync chrome state from the webview (url/back-forward/title) ----
  const syncBrowserState = useCallback((target: ElectronWebviewTag) => {
    // Before dom-ready, during navigation churn or re-attach the guest is unattached and the sync methods
    // throw must-be-attached-to-the-DOM; route everything through safeWebviewCall so nothing reaches
    // window.onerror.
    const onDetached = (error: unknown) => {
      logger.debug("[browser-use] state sync skipped, webview not ready", {
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
    // The page URL is untrusted: display and tab persistence only, never an execution path.
    if (currentUrl !== DEFAULT_BROWSER_URL) {
      onUrlChangeRef.current?.(currentUrl);
    }
  }, []);

  // ---- Webview event wiring plus did-attach guestId report ----
  useEffect(() => {
    if (!webview) return;

    const handleDidAttach = () => {
      // navigationHistory.restore works only on a guest that never loaded. Reporting at dom-ready is too
      // late, about:blank already committed and restore degrades to a URL reload; report right after attach
      // so main can restore full Chromium pageState before the first navigation commits.
      if (isResidencyRestore) {
        // A src attribute is required to create the guest, but leaving it re-commits about:blank after
        // attach and interrupts main's history restore. Revoke the bootstrap src as soon as the guest exists.
        webview.removeAttribute("src");
      }
      reportBrowserGuest(isSelected);
    };

    const handleDomReady = () => {
      // Electron/Chromium propagates host page zoom into the guest; compensating the outer transform
      // alone still changes guest innerWidth/DPR. Free-size must pin guest zoom to 1; normal mode keeps
      // Electron's natural propagation instead of rewriting the page zoom.
      if (isResponsiveMode) setGuestZoomFactor(webview, 1);
      // did-attach is the earliest full-history restore point; dom-ready remains the older-Electron fallback.
      reportBrowserGuest(isSelected);

      // The src attribute applies on first attach only; later navigation goes through imperative loadURL, consuming queued URLs.
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
            // Writing the external request into pendingUrl and acknowledging is not enough: a failed guest
            // never consumes it. Only a replacement guest reaching dom-ready and attempting one loadURL
            // truly adopts the navigation intent.
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
      // Ignore subframe failures and -3 (ERR_ABORTED, superseded by a later navigation).
      if (!event.isMainFrame || event.errorCode === -3) return;
      logger.warn("[browser-use] page load failed", {
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
        logger.warn("[browser-use] guest renderer crashed without self-recovery", {
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
          // A renderer exit needs a full guest rebuild; navigation alone cannot recover. guestFailure makes
          // the UI offer the rebuild path rather than a plain load-error retry.
          guestFailure: { exitCode, reason },
          isLoading: false,
          isReady: false,
        }));
        // Should the replacement guest also fail to start, the outcome is a definite failure: settle the wait so no upstream request hangs forever.
        completePendingGuestNavigation();
        return;
      }
      if (guestRecoveryInProgressRef.current) return;

      guestRecoveryInProgressRef.current = true;
      const recoveryUrl = lastRestorableUrlRef.current;
      void cancelWebElementPicking();

      logger.warn("[browser-use] guest renderer exited; rebuilding in place at the last URL", {
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
        // The renderer saw the exit, but main's render-process-gone does not always land first. Bump the
        // key only after the CDP detach ACK above; unmounting the old webview earlier lets Electron's
        // DevToolsSession touch a freed client mid-notification.
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
      // Restore the app zoom only when leaving free-size; normal browsing keeps Electron's native propagation.
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
        // A favicon cannot live only in renderer tab state: one missed residency report and every
        // suspended or cold-restored shell falls back to the globe.
        ...(faviconUrl === undefined ? {} : { faviconUrl }),
      })
      .catch((error) => {
        logger.debug("[browser-use] tab residency report failed", {
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

      logger.warn("[browser-use] explicit navigation hit a guest renderer that failed to rebuild", {
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

  // ---- Navigation (human drives webview.loadURL; queued for dom-ready when not ready) ----
  const openUrl = useCallback(
    async (input: string, source: "toolbar" | "restore" | "request" = "toolbar") => {
      const nextUrl = normalizeBrowserUrl(input);
      if (!nextUrl) {
        setBrowserState((prev) => ({
          ...prev,
          errorMessage: intl.formatMessage({ id: "browser.invalidUrl" }),
          // An invalid address is unrelated to the last network failure; without clearing, the error state keeps the stale certificate guidance.
          loadErrorCode: null,
        }));
        return;
      }

      // An external request queued for an unready guest is acknowledged only once dom-ready actually takes
      // over the loadURL; address-bar and restore navigation have no upstream consumer and need no such
      // lifecycle signal.
      const navigationTakenOver =
        source === "request" && (!webview || !browserState.isReady)
          ? waitForGuestNavigationTakeover(nextUrl)
          : null;

      // After launch-failure isReady is false, and parking the address-bar URL in pendingUrl stalls
      // forever: a dead guest never fires dom-ready, so the failure state and the queued navigation stick.
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

      // Dedup: an external request and a restore can name the same URL in one tick; back-to-back loadURL trips ERR_ABORTED (-3).
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

  // ---- Mount-time navigation to the initial/restored URL (human tab restore) ----
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

  // ---- Tool and nav buttons (isReady gate; safeWebviewCall covers detach races at click time) ----
  const runWebviewAction = useCallback((action: () => void) => {
    safeWebviewCall(
      () => {
        action();
        return undefined;
      },
      undefined,
      (error) => {
        logger.debug("[browser-use] action skipped, webview not ready", {
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
      // Safety bound: the open-in-system-browser entry allows web and file URLs only; inline schemes like about/data stay excluded.
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
        // page-favicon-updated can fire exactly once; by the time an effect wires the listener it may
        // already be gone, in the gap between ref commit and effect run. Listening at ref time closes it.
        node.addEventListener("page-favicon-updated", listener);
        faviconListenerRef.current = { node, listener };
      } else if (webviewTeardownProbeRef.current.hadWebview) {
        // Both a generation bump (controlled rebuild) and a parent unmount pass here; a new node ref right
        // after means regeneration, otherwise a whole-tree or conditional unmount. Attribution markers per
        // the webviewTeardownProbeRef note.
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

  // A load failure rejects one navigation; the guest lives. Re-run openUrl, no rebuild.
  const handleRetryLoad = useCallback(() => {
    const retryUrl = lastRestorableUrlRef.current ?? browserState.currentUrl;
    if (!retryUrl) return;
    void openUrl(retryUrl, "toolbar");
  }, [browserState.currentUrl, openUrl]);

  // Counting the addressValue draft as emptiness hid the empty state and exposed the raw webview the
  // moment typing began, before any commit. Emptiness follows confirmed navigation and load/error state only.
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

  let permissionOrigin: string | null = null;
  try {
    const url = new URL(browserState.currentUrl);
    if (["http:", "https:"].includes(url.protocol)) permissionOrigin = url.origin;
  } catch {
    /* The blank page holds no site permissions. */
  }

  // display:none on the inactive pane makes Electron keep a stale compositor surface and background
  // screenshots tile from it. During prepare, flex exists for compositing only; the outer inert,
  // pointer-events-none and aria-hidden keep interaction and a11y out.
  return (
    <div
      aria-hidden={!isVisible}
      data-browser-screenshot-webview-state={
        screenshotSurfaceRequest ? (webview ? "ready" : "missing") : undefined
      }
      className={cn(
        isVisible || shouldComposeSurface ? "flex" : "hidden",
        "relative h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-background",
      )}
    >
      <BrowserToolbar
        addressValue={addressValue}
        browserState={browserState}
        permissionControl={
          permissionOrigin ? (
            <BrowserSiteSettingsEntry
              origin={permissionOrigin}
              onOpenSettings={onOpenPermissionSettings}
            />
          ) : null
        }
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
      {/* Permission prompt layer: mounted for the visible tab only (the store is shared across tabs, so
          no duplicate renders or background requests surfacing); permission requests then filter to the
          origin tab by guest ownership. */}
      {isVisible ? (
        <EmbeddedBrowserPermissionPrompts guestWebContentsId={permissionGuestWebContentsId} />
      ) : null}
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
