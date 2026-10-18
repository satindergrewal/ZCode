import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useBrowserUseOperationActive } from "@/browser-use/useBrowserUseOperationActive.js";
import { logger } from "@/logger.js";

const RESIZE_WARNING_DURATION_MS = 3_000;
const AGENT_LAYOUT_SETTLE_MIN_DURATION_MS = 300;
const AGENT_LAYOUT_SETTLE_QUIET_DURATION_MS = 100;
const AGENT_LAYOUT_SETTLE_MAX_DURATION_MS = 500;

/**
 * Listens to browser-region sizes within the same Browser Use active window as the tab cursor icon.
 * Renderer-local mild hint only: never cancels the tool, never edits the snapshot, never writes protocol state.
 */
export function useBrowserResizeOperationWarning({
  browserKey,
  isVisible,
  operationUntil,
  resizeBaselineVersion,
}: {
  browserKey: string;
  isVisible: boolean;
  operationUntil?: number;
  resizeBaselineVersion?: number;
}) {
  const [showResizeWarning, setShowResizeWarning] = useState(false);
  const browserRegionRef = useRef<HTMLDivElement | null>(null);
  const lastSizeRef = useRef<{ width: number; height: number } | null>(null);
  const warnedForActiveCycleRef = useRef(false);
  const warningTimerRef = useRef<number | null>(null);
  const agentLayoutSettleUntilRef = useRef(0);
  const agentLayoutSettleMaxUntilRef = useRef(0);
  const previousResizeBaselineVersionRef = useRef(resizeBaselineVersion);
  const hasAppliedResizeBaselineVersionRef = useRef(false);
  const isVisibleRef = useRef(isVisible);
  const isAgentOperating = useBrowserUseOperationActive(operationUntil);
  const isAgentOperatingRef = useRef(isAgentOperating);
  // ResizeObserver may fire before the effect refresh; sync the ref during render so it matches the icon in the same frame.
  isVisibleRef.current = isVisible;
  isAgentOperatingRef.current = isAgentOperating;

  const warnForBrowserResize = useCallback(() => {
    if (!isVisibleRef.current || !isAgentOperatingRef.current || warnedForActiveCycleRef.current) {
      return;
    }

    warnedForActiveCycleRef.current = true;
    setShowResizeWarning(true);
    warningTimerRef.current = window.setTimeout(() => {
      warningTimerRef.current = null;
      setShowResizeWarning(false);
    }, RESIZE_WARNING_DURATION_MS);
  }, []);

  const beginAgentLayoutSettlement = useCallback(() => {
    const now = Date.now();
    lastSizeRef.current = null;
    agentLayoutSettleUntilRef.current = now + AGENT_LAYOUT_SETTLE_MIN_DURATION_MS;
    agentLayoutSettleMaxUntilRef.current = now + AGENT_LAYOUT_SETTLE_MAX_DURATION_MS;
  }, []);

  const prepareForAgentViewportChange = useCallback(
    (willChangeResponsiveMode: boolean) => {
      if (!willChangeResponsiveMode) return;
      beginAgentLayoutSettlement();
    },
    [beginAgentLayoutSettlement],
  );

  useLayoutEffect(() => {
    const previousVersion = previousResizeBaselineVersionRef.current;
    const hasAppliedVersion = hasAppliedResizeBaselineVersionRef.current;
    const hasInitialAgentMarker = !hasAppliedVersion && (resizeBaselineVersion ?? 0) > 0;
    const agentMarkerChanged = hasAppliedVersion && previousVersion !== resizeBaselineVersion;
    previousResizeBaselineVersionRef.current = resizeBaselineVersion;
    hasAppliedResizeBaselineVersionRef.current = true;

    // A model newTab mounts the view on ready/visibility first and the real tabId operation lands later, while
    // guest mount and side-pane animation keep producing ResizeObserver frames past the marker. A single baseline
    // clear would swallow frame one and misreport frame two as a user resize. Model layout markers get a
    // bounded stabilization window; plain first mount/user tab switch still only rebuild the baseline.
    lastSizeRef.current = null;
    if (hasInitialAgentMarker || agentMarkerChanged) beginAgentLayoutSettlement();
  }, [beginAgentLayoutSettlement, isVisible, resizeBaselineVersion]);

  useEffect(() => {
    if (isAgentOperating) return;
    warnedForActiveCycleRef.current = false;
    setShowResizeWarning(false);
    if (warningTimerRef.current !== null) {
      window.clearTimeout(warningTimerRef.current);
      warningTimerRef.current = null;
    }
  }, [isAgentOperating]);

  useEffect(() => {
    const element = browserRegionRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const nextSize = {
        width: Math.round(entry.contentRect.width),
        height: Math.round(entry.contentRect.height),
      };
      if (nextSize.width <= 0 || nextSize.height <= 0) return;

      const previousSize = lastSizeRef.current;
      lastSizeRef.current = nextSize;
      const now = Date.now();
      const isAgentLayoutSettling = now <= agentLayoutSettleUntilRef.current;
      if (isAgentLayoutSettling) {
        agentLayoutSettleUntilRef.current = Math.min(
          agentLayoutSettleMaxUntilRef.current,
          Math.max(agentLayoutSettleUntilRef.current, now + AGENT_LAYOUT_SETTLE_QUIET_DURATION_MS),
        );
      }
      const sizeChanged =
        previousSize !== null &&
        (previousSize.width !== nextSize.width || previousSize.height !== nextSize.height);
      logger.debug("[browser-use] browser region ResizeObserver", {
        browserKey,
        isAgentOperating: isAgentOperatingRef.current,
        isVisible: isVisibleRef.current,
        nextSize,
        previousSize,
        resizeBaselineVersion,
        isAgentLayoutSettling,
        sizeChanged,
        warnedForActiveCycle: warnedForActiveCycleRef.current,
      });
      if (!sizeChanged || isAgentLayoutSettling) return;

      // Coordinate actions may still rely on pre-resize visuals. Hint once per active window to
      // avoid a hint storm across continuous drags, keeping locator/CUA execution semantics unchanged.
      warnForBrowserResize();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [browserKey, resizeBaselineVersion, warnForBrowserResize]);

  useEffect(
    () => () => {
      if (warningTimerRef.current !== null) window.clearTimeout(warningTimerRef.current);
    },
    [],
  );

  return {
    browserRegionRef,
    notifyBrowserViewportResize: warnForBrowserResize,
    prepareForAgentViewportChange,
    showResizeWarning,
  };
}
