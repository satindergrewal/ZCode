import { useEffect, type RefObject } from "react";
import {
  EmbeddedBrowserWebviewChannels,
  type EmbeddedBrowserWheelBoundaryPayload,
} from "@zcode/shared";
import { logger } from "@/logger.js";

function validatedDelta(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Chains a guest two-axis wheel that hit the edge into the free-size host canvas. */
export function useEmbeddedBrowserWheelChain({
  browserRegionRef,
  isResponsiveMode,
  webview,
}: {
  browserRegionRef: RefObject<HTMLDivElement | null>;
  isResponsiveMode: boolean;
  webview: ElectronWebviewTag | null;
}): void {
  useEffect(() => {
    if (!webview) return;

    const handleGuestIpcMessage = (event: ElectronWebviewIpcMessageEvent): void => {
      if (!isResponsiveMode || event.channel !== EmbeddedBrowserWebviewChannels.WheelBoundary) {
        return;
      }
      const payload = event.args[0] as Partial<EmbeddedBrowserWheelBoundaryPayload> | undefined;
      // IPC payloads may miss fields or carry non-finite numbers; never hand them straight to the host scroll canvas.
      const deltaX = validatedDelta(payload?.deltaX);
      const deltaY = validatedDelta(payload?.deltaY);
      if (deltaX === 0 && deltaY === 0) return;

      const responsiveCanvas = browserRegionRef.current?.querySelector<HTMLElement>(
        '[data-responsive-browser-mode="active"]',
      );
      if (!responsiveCanvas) return;
      // An Electron <webview> guest wheel does not bubble to the host DOM; the fixed preload
      // messages only when the page cannot consume the axis, and here it chains into the outer free-size scroll.
      responsiveCanvas.scrollBy({ behavior: "auto", left: deltaX, top: deltaY });
      // Wheel volume matches the message stream: debug only, never persisted in production.
      logger.debug("[browser-use] Guest wheel chained into the free-size canvas", {
        deltaX,
        deltaY,
        scrollLeft: responsiveCanvas.scrollLeft,
        scrollTop: responsiveCanvas.scrollTop,
      });
    };

    webview.addEventListener("ipc-message", handleGuestIpcMessage);
    return () => webview.removeEventListener("ipc-message", handleGuestIpcMessage);
  }, [browserRegionRef, isResponsiveMode, webview]);
}
