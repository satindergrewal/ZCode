// Virtual-scroll core: bottom-anchor state machine for the v4 timeline (pure functions, no
// DOM/React dependencies).
//
// Semantics (scrollAnchor):
// - user at the bottom -> following=true; new content (rows/streamed deltas/height changes)
//   keeps the view pinned;
// - user scrolls up off the bottom -> following=false; streaming deltas must not drag the
//   reading position, and a jump-to-bottom button appears;
// - user scrolls back to the bottom (or clicks the button) -> following resumes.
//
// following is the user's scroll authority, not an instantaneous geometry snapshot: only real
// user scroll input changes it. Scroll events from programmatic pinning, terminal collapse,
// and virtualizer measurement compensation only update the geometry ledger.
//

/** Off-bottom tolerance: closer than this counts as at the bottom. Covers subpixel scrolling and last-row padding. */
const BOTTOM_ANCHOR_EPSILON_PX = 48;

interface TimelineScrollMetrics {
  /** Scroller scrollTop. */
  scrollTop: number;
  /** Scroller visible height (clientHeight). */
  viewportHeight: number;
  /** Total content height (scrollHeight). */
  contentHeight: number;
}

/** Remaining scrollable distance to the bottom (0 when content is shorter than the viewport). */
export function distanceToBottom(metrics: TimelineScrollMetrics): number {
  return Math.max(0, metrics.contentHeight - metrics.viewportHeight - metrics.scrollTop);
}

export function isAtBottom(
  metrics: TimelineScrollMetrics,
  epsilonPx: number = BOTTOM_ANCHOR_EPSILON_PX,
): boolean {
  return distanceToBottom(metrics) <= epsilonPx;
}

/**
 * Following state after a scroll event. Rule: landed at the bottom iff following.
 * All three sources covered with no case split: user scrolls up (off bottom -> release),
 * user scrolls back (at bottom -> resume), programmatic pin (lands at bottom -> keep).
 */
function nextFollowingAfterScroll(
  metrics: TimelineScrollMetrics,
  epsilonPx: number = BOTTOM_ANCHOR_EPSILON_PX,
): boolean {
  return isAtBottom(metrics, epsilonPx);
}

type TimelineScrollEventSource = "user" | "programmatic" | "layout";

/**
 * Scroll-authority verdict after a scroll event. Layout/programmatic scrolls must not change
 * user intent; only user input decides following, by the final resting point.
 */
export function resolveFollowingAfterScroll(input: {
  following: boolean;
  metrics: TimelineScrollMetrics;
  source: TimelineScrollEventSource;
  epsilonPx?: number;
}): boolean {
  if (input.source !== "user") return input.following;
  return nextFollowingAfterScroll(input.metrics, input.epsilonPx);
}

/**
 * Action after content changes (appended rows / streaming growth / measured-height fixes):
 * following -> pin to bottom; released -> keep the reading position (never drag back).
 */
export function anchorActionAfterContentChange(
  following: boolean,
  contentWidthChanging: boolean = false,
): "stickToBottom" | "hold" {
  return following && !contentWidthChanging ? "stickToBottom" : "hold";
}

/**
 * Scroll-compensation verdict after virtualizer remeasures. A width resize remeasures many
 * messages across adjacent frames; compensating scrollTop per row would visibly jitter.
 */
export function shouldAdjustVirtualizerForItemSizeChange(input: {
  following: boolean;
  suppressAdjustment: boolean;
  contentWidthChanging: boolean;
  itemEnd: number;
  scrollTop: number;
}): boolean {
  if (input.suppressAdjustment || input.following || input.contentWidthChanging) {
    return false;
  }
  return input.itemEnd <= input.scrollTop;
}

/** Unobserved-scroll tolerance: a scrollTop regression below this is subpixel jitter, not a user scroll-up. */
const UNOBSERVED_SCROLL_EPSILON_PX = 2;

