import { useEffect } from "react";
import {
  BROWSER_SCREENSHOT_SURFACE_PREPARE_TIMEOUT_MS,
  type BrowserViewportSize,
  type BrowserViewScreenshotSurfacePreparePayload,
} from "@zcode/shared";
import { safeWebviewCall } from "@/embeddedBrowserHelpers.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";

function roundViewport(width: number, height: number): BrowserViewportSize | null {
  const viewport = { width: Math.round(width), height: Math.round(height) };
  return viewport.width > 0 && viewport.height > 0 ? viewport : null;
}

function withinOnePixel(left: BrowserViewportSize, right: BrowserViewportSize): boolean {
  return Math.abs(left.width - right.width) <= 1 && Math.abs(left.height - right.height) <= 1;
}

const SURFACE_SCALE_EPSILON = 0.001;

// ready used to be reported only from
// requestAnimationFrame callbacks, and Chromium freezes renderer rAF while the ZCode window is occluded/minimized,
// so ready never fired and the main-process handshake always burned the 1500ms timeout. User logs show
// failures all at 1501/1502ms, successes at 146-736ms, and success 461ms after app-activate,
// confirming "window not foreground -> rAF not scheduled" rather than a slow capture.
//
//   Foreground: prepare -> rAF(frame1) -> rAF(frame2) -> ready -> capture      OK ~150ms
//   Background: prepare -> rAF frozen --------------------> (no ready) -> 1500ms timeout FAIL
//
// So the timer must race the rAF scheduling of the same check: with the window occluded the timer is the only clock still running.
const SURFACE_VERIFY_FALLBACK_MS = 100;
// While the viewport is misaligned this used to return early, and the only restart points were ResizeObserver and dom-ready;
// if the size settles after setViewportSize/reload there is never a second validation, burning another 1500ms.
// Now a controlled retry: main puts the current timeout into the prepare payload and the renderer keeps an extra
// Release-cleanup grace. Normally main releases first; the grace only keeps the loop alive if a Release is lost.
const SURFACE_VERIFY_RELEASE_GRACE_MS = 1_000;

function resolveSurfacePrepareTimeoutMs(timeoutMs: number | undefined): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : BROWSER_SCREENSHOT_SURFACE_PREPARE_TIMEOUT_MS;
}

interface StableScreenshotSurface {
  surfaceScale: number;
  viewport: BrowserViewportSize;
}

function readBrowserLayoutScale(webview: ElectronWebviewTag): number {
  const layoutScale = Number(webview.dataset.browserLayoutScale);
  return Number.isFinite(layoutScale) && layoutScale > 0 ? layoutScale : 1;
}

function readSurfaceScale(webview: ElectronWebviewTag): number {
  const responsiveViewport = webview.closest<HTMLElement>("[data-responsive-scale]");
  const surfaceScale = Number(responsiveViewport?.dataset.responsiveScale);
  return Number.isFinite(surfaceScale) && surfaceScale > 0 ? surfaceScale : 1;
}

function sameSurface(left: StableScreenshotSurface, right: StableScreenshotSurface): boolean {
  return (
    withinOnePixel(left.viewport, right.viewport) &&
    Math.abs(left.surfaceScale - right.surfaceScale) <= SURFACE_SCALE_EPSILON
  );
}

function readSurfaceViewport(
  webview: ElectronWebviewTag,
  expected: BrowserViewportSize,
): BrowserViewportSize | null {
  const rect = webview.getBoundingClientRect();
  const transformed = roundViewport(rect.width, rect.height);
  const layoutScale = readBrowserLayoutScale(webview);
  // Negative desktop scaling first expands the webview layout by 1/zoom, then shrinks back into the visible frame;
  // the raw offset is a host-compensated size and must be scaled back by the same layout factor to mean the logical screenshot viewport.
  const layout = roundViewport(
    webview.offsetWidth / layoutScale,
    webview.offsetHeight / layoutScale,
  );
  if (transformed && withinOnePixel(transformed, expected)) return transformed;
  if (layout && withinOnePixel(layout, expected)) return layout;
  return transformed ?? layout;
}

