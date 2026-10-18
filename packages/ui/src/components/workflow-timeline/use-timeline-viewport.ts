import { useEffect, useLayoutEffect, useState } from "react";

/**
 * The scroll viewport's three numbers (scrollLeft / clientWidth / scrollWidth) and the "is scrolling" mark.
 * Scroll events coalesce per frame; resizes go through ResizeObserver (watching container and content layer — the draft's pen widens it with every revealed station).
 * jsdom cannot measure (width 0); consumers fold nothing in that case — static test output stays pixel-identical.
 *
 * Depend on the **element**, not the ref object: the draft's first frame has no stations and the scroll layer mounts a frame later;
 * an effect depending on the ref object returns early on the null first frame and never runs again — the listener never attaches, and the viewport
 * keeps that one stale measurement, leaving the newest station folded to the right edge forever. The consumer passes the element in via callback-ref state: attach on mount, detach on unmount.
 *
 * Keep the previous object while the measured numbers are unchanged; the ResizeObserver and
 * scroll callbacks used to allocate a fresh object per event and cost the timeline a wasted render; during empty-draft idle those extra updates all get
 * charged to React's nested-update accounting.
 */
export interface TimelineViewport {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
  /** Scrolled within the last 800ms (the scrollbar shows on this). */
  scrolling: boolean;
}

const SCROLLING_MS = 800;
const EMPTY: TimelineViewport = { clientWidth: 0, scrollLeft: 0, scrollWidth: 0, scrolling: false };

function measure(element: HTMLElement): Omit<TimelineViewport, "scrolling"> {
  return {
    clientWidth: element.clientWidth,
    scrollLeft: element.scrollLeft,
    scrollWidth: element.scrollWidth,
  };
}

/** Fold one measurement into the previous viewport; with the three numbers and scrolling unchanged, return the previous object so React skips the render. */
function merge(
  previous: TimelineViewport,
  measured: Omit<TimelineViewport, "scrolling">,
  scrolling = previous.scrolling,
): TimelineViewport {
  return previous.clientWidth === measured.clientWidth &&
    previous.scrollLeft === measured.scrollLeft &&
    previous.scrollWidth === measured.scrollWidth &&
    previous.scrolling === scrolling
    ? previous
    : { ...measured, scrolling };
}

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function useTimelineViewport(
  /** The scrolling-layer element; null before mount (draft first frame) or after unmount. */
  element: HTMLElement | null,
  /** Handle on content changes (station count, width): re-measure when it changes. */
  contentKey: number,
): TimelineViewport {
  const [viewport, setViewport] = useState<TimelineViewport>(EMPTY);

  useIsomorphicLayoutEffect(() => {
    if (element === null) return;
    setViewport((previous) => merge(previous, measure(element)));
  }, [element, contentKey]);

  useEffect(() => {
    if (element === null) return;
    let frame: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        setViewport((previous) => merge(previous, measure(element), true));
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = undefined;
          setViewport((previous) =>
            previous.scrolling ? { ...previous, scrolling: false } : previous,
          );
        }, SCROLLING_MS);
      });
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        setViewport((previous) => merge(previous, measure(element)));
      });
      observer.observe(element);
      const content = element.firstElementChild;
      if (content !== null) observer.observe(content);
    }
    return () => {
      element.removeEventListener("scroll", onScroll);
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (timer !== undefined) clearTimeout(timer);
      observer?.disconnect();
    };
  }, [element]);

  return viewport;
}
