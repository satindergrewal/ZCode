import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  TID_BROWSER_RESPONSIVE_SCALED_FRAME,
  TID_BROWSER_RESPONSIVE_VIEWPORT,
  type BrowserViewportSize,
} from "@zcode/shared";
import {
  resolveBrowserViewportRendererScale,
  resolveBrowserViewportScale,
  type BrowserViewportZoom,
} from "@/browser-use/browserViewportZoom.js";
import {
  RESPONSIVE_BROWSER_VIEWPORT_LIMITS,
  ResponsiveBrowserResizeHandles,
  type ResizeDirection,
  type ResizeHandleDirections,
} from "@/browser-use/ResponsiveBrowserResizeHandles.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

export const DEFAULT_RESPONSIVE_BROWSER_VIEWPORT_SIZE = {
  width: 393,
  height: 852,
} as const;

interface ResizeDragState {
  captureTarget: HTMLDivElement;
  heightDirection: ResizeDirection;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startSize: BrowserViewportSize;
  widthDirection: ResizeDirection;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function clampViewportSize(size: BrowserViewportSize): BrowserViewportSize {
  return {
    width: clamp(
      size.width,
      RESPONSIVE_BROWSER_VIEWPORT_LIMITS.minWidth,
      RESPONSIVE_BROWSER_VIEWPORT_LIMITS.maxWidth,
    ),
    height: clamp(
      size.height,
      RESPONSIVE_BROWSER_VIEWPORT_LIMITS.minHeight,
      RESPONSIVE_BROWSER_VIEWPORT_LIMITS.maxHeight,
    ),
  };
}

/**
 * Keep the same DOM wrapper layer and switch only the frame CSS size, so toggling free-size never rebuilds the Electron guest.
 * Sizes belong to this Browser tab React instance; never written to cross-platform stores or persistence.
 */
export function ResponsiveBrowserViewport({
  active,
  children,
  desktopZoomFactor,
  isComposed,
  onResize,
  onViewportSizeChange,
  viewportSize,
  zoom,
}: {
  active: boolean;
  children: ReactNode;
  desktopZoomFactor: number;
  isComposed: boolean;
  onResize?: () => void;
  onViewportSizeChange: (viewportSize: BrowserViewportSize) => void;
  viewportSize: BrowserViewportSize;
  zoom: BrowserViewportZoom;
}): React.JSX.Element {
  const { intl } = useZCodeIntl();
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const viewportSizeRef = useRef<BrowserViewportSize>(viewportSize);
  const rendererScaleRef = useRef(1);
  const dragRef = useRef<ResizeDragState | null>(null);
  const pendingViewportSizeRef = useRef<BrowserViewportSize | null>(null);
  const resizeAnimationFrameRef = useRef(0);
  const [canvasSize, setCanvasSize] = useState<BrowserViewportSize | null>(null);
  const visualScale = active
    ? resolveBrowserViewportScale({ canvasSize, desktopZoomFactor, viewportSize, zoom })
    : 1;
  // Electron app-global zoom keeps multiplying into the free-size frame CSS transform,
  // dragging the 100%/fixed ratios and drag math along with it. The frame multiplies by the inverse to cancel the parent zoom;
  // the guest CSS viewport stays governed by width/height and no visual compensation is written back to Browser Use.
  const rendererScale = active
    ? resolveBrowserViewportRendererScale({ desktopZoomFactor, visualScale })
    : 1;
  rendererScaleRef.current = rendererScale;

  const applyViewportSize = useCallback(
    (requestedSize: BrowserViewportSize) => {
      const nextSize = clampViewportSize(requestedSize);
      const previousSize = viewportSizeRef.current;
      if (previousSize.width === nextSize.width && previousSize.height === nextSize.height) {
        return;
      }
      viewportSizeRef.current = nextSize;
      onViewportSizeChange(nextSize);
      onResize?.();
    },
    [onResize, onViewportSizeChange],
  );

  useEffect(() => {
    viewportSizeRef.current = viewportSize;
  }, [viewportSize]);

  const scheduleViewportSize = useCallback(
    (requestedSize: BrowserViewportSize) => {
      pendingViewportSizeRef.current = clampViewportSize(requestedSize);
      if (resizeAnimationFrameRef.current !== 0) return;
      // pointermove can outpace the refresh rate; commit only the last size sample per frame, skipping no-op React renders.
      resizeAnimationFrameRef.current = window.requestAnimationFrame(() => {
        resizeAnimationFrameRef.current = 0;
        const pendingSize = pendingViewportSizeRef.current;
        pendingViewportSizeRef.current = null;
        if (pendingSize) applyViewportSize(pendingSize);
      });
    },
    [applyViewportSize],
  );

  const finishResize = useCallback(
    (reason: string, pointerId?: number, commitPendingSize = true) => {
      const drag = dragRef.current;
      if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) return;
      dragRef.current = null;
      if (resizeAnimationFrameRef.current !== 0) {
        window.cancelAnimationFrame(resizeAnimationFrameRef.current);
        resizeAnimationFrameRef.current = 0;
      }
      const pendingSize = pendingViewportSizeRef.current;
      pendingViewportSizeRef.current = null;
      if (pendingSize && commitPendingSize) applyViewportSize(pendingSize);
      try {
        if (drag.captureTarget.hasPointerCapture(drag.pointerId)) {
          drag.captureTarget.releasePointerCapture(drag.pointerId);
        }
      } catch {
        // Capture may already be revoked by the system or browser; state was cleaned first, so a lostpointercapture re-entry cannot resume the drag.
      }
      logger.debug("[browser-use] Ended free-size drag", {
        pointerId: drag.pointerId,
        reason,
      });
    },
    [applyViewportSize],
  );

