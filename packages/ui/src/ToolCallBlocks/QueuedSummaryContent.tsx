import { type ReactNode, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

const SUMMARY_ROLL_TRANSITION_MS = 300;
const SUMMARY_ROLL_HOLD_MS = 500;
const SUMMARY_ROLL_TOTAL_MS = SUMMARY_ROLL_TRANSITION_MS + SUMMARY_ROLL_HOLD_MS;
const SUMMARY_ROLL_TIMER_DRIFT_SKIP_MS = 250;
const SUMMARY_ROLL_MAX_PENDING = 2;
const SUMMARY_ROLL_TRANSITION = {
  duration: SUMMARY_ROLL_TRANSITION_MS / 1000,
  ease: [0.4, 0, 0.2, 1],
} as const;

function getCurrentTimestamp() {
  if (typeof performance !== "undefined") {
    return performance.now();
  }
  return Date.now();
}

function resolveQueuedSummaryPlaybackQueue<T>(
  queuedContent: readonly T[],
  timerDriftMs: number,
): T[] {
  if (timerDriftMs > SUMMARY_ROLL_TIMER_DRIFT_SKIP_MS && queuedContent.length > 1) {
    return queuedContent.slice(-1);
  }
  return [...queuedContent];
}

function shouldAnimateQueuedSummaryContent({
  enabled,
  disableAnimation,
  reducedMotion,
}: {
  enabled: boolean;
  disableAnimation?: boolean;
  reducedMotion: boolean;
}) {
  return enabled && disableAnimation !== true && !reducedMotion;
}

interface SummaryContentSnapshot {
  key: string;
  refreshVersion?: string;
  primaryText: ReactNode;
  secondaryText?: ReactNode;
  trailingText?: ReactNode;
}

function shouldRefreshQueuedSummaryContent(
  current: Pick<SummaryContentSnapshot, "key" | "refreshVersion" | "trailingText">,
  next: Pick<SummaryContentSnapshot, "key" | "refreshVersion" | "trailingText">,
) {
  return (
    current.key === next.key &&
    (current.trailingText !== next.trailingText || current.refreshVersion !== next.refreshVersion)
  );
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setPrefersReducedMotion(query.matches);
    };
    update();

    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", update);
      return () => {
        query.removeEventListener("change", update);
      };
    }

    query.addListener(update);
    return () => {
      query.removeListener(update);
    };
  }, []);

  return prefersReducedMotion;
}