/** Wait through two stable frames in the background compositor, confirming guest id and natural viewport stay valid together. */
export function useBrowserScreenshotSurfaceReady({
  request,
  webview,
}: {
  request: BrowserViewScreenshotSurfacePreparePayload | null;
  webview: ElectronWebviewTag | null;
}): void {
  const platform = usePlatform();

  useEffect(() => {
    logger.debug("[browser-use] Screenshot surface ready effect", {
      requestId: request?.requestId,
      tabId: request?.tabId,
      hasWebview: Boolean(webview),
      hasResizeObserver: typeof ResizeObserver !== "undefined",
    });
    if (!request || !webview || typeof ResizeObserver === "undefined") {
      logger.debug("[browser-use] Screenshot surface ready not starting yet", {
        requestId: request?.requestId,
        tabId: request?.tabId,
        hasWebview: Boolean(webview),
        hasResizeObserver: typeof ResizeObserver !== "undefined",
      });
      return;
    }

    // TypeScript does not carry early-return non-null narrowing into the hoisted function declarations
    // below (theoretically callable before the guards); pin one narrowed reference for the whole validation chain.
    const activeRequest = request;
    const activeWebview = webview;

    let disposed = false;
    let reported = false;
    let firstFrame: StableScreenshotSurface | null = null;
    let rafId: number | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let mismatchLogged = false;
    let verificationVersion = 0;
    const prepareTimeoutMs = resolveSurfacePrepareTimeoutMs(activeRequest.timeoutMs);
    const verifyDeadlineMs = prepareTimeoutMs + SURFACE_VERIFY_RELEASE_GRACE_MS;
    const deadline = Date.now() + verifyDeadlineMs;
    const cancelPendingVerification = () => {
      verificationVersion += 1;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (fallbackTimer !== null) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
    };
    // rAF vs timer race: whoever lands first runs this check and cancels the other; semantically still one validation.
    function verify(): void {
      if (disposed || reported) return;
      cancelPendingVerification();
      const version = verificationVersion;
      const run = () => {
        if (disposed || reported || version !== verificationVersion) return;
        cancelPendingVerification();
        runVerification();
      };
      rafId = window.requestAnimationFrame(run);
      fallbackTimer = setTimeout(run, SURFACE_VERIFY_FALLBACK_MS);
    }
    function retry(): void {
      if (Date.now() >= deadline) {
        logger.warn("[browser-use] Screenshot surface wait timed out; stopping retries", {
          requestId: activeRequest.requestId,
          tabId: activeRequest.tabId,
          expectedViewport: activeRequest.viewport,
          prepareTimeoutMs,
          verifyDeadlineMs,
        });
        return;
      }
      verify();
    }
    function runVerification(): void {
      const guestId = safeWebviewCall(() => activeWebview.getWebContentsId(), 0);
      if (guestId !== activeRequest.webContentsId) {
        logger.debug("[browser-use] Screenshot surface waiting for the current guest", {
          requestId: activeRequest.requestId,
          expectedGuestId: activeRequest.webContentsId,
          guestId,
        });
        retry();
        return;
      }
      const viewport = readSurfaceViewport(activeWebview, activeRequest.viewport);
      if (!viewport || !withinOnePixel(viewport, activeRequest.viewport)) {
        if (!mismatchLogged) {
          mismatchLogged = true;
          logger.debug("[browser-use] Screenshot surface viewport not aligned yet", {
            requestId: activeRequest.requestId,
            expectedViewport: activeRequest.viewport,
            viewport,
          });
        }
        retry();
        return;
      }
      const current = { surfaceScale: readSurfaceScale(activeWebview), viewport };
      if (!firstFrame || !sameSurface(firstFrame, current)) {
        firstFrame = current;
        retry();
        return;
      }
      if (disposed) return;
      logger.debug("[browser-use] Screenshot surface stable", {
        requestId: activeRequest.requestId,
        tabId: activeRequest.tabId,
        surfaceScale: current.surfaceScale,
        viewport: current.viewport,
      });
      reported = true;
      platform.browserViewScreenshotSurfaceReady?.({
        ...activeRequest,
        surfaceScale: current.surfaceScale,
        viewport: current.viewport,
      });
    }
    function restartVerification(): void {
      if (disposed || reported) return;
      firstFrame = null;
      mismatchLogged = false;
      cancelPendingVerification();
      verify();
    }
    const observer = new ResizeObserver(() => {
      restartVerification();
    });
    // On first attach getWebContentsId() may transiently return 0; without a layout resize,
    // ResizeObserver never refires. dom-ready is the same-view boundary once the guest identity is readable,
    // so reset the stable frames and restart validation here.
    const handleDomReady = () => {
      restartVerification();
    };
    // Only when the window returns to the foreground does Chromium resume rAF and compositing; the surface may be freshly
    // rebuilt and earlier stable frames are no longer trustworthy; clear and restart so visibility restore reruns the two-frame check.
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      restartVerification();
    };
    observer.observe(activeWebview);
    activeWebview.addEventListener("dom-ready", handleDomReady);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    verify();
    return () => {
      disposed = true;
      observer.disconnect();
      activeWebview.removeEventListener("dom-ready", handleDomReady);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      cancelPendingVerification();
    };
  }, [platform, request, webview]);
}