  const beginResize = useCallback(
    (directions: ResizeHandleDirections, event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      finishResize("pointer-replaced");
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Synthesized automation events may have no active pointer; move on the same node still validates the sizing logic.
      }
      dragRef.current = {
        ...directions,
        captureTarget: event.currentTarget,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startSize: viewportSizeRef.current,
      };
    },
    [finishResize],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      // mousemove buttons is the browser source of truth for physical buttons; even if window blur is eaten by the screenshot layer,
      // the first frame after the primary button releases must end the old gesture, not keep trusting the pointerdown dragRef.
      if (event.pointerType === "mouse" && (event.buttons & 1) === 0) {
        finishResize("mouse-button-released", event.pointerId);
        return;
      }
      event.preventDefault();
      // With the frame scaled via CSS transform, pointer deltas are visual pixels; accumulating them directly
      // would produce the same CSS viewport delta at 50%/200% for the same drag distance.
      const scale = rendererScaleRef.current > 0 ? rendererScaleRef.current : 1;
      const widthDelta = (event.clientX - drag.startClientX) / scale;
      const heightDelta = (event.clientY - drag.startClientY) / scale;
      scheduleViewportSize({
        width: drag.startSize.width + widthDelta * drag.widthDirection,
        height: drag.startSize.height + heightDelta * drag.heightDirection,
      });
    },
    [finishResize, scheduleViewportSize],
  );

  const endResize = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      finishResize(event.type, event.pointerId);
    },
    [finishResize],
  );

  const handleResizeKeyDown = useCallback(
    (directions: ResizeHandleDirections, event: ReactKeyboardEvent<HTMLDivElement>) => {
      const step = event.shiftKey ? 10 : 1;
      const currentSize = viewportSizeRef.current;
      if (
        directions.widthDirection !== 0 &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")
      ) {
        event.preventDefault();
        applyViewportSize({
          ...currentSize,
          width:
            currentSize.width +
            (event.key === "ArrowRight" ? step : -step) * directions.widthDirection,
        });
      }
      if (
        directions.heightDirection !== 0 &&
        (event.key === "ArrowUp" || event.key === "ArrowDown")
      ) {
        event.preventDefault();
        applyViewportSize({
          ...currentSize,
          height:
            currentSize.height +
            (event.key === "ArrowDown" ? step : -step) * directions.heightDirection,
        });
      }
    },
    [applyViewportSize],
  );

  useLayoutEffect(() => {
    if (!active || !isComposed || zoom !== "fit") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const updateCanvasSize = (size: BrowserViewportSize) => {
      // display:none on an inactive tab makes ResizeObserver report 0x0; clearing the last valid canvas
      // would make the first frame back fall to Fit=1 and shrink only a frame later.
      // Non-positive sizes carry no layout authority; on recompose the layout effect re-measures before first paint.
      if (size.width <= 0 || size.height <= 0) return;
      setCanvasSize((previous) =>
        previous?.width === size.width && previous.height === size.height ? previous : size,
      );
    };
    const rect = canvas.getBoundingClientRect();
    updateCanvasSize({ width: rect.width, height: rect.height });
    logger.debug("[browser-use] Re-measured the free-size Fit canvas", {
      desktopZoomFactor,
      height: rect.height,
      width: rect.width,
    });
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      updateCanvasSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [active, desktopZoomFactor, isComposed, zoom]);

  useEffect(() => {
    if (!active) {
      finishResize("mode-inactive", undefined, false);
      return;
    }
    // System screenshots and app switches blur the window before pointerup, so the old handle
    // never sees the end event and pointer capture plus dragRef leak; movement after refocus keeps resizing.
    const handleWindowBlur = () => finishResize("window-blur");
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("blur", handleWindowBlur);
      finishResize("mode-exit", undefined, false);
    };
  }, [active, finishResize]);

  return (
    <div
      ref={canvasRef}
      className={cn(
        "h-full min-h-0 w-full min-w-0",
        active ? "overflow-auto bg-background-alt" : "overflow-hidden bg-background",
      )}
      data-responsive-browser-mode={active ? "active" : "inactive"}
    >
      <div
        className={cn(
          active
            ? "flex min-h-full w-max min-w-full items-center justify-center p-4"
            : "h-full w-full",
        )}
      >
        <div
          className={cn(
            "relative shrink-0",
            active ? "bg-card shadow-sm ring-1 ring-border" : "h-full w-full",
          )}
          data-testid={TID_BROWSER_RESPONSIVE_SCALED_FRAME}
          style={
            active
              ? {
                  height: `${viewportSize.height * rendererScale}px`,
                  width: `${viewportSize.width * rendererScale}px`,
                }
              : undefined
          }
        >
          <div
            aria-label={intl.formatMessage({ id: "browser.responsive.viewport" })}
            className={cn("relative", active ? "shrink-0" : "h-full w-full")}
            data-responsive-height={active ? viewportSize.height : undefined}
            data-responsive-scale={active ? visualScale : undefined}
            data-responsive-width={active ? viewportSize.width : undefined}
            data-testid={TID_BROWSER_RESPONSIVE_VIEWPORT}
            style={
              active
                ? {
                    height: `${viewportSize.height}px`,
                    transform: `scale(${rendererScale})`,
                    transformOrigin: "top left",
                    width: `${viewportSize.width}px`,
                  }
                : undefined
            }
          >
            {children}
            {active ? (
              <ResponsiveBrowserResizeHandles
                height={viewportSize.height}
                heightLabel={intl.formatMessage({
                  id: "browser.responsive.resizeHeight",
                })}
                onBeginResize={beginResize}
                onEndResize={endResize}
                onPointerMove={handlePointerMove}
                onResizeKeyDown={handleResizeKeyDown}
                width={viewportSize.width}
                widthLabel={intl.formatMessage({
                  id: "browser.responsive.resizeWidth",
                })}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