export type TimelineUserScrollIntent = "none" | "awayFromBottom" | "towardBottom" | "unknown";

/** wheel deltaY shares the sign of scrollTop: negative reads earlier content, positive nears the bottom. */
export function timelineWheelScrollIntent(deltaY: number): TimelineUserScrollIntent {
  if (deltaY < 0) return "awayFromBottom";
  if (deltaY > 0) return "towardBottom";
  return "none";
}

/** Touch delta is inverted vs scrollTop: finger down reads earlier content. */
export function timelineTouchScrollIntent(
  previousClientY: number,
  nextClientY: number,
): TimelineUserScrollIntent {
  if (nextClientY > previousClientY) return "awayFromBottom";
  if (nextClientY < previousClientY) return "towardBottom";
  return "none";
}

/** Keyboard scroll intent; caret keys inside inputs are not timeline scrolling. */
export function timelineKeyboardScrollIntent(input: {
  key: string;
  shiftKey: boolean;
  editableTarget: boolean;
}): TimelineUserScrollIntent {
  if (input.editableTarget) return "none";
  if (input.key === "ArrowUp" || input.key === "PageUp" || input.key === "Home") {
    return "awayFromBottom";
  }
  if (input.key === "ArrowDown" || input.key === "PageDown" || input.key === "End") {
    return "towardBottom";
  }
  if (input.key === " ") {
    return input.shiftKey ? "awayFromBottom" : "towardBottom";
  }
  return "none";
}

/**
 * Reconciles user scroll intent before a content-change commit pins to the bottom.
 *
 * Following is driven by scroll events, which dispatch a rendered frame after the scroll: if
 * a user scroll-up (wheel) or test-programmatic scrollTop write lands inside a React commit
 // that changes totalSize/rowCount (streamed delta, ResizeObserver correction, window remeasure
 // from a composer resize), the pin effect runs with a stale following=true, drags scrollTop
 // back, and the rebound makes the subsequent scroll event judge following=true again - the
 // user's/test's scroll-up is swallowed entirely (resize/measure commits stealing scroll
 // authority).
 *
 * Reconcile rules (run before the pin action; inputs are live metrics at commit time):
 * 1. definite scroll-up -> release following now; same-frame terminal/layout commits must yield too;
 * 2. no user input -> keep following as-is; virtualizer/collapse scrollTop regressions are not scroll-ups;
 * 3. unknown/downward input -> resume if resting at the bottom, release on a clear regression, else keep.
 */
export function reconcileFollowingForContentAnchor(input: {
  /** Current following state (the existing scroll-event-driven value). */
  following: boolean;
  /** Live scroll metrics at commit time (before the pin action). */
  metrics: TimelineScrollMetrics;
  /** The component's latest ledgered scrollTop (scroll-event value or readback after a programmatic write). */
  lastObservedScrollTop: number;
  /** User scroll intent captured before the current content commit; when omitted, reconcile as the legacy unknown source. */
  userScrollIntent?: TimelineUserScrollIntent;
  bottomEpsilonPx?: number;
  scrollEpsilonPx?: number;
}): boolean {
  const userScrollIntent = input.userScrollIntent ?? "unknown";
  if (userScrollIntent === "awayFromBottom") return false;
  if (userScrollIntent === "none") return input.following;
  if (isAtBottom(input.metrics, input.bottomEpsilonPx ?? BOTTOM_ANCHOR_EPSILON_PX)) {
    return true;
  }
  const unobservedUpscroll =
    input.metrics.scrollTop <
    input.lastObservedScrollTop - (input.scrollEpsilonPx ?? UNOBSERVED_SCROLL_EPSILON_PX);
  if (unobservedUpscroll) {
    return false;
  }
  return input.following;
}

/** Jump-to-bottom button visibility: only while released from following and content exists. */
export function shouldShowBackToBottom(following: boolean, rowCount: number): boolean {
  return !following && rowCount > 0;
}

