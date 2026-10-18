import {
  BROWSER_VIEWPORT_ZOOM_OPTIONS,
  DEFAULT_BROWSER_VIEWPORT_ZOOM,
  type BrowserViewportSize,
  type BrowserViewportZoom,
} from "@zcode/shared";

export { BROWSER_VIEWPORT_ZOOM_OPTIONS, DEFAULT_BROWSER_VIEWPORT_ZOOM };
export type { BrowserViewportZoom };

/** Fit padding matches ResponsiveBrowserViewport's p-4. */
export const RESPONSIVE_BROWSER_CANVAS_PADDING_PX = 16;

export function resolveBrowserViewportScale({
  canvasSize,
  desktopZoomFactor = 1,
  viewportSize,
  zoom,
}: {
  canvasSize: BrowserViewportSize | null;
  desktopZoomFactor?: number;
  viewportSize: BrowserViewportSize;
  zoom: BrowserViewportZoom;
}): number {
  if (zoom !== "fit") {
    return Number(zoom) / 100;
  }
  if (!canvasSize || canvasSize.width <= 0 || canvasSize.height <= 0) {
    return 1;
  }

  const safeDesktopZoomFactor =
    Number.isFinite(desktopZoomFactor) && desktopZoomFactor > 0 ? desktopZoomFactor : 1;
  // ResizeObserver reports CSS size after page zoom; convert to visual screen
  // size before Fit, or app zoom reads as preview zoom.
  const availableWidth =
    Math.max(0, canvasSize.width - RESPONSIVE_BROWSER_CANVAS_PADDING_PX * 2) *
    safeDesktopZoomFactor;
  const availableHeight =
    Math.max(0, canvasSize.height - RESPONSIVE_BROWSER_CANVAS_PADDING_PX * 2) *
    safeDesktopZoomFactor;
  if (availableWidth === 0 || availableHeight === 0) {
    return 1;
  }

  return Math.min(1, availableWidth / viewportSize.width, availableHeight / viewportSize.height);
}

export function resolveBrowserViewportRendererScale({
  desktopZoomFactor,
  visualScale,
}: {
  desktopZoomFactor: number;
  visualScale: number;
}): number {
  const safeDesktopZoomFactor =
    Number.isFinite(desktopZoomFactor) && desktopZoomFactor > 0 ? desktopZoomFactor : 1;
  return visualScale / safeDesktopZoomFactor;
}

export function resolveResponsiveBrowserGuestLayout(desktopZoomFactor: number): {
  layoutScale: number;
  transformScale: number;
} {
  const safeDesktopZoomFactor =
    Number.isFinite(desktopZoomFactor) && desktopZoomFactor > 0 ? desktopZoomFactor : 1;

  if (safeDesktopZoomFactor > 1) {
    // Page zoom-in grows only the webview DOM; guest raster stays 1/zoom of the frame,
    // leaving right/bottom gutters.
    // Compensation lives in main's CDP metrics scale; renderer keeps true 100% bounds.
    return { layoutScale: 1, transformScale: 1 };
  }

  if (safeDesktopZoomFactor < 1) {
    // Zoom-out on the surface alone also gutters: expand layout inversely, then fit
    // the frame, keeping full content and correct guest coordinates.
    return {
      layoutScale: 1 / safeDesktopZoomFactor,
      transformScale: safeDesktopZoomFactor,
    };
  }

  return { layoutScale: 1, transformScale: 1 };
}
