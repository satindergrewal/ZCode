const PERFORMANCE_TIMELINE_CLEANUP_INTERVAL_MS = 10_000;

let cleanupTimer: ReturnType<typeof window.setInterval> | undefined;

export function startPerformanceTimelineCleanup(): void {
  if (!import.meta.env.DEV || cleanupTimer != null) {
    return;
  }

  // React 19.2 development builds write component renders into the Performance timeline.
  // window.performance strongly references those PerformanceMeasures; long dev sessions pile up GBs.
  // This periodic cleanup trims DevTools traces only -- no app logic, nothing in production builds.
  cleanupTimer = window.setInterval(() => {
    window.performance.clearMeasures();
    window.performance.clearMarks();
  }, PERFORMANCE_TIMELINE_CLEANUP_INTERVAL_MS);
}