/** Session switch / first bind: reset to following (a opened session lands on the newest message). */
export function initialFollowing(): boolean {
  return true;
}

// -- loadOlder: prepend scroll anchoring (the classic virtual-scroll prepend trap) --
//
// Semantics: when prepending history above the window, the row the user is reading (the
// anchor) must not shift in the viewport. In a virtualized list prepending only grows the
// total height (existing turns keep cached measurements by turnId; no remount/remasure), so
// anchor restoration = shifting scrollTop by the height the prepend added.
//   scrollTop' = scrollTop + (nextTotalSize - prevTotalSize)
// Premise: existing render-unit keys are stable (getItemKey=turnId) and no other measurement
// fix lands in the same frame - new rows in the prepend commit have estimated heights only;
// later ResizeObserver corrections go through the virtualizer's normal shift path, not here.

export interface PrependVirtualAnchor {
  key: string;
  /** Anchor measurement start offset from the viewport top. */
  offsetTop: number;
  start: number;
}

/**
 * scrollTop correction to apply for a stable key after a prepend.
 *
 * Between the loadOlder trigger and the rows commit, a layout restore or the virtualizer may
 * rewrite scrollTop; adding only the measurement.start delta would double-count that interim
 * movement. Compute the absolute target from the viewport offset saved at trigger time, then
 // subtract live scrollTop, to restore the reading position stably.
 */
export function prependVirtualAnchorAdjustment(
  previous: PrependVirtualAnchor,
  next: PrependVirtualAnchor,
  currentScrollTop: number,
): number | null {
  if (previous.key !== next.key) return null;
  if (
    !Number.isFinite(previous.offsetTop) ||
    !Number.isFinite(next.start) ||
    !Number.isFinite(currentScrollTop)
  ) {
    return null;
  }
  return next.start - previous.offsetTop - currentScrollTop;
}

interface PrependAnchorInput {
  /** Previous commit window-head rowId (null = no rows yet). */
  prevFirstRowId: number | null;
  /** Current commit window-head rowId (null = rows cleared). */
  nextFirstRowId: number | null;
  /** Previous commit virtual-list total height. */
  prevTotalSize: number;
  /** Current commit virtual-list total height. */
  nextTotalSize: number;
}

/**
 * scrollTop shift after a prepend. Positive shift only when the head rowId decreased (a real
 * prepend); append/replace/clear/first frame return null (leave scrolling to the bottom-anchor
 * logic).
 */
export function prependScrollAdjustment(input: PrependAnchorInput): number | null {
  if (input.prevFirstRowId === null || input.nextFirstRowId === null) {
    return null;
  }
  if (input.nextFirstRowId >= input.prevFirstRowId) return null;
  const delta = input.nextTotalSize - input.prevTotalSize;
  return delta > 0 ? delta : null;
}

/** Top trigger threshold: closer than this counts as at-the-top and prefetches another window. */
const LOAD_OLDER_TRIGGER_PX = 64;

/** Prefetch two viewports early, so network and render finish before the user reaches the window edge. */
const LOAD_OLDER_PREFETCH_VIEWPORTS = 2;

export function historyPrefetchTriggerPx(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return LOAD_OLDER_TRIGGER_PX;
  }
  return Math.max(LOAD_OLDER_TRIGGER_PX, viewportHeight * LOAD_OLDER_PREFETCH_VIEWPORTS);
}

/** Whether a scroll event should trigger loadOlder (at top + more available + not in flight). */
export function shouldTriggerLoadOlder(input: {
  scrollTop: number;
  canLoadOlder: boolean;
  loadingOlder: boolean;
  triggerPx?: number;
}): boolean {
  return (
    input.canLoadOlder &&
    !input.loadingOlder &&
    input.scrollTop <= (input.triggerPx ?? LOAD_OLDER_TRIGGER_PX)
  );
}
