import { useCallback, type RefObject } from "react";
import {
  BROWSER_VIEW_RESTORE_BOOTSTRAP_URL,
  TID_BROWSER_WEBVIEW,
  type BrowserViewportSize,
} from "@zcode/shared";
import { TriangleAlertIcon } from "lucide-react";
import { ResponsiveBrowserViewport } from "@/browser-use/ResponsiveBrowserViewport.js";
import {
  resolveResponsiveBrowserGuestLayout,
  type BrowserViewportZoom,
} from "@/browser-use/browserViewportZoom.js";
import { cn } from "@/components/lib/utils.js";
import {
  BrowserEmptyState,
  BrowserGuestFailureState,
  BrowserLoadErrorState,
} from "@/EmbeddedBrowserPaneParts.js";
import {
  DEFAULT_BROWSER_URL,
  isCertificateBrowserLoadErrorCode,
  type BrowserState,
} from "@/embeddedBrowserHelpers.js";

export function BrowserViewportSurface({
  browserRegionRef,
  browserState,
  desktopZoomFactor,
  isResidencyRestore,
  formatMessage,
  isEmptyBrowserState,
  isComposed,
  isResponsiveMode,
  isViewportEmulated = isResponsiveMode,
  onRetryGuest,
  onRetryLoad,
  onViewportResize,
  onViewportSizeChange,
  onWebviewRef,
  shouldMountWebview = true,
  showResizeWarning,
  webviewGeneration,
  viewportSize,
  viewportZoom,
}: {
  browserRegionRef: RefObject<HTMLDivElement | null>;
  browserState: BrowserState;
  desktopZoomFactor: number;
  isResidencyRestore: boolean;
  formatMessage: (descriptor: { id: string }, values?: Record<string, number | string>) => string;
  isEmptyBrowserState: boolean;
  isComposed: boolean;
  isResponsiveMode: boolean;
  isViewportEmulated?: boolean;
  onRetryGuest: () => void;
  onRetryLoad: () => void;
  onViewportResize: () => void;
  onViewportSizeChange: (viewportSize: BrowserViewportSize) => void;
  onWebviewRef: (node: ElectronWebviewTag | null) => void;
  shouldMountWebview?: boolean;
  showResizeWarning: boolean;
  webviewGeneration: number;
  viewportSize: BrowserViewportSize;
  viewportZoom: BrowserViewportZoom;
}): React.JSX.Element {
  const { guestFailure } = browserState;
  // A guest-level process failure outranks a load error: the former has no picture at all, the latter only rejects this navigation.
  const loadError = !guestFailure && browserState.errorMessage ? browserState.errorMessage : null;
  // The natural viewport has no metrics-pinned size; a temporary responsive frame does not mean the guest may expand.
  const responsiveGuestLayout = resolveResponsiveBrowserGuestLayout(desktopZoomFactor);
  const responsiveGuestLayoutScale = isViewportEmulated ? responsiveGuestLayout.layoutScale : 1;
  const responsiveGuestTransformScale = isViewportEmulated
    ? responsiveGuestLayout.transformScale
    : 1;
  const needsResponsiveGuestLayout = isResponsiveMode && responsiveGuestLayoutScale !== 1;
  const responsiveGuestLayoutSize = `calc(100% * ${responsiveGuestLayoutScale})`;
  const handleWebviewRef = useCallback(
    (node: ElectronWebviewTag | null) => {
      onWebviewRef(node);
    },
    [onWebviewRef],
  );

  return (
    <div
      ref={browserRegionRef}
      className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-background"
    >
      {showResizeWarning ? (
        <div
          role="status"
          aria-live="polite"
          data-browser-resize-warning="visible"
          className="pointer-events-none absolute top-2 right-2 left-2 z-20 mx-auto flex w-fit max-w-full items-center gap-2 rounded-xl border border-popover-border bg-popover px-3 py-2 text-ui-base font-medium text-foreground shadow-md"
        >
          <span
            aria-hidden="true"
            data-browser-resize-warning-accent="visible"
            className="h-5 w-0.5 shrink-0 rounded-full bg-warning"
          />
          <TriangleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-warning" />
          <span>{formatMessage({ id: "browser.resizeDuringOperationWarning" })}</span>
        </div>
      ) : null}
      <ResponsiveBrowserViewport
        active={isResponsiveMode}
        desktopZoomFactor={desktopZoomFactor}
        isComposed={isComposed}
        onResize={onViewportResize}
        onViewportSizeChange={onViewportSizeChange}
        viewportSize={viewportSize}
        zoom={viewportZoom}
      >
        {guestFailure ? (
          <BrowserGuestFailureState
            formatMessage={formatMessage}
            guestFailure={guestFailure}
            onRetry={onRetryGuest}
          />
        ) : loadError ? (
          <BrowserLoadErrorState
            errorMessage={loadError}
            formatMessage={formatMessage}
            isCertificateError={isCertificateBrowserLoadErrorCode(browserState.loadErrorCode)}
            onRetry={onRetryLoad}
          />
        ) : isEmptyBrowserState ? (
          <BrowserEmptyState
            key="empty-state"
            browserState={browserState}
            formatMessage={formatMessage}
            isGuestStarting={shouldMountWebview && !browserState.isReady}
          />
        ) : null}
        {/* The free-size toggle only alters the stable frame CSS width/height; never conditionally re-parent the webview,
            or the Electron guest is rebuilt and web history lost. Blank pages keep hiding the webview directly so the empty state stays visible.
            Electron 41 also requires nodeintegrationinsubframes declared at guest creation, so child frames that really navigate load the fixed preload.
            If allowpopups waits for the ref callback, the guest has attached already and target=_blank is
            silently swallowed at the Chromium permission boundary. React must emit string attributes before insertion; the type assertions only
            silence the React DOM warning caused by @types/react modeling the Electron boolean attribute as boolean.
            generation bumps only after a guest renderer crash; plain switches/resizes must keep reusing the node.
            When a new human tab and an about:blank guest mount in the same frame, the separate Electron compositor surface
            can paint a white first frame before the host hidden styles apply, so the human guest is created only after a confirmed navigation;
            created guests stay stably mounted. */}
        {shouldMountWebview ? (
          <webview
            key={`webview:${webviewGeneration}`}
            ref={handleWebviewRef}
            allowpopups={"" as unknown as boolean}
            src={isResidencyRestore ? BROWSER_VIEW_RESTORE_BOOTSTRAP_URL : DEFAULT_BROWSER_URL}
            partition="persist:zcode-embedded-browser"
            nodeintegrationinsubframes="true"
            data-browser-compositor-scale={isResponsiveMode ? desktopZoomFactor : undefined}
            data-browser-layout-scale={isResponsiveMode ? responsiveGuestLayoutScale : undefined}
            data-browser-transform-scale={
              isResponsiveMode ? responsiveGuestTransformScale : undefined
            }
            data-testid={TID_BROWSER_WEBVIEW}
            data-browser-resize-dimmed={showResizeWarning ? "true" : undefined}
            className={cn(
              "browser-use-viewport h-full min-h-0 w-full",
              isEmptyBrowserState || guestFailure || loadError ? "hidden" : "inline-flex",
            )}
            // Electron <webview> separate guest surfaces compose page zoom asymmetrically: zoom-in is
            // corrected by the main CDP metrics scale; zoom-out expands the layout by 1/zoom before scaling.
            // absolute keeps the compensation layout out of the Fit scroll extent.
            // Only host layout/compositing changes here; guest zoom, CSS viewport, DPR and Browser Use readbacks stay untouched.
            style={{
              // The page canvas defaults to browser white; set only the webview node background,
              // no overlay layers, no injected or overridden styles in the guest page.
              backgroundColor: "#fff",
              // The Electron guest surface can finish its first composite before the Tailwind hidden class applies,
              // flashing a white frame on new tabs; inline visibility during creation closes that timing window.
              ...(isEmptyBrowserState ? { visibility: "hidden" as const } : {}),
              ...(isResponsiveMode
                ? {
                    ...(needsResponsiveGuestLayout
                      ? {
                          height: responsiveGuestLayoutSize,
                          left: 0,
                          position: "absolute" as const,
                          top: 0,
                          width: responsiveGuestLayoutSize,
                        }
                      : {}),
                    ...(responsiveGuestTransformScale !== 1
                      ? {
                          transform: `scale(${responsiveGuestTransformScale})`,
                          transformOrigin: "top left",
                        }
                      : {}),
                  }
                : {}),
            }}
          />
        ) : null}
      </ResponsiveBrowserViewport>
    </div>
  );
}