export function QueuedSummaryContent({
  contentKey,
  contentRefreshVersion,
  primaryText,
  secondaryText,
  trailingText,
  enabled,
  disableAnimation = false,
}: {
  contentKey: string;
  contentRefreshVersion?: string;
  primaryText: ReactNode;
  secondaryText?: ReactNode;
  trailingText?: ReactNode;
  enabled: boolean;
  disableAnimation?: boolean;
}) {
  const reducedMotion = usePrefersReducedMotion();
  const shouldAnimate = shouldAnimateQueuedSummaryContent({
    enabled,
    disableAnimation,
    reducedMotion,
  });
  const createSnapshot = (): SummaryContentSnapshot => ({
    key: contentKey,
    refreshVersion: contentRefreshVersion,
    primaryText,
    secondaryText,
    trailingText,
  });
  const [displayedContent, setDisplayedContent] = useState(createSnapshot);
  const displayedContentRef = useRef(displayedContent);
  const queuedContentRef = useRef<SummaryContentSnapshot[]>([]);
  const animationTimerRef = useRef<number | null>(null);
  const isAnimatingRef = useRef(false);

  useEffect(() => {
    displayedContentRef.current = displayedContent;
  }, [displayedContent]);

  useEffect(() => {
    const clearAnimationTimer = () => {
      if (animationTimerRef.current !== null) {
        window.clearTimeout(animationTimerRef.current);
        animationTimerRef.current = null;
      }
    };
    const enqueue = (snapshot: SummaryContentSnapshot) => {
      const queue = queuedContentRef.current;
      const existingIndex = queue.findIndex((item) => item.key === snapshot.key);
      if (existingIndex >= 0) {
        // While a file summary waits to play, later diffs update the same snapshot: key
        // dedupe must not keep the earliest +N/-N, nor enqueue a whole new roll per value
        // change.
        const nextQueue = [...queue];
        nextQueue[existingIndex] = snapshot;
        queuedContentRef.current = nextQueue;
        return;
      }

      if (queue.length === 0) {
        queuedContentRef.current = [snapshot];
        return;
      }

      // The summary roll has exactly three slots: showing, next, and the queue-jumper.
      // queuedContentRef holds only the last two; slot two must not be overwritten — new
      // summaries may only replace slot three.
      queuedContentRef.current = [queue[0]!, snapshot].slice(0, SUMMARY_ROLL_MAX_PENDING);
    };
    const promote = (snapshot: SummaryContentSnapshot) => {
      displayedContentRef.current = snapshot;
      setDisplayedContent(snapshot);
      isAnimatingRef.current = true;
      clearAnimationTimer();
      const expectedTimerAt = getCurrentTimestamp() + SUMMARY_ROLL_TOTAL_MS;
      animationTimerRef.current = window.setTimeout(() => {
        isAnimatingRef.current = false;
        animationTimerRef.current = null;
        const queuedContent = queuedContentRef.current;
        const timerDrift = getCurrentTimestamp() - expectedTimerAt;
        // Timers fire late when the main thread is busy; replaying stale summaries one by
        // one after a stall would queue outdated states in front of the user and feel even
        // laggier.
        const nextQueue = resolveQueuedSummaryPlaybackQueue(queuedContent, timerDrift);
        const [nextQueued, ...restQueued] = nextQueue;
        if (!nextQueued) {
          queuedContentRef.current = [];
          return;
        }
        queuedContentRef.current = restQueued;
        promote(nextQueued);
      }, SUMMARY_ROLL_TOTAL_MS);
    };
    const nextContent = createSnapshot();

    if (!shouldAnimate) {
      clearAnimationTimer();
      isAnimatingRef.current = false;
      queuedContentRef.current = [];
      displayedContentRef.current = nextContent;
      setDisplayedContent(nextContent);
      return;
    }

    if (displayedContentRef.current.key === nextContent.key) {
      // Never replay the whole summary for the same Changes child's diff or the same
      // streaming Assistant message; the former updates the trailing count, the latter
      // refreshes the body in place via the explicit version.
      if (shouldRefreshQueuedSummaryContent(displayedContentRef.current, nextContent)) {
        displayedContentRef.current = nextContent;
        setDisplayedContent(nextContent);
      }
      return;
    }

    if (isAnimatingRef.current) {
      enqueue(nextContent);
      return;
    }

    if (queuedContentRef.current.length > 0) {
      enqueue(nextContent);
      return;
    }

    promote(nextContent);
  }, [contentKey, contentRefreshVersion, shouldAnimate, trailingText]);

  useEffect(() => {
    return () => {
      if (animationTimerRef.current !== null) {
        window.clearTimeout(animationTimerRef.current);
      }
    };
  }, []);

  if (!shouldAnimate) {
    return (
      <>
        {primaryText}
        {secondaryText}
        {trailingText}
      </>
    );
  }

  return (
    <span className="relative inline-flex min-w-0 items-center gap-2 overflow-hidden align-middle">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={displayedContent.key}
          className="inline-flex min-w-0 items-center gap-2"
          initial={{ y: "0.8em", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: "-0.8em", opacity: 0 }}
          transition={SUMMARY_ROLL_TRANSITION}
        >
          {displayedContent.primaryText}
          {displayedContent.secondaryText}
        </motion.span>
      </AnimatePresence>
      {/* The Changes diff count belongs to the same queued snapshot as the file summary,
          but the number keeps flipping independently via FlipMetricValue instead of
          scrolling away with the whole summary. */}
      {displayedContent.trailingText}
    </span>
  );
}
