import { useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";

const PANEL_FLEX_GROW_TRANSITION_CLASSES = ["transition-[flex-grow]", "duration-200", "ease-out"];
const PANEL_FLEX_GROW_TRANSITION_FALLBACK_MS = 240;

function enablePanelFlexGrowTransition(panelElement: HTMLElement): () => void {
  panelElement.classList.add(...PANEL_FLEX_GROW_TRANSITION_CLASSES);

  let finished = false;
  let fallbackTimer = 0;

  const finish = () => {
    if (finished) {
      return;
    }
    finished = true;
    panelElement.removeEventListener("transitionend", handleTransitionEnd);
    if (fallbackTimer) {
      window.clearTimeout(fallbackTimer);
    }
    panelElement.classList.remove(...PANEL_FLEX_GROW_TRANSITION_CLASSES);
  };

  const handleTransitionEnd = (event: TransitionEvent) => {
    if (event.target === panelElement && event.propertyName === "flex-grow") {
      finish();
    }
  };

  panelElement.addEventListener("transitionend", handleTransitionEnd);
  fallbackTimer = window.setTimeout(finish, PANEL_FLEX_GROW_TRANSITION_FALLBACK_MS);

  return finish;
}

export function useAnimatedResizablePanel({
  open,
  alwaysMounted = false,
  expandedSize,
  rememberExpandedSize = false,
  resizeOnInitialVisibleMount = true,
}: {
  open: boolean;
  alwaysMounted?: boolean;
  expandedSize?: string;
  rememberExpandedSize?: boolean;
  resizeOnInitialVisibleMount?: boolean;
}) {
  const panelRef = useRef<PanelImperativeHandle | null>(null);
  const panelElementRef = useRef<HTMLDivElement | null>(null);
  const expandedSizeRef = useRef(expandedSize);
  const hasHandledVisibilityRef = useRef(false);
  const [isVisible, setIsVisible] = useState(open);

  useEffect(() => {
    expandedSizeRef.current = expandedSize;
  }, [expandedSize]);

  useEffect(() => {
    if (alwaysMounted) {
      setIsVisible(open);
      return;
    }

    if (open) {
      // A conditionally mounted Panel that mounts already expanded jumps straight to its target size on the first frame.
      // Keep it collapsed on mount and expand on the next frame, so open and close share one transition.
      const rafId = window.requestAnimationFrame(() => {
        setIsVisible(true);
      });
      return () => {
        window.cancelAnimationFrame(rafId);
      };
    }

    setIsVisible(false);
  }, [alwaysMounted, open]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    const panelElement = panelElementRef.current;

    if (!hasHandledVisibilityRef.current) {
      hasHandledVisibilityRef.current = true;
      if (isVisible && !resizeOnInitialVisibleMount) {
        // The sidebar PanelGroup persists its width via layoutId.
        // Resizing to the defaults on first visible mount would overwrite the width the user dragged last time.
        return;
      }
    }

    // The flex-grow transition used to live on data-panel permanently; during native window resize
    // the library ResizeObserver saw a stream of intermediate animated sizes, triggering
    // lots of layout-store updates and React commits. Enable the size transition only for explicit expand/collapse
    // so ordinary window resizes are not amplified through the animation path.
    const cleanupTransition = panelElement
      ? enablePanelFlexGrowTransition(panelElement)
      : undefined;

    // On first mount react-resizable-panels registers constraints in an internal effect.
    // Calling collapse/expand in the same tick occasionally races the registration and crashes with
    // "Panel constraints not found". Defer by one frame so registration completes before the animation command.
    const rafId = window.requestAnimationFrame(() => {
      if (isVisible) {
        const nextExpandedSize = expandedSizeRef.current;
        if (nextExpandedSize) {
          panel.resize(nextExpandedSize);
          return;
        }
        panel.expand();
        return;
      }
      if (rememberExpandedSize) {
        const currentSize = panel.getSize().asPercentage;
        if (Number.isFinite(currentSize) && currentSize > 0) {
          expandedSizeRef.current = `${currentSize}%`;
        }
      }
      panel.collapse();
    });

    return () => {
      window.cancelAnimationFrame(rafId);
      cleanupTransition?.();
    };
  }, [isVisible, rememberExpandedSize, resizeOnInitialVisibleMount]);

  return {
    panelRef,
    panelElementRef,
    isVisible,
  };
}
